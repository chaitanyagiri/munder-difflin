/**
 * HookServer —— `claude` 生命周期 hook 与 harness 之间的桥梁。
 *
 * 每个派生的 agent 都以 `--settings` 启动，把它的 hook 指向一个极小的
 * shim（见 hive.ts 中的 HOOK_SHIM），shim 把 hook 负载转发到本服务器
 * 监听的 Unix 域套接字。然后我们：
 *   - 根据 PreToolUse/PostToolUse/Notification 等驱动头像状态，以及
 *   - 上报生命周期边界，同时渲染进程侧的受守卫队列只会在会话到达
 *     安全空闲提示之后才投递 inbox 工作。
 *
 * 运行在 Electron 主进程。
 */
import { createServer, type Server } from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { Notification, type WebContents } from 'electron';
import { l10n } from './l10n';
import type { HiveManager } from './hive';
import type { HarnessConfig } from './config';
import type { ControlRegistry } from './control';
import type { CircuitBreaker } from './breaker';
import { estimateCostUsd } from './pricing';
import { validateHookEvent } from '../shared/hookEvents';

interface HookPayload {
  hook_event_name?: string;
  agent_id?: string | null;
  session_id?: string;
  transcript_path?: string;
  /** 仅状态行负载：会话的实时上下文计量。 */
  context_window?: { total_input_tokens?: number; context_window_size?: number };
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
  stop_hook_active?: boolean;
  prompt?: string;
  source?: string;
  notification_type?: string;
  /** Notification hook 文本，例如“Claude is waiting for your input”（空闲）
   *  与权限请求的区别。用于区分“需要你”与“刚做完 / 还在逗留”。 */
  message?: string;
  /** 仅 CostSample 负载（由 proxy-bridge sidecar 为 qwen 合成）。
   *  一次响应的原始 token 计数，送入成本账本。 */
  model?: string;
  input?: number;
  output?: number;
  cache_read?: number;
  cache_creation?: number;
}

export class HookServer {
  private server: Server | null = null;
  /** agentId → 当前会话的 transcript 文件，从 hook 负载中学得。
   *  即使多个 agent 共享同一个 cwd，harness 也能据此读取每个 agent
   *  的遥测数据（例如当前上下文大小）。 */
  private transcriptPaths = new Map<string, string>();
  /** agentId → 来自 statusLine shim 的最新上下文窗口计量（当前 token + 真实
   *  窗口大小——200k vs 1M，别的任何地方都拿不到）。渲染进程已经通过
   *  `hive:contextUpdate` 实时收到它；我们在这里也保留最后的值，这样主进程
   *  侧的读取（voice 读取层的 get_agent_detail / list_agents）能报告“每个
   *  agent 的上下文装得多满”，而不依赖渲染进程的一次往返。 */
  private contextById = new Map<string, { tokens: number; limit: number; ts: number }>();

  constructor(
    private hive: HiveManager,
    private getWebContents: () => WebContents | null,
    private getConfig: () => HarnessConfig,
    /** #7C —— 操作员控制状态。可选，测试可以省略。 */
    private control?: ControlRegistry,
    /** 熔断器（Lane A #6.6b）——喂入 hook 派生的信号（session id、
     *  重复的相同工具调用）。可选，没有它服务器照样运行。 */
    private breaker?: CircuitBreaker,
    /** agent 的长期目标文本（来自持久化 roster）。可选，测试可以省略；
     *  设置后会在 SessionStart / UserPromptSubmit 时注入。 */
    private getStandingGoal?: (agentId: string) => string | null,
    /** 每个 hook 边界的可选观察者（agentId、event、message）。
     *  worker 的 inbox-wake 看门狗（workerWake.ts）靠这个得知一个 agent
     *  何时停在权限/HITL 提示上，从而绝不向它输入文字。 */
    private onEvent?: (agentId: string | undefined, event: string, message: string | undefined) => void
  ) {}

  start(): void {
    const sock = this.hive.sockPath();
    if (!sock || this.server) return;
    // 清除上一次运行留下的过期套接字文件。
    try { if (existsSync(sock)) rmSync(sock); } catch { /* 空操作 */ }

    this.server = createServer((conn) => {
      let buf = '';
      conn.on('data', (d) => {
        buf += d.toString();
        const nl = buf.indexOf('\n');
        if (nl === -1) return; // 等待完整的一行
        let payload: HookPayload = {};
        try { payload = JSON.parse(buf.slice(0, nl)); } catch { /* 忽略 */ }
        let res: unknown = {};
        try { res = this.handle(payload); } catch { res = {}; }
        conn.end(JSON.stringify(res ?? {}));
      });
      conn.on('error', () => { /* shim 挂断了——忽略 */ });
    });
    this.server.on('error', (e) => console.error('[hive] hook server error:', e));
    this.server.listen(sock);
  }

  stop(): void {
    try { this.server?.close(); } catch { /* 空操作 */ }
    this.server = null;
    const sock = this.hive.sockPath();
    try { if (sock && existsSync(sock)) rmSync(sock); } catch { /* 空操作 */ }
  }

  /** 若发生过任何 hook，则是 agent 当前会话的 transcript 文件。 */
  transcriptPath(agentId: string): string | undefined {
    return this.transcriptPaths.get(agentId);
  }

  /** agent 最新的上下文窗口计量（当前 token + 真实窗口大小），
   *  若尚无 statusLine 心跳则为 undefined。 */
  contextFor(agentId: string): { tokens: number; limit: number; ts: number } | undefined {
    return this.contextById.get(agentId);
  }

  private handle(p: HookPayload): unknown {
    const agentId = p.agent_id ?? undefined;
    const event = p.hook_event_name ?? 'Unknown';
    this.onEvent?.(agentId, event, p.message);
    if (agentId && typeof p.transcript_path === 'string' && p.transcript_path) {
      this.transcriptPaths.set(agentId, p.transcript_path);
    }

    // 状态行负载携带会话“精确”的上下文计量——
    // 当前 token 以及真实窗口大小（200k vs 1M，别的任何地方都拿不到）。
    // 转发给渲染进程，供 agent 卡片的上下文仪表使用。
    // 最先处理并提前返回：这是来自 statusLine shim 的纯遥测，
    // 不是真正的 hook 边界——它绝不能触发 HALT 门，
    // 也绝不能喂给下面的熔断器循环检测。提前返回
    // 还（刻意地）让状态心跳跳过 recordSession：statusLine
    // 负载的 session_id 不会给真实 hook 尚未记录的内容增加任何东西，
    // 而且遥测绝不应写入注册表。transcript_path 仍然
    // 会在上面被捕获，所有负载形态都能受益于它。
    if (event === 'Status') {
      const cw = p.context_window;
      if (agentId && cw && typeof cw.total_input_tokens === 'number'
        && typeof cw.context_window_size === 'number' && cw.context_window_size > 0) {
        // 为主进程侧读取保留（voice get_agent_detail / list_agents）……
        this.contextById.set(agentId, {
          tokens: cw.total_input_tokens,
          limit: cw.context_window_size,
          ts: Date.now()
        });
        // ……并实时转发给渲染进程的 agent 卡片上下文仪表。
        this.getWebContents()?.send('hive:contextUpdate', {
          agentId,
          tokens: cw.total_input_tokens,
          limit: cw.context_window_size
        });
      }
      return {};
    }

    // 7C.3 —— 操作员的优雅 HALT 覆盖一切（包括下面的 inbox
    // 排空）：在这个 hook 边界“干净”地停住 agent，而不是
    // 杀掉 PTY。payload 里带 session_id，供以后 --resume 用。
    if (agentId && this.control?.shouldHalt(agentId)) {
      this.emit(agentId, event, p);
      return { continue: false, stopReason: 'Halted by the operator from the floor.' };
    }

    // 捕获 Claude Code session id，用于幂等的 --resume + 成本去重
    // （Lane A #6.6a）。很便宜：recordSession 只在变化时写入。
    if (agentId && p.session_id) this.hive.recordSession(agentId, p.session_id);

    // CostSample —— 由 proxy-bridge sidecar（qwen）在每次带 usage 的
    // 响应上合成。按合成的 session_id 持久化到与 Claude OTel 路径
    // 相同的成本账本，然后提前返回，让这笔成本
    // 不进入下面只属于 Claude 的 OTel/熔断/排空路径。`usd` 是回退的
    // 按模型估算（本地模型通常约 $0，但该行保持核算
    // schema 统一）。纯遥测——绝不喂给循环检测器。
    if (event === 'CostSample') {
      if (agentId && p.session_id) {
        const input = p.input ?? 0;
        const output = p.output ?? 0;
        const cacheRead = p.cache_read ?? 0;
        const cacheCreation = p.cache_creation ?? 0;
        this.hive.appendCostLedger({
          agentId,
          sessionId: p.session_id,
          ts: Date.now(),
          input,
          output,
          cacheRead,
          cacheCreation,
          model: p.model ?? '',
          usd: estimateCostUsd(p.model, {
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheCreation
          })
        });
      }
      return {};
    }

    // 给熔断器喂它 hook 派生的循环信号：一个真正运行过的工具。
    // 重复的相同（name+input）PostToolUse 就是失控循环的征兆。
    if (event === 'PostToolUse' && agentId) {
      this.breaker?.recordToolUse(agentId, p.tool_name, p.tool_input);
    }

    // 压缩豁免（issue #109）：PreCompact 打开它，这样压缩时的
    // token 洪峰不会触发 Δoutput 分支；PostCompact——或任何
    // SessionStart，因为新会话会让进行中的压缩状态失去意义——把它
    // 关闭到尾部宽限（没有在压缩时就是空操作）。
    if (event === 'PreCompact' && agentId) this.breaker?.recordCompactStart(agentId);
    if ((event === 'PostCompact' || event === 'SessionStart') && agentId) {
      this.breaker?.recordCompactEnd(agentId);
    }

    if ((event === 'Stop' || event === 'SubagentStop') && agentId) {
      // 尊重任何已经重新进入此边界的上游 Stop hook。
      if (p.stop_hook_active) { this.emit(agentId, event, p); return {}; }
      // 绝不在 Stop 时把未读的 hive 邮件变成强制继续。那条旧
      // 路径绕过了终端草稿/HITL 安全，而且可能在用户
      // 正在回答问题时消耗额度。inbox 文件保持持久；渲染进程
      // 稍后会通过它受守卫的仅-空闲投递路径唤醒 agent。
      this.notify(agentId ?? l10n('Agent', '成员'), l10n('finished — idle', '已完成 — 空闲'));
      this.emit(agentId, event, p);
      return {};
    }

    // 7C.1 —— HITL 门：当 agent 已暂停或该工具被门控时，在 PreToolUse
    // 边界拒绝工具调用。无竞态（立即返回，不经过
    // 渲染进程往返 → 不会撞上 shim 超时）。缓慢的人工 APPROVAL
    // 刻意交给 Claude 的原生权限提示。
    if (event === 'PreToolUse' && agentId && this.control) {
      const d = this.control.toolDecision(agentId, p.tool_name ?? '');
      if (d.deny) {
        this.emitControl(agentId, p.tool_name, d.reason);
        this.emit(agentId, event, p);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: d.reason ?? 'Denied by operator.'
          }
        };
      }
    }

    // 7C.2 —— 运行中 steering：在下一个符合条件的 hook 上把排队中的
    // 操作员指导作为上下文注入（不做脆弱的 TUI 打字）。只投递一次。
    // 与下面的 roster 行合并，这样两股注入永远不会互相挤掉
    // 对方（每个 hook 只能返回“一个”additionalContext）。
    let steer: string | null = null;
    if ((event === 'UserPromptSubmit' || event === 'PostToolUse') && agentId && this.control) {
      steer = this.control.takeSteer(agentId) ?? null;
    }

    // 让 god 的 roster 保持最新。fleet.json 在磁盘上总是新鲜的，但 god 的
    // 上下文不是：重启后它会恢复一段描述旧工作区的 transcript，
    // 然后给早已离开的 agent 发消息。在每次会话开始时以及每个提示词时
    // 把实时 roster 作为 additionalContext 推入，这样 god 始终
    // 了解工作区，而不是只在它记得 Read 的时候。
    // 仅 god 且只有一行——其他 agent 完全不受影响。
    const wantsRoster = (event === 'SessionStart' || event === 'UserPromptSubmit')
      && !!agentId && this.hive.isGod(agentId);
    // 把实时的上下文窗口占用（contextById）交给 roster，这样每行
    // agent 都能带上 `ctx NN%`——god 在路由工作时就能看到谁的上下文
    // 快满了，而不是靠累计 token 花费去猜。
    const roster = wantsRoster
      ? this.hive.rosterContext((id) => this.contextFor(id))
      : null;

    // 长期目标（hire Briefing）——持久化 roster 字段，每个周期重新读取，
    // 这样一次 Edit Agent 保存就会在下一个 SessionStart / UserPromptSubmit
    // 被拾取，无需重启 worker。不放进 --append-system-prompt
    // （无易变内容的缓存不变量）；而是放在实时的 hook 通道上。
    const wantsGoal = (event === 'SessionStart' || event === 'UserPromptSubmit') && !!agentId;
    const goalRaw = wantsGoal ? (this.getStandingGoal?.(agentId) ?? null) : null;
    const goal = goalRaw
      ? `<goal>\n${goalRaw}\n</goal>`
      : null;

    if (steer || roster || goal) {
      this.emit(agentId, event, p);
      return {
        hookSpecificOutput: {
          hookEventName: event,
          additionalContext: [roster, goal, steer].filter(Boolean).join('\n\n')
        }
      };
    }

    // 一条表示“agent 正卡在等待用户”的 Notification hook
    // （空闲提示）也值得一个桌面 toast——它与权限请求不同，
    // 权限请求会在 agent 自己的 Claude Code 会话中原生浮现
    // （可通过 /remote-control 远程批准）。
    if (
      event === 'Notification' &&
      (p.notification_type === 'idle' ||
        (p.message ?? '').toLowerCase().includes('waiting for your input'))
    ) {
      this.notify(agentId ?? l10n('Agent', '成员'), p.message ?? l10n('needs your attention', '需要你的关注'));
    }

    // 其余一切转发给渲染进程，让头像反映真实活动。
    this.emit(agentId, event, p);
    return {};
  }

  /** 触发一条原生桌面通知——以用户的 `notifications` 设置为门。
   *  只有 OS toast 被门控；hive:hookEvent 事件总是会发送，
   *  这样头像/UI 无论如何都保持实时。尽力而为：绝不向 hook 抛错。 */
  private notify(title: string, body: string): void {
    if (!this.getConfig().notifications) return;
    try {
      if (!Notification.isSupported()) return;
      new Notification({ title, body }).show();
    } catch { /* 该平台不支持通知——忽略 */ }
  }

  /** 告诉渲染进程一次工具调用被门控/拒绝（#7C.1），让它可以浮现出来
   *  （toast / 控制条）——与头像 hook 流区分开。 */
  private emitControl(agentId: string, tool: string | undefined, reason: string | undefined): void {
    this.getWebContents()?.send('control:approvalRequest', { agentId, tool, reason });
  }

  private emit(agentId: string | undefined, event: string, p: HookPayload, blocked = false): void {
    const payload = {
      agentId,
      event,
      tool: p.tool_name,
      notificationType: p.notification_type,
      source: p.source,
      message: p.message,
      blocked
    };
    if (!validateHookEvent(payload)) {
      console.warn('[hive] rejected invalid hook event:', event);
      return;
    }
    this.getWebContents()?.send('hive:hookEvent', payload);
  }
}

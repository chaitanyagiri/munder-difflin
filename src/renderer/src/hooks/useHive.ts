import { useEffect, useRef } from 'react';
import { useStore, type Agent, type QueuedMessage, type StationKind, type ToolKind } from '@/store/store';
import {
  buildSpawnCommand,
  ASSISTANT_MODEL,
  inferAgentProvider,
  isClaudeProvider,
  tokenizeCommand,
  type HarnessConfig
} from '@/store/config';
import {
  clearCommandForProvider,
  compactionCommandForProvider,
  remoteControlCommandForProvider,
  terminalReadyToReceive
} from '../../../shared/providerAutomation';
import { DEFAULT_CONTEXT_TRIGGER, type ContextRule } from '../../../shared/triggers';
import type { AgentProvider } from '../../../shared/agentProvider';
import { bridgeOf, providerPreset } from '../../../shared/agentProvider';
import { isDurableRole, preferredAgentRole, roleForHiveSpawn } from '../../../shared/agentRole';
import { inboxNudgeText } from '../../../shared/hiveNudge';
import { resolveGodName } from '../../../shared/godIdentity';
import { acquireTerminal, resetTerminal, isTerminalAutomationSafe } from '@/components/terminalPool';
import { canDeliverToAgent, deliverWithAcknowledgement, checkPrecondition } from './queueDelivery';
import { OFFICE_CAST, DEFAULT_CHARACTER } from '@/scene/office/cast';

const GOD_ID = 'god';
/** MAIN 拉起（语音雇佣）agent 用的强调色板——由 agent id 确定性选取，
 *  同一个 agent 总是得到同一个颜色。与 AddAgentModal 调色板保持一致。 */
const SPAWN_ACCENTS = ['coral', 'mint', 'sky', 'lemon', 'lilac', 'peach'] as const;
const GOD_PTY = `pty-${GOD_ID}`;

const REMOTE_CONTROL_SETTLE_MS = 1500;
// 与 provider 无关的 PTY 静默空闲回退 (#2e)。非 Claude 桥如果发出了
// 'working' 事件却从不发出回合结束信号（Stop / session.idle / agent_end），
// 会把 agent 永久钉在 'working' → 仅空闲触发的 inbox 唤醒 nudge 永不触发 →
// god 停止排空邮件，楼层停摆。因此，PTY 在该窗口内没有任何输出的
// 'working' agent 会被当作回合结束并翻转为 idle。流式回合（包括长时间
// 工具调用）会持续输出字节 → 保持 working；只有真正的静默才漂移到 idle。
// hook 事件仍然优先——新的 PreToolUse/Stop 会在下一个事件上刷新状态。
// 按 QUIESCE_POLL_MS 检查。
const QUIESCE_IDLE_MS = 12000;
const QUIESCE_POLL_MS = 4000;
// god/agent spawn 之后，在就绪握手 + provider 特有启动序列运行期间，
// 抑制 inbox 唤醒 + 队列排空输入。
const BOOT_GRACE_MS = 35_000;
// 把一次性 TUI 协议种子输入新 worker 前的延迟 (3b)——足够 TUI 完成绘制并
// 弹出任何权限提示。submitToPty 还会额外等待终端的就绪握手。
const SEED_BOOT_MS = 12_000;

/** 支持 hive / hooks 桥的引擎通过 HookServer 获得常驻目标
 *  (SessionStart + UserPromptSubmit)。Cursor 和其他无 hook 引擎需要把目标
 *  前置到排队的 PTY 投递上，这样 Edit Agent 保存后无需重启就能在下一个
 *  排空周期落地。 */
function usesHookStandingGoal(agent: Agent): boolean {
  const provider = inferAgentProvider(agent.command, agent.provider);
  const preset = providerPreset(provider);
  if (preset.hiveAware) return true;
  return bridgeOf(provider)?.kind === 'hooks';
}

/** 为无法通过 hooks 注入的引擎前置 `<goal>…</goal>`。读取实时 store 字段，
 *  因此刚保存的目标会在下一次队列冲刷时被拾取。 */
function withStandingGoal(agent: Agent, text: string): string {
  const goal = agent.goal?.trim();
  if (!goal || usesHookStandingGoal(agent)) return text;
  if (text.includes('<goal>')) return text;
  return `<goal>\n${goal}\n</goal>\n\n${text}`;
}

// 全新 spawn 后告诉 Michael (god) 的第一件事——让他认清方向并开始运行
// 楼层。保持简洁、行动导向。
const INITIAL_GOD_PROMPT = [
  "You're online as Michael, the orchestrator of the hive. Get oriented, then start running the floor:",
  '1. Read your memory.md and drain every message in your inbox.',
  '2. Review board.md + tasks.json and the current roster of agents (active vs archived).',
  '3. Check fleet health: read fleet.json in the hive root for every agent\'s live tokens, cost, status, breaker level, and inbox backlog (`claude agents` will NOT show your hive\'s agents). Flag anyone stalled, over-budget, or breaker-armed.',
  '4. Skim COMMANDS.md (hive root) for the Claude Code commands you can use — and run `mempalace wake-up` for a memory digest if the CLI is available.',
  'Then begin orchestrating: triage requests, delegate work to the team, and keep everyone unblocked. You are fully autonomous — there is no approval queue, so handle tool-permission prompts in this session yourself (the human can approve them remotely from their phone).'
].join('\n');

// 每条 pty 的提交流水线。对同一 pty 的每次 submitToPty 都追加到这里，确保
// 两个调用方（如启动序列的 /remote-control 与 inbox 唤醒 nudge）绝不互相
// 交错 text + Enter——那会把它们挤到同一行，产生 “Unknown command:
// /remote-control<下一个提示符>”。
const writeChains = new Map<string, Promise<void>>();
const readyPids = new Map<string, number>();

async function waitForTerminalReady(
  ptyId: string,
  provider: AgentProvider,
  timeoutMs = 30_000
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const live = await window.cth.listPtys();
    const pty = live.find((entry) => entry.id === ptyId);
    if (!pty) throw new Error(`PTY exited before becoming ready: ${ptyId}`);
    if (readyPids.get(ptyId) === pty.pid) return;
    if (terminalReadyToReceive(pty.hasOutput, Date.now() - started, provider)) {
      readyPids.set(ptyId, pty.pid);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`PTY did not become ready within ${timeoutMs}ms: ${ptyId}`);
}

/**
 * 向 agent 的 Claude Code TUI 输入一行文字并真正提交。
 *
 * 把文字与回车写进同一个块会让 TUI 把整段当作粘贴处理，于是 "\r" 变成输入
 * 框里的一行回车而不是提交——命令只是作为文本停在那里。所以我们先发送
 * 文字，稍后把 Enter 作为独立按键发出去，提示符才被注册并执行。空闲的
 * 自主 agent 因此能自行执行收到的指令。
 *
 * 对同一 pty 的提交是串行化的（并且每次 Enter 之后都等待 `settleMs`），
 * 并发调用方不会把输入挤在一起。
 *
 * 文本用方括号粘贴标记（ESC[200~ … ESC[201~）包起来，让 TUI 视为一次
 * 粘贴：内嵌换行以字面换行落入输入框。没有这些标记时，多行消息里的每个
 * "\n" 都会充当 Enter——消息被逐行分片提交（agent 只看到最后一块）。
 * 稍后一拍才发送的收尾 Enter 会提交整个块。 (#24) */
function submitToPty(
  ptyId: string,
  text: string,
  provider: AgentProvider,
  settleMs = 250
): Promise<void> {
  const prev = writeChains.get(ptyId) ?? Promise.resolve();
  const next = prev.catch(() => { /* 前一次失败的写入不能卡死整条流水线 */ }).then(async () => {
    await waitForTerminalReady(ptyId, provider);
    // 方括号粘贴 (ESC[200~ … ESC[201~) 只对多行文本有意义，防止多余的
    // "\n" 提前提交 (#24)。单行文本（nudge、斜杠命令）原样发送——有些 TUI
    // (Antigravity 的 agy) 会把粘贴标记当作字面输入而永不提交，跳过它们
    // 更稳妥。
    const payload = text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text;
    // writePty 对已死的 pty 永不 reject——它 resolve { ok:false, error:
    // 'no pty: …' }——因此这里未检查的 await 曾让每次失败投递都显得成功
    // （队列排空随即销毁它已弹出的消息，#36）。把失败以 rejection 形式
    // 抛出；流水线本身免疫（上面的 prev.catch 会为下一个写入者吸收它）。
    const wrote = await window.cth.writePty(ptyId, payload);
    if (!wrote?.ok) throw new Error(wrote?.error ?? `pty write failed: ${ptyId}`);
    await new Promise((r) => setTimeout(r, 140));
    const submitted = await window.cth.writePty(ptyId, '\r');
    if (!submitted?.ok) throw new Error(submitted?.error ?? `pty write failed: ${ptyId}`);
    await new Promise((r) => setTimeout(r, settleMs));
  });
  writeChains.set(ptyId, next);
  return next;
}

/** 把用户消息包装成给助手的 enrich 任务。助手的系统提示里已有完整指令；
 *  这里只框出这一件事。 */
function enrichTaskPrompt(text: string): string {
  return [
    `ENRICH TASK: ${text}`,
    '',
    '(Identify the relevant project, cd in, gather READ-ONLY context, then send the improved,',
    'self-contained prompt to Michael via an outbox message with "to":"god". Do not do the task yourself.)'
  ].join('\n');
}

function terminalWorkOrderPrompt(msg: {
  id: string;
  from: string;
  act: string;
  subject: string;
  body: string;
  requiresReply: boolean;
  createdAt: string;
}): string {
  return [
    'WORK ORDER FROM HIVE',
    `Message: ${msg.id}`,
    `From: ${msg.from}`,
    `Subject: ${msg.subject}`,
    `Act: ${msg.act}${msg.requiresReply ? ' (reply expected)' : ''}`,
    `Issued: ${msg.createdAt}`,
    '',
    msg.body,
    '',
    'Notes:',
    '- This message is also queued in your hive inbox — read it there and move handled messages to inbox/.done/.',
    '- Work in your current cwd.',
    '- When done, report changes, validation, blockers, and next step in this terminal.'
  ].join('\n');
}

/** 工具名 → 头像走向何处 + 携带什么。 */
const TOOL_STATION: Record<string, { station: StationKind; carry?: ToolKind }> = {
  Read: { station: 'shelf', carry: 'Read' },
  Edit: { station: 'desk', carry: 'Edit' },
  Write: { station: 'desk', carry: 'Write' },
  Bash: { station: 'terminal', carry: 'Bash' },
  Grep: { station: 'shelf', carry: 'Grep' },
  Glob: { station: 'shelf', carry: 'Glob' },
  WebFetch: { station: 'web', carry: 'WebFetch' },
  WebSearch: { station: 'web', carry: 'WebSearch' },
  TodoWrite: { station: 'board', carry: 'TodoWrite' },
  // #5A — 委托给子 agent 视为“在收件箱交接”。
  Task: { station: 'mailbox', carry: 'TodoWrite' }
};

/** 把工具名解析为站位/图标。回退规则：任何 `mcp__*` 工具 → MCP 站位
 *  （此前它们会静默停在工位上，#5A 缺口）；其他一律 → 工位。 */
function stationForTool(tool: string): { station: StationKind; carry?: ToolKind } {
  if (TOOL_STATION[tool]) return TOOL_STATION[tool];
  if (tool.startsWith('mcp__')) return { station: 'mcp', carry: 'MCP' };
  // 非 Claude 工具名的启发式回退（Antigravity 发送 run_command、ListDir、
  // write_file 等——它的 hook 名与 Claude 的确切标签不同）。
  // 先匹配 write/edit 再匹配 read，保证 "write_file" → 工位，而不是书架。
  const t = tool.toLowerCase();
  if (/command|bash|shell|exec|terminal|run_/.test(t)) return { station: 'terminal', carry: 'Bash' };
  if (/web|fetch|browser|http|url/.test(t)) return { station: 'web', carry: 'WebFetch' };
  if (/write|edit|create|patch|replace|apply/.test(t)) return { station: 'desk', carry: 'Write' };
  if (/read|list|view|dir|glob|grep|search|find|file|cat|\bls\b/.test(t)) return { station: 'shelf', carry: 'Read' };
  return { station: 'desk' };
}

/** 上下文窗口达到/超过此大小时，agent 算“大上下文”，改按
 *  `minContextPctLargeWindow` 判定。它位于应用实际会遇到的两种窗口尺寸
 *  （200k 与 1M）之间，避免两边都落入歧义。 */
const LARGE_CONTEXT_WINDOW = 500_000;

/**
 * 该 agent 上下文窗口的占用百分比，0-100；完全读不到时返回 null。
 *
 * 有两个来源写入 store，只有一个是精确的：状态栏 shim 推送真实的
 * `contextTokens` + `contextLimit`（effect 2d），而 transcript 轮询 (2c)
 * 只回填 tokens。因此 agent 可能合理地只知道 token 数而不知道窗口大小——
 * 用与 2c 相同的方式推断窗口，而不是把 token 读数丢掉。
 */
function contextFillPct(a: Agent): number | null {
  if (a.contextTokens === undefined || !Number.isFinite(a.contextTokens)) return null;
  const limit = a.contextLimit && a.contextLimit > 0
    ? a.contextLimit
    : 1_000_000;
  return (a.contextTokens / limit) * 100;
}

/**
 * 上下文压力门：该 agent 是否满到值得打断？
 *
 * `minContextPct` 为 0 时禁用此门（仅按规则自身的节奏触发）。
 *
 * 没有读数时开放放行。这是刻意选择：上下文遥测走 Claude 状态栏/hook
 * 路径，因此大多数非 Claude provider 什么都不报。在那里保守关闭会静默
 * 复活本修复要消灭的 bug——一个永不压缩的舰队——而且更难发现。因此
 * 未计量的 agent 回退为仅按时间触发，这正是旧行为，绝不更差。
 */
function passesContextPressure(a: Agent, rule: ContextRule): boolean {
  const large = (a.contextLimit ?? 0) >= LARGE_CONTEXT_WINDOW;
  const bar = large ? rule.minContextPctLargeWindow : rule.minContextPct;
  if (!(bar > 0)) return true;
  const pct = contextFillPct(a);
  if (pct === null) return true;
  return pct >= bar;
}

/**
 * 渲染端的 hive 胶水：
 *   1. 没有 god 在运行时，把 god agent spawn 进 Michael 的房间，
 *   2. 用真实的 Claude Code hook 事件驱动头像状态，并且
 *   3. 唤醒有未读 inbox 消息的空闲 agent，让协作不会在 agent 坐在提示符
 *      前时停滞。
 */
export function useHive(config: HarnessConfig | null): void {
  // 每个 agent 的 inbox 唤醒 nudge 去重：我们已就该 agent 的每条 inbox
  // 消息 id 提醒过它。用 SET 而不是高水位标记。
  //
  // 这里以前只存一个字符串——inbox 里字典序最大的 id，当作“最新”。消息 id
  // 通常形如 `<timestamp>-<rand>`，所以这个假设成立，但 agent 可以在 outbox
  // JSON 里自定义 `id`，hive 会原样保留（hive.ts normalize: `partial.id ?? ...`）。
  // god 的 inbox 里就有这样一个 id——`dev15-progress-canvas-v4`——它把每个
  // `2026-*` 时间戳都比下去且永不排空，于是“最新”id 就冻结在它上面：
  // Michael 每次启动应用只被提醒一次，之后无论后面堆了多少真邮件都不再提醒。
  // 记录已见过的 id 没有这种排序假设，同时保留了高水位标记的本意：
  // 排空会从 INBOX 中移除 id 而不新增任何内容，所以一次排空依然不会产生
  // nudge。
  //
  // 注意这个集合不做的事：它只会增长不会缩小。id 会累积到窗口生命周期结束
  // （重启即清空），因为忘记一个已提醒过的 id，会让该消息一出现在列表里就
  // 被重新提醒。代价是每条消息几十字节，对 7x24 的楼层而言真实存在，但与
  // 一个停摆的 agent 相比微不足道。驱逐已离开 inbox 的 id 本可以把集合
  // 限制到精确大小；这里刻意不做，以保持修复最小化。
  const nudged = useRef<Record<string, Set<string>>>({});
  // 上次排到自动 /compact 时各 agent 的上下文字节数。参见 context-trigger
  // effect 中的闩锁说明：空闲 agent 的 token 数是冻结的，没有这个闩锁，
  // 压力门会每个周期都对着同一个数字重新触发。
  const lastCompactUsed = useRef<Record<string, number>>({});
  // 每个 agent 上次提交队列消息的时间戳。防止在 agent 的 hooks 把它翻成
  // 'working' 之前重发下一条消息（我们输入后有一个短暂窗口它仍显示
  // 'idle'）。每个冷却窗口一条消息，保证严格逐条投递。
  const lastFlush = useRef<Record<string, number>>({});
  // 队列排空投递跟踪 (#36)：消息现在会留在队列里，直到其 PTY 写入链
  // resolve，因此 `inFlightSends`（正在写入的消息 id）防止 store 更新突发
  // 时重复发送队首，`sendFailures` 限制重试——写失败达到 MAX_SEND_ATTEMPTS
  // 后，消息会带着 console.warn 被丢弃，而不是被静默销毁。
  const inFlightSends = useRef<Set<string>>(new Set());
  const sendFailures = useRef<Record<string, number>>({});
  // 进行中的 spawn 守卫，防止重渲染 / StrictMode 双挂载把 Michael spawn
  // 两次（listPtys 检查与 spawnPty 之间的窗口有竞争）。
  const godSpawning = useRef(false);
  // 每个 agent 在此时间戳之前，自动输入器（inbox 唤醒 #3、队列排空 #4）
  // 必须放过它——在其启动序列输入期间设置，防止任何东西与 /remote-control
  // 和定向提示碰撞。
  const bootGraceUntil = useRef<Record<string, number>>({});
  // 已输入一次性 TUI 协议种子（Crush，seedDelivery:'type-into-tui'）的
  // agent——守卫 effect #3b 不重复播种。(ondev-b)
  const seeded = useRef<Set<string>>(new Set());
  const seenTerminalHandoffs = useRef<Set<string>>(new Set());
  // 每条 pty 的时间戳，守卫自动复活（effect #7）在电源恢复 + 屏幕解锁
  // 接连到达时重复 spawn：REVIVE_DEBOUNCE_MS 内已复活（或正在复活）的 id
  // 被跳过。在异步 spawn 之前设置，防止重入事件为同一 id 竞争第二次
  // respawn。
  const reviving = useRef<Record<string, number>>({});
  // 响应式的：Michael 就绪后助手引导（effect #1b）会重新运行。
  const godStatus = useStore((s) => s.godStatus);
  // 每条 pty 的 `lastOutputAt`，由静默扫描 (#2e) 刷新、队列排空 (#4) 读取，
  // 用来区分“停在提示符前”的终端与“回合中途”的终端。放在这里而不是在
  // #4 里重新抓取——#2e 已经按排空所需的精确节奏轮询 listPtys，单次读数
  // 让两个循环对“agent 是否安静”的判断保持一致。
  const ptyLastOutput = useRef<Record<string, number>>({});
    /** 该终端已静默多久；没有读数时返回 null（从未轮询、PTY 已消失、或
   *  从未输出任何内容）。canDeliverToAgent 对 null 保守关闭——无法测量的
   *  静默不是静默的证据。钩子级（而非 effect 局部），因为排空 effect 和
   *  context-trigger effect 都用同一个检查门控投递。 */
  const ptyQuietMs = (ptyId: string, now: number): number | null => {
    const last = ptyLastOutput.current[ptyId];
    return typeof last === 'number' && last > 0 ? now - last : null;
  };
  // #5C/#7C.4 — 每个 agent 最新的熔断器等级。为 'constrained'/'stopped'
  // 时头像被钉在 'looping'，hook 事件绝不能把它翻回 'working'（规范指出的
  // 闪烁问题）；只有真正的 Stop 能清除。
  const breakerLevel = useRef<Record<string, string>>({});

  // 0) 当楼层说明被状态字符串（雇佣后的“on standby”）覆盖后，用 hive
  //    `role` 修复名单里的 `description`。
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    void window.cth.hiveRegistry().then((reg) => {
      const roles: Record<string, string> = {};
      for (const [id, entry] of Object.entries(reg.agents ?? {})) {
        if (typeof entry.role === 'string' && entry.role.trim()) roles[id] = entry.role.trim();
      }
      useStore.getState().syncDescriptionsFromRoles(roles);
      const { agents, archivedAgents } = useStore.getState();
      for (const a of [...agents, ...archivedAgents]) {
        const next = preferredAgentRole(a.description, roles[a.id], !!a.isGod);
        if (isDurableRole(next) && next !== roles[a.id]) {
          void window.cth.hivePatchAgentRole(a.id, next);
        }
      }
    }).catch(() => { /* hive 尚未就绪 */ });
  }, [config?.onboardingComplete]);

  // 1) 引导 god agent（事实来源 = 活跃 PTY，以规避重启）。
  useEffect(() => {
    if (!config?.onboardingComplete || !config.harnessHome) return;
    let cancelled = false;
    useStore.getState().setGodStatus('booting');
    const t = setTimeout(async () => {
      if (cancelled) return;
      const live = await window.cth.listPtys().catch(() => []);
      if (live.some((p) => p.id === GOD_PTY)) { // 已在运行——保留已恢复的条目
        if (!cancelled) useStore.getState().setGodStatus('ready');
        return;
      }
      // 同步守卫（检查与设置之间没有 await）→ 恰好一次 spawn。
      if (cancelled || godSpawning.current) return;
      godSpawning.current = true;
      useStore.getState().removeAgent(GOD_ID); // 清除任何过期的已恢复条目

      // 之前的重命名（Edit Agent 面板 → renameAgent() → hive.ts 的
      // renameAgent()）会直接持久化到 registry.json，所以在这里读回而不是
      // 硬编码下面的 DEFAULT_GOD_NAME——否则即使注册表仍然正确，自定义名
      // 也会在每次 respawn 时被还原。
      const reg = await window.cth.hiveRegistry().catch(() => null);
      const godName = resolveGodName(reg?.agents?.[GOD_ID]?.name);

      const godProvider = config.godProvider ?? 'claude';
      const godModel = config.godModel;
      const command = buildSpawnCommand(config, godModel, godProvider);
      const [exe, ...args] = tokenizeCommand(command.trim());
      const res = await window.cth.spawnPty({
        id: GOD_PTY,
        cwd: config.harnessHome!,
        command: exe,
        provider: godProvider,
        args,
        cols: 100,
        rows: 30,
        // 跨应用重启恢复 Michael 之前的对话。他的会话 id 存在 hive 注册表里
        // （由其 hooks 记录），所以主进程会附加 `--resume <id>`；transcript
        // 缺失则回退为新会话。没有这个，楼层上最重要的上下文——编排者的——
        // 就会在每次重启时丢失。
        resume: true,
        hive: { id: GOD_ID, name: godName, provider: godProvider, cwd: config.harnessHome!, isGod: true, role: 'orchestrator (god)' }
      });
      if (cancelled) { godSpawning.current = false; return; }
      if (!res.ok) { godSpawning.current = false; useStore.getState().setGodStatus('failed'); return; }
      const god: Agent = {
        id: GOD_ID,
        name: godName,
        character: 'michael',
        accent: 'lemon',
        description: 'god — runs the floor, triages requests, escalates only critical calls to you',
        project: 'hive',
        tmuxTarget: '',
        cwd: config.harnessHome!,
        status: 'idle',
        action: '正在巡视办公室',
        progress: 0,
        currentStation: 'desk',
        ptyId: GOD_PTY,
        command: command.trim(),
        provider: godProvider,
        model: godModel,
        isGod: true,
        recentTextTs: Date.now()
      };
      useStore.getState().addAgent(god);
      useStore.getState().setGodStatus('ready');

      // Michael 的 TUI 起来后立刻踢他一脚。总是重新启用远程控制，让人类
      // 能从手机批准权限提示（尽力而为——一条失败/未知的斜杠命令只会打印到
      // 他的终端，无害）。
      // 然后，只在真正全新 spawn 时才把定向提示交给他——一个 RESUMED 的
      // Michael 已经拥有全部上下文，不能中途被重新定向（那会重置楼层的
      // 态势感知）。两者都走每条 pty 的提交流水线，因此严格串行、不会挤在
      // 一起；boot-grace 窗口让 inbox 唤醒/排空循环在 Michael 安定之前不去
      // 打扰他。上面的活跃-PTY 分支完全跳过这一切。
      const resumedGod = res.resumed === true;
      bootGraceUntil.current[GOD_ID] = Date.now() + BOOT_GRACE_MS;
      void (async () => {
        try {
          const remoteCommand = remoteControlCommandForProvider(godProvider, godName);
          if (remoteCommand) {
            // settleMs 让流水线在 /remote-control 之后暂停约 1.5s，再提交
            // 定向提示（仅全新 spawn）。
            await submitToPty(GOD_PTY, remoteCommand, godProvider, REMOTE_CONTROL_SETTLE_MS);
          }
          if (!cancelled && !resumedGod) {
            // type-into-tui 的 god (Crush) 无法通过 argv 带上 hive 协议，所以
            // 主进程以 seedPrompt 交回——先输入它（身份），再输入定向提示。
            // 经 writeChains 串行化，不会挤在一起。(ondev-b)
            if (res.seedPrompt) await submitToPty(GOD_PTY, res.seedPrompt, godProvider);
            await submitToPty(GOD_PTY, INITIAL_GOD_PROMPT, godProvider);
          }
        } catch { /* PTY 可能在启动期间死亡 */ }
        finally { bootGraceUntil.current[GOD_ID] = 0; }
      })();
    }, 1200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [config?.onboardingComplete, config?.harnessHome]);

  // 2) 用每个 agent 的 shim 发出的真实 hook 事件驱动头像。
  useEffect(() => {
    return window.cth.onHiveHookEvent((e) => {
      if (!e.agentId) return;
      const { updateAgent, agents } = useStore.getState();
      const self = agents.find((a) => a.id === e.agentId);
      if (!self) return;
      // 熔断器优先级 (#5C)：constrained/stopped 的 agent 保持 'looping'，
      // 不受进行中的工具/提示/压缩事件影响。
      const blevel = breakerLevel.current[e.agentId];
      const breakerArmed = blevel === 'constrained' || blevel === 'stopped';
      // hook 事件是真实 agent 状态的权威来源（pty 流解析器只细化楼层的
      // 动作/站位）。
      if (e.event === 'PreCompact') {
        // #5C — agent 进入 /compact；显示它正在打包上下文，而不是冻结。
        if (!breakerArmed) updateAgent(e.agentId, { status: 'compacting', action: '正在压缩上下文', carrying: undefined });
      } else if (e.event === 'PostCompact') {
        if (!breakerArmed) updateAgent(e.agentId, { status: 'working', action: '已恢复', carrying: undefined });
      } else if (e.event === 'PreToolUse' && e.tool) {
        const m = stationForTool(e.tool);
        if (!breakerArmed) updateAgent(e.agentId, { status: 'working', currentStation: m.station, carrying: m.carry, action: `正在使用 ${e.tool}` });
        useStore.getState().bumpToolCount(e.agentId); // 指挥中心的用量代理
      } else if (e.event === 'PostToolUse' || e.event === 'UserPromptSubmit') {
        // 回合进行中（提示已提交 / 工具刚结束）——保持 working，
        // 让它在工具调用之间不会闪烁成 idle。
        if (!breakerArmed) updateAgent(e.agentId, { status: 'working' });
      } else if (e.event === 'PreInvocation') {
        // Antigravity (agy)：模型正在被调用——它在思考/工作。
        if (!breakerArmed) updateAgent(e.agentId, { status: 'working', action: '思考中' });
      } else if (e.event === 'PostInvocation') {
        // agy 的每回合边界。与 Claude 不同，agy 的 Stop 只在进程 EXIT 时
        // 触发，所以没有这个事件，agy worker 永远不会登记为 idle，
        // inbox 唤醒 nudge（仅 idle）也就永远够不到它——它的邮件会一直
        // 排不空。当作 idle 处理；后续的工具/回合会重新置回 working。
        if (!breakerArmed) updateAgent(e.agentId, { status: 'idle', action: 'idle', carrying: undefined });
      } else if (e.event === 'Stop' || e.event === 'SubagentStop') {
        // 被阻塞的 Stop 意味着 agent 正被重新拉回来处理 inbox——它不是
        // idle，所以保持 working，直到它真正停下。
        if (e.blocked) {
          if (!breakerArmed) updateAgent(e.agentId, { status: 'working', action: '正在读取收件箱', carrying: undefined });
        } else {
          // 真正的停止清除任何熔断覆盖——回合结束了。
          breakerLevel.current[e.agentId] = 'healthy';
          updateAgent(e.agentId, { status: 'idle', action: 'idle', carrying: undefined });
        }
      } else if (e.event === 'Notification' && !breakerArmed) {
        // Claude Code 会在两种截然不同的情况下触发 Notification：
        //   1. 它真的需要人类（权限/审批提示），或
        //   2. 提示符只是进入空闲（“Claude is waiting for your input”）
        //      ——即 agent 已回答完且没有排队内容。
        // 只有 (1) 才是真正的“需要你”。把 (2) 当作 blocked 会让 Michael
        // 每次刚干完活就举着红色“!”走到门口，所以要识别空闲情形，让他
        // 留在楼层上。
        const msg = (e.message ?? '').toLowerCase();
        const idleWaiting = !msg
          || msg.includes('waiting for your input')
          || msg.includes('is idle')
          || msg.includes('waiting for input');
        const needsHuman = msg.includes('permission')
          || msg.includes('approve')
          || msg.includes('confirm')
          || msg.includes('needs your');
        if (needsHuman && !idleWaiting) {
          // 只有 god agent 会升级给人类；子 agent 是自主的，读作 "waiting"
          // （停在 god 上，而不是等你）。
          updateAgent(e.agentId, { status: self.isGod ? 'blocked' : 'waiting' });
        } else {
          // 空闲通知——已应答、无事可做。留下来，别标记。
          updateAgent(e.agentId, { status: 'idle', action: 'idle', carrying: undefined });
        }
      }
    });
  }, []);

  // 2b) 消费熔断器状态 (#7C.4/#5C)。Lane A 的熔断器策略 (#6) 通过
  //     `control:breakerState` 推送 BreakerState；这里给它对 hook 派生状态的
  //     优先级：constrained/stopped 的 agent 被钉在 'looping'（见上面的
  //     breakerArmed 守卫），直到真正 Stop。
  useEffect(() => {
    return window.cth.onBreakerState((s) => {
      breakerLevel.current[s.agentId] = s.level;
      const { updateAgent, agents } = useStore.getState();
      if (!agents.some((a) => a.id === s.agentId)) return;
      if (s.level === 'constrained' || s.level === 'stopped') {
        updateAgent(s.agentId, { status: 'looping', action: s.reason || '熔断已触发', carrying: undefined });
      }
      // 'healthy'/'steering' clear the pin; the next hook event refreshes status.
    });
  }, []);

  // 2c) 上下文计量表回填：轮询每个活跃 agent 当前上下文大小（tokens），
  //     数据来自其会话 transcript——仅在状态栏（effect 2d）尚未为该 agent
  //     送达精确数字之前。
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const poll = async () => {
      const { agents, updateAgent } = useStore.getState();
      for (const a of agents) {
        if (!a.ptyId) continue;
        // 状态栏每次响应后都会推送精确数字（effect 2d）——这个 transcript
        // 轮询只为状态栏尚未触发的 agent 回填（例如刚恢复、尚无响应的）。
        if (a.contextLimit !== undefined) continue;
        try {
          const ctx = await window.cth.agentContext(a.id);
          if (ctx === null) continue;
          const limit = 1_000_000;
          const progress = Math.max(0, Math.min(8, Math.round((ctx / limit) * 8)));
          updateAgent(a.id, { contextTokens: ctx, progress });
        } catch { /* 忽略——下个 tick 重试 */ }
      }
    };
    const t = setTimeout(poll, 3000); // 启动后不久先填一次
    const iv = setInterval(poll, 15000);
    return () => { clearTimeout(t); clearInterval(iv); };
  }, [config?.onboardingComplete]);

  // 2d) 推送式上下文计量表：状态栏 shim 在每次响应后转发会话的精确上下文
  //     账目（tokens + 真实窗口大小）——无需探测，无需猜 transcript。
  useEffect(() => {
    return window.cth.onHiveContextUpdate(({ agentId, tokens, limit }) => {
      // 纵深防御：主进程已经过滤 limit > 0，但渲染端不能盲目信任 IPC——
      // limit 为 0 会把 NaN progress 放进 store（NaN 能穿过 Math.min/max
      // 钳制）。
      if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(tokens)) return;
      const progress = Math.max(0, Math.min(8, Math.round((tokens / limit) * 8)));
      useStore.getState().updateAgent(agentId, { contextTokens: tokens, contextLimit: limit, progress });
    });
  }, []);

  // 2e) 非 Claude provider 无法排空 hive inbox。发往它们的 hive 邮件在这里
  //     以终端工单形式到达，并与人类撰写的消息走同一条仅空闲 PTY 排空通道。
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    return window.cth.onHiveTerminalHandoff((msg) => {
      if (seenTerminalHandoffs.current.has(msg.id)) return;
      const { agents, enqueueMessage, messageQueues } = useStore.getState();
      const target = agents.find((a) => a.id === msg.to);
      if (target?.ptyId) {
        const marker = `Message: ${msg.id}`;
        if ((messageQueues[target.id] ?? []).some((queued) => queued.text.includes(marker))) return;
        seenTerminalHandoffs.current.add(msg.id);
        enqueueMessage(target.id, terminalWorkOrderPrompt(msg));
        return;
      }
      seenTerminalHandoffs.current.add(msg.id);
      enqueueMessage(
        GOD_ID,
        [
          `给 ${msg.to} 的终端交接失败: ${msg.subject}`,
          '',
          `来自 ${msg.from} 的消息 ${msg.id} 无法入队，因为 ${msg.to} 没有活动的 PTY。请手动路由或重新生成该 agent。`
        ].join('\n')
      );
    });
  }, [config?.onboardingComplete]);

  // 2e) 与 PROVIDER 无关的 PTY 静默空闲回退（让 canReceiveInbox:true 对
  //     未经实盘验证的 OpenCode/Crush/pi 桥也安全的关键机制）。
  //     hook 事件是权威状态来源，但回合结束信号（Stop/session.idle/
  //     agent_end）不触发的桥会把 agent 钉在 'working'——而两条投递路径
  //     （#3 nudge、#4 队列排空）都以 idle 为门，agent 会静默停止排空邮件。
  //     usePtyParser 有 4s 空闲漂移，但它是为 Claude TUI 调校的，且只作用于
  //     已挂载的终端——后台化的 god 一个都拿不到。这里是楼层级、与
  //     provider 无关的最后防线：读取每个活跃 PTY 的 lastOutputAt（主进程
  //     已在跟踪），把 QUIESCE_IDLE_MS 内保持安静的 'working' agent 翻转
  //     为 idle，让 nudge 能排空它。安全因为真正在工作的 agent（包括长时间
  //     流式工具）会持续输出字节；误判的 idle 会在下一个 hook 事件自纠。
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const iv = setInterval(async () => {
      const ptys = await window.cth.listPtys().catch(() => []);
      const lastOut: Record<string, number> = {};
      for (const p of ptys) lastOut[p.id] = p.lastOutputAt;
      // 在提前返回和下面的 'working' 过滤之前发布，让排空 (#4) 也为被
      // 熔断钉住的 agent 拿到读数——也让消失的 PTY 清除其条目而不是留下
      // 过期值。
      ptyLastOutput.current = lastOut;
      if (!ptys.length) return;
      const now = Date.now();
      const { agents, updateAgent } = useStore.getState();
      for (const a of agents) {
        if (!a.ptyId || a.status !== 'working') continue;
        // 绝不与熔断钉住对抗（constrained/stopped 的 agent 保持 'looping'），
        // 也不碰仍在启动的 agent（其启动序列正在输入中）。
        const bl = breakerLevel.current[a.id];
        if (bl === 'constrained' || bl === 'stopped') continue;
        if ((bootGraceUntil.current[a.id] ?? 0) > now) continue;
        const last = lastOut[a.ptyId];
        if (typeof last === 'number' && last > 0 && now - last > QUIESCE_IDLE_MS) {
          updateAgent(a.id, { status: 'idle', action: 'idle', carrying: undefined });
        }
      }
    }, QUIESCE_POLL_MS);
    return () => clearInterval(iv);
  }, [config?.onboardingComplete]);

  // 3) 唤醒持有未读 inbox 消息的 agent。助手只发不收（它从不接收 inbox
  //    邮件），所以被排除。
  //
  //    把 nudge QUEUE 起来而不是直接输入。这个循环以前直接写终端，使它
  //    成为唯一可能落在用户正在输入内容之上的自动写入者——它的文本与用户
  //    写到一半的行融合，整对被当作一条乱码提示提交。改走队列意味着
  //    effect #4 全权决定何时可以向终端输入：idle、冷却期外、过了启动宽限、
  //    投递未暂停、且没有用户草稿挡路。一个门、一处集中，这个循环不再需要
  //    自己的提示逻辑。/compact (effect #6) 一直就是这么做的。
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const iv = setInterval(async () => {
      const agents = useStore.getState().agents.filter((a) => a.ptyId);
      for (const a of agents) {
        try {
          const inbox = await window.cth.hiveInbox(a.id);
          // 对任何尚未提醒过的 id 触发 nudge (#130 的按 id Set)。
          // 排空会缩小集合且不引入新内容，所以这个 POLL 保持安静；真正
          // 的新消息无论其 id 碰巧怎么排序都会触发。
          //
          // 这个推理只覆盖轮询——它撑不过 enqueue 与投递之间的间隙，所以
          // nudge 携带 'inbox-nonempty' 前置条件，排空在输入前会重新检查。
          // 没有它：邮件落地并排队 nudge，已经醒着的 agent 在同一回合排空
          // 整个 inbox，之后 nudge 被输入到一个空 inbox——浪费一个回合，
          // 而当 agent 是 god 时这是楼层上最贵的回合。
          const seen = nudged.current[a.id] ?? (nudged.current[a.id] = new Set());
          const fresh = inbox.filter((m) => m.id && !seen.has(m.id));
          if (fresh.length) {
            // 指名 id：nudge 现在入队、在 agent 下次空闲时输入，所以它可能
            // 在 agent 已经排空并归档这封邮件很久之后才到达。携带 id 才能
            // 区分“已处理”与“白唤醒”。队列每个 agent 只保留一条待决
            // nudge（见 enqueueMessage），被抑制的副本的 id 保持无名——
            // 因此文本指向待决 inbox 作为权威，而不是这份列表。
            useStore.getState().enqueueMessage(
              a.id,
              inboxNudgeText(fresh.map((m) => m.id)),
              { precondition: 'inbox-nonempty' }
            );
            for (const m of fresh) seen.add(m.id);
          }
        } catch { /* 忽略 */ }
      }
    }, 4000);
    return () => clearInterval(iv);
  }, [config?.onboardingComplete]);

  // 3b) 用 hive 协议给全新 “type-into-tui” worker (Crush) 播种。它的裸
  //     TUI 拒绝位置参数种子（Cobra 把它当作子命令 → `Unknown command`），
  //     所以主进程裸 spawn 它，把协议以 `seedPrompt` 交回；我们把它作为
  //     worker 的第一回合在启动宽限后输入（TUI 完成绘制后），每个 agent
  //     一次。与 inbox 唤醒 nudge 走同一条 per-pty 提交流水线 + 启动宽限，
  //     种子与 nudge 永远不会挤到同一行。(god-as-Crush 在其自有启动序列中
  //     播种；这里覆盖 workers。) (ondev-b)
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const iv = setInterval(() => {
      const { agents, updateAgent } = useStore.getState();
      for (const a of agents) {
        if (!a.ptyId || a.isGod || !a.seedPrompt || seeded.current.has(a.id)) continue;
        seeded.current.add(a.id);
        const ptyId = a.ptyId;
        const seed = a.seedPrompt;
        // 在种子落地并安定之前，让 nudge/静默输入器离这个 agent 远点。
        bootGraceUntil.current[a.id] = Date.now() + BOOT_GRACE_MS;
        // 现在就清掉记录，避免被再次看到（ref 也是守卫）或持久化。
        updateAgent(a.id, { seedPrompt: undefined });
        setTimeout(() => {
          // 权限提示安全 (#5)：如果 worker 在其 TUI 启动期间浮出审批/需要
          // 人类的提示（'waiting'/'blocked'），种子的收尾 Enter 会确认它。
          // 把种子放回去，等提示清除后由稍后的 tick 重试；如果 agent 消失
          // （启动中被杀），就完全不要向它的孤儿 pty 输入。
          const live = useStore.getState().agents.find((x) => x.id === a.id);
          if (!live) return;
          if (live.status === 'waiting' || live.status === 'blocked') {
            seeded.current.delete(a.id);
            useStore.getState().updateAgent(a.id, { seedPrompt: seed });
            return;
          }
          submitToPty(
            ptyId,
            withStandingGoal(live, seed),
            inferAgentProvider(live.command, live.provider)
          )
            .catch(() => { /* pty 可能已死 */ });
        }, SEED_BOOT_MS);
      }
    }, 1500);
    return () => clearInterval(iv);
  }, [config?.onboardingComplete]);

  // 4) 在 agent 空闲的那一刻，把每个 agent 排队的消息逐条排空到它的终端。
  //    这让用户可以在 agent 的“云端终端”运行期间继续发消息：消息停在
  //    store 里，等它一有空就被输入（并提交）。
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const FLUSH_COOLDOWN_MS = 4500;
    // 一条消息若连续这么多次 PTY 写入失败（store 仍以为它空闲的死/崩 pty）
    // 会被丢弃并带 console.warn——有界以免排空在尸体上永远打转，发声以便
    // 损失可诊断。(#113)
    const MAX_SEND_ATTEMPTS = 3;
    const inFlight = new Set<string>();
    const sendFailures: Record<string, number> = {};


    // 把 `srcId` 队列头部的消息发送到 `target` 的 pty（原样或包装后），
    // 以 target 空闲、没有交互菜单、且不在冷却期为门。队列项只有在两次
    // PTY 写入都成功后才会被确认；失败保持可见并按 MAX_SEND_ATTEMPTS
    // 有界自动重试，排空不会在尸体上永远打转。
    const dispatch = async (
      srcId: string,
      target: Agent | undefined,
      wrap?: (m: QueuedMessage) => string
    ): Promise<{ sent: boolean; message?: QueuedMessage }> => {
      const { messageQueues, removeQueuedMessage } = useStore.getState();
      const next = messageQueues[srcId]?.[0];
      if (!next || !target?.ptyId) return { sent: false };
      const now = Date.now();
      // 空闲，或被熔断钉住但终端真正安静了。
      // 这个门是不在流中输入的 safety 检查，`manual` 不会绕过它——
      // “立即发送”只解除下面的自动投递暂停，不解除此门。
      if (!canDeliverToAgent(target.status, ptyQuietMs(target.ptyId, now), QUIESCE_IDLE_MS)) {
        return { sent: false };
      }
      const control = await window.cth.controlSnapshot(target.id);
      // 暂停门拦截所有消息，除了用户用“立即发送”明确放行的（m.manual）——
      // 否则暂停的楼层会让队列完全没有逃生通道。下面的 idle/草稿/选择器
      // 安全对 manual 消息仍然适用；只有暂停被绕过。
      if (control?.autoDeliveryPaused && !next.manual) return { sent: false };
      // 在 target 完成启动序列之前扣住排队消息。
      if ((bootGraceUntil.current[target.id] ?? 0) >= now) return { sent: false };
      // 提示符归用户所有：正在写的草稿，或打开的菜单，都会扣住投递。两者
      // 半小时后过期，过期后我们只在现有内容后面输入——自动化绝不擦除用户
      // 的文本，也绝不关闭用户的菜单。
      if (!isTerminalAutomationSafe(target.ptyId, now)) return { sent: false };
      if (now - (lastFlush.current[target.id] ?? 0) < FLUSH_COOLDOWN_MS) return { sent: false };
      // 输入前的最后一道门：重新检查消息投递时的前置条件。队列项在入队时
      // 决策、在间隔任意长之后投递，inbox nudge 只有在 inbox 里还有东西时
      // 才值得发送——agent 通常会在 nudge 入队的同一回合排空它。过期的
      // 直接 DROP 而不是 defer，避免它们停在队首饿死其余消息。
      if (await checkPrecondition(next, () => window.cth.hiveInbox(srcId)) === 'drop') {
        removeQueuedMessage(srcId, next.id);
        return { sent: false };
      }
      const flightKey = `${srcId}:${next.id}`;
      if (inFlight.has(flightKey)) return { sent: false };
      inFlight.add(flightKey);
      lastFlush.current[target.id] = now;
      try {
        const sent = await deliverWithAcknowledgement(
          // `instruction`（若有）是要输入 PTY 的权威文本；UI/卡片界面继续
          // 显示可读的 `text`。
          () => submitToPty(
            target.ptyId!,
            withStandingGoal(
              target,
              wrap ? wrap(next) : (next.instruction ?? next.text)
            ),
            inferAgentProvider(target.command, target.provider)
          ),
          () => {
            removeQueuedMessage(srcId, next.id);
            // 已投递的 /clear 之后把计量表清零——新会话的上下文要等
            // statusLine 在清空后的首次响应才会出现，留着旧值会显示一个
            // 过期的满格条。
            if (next.text.trim().toLowerCase() === '/clear') {
              useStore.getState().updateAgent(target.id, {
                contextTokens: 0,
                contextLimit: undefined,
                progress: 0
              });
            }
          }
        );
        if (sent) {
          delete sendFailures[next.id];
          return { sent: true, message: next };
        }
        // 写入失败（store 仍以为空闲的死/崩 pty）：在下一次冷却间隔的冲刷
        // 重试，但只重试 MAX_SEND_ATTEMPTS 次——然后带响动丢弃，让损失
        // 可诊断。(#113/#36)
        const attempts = (sendFailures[next.id] ?? 0) + 1;
        sendFailures[next.id] = attempts;
        if (attempts >= MAX_SEND_ATTEMPTS) {
          delete sendFailures[next.id];
          removeQueuedMessage(srcId, next.id);
          console.warn(
            `[queue-drain] dropping message ${next.id} for ${target.id} after ${attempts} failed pty writes ` +
            `("${next.text.slice(0, 80)}${next.text.length > 80 ? '…' : ''}")`
          );
        }
        return { sent: false };
      } finally {
        inFlight.delete(flightKey);
      }
    };

    // 第一次分发到办公室时，把真正的 Slack 来源工作项升级为带戳的看板卡片。
    // 卡片携带 slack:{channel,thread_ts}（来源线程），让主进程的完成观察者
    // 能在卡片稍后达到 'done' 时在原始线程里回复一条总结。加性 + 幂等 +
    // 尽力而为：这里的失败绝不影响已经发生的分发，而且只有已分发的工作项
    // 会走到这里（斜杠命令/ack 永远不会）。
    type SlackTaskCard = Parameters<typeof window.cth.hiveAddTask>[0];
    const ensureSlackCard = async (m: QueuedMessage): Promise<void> => {
      const slack = m.slack;
      if (!slack) return;
      try {
        const raw = await window.cth.hiveTasks();
        const existing: SlackTaskCard[] =
          raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks)
            ? (raw as { tasks: SlackTaskCard[] }).tasks
            : [];
        const id = `slack-${slack.thread_ts}-${m.id}`;
        if (existing.some((t) => t.id === id)) return; // 已升级——不重复
        const title = m.text.length > 80 ? `${m.text.slice(0, 79)}…` : m.text;
        const card: SlackTaskCard = {
          id,
          title,
          description: m.text,
          status: 'todo',
          dependsOn: [],
          priority: 1,
          createdAt: new Date().toISOString(),
          slack
        };
        await window.cth.hiveAddTask(card);
      } catch { /* 尽力而为：卡片升级绝不能拖垮分发 */ }
    };

    const flush = () => {
      const { agents, messageQueues } = useStore.getState();
      const byId = (id: string) => agents.find((a) => a.id === id);
      const now = Date.now();

      for (const a of agents) {
        // 与 dispatch() 相同的门——这个预过滤先跑，只放宽 dispatch 内部的
        // 一个门不会有任何改变。
        if (!a.ptyId || !canDeliverToAgent(a.status, ptyQuietMs(a.ptyId, now), QUIESCE_IDLE_MS)) continue;
        if (!messageQueues[a.id]?.length) continue;
                void dispatch(a.id, a).then(({ sent, message }) => {
          if (sent && message?.slack) void ensureSlackCard(message);
          // 只在真正投递后写入压缩闩锁——见上面 fire() 中的注释。
          if (sent && message?.compactUsed !== undefined) {
            lastCompactUsed.current[a.id] = message.compactUsed;
          }
        });
      }
    };

    // 在每次 store 变化时运行（状态翻转、新队列项）——去抖让 pty 流更新
    // 突发合并——外加一个周期兜底。
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (debounce) return;
      debounce = setTimeout(() => { debounce = null; flush(); }, 200);
    };
    const unsub = useStore.subscribe(schedule);
    const iv = setInterval(flush, 3000);
    schedule();
    return () => { unsub(); if (debounce) clearTimeout(debounce); clearInterval(iv); };
  }, [config?.onboardingComplete]);

  // 5) 把入站 Slack 消息导入 Michael 的队列。主进程 Slack webhook 服务器经
  //    IPC 把每条验证过的消息推到这里；入队到 GOD_ID 让它像用户亲手在
  //    输入框输入一样落进 Michael 的队列——上面的 effect #4 随后把它排空
  //    到他的 PTY。
  //    我们立即在触发线程里 ack，并暂存线程坐标，供办公室稍后把总结
  //    发回去。
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    return window.cth.onSlackMessage((msg) => {
      const hasFiles = Array.isArray(msg.files) && msg.files.length > 0;
      if (!msg?.text?.trim() && !hasFiles) return;
      let text = msg.text.trim();
      // 追加本地文件路径，让 agent (Claude Code) 可以直接 Read 它们。
      if (hasFiles) {
        const fileLines = msg.files!.map((f) => `- ${f.path} (${f.name})`).join('\n');
        text = text ? `${text}\n\n附件文件:\n${fileLines}` : `附件文件:\n${fileLines}`;
      }
      const slack = { channel: msg.channel, thread_ts: msg.thread_ts };
      // `text`（原始用户请求 + 任何附件行）驱动面向人类的看板卡片标题/
      // 描述。自治前言——由 main（权威来源）逐字提供——只前置到 god 的
      // 工作指令上（要输入他 PTY 的内容），这样看板保持可读，同时每条
      // Slack 来源的 god 会话都在自治策略下运行。当 main 不发送前言
      // （旧构建）时，god 只拿到原始文本。
      const instruction = msg.autonomyPreamble ? `${msg.autonomyPreamble}${text}` : undefined;
      useStore.getState().enqueueMessage(GOD_ID, text, { slack, instruction });
      // 在来源 Slack 线程里立即“已排队”确认。
      void window.cth.slackReply({
        channel: msg.channel,
        thread_ts: msg.thread_ts,
        text: ':hourglass_flowing_sand: *Received.* Your request has been queued — the team is on it and will reply here when done.'
      });
    });
  }, [config?.onboardingComplete]);

  // 5b) 把发给非 Claude agent（如 Codex）的 hive 任务导入其终端队列。
  //     当 main 把消息路由给非 claude provider 时，它发出
  //     'hive:enqueueToAgent' 而不是弹回；我们在这里把原始任务文本入队，
  //     好让 effect #4 在 agent 空闲时把它输入 REPL。
  //     没有 inbox nudge，没有 /compact——只是逐字的 subject+body 文本。
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    return window.cth.onHiveEnqueue?.((msg) => {
      if (!msg?.targetId || !msg?.text?.trim()) return;
      useStore.getState().enqueueMessage(msg.targetId, msg.text.trim());
    });
  }, [config?.onboardingComplete]);

  // 5b) MAIN 发起的名单变更（rt-5 语音 spawn/kill）。渲染端 store 只被渲染端
  //     发起的雇佣（AddAgentModal）变更；语音雇佣/击杀运行在 MAIN
  //     (spawnAgentCore / teardownPty, owner=null)，否则在楼层上不可见。
  //     Main 广播；我们在这里建/归档卡片。
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const offSpawn = window.cth.onHiveAgentSpawned?.((rec) => {
      if (!rec?.id) return;
      // addAgent 是幂等的，但若渲染端已建卡就提前返回。
      if (useStore.getState().agents.some((a) => a.id === rec.id)) return;
      // 显式角色优先；否则从名字推断——这就是“spawn one called Meredith”
      // 无需其他条件就落在 Meredith 头像上的原因。显式字段覆盖推断无法
      // 表达的情形：一个叫别的名字但看起来仍应是特定角色的 agent。未知值
      // 落到推断上而不是弄坏卡片。
      const castMember = (q?: string) =>
        q ? OFFICE_CAST.find((m) => m.name === q || m.displayName.toLowerCase() === q)?.name : undefined;
      const character =
        castMember(rec.character?.trim().toLowerCase()) ??
        castMember((rec.name || rec.id).toLowerCase()) ??
        DEFAULT_CHARACTER;
      // 强调色原本是从 worker id 哈希出来的，稳定但不可选。未识别的强调色
      // 保持哈希。
      const askedAccent = SPAWN_ACCENTS.find((a) => a === rec.accent?.trim().toLowerCase());
      let h = 0;
      for (const ch of rec.id) h = (h + ch.charCodeAt(0)) % SPAWN_ACCENTS.length;
      const project = (rec.cwd || '').split(/[\\/]/).filter(Boolean).pop() || 'hive';
      const agent: Agent = {
        id: rec.id,
        name: rec.name || rec.id,
        character,
        accent: askedAccent ?? SPAWN_ACCENTS[h],
        description: rec.role || 'a fresh harness',
        project,
        tmuxTarget: '',
        cwd: rec.cwd,
        status: 'idle',
        action: '正在启动',
        progress: 0,
        currentStation: 'desk',
        ptyId: rec.id,
        command: rec.command,
        provider: rec.provider as Agent['provider'],
        isGod: false,
        recentTextTs: Date.now()
      };
      useStore.getState().addAgent(agent);
    });
    const offArchive = window.cth.onHiveAgentArchived?.((e) => {
      if (e?.id) useStore.getState().archiveAgent(e.id);
    });
    return () => { offSpawn?.(); offArchive?.(); };
  }, [config?.onboardingComplete]);

  // 5c) v0.3.4 语音桥：main 暂存队列插入（clear_context）并推到这边，
  //     让投递走遍每道既有门——仅空闲、启动宽限、草稿/选择器安全、
  //     自动投递暂停。确认策略归 main 管；这里只是入队。
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    return window.cth.onRealtimeEnqueue?.((evt) => {
      if (!evt?.agentId || typeof evt.text !== 'string' || !evt.text.trim()) return;
      const { agents, enqueueMessage } = useStore.getState();
      if (!agents.some((a) => a.id === evt.agentId)) return;
      enqueueMessage(evt.agentId, evt.text.trim());
    });
  }, [config?.onboardingComplete]);

  // 6) CONTEXT TRIGGERS (compact / clear)。Main 决定何时——节奏、以及规则
  //    的哪一半触发——并推送 `{action, rule}`；这里决定对谁，然后把
  //    provider 自己的命令入队，让排空 (#4) 只在空闲提示符投递它，绝不
  //    挤进一个工作中的终端。
  //
  //    压力门。main/config.ts 早就 DOCUMENTED 自动压缩“只压缩上下文已
  //    填过阈值（~250k 窗口 30%，~1M 窗口 20%）的 agent”。这个检查从未
  //    实现过：每个有可解析命令的活跃 agent 每个 tick 都被压缩，每小时，
  //    无论窗口多空。这里让文档行为成真——`rule.minContextPct`，或窗口
  //    >= LARGE_CONTEXT_WINDOW 时的 `minContextPctLargeWindow`，必须先满足
  //    才能打断一个 agent。（发版数值现在是 60/40，是那份过期文档的两倍；
  //    见 DEFAULT_CONTEXT_TRIGGER。config.ts 里的 doc 注释仍是旧的。）
  //
  //    去重推广到两种动作：以命令自身的动词为键，排队中的 /compact 会
  //    拦住第二个 compact，而不会拦 /clear。
  useEffect(() => {
    if (!config?.onboardingComplete) return;

       const fire = (action: 'compact' | 'clear', rule: ContextRule): void => {
      const { agents, messageQueues, enqueueMessage } = useStore.getState();
      const now = Date.now();
      for (const a of agents) {
        if (!a.ptyId) continue;
        // Gate #109-2：不要为当前无法接收上下文命令的 agent 入队（例如
        // god 'blocked' 在人类提示前）。照旧入队会让一条卡死的 /compact
        // 停在队首，去重随后把它对着的每次每小时尝试都永久折叠掉——
        // 这正是排空本身在输入前用的那道检查，所以绝不会在排空拒绝投递
        // 的状态下入队一条命令。
        if (!canDeliverToAgent(a.status, ptyQuietMs(a.ptyId, now), QUIESCE_IDLE_MS)) continue;
        const provider = inferAgentProvider(a.command, a.provider);
        const command = action === 'clear'
          ? clearCommandForProvider(provider, rule.message)
          : compactionCommandForProvider(provider, rule.message);
        // 该 CLI 没有可信命令（Crush 的纯调色板 TUI、Copilot 的打印模式、
        // 未知自定义二进制）——别碰它的终端。
        if (!command) continue;
        if (!passesContextPressure(a, rule)) continue;
        const verb = command.trimStart().split(/\s+/)[0];
        const queued = messageQueues[a.id] ?? [];
        if (queued.some((m) => m.text.trimStart().startsWith(verb))) continue;
        // 闩锁，仅 compact。`used` 从 Claude 状态栏到达此门，而状态栏只在
        // API 调用后报告。对一个自上次压缩以来什么都没做的 agent 发
        // /compact 根本不会触发调用——Claude 本地拒绝它，报 "Not enough
        // messages to compact"——所以计数保持逐字节相同，压力门下个周期、
        // 再下个周期都对着同一个数字放行。线上见到的：连续 15 个小时每小时
        // 一次 /compact、恰好 400958 tokens，然后又在恰好 221772 上再来 11
        // 次，每次都是 agent 仍然要读要答的无操作。提高阈值只会让它更少见
        // 而非消失：任何停在阈值之上的 agent 都会无限重复。
        //
        // 所以记住上次 compact 入队时的计数，逐字节相同时跳过。刻意用
        // 相等而非“没增长”：阈值决策归规则所有，仍在阈值之上的 agent
        // 无论计数上还是下都该得到它的 /compact。冻结的计数是阈值无法
        // 推理的唯一状态，因为无论它们做什么都不会改变它。/clear 无需
        // 等价物——队列排空在它落地时会把 store 读数清零。
               const used = a.contextTokens ?? 0;
        if (action === 'compact' && lastCompactUsed.current[a.id] === used) continue;
        // 闩锁在成功 DELIVERY 时写入（见下方 flush() 的 dispatch 回调），
        // 而不是这里。入队时写入会为一次可能根本不会发生的压缩记录
        // “已在 N tokens 压缩过”——例如被上面这道门挡住，或发送失败——
        // 静默把该计数下的所有未来尝试都闩死。compactUsed 搭载在排队消息
        // 上，让投递现场知道要闩哪个计数。
        enqueueMessage(a.id, command, action === 'compact' ? { compactUsed: used } : undefined);
      }
    };

    // 类型化 `onContextTrigger` 随发出它的主进程/preload 变更一起到达；
    // 防御性地访问它，让本代码独立于该变更落地。
    const off = (window.cth as unknown as {
      onContextTrigger?: (
        cb: (p: { action: 'compact' | 'clear'; rule: ContextRule }) => void
      ) => () => void;
    }).onContextTrigger?.((p) => {
      if (!p?.rule) return;
      fire(p.action === 'clear' ? 'clear' : 'compact', p.rule);
    });

    // LEGACY 回退：在切换完成前，main 仍发出旧的无参数自动压缩。把它当作
    // 默认压缩规则处理，让行为在其落地期间保持连续。两者都触发也无害——
    // 上面的去重会丢弃重复。
    const offLegacy = window.cth.onAutoCompact(
      () => fire('compact', DEFAULT_CONTEXT_TRIGGER.compact)
    );

    return () => { off?.(); offLegacy?.(); };
  }, [config?.onboardingComplete]);

  // 7) Mac 睡眠/锁屏后自动复活卡死的 PTY。Kevin 的主进程 keepalive 会在
  //    唤醒时补齐其计划，并 DETECT 睡眠前活着、恢复后却静默的终端——它把
  //    这些 id 报告在 `power:resume` 上。我们只 respawn 这些，恢复每个
  //    agent 之前的 CLI 会话（--resume），让终端自愈而不是让用户去点
  //    “Restart & Continue”。这复用与那个按钮 (CommandCenterPanel.
  //    restartWithModel) 和 restoreTeam 的 worktree 处理相同的 resume-spawn
  //    流程。纯增量：空的 `dead[]` 是 no-op；健康的 PTY 永远不会被碰。
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    // 跳过该窗口内已复活（或正在复活）的 id——把接连到达的 resume + unlock
    // 合并（main 在它那边也会合并）。
    const REVIVE_DEBOUNCE_MS = 8000;

    const revive = async (deadId: string): Promise<void> => {
      const now = Date.now();
      if (now - (reviving.current[deadId] ?? 0) < REVIVE_DEBOUNCE_MS) return;
      reviving.current[deadId] = now; // 在任何 await 之前认领，重入不能双 spawn
      // 只 respawn 我们真正拥有的 PTY；绝不碰未知/健康 id。
      const a = useStore.getState().agents.find((x) => x.ptyId === deadId);
      if (!a) return;
      try {
        const cfg = await window.cth.getConfig();
        // 隔离 agent 在其工作树内运行（a.cwd 是基础仓库）；它仍存在就
        // 重新进入，否则回退到基础 cwd——与 restoreTeam 相同。
        let cwd = a.cwd;
        if (a.worktreePath && (await window.cth.gitIsRepo(a.worktreePath))) cwd = a.worktreePath;
        await window.cth.killPty(deadId);
        // 就地软重置池化的 xterm（没有则是 no-op）：重新武装输入并清掉
        // 过期帧，让复活的 TUI 干净绘制——与那个按钮一样。
        resetTerminal(deadId);
        const provider = inferAgentProvider(a.command, a.provider);
        // 优先用 agent 记录的确切命令（相同 model/标志）；只有它早于持久化
        // 的 `command` 字段时才回退到重建的命令。
        const command = (a.command ?? '').trim() || buildSpawnCommand(cfg, a.model, provider);
        const [exe, ...args] = tokenizeCommand(command);
        const hive = a.isGod
          ? { id: a.id, name: a.name, cwd, provider, isGod: true, role: roleForHiveSpawn(a) }
          : a.isAssistant
          ? { id: a.id, name: a.name, cwd, provider, isAssistant: true, role: roleForHiveSpawn(a) }
          : { id: a.id, name: a.name, cwd, provider, role: roleForHiveSpawn(a) };
        // 按终端的真实网格 spawn，让 TUI 的绝对光标移动落到正确的单元格
        //（尺寸不匹配会打散重绘）。
        const entry = acquireTerminal(deadId);
        let cols = 100, rows = 30;
        try { entry.fit.fit(); cols = entry.term.cols; rows = entry.term.rows; } catch { /* 宿主尚未定尺寸 */ }
        const res = await window.cth.spawnPty({
          id: deadId,
          cwd,
          command: exe,
          provider,
          args,
          cols,
          rows,
          // 工作树（如果有）已在磁盘上——重新进入，不要重新隔离
          // （那会在既有路径/分支上冲突）。
          isolate: false,
          // 重新挂接 agent 之前的会话，让复活不丢失上下文。
          resume: true,
          hive
        });
        if (res.ok) {
          reviving.current[deadId] = Date.now(); // 重新盖章，让去抖覆盖本次 spawn
          useStore.getState().updateAgent(a.id, { status: 'idle', action: '休眠后已唤醒' });
        } else {
          delete reviving.current[deadId]; // 让稍后的 power:resume 重试它
          console.error('[autorevive] respawn failed for', a.id, res.error);
        }
      } catch (err) {
        delete reviving.current[deadId];
        console.error('[autorevive] respawn threw for', deadId, err);
      }
    };

    return window.cth.onPowerResume?.((e) => {
      const dead = Array.isArray(e?.dead) ? e.dead : [];
      if (!dead.length) return; // 健康唤醒——没有卡死的，no-op
      for (const id of dead) void revive(id);
    });
  }, [config?.onboardingComplete]);
}

import { useCallback, useEffect, useRef } from 'react';
import { useStore, type ToolKind, type StationKind } from '@/store/store';
import { createAnsiStripper } from '@/components/ansiText';

// 工具调用行形如：`● Read SPEC.md`、`● Bash npm test`、`● Edit src/foo.ts`
const TOOL_RE = /●\s+([A-Za-z][A-Za-z_]*)(?:\s+(.+))?/g;

const TOOL_TO_STATION: Record<string, StationKind> = {
  Read: 'shelf', Edit: 'shelf', Write: 'shelf', MultiEdit: 'shelf',
  Grep: 'shelf', Glob: 'shelf',
  Bash: 'terminal', BashOutput: 'terminal',
  WebFetch: 'web', WebSearch: 'web',
  TodoWrite: 'board', TaskCreate: 'board', TaskUpdate: 'board'
};

const TOOLKIND_BY_NAME: Record<string, ToolKind> = {
  Read: 'Read', Edit: 'Edit', Write: 'Write',
  Bash: 'Bash',
  WebFetch: 'WebFetch', WebSearch: 'WebSearch',
  Grep: 'Grep', Glob: 'Glob',
  TodoWrite: 'TodoWrite'
};

// “Blocked” = Claude 确实在等待用户。仅匹配真正的提示符（审批菜单 /
// 是非问题）。不要匹配裸词 “permission”：TUI 底栏常驻显示 “bypass
// permissions on (shift+tab to cycle)”，否则会在每次重绘时把忙碌中的
// agent 误标为 blocked——导致它在 working 与 blocked 之间反复横跳。
const BLOCK_HINTS = [
  /Do you want to proceed/i,
  /❯\s*\d+\.\s*Yes/i,            // 编号审批菜单，光标停在“1. Yes”上
  /Yes, and don't ask again/i,
  /\(y\/n\)/i,
  /\[y\/n\]/i,
];

// /context 输出会打印 “235.3k/1m tokens (24%)” ——嗅探分母以获知会话真实的
// 上下文窗口大小。对使用 CLI 默认模型的会话来说这是唯一可靠来源：
// “[1m]” 别名只存在于 Claude Code 内部；transcript 里的 API 模型 id 是
// 纯文本形式。
const CONTEXT_LIMIT_RE = /[\d.,]+k\s*\/\s*([\d.]+)([km])\s+tokens/i;

/**
 * 订阅 pty 流，并根据滚过的内容更新 agent 的头像状态。这是在我们接入真正的
 * Claude Code hooks 之前的过渡方案——它检查可见终端输出，推断 status /
 * station / carrying。
 *
 * 返回一个适用于 `<PtyTerminalView onStreamData={...} />` 的函数。
 */
export function usePtyParser(agentId: string) {
  const updateAgent = useStore(s => s.updateAgent);
  const pushFeed = useStore(s => s.pushFeed);
  const idleTimerRef = useRef<number | null>(null);
  // 每个 agent 一个剥离器：它需要跨 pty 分片携带转义序列状态。
  const stripRef = useRef(createAnsiStripper());

  const scheduleIdle = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
    }
    idleTimerRef.current = window.setTimeout(() => {
      // 约 4 秒没有新的工具调用 → 假定模型已进入空闲
      updateAgent(agentId, {
        status: 'idle',
        action: '等待中',
        carrying: undefined,
        currentStation: 'desk'
      });
    }, 4000) as unknown as number;
  }, [agentId, updateAgent]);

  const cancelIdle = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
      }
    };
  }, []);

  return useCallback((chunk: string) => {
    const text = stripRef.current(chunk);
    if (!text.trim()) return;

    // 从 /context 输出被动嗅探上下文上限（计量轮询每个会话探测一次，
    // 手动 /context 同样有效）。所有引擎统一按 1M 窗口计；只有 CLI 真实
    // 报告超过 1M 时才抬升上限，绝不把 1M 拉低到真实小窗口。
    const lim = CONTEXT_LIMIT_RE.exec(text);
    if (lim) {
      const value = parseFloat(lim[1]) * (lim[2].toLowerCase() === 'm' ? 1_000_000 : 1_000);
      if (value > 1_000_000) {
        const agent = useStore.getState().agents.find((a) => a.id === agentId);
        if (agent && value > (agent.contextLimit ?? 0)) {
          updateAgent(agentId, { contextLimit: value });
        }
      }
    }

    // “esc to interrupt” 底栏只在回合进行中显示。
    const running = /esc to interrupt/i.test(text);

    let lastTool: string | null = null;
    let lastArg: string | null = null;

    TOOL_RE.lastIndex = 0;
    for (let m: RegExpExecArray | null; (m = TOOL_RE.exec(text)) !== null; ) {
      lastTool = m[1];
      lastArg = (m[2] ?? '').trim();
    }

    if (lastTool) {
      const station = TOOL_TO_STATION[lastTool] ?? 'desk';
      const carrying = TOOLKIND_BY_NAME[lastTool] ?? undefined;
      // 压缩连续空格：翻译后的光标前移（见 ansiText）可能代表多个列宽，
      // 气泡不应显示这些空隙。
      const summary = (lastArg ? `${lastTool.toLowerCase()} ${lastArg}` : lastTool.toLowerCase())
        .replace(/\s+/g, ' ');
      // 注意：`progress` 刻意保持不动——它现在是上下文计量表（由 useHive
      // 的上下文轮询填充），不再是单任务进度条。
      updateAgent(agentId, {
        status: 'working',
        action: summary,
        currentStation: station,
        carrying
      });
      // 镜像写入应用内 feed，以便（若启用）模拟终端视图也能看到——
      // 对真实 pty 无害。
      pushFeed(agentId, `\x1b[36m● ${lastTool}\x1b[0m ${lastArg ?? ''}`);
      // 旋转动画在转时就保持 working；否则允许空闲漂移。
      if (running) cancelIdle(); else scheduleIdle();
      return;
    }

    // 正在运行但没有新的工具行（模型在思考 / 流式输出正文）→ 让 agent
    // 继续在工位上保持 working，别让它漂移到 idle。
    if (running) {
      cancelIdle();
      updateAgent(agentId, { status: 'working' });
      return;
    }

    // 不在运行 → 屏幕上是一个真正的审批/提问提示符。
    const recent = text.slice(-400);
    if (BLOCK_HINTS.some(re => re.test(recent))) {
      // 只有 god agent 与人类对话，因此只有它会真正“被阻塞”（需要你）。
      // 坐在提示符前的子 agent 是自主的——它记为 “waiting”，我们不会为它
      // 弹人工审批卡片。
      const isGod = !!useStore.getState().agents.find((a) => a.id === agentId)?.isGod;
      if (isGod) {
        updateAgent(agentId, {
          status: 'blocked',
          action: '等你确认',
          currentStation: 'mailbox',
          blockReason: {
            summary: '等待你的回复',
            detail: 'Claude 正在等待输入。请查看终端以获取确切提示。',
            actions: [
              { label: 'Approve', kind: 'approve', send: 'y\r' },
              { label: 'Deny',    kind: 'deny',    send: 'n\r' }
            ]
          }
        });
      } else {
        updateAgent(agentId, {
          status: 'waiting',
          action: '等 god 处理',
          currentStation: 'desk',
          blockReason: undefined
        });
      }
      return;
    }

    // 回合结束、屏幕上没有提示符 → 让它漂移到空闲。
    // qwen/kimi 等 proxy provider 没有 Claude 的 '● Tool' / 'esc to interrupt' 标记，
    // 只要终端还在持续输出就先把状态置为 working（避免实际干活却恒显 idle），
    // 静默 4s 后由 scheduleIdle 自动回落到 idle。blocked/waiting 不覆盖。
    const agentNow = useStore.getState().agents.find((a) => a.id === agentId);
    if (agentNow && agentNow.status !== 'blocked' && agentNow.status !== 'waiting') {
      updateAgent(agentId, { status: 'working' });
    }
    scheduleIdle();
  }, [agentId, updateAgent, pushFeed, scheduleIdle, cancelIdle]);
}

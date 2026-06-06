/**
 * Global pty → avatar-status watcher.
 *
 * Why: the pty-stream parser used to live in usePtyParser and only ran while an
 * agent's profile panel was mounted. A background agent's status therefore froze
 * at whatever it last showed until you clicked its profile (issue #3) — and the
 * idle/waiting-gated inbox nudge (useHive effect #3) skipped agents stuck on
 * 'working', quietly stalling the hive.
 *
 * This module subscribes to EVERY live agent pty exactly once, app-wide, so
 * working/idle/waiting always track the real terminals — panel open or not.
 * Hook events (useHive effect #2) remain the authoritative status source; this
 * is the refinement + fallback layer (it also covers a missed Stop event).
 */
import { useStore, type StationKind, type ToolKind } from '@/store/store';

// ANSI escape sequence stripper — Claude colors its tool tags with these.
const ANSI_RE = /\x1b\[[0-9;]*m/g;

// Tool call lines look like: `● Read SPEC.md`, `● Bash npm test`, `● Edit src/foo.ts`
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

// "Blocked" = Claude is genuinely waiting on the user. Match only real prompts
// (the approval menu / a yes-no question). Do NOT match the bare word
// "permission": the TUI footer always shows "bypass permissions on (shift+tab
// to cycle)", which would otherwise flag a busy agent as blocked on every
// repaint — making it flip-flop between working and blocked.
const BLOCK_HINTS = [
  /Do you want to proceed/i,
  /❯\s*\d+\.\s*Yes/i,            // numbered approval menu, cursor on "1. Yes"
  /Yes, and don't ask again/i,
  /\(y\/n\)/i,
  /\[y\/n\]/i,
];

interface Watcher {
  ptyId: string;
  idleTimer: number | null;
  unsub: () => void;
}

const watchers = new Map<string, Watcher>();

function scheduleIdle(agentId: string, w: Watcher): void {
  if (w.idleTimer !== null) window.clearTimeout(w.idleTimer);
  w.idleTimer = window.setTimeout(() => {
    // No new tool calls for ~4 s → assume the model went idle
    useStore.getState().updateAgent(agentId, {
      status: 'idle',
      action: 'awaiting',
      description: 'on standby',
      carrying: undefined,
      currentStation: 'desk'
    });
  }, 4000) as unknown as number;
}

function cancelIdle(w: Watcher): void {
  if (w.idleTimer !== null) {
    window.clearTimeout(w.idleTimer);
    w.idleTimer = null;
  }
}

/** Same inference as the old usePtyParser, just decoupled from React. */
function parseChunk(agentId: string, w: Watcher, chunk: string): void {
  const { updateAgent, pushFeed } = useStore.getState();
  const text = chunk.replace(ANSI_RE, '');
  if (!text.trim()) return;

  // The "esc to interrupt" footer is only shown while a turn is in progress.
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
    const summary = lastArg ? `${lastTool.toLowerCase()} ${lastArg}` : lastTool.toLowerCase();
    updateAgent(agentId, {
      status: 'working',
      action: summary,
      description: summary,
      currentStation: station,
      carrying,
      progress: 0
    });
    pushFeed(agentId, `\x1b[36m● ${lastTool}\x1b[0m ${lastArg ?? ''}`);
    // Keep working while the spinner is up; otherwise allow the idle drift.
    if (running) cancelIdle(w); else scheduleIdle(agentId, w);
    return;
  }

  // Actively running but no fresh tool line (model is thinking / streaming
  // prose) → keep the agent working at its desk, don't let it drift to idle.
  if (running) {
    cancelIdle(w);
    updateAgent(agentId, { status: 'working' });
    return;
  }

  // Not running → a genuine approval/question prompt is on screen.
  const recent = text.slice(-400);
  if (BLOCK_HINTS.some(re => re.test(recent))) {
    // Only the god agent talks to the human, so only it is truly "blocked"
    // (needs you). A sub-agent sitting at a prompt is autonomous — it reads as
    // "waiting" and we don't raise a human-approval card for it.
    const isGod = !!useStore.getState().agents.find((a) => a.id === agentId)?.isGod;
    if (isGod) {
      updateAgent(agentId, {
        status: 'blocked',
        action: 'waiting on you',
        description: 'waiting on you',
        currentStation: 'mailbox',
        blockReason: {
          summary: 'Waiting for your reply',
          detail: 'Claude is waiting for input. Check the terminal for the exact prompt.',
          actions: [
            { label: 'Approve', kind: 'approve', send: 'y\r' },
            { label: 'Deny',    kind: 'deny',    send: 'n\r' }
          ]
        }
      });
    } else {
      updateAgent(agentId, {
        status: 'waiting',
        action: 'waiting on god',
        description: 'waiting on god',
        currentStation: 'desk',
        blockReason: undefined
      });
    }
    return;
  }

  // Turn finished, no prompt on screen → let it drift to idle.
  scheduleIdle(agentId, w);
}

/**
 * Reconcile the active watchers with the current agent list: subscribe newly
 * appeared agent ptys, drop watchers whose agent/pty went away. Idempotent and
 * cheap — safe to call on every store change.
 */
export function syncPtyWatchers(agents: Array<{ id: string; ptyId?: string }>): void {
  const want = new Map<string, string>();
  for (const a of agents) if (a.ptyId) want.set(a.id, a.ptyId);

  for (const [id, w] of watchers) {
    if (want.get(id) !== w.ptyId) {
      try { w.unsub(); } catch { /* noop */ }
      cancelIdle(w);
      watchers.delete(id);
    }
  }

  for (const [id, ptyId] of want) {
    if (watchers.has(id)) continue;
    const w: Watcher = { ptyId, idleTimer: null, unsub: () => {} };
    w.unsub = window.cth.onPtyData(ptyId, (chunk) => parseChunk(id, w, chunk));
    watchers.set(id, w);
  }
}

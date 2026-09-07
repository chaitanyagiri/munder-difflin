/**
 * MockHookServer — generates synthetic Claude Code hook events so avatar
 * animation works without a live agent. Emits the same hive:hookEvent payloads
 * as the real HookServer, so the renderer's useHive handler treats mock and
 * real events identically.
 *
 * Replaces the old renderer-side mockEvents.ts (which wrote the zustand store
 * directly). This server runs in the main process and pushes events through
 * IPC, keeping all avatar state centralized in useHive.ts.
 */

import { WebContents } from 'electron';

// ─── Types ────────────────────────────────────────────────────────────────────

interface MockHookPayload {
  hook_event_name: string;
  agent_id: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  notification_type?: string;
  message?: string;
  model?: string;
  input?: number;
  output?: number;
  cache_read?: number;
  cache_creation?: number;
}

interface ToolSample {
  event: string;
  tool: string;
  what: string;
  station: string;
  lines: string[];
  thought: string;
}

// ─── Tool samples (ported from the old renderer-side mockEvents.ts) ───────────

const TOOL_SAMPLES: ToolSample[] = [
  { event: 'PreToolUse', tool: 'Read', what: 'reading SPEC.md', station: 'shelf',
    lines: ['\x1b[36m● Read\x1b[0m SPEC.md', '   read 412 lines.'],
    thought: 'Pulling up the spec so I can confirm the state machine before touching the implementation.' },
  { event: 'PostToolUse', tool: 'Read', what: 'reading SPEC.md', station: 'shelf',
    lines: ['\x1b[36m● Read\x1b[0m SPEC.md', '   read 412 lines.'], thought: '' },
  { event: 'PreToolUse', tool: 'Edit', what: 'editing PixelPanel.tsx', station: 'shelf',
    lines: ['\x1b[36m● Edit\x1b[0m src/renderer/src/components/PixelPanel.tsx', '   +14 / -3'],
    thought: 'Tightening up the panel border math — the inner stroke was a pixel off in inset mode.' },
  { event: 'PostToolUse', tool: 'Edit', what: 'editing PixelPanel.tsx', station: 'shelf',
    lines: ['\x1b[36m● Edit\x1b[0m src/renderer/src/components/PixelPanel.tsx', '   +14 / -3'], thought: '' },
  { event: 'PreToolUse', tool: 'Bash', what: 'running tests', station: 'terminal',
    lines: ['\x1b[36m● Bash\x1b[0m npm test', '   ✓ 24 passed'],
    thought: 'Running the renderer suite to make sure nothing regressed before I move on.' },
  { event: 'PostToolUse', tool: 'Bash', what: 'running tests', station: 'terminal',
    lines: ['\x1b[36m● Bash\x1b[0m npm test', '   ✓ 24 passed'], thought: '' },
  { event: 'PreToolUse', tool: 'WebFetch', what: 'fetching docs', station: 'web',
    lines: ['\x1b[36m● WebFetch\x1b[0m https://docs.example.com/hooks', '   ok 200 (1.2kb)'],
    thought: 'Grabbing the hooks doc to double-check the PreToolUse payload shape.' },
  { event: 'PostToolUse', tool: 'WebFetch', what: 'fetching docs', station: 'web',
    lines: ['\x1b[36m● WebFetch\x1b[0m https://docs.example.com/hooks', '   ok 200 (1.2kb)'], thought: '' },
  { event: 'PreToolUse', tool: 'Glob', what: 'searching for skill files', station: 'shelf',
    lines: ['\x1b[36m● Glob\x1b[0m **/*.skill.md', '   23 matches'],
    thought: 'Enumerating all the skill files so I can walk each one and look for stale script paths.' },
  { event: 'PostToolUse', tool: 'Glob', what: 'searching for skill files', station: 'shelf',
    lines: ['\x1b[36m● Glob\x1b[0m **/*.skill.md', '   23 matches'], thought: '' },
  { event: 'PreToolUse', tool: 'TodoWrite', what: 'updating the todo board', station: 'board',
    lines: ['\x1b[36m● TodoWrite\x1b[0m 4 items'],
    thought: 'Splitting the remaining work into four discrete tasks so I can track them as I go.' },
  { event: 'PostToolUse', tool: 'TodoWrite', what: 'updating the todo board', station: 'board',
    lines: ['\x1b[36m● TodoWrite\x1b[0m 4 items'], thought: '' },
];

const PRE_SAMPLES = TOOL_SAMPLES.filter(s => s.event === 'PreToolUse');
const POST_SAMPLES = TOOL_SAMPLES.filter(s => s.event === 'PostToolUse');
const MOCK_ACTS = ['request', 'inform', 'propose', 'query', 'agree'] as const;
const TICK_MS = 1800;

// ─── Public API ───────────────────────────────────────────────────────────────

export class MockHookServer {
  private webContents: WebContents | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private agentStates = new Map<string, { status: 'idle' | 'thinking'; lastTool: string }>();

  constructor(getWebContents: () => WebContents | null) {
    this.webContents = getWebContents();
  }

  /** Start the synthetic event loop. Idempotent. */
  start(agentIds: string[]): void {
    if (this.interval !== null) return;
    for (const id of agentIds) {
      this.agentStates.set(id, { status: 'idle', lastTool: '' });
    }
    this.interval = setInterval(() => this.tick(agentIds), TICK_MS);
  }

  /** Stop the loop and clear agent state. */
  stop(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.agentStates.clear();
  }

  /** Sync the agent roster (add new, remove stale). */
  syncAgents(agentIds: string[]): void {
    for (const id of agentIds) {
      if (!this.agentStates.has(id)) {
        this.agentStates.set(id, { status: 'idle', lastTool: '' });
      }
    }
    for (const [id] of this.agentStates) {
      if (!agentIds.includes(id)) this.agentStates.delete(id);
    }
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private tick(agentIds: string[]): void {
    if (!this.webContents) return;

    for (const agentId of agentIds) {
      const state = this.agentStates.get(agentId);
      if (!state) continue;

      if (state.status === 'idle' && Math.random() < 0.4) {
        const preSample = PRE_SAMPLES[Math.floor(Math.random() * PRE_SAMPLES.length)];
        state.status = 'thinking';
        state.lastTool = preSample.tool;
        this.emitHook(agentId, {
          hook_event_name: 'PreToolUse', agent_id: agentId,
          tool_name: preSample.tool,
        });
        this.webContents.send('hive:mockFeed', { agentId, lines: preSample.lines });
      } else if (state.status === 'thinking') {
        const postSample = POST_SAMPLES.find(s => s.tool === state.lastTool) ?? POST_SAMPLES[0];
        state.status = 'idle';
        state.lastTool = '';
        this.emitHook(agentId, {
          hook_event_name: 'PostToolUse', agent_id: agentId,
          tool_name: postSample.tool,
        });
        this.webContents.send('hive:mockFeed', { agentId, lines: postSample.lines });
        this.emitHook(agentId, {
          hook_event_name: 'Stop', agent_id: agentId,
          tool_name: undefined,
        });
      }
    }

    this.maybeFlyMessage(agentIds);
  }

  private emitHook(agentId: string, payload: MockHookPayload): void {
    if (!this.webContents) return;
    this.webContents.send('hive:hookEvent', {
      agentId: payload.agent_id,
      event: payload.hook_event_name,
      tool: payload.tool_name,
      notificationType: undefined,
      source: undefined,
      message: payload.message,
      blocked: false,
    });
  }

  private maybeFlyMessage(agentIds: string[]): void {
    if (agentIds.length < 2 || Math.random() >= 0.45) return;
    const from = agentIds[Math.floor(Math.random() * agentIds.length)];
    let to = from;
    for (let i = 0; i < 6 && to === from; i++) {
      to = agentIds[Math.floor(Math.random() * agentIds.length)];
    }
    if (to === from) return;
    const act = MOCK_ACTS[Math.floor(Math.random() * MOCK_ACTS.length)];
    this.webContents?.send('cth:demo-handoff', { from, to, act });
  }
}

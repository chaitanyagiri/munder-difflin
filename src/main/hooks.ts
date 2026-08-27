/**
 * HookServer — the bridge between `claude` lifecycle hooks and the harness.
 *
 * Each spawned agent is launched with `--settings` pointing its hooks at a tiny
 * shim (see HOOK_SHIM in hive.ts) that forwards the hook payload to the Unix
 * domain socket this server listens on. We then:
 *   - drive avatar state from PreToolUse/PostToolUse/Notification/etc., and
 *   - report lifecycle boundaries while renderer-side guarded queues deliver
 *     inbox work only after the session reaches a safe idle prompt.
 *
 * Runs in the Electron main process.
 */
import { createServer, type Server } from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { Notification, type WebContents } from 'electron';
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
  /** Status-line payloads only: the session's live context accounting. */
  context_window?: { total_input_tokens?: number; context_window_size?: number };
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
  stop_hook_active?: boolean;
  prompt?: string;
  source?: string;
  notification_type?: string;
  /** Notification hook text, e.g. "Claude is waiting for your input" (idle) vs a
   *  permission request. Used to tell "needs you" from "just done / lingering". */
  message?: string;
  /** CostSample payloads only (synthesized by the proxy-bridge sidecar for
   *  qwen). Raw token counts for one response, fed to the cost ledger. */
  model?: string;
  input?: number;
  output?: number;
  cache_read?: number;
  cache_creation?: number;
}

export class HookServer {
  private server: Server | null = null;
  /** agentId → the live session's transcript file, learned from hook payloads.
   *  Lets the harness read per-agent telemetry (e.g. current context size)
   *  even when several agents share one cwd. */
  private transcriptPaths = new Map<string, string>();
  /** agentId → the latest context-window accounting from the statusLine shim
   *  (current tokens + the REAL window size — 200k vs 1M, which nothing else
   *  exposes). The renderer already gets this pushed live on `hive:contextUpdate`;
   *  we also retain the last value here so a main-side read (the voice read-layer's
   *  get_agent_detail / list_agents) can report "how full is each agent's context"
   *  without depending on a renderer round-trip. */
  private contextById = new Map<string, { tokens: number; limit: number; ts: number }>();

  constructor(
    private hive: HiveManager,
    private getWebContents: () => WebContents | null,
    private getConfig: () => HarnessConfig,
    /** #7C — operator control state. Optional so tests can omit it. */
    private control?: ControlRegistry,
    /** Circuit breaker (Lane A #6.6b) — fed the hook-derived signals (session id,
     *  repeated identical tool calls). Optional so the server still runs without it. */
    private breaker?: CircuitBreaker,
    /** Standing goal text for an agent (from the durable roster). Optional so
     *  tests can omit it; when set, injected on SessionStart / UserPromptSubmit. */
    private getStandingGoal?: (agentId: string) => string | null,
    /** Optional observer of every hook boundary (agentId, event, message). The
     *  worker inbox-wake watchdog (workerWake.ts) feeds on this to learn when an
     *  agent is parked on a permission/HITL prompt so it never types into it. */
    private onEvent?: (agentId: string | undefined, event: string, message: string | undefined) => void
  ) {}

  start(): void {
    const sock = this.hive.sockPath();
    if (!sock || this.server) return;
    // Clear a stale socket file left by a previous run.
    try { if (existsSync(sock)) rmSync(sock); } catch { /* noop */ }

    this.server = createServer((conn) => {
      let buf = '';
      conn.on('data', (d) => {
        buf += d.toString();
        const nl = buf.indexOf('\n');
        if (nl === -1) return; // wait for the full line
        let payload: HookPayload = {};
        try { payload = JSON.parse(buf.slice(0, nl)); } catch { /* ignore */ }
        let res: unknown = {};
        try { res = this.handle(payload); } catch { res = {}; }
        conn.end(JSON.stringify(res ?? {}));
      });
      conn.on('error', () => { /* shim hung up — ignore */ });
    });
    this.server.on('error', (e) => console.error('[hive] hook server error:', e));
    this.server.listen(sock);
  }

  stop(): void {
    try { this.server?.close(); } catch { /* noop */ }
    this.server = null;
    const sock = this.hive.sockPath();
    try { if (sock && existsSync(sock)) rmSync(sock); } catch { /* noop */ }
  }

  /** The transcript file of an agent's CURRENT session, if any hook has fired. */
  transcriptPath(agentId: string): string | undefined {
    return this.transcriptPaths.get(agentId);
  }

  /** The latest context-window accounting for an agent (current tokens + the real
   *  window size), or undefined if no statusLine tick has fired for it yet. */
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

    // Status-line payloads carry the session's EXACT context accounting —
    // current tokens AND the real window size (200k vs 1M, which nothing else
    // exposes). Forward to the renderer for the agent-card context gauge.
    // Handled FIRST and returned early: this is pure telemetry from the
    // statusLine shim, not a real hook boundary — it must never trip the
    // HALT gate or feed the breaker's loop detector below. The early return
    // also (deliberately) skips recordSession for status ticks: a statusLine
    // payload's session_id adds nothing the real hooks don't already record,
    // and telemetry should never write to the registry. transcript_path IS
    // still captured above, where every payload shape benefits from it.
    if (event === 'Status') {
      const cw = p.context_window;
      if (agentId && cw && typeof cw.total_input_tokens === 'number'
        && typeof cw.context_window_size === 'number' && cw.context_window_size > 0) {
        // Retain for main-side reads (voice get_agent_detail / list_agents) …
        this.contextById.set(agentId, {
          tokens: cw.total_input_tokens,
          limit: cw.context_window_size,
          ts: Date.now()
        });
        // … and forward live to the renderer's agent-card context gauge.
        this.getWebContents()?.send('hive:contextUpdate', {
          agentId,
          tokens: cw.total_input_tokens,
          limit: cw.context_window_size
        });
      }
      return {};
    }

    // 7C.3 — a graceful operator HALT overrides everything (incl. the inbox
    // drain below): stop the agent CLEANLY at this hook boundary rather than
    // killing the PTY. session_id is in the payload for a later --resume.
    if (agentId && this.control?.shouldHalt(agentId)) {
      this.emit(agentId, event, p);
      return { continue: false, stopReason: 'Halted by the operator from the floor.' };
    }

    // Capture the Claude Code session id for idempotent --resume + cost dedup
    // (Lane A #6.6a). Cheap: recordSession writes only when it changes.
    if (agentId && p.session_id) this.hive.recordSession(agentId, p.session_id);

    // CostSample — synthesized by the proxy-bridge sidecar (qwen) on every
    // response with usage. Persist it to the SAME cost ledger as Claude's OTel
    // path, keyed by the synthesized session_id, then return early so cost stays
    // OUT of the Claude-only OTel/breaker/drain paths below. `usd` is the fallback
    // per-model estimate (a local model normally costs ~$0, but the row keeps the
    // accounting schema uniform). Pure telemetry — never feeds the loop detector.
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

    // Feed the breaker its hook-derived loop signal: a tool that actually ran.
    // A repeated identical (name+input) PostToolUse is the runaway-loop tell.
    if (event === 'PostToolUse' && agentId) {
      this.breaker?.recordToolUse(agentId, p.tool_name, p.tool_input);
    }

    // Compaction exemption (issue #109): PreCompact opens it so the compaction
    // token burst can't trip the Δoutput arms; PostCompact — or any SessionStart,
    // since a fresh session makes in-flight compaction state moot — closes it
    // down to the trailing grace (a no-op when nothing was compacting).
    if (event === 'PreCompact' && agentId) this.breaker?.recordCompactStart(agentId);
    if ((event === 'PostCompact' || event === 'SessionStart') && agentId) {
      this.breaker?.recordCompactEnd(agentId);
    }

    if ((event === 'Stop' || event === 'SubagentStop') && agentId) {
      // Respect any upstream Stop hook that already re-entered this boundary.
      if (p.stop_hook_active) { this.emit(agentId, event, p); return {}; }
      // Never turn unread hive mail into a forced continuation at Stop. That old
      // path bypassed terminal-draft/HITL safety and could spend credits while a
      // user was answering a question. Inbox files remain durable; the renderer
      // wakes the agent later through its guarded idle-only delivery path.
      this.notify(agentId ?? 'Agent', 'finished — idle');
      this.emit(agentId, event, p);
      return {};
    }

    // 7C.1 — HITL gate: deny a tool call at the PreToolUse boundary when the
    // agent is paused or this tool is gated. Race-free (immediate return, no
    // renderer round-trip → can't hit the shim timeout). Slow human APPROVAL is
    // deliberately left to Claude's native permission prompt.
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

    // 7C.2 — mid-run steering: inject queued operator guidance as context on the
    // next eligible hook (no fragile typing into the TUI). Delivered once.
    // Merged with the roster line below so the two injections never displace each
    // other (only ONE additionalContext can be returned per hook).
    let steer: string | null = null;
    if ((event === 'UserPromptSubmit' || event === 'PostToolUse') && agentId && this.control) {
      steer = this.control.takeSteer(agentId) ?? null;
    }

    // Keep god's roster CURRENT. fleet.json is always fresh on disk, but god's
    // context is not: after a restart it resumes a transcript describing the old
    // floor and messages agents that are long gone. Push the live roster in as
    // additionalContext at the start of each session and on every prompt, so god
    // knows the floor all the time instead of only when it remembers to Read.
    // God-only and one line — every other agent is unaffected.
    const wantsRoster = (event === 'SessionStart' || event === 'UserPromptSubmit')
      && !!agentId && this.hive.isGod(agentId);
    // Hand the roster the LIVE context-window occupancy (contextById) so each
    // agent line can carry a `ctx NN%` — god then sees whose context is nearly
    // full when it routes work, instead of guessing from cumulative token spend.
    const roster = wantsRoster
      ? this.hive.rosterContext((id) => this.contextFor(id))
      : null;

    // Standing goal (hire Briefing) — durable roster field, re-read every cycle so
    // an Edit Agent save is picked up on the next SessionStart / UserPromptSubmit
    // without restarting the worker. Kept out of --append-system-prompt (volatile-
    // free cache invariant); lives on the live hook channel instead.
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

    // A Notification hook that means "the agent is blocked waiting for the user"
    // (idle prompt) deserves a desktop toast too — distinct from a permission
    // request, which surfaces natively in the agent's own Claude Code session
    // (approvable remotely via /remote-control).
    if (
      event === 'Notification' &&
      (p.notification_type === 'idle' ||
        (p.message ?? '').toLowerCase().includes('waiting for your input'))
    ) {
      this.notify(agentId ?? 'Agent', p.message ?? 'needs your attention');
    }

    // Forward everything else to the renderer so avatars reflect real activity.
    this.emit(agentId, event, p);
    return {};
  }

  /** Fire a native desktop notification — gated on the user's `notifications`
   *  setting. Only the OS toast is gated; the hive:hookEvent emit is always sent
   *  so avatars/UI stay live regardless. Best-effort: never throw into the hook. */
  private notify(title: string, body: string): void {
    if (!this.getConfig().notifications) return;
    try {
      if (!Notification.isSupported()) return;
      new Notification({ title, body }).show();
    } catch { /* notifications unsupported on this platform — ignore */ }
  }

  /** Tell the renderer a tool call was gated/denied (#7C.1) so it can surface it
   *  (toast / control strip) — distinct from the avatar hook stream. */
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

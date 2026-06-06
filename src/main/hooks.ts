/**
 * HookServer — the bridge between `claude` lifecycle hooks and the harness.
 *
 * Each spawned agent is launched with `--settings` pointing its hooks at a tiny
 * shim (see HOOK_SHIM in hive.ts) that forwards the hook payload to the Unix
 * domain socket this server listens on. We then:
 *   - drive avatar state from PreToolUse/PostToolUse/Notification/etc., and
 *   - implement the autonomous loop: on Stop, drain the agent's inbox and return
 *     {"decision":"block", reason} so the agent keeps working — guarded by
 *     `stop_hook_active` so it can never loop forever.
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

interface HookPayload {
  hook_event_name?: string;
  agent_id?: string | null;
  session_id?: string;
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
}

export class HookServer {
  private server: Server | null = null;

  constructor(
    private hive: HiveManager,
    private getWebContents: () => WebContents | null,
    private getConfig: () => HarnessConfig,
    /** #7C — operator control state. Optional so tests can omit it. */
    private control?: ControlRegistry,
    /** Circuit breaker (Lane A #6.6b) — fed the hook-derived signals (session id,
     *  repeated identical tool calls). Optional so the server still runs without it. */
    private breaker?: CircuitBreaker
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

  private handle(p: HookPayload): unknown {
    const agentId = p.agent_id ?? undefined;
    const event = p.hook_event_name ?? 'Unknown';

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

    // Feed the breaker its hook-derived loop signal: a tool that actually ran.
    // A repeated identical (name+input) PostToolUse is the runaway-loop tell.
    if (event === 'PostToolUse' && agentId) {
      this.breaker?.recordToolUse(agentId, p.tool_name, p.tool_input);
    }

    if ((event === 'Stop' || event === 'SubagentStop') && agentId) {
      // Loop guard: a previous Stop hook already blocked this turn → let it stop.
      if (p.stop_hook_active) { this.emit(agentId, event, p); return {}; }
      const drain = this.hive.drainForStop(agentId);
      if (drain.block) {
        // The agent is NOT idle — we're forcing it to keep working to process
        // its inbox. Tell the renderer that (blocked: true) so it doesn't flash
        // 'idle' on a Stop that never actually stops. Without this, an agent
        // re-engaged by a queued/dispatched message reads as idle while working.
        this.emit(agentId, event, p, true);
        return { decision: 'block', reason: drain.reason };
      }
      // A genuine stop with nothing queued → idle. Surface it as a desktop toast.
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
    if ((event === 'UserPromptSubmit' || event === 'PostToolUse') && agentId && this.control) {
      const steer = this.control.takeSteer(agentId);
      if (steer) {
        this.emit(agentId, event, p);
        return { hookSpecificOutput: { hookEventName: event, additionalContext: steer } };
      }
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
    this.getWebContents()?.send('hive:hookEvent', {
      agentId,
      event,
      tool: p.tool_name,
      notificationType: p.notification_type,
      source: p.source,
      message: p.message,
      blocked
    });
  }
}

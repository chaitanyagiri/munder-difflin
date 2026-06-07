/**
 * ControlRegistry — operator control over running agents (#7C.1–7C.3).
 *
 * Holds per-agent control state that the HookServer reads when deciding what to
 * return from a hook. This is how the floor exerts control WITHOUT typing into
 * the PTY: the decision rides Claude Code's own hook-return protocol.
 *
 *   - pause / gateTool (#7C.1) → PreToolUse returns permissionDecision:'deny'
 *     (race-free, immediate — no renderer round-trip, so it can't hit the shim
 *     timeout). Slow human APPROVAL deliberately rides Claude's native prompt
 *     instead, per the spec's latency mitigation.
 *   - steer (#7C.2) → the next UserPromptSubmit/PostToolUse returns
 *     additionalContext, injecting guidance into the agent's context once.
 *   - halt (#7C.3) → the next hook boundary returns { continue:false } so the
 *     agent stops CLEANLY (vs killing the PTY). Overrides the inbox-drain.
 *
 * Runs in the Electron main process; no electron import (unit-testable).
 */

export interface AgentControlSnapshot {
  paused: boolean;
  halted: boolean;
  gatedTools: string[];
  pendingSteers: number;
}

interface AgentControl {
  paused: boolean;
  halted: boolean;
  gatedTools: Set<string>;
  steerQueue: string[];
}

export class ControlRegistry {
  private readonly map = new Map<string, AgentControl>();

  private ensure(id: string): AgentControl {
    let c = this.map.get(id);
    if (!c) { c = { paused: false, halted: false, gatedTools: new Set(), steerQueue: [] }; this.map.set(id, c); }
    return c;
  }

  // ─── Operator actions (wired to IPC) ───────────────────────────────────────

  pause(id: string, on: boolean): void { this.ensure(id).paused = on; }
  gateTool(id: string, tool: string, on: boolean): void {
    const c = this.ensure(id);
    if (on) c.gatedTools.add(tool); else c.gatedTools.delete(tool);
  }
  steer(id: string, text: string): void {
    const t = text.trim();
    if (t) this.ensure(id).steerQueue.push(t.slice(0, 10000)); // hook additionalContext cap
  }
  /** Request a graceful stop at the next hook boundary. */
  halt(id: string): void { this.ensure(id).halted = true; }
  /** Drop all queued-but-undelivered steer notes (e.g. closing time cancelled
   *  before a busy agent's next hook boundary consumed the instruction). */
  clearSteers(id: string): void { const c = this.map.get(id); if (c) c.steerQueue.length = 0; }
  /** Clear pause + halt (lets a paused/halted agent run again). Keeps gates. */
  resume(id: string): void { const c = this.ensure(id); c.paused = false; c.halted = false; }

  // ─── Reads (used by HookServer) ────────────────────────────────────────────

  shouldHalt(id: string): boolean { return this.map.get(id)?.halted ?? false; }

  /** Whether a tool call should be denied (paused agent, or this tool gated). */
  toolDecision(id: string, tool: string): { deny: boolean; reason?: string } {
    const c = this.map.get(id);
    if (!c) return { deny: false };
    if (c.paused) return { deny: true, reason: 'Paused by operator — resume from the floor to continue.' };
    if (tool && c.gatedTools.has(tool)) return { deny: true, reason: `Tool ${tool} is gated by the operator.` };
    return { deny: false };
  }

  /** Dequeue one pending steer note for delivery, or undefined. */
  takeSteer(id: string): string | undefined { return this.map.get(id)?.steerQueue.shift(); }

  snapshot(id: string): AgentControlSnapshot {
    const c = this.map.get(id);
    return {
      paused: c?.paused ?? false,
      halted: c?.halted ?? false,
      gatedTools: c ? Array.from(c.gatedTools) : [],
      pendingSteers: c?.steerQueue.length ?? 0
    };
  }
}

/**
 * WorkerWakeWatchdog — main-process inbox-wake watchdog for worker agents (#151).
 *
 * The renderer's idle inbox-wake nudge (useHive.ts effect #3) is the ONLY wake
 * path for a worker that has gone quiet at its prompt: it polls on a setInterval
 * in the renderer, so a throttled/occluded window (Chromium suspends background
 * setInterval timers) can miss the moment mail lands and the worker then sits on
 * an undrained inbox forever — the orchestrator ("god") never has this problem
 * because the main process re-engages it on its own heartbeat cadence.
 *
 * This watchdog is the worker-side counterpart: on a cadence it finds live
 * workers that are genuinely idle, have newly arrived inbox mail, are not
 * paused / not awaiting a human decision, and have not been nudged recently —
 * then types the same guarded nudge the renderer would have, directly into the
 * PTY. Message ids make this edge-triggered: unchanged undrained mail is never
 * re-announced once a minute forever.
 *
 * Safety mirrors the renderer's guarded queue-drain (useHive.ts dispatch):
 *  - only a GENUINELY idle worker is nudged (no PTY output for IDLE_MS — the
 *    same quiescence the renderer's idle fallback uses), never a mid-turn one,
 *  - never inside the boot sequence (BOOT_GRACE_MS from spawn, mirroring the
 *    renderer's bootGraceUntil),
 *  - delivery paused / agent paused / halted → no nudge (ControlRegistry),
 *  - a recent permission/HITL notification re-arms a block (HITL_REARM_MS) so a
 *    prompt the human is deciding on is never typed into,
 *  - a per-worker cooldown (NUDGE_COOLDOWN_MS) so the watchdog and the renderer
 *    nudge don't stack on top of each other.
 *
 * Deliberately the renderer's own nudge text, and the same type pattern the
 * renderer's submitToPty uses (text first, Enter as a separate keystroke).
 *
 * No electron import — unit-testable (mirrors ControlRegistry).
 */

/** The exact nudge the renderer's inbox-wake loop would have typed. */
export const WORKER_WAKE_NUDGE =
  'You have new hive inbox message(s) — read your inbox, act on them now, and move handled ones to inbox/.done/. Act autonomously; only message god if you genuinely need a decision.';

/** No PTY output for this long = genuinely idle (renderer QUIESCE_IDLE_MS). */
export const WORKER_WAKE_IDLE_MS = 12_000;
/** Never nudge inside the boot sequence (renderer BOOT_GRACE_MS). */
export const WORKER_WAKE_BOOT_GRACE_MS = 35_000;
/** Minimum gap between two watchdog nudges of the same worker. */
export const WORKER_WAKE_COOLDOWN_MS = 60_000;
/** A permission/HITL notification blocks nudges for this long after it fires. */
export const WORKER_WAKE_HITL_REARM_MS = 5 * 60_000;

/** A hook event message that means "the agent needs the human" — permission /
 *  approve / confirm prompts (mirrors the renderer's needsHuman detection in
 *  useHive.ts). Anything matching the idle-waiting shape is NOT a HITL hold. */
export type HookClass = 'needsHuman' | 'idle' | null;

export function classifyHook(event: string | undefined, message: string | undefined): HookClass {
  if (event === 'Notification') {
    const msg = (message ?? '').toLowerCase();
    const idleWaiting = !msg
      || msg.includes('waiting for your input')
      || msg.includes('is idle')
      || msg.includes('waiting for input');
    const needsHuman = msg.includes('permission')
      || msg.includes('approve')
      || msg.includes('confirm')
      || msg.includes('needs your');
    if (needsHuman && !idleWaiting) return 'needsHuman';
    return 'idle';
  }
  return null;
}

/** One worker's live facts, gathered by the caller each beat. */
export interface WorkerWakeFacts {
  /** Worker agent id (god is never a candidate). */
  agentId: string;
  /** True when this agent is the orchestrator — god is never nudged. */
  isGod?: boolean;
  /** Live PTY id, or undefined when the agent has no terminal. */
  ptyId?: string;
  /** Timestamp of the PTY's last output (0 = never output). */
  lastOutputAt: number;
  /** IDs of undrained inbox messages (empty → nothing to wake for). */
  inboxIds: readonly string[];
  /** ControlRegistry snapshot flags. */
  autoDeliveryPaused: boolean;
  paused: boolean;
  halted: boolean;
}

export class WorkerWakeWatchdog {
  /** ptyId → spawn timestamp (boot grace). */
  private spawnedAt = new Map<string, number>();
  /** agentId → last nudge timestamp (cooldown). */
  private lastNudgeAt = new Map<string, number>();
  /** agentId → inbox ids included in the last nudge. This turns the watchdog
   *  into an edge trigger: a worker is nudged again only when a new id appears. */
  private announcedInboxIds = new Map<string, Set<string>>();
  /** agentId → timestamp of the last needsHuman hook notification. */
  private lastHumanNeedsAt = new Map<string, number>();

  /** Record a PTY spawn so its boot sequence is left alone. */
  noteSpawn(ptyId: string, at = Date.now()): void {
    this.spawnedAt.set(ptyId, at);
  }

  /** Feed hook events (from HookServer) so a HITL prompt blocks nudges. */
  noteHook(agentId: string | undefined, event: string | undefined, message: string | undefined, at = Date.now()): void {
    if (!agentId) return;
    if (classifyHook(event, message) === 'needsHuman') this.lastHumanNeedsAt.set(agentId, at);
  }

  /** Forget per-agent state (e.g. the agent's PTY was closed). */
  forget(agentId: string, ptyId?: string): void {
    this.lastNudgeAt.delete(agentId);
    this.announcedInboxIds.delete(agentId);
    this.lastHumanNeedsAt.delete(agentId);
    if (ptyId) this.spawnedAt.delete(ptyId);
  }

  /** The worker ids that should be nudged right now, in stable registry order.
   *  Pure decision — the caller types the nudge. */
  decide(facts: readonly WorkerWakeFacts[], now = Date.now()): string[] {
    const out: string[] = [];
    for (const f of facts) {
      const inboxIds = new Set(f.inboxIds.filter((id) => typeof id === 'string' && id.length > 0));
      if (inboxIds.size === 0) {
        // A fully drained inbox starts a fresh announcement cycle and bounds the
        // remembered set even for a worker that lives for months.
        this.announcedInboxIds.delete(f.agentId);
        continue;
      }
      if (f.isGod || !f.ptyId) continue;
      if (f.autoDeliveryPaused || f.paused || f.halted) continue;
      if (f.lastOutputAt <= 0) continue; // never produced output → still booting
      if (now - f.lastOutputAt < WORKER_WAKE_IDLE_MS) continue; // mid-turn
      const spawned = this.spawnedAt.get(f.ptyId) ?? 0;
      if (spawned > 0 && now - spawned < WORKER_WAKE_BOOT_GRACE_MS) continue;
      const lastHuman = this.lastHumanNeedsAt.get(f.agentId) ?? 0;
      if (lastHuman > 0 && now - lastHuman < WORKER_WAKE_HITL_REARM_MS) continue;
      const announced = this.announcedInboxIds.get(f.agentId);
      if (announced && !Array.from(inboxIds).some((id) => !announced.has(id))) continue;
      const lastNudge = this.lastNudgeAt.get(f.agentId) ?? 0;
      if (lastNudge > 0 && now - lastNudge < WORKER_WAKE_COOLDOWN_MS) continue;
      this.lastNudgeAt.set(f.agentId, now);
      this.announcedInboxIds.set(f.agentId, inboxIds);
      out.push(f.agentId);
    }
    return out;
  }

  /** Last time this worker was nudged (0 = never) — useful for diagnostics. */
  lastNudge(agentId: string): number {
    return this.lastNudgeAt.get(agentId) ?? 0;
  }
}

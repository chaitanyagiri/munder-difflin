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
 *  workers that are genuinely idle, have undrained inbox mail, are not paused /
 *  not awaiting a human decision, and have not been nudged recently — then types
 *  the same guarded nudge the renderer would have, directly into the PTY.
 *
 *  Safety mirrors the renderer's guarded queue-drain (useHive.ts dispatch):
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
 *  (#358) The nudge is EDGE-triggered, not level-triggered: each worker remembers
 *  the inbox message ids it has already announced, and is only woken again when a
 *  NEW id appears in its inbox. Mail that was already announced is NOT re-nudged
 *  at a flat cadence forever — a worker that stays parked on already-announced
 *  mail (the genuinely-stuck #151 case) is re-woken on a backoff ladder
 *  (60s → 5m → 30m, then 30m) instead.
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
/** Backoff ladder for re-nudging a worker parked on ALREADY-announced mail
 *  (#358): a stuck worker is still woken, but at 60s → 5m → 30m → 30m instead
 *  of a flat minute forever. New mail resets the ladder. */
export const WORKER_WAKE_REPEAT_MS = [WORKER_WAKE_COOLDOWN_MS, 5 * 60_000, 30 * 60_000];

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
  /** Count of undrained inbox messages (0 → nothing to wake for). */
  inboxCount: number;
  /** The ids of the undrained inbox messages, so the watchdog can edge-trigger
   *  on NEW mail instead of re-announcing already-announced ids (#358). Optional
   *  for backward compat — when absent the nudge stays level-triggered. */
  inboxIds?: string[];
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
  /** agentId → timestamp of the last needsHuman hook notification. */
  private lastHumanNeedsAt = new Map<string, number>();
  /** agentId → the inbox message ids the watchdog has already announced, so a
   *  nudge is edge-triggered on NEW mail rather than re-announced at a flat
   *  cadence forever (#358). */
  private announcedIds = new Map<string, Set<string>>();
  /** agentId → how many consecutive re-nudges have fired on already-announced
   *  mail, advancing the WORKER_WAKE_REPEAT_MS backoff ladder (#358). */
  private repeatCounts = new Map<string, number>();

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
    this.lastHumanNeedsAt.delete(agentId);
    this.announcedIds.delete(agentId);
    this.repeatCounts.delete(agentId);
    if (ptyId) this.spawnedAt.delete(ptyId);
  }

  /** The worker ids that should be nudged right now, in stable registry order.
   *  Pure decision — the caller types the nudge.
   *
   *  (#358) Edge-triggered: a worker is only nudged for inbox mail it has not
   *  already been told about. Mail it HAS been told about is only re-nudged when
   *  it is still parked on it (the stuck-worker case), on the backoff ladder. */
  decide(facts: readonly WorkerWakeFacts[], now = Date.now()): string[] {
    const out: string[] = [];
    for (const f of facts) {
      if (f.isGod || f.inboxCount <= 0 || !f.ptyId) continue;
      if (f.autoDeliveryPaused || f.paused || f.halted) continue;
      if (f.lastOutputAt <= 0) continue; // never produced output → still booting
      if (now - f.lastOutputAt < WORKER_WAKE_IDLE_MS) continue; // mid-turn
      const spawned = this.spawnedAt.get(f.ptyId) ?? 0;
      if (spawned > 0 && now - spawned < WORKER_WAKE_BOOT_GRACE_MS) continue;
      const lastHuman = this.lastHumanNeedsAt.get(f.agentId) ?? 0;
      if (lastHuman > 0 && now - lastHuman < WORKER_WAKE_HITL_REARM_MS) continue;
      const lastNudge = this.lastNudgeAt.get(f.agentId) ?? 0;

      // Edge-trigger (#358): when inbox ids are known, only NEW ids are
      // announceable — ids the watchdog already announced reset nothing and only
      // advance the repeat ladder, so a worker parked on already-announced mail
      // is woken at 60s → 5m → 30m, never at the flat cooldown forever. When ids
      // are NOT provided the nudge stays level-triggered (any pending mail is
      // fresh), preserving the pre-#358 behaviour for callers that have no ids.
      const hasIds = Array.isArray(f.inboxIds);
      const pending = new Set(hasIds ? f.inboxIds : []);
      const announced = hasIds ? this.announcedIds.get(f.agentId) : undefined;
      const isFresh = !hasIds || !announced || [...pending].some((id) => !announced.has(id));
      const wait = isFresh
        ? WORKER_WAKE_COOLDOWN_MS
        : WORKER_WAKE_REPEAT_MS[Math.min(this.repeatCounts.get(f.agentId) ?? 0, WORKER_WAKE_REPEAT_MS.length - 1)];
      if (lastNudge > 0 && now - lastNudge < wait) continue;

      this.lastNudgeAt.set(f.agentId, now);
      if (hasIds) this.announcedIds.set(f.agentId, pending);
      this.repeatCounts.set(f.agentId, isFresh ? 0 : (this.repeatCounts.get(f.agentId) ?? 0) + 1);
      out.push(f.agentId);
    }
    return out;
  }

  /** Last time this worker was nudged (0 = never) — useful for diagnostics. */
  lastNudge(agentId: string): number {
    return this.lastNudgeAt.get(agentId) ?? 0;
  }
}
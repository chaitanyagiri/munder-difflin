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
/** Mail this old with NO session activity since it landed = a STALLED worker:
 *  its CLI never took the first turn (a boot-time nudge lost while the TUI was
 *  still drawing, an occluded renderer that never typed one). PTY output cannot
 *  vouch for such a worker — a TUI redraws its chrome without doing any work,
 *  and the boot sequence itself is output — so past this age the quiet-output
 *  and never-output rules are bypassed, and so is the announced-ids edge trigger
 *  (#358 is for a worker that HEARD the announcement; a stalled one did not),
 *  still subject to paused/halted/HITL/boot-grace/cooldown. Observed live
 *  2026-09-06: a worker sat 17 minutes on its work order with 0 tokens and no
 *  transcript until the human typed "read your inbox" by hand; this watchdog
 *  never fired. */
export const WORKER_WAKE_STALL_MS = 90_000;
/** Minimum age of pending mail before a held worker is reported in the log. */
export const WORKER_WAKE_REPORT_MS = 60_000;

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
  /** Timestamp of the agent's last telemetry usage sample — the CLI's own
   *  evidence of a turn — or 0/undefined when it has never reported one. */
  lastActivityAt?: number;
  /** created_at of the OLDEST undrained inbox message, or 0/undefined when
   *  unknown (the stall rule then stays off — fail closed, as before). */
  oldestMailAt?: number;
}

/** Why a worker with pending mail is NOT being nudged right now. */
export type WorkerWakeHold =
  | 'god' | 'no-mail' | 'no-pty'
  | 'delivery-paused' | 'paused' | 'halted'
  | 'booting' | 'mid-turn' | 'boot-grace' | 'hitl' | 'announced' | 'cooldown';

/** The inbox ids that count as mail: non-empty strings only. */
function liveInboxIds(f: WorkerWakeFacts): Set<string> {
  return new Set(f.inboxIds.filter((id) => typeof id === 'string' && id.length > 0));
}

/** Mail has waited WORKER_WAKE_STALL_MS and the CLI has shown no session
 *  activity since it landed: whatever its terminal is printing, this worker is
 *  not working the mail. */
export function isStalledWorker(f: WorkerWakeFacts, now = Date.now()): boolean {
  const mailAt = f.oldestMailAt ?? 0;
  if (mailAt <= 0 || liveInboxIds(f).size === 0) return false;
  if (now - mailAt < WORKER_WAKE_STALL_MS) return false;
  return (f.lastActivityAt ?? 0) < mailAt;
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
    this.lastHoldReportAt.delete(agentId);
    if (ptyId) this.spawnedAt.delete(ptyId);
  }

  /** The worker ids that should be nudged right now, in stable registry order.
   *  Pure decision — the caller types the nudge. */
  /** Why this worker is held right now, or null when it should be nudged.
   *  The same checks decide() applies, in the same order, exposed so the beat
   *  can LOG why a worker with old pending mail is not being woken — the
   *  watchdog's silence used to be indistinguishable from "nothing to do".
   *  Pure: never touches the announcement / cooldown memory. */
  explain(f: WorkerWakeFacts, now = Date.now()): WorkerWakeHold | null {
    const inboxIds = liveInboxIds(f);
    if (inboxIds.size === 0) return 'no-mail';
    if (f.isGod) return 'god';
    if (!f.ptyId) return 'no-pty';
    if (f.autoDeliveryPaused) return 'delivery-paused';
    if (f.paused) return 'paused';
    if (f.halted) return 'halted';
    const stalled = isStalledWorker(f, now);
    if (f.lastOutputAt <= 0 && !stalled) return 'booting'; // never produced output → still booting
    if (now - f.lastOutputAt < WORKER_WAKE_IDLE_MS && !stalled) return 'mid-turn';
    const spawned = this.spawnedAt.get(f.ptyId) ?? 0;
    if (spawned > 0 && now - spawned < WORKER_WAKE_BOOT_GRACE_MS) return 'boot-grace';
    const lastHuman = this.lastHumanNeedsAt.get(f.agentId) ?? 0;
    if (lastHuman > 0 && now - lastHuman < WORKER_WAKE_HITL_REARM_MS) return 'hitl';
    // Edge trigger (#358): mail already announced is not announced again — unless
    // the worker is stalled, i.e. it demonstrably never acted on the announcement.
    const announced = this.announcedInboxIds.get(f.agentId);
    if (announced && !stalled && !Array.from(inboxIds).some((id) => !announced.has(id))) return 'announced';
    const lastNudge = this.lastNudgeAt.get(f.agentId) ?? 0;
    if (lastNudge > 0 && now - lastNudge < WORKER_WAKE_COOLDOWN_MS) return 'cooldown';
    return null;
  }

  decide(facts: readonly WorkerWakeFacts[], now = Date.now()): string[] {
    const out: string[] = [];
    for (const f of facts) {
      const inboxIds = liveInboxIds(f);
      if (inboxIds.size === 0) {
        this.announcedInboxIds.delete(f.agentId);
        continue;
      }
      if (this.explain(f, now) !== null) continue;
      this.lastNudgeAt.set(f.agentId, now);
      this.announcedInboxIds.set(f.agentId, inboxIds);
      out.push(f.agentId);
    }
    return out;
  }

  /** agentId → when its hold was last reported, so the beat logs a held worker
   *  once per cooldown instead of every 15 s. */
  private lastHoldReportAt = new Map<string, number>();

  /** True once per WORKER_WAKE_COOLDOWN_MS per worker — the beat's log gate. */
  shouldReportHold(agentId: string, now = Date.now()): boolean {
    const last = this.lastHoldReportAt.get(agentId) ?? 0;
    if (last > 0 && now - last < WORKER_WAKE_COOLDOWN_MS) return false;
    this.lastHoldReportAt.set(agentId, now);
    return true;
  }

  lastNudge(agentId: string): number {
    return this.lastNudgeAt.get(agentId) ?? 0;
  }
}

/**
 * Worker inbox-wake watchdog — the main-process half of issue #151.
 *
 * Worker wake used to live ONLY in the renderer: one 4s interval enqueues an
 * inbox nudge (deduped on the newest message id), another drains it into the
 * terminal once the agent idles. One wedged store status, one stale dedup key,
 * or one renderer reload losing its in-memory queue, and a durable inbox file
 * sat unread until a full app restart. God never had this problem: the
 * heartbeat re-delivers HIS digest from main on a cadence. This gives workers
 * the same second engine.
 *
 * DECISION ONLY — no I/O, no timers. The index.ts beat feeds it the live
 * registry + pty idle times and broadcasts one `hive:inboxWake` per firing; the
 * RENDERER stays the only terminal writer, re-driving its normal guarded
 * delivery (idle-only, boot grace, pause, draft/picker safety), so this can
 * never bypass the HITL protections hooks.ts deliberately preserves at Stop
 * (never force a continuation from unread mail).
 */

/** An agent must be THIS long idle before it counts as stalled-with-mail —
 *  long enough that a turn wrapping up doesn't get a redundant wake. Idle is
 *  measured from hook boundaries when the provider has them (Stop = idle; any
 *  other real event = busy): raw pty quiet CANNOT tell "mid-turn" from
 *  "sitting at the prompt" for claude's TUI, whose idle prompt repaints
 *  constantly. Hookless providers fall back to pty output recency.
 *
 *  Worst-case wake latency is this threshold PLUS the 60s beat cadence — up to
 *  ~90s from mail landing to the fire. That is the intended shape: this is the
 *  backstop engine, not the primary (the renderer's 4s poll is), so a ~90s
 *  delay here is not a bug to "fix". */
export const WAKE_QUIET_MS = 30_000;
/** While the same mail stays undrained, re-fire on this cadence — the retry
 *  the renderer's single-shot nudge never had. */
export const WAKE_RETRY_MS = 5 * 60_000;
/** A hook-idle of 0 means "mid-turn" — but a CLI that HANGS, crashes without a
 *  Stop, or loses hook delivery reports 0 forever, and the watchdog would be
 *  structurally blind to exactly the stall it exists to catch. A genuinely
 *  working turn keeps the pty emitting, so a pty silence THIS long overrides a
 *  stuck busy hook state. Deliberately well above WAKE_QUIET_MS: a legitimately
 *  long quiet tool call (a slow build emitting nothing) must never be read as
 *  hung on the strength of thirty quiet seconds. */
export const HOOK_STALE_MS = 5 * 60_000;

export interface InboxWakeDeps {
  /** Live registry entries (archived included — they are skipped here). */
  agents: Record<string, { archived?: boolean }>;
  godId: string | null | undefined;
  /** Live pty id for an agent, or undefined when it has none. */
  ptyFor(agentId: string): string | undefined;
  /** ms the agent has been hook-idle (0 = mid-turn / HITL prompt pending), or
   *  null when it has emitted no hook events (hookless provider / booting). */
  hookIdleFor(agentId: string): number | null;
  /** Fallback for hookless agents: ms since the pty last produced output. */
  idleFor(ptyId: string): number | null | undefined;
  /** Ids of the messages currently in the agent's inbox. */
  inboxIds(agentId: string): string[];
}

export interface InboxWakeFire {
  agentId: string;
  /** Retry-cadence key: the lexically-largest undrained inbox id. */
  newestId: string;
  /** EVERY undrained id at fire time — the renderer marks them all as nudged so
   *  its own per-id poll can't queue a duplicate for the same mail. */
  inboxIds: string[];
  idleMs: number;
  /** Which signal produced idleMs — 'hook' (boundary events) or 'pty' (output
   *  recency: hookless provider, or the hung-turn override). Log labels only. */
  idleSource: 'hook' | 'pty';
  count: number;
}

/** Per-agent memory of the last firing — owned by the caller so a re-bootstrap
 *  (changeHome) or a test can reset it. */
export type InboxWakeState = Map<string, { newestId: string; at: number }>;

export function inboxWakeTick(
  deps: InboxWakeDeps,
  state: InboxWakeState,
  now: number
): InboxWakeFire[] {
  const fires: InboxWakeFire[] = [];
  for (const [id, a] of Object.entries(deps.agents)) {
    if (a.archived || id === deps.godId) continue; // god has the heartbeat
    const ptyId = deps.ptyFor(id);
    if (!ptyId) continue; // no live terminal to wake
    const ids = deps.inboxIds(id);
    if (ids.length === 0) { state.delete(id); continue; } // drained — forget it
    const hookIdle = deps.hookIdleFor(id);
    const ptyIdle = deps.idleFor(ptyId) ?? 0;
    // Hook boundaries first; pty recency when there are none — or when the hook
    // state is stuck busy while the pty has been silent past HOOK_STALE_MS (the
    // hung-turn case: without this override a crash-without-Stop pins hookIdle
    // at 0 forever and the watchdog never fires).
    const hungTurn = hookIdle !== null && ptyIdle > HOOK_STALE_MS && ptyIdle > hookIdle;
    const idleMs = hookIdle === null || hungTurn ? ptyIdle : hookIdle;
    const idleSource: 'hook' | 'pty' = hookIdle === null || hungTurn ? 'pty' : 'hook';
    if (idleMs < WAKE_QUIET_MS) continue; // mid-turn; it reads mail on its own
    const newestId = [...ids].sort().slice(-1)[0] ?? '';
    const prev = state.get(id);
    // New mail re-fires immediately; the SAME undrained mail re-fires only on
    // the retry cadence (the renderer dedupes by queue content either way).
    if (prev && prev.newestId === newestId && now - prev.at < WAKE_RETRY_MS) continue;
    state.set(id, { newestId, at: now });
    fires.push({ agentId: id, newestId, inboxIds: [...ids], idleMs, idleSource, count: ids.length });
  }
  return fires;
}

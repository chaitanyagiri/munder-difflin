/** Run one queued delivery and acknowledge it only after the sender resolves.
 * Rejections deliberately leave the queue item untouched for the next retry. */
export async function deliverWithAcknowledgement(
  send: () => Promise<void>,
  acknowledge: () => void
): Promise<boolean> {
  try {
    await send();
    acknowledge();
    return true;
  } catch {
    return false;
  }
}

/**
 * May the drain type into this agent's terminal right now?
 *
 * The gate used to be `status === 'idle'`, full stop, and that stranded mail
 * indefinitely. `looping` is not a terminal state the agent recovers from on its
 * own — it is the circuit breaker's PIN, re-asserted on every beat for as long
 * as the agent is `constrained` or `stopped`. The PTY-quiescence fallback only
 * un-pins `working`, so a breaker-armed agent never returned to `idle` and its
 * queue never drained. Observed live: an agent over its token cap sat pinned
 * while a nudge enqueued two seconds after the message landed went undelivered
 * for minutes, until something outside the app woke it.
 *
 * That is self-defeating, because the breaker STEERS by mailing the agent it
 * armed ("stop, write a plan, send it to god"). Under the old gate the one
 * message meant to unwedge a wedged agent was exactly the message that could
 * never arrive.
 *
 * So a pinned agent is deliverable once its terminal has been silent for
 * `quiesceMs` — the same evidence the idle fallback already trusts to decide a
 * turn is over. The pin stays on the avatar and the badge; it just stops
 * doubling as a delivery lock.
 *
 * `compacting` gets the same admission, and for a stronger reason: PreCompact
 * sets it and only a PostCompact hook clears it — exactly the signal a CLI that
 * hangs or dies mid-compact never sends (a crash fires no hook, and the Stop
 * that would flip the agent idle may already have been consumed). The
 * quiescence sweep only rescues 'working', so a wedged 'compacting' agent could
 * never return to 'idle' on its own, and the drain being strictly head-of-line,
 * one stuck compact starved every later message in the queue — user replies,
 * god directives, even the inbox nudge whose whole job is to unstick the agent.
 * A terminal silent past `quiesceMs` is the same evidence the 'looping' case
 * already trusts: the compact is finished or dead, and either way the queue
 * must move. The badge stays; the delivery lock goes.
 *
 * Everything else still holds the prompt:
 *   - `working` / `thinking`: mid-turn. The quiescence fallback flips a genuinely
 *     finished turn to `idle`, and then the ordinary gate applies.
 *   - `waiting` / `blocked`: an interactive prompt is on screen. The drain ends
 *     every delivery with Enter, which would ANSWER it — the same reason the
 *     one-time TUI seed refuses to type at those two statuses.
 *
 * Fails CLOSED on an unknown `ptyQuietMs` (no reading, or a PTY that has never
 * emitted): silence we cannot measure is not evidence of silence.
 */
export function canDeliverToAgent(
  status: string,
  ptyQuietMs: number | null,
  quiesceMs: number
): boolean {
  if (status === 'idle') return true;
  // 'looping' (breaker pin) and 'compacting' (PreCompact, no PostCompact yet —
  // see the comment above for why that state is un-recoverable on its own) both
  // release the prompt once the terminal is measurably quiet.
  if (status !== 'looping' && status !== 'compacting') return false;
  return ptyQuietMs !== null && ptyQuietMs >= quiesceMs;
}

/** The subset of a QueuedMessage this module needs. Kept structural so the
 *  gate is testable without dragging the store (and zustand) into the test. */
export interface DeliveryGateMessage {
  precondition?: 'inbox-nonempty';
}

export type PreconditionVerdict = 'send' | 'drop';

/** Re-check a queued message's delivery-time precondition, immediately before it
 *  is typed into a PTY.
 *
 *  A queue item is decided at enqueue time and delivered an arbitrary interval
 *  later, so some messages describe a world that may no longer exist by the time
 *  their turn comes. The inbox-wake nudge is the motivating case: an agent that
 *  is already awake routinely drains its whole inbox during the same turn the
 *  nudge was queued from, and delivering it afterwards spends a full turn
 *  discovering there is nothing to read.
 *
 *  Returns 'drop', never 'defer': a stale message left at the head of the queue
 *  would block every message behind it forever.
 *
 *  Fails OPEN. If the inbox cannot be read we send, because a spurious nudge
 *  costs one turn whereas a swallowed one can leave real mail unread
 *  indefinitely. */
export async function checkPrecondition(
  message: DeliveryGateMessage,
  readInbox: () => Promise<{ id?: string }[]>
): Promise<PreconditionVerdict> {
  if (message.precondition !== 'inbox-nonempty') return 'send';
  try {
    return (await readInbox()).length > 0 ? 'send' : 'drop';
  } catch {
    return 'send';
  }
}

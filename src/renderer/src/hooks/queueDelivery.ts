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
  if (status !== 'looping') return false;
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

/** The hook event that proves a typed prompt reached the agent's CLI, per
 *  provider — or null when the provider gives no such signal (delivery is then
 *  acknowledged on the PTY write, as before). Claude Code, Codex and Gemini all
 *  run the harness shim on UserPromptSubmit (see installClaudeHooks /
 *  installCodexHooks / the Gemini BeforeAgent mapping in hive.ts). */
export function promptAckEventFor(provider: string): 'UserPromptSubmit' | null {
  return provider === 'claude' || provider === 'codex' || provider === 'gemini' ? 'UserPromptSubmit' : null;
}

/** Slash commands (/compact, /clear, /remote-control …) are handled by the TUI
 *  itself and do not reliably raise UserPromptSubmit, so they keep the
 *  write-is-delivery rule: demanding a confirmation would re-type /compact. */
export function promptNeedsConfirmation(provider: string, text: string): boolean {
  return promptAckEventFor(provider) !== null && !text.trim().startsWith('/');
}

/** Per-agent memory of prompt-submit events, so a delivery can wait for the
 *  one that proves ITS prompt was received.
 *
 *  Why: "ready to receive" is judged by the TUI having painted anything plus a
 *  short settle (providerAutomation.terminalReadyToReceive), which is the boot
 *  banner, not the input box. Bytes typed before the CLI's input handler is
 *  attached are silently lost, and the old acknowledge-on-write rule then
 *  dropped the queue item, so nothing ever retried. Observed live twice
 *  (2026-09-06 worker-stanley4, 2026-09-07 worker-holly): work order in the
 *  inbox, queue empty, 0 tokens, no transcript, for as long as nobody typed
 *  by hand. Pure and clock-injectable so it is unit-testable. */
export class PromptAckTracker {
  private lastAt = new Map<string, number>();
  private waiters = new Map<string, Array<{ since: number; resolve: (ok: boolean) => void }>>();

  /** Record a prompt submit reported by `agentId` at `at`. Wakes every waiter
   *  whose typing happened at or before that moment. */
  note(agentId: string, at = Date.now()): void {
    const prev = this.lastAt.get(agentId) ?? 0;
    if (at > prev) this.lastAt.set(agentId, at);
    const list = this.waiters.get(agentId);
    if (!list) return;
    const keep: typeof list = [];
    for (const w of list) {
      if (w.since <= at) w.resolve(true); else keep.push(w);
    }
    if (keep.length) this.waiters.set(agentId, keep); else this.waiters.delete(agentId);
  }

  /** Resolves true once a prompt submit at or after `since` is known for
   *  `agentId`; false when `timeoutMs` elapses first. A submit that already
   *  happened resolves immediately. */
  waitFor(agentId: string, since: number, timeoutMs: number): Promise<boolean> {
    const last = this.lastAt.get(agentId) ?? 0;
    if (last >= since) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const w = { since, resolve: (ok: boolean) => { clearTimeout(timer); resolve(ok); } };
      const timer = setTimeout(() => {
        const list = this.waiters.get(agentId) ?? [];
        const rest = list.filter((x) => x !== w);
        if (rest.length) this.waiters.set(agentId, rest); else this.waiters.delete(agentId);
        resolve(false);
      }, timeoutMs);
      const list = this.waiters.get(agentId) ?? [];
      list.push(w);
      this.waiters.set(agentId, list);
    });
  }

  /** Drop everything known about an agent (it exited / was archived). */
  forget(agentId: string): void {
    this.lastAt.delete(agentId);
    for (const w of this.waiters.get(agentId) ?? []) w.resolve(false);
    this.waiters.delete(agentId);
  }
}

export type DeliveryOutcome = 'delivered' | 'unconfirmed' | 'failed';

/** Run one queued delivery: send, then wait for the agent's own confirmation,
 *  and acknowledge only then. `unconfirmed` = the PTY took the bytes but the
 *  CLI never reported the prompt — the caller keeps the item and retries.
 *  `failed` = the send itself rejected (dead PTY), as before. */
export async function deliverWithConfirmation(
  send: () => Promise<void>,
  confirm: () => Promise<boolean>,
  acknowledge: () => void
): Promise<DeliveryOutcome> {
  try {
    await send();
  } catch {
    return 'failed';
  }
  if (!(await confirm())) return 'unconfirmed';
  acknowledge();
  return 'delivered';
}

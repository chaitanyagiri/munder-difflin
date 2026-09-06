/** The single definition of "this card is waiting on the human".
 *
 *  An ask is OPEN when a `humanQA` entry has a question but no answer and was not
 *  dismissed. That alone makes the card wait on the human — the card's `status`
 *  is NOT part of the test. Before this module, ASK ME (the tab, the kanban badge
 *  and the floor board) also required `status === 'blocked'`, so an ask the god
 *  appended to a card it had left in `doing` was recorded in the ledger yet shown
 *  nowhere: the god told the human "awaiting your answer — ASK ME tab" and the tab
 *  was empty (observed live 2026-09-06 on card F1, ~440k tokens into the god's
 *  session, after the same god had done it right three times). The invariant now
 *  lives in the harness, where an agent cannot forget it; main and renderer both
 *  import it from here so they can never disagree about what an open ask is. */

export interface HumanAskLike {
  q?: unknown;
  a?: unknown;
  askedAt?: unknown;
  answeredAt?: unknown;
  dismissedAt?: unknown;
}

export interface AskCardLike {
  id?: unknown;
  title?: unknown;
  status?: unknown;
  humanQA?: unknown;
}

/** The newest open ask on a card, or undefined. Scans from the end so the
 *  entry the human sees is the latest question, not the first ever asked. */
export function openQuestion<E extends HumanAskLike>(
  card: { humanQA?: E[] | unknown } | null | undefined
): E | undefined {
  const qa = card?.humanQA;
  if (!Array.isArray(qa)) return undefined;
  for (let i = qa.length - 1; i >= 0; i--) {
    const e = qa[i] as E | undefined;
    if (e && typeof e.q === 'string' && !e.a && !e.dismissedAt) return e;
  }
  return undefined;
}

/** True when the card has an open ask — regardless of its kanban status. */
export function waitsOnHuman(card: { humanQA?: unknown } | null | undefined): boolean {
  return !!openQuestion<HumanAskLike>(card);
}

export interface OpenAsk {
  taskId: string;
  title: string;
  question: string;
  askedAt: string | null;
  /** Stable identity of one ask across ledger reads (card + askedAt, falling
   *  back to the question text when the god omitted the timestamp). */
  key: string;
}

/** Every open ask in a ledger. Accepts the on-disk `{ tasks: [...] }` shape or a
 *  bare array; tolerates the loosely-typed cards agents write by hand. */
export function openAsks(ledger: unknown): OpenAsk[] {
  const tasks = Array.isArray(ledger)
    ? ledger
    : (ledger as { tasks?: unknown } | null | undefined)?.tasks;
  if (!Array.isArray(tasks)) return [];
  const out: OpenAsk[] = [];
  tasks.forEach((t, i) => {
    const card = (t ?? {}) as AskCardLike;
    const open = openQuestion<HumanAskLike>(card as { humanQA?: unknown });
    if (!open) return;
    const taskId = typeof card.id === 'string' && card.id ? card.id : `idx-${i}`;
    const title = typeof card.title === 'string' && card.title ? card.title : taskId;
    const askedAt = typeof open.askedAt === 'string' && open.askedAt ? open.askedAt : null;
    const question = open.q as string;
    out.push({ taskId, title, question, askedAt, key: `${taskId} @ ${askedAt ?? question}` });
  });
  return out;
}

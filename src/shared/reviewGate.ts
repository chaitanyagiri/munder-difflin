/**
 * The review gate: a task card cannot reach `done` until a reviewer has
 * approved the work AND a final reviewer has approved it after that.
 *
 * The whole point of this file is the word AFTER. "Two approvals exist on the
 * card" is easy and worthless — a developer can push a change the moment both
 * are in, and the card still reads as signed off. What the operator asked for
 * is that a final reviewer's approval is the LAST thing that happened to the
 * card. So the trail is versioned:
 *
 *   - Every card carries a `revision` (absent = 0), the work round it is in.
 *   - Every review entry records the revision it was cast against.
 *   - Only entries at the CURRENT revision count. Everything older is history.
 *   - Requesting changes bumps the revision, which invalidates every approval
 *     already collected in that round — including a reviewer's. That is the
 *     loop the operator described: reject → developer fixes → reviewer approves
 *     again → final reviewer approves again.
 *   - Re-submitting work when approvals already exist ALSO bumps the revision,
 *     so "approve, then quietly change it" cannot produce a signed-off card.
 *
 * Two degradations are deliberate, because without them this feature bricks
 * every hive that predates it:
 *
 *   1. **No regime, no gate.** If not one active agent holds `reviewer` or
 *      `final-reviewer`, `done` passes through untouched. A hive that never
 *      opted in behaves exactly as before.
 *   2. **A stage with nobody to clear it is skipped.** Reviewers but no final
 *      reviewer → the reviewer's approval completes the card. This is also what
 *      makes the eligibility rule below safe.
 *
 * And one loophole is closed: **the assignee's own approval never counts.** An
 * agent holding the reviewer duty that is also the assignee of a card would
 * otherwise sign off its own work. Eligibility is therefore computed per card
 * (see `dutyCensus`) — an assignee is excluded from the census, so a hive whose
 * only reviewer IS the assignee reports "no reviewer" for that card and skips
 * the stage rather than deadlocking on an approval that can never legally come.
 */

import { normalizeDuty, type AgentDuty } from './agentDuty';

export type HiveTaskStatus = 'todo' | 'doing' | 'blocked' | 'done';

/** What an agent did to a card. `submitted` is a developer saying "ready for
 *  review"; the other two are verdicts. Kept in one append-only list because
 *  the ORDER of these events is the thing being enforced. */
export type ReviewVerdict = 'submitted' | 'approved' | 'changes-requested';

export interface TaskReview {
  /** agent id that cast this. */
  by: string;
  /** The duty held AT THE TIME. Read from the entry, never re-read from the
   *  live registry — demoting an agent must not rewrite what it once approved. */
  duty: AgentDuty;
  verdict: ReviewVerdict;
  /** The work round this was cast against. Entries below the card's current
   *  revision are history and clear nothing. */
  revision: number;
  /** ISO-8601. */
  at: string;
  note?: string;
}

/** The subset of a card this module reads and writes. Deliberately structural:
 *  main holds `HiveTask`, the renderer holds its own display model, and the
 *  ledger on disk holds whatever the god wrote — all three satisfy this. */
export interface ReviewableTask {
  id?: string;
  status?: HiveTaskStatus | string;
  assignee?: string;
  /** ISO-8601. Used only to grandfather cards finished before any duty existed
   *  — see `isGrandfathered`. */
  createdAt?: string;
  revision?: number;
  reviews?: TaskReview[];
}

/**
 * Is this card older than the review regime, and therefore none of its
 * business?
 *
 * The read gate (see `HiveClient.tasks`) reports a `done` card as unfinished
 * when its trail is incomplete, which is what stops the god from writing
 * `"status": "done"` straight into `tasks.json` and bypassing everything. But
 * applied naively that rule reaches BACKWARDS: the moment an operator assigns
 * the first reviewer, every card the hive ever completed has an empty trail and
 * would reappear on the board as in-flight work.
 *
 * `regimeSince` is stamped into the registry the first time any agent is given
 * a gating duty. A card created before that instant was completed under the old
 * rules and stays completed.
 *
 * Two judgement calls, both erring the same way — towards not disturbing
 * finished work:
 *   - No `regimeSince` at all (a hive that never opted in) → everything is
 *     grandfathered.
 *   - No `createdAt` (a hand-written card) → grandfathered only if the card has
 *     no review trail either. A card with a trail is demonstrably living under
 *     the regime, whatever its missing timestamp says.
 */
export function isGrandfathered(
  task: ReviewableTask | null | undefined,
  regimeSince?: string
): boolean {
  if (!regimeSince) return true;
  const since = Date.parse(regimeSince);
  if (!Number.isFinite(since)) return true;
  const created = task?.createdAt ? Date.parse(task.createdAt) : NaN;
  if (!Number.isFinite(created)) {
    return !(Array.isArray(task?.reviews) && task!.reviews!.length > 0);
  }
  return created < since;
}

/** Which stages actually have somebody who can clear them, FOR ONE CARD. */
export interface DutyCensus {
  /** An active `reviewer` exists that is not the card's assignee. */
  hasReviewer: boolean;
  /** An active `final-reviewer` exists that is not the card's assignee. */
  hasFinalReviewer: boolean;
}

/** Derived position of a card in the workflow. Not persisted — computing it is
 *  cheap and a stored copy would be a second source of truth that drifts. */
export type ReviewStage = 'implementing' | 'peer-review' | 'final-review' | 'complete';

/** Nothing to enforce: no stage has an eligible approver. */
export function censusIsEmpty(census: DutyCensus): boolean {
  return !census.hasReviewer && !census.hasFinalReviewer;
}

/**
 * The verdict an agent attaches to a hive message.
 *
 * This is how a verdict enters the ledger: not by an agent editing
 * `tasks.json` (the hive's locked rule is that an agent writes only inside its
 * own directory), but by writing ONE message into its own outbox with this
 * field set. The router picks it up where the sender is proven by directory
 * ownership, reads the sender's duty from the registry, and records the verdict
 * itself — so no payload can claim an authority its author does not hold.
 */
export interface ReviewMessagePayload {
  /** The card's id. */
  task: string;
  verdict: ReviewVerdict;
}

const VERDICTS: readonly ReviewVerdict[] = ['submitted', 'approved', 'changes-requested'];

/** Validate the `review` field off a hand-written message. Null when absent or
 *  malformed — a malformed verdict must not become a silently-recorded
 *  `submitted`, so nothing here defaults. */
export function parseReviewPayload(value: unknown): ReviewMessagePayload | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { task?: unknown; verdict?: unknown };
  if (typeof v.task !== 'string' || !v.task.trim()) return null;
  if (typeof v.verdict !== 'string') return null;
  const verdict = v.verdict.trim().toLowerCase().replace(/[\s_]+/g, '-') as ReviewVerdict;
  if (!VERDICTS.includes(verdict)) return null;
  return { task: v.task.trim(), verdict };
}

/**
 * Who can clear the card's CURRENT stage — the agents the god should hand it
 * to. Empty for `implementing` (that is the assignee's) and `complete`.
 * The assignee is excluded for the same reason as in `dutyCensus`.
 */
export function eligibleFor(
  stage: ReviewStage,
  duties: Readonly<Record<string, AgentDuty | string | undefined>>,
  assignee?: string
): string[] {
  const want: AgentDuty | null =
    stage === 'peer-review' ? 'reviewer' : stage === 'final-review' ? 'final-reviewer' : null;
  if (!want) return [];
  return Object.entries(duties ?? {})
    .filter(([id, raw]) => id !== assignee && normalizeDuty(raw) === want)
    .map(([id]) => id);
}

/**
 * Who can clear which stage for one card.
 *
 * `duties` must already be narrowed to agents that can actually act — active,
 * not archived. An archived reviewer would otherwise hold every card hostage.
 * `assignee` is excluded from both counts: see the self-approval note above.
 */
export function dutyCensus(
  duties: Readonly<Record<string, AgentDuty | string | undefined>>,
  assignee?: string
): DutyCensus {
  let hasReviewer = false;
  let hasFinalReviewer = false;
  for (const [id, raw] of Object.entries(duties ?? {})) {
    if (assignee && id === assignee) continue;
    const duty = normalizeDuty(raw);
    if (duty === 'reviewer') hasReviewer = true;
    else if (duty === 'final-reviewer') hasFinalReviewer = true;
  }
  return { hasReviewer, hasFinalReviewer };
}

export function revisionOf(task: ReviewableTask | null | undefined): number {
  const r = task?.revision;
  return typeof r === 'number' && Number.isFinite(r) && r > 0 ? Math.floor(r) : 0;
}

/** The card's review entries for its current revision, in recorded order. */
export function currentReviews(task: ReviewableTask | null | undefined): TaskReview[] {
  const list = Array.isArray(task?.reviews) ? task!.reviews! : [];
  const rev = revisionOf(task);
  return list.filter((e) => e && typeof e === 'object' && revisionAt(e) === rev);
}

function revisionAt(entry: TaskReview): number {
  const r = entry.revision;
  return typeof r === 'number' && Number.isFinite(r) && r > 0 ? Math.floor(r) : 0;
}

/**
 * Where the card stands.
 *
 * Reads only the current revision, so a bumped revision resets the card to
 * `implementing` with no special case for "was rejected".
 */
export function reviewStage(task: ReviewableTask | null | undefined, census: DutyCensus): ReviewStage {
  const entries = currentReviews(task);
  const assignee = task?.assignee;

  // A card that SAYS it is done has, by saying so, been handed over — even with
  // no `submitted` entry behind it. That is not a nicety: the god edits
  // `tasks.json` with its own file tools, so a card it closes arrives here with
  // `status: "done"` and an empty trail. Reading that as `implementing` would
  // report the card as "not submitted for review yet", which is both unhelpful
  // and self-fulfilling — no reviewer is ever cued, so the approval the gate is
  // waiting for can never arrive. The write path records the same implicit
  // submit for real (`gateTaskTransition`); this keeps the read path agreeing
  // with it without a write.
  const handedOver = entries.some((e) => e.verdict === 'submitted') || task?.status === 'done';
  if (!handedOver) return 'implementing';

  const approvalsBy = (duty: AgentDuty): number[] => {
    const out: number[] = [];
    entries.forEach((e, i) => {
      if (e.verdict !== 'approved') return;
      if (normalizeDuty(e.duty) !== duty) return;
      // An assignee cannot clear a stage on its own card, whatever duty it held.
      if (assignee && e.by === assignee) return;
      out.push(i);
    });
    return out;
  };

  // Peer stage. With no eligible reviewer the stage is skipped, and "cleared at
  // index -1" makes the ordering test below trivially true for the final stage.
  let peerClearedAt = -1;
  if (census.hasReviewer) {
    const peer = approvalsBy('reviewer');
    if (!peer.length) return 'peer-review';
    peerClearedAt = peer[peer.length - 1];
  }

  if (!census.hasFinalReviewer) return 'complete';

  // The ordering rule, and the reason approvals carry an index at all: a final
  // approval cast BEFORE the peer approval does not count. It reviewed work
  // that the reviewer had not yet passed.
  const finalAfterPeer = approvalsBy('final-reviewer').some((i) => i > peerClearedAt);
  return finalAfterPeer ? 'complete' : 'final-review';
}

/** One line, for a card chip / a log entry / a refusal reason. */
export function stageReason(stage: ReviewStage): string {
  switch (stage) {
    case 'implementing': return 'not submitted for review yet';
    case 'peer-review': return 'awaiting a reviewer’s approval';
    case 'final-review': return 'awaiting a final reviewer’s approval';
    case 'complete': return 'reviewed and approved';
  }
}

export interface RecordReviewInput {
  by: string;
  duty: AgentDuty | string | undefined;
  verdict: ReviewVerdict;
  note?: string;
  /** ISO-8601; defaults to now. Injectable so tests are deterministic. */
  at?: string;
}

/**
 * Append one review event, doing the revision bookkeeping that makes the trail
 * mean what it says. Returns a NEW task object; never mutates the input, so a
 * caller holding the raw on-disk entry keeps its unmodelled fields.
 *
 * The two bumps:
 *   - `changes-requested` is recorded against the round it judged, and THEN the
 *     round closes. Every approval in it is now history.
 *   - `submitted` closes the round first if that round already collected an
 *     approval, so re-submitting after a sign-off cannot inherit it.
 */
export function recordReview<T extends ReviewableTask>(task: T, input: RecordReviewInput): T {
  const at = input.at ?? new Date().toISOString();
  const duty = normalizeDuty(input.duty);
  const existing = Array.isArray(task.reviews) ? task.reviews : [];
  let revision = revisionOf(task);

  if (input.verdict === 'submitted' && currentReviews(task).some((e) => e.verdict === 'approved')) {
    revision += 1;
  }

  const entry: TaskReview = {
    by: input.by,
    duty,
    verdict: input.verdict,
    revision,
    at,
    ...(input.note ? { note: input.note } : {})
  };

  const nextRevision = input.verdict === 'changes-requested' ? revision + 1 : revision;
  const next: T = { ...task, reviews: [...existing, entry] };
  if (nextRevision > 0) next.revision = nextRevision;
  return next;
}

export interface GateResult<T extends ReviewableTask> {
  /** The card to persist — carries an implicit `submitted` entry when the
   *  caller asked for `done` without ever handing the work over. */
  task: T;
  /** The status that may actually be written. */
  status: HiveTaskStatus;
  stage: ReviewStage;
  /** True when `requested` was refused and `status` is not what was asked for. */
  refused: boolean;
  /** Why, when refused. Written into the log and handed back to the caller so
   *  the god can see the gate rather than guess at it. */
  reason?: string;
}

export interface GateOptions {
  /** The status the card has ON DISK. A card that is already `done` is left
   *  alone: this feature must not retroactively reopen finished work. */
  previousStatus?: HiveTaskStatus | string;
  /** When the hive's first gating duty was assigned. Cards older than this are
   *  grandfathered (see `isGrandfathered`). */
  regimeSince?: string;
  /** Who is asking. Used as the author of the implicit submit. */
  actor?: string;
  at?: string;
}

/**
 * Decide whether `requested` may be written, and return the card to persist.
 *
 * Refusing `done` yields `doing`, not `blocked`: in this app `blocked` means
 * "a human must act" and drives the ASK ME board. A card waiting on a reviewer
 * is not waiting on the human.
 *
 * A `done` request on a card that was never submitted is treated as the submit
 * it plainly is — the god setting `done` IS the claim that the work is
 * finished. Without that, the gate would sit at `implementing` forever unless
 * every agent learned a new verb first, and the operator would see cards that
 * simply never complete.
 */
export function gateTaskTransition<T extends ReviewableTask>(
  task: T,
  requested: HiveTaskStatus | string | undefined,
  census: DutyCensus,
  opts: GateOptions = {}
): GateResult<T> {
  const asked = (requested ?? task.status ?? 'todo') as HiveTaskStatus;

  // Not a completion attempt, no regime at all, already finished before this
  // feature existed, or a card that predates the regime — nothing to enforce.
  if (
    asked !== 'done' ||
    censusIsEmpty(census) ||
    opts.previousStatus === 'done' ||
    ('regimeSince' in opts && isGrandfathered(task, opts.regimeSince))
  ) {
    return { task, status: asked, stage: reviewStage(task, census), refused: false };
  }

  let next = task;
  if (!currentReviews(next).some((e) => e.verdict === 'submitted')) {
    next = recordReview(next, {
      by: opts.actor || task.assignee || 'god',
      duty: 'developer',
      verdict: 'submitted',
      note: 'submitted for review (implicit: completion was requested)',
      at: opts.at
    });
  }

  const stage = reviewStage(next, census);
  if (stage === 'complete') return { task: next, status: 'done', stage, refused: false };

  return {
    task: next,
    status: 'doing',
    stage,
    refused: true,
    reason: `cannot complete — ${stageReason(stage)}`
  };
}

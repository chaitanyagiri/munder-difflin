/**
 * An agent's DUTY — what it is allowed to do in the review workflow.
 *
 * This is a different axis from `role` (see `agentRole.ts`), and the two are
 * deliberately not merged. `role` is the free-text hire one-liner ("Head of
 * Marketing — owns marketing-control-room"): prose, written by whoever hired
 * the agent, read by humans and by the agent itself. `duty` is a closed set the
 * harness reasons about: it decides who may implement, whose approval counts,
 * and when a task card is allowed to reach `done`.
 *
 * Collapsing them was the obvious first idea and it fails immediately: a gate
 * cannot be driven by a string a human types freehand, and a hire one-liner
 * cannot be reduced to four words without losing the whole point of it. So a
 * registry entry carries both — `role: "Head of Marketing — …"`, `duty:
 * "reviewer"`.
 *
 * The workflow the duties encode:
 *
 *   developer      implements. Its output must be approved by a reviewer.
 *   reviewer       reviews, does not implement. Its approval clears the peer
 *                  stage. A rejection sends the card back to the developer.
 *   final-reviewer reviews LAST, after a reviewer has approved. Only its
 *                  approval completes a card. There may be several; any one of
 *                  them suffices.
 *   unassigned     the pre-existing state. Behaves like a developer: it can
 *                  implement, and its approval clears nothing.
 *
 * `unassigned` is what every agent registered before this feature has, which is
 * why the gate has to treat "no duties anywhere" as "no regime" rather than as
 * "nothing may ever complete" — see `reviewGate.ts`.
 */

export const AGENT_DUTIES = ['developer', 'reviewer', 'final-reviewer', 'unassigned'] as const;

export type AgentDuty = (typeof AGENT_DUTIES)[number];

/** What a brand-new agent gets when the operator does not pick anything.
 *  `developer` rather than `unassigned`: the overwhelmingly common case is an
 *  agent that does work, and leaving new hires unassigned would mean the duty
 *  picker looks optional while quietly opting the agent out of the workflow. */
export const DEFAULT_AGENT_DUTY: AgentDuty = 'developer';

/** Coerce anything read off disk / off the wire into a known duty.
 *  Unknown strings and missing values become `unassigned`, never the default —
 *  a typo in a hand-edited `registry.json` must not silently enrol an agent as
 *  a developer, and a legacy record has genuinely made no choice. */
export function normalizeDuty(value: unknown): AgentDuty {
  if (typeof value !== 'string') return 'unassigned';
  const v = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
  // Tolerate the spellings a human or an LLM actually writes. The canonical
  // value is what gets persisted, so these aliases never spread.
  if (v === 'dev' || v === 'developer' || v === 'engineer') return 'developer';
  if (v === 'reviewer' || v === 'review' || v === 'peer-reviewer') return 'reviewer';
  if (
    v === 'final-reviewer' || v === 'last-reviewer' || v === 'finalreviewer' ||
    v === 'lastreviewer' || v === 'final' || v === 'last'
  ) {
    return 'final-reviewer';
  }
  if (v === 'unassigned' || v === 'none' || v === '') return 'unassigned';
  return 'unassigned';
}

/** May this duty cast a review verdict that CLEARS a stage?
 *  A developer's review is still recorded and still worth reading — it simply
 *  moves no card, which is what `recordTaskReview` reports back to the caller
 *  so an advisory verdict is not mistaken for a sign-off. */
export function mayGate(duty: AgentDuty): boolean {
  return duty === 'reviewer' || duty === 'final-reviewer';
}

/** The one-line rule text injected into an agent's `identity.md`, so the agent
 *  itself knows what it may and may not do. Returns undefined for a duty that
 *  imposes nothing, so the identity file gains no empty bullet. */
export function dutyBriefing(duty: AgentDuty): string | undefined {
  switch (duty) {
    case 'developer':
      return 'You are a **DEVELOPER**. You implement — write and change code, run it, and prove it works. You do NOT sign off work: your own card is never done on your word, and reviewing OTHER agents\' work is not your job. When you believe a card is finished, hand it over: write ONE message into your outbox with `"to": "god"`, `"act": "inform"`, a short summary in `body`, and `"review": {"task": "<card id>", "verdict": "submitted"}` — the harness records the handover on the card and tells god to route a reviewer. A reviewer approves it, then a final reviewer approves it, and only then is it done. If a review comes back with changes requested, the card is yours again: discuss with the reviewer if needed, fix it, and submit again the same way.';
    case 'reviewer':
      return 'You are a **REVIEWER**. You review — you do NOT implement. Read the code, run it, reason about it, and then give a verdict: write ONE message into your outbox with `"to": "god"` (or the developer\'s id), `"act": "inform"`, your findings in `body`, and `"review": {"task": "<card id>", "verdict": "approved"}` or `"verdict": "changes-requested"`. The harness records the verdict on the card under YOUR duty — you cannot approve your own card, and a verdict written straight into tasks.json is not yours. Do not fix the problem yourself: describe it concretely, send the card back, and re-review after the developer resubmits; talk to the developer directly (their inbox) when a finding needs discussion. Your approval clears the peer stage only — a final reviewer still has to approve after you, so approve when the work is genuinely right, not nearly right.';
    case 'final-reviewer':
      return 'You are a **FINAL REVIEWER**. You review LAST, and you do NOT implement. A card reaches you only after a reviewer has approved it, and your approval is the single thing that makes it done. Check that the work satisfies the card and that the earlier review was real, then give a verdict: write ONE message into your outbox with `"to": "god"`, `"act": "inform"`, your findings in `body`, and `"review": {"task": "<card id>", "verdict": "approved"}` or `"verdict": "changes-requested"`. The harness records it under your duty. Requesting changes sends the card all the way back — the developer fixes it, a reviewer approves it again, and only then does it return to you. Never approve a card assigned to yourself.';
    case 'unassigned':
      return undefined;
  }
}

/** Human-facing label. The UI translates its own copy; this is for files the
 *  agents read (identity.md, log lines, dispatch text). */
export function dutyLabel(duty: AgentDuty): string {
  switch (duty) {
    case 'developer': return 'developer';
    case 'reviewer': return 'reviewer';
    case 'final-reviewer': return 'final reviewer';
    case 'unassigned': return 'unassigned';
  }
}

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
 *   planner     turns the human's requirements into a detailed plan. Plans a
 *               card ONCE, does not implement, does not review.
 *   developer   implements, working from that plan. Its output must be
 *               approved by a reviewer.
 *   reviewer    reviews, does not implement. **Its approval completes the
 *               card** — it is the last word. A rejection sends the card back
 *               to the DEVELOPER, never to the planner.
 *   unassigned  the pre-existing state. Behaves like a developer: it can
 *               implement, and its approval clears nothing.
 *
 * `unassigned` is what every agent registered before this feature has, which is
 * why the gate has to treat "no duties anywhere" as "no regime" rather than as
 * "nothing may ever complete" — see `reviewGate.ts`.
 */

export const AGENT_DUTIES = ['planner', 'developer', 'reviewer', 'unassigned'] as const;

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
  if (v === 'planner' || v === 'plan' || v === 'architect') return 'planner';
  if (v === 'dev' || v === 'developer' || v === 'engineer') return 'developer';
  // A separate final-reviewer duty existed briefly and was removed: one review
  // is the whole review. Every spelling of it now lands on `reviewer` — the
  // duty that closes a card today — so a registry.json written while it existed
  // keeps a reviewing agent reviewing instead of silently falling to
  // `unassigned`, which would drop it out of the workflow and quietly hand its
  // cards' sign-off to nobody.
  if (
    v === 'reviewer' || v === 'review' || v === 'peer-reviewer' ||
    v === 'final-reviewer' || v === 'last-reviewer' || v === 'finalreviewer' ||
    v === 'lastreviewer' || v === 'final' || v === 'last'
  ) {
    return 'reviewer';
  }
  if (v === 'unassigned' || v === 'none' || v === '') return 'unassigned';
  return 'unassigned';
}

/** The one-line rule text injected into an agent's `identity.md`, so the agent
 *  itself knows what it may and may not do. Returns undefined for a duty that
 *  imposes nothing, so the identity file gains no empty bullet. */
export function dutyBriefing(duty: AgentDuty): string | undefined {
  switch (duty) {
    case 'planner':
      return 'You are a **PLANNER**. You plan — you do NOT write code and you do NOT review it. The human\'s requirements reach you through `god`; your job is to turn them into a plan detailed enough that a developer can execute it without guessing: what is being built and why, which files and components are touched, the steps in order, the interfaces and data shapes involved, what is explicitly out of scope, and how anyone can tell it is finished. Investigate the codebase read-only first — a plan written without reading the code is a wish. Deliver it by writing ONE message into your outbox with `"to": "god"`, `"act": "inform"`, **the full plan as the `body`**, and `"review": {"task": "<card id>", "verdict": "planned"}`; the harness stores the body on the card as its plan, where the developer reads it. You plan each card ONCE. When a reviewer later requests changes, the card goes back to the DEVELOPER, not to you — a rejection is a statement about the implementation, not about the plan. Do not re-plan a card unless the human changes the requirements.';
    case 'developer':
      return 'You are a **DEVELOPER**. You implement — write and change code, run it, and prove it works. Build from the card\'s `plan` when it has one: that is the planner\'s brief and it is what your work is measured against, so read it before you start and say so if it is wrong rather than quietly departing from it. You do NOT sign off work: your own card is never done on your word, and reviewing OTHER agents\' work is not your job. When you believe a card is finished, hand it over: write ONE message into your outbox with `"to": "god"`, `"act": "inform"`, a short summary in `body`, and `"review": {"task": "<card id>", "verdict": "submitted"}` — the harness records the handover and tells god to route a reviewer. The reviewer\'s approval is what completes the card. If a review comes back with changes requested, the card is YOURS again: discuss with the reviewer if needed, fix it against the same plan, and submit again the same way. Do not send it back to the planner.';
    case 'reviewer':
      return 'You are a **REVIEWER**. You review — you do NOT implement. Read the code, run it, reason about it, and check it against the card\'s `plan` where there is one. Then give a verdict: write ONE message into your outbox with `"to": "god"` (or the developer\'s id), `"act": "inform"`, your findings in `body`, and `"review": {"task": "<card id>", "verdict": "approved"}` or `"verdict": "changes-requested"`. **Your approval completes the card — you are the last word on it**, so approve when the work is genuinely right rather than when it is nearly right. The harness records the verdict on the card under YOUR duty — you cannot approve your own card, and a verdict written straight into tasks.json is not yours. Do not fix the problem yourself: describe it concretely and send the card back to its DEVELOPER (never to the planner), then re-review after they resubmit; talk to the developer directly (their inbox) when a finding needs discussion.';
    case 'unassigned':
      return undefined;
  }
}

/** Human-facing label. The UI translates its own copy; this is for files the
 *  agents read (identity.md, log lines, dispatch text). */
export function dutyLabel(duty: AgentDuty): string {
  switch (duty) {
    case 'planner': return 'planner';
    case 'developer': return 'developer';
    case 'reviewer': return 'reviewer';
    case 'unassigned': return 'unassigned';
  }
}

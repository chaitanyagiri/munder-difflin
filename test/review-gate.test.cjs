'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  dutyCensus,
  censusIsEmpty,
  revisionOf,
  currentReviews,
  reviewStage,
  recordReview,
  gateTaskTransition,
  stageReason
} = loadTs('src/shared/reviewGate.ts');

// A hive with all three duties. `dev` implements, `rev` peer-reviews, `boss`
// signs off last.
const DUTIES = { dev: 'developer', rev: 'reviewer', boss: 'final-reviewer' };
const card = (extra = {}) => ({ id: 't1', status: 'doing', assignee: 'dev', ...extra });

const at = (n) => `2026-01-0${n}T00:00:00.000Z`;

// ── census ──────────────────────────────────────────────────────────────────

test('the census reports which stages have an eligible approver', () => {
  const c = dutyCensus(DUTIES, 'dev');
  assert.deepEqual(c, { hasReviewer: true, hasFinalReviewer: true });
  assert.equal(censusIsEmpty(c), false);
});

test('a hive with no duties has no regime at all', () => {
  const c = dutyCensus({ a: 'developer', b: undefined, c: 'nonsense' }, 'a');
  assert.deepEqual(c, { hasReviewer: false, hasFinalReviewer: false });
  assert.equal(censusIsEmpty(c), true);
});

test('the assignee is excluded from its own card’s census', () => {
  // Closes the self-approval loophole AND avoids the deadlock it would create:
  // the only reviewer being the assignee reports "no reviewer" for THIS card,
  // so the stage is skipped rather than waiting on an approval that can never
  // legally count.
  assert.deepEqual(
    dutyCensus({ solo: 'reviewer' }, 'solo'),
    { hasReviewer: false, hasFinalReviewer: false }
  );
  assert.deepEqual(
    dutyCensus({ solo: 'reviewer' }, 'someone-else'),
    { hasReviewer: true, hasFinalReviewer: false }
  );
});

// ── stage derivation ────────────────────────────────────────────────────────

test('a card nobody handed over is still being implemented', () => {
  const census = dutyCensus(DUTIES, 'dev');
  assert.equal(reviewStage(card(), census), 'implementing');
  assert.equal(reviewStage(card({ reviews: [] }), census), 'implementing');
  assert.equal(reviewStage(null, census), 'implementing');
});

test('the happy path walks implementing → peer → final → complete', () => {
  const census = dutyCensus(DUTIES, 'dev');
  let t = card();

  t = recordReview(t, { by: 'dev', duty: 'developer', verdict: 'submitted', at: at(1) });
  assert.equal(reviewStage(t, census), 'peer-review');

  t = recordReview(t, { by: 'rev', duty: 'reviewer', verdict: 'approved', at: at(2) });
  assert.equal(reviewStage(t, census), 'final-review');

  t = recordReview(t, { by: 'boss', duty: 'final-reviewer', verdict: 'approved', at: at(3) });
  assert.equal(reviewStage(t, census), 'complete');
});

test('a card that says it is done counts as handed over', () => {
  // The god edits tasks.json with its own file tools, so a card it closes
  // arrives with status 'done' and an empty trail. Reading that as
  // 'implementing' would be self-fulfilling: no reviewer is cued, so the
  // approval the gate waits for could never arrive.
  const census = dutyCensus(DUTIES, 'dev');
  assert.equal(reviewStage(card({ status: 'done' }), census), 'peer-review');
  assert.equal(reviewStage(card({ status: 'doing' }), census), 'implementing');

  let t = card({ status: 'done' });
  t = recordReview(t, { by: 'rev', duty: 'reviewer', verdict: 'approved', at: at(1) });
  assert.equal(reviewStage(t, census), 'final-review');
  t = recordReview(t, { by: 'boss', duty: 'final-reviewer', verdict: 'approved', at: at(2) });
  assert.equal(reviewStage(t, census), 'complete');
});

test('a developer’s approval clears nothing', () => {
  const census = dutyCensus(DUTIES, 'dev');
  let t = recordReview(card(), { by: 'dev', duty: 'developer', verdict: 'submitted', at: at(1) });
  t = recordReview(t, { by: 'other', duty: 'developer', verdict: 'approved', at: at(2) });
  assert.equal(reviewStage(t, census), 'peer-review');
});

test('the assignee cannot approve its own card even holding the reviewer duty', () => {
  // `rev` is the assignee here, so a second reviewer must exist for the stage
  // to be live at all — otherwise the census would skip it.
  const census = dutyCensus({ ...DUTIES, rev2: 'reviewer' }, 'rev');
  let t = card({ assignee: 'rev' });
  t = recordReview(t, { by: 'rev', duty: 'developer', verdict: 'submitted', at: at(1) });
  t = recordReview(t, { by: 'rev', duty: 'reviewer', verdict: 'approved', at: at(2) });
  assert.equal(reviewStage(t, census), 'peer-review', 'self-approval must not clear the peer stage');

  t = recordReview(t, { by: 'rev2', duty: 'reviewer', verdict: 'approved', at: at(3) });
  assert.equal(reviewStage(t, census), 'final-review');
});

test('a final approval cast BEFORE the peer approval does not count', () => {
  // It reviewed work the reviewer had not yet passed. This is the ordering half
  // of "the final sign-off is the last thing that happened".
  const census = dutyCensus(DUTIES, 'dev');
  let t = recordReview(card(), { by: 'dev', duty: 'developer', verdict: 'submitted', at: at(1) });
  t = recordReview(t, { by: 'boss', duty: 'final-reviewer', verdict: 'approved', at: at(2) });
  t = recordReview(t, { by: 'rev', duty: 'reviewer', verdict: 'approved', at: at(3) });
  assert.equal(reviewStage(t, census), 'final-review', 'the final reviewer has to look again');

  t = recordReview(t, { by: 'boss', duty: 'final-reviewer', verdict: 'approved', at: at(4) });
  assert.equal(reviewStage(t, census), 'complete');
});

// ── the rejection loop ──────────────────────────────────────────────────────

test('requesting changes bumps the revision and invalidates the round', () => {
  const census = dutyCensus(DUTIES, 'dev');
  let t = recordReview(card(), { by: 'dev', duty: 'developer', verdict: 'submitted', at: at(1) });
  t = recordReview(t, { by: 'rev', duty: 'reviewer', verdict: 'changes-requested', note: 'no tests', at: at(2) });

  assert.equal(revisionOf(t), 1);
  assert.equal(currentReviews(t).length, 0, 'the new round starts empty');
  assert.equal(t.reviews.length, 2, 'the trail keeps every past entry');
  assert.equal(reviewStage(t, census), 'implementing', 'the card is the developer’s again');
});

test('a final reviewer’s rejection sends the card all the way back to the reviewer', () => {
  // The operator’s exact loop: reject → dev → reviewer → final.
  const census = dutyCensus(DUTIES, 'dev');
  let t = recordReview(card(), { by: 'dev', duty: 'developer', verdict: 'submitted', at: at(1) });
  t = recordReview(t, { by: 'rev', duty: 'reviewer', verdict: 'approved', at: at(2) });
  t = recordReview(t, { by: 'boss', duty: 'final-reviewer', verdict: 'changes-requested', at: at(3) });
  assert.equal(reviewStage(t, census), 'implementing');

  t = recordReview(t, { by: 'dev', duty: 'developer', verdict: 'submitted', at: at(4) });
  assert.equal(reviewStage(t, census), 'peer-review', 'the reviewer must approve again, not be skipped');

  t = recordReview(t, { by: 'rev', duty: 'reviewer', verdict: 'approved', at: at(5) });
  assert.equal(reviewStage(t, census), 'final-review');

  t = recordReview(t, { by: 'boss', duty: 'final-reviewer', verdict: 'approved', at: at(6) });
  assert.equal(reviewStage(t, census), 'complete');
});

test('re-submitting after approvals invalidates them', () => {
  // "Approve it, then quietly change it" must not leave a signed-off card.
  const census = dutyCensus(DUTIES, 'dev');
  let t = recordReview(card(), { by: 'dev', duty: 'developer', verdict: 'submitted', at: at(1) });
  t = recordReview(t, { by: 'rev', duty: 'reviewer', verdict: 'approved', at: at(2) });
  t = recordReview(t, { by: 'boss', duty: 'final-reviewer', verdict: 'approved', at: at(3) });
  assert.equal(reviewStage(t, census), 'complete');

  t = recordReview(t, { by: 'dev', duty: 'developer', verdict: 'submitted', at: at(4) });
  assert.equal(revisionOf(t), 1);
  assert.equal(reviewStage(t, census), 'peer-review', 'both approvals are stale');
});

test('recordReview never mutates the card it is given', () => {
  // Callers hold the RAW on-disk entry with fields this module does not model.
  const original = card({ result: 'a verbatim Slack reply', repo: 'acme/web' });
  const next = recordReview(original, { by: 'dev', duty: 'developer', verdict: 'submitted', at: at(1) });
  assert.equal(original.reviews, undefined);
  assert.equal(next.result, 'a verbatim Slack reply', 'unmodelled fields survive');
  assert.equal(next.repo, 'acme/web');
});

// ── the gate ────────────────────────────────────────────────────────────────

test('a completion request is refused until the trail is complete', () => {
  const census = dutyCensus(DUTIES, 'dev');
  const g = gateTaskTransition(card(), 'done', census, { actor: 'god', at: at(1) });

  assert.equal(g.refused, true);
  assert.equal(g.status, 'doing', 'refused work is in flight, not blocked on a human');
  assert.equal(g.stage, 'peer-review');
  assert.match(g.reason, /reviewer/);
  // Setting `done` IS the claim that the work is finished, so the gate records
  // the handover the god did not spell out.
  assert.equal(currentReviews(g.task).filter((e) => e.verdict === 'submitted').length, 1);
});

test('a completion request passes once a reviewer and a final reviewer approved', () => {
  const census = dutyCensus(DUTIES, 'dev');
  let t = recordReview(card(), { by: 'dev', duty: 'developer', verdict: 'submitted', at: at(1) });
  t = recordReview(t, { by: 'rev', duty: 'reviewer', verdict: 'approved', at: at(2) });
  t = recordReview(t, { by: 'boss', duty: 'final-reviewer', verdict: 'approved', at: at(3) });

  const g = gateTaskTransition(t, 'done', census, { at: at(4) });
  assert.equal(g.refused, false);
  assert.equal(g.status, 'done');
  assert.equal(g.stage, 'complete');
});

test('a hive that never opted in is not gated', () => {
  // The degradation that keeps every pre-existing hive working.
  const census = dutyCensus({ a: 'developer', b: 'developer' }, 'a');
  const g = gateTaskTransition(card({ assignee: 'a' }), 'done', census);
  assert.equal(g.refused, false);
  assert.equal(g.status, 'done');
  assert.equal(g.task.reviews, undefined, 'no implicit submit is invented when nothing is enforced');
});

test('a stage with nobody to clear it is skipped', () => {
  // Reviewers but no final reviewer: the reviewer's approval completes the card.
  const census = dutyCensus({ dev: 'developer', rev: 'reviewer' }, 'dev');
  let t = recordReview(card(), { by: 'dev', duty: 'developer', verdict: 'submitted', at: at(1) });
  assert.equal(reviewStage(t, census), 'peer-review');
  t = recordReview(t, { by: 'rev', duty: 'reviewer', verdict: 'approved', at: at(2) });
  assert.equal(reviewStage(t, census), 'complete');

  // A final reviewer but no reviewer: the final approval alone completes it.
  const onlyFinal = dutyCensus({ dev: 'developer', boss: 'final-reviewer' }, 'dev');
  let u = recordReview(card(), { by: 'dev', duty: 'developer', verdict: 'submitted', at: at(1) });
  assert.equal(reviewStage(u, onlyFinal), 'final-review');
  u = recordReview(u, { by: 'boss', duty: 'final-reviewer', verdict: 'approved', at: at(2) });
  assert.equal(reviewStage(u, onlyFinal), 'complete');
});

test('any one of several final reviewers suffices', () => {
  const census = dutyCensus({ dev: 'developer', rev: 'reviewer', b1: 'final-reviewer', b2: 'final-reviewer' }, 'dev');
  let t = recordReview(card(), { by: 'dev', duty: 'developer', verdict: 'submitted', at: at(1) });
  t = recordReview(t, { by: 'rev', duty: 'reviewer', verdict: 'approved', at: at(2) });
  t = recordReview(t, { by: 'b2', duty: 'final-reviewer', verdict: 'approved', at: at(3) });
  assert.equal(reviewStage(t, census), 'complete', 'unanimity is not required');
});

test('a card already done on disk is never reopened', () => {
  // This feature must not retroactively un-finish work that predates it.
  const census = dutyCensus(DUTIES, 'dev');
  const g = gateTaskTransition(card({ status: 'done' }), 'done', census, { previousStatus: 'done' });
  assert.equal(g.refused, false);
  assert.equal(g.status, 'done');
});

test('the gate only looks at completion attempts', () => {
  const census = dutyCensus(DUTIES, 'dev');
  for (const status of ['todo', 'doing', 'blocked']) {
    const g = gateTaskTransition(card(), status, census);
    assert.equal(g.refused, false, status);
    assert.equal(g.status, status);
  }
});

test('every stage has a reason string', () => {
  for (const stage of ['implementing', 'peer-review', 'final-review', 'complete']) {
    assert.ok(stageReason(stage).length > 5, stage);
  }
});

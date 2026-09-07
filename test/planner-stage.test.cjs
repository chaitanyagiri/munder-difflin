'use strict';

/**
 * The planner, and the one thing about it that is easy to get wrong.
 *
 * A card is planned ONCE. The requirements come from the human, the planner
 * turns them into a detailed plan, and from then on it is the developer's job
 * to satisfy that plan — including every time a reviewer sends the card back.
 *
 * That collides head-on with how the rest of this gate works. Everything else
 * on a card is versioned: `changes-requested` bumps the revision and voids
 * every approval collected in that round, which is exactly what forces the
 * reviewer to look again. Had the plan been an ordinary
 * versioned entry it would have been voided by that same bump, and every single
 * rejection would have routed the card back to the planner — a round trip the
 * operator explicitly ruled out.
 *
 * So `isPlanned` reads the WHOLE trail rather than the current revision, and
 * most of this file is about proving that the exception holds under each of the
 * ways a revision can move.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  dutyCensus,
  censusIsEmpty,
  reviewStage,
  recordReview,
  revisionOf,
  isPlanned,
  gateTaskTransition,
  stageReason,
  PLAN_MAX_CHARS
} = loadTs('src/shared/reviewGate.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const REGIME = '2026-09-01T00:00:00.000Z';
const GOD = 'god-1';
// The full pipeline: pl plans, dev builds, rev reviews — and the reviewer's
// approval closes the card.
const TEAM = { pl: 'planner', dev: 'developer', rev: 'reviewer' };

const card = (extra = {}) => ({ id: 't1', status: 'doing', assignee: 'dev', ...extra });
const at = (n) => `2026-01-${String(n).padStart(2, '0')}T00:00:00.000Z`;

const plan = (t, opts = {}) => recordReview(t, {
  by: opts.by ?? 'pl', duty: opts.duty ?? 'planner', verdict: 'planned',
  plan: opts.plan ?? 'Step 1. Step 2.', at: opts.at ?? at(1)
});
const submit = (t, n) => recordReview(t, { by: 'dev', duty: 'developer', verdict: 'submitted', at: at(n) });
const approve = (t, by, duty, n) => recordReview(t, { by, duty, verdict: 'approved', at: at(n) });
const reject = (t, by, duty, n) => recordReview(t, { by, duty, verdict: 'changes-requested', at: at(n) });

// ── the stage ───────────────────────────────────────────────────────────────

test('a planner on the floor puts planning before everything else', () => {
  const census = dutyCensus(TEAM, 'dev');
  assert.equal(census.hasPlanner, true);
  assert.equal(censusIsEmpty(census), false);

  assert.equal(reviewStage(card(), census), 'planning');
  // Even a card the developer already submitted: no plan was ever written, and
  // saying `peer-review` would hide that the card skipped its first step.
  assert.equal(reviewStage(submit(card(), 2), census), 'planning');
  // And a card the god simply declared done.
  assert.equal(reviewStage(card({ status: 'done' }), census), 'planning');
});

test('a plan clears planning and hands the card to the developer', () => {
  const census = dutyCensus(TEAM, 'dev');
  const t = plan(card());
  assert.equal(isPlanned(t), true);
  assert.equal(reviewStage(t, census), 'implementing');
  assert.equal(t.plan, 'Step 1. Step 2.');
});

test('the whole pipeline: plan → build → review → final → complete', () => {
  const census = dutyCensus(TEAM, 'dev');
  let t = card();
  assert.equal(reviewStage(t, census), 'planning');
  t = plan(t);
  assert.equal(reviewStage(t, census), 'implementing');
  t = submit(t, 2);
  assert.equal(reviewStage(t, census), 'peer-review');
  t = approve(t, 'rev', 'reviewer', 3);
  assert.equal(reviewStage(t, census), 'complete');
});

test('no planner on the floor means cards are simply not planned', () => {
  // The same degradation every other stage gets: nobody to clear it, skip it.
  const census = dutyCensus({ dev: 'developer', rev: 'reviewer' }, 'dev');
  assert.equal(census.hasPlanner, false);
  assert.equal(reviewStage(card(), census), 'implementing');
});

test('a floor with ONLY a planner is still a regime', () => {
  // Planning is a gate in its own right — a card cannot complete unplanned
  // just because nobody reviews on this floor.
  const census = dutyCensus({ pl: 'planner', dev: 'developer' }, 'dev');
  assert.equal(censusIsEmpty(census), false);
  assert.equal(reviewStage(card(), census), 'planning');
  // A plan is not a handover: the developer still has to build it and say so.
  assert.equal(reviewStage(plan(card()), census), 'implementing');
  assert.equal(reviewStage(submit(plan(card()), 2), census), 'complete',
    'planned and handed over is all a floor with no reviewers asks');
});

// ── the exception: the plan outlives every round ────────────────────────────

test('a rejection sends the card to the DEVELOPER, never back to the planner', () => {
  // The requirement, stated directly. A reviewer bounced the work; the plan is
  // untouched and the developer owns the fix.
  const census = dutyCensus(TEAM, 'dev');
  let t = plan(card());
  t = submit(t, 2);
  t = reject(t, 'rev', 'reviewer', 3);

  assert.equal(revisionOf(t), 1, 'the round closed');
  assert.equal(reviewStage(t, census), 'implementing', 'NOT planning');
  assert.equal(isPlanned(t), true, 'the plan is not voided by the bump');
  assert.equal(t.plan, 'Step 1. Step 2.', 'and it is still readable on the card');
});

test('a rejection after an approval does not re-open planning either', () => {
  const census = dutyCensus(TEAM, 'dev');
  let t = plan(card());
  t = submit(t, 2);
  t = approve(t, 'rev', 'reviewer', 3);
  t = reject(t, 'rev', 'reviewer', 4);

  assert.equal(reviewStage(t, census), 'implementing');
  // The approval must be re-earned — that part IS versioned — but the plan is
  // not re-asked.
  t = submit(t, 5);
  assert.equal(reviewStage(t, census), 'peer-review');
  t = approve(t, 'rev', 'reviewer', 6);
  assert.equal(reviewStage(t, census), 'complete');
});

test('the plan survives many rounds', () => {
  const census = dutyCensus(TEAM, 'dev');
  let t = plan(card());
  for (let round = 0; round < 5; round++) {
    t = submit(t, 10 + round);
    assert.equal(reviewStage(t, census), 'peer-review', `round ${round}`);
    t = reject(t, 'rev', 'reviewer', 20 + round);
    assert.equal(reviewStage(t, census), 'implementing', `round ${round}`);
  }
  assert.equal(revisionOf(t), 5);
  assert.equal(isPlanned(t), true);
});

test('re-submitting approved work voids the approval but not the plan', () => {
  const census = dutyCensus(TEAM, 'dev');
  let t = plan(card());
  t = submit(t, 2);
  t = approve(t, 'rev', 'reviewer', 3);
  assert.equal(reviewStage(t, census), 'complete');

  t = submit(t, 4);
  assert.equal(revisionOf(t), 1);
  assert.equal(reviewStage(t, census), 'peer-review', 'the approval is stale');
  assert.equal(isPlanned(t), true, 'the plan is not');
});

// ── who may plan ────────────────────────────────────────────────────────────

test('only a planner’s verdict plans; a developer’s is an opinion', () => {
  const census = dutyCensus(TEAM, 'dev');
  const t = plan(card(), { by: 'dev', duty: 'developer', plan: 'I will wing it' });
  assert.equal(isPlanned(t), false);
  assert.equal(t.plan, undefined, 'and it stores no plan');
  assert.equal(reviewStage(t, census), 'planning');
});

test('the assignee cannot plan its own card', () => {
  // The same loophole as self-approval. A second planner must exist for the
  // stage to be live at all, or the census would skip it.
  const census = dutyCensus({ ...TEAM, pl2: 'planner' }, 'pl');
  let t = card({ assignee: 'pl' });
  t = plan(t, { by: 'pl' });
  assert.equal(isPlanned(t), false);
  assert.equal(reviewStage(t, census), 'planning');

  t = plan(t, { by: 'pl2', at: at(2) });
  assert.equal(isPlanned(t), true);
  assert.equal(reviewStage(t, census), 'implementing');
});

test('a card whose only planner IS the assignee is not deadlocked', () => {
  const census = dutyCensus({ pl: 'planner', rev: 'reviewer' }, 'pl');
  assert.equal(census.hasPlanner, false, 'no eligible planner → the stage is skipped');
  assert.equal(reviewStage(card({ assignee: 'pl' }), census), 'implementing');
});

test('an empty plan body records the verdict but stores nothing', () => {
  const t = plan(card(), { plan: '   ' });
  assert.equal(t.plan, undefined);
  assert.equal(isPlanned(t), true, 'the planner did speak — the card is not stuck at planning');
});

test('a runaway plan is capped', () => {
  const t = plan(card(), { plan: 'x'.repeat(PLAN_MAX_CHARS + 5000) });
  assert.equal(t.plan.length, PLAN_MAX_CHARS);
});

// ── the gate ────────────────────────────────────────────────────────────────

test('an unplanned card cannot be completed, and claiming done is not a plan', () => {
  // The implicit submit exists because "done" IS a claim the work is finished.
  // It says nothing about requirements nobody wrote down.
  const census = dutyCensus(TEAM, 'dev');
  const g = gateTaskTransition(card(), 'done', census, { actor: 'god', at: at(1) });
  assert.equal(g.refused, true);
  assert.equal(g.status, 'doing');
  assert.equal(g.stage, 'planning');
  assert.match(g.reason, /planner/);
  assert.equal(isPlanned(g.task), false);
});

test('stageReason covers planning', () => {
  assert.match(stageReason('planning'), /planner/);
});

// ── over the wire ───────────────────────────────────────────────────────────

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-planner-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { hive: new HiveManager(() => home), root: path.join(home, 'hive') };
}

function seedFloor(root, duties) {
  fs.mkdirSync(root, { recursive: true });
  const agents = { [GOD]: { id: GOD, name: GOD, cwd: root, duty: 'unassigned', status: 'idle', lastSeen: Date.now(), isGod: true } };
  fs.mkdirSync(path.join(root, 'agents', GOD, 'inbox', '.done'), { recursive: true });
  fs.mkdirSync(path.join(root, 'agents', GOD, 'outbox', '.sent'), { recursive: true });
  for (const [id, duty] of Object.entries(duties)) {
    agents[id] = { id, name: id, cwd: root, duty, status: 'idle', lastSeen: Date.now() };
    fs.mkdirSync(path.join(root, 'agents', id, 'inbox', '.done'), { recursive: true });
    fs.mkdirSync(path.join(root, 'agents', id, 'outbox', '.sent'), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'registry.json'),
    JSON.stringify({ godId: GOD, agents, dutyRegimeSince: REGIME }, null, 2));
}

function post(root, from, msg) {
  fs.writeFileSync(
    path.join(root, 'agents', from, 'outbox', `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`),
    JSON.stringify(msg));
}

function inbox(root, id) {
  const dir = path.join(root, 'agents', id, 'inbox');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

function onDisk(root, id) {
  return JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8')).tasks.find((c) => c.id === id);
}

const hiveCard = (id) => ({ id, title: `Card ${id}`, status: 'doing', assignee: 'dev',
  dependsOn: [], priority: 3, createdAt: '2026-09-02T00:00:00.000Z' });

test('a planner delivers the plan as a message body, stored in full on the card', (t) => {
  const { hive, root } = floor(t);
  hive.writeTasks([]);
  seedFloor(root, TEAM);
  hive.writeTasks([hiveCard('c1')]);
  assert.equal(hive.taskStage('c1'), 'planning');

  const body = ['## Plan', '', '1. Touch `src/a.ts`', '2. Add a test', '', 'Out of scope: the UI.'].join('\n');
  post(root, 'pl', { to: 'god', act: 'inform', subject: 'plan for c1', body,
    review: { task: 'c1', verdict: 'planned' } });
  hive.routeOnce();

  assert.equal(hive.taskStage('c1'), 'implementing');
  const saved = onDisk(root, 'c1');
  // In full, not truncated to a 500-char review note: this is the deliverable
  // the developer builds from, not a comment about one.
  assert.equal(saved.plan, body);
  assert.equal(saved.reviews[0].verdict, 'planned');
  assert.equal(saved.reviews[0].duty, 'planner');
  assert.equal(saved.reviews[0].note, undefined);

  const mail = inbox(root, GOD);
  assert.equal(mail.length, 1);
  assert.match(mail[0].body, /The plan is on the card. Hand it to a developer: dev/);
});

test('god is told a bounced card goes back to the developer, not the planner', (t) => {
  const { hive, root } = floor(t);
  hive.writeTasks([]);
  seedFloor(root, TEAM);
  hive.writeTasks([hiveCard('c1')]);

  post(root, 'pl', { to: 'god', act: 'inform', subject: 'plan', body: 'do the thing',
    review: { task: 'c1', verdict: 'planned' } });
  post(root, 'dev', { to: 'god', act: 'inform', subject: 'ready', body: 'done',
    review: { task: 'c1', verdict: 'submitted' } });
  hive.routeOnce();

  post(root, 'rev', { to: 'god', act: 'inform', subject: 'nope', body: 'missing the null path',
    review: { task: 'c1', verdict: 'changes-requested' } });
  hive.routeOnce();

  const last = inbox(root, GOD).pop();
  assert.match(last.body, /back with its developer \(dev\), working from the same plan/);
  assert.match(last.body, /planner is not involved again/);
  assert.equal(hive.taskStage('c1'), 'implementing');
  assert.equal(onDisk(root, 'c1').plan, 'do the thing', 'still there for the next round');
});

test('appointing a planner starts the regime and tells god new work goes there first', (t) => {
  const { hive, root } = floor(t);
  hive.writeTasks([]);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, 'agents', GOD, 'inbox', '.done'), { recursive: true });
  fs.mkdirSync(path.join(root, 'agents', GOD, 'outbox', '.sent'), { recursive: true });
  fs.mkdirSync(path.join(root, 'agents', 'pam'), { recursive: true });
  fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify({
    godId: GOD,
    agents: {
      [GOD]: { id: GOD, name: GOD, cwd: root, duty: 'unassigned', status: 'idle', lastSeen: Date.now(), isGod: true },
      pam: { id: 'pam', name: 'Pam', cwd: root, duty: 'developer', status: 'idle', lastSeen: Date.now() }
    }
  }, null, 2));

  assert.equal(hive.patchAgentDuty('pam', 'architect').duty, 'planner');

  const reg = JSON.parse(fs.readFileSync(path.join(root, 'registry.json'), 'utf8'));
  assert.ok(reg.dutyRegimeSince, 'a planner is a gating duty like any other');

  const mail = inbox(root, GOD);
  assert.equal(mail.length, 1);
  assert.match(mail[0].body, /New work goes to them FIRST/);
});

test('the planner is briefed in identity.md and in its spawn prompt', async (t) => {
  const { hive, root } = floor(t);
  const home = path.dirname(root);
  const inj = await hive.ensureAgent(
    { id: 'pl', name: 'Planner', provider: 'claude', cwd: home, duty: 'planner' }, {});
  const i = inj.args.findIndex((a) => a === '--append-system-prompt' || a === '--prompt');
  const prompt = inj.args[i + 1];
  assert.match(prompt, /YOUR DUTY — PLANNER/);
  assert.match(prompt, /PLANNER → DEVELOPER → REVIEWER → done/);
  assert.match(prompt, /THE PLAN IS THE EXCEPTION/);

  const identity = fs.readFileSync(path.join(root, 'agents', 'pl', 'identity.md'), 'utf8');
  assert.match(identity, /Duty: planner/);
  assert.match(identity, /"verdict": "planned"/);
});

test('god is told to send new work to a planner before dispatching implementation', async (t) => {
  const { hive, root } = floor(t);
  const inj = await hive.ensureAgent(
    { id: GOD, name: 'Michael', provider: 'claude', cwd: path.dirname(root), isGod: true }, {});
  const i = inj.args.findIndex((a) => a === '--append-system-prompt' || a === '--prompt');
  const prompt = inj.args[i + 1];
  assert.match(prompt, /send NEW work to a planner FIRST/);
  assert.match(prompt, /do not dispatch implementation before the plan exists/);
  assert.match(prompt, /route it to the DEVELOPER, never to the planner/);
});

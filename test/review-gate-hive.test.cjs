'use strict';

/**
 * The review gate as the HiveManager actually applies it, over real files.
 *
 * `reviewGate.test.cjs` covers the rules; this covers the wiring — and in
 * particular the two things that can only be tested against the manager:
 *
 *  1. The READ gate. The god is a Claude process holding Write, and
 *     `hive/tasks.json` is a file: it can put `"status": "done"` on a card with
 *     no review trail and nothing stops the write. What must hold is that
 *     nothing in the app then AGREES the card is done.
 *  2. Grandfathering. Appointing the first reviewer must not drag every card
 *     the hive ever completed back onto the board.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

const REGIME = '2026-09-01T00:00:00.000Z';
const BEFORE_REGIME = '2026-08-01T00:00:00.000Z';
const AFTER_REGIME = '2026-09-02T00:00:00.000Z';

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-review-gate-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { hive: new HiveManager(() => home), home };
}

function card(id, extra = {}) {
  return {
    id,
    title: id,
    status: 'todo',
    dependsOn: [],
    priority: 3,
    createdAt: AFTER_REGIME,
    ...extra
  };
}

/**
 * Register agents with duties by writing `registry.json`, the way the hive is
 * designed to be read — files, not API calls. `ensureAgent` is the real path
 * but it is async and provisions a whole workspace; the gate's only inputs are
 * this file and tasks.json.
 */
function seedRegistry(home, duties, opts = {}) {
  const root = path.join(home, 'hive');
  fs.mkdirSync(root, { recursive: true });
  const agents = {};
  for (const [id, duty] of Object.entries(duties)) {
    agents[id] = {
      id,
      name: id,
      cwd: home,
      duty,
      status: 'idle',
      lastSeen: Date.now(),
      ...(opts.archived?.includes(id) ? { archived: true } : {})
    };
  }
  // `'regimeSince' in opts`, not `?? REGIME`: a test that deliberately passes
  // `regimeSince: undefined` is testing the un-stamped registry, and a `??`
  // default would silently hand it a stamp and pass for the wrong reason.
  const regimeSince = 'regimeSince' in opts ? opts.regimeSince : REGIME;
  fs.writeFileSync(
    path.join(root, 'registry.json'),
    JSON.stringify(
      { godId: null, agents, ...(regimeSince ? { dutyRegimeSince: regimeSince } : {}) },
      null,
      2
    )
  );
}

/** What the app sees — every consumer reads the ledger through `tasks()`. */
function reported(hive) {
  return hive.tasks().tasks;
}

/** What is physically on disk, gate or no gate. */
function onDisk(home) {
  return JSON.parse(fs.readFileSync(path.join(home, 'hive', 'tasks.json'), 'utf8')).tasks;
}

const TEAM = { dev: 'developer', rev: 'reviewer' };

// ── the write gate ──────────────────────────────────────────────────────────

test('writeTasks refuses a done card with no review trail', (t) => {
  const { hive, home } = floor(t);
  hive.writeTasks([]);
  seedRegistry(home, TEAM);

  hive.writeTasks([card('c1', { status: 'done', assignee: 'dev' })]);

  assert.equal(onDisk(home)[0].status, 'doing', 'the refusal is persisted, not just reported');
  // Claiming completion IS the handover, so the gate records the submit the
  // caller did not spell out — otherwise the card would sit at 'implementing'
  // forever and no reviewer would know it was their turn.
  assert.equal(onDisk(home)[0].reviews.length, 1);
  assert.equal(onDisk(home)[0].reviews[0].verdict, 'submitted');
});

test('a card walks the full trail and then completes', (t) => {
  const { hive, home } = floor(t);
  hive.writeTasks([]);
  seedRegistry(home, TEAM);
  hive.writeTasks([card('c1', { status: 'doing', assignee: 'dev' })]);

  assert.equal(hive.recordTaskReview('c1', { by: 'dev', verdict: 'submitted' }).ok, true);
  assert.equal(hive.taskStage('c1'), 'peer-review');

  assert.equal(hive.recordTaskReview('c1', { by: 'rev', verdict: 'approved' }).stage, 'complete');

  assert.equal(hive.patchTask('c1', { status: 'done' }), true);
  assert.equal(reported(hive)[0].status, 'done');
});

test('a verdict cannot claim an authority the registry does not grant', (t) => {
  // An agent that writes `"duty": "reviewer"` into its own verdict must
  // not thereby be able to sign a card off. The duty is read from the registry.
  const { hive, home } = floor(t);
  hive.writeTasks([]);
  seedRegistry(home, TEAM);
  hive.writeTasks([card('c1', { status: 'doing', assignee: 'dev' })]);

  hive.recordTaskReview('c1', { by: 'dev', verdict: 'submitted' });
  const result = hive.recordTaskReview('c1', { by: 'dev', verdict: 'approved' });

  assert.equal(result.duty, 'developer', 'the duty comes from registry.json');
  assert.equal(result.stage, 'peer-review', 'a developer’s approval clears nothing');
  assert.equal(result.advisory, true, 'and the caller is told it was advisory');
});

test('a rejection sends a claimed-done card back to doing', (t) => {
  const { hive, home } = floor(t);
  hive.writeTasks([]);
  seedRegistry(home, TEAM);
  hive.writeTasks([card('c1', { status: 'doing', assignee: 'dev' })]);

  hive.recordTaskReview('c1', { by: 'dev', verdict: 'submitted' });
  hive.recordTaskReview('c1', { by: 'rev', verdict: 'approved' });
  assert.equal(hive.taskStage('c1'), 'complete');

  // The reviewer changes its mind inside the same round: the rejection closes
  // the round, so its own earlier approval goes with it.
  hive.recordTaskReview('c1', { by: 'rev', verdict: 'changes-requested', note: 'no tests' });

  assert.equal(hive.taskStage('c1'), 'implementing', 'back to the developer, approval void');
  assert.equal(onDisk(home)[0].revision, 1);
  assert.equal(onDisk(home)[0].reviews.length, 3, 'the trail keeps its history');
});

test('patchTaskChecked reports the stage a refused card is waiting on', (t) => {
  const { hive, home } = floor(t);
  hive.writeTasks([]);
  seedRegistry(home, TEAM);
  hive.writeTasks([card('c1', { status: 'doing', assignee: 'dev' })]);

  const refused = hive.patchTaskChecked('c1', { status: 'done' });
  assert.equal(refused.ok, true, 'the write happened');
  assert.equal(refused.refused, true, 'the status did not change');
  assert.equal(refused.stage, 'peer-review');
  assert.ok(refused.reason);
});

// ── the read gate: the god's direct file write ──────────────────────────────

test('a done written straight into tasks.json is reported as doing', (t) => {
  const { hive, home } = floor(t);
  hive.writeTasks([card('c1', { status: 'doing', assignee: 'dev' })]);
  seedRegistry(home, TEAM);

  // Exactly what the god does: edit the file. No API, no gate on the way in.
  const raw = onDisk(home);
  raw[0].status = 'done';
  fs.writeFileSync(path.join(home, 'hive', 'tasks.json'), JSON.stringify({ tasks: raw }, null, 2));

  assert.equal(onDisk(home)[0].status, 'done', 'the file says what the god wrote');
  assert.equal(reported(hive)[0].status, 'doing', 'nothing in the app agrees');
  assert.equal(hive.tasks().stages.c1, 'peer-review', 'and it says what is missing');
});

test('the read gate does not persist its correction', (t) => {
  // A read that committed to git would turn every poll into a write.
  const { hive, home } = floor(t);
  hive.writeTasks([card('c1', { status: 'done', assignee: 'dev', reviews: [] })]);
  seedRegistry(home, TEAM);

  assert.equal(reported(hive)[0].status, 'doing');
  assert.equal(onDisk(home)[0].status, 'done', 'the file is untouched by a read');
});

test('the approval that completes the trail restores a god-claimed done', (t) => {
  // The god marked it done, the gate reported 'doing' for want of the final
  // approval. When that approval lands the card is finished — the god must not
  // have to come back and claim it a second time.
  const { hive, home } = floor(t);
  hive.writeTasks([card('c1', { status: 'doing', assignee: 'dev' })]);
  seedRegistry(home, TEAM);

  hive.recordTaskReview('c1', { by: 'dev', verdict: 'submitted' });

  const raw = onDisk(home);
  raw[0].status = 'done';
  fs.writeFileSync(path.join(home, 'hive', 'tasks.json'), JSON.stringify({ tasks: raw }, null, 2));
  assert.equal(reported(hive)[0].status, 'doing', 'still refused: no approval yet');

  hive.recordTaskReview('c1', { by: 'rev', verdict: 'approved' });
  assert.equal(reported(hive)[0].status, 'done');
  assert.equal(onDisk(home)[0].status, 'done');
});

// ── degradations that keep existing hives working ───────────────────────────

test('a hive with no reviewing duty is not gated at all', (t) => {
  const { hive, home } = floor(t);
  hive.writeTasks([]);
  seedRegistry(home, { a: 'developer', b: 'developer' }, { regimeSince: undefined });

  hive.writeTasks([card('c1', { status: 'done', assignee: 'a' })]);
  assert.equal(onDisk(home)[0].status, 'done');
  assert.equal(reported(hive)[0].status, 'done');
  assert.equal(onDisk(home)[0].reviews, undefined, 'no trail is invented');
});

test('cards finished before the first reviewer arrived stay finished', (t) => {
  const { hive, home } = floor(t);
  hive.writeTasks([
    card('old', { status: 'done', assignee: 'dev', createdAt: BEFORE_REGIME }),
    card('new', { status: 'done', assignee: 'dev', createdAt: AFTER_REGIME })
  ]);
  seedRegistry(home, TEAM);

  const byId = Object.fromEntries(reported(hive).map((c) => [c.id, c.status]));
  assert.equal(byId.old, 'done', 'a card completed under the old rules is not reopened');
  assert.equal(byId.new, 'doing', 'a card created under the regime is gated');
});

test('an archived reviewer does not hold every card hostage', (t) => {
  // Its terminal is closed; an approval from it is never coming.
  const { hive, home } = floor(t);
  hive.writeTasks([]);
  seedRegistry(home, { dev: 'developer', rev: 'reviewer' }, { archived: ['rev'] });

  hive.writeTasks([card('c1', { status: 'done', assignee: 'dev' })]);
  assert.equal(onDisk(home)[0].status, 'done', 'no eligible reviewer → no regime → no gate');
});

test('a card the assignee alone could review is not deadlocked', (t) => {
  // The only reviewer IS the assignee, so its own approval can never count.
  // Waiting for one would strand the card forever.
  const { hive, home } = floor(t);
  hive.writeTasks([]);
  seedRegistry(home, { rev: 'reviewer' });
  hive.writeTasks([card('c1', { status: 'doing', assignee: 'rev' })]);

  hive.recordTaskReview('c1', { by: 'rev', verdict: 'submitted' });
  assert.equal(hive.taskStage('c1'), 'complete',
    'the review stage is skipped for this card, not stuck on an approval that could never count');
});

test('any one of several reviewers can close a card', (t) => {
  const { hive, home } = floor(t);
  hive.writeTasks([]);
  seedRegistry(home, { dev: 'developer', r1: 'reviewer', r2: 'reviewer' });
  hive.writeTasks([card('c1', { status: 'doing', assignee: 'dev' })]);

  hive.recordTaskReview('c1', { by: 'dev', verdict: 'submitted' });
  hive.recordTaskReview('c1', { by: 'r2', verdict: 'approved' });

  assert.equal(hive.taskStage('c1'), 'complete', 'unanimity is not required');
});

// ── the refusal has to be findable ──────────────────────────────────────────

test('a refusal is logged with the stage it is waiting on', (t) => {
  // The god reads log.jsonl. A card that silently un-dones itself with no
  // record is indistinguishable from a failed write.
  const { hive, home } = floor(t);
  hive.writeTasks([]);
  seedRegistry(home, TEAM);
  hive.writeTasks([card('c1', { status: 'done', assignee: 'dev' })]);

  const lines = fs.readFileSync(path.join(home, 'hive', 'log.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const gate = lines.filter((e) => e.kind === 'review-gate');
  assert.equal(gate.length, 1);
  assert.equal(gate[0].taskId, 'c1');
  assert.equal(gate[0].stage, 'peer-review');
  assert.ok(gate[0].reason);
});

// ── duty persistence ────────────────────────────────────────────────────────

test('patchAgentDuty persists to the registry and rewrites identity.md', (t) => {
  const { hive, home } = floor(t);
  hive.writeTasks([]);
  seedRegistry(home, { pam: 'developer' }, { regimeSince: undefined });
  fs.mkdirSync(path.join(home, 'hive', 'agents', 'pam'), { recursive: true });

  // "last-reviewer" was a duty of its own for a while. It is gone: one review
  // is the whole review, so the wording still lands on the duty that closes a
  // card rather than being rejected or filed as unassigned.
  const result = hive.patchAgentDuty('pam', 'last-reviewer');
  assert.equal(result.ok, true);
  assert.equal(result.duty, 'reviewer', 'the retired wording migrates to reviewer');

  const reg = JSON.parse(fs.readFileSync(path.join(home, 'hive', 'registry.json'), 'utf8'));
  assert.equal(reg.agents.pam.duty, 'reviewer');
  assert.ok(reg.dutyRegimeSince, 'the first gating duty starts the regime');

  // identity.md is the one file the agent reads about itself, so the limit has
  // to be in there or it is a rule nobody told the agent about.
  const identity = fs.readFileSync(path.join(home, 'hive', 'agents', 'pam', 'identity.md'), 'utf8');
  assert.match(identity, /Duty: reviewer/);
  assert.match(identity, /do NOT implement/);
});

test('a hand-edited registry with duties gets a regime stamp on the next write', (t) => {
  // registry.json is a file and the god can add `"duty": "reviewer"` to it
  // directly. Such a registry has reviewers and no regime instant, and a
  // missing instant reads as "no regime, grandfather everything" — so the gate
  // would be silently off for the whole hive. The next ledger write repairs it.
  const { hive, home } = floor(t);
  hive.writeTasks([]);
  seedRegistry(home, TEAM, { regimeSince: undefined });

  const before = JSON.parse(fs.readFileSync(path.join(home, 'hive', 'registry.json'), 'utf8'));
  assert.equal(before.dutyRegimeSince, undefined);

  hive.writeTasks([card('old', { status: 'doing', assignee: 'dev' })]);

  const after = JSON.parse(fs.readFileSync(path.join(home, 'hive', 'registry.json'), 'utf8'));
  assert.ok(after.dutyRegimeSince, 'the write path stamps the regime it found');

  // The stamp is "now", so only a card created after it is gated — a fixed past
  // `createdAt` would be grandfathered, and correctly so.
  hive.writeTasks([
    card('old', { status: 'doing', assignee: 'dev' }),
    card('fresh', { status: 'done', assignee: 'dev', createdAt: new Date().toISOString() })
  ]);

  const byId = Object.fromEntries(onDisk(home).map((c) => [c.id, c.status]));
  assert.equal(byId.fresh, 'doing', 'the repaired stamp makes the gate apply');
});

test('a card that predates a backfilled stamp is still grandfathered', (t) => {
  // The stamp is taken as "now", never back-dated: cards already on the board
  // were written under no regime and must not be dragged into it.
  const { hive, home } = floor(t);
  hive.writeTasks([card('old', { status: 'doing', assignee: 'dev', createdAt: BEFORE_REGIME })]);
  seedRegistry(home, TEAM, { regimeSince: undefined });

  hive.writeTasks([card('old', { status: 'done', assignee: 'dev', createdAt: BEFORE_REGIME })]);
  assert.equal(onDisk(home)[0].status, 'done');
});

test('the regime instant is stamped once and never moved', (t) => {
  const { hive, home } = floor(t);
  hive.writeTasks([]);
  seedRegistry(home, { pam: 'developer', jim: 'developer' }, { regimeSince: undefined });
  for (const id of ['pam', 'jim']) {
    fs.mkdirSync(path.join(home, 'hive', 'agents', id), { recursive: true });
  }

  hive.patchAgentDuty('pam', 'reviewer');
  const first = JSON.parse(fs.readFileSync(path.join(home, 'hive', 'registry.json'), 'utf8')).dutyRegimeSince;
  hive.patchAgentDuty('jim', 'reviewer');
  const second = JSON.parse(fs.readFileSync(path.join(home, 'hive', 'registry.json'), 'utf8')).dutyRegimeSince;

  // Moving it forward would re-grandfather every card completed in between.
  assert.equal(second, first);
});

test('assigning a duty is not enough to gate a card created before it', (t) => {
  const { hive, home } = floor(t);
  hive.writeTasks([]);
  seedRegistry(home, { dev: 'developer', rev: 'reviewer' }, { regimeSince: undefined });
  fs.mkdirSync(path.join(home, 'hive', 'agents', 'rev'), { recursive: true });

  // A card that exists before anyone is appointed.
  hive.writeTasks([card('legacy', { status: 'doing', assignee: 'dev', createdAt: BEFORE_REGIME })]);
  hive.patchAgentDuty('rev', 'reviewer');

  hive.writeTasks([card('legacy', { status: 'done', assignee: 'dev', createdAt: BEFORE_REGIME })]);
  assert.equal(reported(hive)[0].status, 'done');
});

// ── the developer gap ───────────────────────────────────────────────────────
//
// The gate's degradations skip every stage nobody can clear, which is what
// keeps a hive workable without a full cast. Implementing is the one stage
// that cannot degrade away: the moment a gating duty exists, cards need an
// implementer, and "no planner / no reviewer" is fine
// while "no developer AND no unassigned agent" is a floor that stalls forever.
// The harness tells god — once per episode — instead of deadlocking silently.

const GOD = 'michael';

/** A floor with a god who can receive mail, plus agents with the given
 *  duties. God starts unassigned (an implementer), so each test flips only
 *  what it needs to create or close the gap. */
function seedDutyFloor(home, duties) {
  const root = path.join(home, 'hive');
  fs.mkdirSync(path.join(root, 'agents', GOD, 'inbox', '.done'), { recursive: true });
  fs.mkdirSync(path.join(root, 'agents', GOD, 'outbox', '.sent'), { recursive: true });
  const agents = {
    [GOD]: { id: GOD, name: GOD, cwd: home, duty: 'unassigned', status: 'idle', lastSeen: Date.now(), isGod: true }
  };
  for (const [id, duty] of Object.entries(duties)) {
    agents[id] = { id, name: id, cwd: home, duty, status: 'idle', lastSeen: Date.now() };
    fs.mkdirSync(path.join(root, 'agents', id), { recursive: true });
  }
  fs.writeFileSync(
    path.join(root, 'registry.json'),
    JSON.stringify({ godId: GOD, agents, dutyRegimeSince: REGIME }, null, 2)
  );
}

function godInbox(home) {
  const dir = path.join(home, 'hive', 'agents', GOD, 'inbox');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

function gapMails(home) {
  return godInbox(home).filter((m) => /No developer on the floor/.test(m.subject ?? ''));
}

test('a regime with nobody who implements mails god to get one', (t) => {
  const { hive, home } = floor(t);
  hive.writeTasks([]);
  seedDutyFloor(home, { pl: 'planner' });

  // God reviews, the planner plans — gating duties exist, and nobody may
  // implement. The mix is workable per stage (both stages would degrade) but
  // the floor as a whole is stuck, so god has to hear about it.
  hive.patchAgentDuty(GOD, 'reviewer');

  const mails = gapMails(home);
  assert.equal(mails.length, 1, 'one mail per episode, not one per sweep');
  assert.match(mails[0].body, /"duty": "developer"/);
  assert.match(mails[0].body, /spawn-requests/);
  assert.match(mails[0].body, /unassigned agents implement/);
});

test('an unassigned agent still counts as somebody who implements', (t) => {
  // "Unassigned" is the pre-duty state and behaves like a developer; a legacy
  // hive that appoints its first reviewer must not be told it is broken.
  const { hive, home } = floor(t);
  hive.writeTasks([]);
  seedDutyFloor(home, { pl: 'planner' });

  assert.equal(hive.patchAgentDuty('pl', 'reviewer').ok, true);

  assert.equal(gapMails(home).length, 0);
});

test('a floor that still has an implementer is not a gap', (t) => {
  const { hive, home } = floor(t);
  hive.writeTasks([]);
  seedDutyFloor(home, { pam: 'developer', jim: 'developer' });

  hive.patchAgentDuty('pam', 'reviewer');

  // God is unassigned, pam now reviews, jim implements: the regime is real,
  // and the implementing stage has somebody to clear it — nothing to escalate.
  assert.equal(gapMails(home).length, 0);
});

test('the gap re-announces when it closes and reopens', (t) => {
  const { hive, home } = floor(t);
  hive.writeTasks([]);
  seedDutyFloor(home, { pl: 'planner' });

  hive.patchAgentDuty(GOD, 'reviewer');   // gap opens → mail
  hive.patchAgentDuty(GOD, 'developer');  // gap closes → latch resets
  hive.patchAgentDuty(GOD, 'reviewer');   // gap again → mail again

  assert.equal(gapMails(home).length, 2, 'once per EPISODE, not once forever');
});

test('the sweep notices when the floor loses its only implementer', (t) => {
  // Archiving a developer is a lifecycle event, not a duty change — the sweep
  // is the path that sees it.
  const { hive, home } = floor(t);
  hive.writeTasks([]);
  seedDutyFloor(home, { pl: 'planner', dev: 'developer' });
  const root = path.join(home, 'hive');
  fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify({
    godId: GOD,
    dutyRegimeSince: REGIME,
    agents: {
      [GOD]: { id: GOD, name: GOD, cwd: home, duty: 'reviewer', status: 'idle', lastSeen: Date.now(), isGod: true },
      pl: { id: 'pl', name: 'pl', cwd: home, duty: 'planner', status: 'idle', lastSeen: Date.now() },
      dev: { id: 'dev', name: 'dev', cwd: home, duty: 'developer', status: 'idle', lastSeen: Date.now(), archived: true }
    }
  }, null, 2));

  hive.sweepReviewGate();

  assert.equal(gapMails(home).length, 1);
});

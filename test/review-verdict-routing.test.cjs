'use strict';

/**
 * How a verdict actually travels, and how god finds out.
 *
 * `review-gate-hive.test.cjs` proves the gate holds; this proves the workflow
 * can be DRIVEN by the agents without breaking the hive's single-writer rule:
 *
 *  1. A verdict is a message. An agent writes one JSON into its own outbox with
 *     a `review` field; the router records it under the duty the REGISTRY gives
 *     the sender — the sender being whoever's outbox the file came from, never
 *     what the file claims.
 *  2. god hears of every recorded verdict, with the card's new stage and who
 *     can clear it — because god is the router and a stage nobody routes is a
 *     card that waits for the next heartbeat.
 *  3. The sweep tells god about a card he closed by hand that the gate holds
 *     open, once per stage per round.
 *  4. The rule reaches every agent that needs it — including a god who booted
 *     before any reviewer existed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { parseReviewPayload, eligibleFor } = loadTs('src/shared/reviewGate.ts');

const REGIME = '2026-09-01T00:00:00.000Z';
const GOD = 'god-1';
const TEAM = { [GOD]: 'unassigned', dev: 'developer', rev: 'reviewer', boss: 'final-reviewer' };

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-verdict-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { hive: new HiveManager(() => home), home, root: path.join(home, 'hive') };
}

/** Registry + the per-agent mailboxes the router delivers into. */
function seedFloor(root, duties, opts = {}) {
  fs.mkdirSync(root, { recursive: true });
  const agents = {};
  for (const [id, duty] of Object.entries(duties)) {
    agents[id] = { id, name: id, cwd: root, duty, status: 'idle', lastSeen: Date.now(), ...(id === GOD ? { isGod: true } : {}) };
    fs.mkdirSync(path.join(root, 'agents', id, 'inbox', '.done'), { recursive: true });
    fs.mkdirSync(path.join(root, 'agents', id, 'outbox', '.sent'), { recursive: true });
  }
  const regimeSince = 'regimeSince' in opts ? opts.regimeSince : REGIME;
  fs.writeFileSync(
    path.join(root, 'registry.json'),
    JSON.stringify({ godId: GOD, agents, ...(regimeSince ? { dutyRegimeSince: regimeSince } : {}) }, null, 2)
  );
}

function card(id, extra = {}) {
  return { id, title: `Card ${id}`, status: 'doing', assignee: 'dev', dependsOn: [], priority: 3,
    createdAt: '2026-09-02T00:00:00.000Z', ...extra };
}

/** Exactly what an agent does: one JSON file in its own outbox. */
function post(root, from, msg) {
  const file = path.join(root, 'agents', from, 'outbox', `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(file, JSON.stringify(msg));
}

function inbox(root, id) {
  const dir = path.join(root, 'agents', id, 'inbox');
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

function onDisk(root, id) {
  return JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8')).tasks.find((c) => c.id === id);
}

// ── the payload ─────────────────────────────────────────────────────────────

test('a review payload is validated, never defaulted', () => {
  assert.deepEqual(parseReviewPayload({ task: 'c1', verdict: 'approved' }), { task: 'c1', verdict: 'approved' });
  assert.deepEqual(parseReviewPayload({ task: ' c1 ', verdict: 'Changes Requested' }), { task: 'c1', verdict: 'changes-requested' });
  // A malformed verdict must not become a silently recorded `submitted`.
  for (const bad of [undefined, null, 'approved', {}, { task: 'c1' }, { task: 'c1', verdict: 'lgtm' }, { task: '', verdict: 'approved' }]) {
    assert.equal(parseReviewPayload(bad), null, JSON.stringify(bad));
  }
});

test('eligibleFor names who can clear the current stage, minus the assignee', () => {
  const duties = { dev: 'developer', rev: 'reviewer', rev2: 'reviewer', boss: 'final-reviewer' };
  assert.deepEqual(eligibleFor('peer-review', duties, 'dev').sort(), ['rev', 'rev2']);
  assert.deepEqual(eligibleFor('final-review', duties, 'dev'), ['boss']);
  assert.deepEqual(eligibleFor('peer-review', duties, 'rev'), ['rev2'], 'the assignee cannot clear its own card');
  assert.deepEqual(eligibleFor('implementing', duties, 'dev'), []);
  assert.deepEqual(eligibleFor('complete', duties, 'dev'), []);
});

// ── verdicts travel as messages ─────────────────────────────────────────────

test('the whole workflow runs on outbox messages alone, and nobody writes tasks.json', (t) => {
  const { hive, root } = floor(t);
  hive.writeTasks([]);
  seedFloor(root, TEAM);
  hive.writeTasks([card('c1')]);

  post(root, 'dev', { to: 'god', act: 'inform', subject: 'ready', body: 'implemented, tests green',
    review: { task: 'c1', verdict: 'submitted' } });
  hive.routeOnce();
  assert.equal(hive.taskStage('c1'), 'peer-review');
  assert.equal(onDisk(root, 'c1').reviews[0].by, 'dev');

  post(root, 'rev', { to: 'god', act: 'inform', subject: 'review c1', body: 'read it, ran it, fine',
    review: { task: 'c1', verdict: 'approved' } });
  hive.routeOnce();
  assert.equal(hive.taskStage('c1'), 'final-review');
  assert.equal(onDisk(root, 'c1').reviews[1].duty, 'reviewer', 'the duty comes from the registry');

  post(root, 'boss', { to: 'god', act: 'inform', subject: 'final c1', body: 'agreed',
    review: { task: 'c1', verdict: 'approved' } });
  hive.routeOnce();
  assert.equal(hive.taskStage('c1'), 'complete');

  assert.equal(hive.patchTask('c1', { status: 'done' }), true);
  assert.equal(hive.tasks().tasks[0].status, 'done');
});

test('the sender is the outbox the file came from, not what the file claims', (t) => {
  // A developer writing `"from": "boss"` cannot cast the final reviewer's vote.
  const { hive, root } = floor(t);
  hive.writeTasks([]);
  seedFloor(root, TEAM);
  hive.writeTasks([card('c1', { reviews: [{ by: 'dev', duty: 'developer', verdict: 'submitted', revision: 0, at: REGIME }] })]);

  post(root, 'dev', { from: 'boss', to: 'god', act: 'inform', subject: 'totally boss', body: 'ship it',
    review: { task: 'c1', verdict: 'approved' } });
  hive.routeOnce();

  const entry = onDisk(root, 'c1').reviews[1];
  assert.equal(entry.by, 'dev');
  assert.equal(entry.duty, 'developer');
  assert.equal(hive.taskStage('c1'), 'peer-review', 'a developer’s approval clears nothing, whatever it claims');
});

test('a verdict addressed to god arrives once, with the harness account appended', (t) => {
  const { hive, root } = floor(t);
  hive.writeTasks([]);
  seedFloor(root, TEAM);
  hive.writeTasks([card('c1', { reviews: [{ by: 'dev', duty: 'developer', verdict: 'submitted', revision: 0, at: REGIME }] })]);

  post(root, 'rev', { to: 'god', act: 'inform', subject: 'review c1', body: 'fine',
    review: { task: 'c1', verdict: 'approved' } });
  hive.routeOnce();

  const mail = inbox(root, GOD);
  assert.equal(mail.length, 1, 'the reviewer’s own message, not that plus a system copy');
  assert.equal(mail[0].from, 'rev');
  assert.match(mail[0].body, /\[harness\] Verdict recorded under duty "reviewer"/);
  assert.match(mail[0].body, /Hand it to: boss/);
});

test('a verdict addressed to the developer still reaches god as a system note', (t) => {
  const { hive, root } = floor(t);
  hive.writeTasks([]);
  seedFloor(root, TEAM);
  hive.writeTasks([card('c1', { reviews: [{ by: 'dev', duty: 'developer', verdict: 'submitted', revision: 0, at: REGIME }] })]);

  post(root, 'rev', { to: 'dev', act: 'request', subject: 'needs tests', body: 'no coverage for the null path',
    review: { task: 'c1', verdict: 'changes-requested' } });
  hive.routeOnce();

  assert.equal(inbox(root, 'dev').length, 1, 'the developer gets the reviewer’s message');
  const god = inbox(root, GOD);
  assert.equal(god.length, 1);
  assert.equal(god[0].from, 'system');
  assert.match(god[0].subject, /^Review: changes-requested by rev/);
  assert.match(god[0].body, /back with its developer \(dev\)/);
  assert.equal(hive.taskStage('c1'), 'implementing');
});

test('a verdict on an unknown card is stamped onto the subject, not lost', (t) => {
  const { hive, root } = floor(t);
  hive.writeTasks([]);
  seedFloor(root, TEAM);

  post(root, 'rev', { to: 'god', act: 'inform', subject: 'review', body: 'ok',
    review: { task: 'nope', verdict: 'approved' } });
  hive.routeOnce();

  const mail = inbox(root, GOD);
  assert.equal(mail.length, 1);
  assert.match(mail[0].subject, /^\[review NOT recorded — unknown task; task "nope"\]/);
});

test('the IPC path mails god too', (t) => {
  // A verdict recorded from the renderer is routed the same way as one from an
  // outbox — god must not learn about cards differently depending on the door.
  const { hive, root } = floor(t);
  hive.writeTasks([]);
  seedFloor(root, TEAM);
  hive.writeTasks([card('c1')]);

  const result = hive.recordTaskReview('c1', { by: 'dev', verdict: 'submitted' });
  assert.deepEqual(result.eligible, ['rev']);
  const god = inbox(root, GOD);
  assert.equal(god.length, 1);
  assert.match(god[0].subject, /^Review: submitted by dev/);
  assert.match(god[0].body, /Hand it to: rev/);
});

// ── the sweep: god's own direct writes ──────────────────────────────────────

test('a card closed by hand that the gate holds open is announced to god once', (t) => {
  const { hive, root } = floor(t);
  hive.writeTasks([card('c1')]);
  seedFloor(root, TEAM);

  // god's move: edit the file.
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8'));
  raw.tasks[0].status = 'done';
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify(raw, null, 2));

  hive.sweepReviewGate();
  hive.sweepReviewGate();

  const god = inbox(root, GOD);
  assert.equal(god.length, 1, 'once per card per stage per round, not per sweep');
  assert.match(god[0].subject, /^Review gate: "Card c1" is not done/);
  assert.match(god[0].body, /Hand it to: rev/);
  assert.equal(onDisk(root, 'c1').status, 'done', 'the sweep never rewrites the file');
});

test('the sweep is quiet on a floor with no reviewing duty', (t) => {
  const { hive, root } = floor(t);
  hive.writeTasks([card('c1', { status: 'done' })]);
  seedFloor(root, { [GOD]: 'unassigned', dev: 'developer' }, { regimeSince: undefined });
  hive.sweepReviewGate();
  assert.equal(inbox(root, GOD).length, 0);
});

// ── god learns about duties ─────────────────────────────────────────────────

test('a duty change is mailed to god', (t) => {
  const { hive, root } = floor(t);
  hive.writeTasks([]);
  seedFloor(root, { [GOD]: 'unassigned', pam: 'developer' }, { regimeSince: undefined });

  assert.equal(hive.patchAgentDuty('pam', 'reviewer').ok, true);
  const god = inbox(root, GOD);
  assert.equal(god.length, 1);
  assert.match(god[0].subject, /^Duty change: pam is now reviewer/);
  assert.match(god[0].body, /Route the cards that are waiting/);
});

test('the LIVE ROSTER carries each agent’s duty', (t) => {
  const { hive, root } = floor(t);
  hive.writeTasks([]);
  seedFloor(root, TEAM);
  fs.writeFileSync(path.join(root, 'fleet.json'), JSON.stringify({ ts: Date.now(), agents: [
    { id: 'rev', name: 'Pam', role: 'reviews things', duty: 'reviewer', lastActiveSecAgo: 10 },
    { id: 'dev', name: 'Jim', role: 'builds things', duty: 'developer', lastActiveSecAgo: 5 },
    { id: 'x', name: 'Legacy', role: 'agent', duty: 'unassigned', lastActiveSecAgo: 5 }
  ] }));

  const line = hive.rosterContext();
  assert.match(line, /rev "Pam" \(reviews things, DUTY: reviewer,/);
  assert.match(line, /dev "Jim" \(builds things, DUTY: developer,/);
  assert.doesNotMatch(line, /DUTY: unassigned/, 'an unassigned agent gets no tag');
  assert.match(line, /`DUTY:` = what the agent may do in the review workflow/);
});

// ── the rule reaches the agents that need it ────────────────────────────────

function promptOf(inj) {
  const i = inj.args.findIndex((a) => a === '--append-system-prompt' || a === '--prompt');
  assert.ok(i >= 0, 'the hive protocol must be on argv');
  return inj.args[i + 1];
}

test('god is told the workflow even when no reviewer exists yet', async (t) => {
  // Michael boots first and is not respawned when a reviewer is hired later —
  // gating his prompt on the floor census meant he never learned the rule.
  const { hive, home } = floor(t);
  const inj = await hive.ensureAgent({ id: GOD, name: 'Michael', provider: 'claude', cwd: home, isGod: true }, {});
  const prompt = promptOf(inj);
  assert.match(prompt, /THE REVIEW WORKFLOW/);
  assert.match(prompt, /You are the router for this/);
  assert.match(prompt, /"review": \{"task":"<card id>"/, 'the message form, not a tasks.json edit');
});

test('a developer gets the workflow and its own briefing; an unassigned worker on an empty floor gets neither', async (t) => {
  const { hive, home } = floor(t);
  const dev = promptOf(await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'claude', cwd: home, duty: 'developer' }, {}));
  assert.match(dev, /YOUR DUTY — DEVELOPER/);
  assert.match(dev, /THE REVIEW WORKFLOW/);
  assert.match(dev, /Do not mark your own work done/);

  const legacy = promptOf(await hive.ensureAgent({ id: 'old', name: 'Old', provider: 'claude', cwd: home }, {}));
  assert.doesNotMatch(legacy, /YOUR DUTY/);
  assert.doesNotMatch(legacy, /THE REVIEW WORKFLOW/);
});

test('identity.md tells a reviewer the verdict is a message', async (t) => {
  const { hive, home } = floor(t);
  await hive.ensureAgent({ id: 'pam', name: 'Pam', provider: 'claude', cwd: home, duty: 'reviewer' }, {});
  const identity = fs.readFileSync(path.join(home, 'hive', 'agents', 'pam', 'identity.md'), 'utf8');
  assert.match(identity, /Duty: reviewer/);
  assert.match(identity, /"review": \{"task": "<card id>"/);
  assert.doesNotMatch(identity, /append to the reviews array/i);
});

// ── wiring ──────────────────────────────────────────────────────────────────

test('god can hire a reviewer through the spawn queue', () => {
  const root = path.resolve(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
  assert.match(main, /duty\?: string;/, 'SpawnRequest accepts a duty');
  assert.match(main, /normalizeDuty\(raw\.duty\)/, 'and canonicalises it');
  const hive = fs.readFileSync(path.join(root, 'src/main/hive.ts'), 'utf8');
  assert.match(hive, /\\`duty\\` \(developer \| reviewer \| final-reviewer/, 'and god is told the field exists');
});

test('the duty picker is a dropdown rendered from the shared duty set', () => {
  const root = path.resolve(__dirname, '..');
  const picker = fs.readFileSync(path.join(root, 'src/renderer/src/components/DutyPicker.tsx'), 'utf8');
  assert.match(picker, /<select/);
  assert.match(picker, /AGENT_DUTIES\.map/);
});

test('the kanban reads the stage beside the cards, never off them', () => {
  const root = path.resolve(__dirname, '..');
  const kanban = fs.readFileSync(path.join(root, 'src/renderer/src/components/TasksKanban.tsx'), 'utf8');
  assert.match(kanban, /export function parseStages/);
  assert.match(kanban, /kanban\.stage\./, 'the stage chip is rendered');
  assert.match(kanban, /kanban\.reviews/, 'the trail is rendered');
  const overlay = fs.readFileSync(path.join(root, 'src/renderer/src/components/TaskDetailOverlay.tsx'), 'utf8');
  assert.match(overlay, /parseStages\(raw\)/);
});

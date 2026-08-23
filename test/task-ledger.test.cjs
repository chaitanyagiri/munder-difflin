'use strict';

/**
 * Data-loss guarantee for hive/tasks.json.
 *
 * The ledger is hand-written by the god and carries whatever fields a card
 * needs — `result` (the verbatim Slack reply posted back to the user), `repo`,
 * `origin`, `commit`, string priorities, a `deps` key instead of `dependsOn`.
 * Every UI surface that writes the ledger back holds only a PARTIAL model of a
 * card, and `hive:writeTasks` replaced the file wholesale, so one edit through
 * the UI stripped every unmodelled field from EVERY card on the board.
 *
 * Two legs, and both are needed — the merge alone does not fix a normalized
 * write, because a coerced value is a real value and wins the merge:
 *   - mergeTaskLedger  : a field the writer never mentioned keeps its disk value
 *   - patchTaskInLedger: the writer never emits a coerced value in the first place
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { mergeTaskLedger, patchTaskInLedger } = loadTs('src/shared/taskLedger.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

/** A card as the god actually writes one — most of it outside any UI model. */
const richCard = () => ({
  id: 'vxr-onboarding-review',
  title: 'Review the onboarding doc',
  status: 'blocked',
  deps: ['vxr-intake'],
  priority: 'high',
  createdAt: '2026-08-14T09:00:00.000Z',
  repo: 'vxretail-migration',
  origin: 'slack',
  scope: 'docs/onboarding/**',
  deliverable: 'a reviewed doc + summary',
  commit: 'a1b2c3d',
  result: 'Reviewed. Three gaps found — posted verbatim to the Slack thread.',
  humanQA: [{ q: 'Which branch should I read?', askedAt: '2026-08-14T09:05:00.000Z' }]
});

// ── mergeTaskLedger ──────────────────────────────────────────────────────────

test('a field the writer never mentioned survives the write', () => {
  const disk = [richCard()];
  // What the ASK ME view sends: the same card with its question answered.
  const incoming = [{
    id: 'vxr-onboarding-review',
    title: 'Review the onboarding doc',
    status: 'blocked',
    humanQA: [{ q: 'Which branch should I read?', a: 'main', answeredAt: '2026-08-16T10:00:00.000Z' }]
  }];

  const [merged] = mergeTaskLedger(disk, incoming);

  assert.equal(merged.result, 'Reviewed. Three gaps found — posted verbatim to the Slack thread.');
  assert.equal(merged.repo, 'vxretail-migration');
  assert.equal(merged.origin, 'slack');
  assert.equal(merged.scope, 'docs/onboarding/**');
  assert.equal(merged.deliverable, 'a reviewed doc + summary');
  assert.equal(merged.commit, 'a1b2c3d');
  assert.deepEqual(merged.deps, ['vxr-intake']);
  assert.equal(merged.humanQA[0].a, 'main', 'the field the writer DID send must win');
});

test('deleting a card still deletes it — merging protects fields, not membership', () => {
  const disk = [richCard(), { id: 'other', title: 'Other', status: 'todo' }];

  assert.deepEqual(
    mergeTaskLedger(disk, [{ id: 'other', title: 'Other', status: 'todo' }]).map((t) => t.id),
    ['other'],
    'a card dropped from the incoming list is gone'
  );
  assert.deepEqual(mergeTaskLedger(disk, []), [], 'clearing the board still clears it');
});

test('an explicit null clears a field — a missing key never does', () => {
  const disk = [{ id: 'a', title: 'A', status: 'blocked', blockedOn: 'the human' }];

  assert.equal(mergeTaskLedger(disk, [{ id: 'a', blockedOn: null }])[0].blockedOn, null);
  assert.equal(mergeTaskLedger(disk, [{ id: 'a', status: 'doing' }])[0].blockedOn, 'the human',
    'not mentioning a field means "I do not model it", never "remove it"');
});

test('a card the god wrote without an id passes through instead of being dropped', () => {
  const incoming = [{ title: 'no id here', status: 'todo' }];
  assert.deepEqual(mergeTaskLedger([], incoming), incoming);
});

test('a brand new card is added untouched', () => {
  const fresh = { id: 'new', title: 'New', status: 'todo', slack: { channel: 'C1', thread_ts: '1.2' } };
  const out = mergeTaskLedger([richCard()], [richCard(), fresh]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[1], fresh);
});

// ── patchTaskInLedger ────────────────────────────────────────────────────────

test('moving a card does not normalize the rest of it', () => {
  // The corruption the merge CANNOT catch: parseTasks coerces `priority: "high"`
  // to the number 3 and emits `dependsOn: []` for a card that spells it `deps`.
  // Those are real values, so they beat the merge. Patching the raw entry is
  // what stops them from ever being produced.
  const [moved] = patchTaskInLedger([richCard()], 'vxr-onboarding-review', { status: 'done' });

  assert.equal(moved.status, 'done');
  assert.equal(moved.priority, 'high', 'a string priority must not be coerced to a number');
  assert.deepEqual(moved.deps, ['vxr-intake']);
  assert.equal(moved.dependsOn, undefined, 'no phantom dependsOn grafted on');
  assert.equal(moved.result, 'Reviewed. Three gaps found — posted verbatim to the Slack thread.');
});

test('patching one card leaves its neighbours byte-identical', () => {
  const neighbour = richCard();
  neighbour.id = 'neighbour';
  const out = patchTaskInLedger([richCard(), neighbour], 'vxr-onboarding-review', { status: 'done' });
  assert.deepEqual(out[1], neighbour);
});

// ── end to end through the real persistence path ─────────────────────────────

test('answering a question through hive.writeTasks preserves the whole board', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-task-ledger-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  const ledger = () => JSON.parse(fs.readFileSync(path.join(home, 'hive', 'tasks.json'), 'utf8')).tasks;

  const second = richCard();
  second.id = 'hive-delivery-pump-down';
  second.result = 'Root-caused and fixed; replied in thread.';
  hive.writeTasks([richCard(), second]);

  // The ASK ME view answers the question on the first card, sending the partial
  // model it holds. The second card is sent as the view last read it.
  hive.writeTasks([
    {
      id: 'vxr-onboarding-review',
      title: 'Review the onboarding doc',
      status: 'blocked',
      humanQA: [{ q: 'Which branch should I read?', a: 'main', answeredAt: '2026-08-16T10:00:00.000Z' }]
    },
    { id: 'hive-delivery-pump-down', title: second.title, status: 'blocked' }
  ]);

  const [answered, untouched] = ledger();
  assert.equal(answered.humanQA[0].a, 'main', 'the answer is recorded');
  assert.equal(answered.result, 'Reviewed. Three gaps found — posted verbatim to the Slack thread.',
    'the Slack reply text must survive an answer — this is what was destroyed live');
  assert.equal(answered.commit, 'a1b2c3d');
  assert.equal(answered.priority, 'high');
  assert.equal(untouched.result, 'Root-caused and fixed; replied in thread.',
    'a card nobody edited must not be collateral damage');
  assert.deepEqual(untouched.deps, ['vxr-intake']);
});

test('hive.writeTasks can still empty the ledger', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-task-ledger-del-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  const ledger = () => JSON.parse(fs.readFileSync(path.join(home, 'hive', 'tasks.json'), 'utf8')).tasks;

  hive.writeTasks([richCard(), { id: 'other', title: 'Other', status: 'todo' }]);
  hive.writeTasks([{ id: 'other', title: 'Other', status: 'todo' }]);
  assert.deepEqual(ledger().map((t) => t.id), ['other']);

  hive.writeTasks([]);
  assert.deepEqual(ledger(), []);
});

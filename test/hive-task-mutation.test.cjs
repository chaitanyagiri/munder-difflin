'use strict';

/**
 * Regression for the 2026-08-15 webhook-card loss: ASK ME had read an eight-card
 * ledger, the webhook appended card nine, then ASK ME overwrote tasks.json with
 * its stale eight-card snapshot while recording an answer. Renderer actions must
 * mutate one card against the latest main-process ledger instead of replacing the
 * whole collection they happened to read earlier.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-task-mutate-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return new HiveManager(() => home);
}

function card(id, extra = {}) {
  return {
    id,
    title: id,
    status: 'todo',
    dependsOn: [],
    priority: 3,
    createdAt: '2026-08-15T08:00:00.000Z',
    ...extra
  };
}

function tasks(hive) {
  return hive.tasks().tasks;
}

test('patching a stale UI card preserves a concurrently appended webhook card', (t) => {
  const hive = floor(t);
  const question = card('needs-human', {
    status: 'blocked',
    humanQA: [{ q: 'Which option?', askedAt: '2026-08-15T08:00:00.000Z' }]
  });
  hive.writeTasks([question]);

  // The renderer still holds this one-card snapshot when the webhook arrives.
  const staleQuestion = structuredClone(tasks(hive)[0]);
  const webhook = card('webhook-1', {
    webhook: { tokenHash: 'a'.repeat(64) }
  });
  assert.equal(hive.addTask(webhook), true);

  staleQuestion.humanQA[0].a = 'Option B';
  staleQuestion.humanQA[0].answeredAt = '2026-08-15T08:00:01.000Z';
  assert.equal(hive.patchTask(staleQuestion.id, { humanQA: staleQuestion.humanQA }), true);

  assert.deepEqual(tasks(hive).map((task) => task.id), ['needs-human', 'webhook-1']);
  assert.equal(tasks(hive)[0].humanQA[0].a, 'Option B');
  assert.equal(tasks(hive)[1].webhook.tokenHash, 'a'.repeat(64));
});

test('atomic add is idempotent and delete removes only the named card', (t) => {
  const hive = floor(t);
  hive.writeTasks([card('existing')]);

  assert.equal(hive.addTask(card('new')), true);
  assert.equal(hive.addTask(card('new', { title: 'duplicate' })), false);
  assert.equal(hive.deleteTask('existing'), true);
  assert.equal(hive.deleteTask('missing'), false);

  assert.deepEqual(tasks(hive).map((task) => task.id), ['new']);
  assert.equal(tasks(hive)[0].title, 'new');
});

test('patch refuses an unknown card without rewriting the ledger', (t) => {
  const hive = floor(t);
  hive.writeTasks([card('existing')]);

  assert.equal(hive.patchTask('missing', { status: 'done' }), false);
  assert.deepEqual(tasks(hive), [card('existing')]);
});

// ── the torn-write wipe ─────────────────────────────────────────────────────
// writeJson used to persist tasks.json with a bare writeFileSync and read it
// back through a silent-fallback parse, so a crash mid-persist (or the god's
// mid-write racing a webhook addTask) left an unparsable ledger that the next
// mutation saw as an EMPTY board — and merged its one card over every card it
// could not see. A ledger that exists but cannot be parsed must read as "no
// opinion", never as an empty board (the roster store's rule): refuse the
// write, leave the bytes for recovery, and the last good copy sits in the
// immediately-prior git commit.

test('an unreadable ledger refuses the write instead of wiping the board', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-task-torn-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const tasksPath = path.join(home, 'hive', 'tasks.json');
  const hive = new HiveManager(() => home);

  // A healthy board, persisted exactly as the app leaves it…
  hive.writeTasks([card('slack-triage'), card('needs-human')]);
  const goodBytes = fs.readFileSync(tasksPath, 'utf8');

  // …then the artifact a crash mid-write leaves behind: a torn file.
  const torn = goodBytes.slice(0, Math.floor(goodBytes.length / 2));
  fs.writeFileSync(tasksPath, torn, 'utf8');

  // One inbound-webhook addTask — the designed concurrent writer — must not
  // turn the failed read into a one-card ledger.
  assert.throws(() => hive.addTask(card('webhook-1')), /unreadable/);
  assert.equal(
    fs.readFileSync(tasksPath, 'utf8'), torn,
    'the corrupt bytes must be left untouched — the prior git commit holds the recoverable board'
  );
  assert.equal(hive.patchTask('slack-triage', { status: 'done' }), false,
    'a mutation against a board it cannot see must no-op, not guess');
  assert.equal(hive.deleteTask('slack-triage'), false);

  // Hand corruption behaves the same: refuse, never shrink.
  const handCorrupt = '{"tasks":[{ this is not valid json';
  fs.writeFileSync(tasksPath, handCorrupt, 'utf8');
  assert.throws(() => hive.writeTasks([card('webhook-2')]), /unreadable/);
  assert.equal(fs.readFileSync(tasksPath, 'utf8'), handCorrupt);
});

test('repairing the ledger restores normal mutation', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-task-repair-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const tasksPath = path.join(home, 'hive', 'tasks.json');
  const hive = new HiveManager(() => home);

  hive.writeTasks([card('slack-triage')]);
  const goodBytes = fs.readFileSync(tasksPath, 'utf8');
  fs.writeFileSync(tasksPath, 'not json at all', 'utf8');
  assert.throws(() => hive.addTask(card('webhook-1')), /unreadable/);

  // The operator restores the file (git checkout / hand-fix): the refusal was
  // a guard, not a tombstone.
  fs.writeFileSync(tasksPath, goodBytes, 'utf8');
  hive.writeTasks([card('slack-triage'), card('webhook-1')]);
  assert.deepEqual(tasks(hive).map((task) => task.id), ['slack-triage', 'webhook-1']);
  assert.equal(hive.addTask(card('webhook-1')), false, 'dedupe still works on a healthy ledger');
});

test('renderer task actions never send a whole stale ledger back to main', () => {
  const root = path.resolve(__dirname, '..');
  const preload = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
  const realtimeActions = fs.readFileSync(path.join(root, 'src/main/realtimeActions.ts'), 'utf8');
  const sources = [
    'src/renderer/src/components/AskMeTab.tsx',
    'src/renderer/src/components/TaskDetailOverlay.tsx',
    'src/renderer/src/components/TasksKanban.tsx',
    'src/renderer/src/hooks/useHive.ts'
  ].map((file) => fs.readFileSync(path.join(root, file), 'utf8'));

  for (const source of sources) {
    assert.doesNotMatch(source, /hiveWriteTasks\s*\(/,
      'renderer code must use atomic task IPC rather than overwrite tasks.json');
  }
  assert.doesNotMatch(preload, /hiveWriteTasks\s*:/,
    'the renderer bridge must not expose the unsafe whole-ledger write primitive');
  assert.doesNotMatch(main, /ipcMain\.handle\('hive:writeTasks'/,
    'main must not accept whole-ledger writes from a stale renderer');
  assert.doesNotMatch(realtimeActions, /hiveWriteTasks\s*\(/,
    'voice actions must use atomic task mutations rather than overwrite tasks.json');
  assert.match(realtimeActions, /hiveAddTask\s*\(/);
  assert.match(realtimeActions, /hivePatchTask\s*\(/);
  assert.match(realtimeActions, /hiveDeleteTask\s*\(/);
  assert.match(sources[0], /hivePatchTask\s*\(/);
  assert.match(sources[1], /hivePatchTask\s*\(/);
  assert.match(sources[2], /hiveDeleteTask\s*\(/);
  assert.match(sources[3], /hiveAddTask\s*\(/);
});

test('webhook dispatch appends via atomic addTask, not a stale whole-ledger rewrite', () => {
  const root = path.resolve(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
  const fn = main.slice(main.indexOf('function dispatchWebhookWork'),
    main.indexOf('function handleWebhookMessage'));
  // The card must be appended through hive.addTask(card) — which reads the LATEST
  // on-disk ledger and is idempotent by task id — never through a re-read of a
  // snapshot the caller happened to hold, which would overwrite a concurrently
  // added card (the 2026-08-15 regression this suite guards).
  assert.match(fn, /hive\.addTask\s*\(card\)/,
    'dispatchWebhookWork must add the card via the atomic addTask');
  assert.doesNotMatch(fn, /writeTasks\s*\(\[\s*\.\.\.existing/,
    'dispatchWebhookWork must not rebuild a stale whole-ledger snapshot');
});

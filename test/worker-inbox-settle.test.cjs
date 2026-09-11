'use strict';
// A worker that signaled done is finished with its whole mailbox.
//
// Before this: an ephemeral worker's inbox was left exactly as the worker left
// it when it was released, and workers seldom file their own work order under
// inbox/.done before signaling done. The worker id is `worker-<request name>`,
// reused on every re-hire of the same name, so each new incarnation booted into
// its predecessors' finished orders: the boot nudge told it to "work everything
// still pending", it spent its first turns re-triaging tasks its memory said
// were done, and the inbox-wake watchdog read the oldest order as mail that had
// gone unanswered for 21 hours. Seen live 2026-09-07: 13 of 30 worker inboxes
// on one floor carried finished orders, one of them three deep.
//
// The release path now files whatever is still unread. Only the DONE path does —
// an idle or token-cap reap never signaled completion, so its mail stays pending.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-inbox-settle-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home, () => true);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker-phyllis', name: 'Phyllis', provider: 'claude', cwd: home });
  return { home, hive };
}

const inboxDir = (hive, id) => path.join(hive.root(), 'agents', id, 'inbox');
const jsonFiles = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
const entries = (hive, kind) => hive.logTail(500).filter((e) => e.kind === kind);

test('settling files every unread message under inbox/.done and says how many', async (t) => {
  const { hive } = await floor(t);
  hive.send({ to: 'worker-phyllis', act: 'request', subject: 'Phyllis', body: 'yesterday\'s work order' }, 'god-1');
  hive.send({ to: 'worker-phyllis', act: 'inform', subject: 'IOCs', body: 'anchors from Ryan' }, 'god-1');
  const before = jsonFiles(inboxDir(hive, 'worker-phyllis'));
  assert.equal(before.length, 2, 'both messages are pending before the worker is released');

  assert.equal(hive.settleInbox('worker-phyllis'), 2);

  assert.deepEqual(hive.inbox('worker-phyllis'), [], 'nothing reads as pending any more');
  assert.deepEqual(jsonFiles(path.join(inboxDir(hive, 'worker-phyllis'), '.done')), before,
    'the messages are filed, not deleted — the same files, now under .done');
  const [logged] = entries(hive, 'inbox-settled');
  assert.deepEqual({ agentId: logged.agentId, count: logged.count }, { agentId: 'worker-phyllis', count: 2 },
    'the ledger records the settle so a later reader knows why the inbox is empty');
});

test('a clean inbox settles to zero without touching the ledger; an unknown agent is a no-op', async (t) => {
  const { hive } = await floor(t);
  assert.equal(hive.settleInbox('worker-phyllis'), 0);
  assert.equal(hive.settleInbox('worker-nobody'), 0);
  assert.equal(entries(hive, 'inbox-settled').length, 0);
  // Idempotent: a second settle after a real one finds nothing left.
  hive.send({ to: 'worker-phyllis', act: 'request', subject: 'Phyllis', body: 'order' }, 'god-1');
  assert.equal(hive.settleInbox('worker-phyllis'), 1);
  assert.equal(hive.settleInbox('worker-phyllis'), 0);
});

test('a message already filed under .done is left alone (never re-filed or duplicated)', async (t) => {
  const { hive } = await floor(t);
  hive.send({ to: 'worker-phyllis', act: 'request', subject: 'Phyllis', body: 'order' }, 'god-1');
  const dir = inboxDir(hive, 'worker-phyllis');
  const [f] = jsonFiles(dir);
  fs.renameSync(path.join(dir, f), path.join(dir, '.done', f));
  assert.equal(hive.settleInbox('worker-phyllis'), 0);
  assert.deepEqual(jsonFiles(path.join(dir, '.done')), [f]);
});

// The release path is the only caller, and it must be the DONE branch — pinned
// by reading index.ts as text, since the tick is not importable on its own.
test('the ephemeral-worker tick settles the inbox on the done path, before the kill, and only there', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const done = source.indexOf('signaled done — releasing');
  assert.ok(done > 0, 'the done branch exists');
  const settle = source.indexOf('hive.settleInbox(workerId)', done);
  assert.ok(settle > 0, 'the done branch settles the inbox');
  const kill = source.indexOf('ptyManager.kill(workerId)', done);
  assert.ok(settle < kill, 'the settle happens before the PTY is killed (the worker dir still exists either way, but the order keeps the log readable)');
  assert.equal(source.indexOf('hive.settleInbox', kill), -1, 'neither the token-cap nor the idle reap settles — they never signaled completion');
});

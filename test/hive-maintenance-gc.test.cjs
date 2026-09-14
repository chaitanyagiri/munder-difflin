'use strict';

/**
 * AEON-1493-for-0.5.2 / AEON-1507. Once the hive repo crosses git's gc.auto
 * loose-object threshold, `commit()`'s synchronous git() call (gc.autoDetach
 * =false) runs the resulting repack INLINE, freezing the whole process. The
 * fix keeps the repo packed continuously via a periodic, detached `git gc`
 * fired every N commits — this proves that path actually runs, on cadence,
 * without ever overlapping itself (Pam's non-author review of commit
 * 6dbc814, AEON-1493-for-0.5.2: no test exercised the new branch at all, and
 * nothing guarded against two gcs running at once).
 *
 * Uses the constructor's test-only `maintenanceGcOptions` seam (a small
 * `everyCommits` count + a fake `spawnGc`) instead of real commit volume and
 * a real, timing-dependent `git gc` — deterministic by construction.
 *
 * AEON-1510 update: `commit()` is now async/queued, and — per that patch's
 * own documented trade-off — `git add -A` stages whatever is on disk when
 * ITS queued turn runs, not at call time. Priming a brand-new home (which
 * queues `git init` + the "hive: init" commit) and then immediately calling
 * `writeTasks()` with no `await` between them used to reliably produce TWO
 * separate commits (the old synchronous model guaranteed it); now both are
 * queued in the same synchronous burst and the SECOND write's file lands
 * inside the FIRST (init) commit instead of getting its own — reproduced
 * directly while wiring this file up to the async model, not theorized.
 * `primeHive` below explicitly `flushGit()`s the init commit on its own
 * before any test starts counting, so every `writeOneTask` after that is
 * exactly one real commit, same predictability the old sync tests had.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-maintgc-'));
}

/** A fake ChildProcess: an EventEmitter with the two calls the real code
 *  path touches (`unref`, and `.on('exit'|'error', ...)`), plus a spy on
 *  whether/how it was constructed. Nothing here ever actually runs `git`. */
function fakeSpawnFactory() {
  const calls = [];
  const children = [];
  function spawnGc(cmd, args, opts) {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.unref = () => { child.unrefCalled = true; };
    children.push(child);
    return child;
  }
  return { spawnGc, calls, children };
}

/** Lands the "hive: init" commit on its own, isolated from whatever the test
 *  does next — see the file doc comment for why this is necessary now. */
async function primeHive(hive) {
  hive.ensureHive();
  await hive.flushGit();
}

let taskCounter = 0;
async function writeOneTask(hive) {
  taskCounter += 1;
  hive.writeTasks([{
    id: `t${taskCounter}`,
    title: `task ${taskCounter}`,
    status: 'todo',
    dependsOn: [],
    priority: 0,
    createdAt: new Date().toISOString()
  }]);
  await hive.flushGit(); // wait for the now-async commit() (and any maintenance gc it schedules) to actually run
}

test('maintenance gc does not fire before the threshold', async (t) => {
  const home = tmpHome();
  const { spawnGc, calls } = fakeSpawnFactory();
  const hive = new HiveManager(() => home, undefined, { everyCommits: 5, spawnGc });
  t.after(async () => { await hive.flushGit(); fs.rmSync(home, { recursive: true, force: true }); });

  // init (1) + one task write (2) = 2 commits, under the threshold of 5.
  await primeHive(hive);
  await writeOneTask(hive);
  assert.equal(calls.length, 0, 'two commits under a threshold of five must not spawn a maintenance gc');
});

test('maintenance gc fires at the threshold, detached with ignored stdio, and is unref\'d', async (t) => {
  const home = tmpHome();
  const { spawnGc, calls, children } = fakeSpawnFactory();
  const hive = new HiveManager(() => home, undefined, { everyCommits: 2, spawnGc });
  t.after(async () => { await hive.flushGit(); fs.rmSync(home, { recursive: true, force: true }); });

  // init (1) + one task write (2) lands EXACTLY on a threshold of 2, so the
  // task-write commit must trigger exactly one maintenance gc.
  await primeHive(hive);
  await writeOneTask(hive);

  assert.equal(calls.length, 1, 'landing exactly on the threshold must spawn exactly one maintenance gc');
  assert.deepEqual(calls[0].cmd, 'git');
  assert.deepEqual(calls[0].args, ['gc']);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.stdio, 'ignore');
  assert.equal(children[0].unrefCalled, true, 'the child must be unref\'d so it cannot keep the process alive');
});

test('a maintenance gc still in flight is not overlapped by a second one', async (t) => {
  const home = tmpHome();
  const { spawnGc, calls, children } = fakeSpawnFactory();
  const hive = new HiveManager(() => home, undefined, { everyCommits: 1, spawnGc });
  t.after(async () => { await hive.flushGit(); fs.rmSync(home, { recursive: true, force: true }); });

  // Threshold 1: every single commit is a threshold crossing. The init
  // commit itself fires gc #1 and marks it in-flight.
  await primeHive(hive);
  assert.equal(calls.length, 1, 'the init commit alone must cross a threshold of one');

  // Further commits while gc #1 is still "running" must all be skipped.
  await writeOneTask(hive);
  await writeOneTask(hive);
  assert.equal(calls.length, 1, 'a gc already running must not be overlapped by another');

  // Once gc #1 "exits", the guard clears and the next crossing may fire.
  children[0].emit('exit', 0, null);
  await writeOneTask(hive);
  assert.equal(calls.length, 2, 'after the prior gc exits, the next threshold crossing may spawn again');
});

test('a maintenance gc that fails to spawn clears the in-flight guard too', async (t) => {
  const home = tmpHome();
  const { spawnGc, calls, children } = fakeSpawnFactory();
  const hive = new HiveManager(() => home, undefined, { everyCommits: 1, spawnGc });
  t.after(async () => { await hive.flushGit(); fs.rmSync(home, { recursive: true, force: true }); });

  await primeHive(hive);
  assert.equal(calls.length, 1);

  // Simulate the spawned process failing to start at all (e.g. ENOENT) — this
  // must clear the guard exactly like a normal 'exit' does, not wedge every
  // future maintenance gc off permanently.
  children[0].emit('error', new Error('spawn git ENOENT'));

  await writeOneTask(hive);
  assert.equal(calls.length, 2, 'an error clearing the guard must let the next threshold crossing try again');
});

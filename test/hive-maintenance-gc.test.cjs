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
 * Commit-counting note: `writeTasks` on a brand-new home does TWO real
 * commits, not one — `ensureHive()` creates the git repo and commits
 * "hive: init" before `writeTasks` makes its own "hive: tasks (N)" commit.
 * Every test below accounts for that explicitly rather than assuming one
 * `writeOneTask` call equals one commit.
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

let taskCounter = 0;
function writeOneTask(hive) {
  taskCounter += 1;
  hive.writeTasks([{
    id: `t${taskCounter}`,
    title: `task ${taskCounter}`,
    status: 'todo',
    dependsOn: [],
    priority: 0,
    createdAt: new Date().toISOString()
  }]);
}

test('maintenance gc does not fire before the threshold', (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { spawnGc, calls } = fakeSpawnFactory();
  const hive = new HiveManager(() => home, undefined, { everyCommits: 5, spawnGc });

  // Fresh home: this one call does TWO commits (repo init + the task write),
  // landing the counter at 2 — under the threshold of 5.
  writeOneTask(hive);
  assert.equal(calls.length, 0, 'two commits under a threshold of five must not spawn a maintenance gc');
});

test('maintenance gc fires at the threshold, detached with ignored stdio, and is unref\'d', (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { spawnGc, calls, children } = fakeSpawnFactory();
  const hive = new HiveManager(() => home, undefined, { everyCommits: 2, spawnGc });

  // Fresh home, threshold 2: init-commit + task-commit lands EXACTLY on the
  // threshold, so this single call must trigger exactly one maintenance gc.
  writeOneTask(hive);

  assert.equal(calls.length, 1, 'landing exactly on the threshold must spawn exactly one maintenance gc');
  assert.deepEqual(calls[0].cmd, 'git');
  assert.deepEqual(calls[0].args, ['gc']);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.stdio, 'ignore');
  assert.equal(children[0].unrefCalled, true, 'the child must be unref\'d so it cannot keep the process alive');
});

test('a maintenance gc still in flight is not overlapped by a second one', (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { spawnGc, calls, children } = fakeSpawnFactory();
  const hive = new HiveManager(() => home, undefined, { everyCommits: 1, spawnGc });

  // Threshold 1: every single commit is a threshold crossing. The priming
  // call's FIRST commit (repo init) fires gc #1 and marks it in-flight; its
  // SECOND commit (the task write, same call) crosses the threshold again
  // immediately but must be skipped because gc #1's fake child has not
  // "exited" yet — this already exercises the guard inside one call.
  writeOneTask(hive);
  assert.equal(calls.length, 1, 'the in-flight gc from the init-commit must suppress the task-commit\'s own crossing');

  // Two more commits while gc #1 is still "running" — both must be skipped.
  writeOneTask(hive);
  writeOneTask(hive);
  assert.equal(calls.length, 1, 'a gc already running must not be overlapped by another');

  // Once gc #1 "exits", the guard clears and the next crossing may fire.
  children[0].emit('exit', 0, null);
  writeOneTask(hive);
  assert.equal(calls.length, 2, 'after the prior gc exits, the next threshold crossing may spawn again');
});

test('a maintenance gc that fails to spawn clears the in-flight guard too', (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { spawnGc, calls, children } = fakeSpawnFactory();
  const hive = new HiveManager(() => home, undefined, { everyCommits: 1, spawnGc });

  writeOneTask(hive);
  assert.equal(calls.length, 1);

  // Simulate the spawned process failing to start at all (e.g. ENOENT) — this
  // must clear the guard exactly like a normal 'exit' does, not wedge every
  // future maintenance gc off permanently.
  children[0].emit('error', new Error('spawn git ENOENT'));

  writeOneTask(hive);
  assert.equal(calls.length, 2, 'an error clearing the guard must let the next threshold crossing try again');
});

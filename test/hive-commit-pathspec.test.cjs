'use strict';

/**
 * AEON-1522 — the pathspec-add follow-up `gitQueue`'s own doc comment
 * flagged as separate, larger work (originally noted in AEON-1493/1510's
 * notes too): `doCommit`'s `git add -A` stages whatever is on disk at the
 * moment its QUEUED TURN runs, not at the moment `commit()` was called. Two
 * `commit()` calls fired in the same synchronous burst (the common shape —
 * no call site awaits `commit()`) both enqueue before either's `add`
 * executes, so with `-A` the FIRST commit's turn sweeps up the SECOND
 * call's already-written file too, leaving the second call's own
 * `git commit` with nothing left to stage — it silently no-ops on "nothing
 * to commit", and the second call's message never appears in the log at
 * all.
 *
 * `commit()` now accepts an optional `paths` array; `setArchived` and
 * `writeTasks` (among others) pass their own exact write-set instead of
 * relying on `-A`. This proves the fix directly: fire both in the SAME
 * synchronous burst (no await between them) and confirm BOTH commit
 * messages land as separate commits, each staging only its own file — not
 * one message swallowing the other's file, and not one call silently
 * producing no commit at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-pathspec-'));
}

function commitLog(root) {
  const r = spawnSync('git', ['log', '--format=%s'], { cwd: root, encoding: 'utf8' });
  return r.stdout.trim().split('\n').filter(Boolean);
}

function commitFiles(root, subject) {
  const rev = spawnSync('git', ['log', '--format=%H', '--grep', subject, '-F'], { cwd: root, encoding: 'utf8' })
    .stdout.trim().split('\n')[0];
  const r = spawnSync('git', ['show', '--name-only', '--format=', rev], { cwd: root, encoding: 'utf8' });
  return r.stdout.trim().split('\n').filter(Boolean);
}

test('two migrated commit() calls in the same synchronous burst land as two separate commits, each staging only its own file', async (t) => {
  const home = tmpHome();
  t.after(async () => { await hive.flushGit(); fs.rmSync(home, { recursive: true, force: true }); });

  const hive = new HiveManager(() => home);
  hive.ensureHive();
  await hive.flushGit();

  await hive.ensureAgent({ id: 'a1', name: 'A1', provider: 'claude', cwd: home });
  await hive.flushGit(); // isolate registration's own -A commit from the burst below

  // The burst: two calls, each migrated to pass its own pathspec, fired with
  // NO await between them — both their doCommit() closures enqueue before
  // either's `git add` actually runs, exactly the shape that used to blur.
  hive.setArchived('a1', true); // touches registry.json only
  hive.writeTasks([{ id: 't1', title: 'burst task', status: 'todo', dependsOn: [], priority: 0, createdAt: new Date().toISOString() }]); // touches tasks.json only

  await hive.flushGit();

  const root = path.join(home, 'hive');
  const log = commitLog(root);
  assert.ok(log.includes('hive: archive a1'), `the archive commit must appear on its own — saw: ${JSON.stringify(log)}`);
  assert.ok(log.some((s) => s.startsWith('hive: tasks (')), `the tasks commit must appear on its own — saw: ${JSON.stringify(log)}`);
  assert.notEqual(log[0], log[1], 'the two burst calls must not have collapsed into a single commit');

  // The real property under test: neither commit's diff contains the OTHER
  // call's file — that cross-contamination is exactly what `-A` would have
  // produced had the fix not applied (the first-queued commit sweeping up
  // the second call's already-written file). Whether `log.jsonl` itself
  // shows up in a given commit's diff is incidental: both calls' appendLog
  // writes happen synchronously before either commit's queued turn runs, so
  // whichever commit runs first legitimately captures the whole file and
  // the second has nothing new left in it to stage — not a bug, just `git
  // add` correctly seeing no change.
  const archiveFiles = commitFiles(root, 'hive: archive a1');
  assert.ok(archiveFiles.includes('registry.json'), `the archive commit must stage registry.json — saw: ${JSON.stringify(archiveFiles)}`);
  assert.ok(!archiveFiles.includes('tasks.json'), `the archive commit must NOT stage tasks.json — saw: ${JSON.stringify(archiveFiles)}`);

  const tasksFiles = commitFiles(root, 'hive: tasks (1)');
  assert.ok(tasksFiles.includes('tasks.json'), `the tasks commit must stage tasks.json — saw: ${JSON.stringify(tasksFiles)}`);
  assert.ok(!tasksFiles.includes('registry.json'), `the tasks commit must NOT stage registry.json — saw: ${JSON.stringify(tasksFiles)}`);
});

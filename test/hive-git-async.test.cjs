'use strict';

/**
 * AEON-1510: `HiveManager.git()`/`commit()` used to be fully synchronous
 * (`spawnSync`), which blocked the whole Electron main thread — renderer IPC,
 * every timer, every window — for the duration of `git add -A` + `commit` on
 * the hive's own tree. Converted to async, serialized through one internal
 * queue (`gitQueue`) so concurrent commits still land one at a time exactly
 * as the old synchronous calls did for free (with `gc.autoDetach=false`, two
 * real git processes racing `.git/objects/` is exactly the hazard that flag
 * exists to prevent).
 *
 * These tests prove the queue itself, not just that `commit()` doesn't throw,
 * and they also pin down a real, deliberate trade-off the conversion makes:
 * `git add -A` stages whatever is CURRENTLY on disk at the moment its queued
 * turn actually runs, not at the moment `commit()` was called — so files
 * written by a second, rapid-fire `commit()` call queued before the first
 * one's `add -A` has run can get swept into the FIRST commit instead of
 * getting their own. No data is ever lost (every write lands in SOME commit,
 * the tree always ends up clean) and ordering is never violated, but commit
 * GRANULARITY can blur under rapid succession — the same trade-off flagged
 * for the router's own `add -A` in the AEON-1493 patch notes, and out of
 * scope here for the same reason (a real fix is per-call-site pathspec
 * `add`, a separate, larger diff). A caller that needs a guaranteed distinct
 * commit per operation can `await hive.flushGit()` between them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

test('many rapid unawaited commit() calls: no data lost, tree ends clean, no index.lock failures', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-git-async-'));
  const hive = new HiveManager(() => home);
  t.after(async () => { await hive.flushGit(); fs.rmSync(home, { recursive: true, force: true }); });

  hive.ensureHive(); // queues the init commit
  const root = path.join(home, 'hive');

  for (let i = 0; i < 10; i++) {
    fs.writeFileSync(path.join(root, `file-${i}.txt`), String(i), 'utf8');
    hive.commit(`test commit ${i}`); // deliberately not awaited — fire-and-forget
  }

  await hive.flushGit();

  const log = git(root, ['log', '--format=%s']);
  assert.equal(log.status, 0, 'git log must succeed — a wedged/half-finished repo would fail here');
  // NOT asserting one distinct commit per call: `add -A` stages whatever is on
  // disk when its queued turn runs, so rapid-fire writes queued before the
  // first commit's `add -A` executes can land inside that first commit
  // instead of their own (see the file-level doc comment) — a real,
  // deliberate trade-off, not a bug. What must always hold: every file made
  // it into SOME commit, and the tree ends up clean.
  for (let i = 0; i < 10; i++) {
    assert.ok(fs.existsSync(path.join(root, `file-${i}.txt`)), `file-${i}.txt must exist on disk`);
    const inHistory = git(root, ['log', '--all', '--format=', '--name-only']).stdout.includes(`file-${i}.txt`);
    assert.ok(inHistory, `file-${i}.txt must appear in SOME commit, not just on disk uncommitted`);
  }
  assert.ok(log.stdout.includes('hive: init'), 'the init commit must still be present');

  const status = git(root, ['status', '--porcelain']);
  assert.equal(status.stdout.trim(), '', 'the working tree must be clean — nothing left uncommitted');
});

test('a caller that awaits flushGit() between writes gets one distinct commit per write', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-git-async-distinct-'));
  const hive = new HiveManager(() => home);
  t.after(async () => { await hive.flushGit(); fs.rmSync(home, { recursive: true, force: true }); });

  hive.ensureHive();
  await hive.flushGit(); // let the init commit fully land before writing anything else
  const root = path.join(home, 'hive');

  fs.writeFileSync(path.join(root, 'note.txt'), 'hi', 'utf8');
  hive.commit('add note');
  await hive.flushGit(); // the tool a caller uses to guarantee separation

  fs.writeFileSync(path.join(root, 'note2.txt'), 'hi again', 'utf8');
  hive.commit('add note2');
  await hive.flushGit();

  const log = git(root, ['log', '--format=%s']);
  const subjects = log.stdout.trim().split('\n');
  assert.deepEqual(subjects, ['add note2', 'add note', 'hive: init'], 'awaiting flushGit() between writes must yield one commit per write');
});

test('flushGit() actually waits — a read right after resolves against the finished commit', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-git-async-flush-'));
  const hive = new HiveManager(() => home);
  t.after(async () => { await hive.flushGit(); fs.rmSync(home, { recursive: true, force: true }); });

  hive.ensureHive();
  await hive.flushGit(); // isolate: the init commit must not be the one we observe below
  const root = path.join(home, 'hive');
  fs.writeFileSync(path.join(root, 'note.txt'), 'hi', 'utf8');
  hive.commit('add note');

  await hive.flushGit();

  const log = git(root, ['log', '-1', '--format=%s']);
  assert.equal(log.stdout.trim(), 'add note', 'flushGit() resolving must mean the commit already landed');
});

test('flushGit() resolves immediately (no hang) when nothing was ever queued', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-git-async-idle-'));
  const hive = new HiveManager(() => home);
  try {
    await hive.flushGit(); // must not hang — no queued work, no repo, nothing to wait on
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

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

// AEON-1522 round 3 (Dwight's review, 2026-09-14, SEVERE): pins the fact that made round 2's
// own `written` accumulator unusable in production — `git add` on an EXISTING-but-ignored path
// is refused. Probed directly here (the same instrument Dwight used, not read out of docs)
// rather than assumed, since relying on ignore semantics without checking is exactly how this
// slipped through round 2 in the first place.
test('AEON-1522 round 3 fact-check: `git add` refuses an existing path under a gitignored tree', () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, '.gitignore'), 'ignored/\n');
  fs.mkdirSync(path.join(home, 'ignored'));
  fs.writeFileSync(path.join(home, 'ignored', 'x.json'), '{}');
  fs.writeFileSync(path.join(home, 'log.jsonl'), 'line\n');
  spawnSync('git', ['init', '-q'], { cwd: home });
  spawnSync('git', ['add', '.gitignore'], { cwd: home });
  spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: home });

  const r = spawnSync('git', ['add', '--', path.join(home, 'log.jsonl'), path.join(home, 'ignored', 'x.json')], { cwd: home, encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'git must refuse when an ignored-but-existing path is named explicitly — this is the fact commit()\'s two-signal `paths` contract exists to route around, not paper over');
  assert.match(r.stderr, /ignored by one of your \.gitignore files/i, `expected git's own ignored-path refusal: ${r.stderr}`);

  fs.rmSync(home, { recursive: true, force: true });
});

// AEON-1522 round 3 (Dwight's review, 2026-09-14): the fix — `deliver()`/`routeOnce()` no
// longer collect ANY inbox/outbox path into a pathspec at all, since both are gitignored by
// design in every real agent's own `.gitignore` (`ensureMineIgnore`) and were never valid `git
// add` targets in production. `send()` and `routeOnce()` now pass `[]` explicitly, scoping the
// commit to exactly `log.jsonl`. Proven against a REAL `ensureAgent`/`ensureMineIgnore`-built
// hive (not a hand-created fixture — that gap is exactly how round 2's own bug survived), for
// BOTH call sites this round touched.
test('AEON-1522 round 3: send() and routeOnce() commit cleanly against a REAL ensureAgent hive with .gitignore in effect', async (t) => {
  const home = tmpHome();
  t.after(async () => { await hive.flushGit(); fs.rmSync(home, { recursive: true, force: true }); });

  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker-1', name: 'Creed', provider: 'claude', cwd: home });
  await hive.flushGit();

  const root = path.join(home, 'hive');
  // Sanity: confirm the real .gitignore this hive actually produces DOES ignore inbox/outbox —
  // if this ever stops being true, the whole premise of this test (and the production fix)
  // changes, and it should fail loudly here rather than pass for an unrelated reason.
  const ignoreCheck = spawnSync('git', ['check-ignore', '-q', path.join(root, 'agents', 'worker-1', 'inbox', 'probe.json')], { cwd: root });
  assert.equal(ignoreCheck.status, 0, 'sanity: a real hive must gitignore inbox/ — if this fails, the fixture no longer matches production');

  hive.send({ to: 'worker-1', act: 'inform', subject: 'hi', body: 'test' }, 'god-1');
  await hive.flushGit();
  const sendFiles = commitFiles(root, 'hive: msg god-1→worker-1 (inform)');
  assert.deepEqual(sendFiles, ['log.jsonl'], `send() must commit exactly log.jsonl, never an inbox path — saw: ${JSON.stringify(sendFiles)}`);

  fs.writeFileSync(path.join(root, 'agents', 'worker-1', 'outbox', 'm2.json'), JSON.stringify({ to: 'god', act: 'done', subject: 'x', body: 'y' }));
  assert.equal(hive.routeOnce(), 1);
  await hive.flushGit();
  const routeFiles = commitFiles(root, 'hive: routed 1 message(s)');
  assert.deepEqual(routeFiles, ['log.jsonl'], `routeOnce() must commit exactly log.jsonl, never an outbox/inbox path — saw: ${JSON.stringify(routeFiles)}`);
});

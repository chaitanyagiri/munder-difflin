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
 * AEON-1510 update: `commit()` is now async/queued, and — per that patch's
 * own documented trade-off — `git add -A` stages whatever is on disk when
 * ITS queued turn runs, not at call time. `primeHive` below explicitly
 * `flushGit()`s the init commit on its own before any test starts counting,
 * so every `writeOneTask` after that is exactly one real commit.
 *
 * AEON-1523 round 5 (Dwight's review, 2026-09-14): `maybeScheduleMaintenanceGc`
 * used to spawn `git gc` directly via `spawn`/a fake `spawnGc`, entirely
 * OUTSIDE `git()`/`gitQueue` — not gated by shutdown, not tracked, and
 * explicitly `detached`+`unref`'d, surviving `will-quit`'s `app.exit(0)` by
 * design. Fixed to route through `enqueueGit`+`git()`, the same choke point
 * every other git-touching operation uses. That removed the `spawnGc`
 * constructor seam entirely — these tests now drive the SAME `gitBin`
 * override every other `git()`-based test in this suite uses, with a small
 * counting/forwarding fake script (real process, real git underneath)
 * instead of a bare in-memory `EventEmitter` fake that never touched git.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-maintgc-'));
}

/** A "git" stand-in. Logs `gc <ts>` to LOG_FILE whenever invoked with `gc`,
 *  then: if GC_FAIL is set, exits 1 without touching real git (simulates a
 *  gc that ran and failed, not a spawn-level ENOENT); if GC_DELAY_MS is set,
 *  ignores SIGTERM and sleeps that long before exiting 0 (simulates a slow
 *  gc, to test the overlap guard); otherwise passes straight through to the
 *  real `git`. Every non-`gc` invocation always passes straight through. */
function writeCountingGit(dir) {
  const script = path.join(dir, 'counting-git.js');
  fs.writeFileSync(script, `#!${process.execPath}
const fs = require('fs');
const { spawnSync } = require('child_process');
const args = process.argv.slice(2);
const log = process.env.GC_LOG_FILE;
if (args.includes('gc')) {
  if (log) fs.appendFileSync(log, 'gc ' + Date.now() + '\\n');
  if (process.env.GC_FAIL) process.exit(1);
  if (process.env.GC_DELAY_MS) {
    process.on('SIGTERM', () => {});
    setTimeout(() => process.exit(0), Number(process.env.GC_DELAY_MS));
    return;
  }
}
const r = spawnSync('git', args, { cwd: process.cwd(), stdio: 'inherit' });
process.exit(r.status ?? 1);
`, 'utf8');
  fs.chmodSync(script, 0o755);
  return script;
}

function gcCount(logPath) {
  if (!fs.existsSync(logPath)) return 0;
  return (fs.readFileSync(logPath, 'utf8').match(/^gc /gm) || []).length;
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
  const logPath = path.join(home, 'gc.log');
  process.env.GC_LOG_FILE = logPath;
  t.after(async () => { await hive.flushGit(); delete process.env.GC_LOG_FILE; fs.rmSync(home, { recursive: true, force: true }); });

  const hive = new HiveManager(() => home, undefined, { everyCommits: 5 });
  hive.gitBin = writeCountingGit(home);

  // init (1) + one task write (2) = 2 commits, under the threshold of 5.
  await primeHive(hive);
  await writeOneTask(hive);
  assert.equal(gcCount(logPath), 0, 'two commits under a threshold of five must not spawn a maintenance gc');
});

test('maintenance gc fires exactly once at the threshold, routed through the real git() queue', async (t) => {
  const home = tmpHome();
  const logPath = path.join(home, 'gc.log');
  process.env.GC_LOG_FILE = logPath;
  t.after(async () => { await hive.flushGit(); delete process.env.GC_LOG_FILE; fs.rmSync(home, { recursive: true, force: true }); });

  const hive = new HiveManager(() => home, undefined, { everyCommits: 2 });
  hive.gitBin = writeCountingGit(home);

  // init (1) + one task write (2) lands EXACTLY on a threshold of 2, so the
  // task-write commit must trigger exactly one maintenance gc.
  await primeHive(hive);
  await writeOneTask(hive);

  assert.equal(gcCount(logPath), 1, 'landing exactly on the threshold must spawn exactly one maintenance gc');
  // Routed through git() means it inherits git()'s own detached:true (proven
  // once, generically, by hive-git-timeout.test.cjs's kill mechanism working
  // at all) — no need to re-assert spawn options specific to gc anymore;
  // what matters now is that it went through the SAME path, which the count
  // above plus the shutdown-participation test below together establish.
});

test('several threshold crossings queued together must spawn only ONE gc, not one each', async (t) => {
  const home = tmpHome();
  const logPath = path.join(home, 'gc.log');
  process.env.GC_LOG_FILE = logPath;
  t.after(async () => {
    await hive.flushGit();
    delete process.env.GC_LOG_FILE;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const hive = new HiveManager(() => home, undefined, { everyCommits: 1 });
  hive.gitBin = writeCountingGit(home);

  // The real race the in-flight guard protects against: with the gc now
  // routed through the SAME serial queue as everything else, a later commit
  // can never run WHILE an earlier one's gc is still executing (the queue
  // itself already prevents that overlap). The guard's real job is upstream
  // of that — several commits enqueued in the SAME synchronous burst, each
  // independently crossing the threshold, before ANY of their gc-scheduling
  // has run. `maybeScheduleMaintenanceGc`'s own increment+check is
  // synchronous per call, but the FIRST commit's gc doesn't get enqueued
  // until control reaches its own success branch, well after later commits
  // in the same burst have already queued their own commit closures —
  // this is deliberately NOT `writeOneTask` (which awaits `flushGit()`
  // internally, serializing one full commit+gc cycle before the next call
  // even starts, which cannot reproduce this race at all).
  hive.ensureHive(); // init — the first threshold crossing
  for (let i = 0; i < 3; i++) {
    taskCounter += 1;
    hive.writeTasks([{
      id: `t${taskCounter}`, title: `task ${taskCounter}`, status: 'todo',
      dependsOn: [], priority: 0, createdAt: new Date().toISOString()
    }]);
  }

  await hive.flushGit(); // drains all 4 commits and however many gc attempts got through

  assert.equal(gcCount(logPath), 1, 'only ONE gc may fire despite four threshold crossings (init + 3 tasks) queued in the same burst');
});

test('a maintenance gc that fails clears the in-flight guard too', async (t) => {
  const home = tmpHome();
  const logPath = path.join(home, 'gc.log');
  process.env.GC_LOG_FILE = logPath;
  t.after(async () => { await hive.flushGit(); delete process.env.GC_LOG_FILE; fs.rmSync(home, { recursive: true, force: true }); });

  const hive = new HiveManager(() => home, undefined, { everyCommits: 1 });
  hive.gitBin = writeCountingGit(home);

  await primeHive(hive);
  assert.equal(gcCount(logPath), 1);

  // The gc that just ran failed (real exit 1, not a spawn-level ENOENT —
  // `maybeScheduleMaintenanceGc`'s `finally` clears the guard on ANY
  // settlement of `git()`'s promise, success or failure alike) — this must
  // not wedge every future maintenance gc off permanently.
  process.env.GC_FAIL = '1';
  await writeOneTask(hive); // this commit's OWN threshold crossing tries gc #2, which fails
  delete process.env.GC_FAIL;

  assert.equal(gcCount(logPath), 2, 'the failed gc must still have been attempted');

  await writeOneTask(hive); // proves the guard is clear: a THIRD gc may now fire
  assert.equal(gcCount(logPath), 3, 'a failed gc must clear the in-flight guard so the next threshold crossing can try again');
});

'use strict';

/**
 * AEON-1523 (Pam's production-base review, 2026-09-14, two rounds on this
 * one file):
 *
 * Round 2 finding: `flushGit()` existed but had zero production callers —
 * `git grep flushGit -- src` found only its own declaration — despite
 * `hive.ts`'s own doc comment naming app shutdown as a required caller.
 * Production `teardownAndQuit()` calls `app.quit()` synchronously and
 * `will-quit` hard-exits after analytics/1200ms; neither awaited the git
 * queue, so a file written and fire-and-forget `commit()`-queued shortly
 * before quit could have its `git add`/`git commit` child killed mid-flight
 * by process exit.
 *
 * Round 3 finding, on the round-2 fix itself: `flushGitBeforeQuit` raced
 * `flushGit()` against a timeout, but when the TIMEOUT won it only stopped
 * WAITING — it never touched the still-running `detached: true` git child,
 * which survives Electron's own `app.exit(0)` (exiting the app does not
 * touch an orphaned process's own process GROUP). A quick relaunch could
 * then start a NEW writer while that orphan was still mutating
 * `.git/objects` — the exact concurrent-writer hazard `gc.autoDetach=false`
 * and the whole queue exist to prevent, reproduced at the shutdown boundary.
 * The round-2 test's OWN cleanup masked this: its `t.after` called unbounded
 * `flushGit()` and waited out the full slow child, so it proved the method
 * RETURNS at the bound, never that shutdown actually leaves nothing running.
 *
 * Fixed: when the deadline wins, `flushGitBeforeQuit` now (1) marks the
 * queue shutting down so no FUTURE queued op can start a new process, (2)
 * kills the CURRENT process's tree via `hardKillTree` (unignorable SIGKILL),
 * and (3) waits, still bounded, for that kill to actually be reaped.
 *
 * Round 4, on the round-3 fix: `gitShuttingDown` was checked only inside
 * `enqueueGit` — the wrong layer. `doCommit()` makes SEVERAL sequential
 * `git()` calls inside one already-admitted queue link (untrack probes,
 * `add -A`, `commit`, retries); killing an EARLY one (say `add -A`) let
 * `doCommit` carry on and spawn its NEXT one (`commit`) past the latch — a
 * second, untracked detached child, overwriting `currentGitPid`/
 * `currentGitClosed` out from under the shutdown sequence already awaiting
 * the FIRST one. The round-3 test could not see this: it enqueued single-
 * `git()` closures directly, never a real multi-call `doCommit()`. Fixed by
 * moving the gate to `git()` itself — the one choke point every caller
 * (`enqueueGit`'s wrapped closures, `doCommit`'s own sequential calls,
 * `ensureHive`'s init) routes through — so a shutdown mid-`doCommit` makes
 * its NEXT `git()` call reject immediately, before ever spawning.
 *
 * These tests prove BOTH halves Pam asked for, directly — not a
 * reimplemented pattern, and not via `process.kill(pid, 0)` (see
 * `hive-git-timeout.test.cjs`'s own doc comment for why that specific check
 * is unreliable on this box: a zombie can still answer it as "alive" for a
 * few ms after a real death). Instead, a heartbeat file the slow child
 * writes every 5ms for as long as it's genuinely alive proves liveness
 * directly — the same technique `hive-git-timeout.test.cjs` uses for exactly
 * this reason:
 *   1. after the timeout wins, the killed child's heartbeat goes and STAYS
 *      stale (it cannot write another one once dead — no ambiguity);
 *   2. a git operation queued AFTER shutdown never even starts (never logs
 *      its own `start` line) — proving `gitShuttingDown` actually blocks it,
 *      not merely that it happens to run "too late to matter".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

/** A "git" stand-in. If `args` includes the value of HEARTBEAT_PHASE (e.g.
 *  'commit' or 'add') and HEARTBEAT_FILE is set: logs its own `start <phase>`
 *  line, ignores SIGTERM (only SIGKILL ends it), and writes a heartbeat every
 *  5ms for up to DELAY_MS. Every OTHER invocation (any phase not matching
 *  HEARTBEAT_PHASE) logs its own `start <phase>` line too, then passes
 *  straight through to the real `git` — so a test can prove which phases
 *  actually ran by reading the log, not just infer it from side effects. */
function writeHeartbeatGit(dir) {
  const script = path.join(dir, 'hb-git.js');
  fs.writeFileSync(script, `#!${process.execPath}
const fs = require('fs');
const { spawnSync } = require('child_process');
const args = process.argv.slice(2);
const log = process.env.FAKE_GIT_LOG;
const phase = args.find((a) => !a.startsWith('-') && !a.includes('=')) || args[0];
if (log) fs.appendFileSync(log, 'start ' + phase + ' ' + Date.now() + '\\n');
if (process.env.HEARTBEAT_FILE && args.includes(process.env.HEARTBEAT_PHASE || 'commit')) {
  process.on('SIGTERM', () => {}); // eat it — only SIGKILL can end this
  const hbFile = process.env.HEARTBEAT_FILE;
  const hbTimer = setInterval(() => { try { fs.writeFileSync(hbFile, String(Date.now())); } catch {} }, 5);
  fs.writeFileSync(hbFile, String(Date.now()));
  setTimeout(() => { clearInterval(hbTimer); process.exit(0); }, Number(process.env.FAKE_GIT_DELAY_MS || 0));
  return;
}
const r = spawnSync('git', args, { cwd: process.cwd(), stdio: 'inherit' });
process.exit(r.status ?? 1);
`, 'utf8');
  fs.chmodSync(script, 0o755);
  return script;
}

test('flushGitBeforeQuit waits for a commit that settles well within the bound', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-flush-quit-fast-'));
  t.after(async () => { await hive.flushGit(); fs.rmSync(home, { recursive: true, force: true }); });

  const hive = new HiveManager(() => home);
  const logPath = path.join(home, 'log.txt');
  fs.writeFileSync(logPath, '');
  process.env.FAKE_GIT_LOG = logPath;
  hive.gitBin = writeHeartbeatGit(home);

  hive.ensureHive(); // real init commit, real (fast, non-heartbeat) git — settles quickly
  await hive.flushGitBeforeQuit(2000);

  const root = path.join(home, 'hive');
  const log = spawnSync('git', ['log', '--format=%s'], { cwd: root, encoding: 'utf8' });
  assert.equal(log.stdout.trim(), 'hive: init', 'a commit well inside the bound must not be lost by a premature exit');
});

test('when the deadline wins: the killed child stops running, and no queued successor starts', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-flush-quit-shutdown-'));
  const logPath = path.join(home, 'log.txt');
  const heartbeatFile = path.join(home, 'heartbeat.txt');
  fs.writeFileSync(logPath, '');
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); }); // NOT flushGit() — that would mask exactly this bug

  const hive = new HiveManager(() => home);
  hive.gitBin = writeHeartbeatGit(home);
  process.env.FAKE_GIT_LOG = logPath;
  process.env.HEARTBEAT_FILE = heartbeatFile;
  process.env.FAKE_GIT_DELAY_MS = '3000'; // far longer than the bound below
  t.after(() => { delete process.env.FAKE_GIT_LOG; delete process.env.HEARTBEAT_FILE; delete process.env.FAKE_GIT_DELAY_MS; });

  // Enqueue directly (bypassing ensureHive/commit) so this test controls
  // exactly two git-touching operations: one that hangs past the bound, and
  // one queued right behind it that must never be allowed to start.
  let secondRan = false;
  hive.enqueueGit(() => hive.git(['commit', '-q', '-m', 'first'], home).then(() => {}));
  hive.enqueueGit(() => { secondRan = true; return hive.git(['commit', '-q', '-m', 'second'], home).then(() => {}); });

  // Let the queue actually start the first (slow) job before capturing its
  // pid — enqueueGit chains onto a promise, so the spawn happens a
  // microtask after this function returns, not synchronously within it.
  await new Promise((r) => setImmediate(r));
  const killedPid = hive.currentGitPid;
  assert.ok(killedPid, 'the slow commit must have actually started (and be trackable) before shutdown begins');

  // 600ms, not something shorter: a real node child needs time to cold-boot
  // and write its FIRST heartbeat before the bound fires — too short a bound
  // here isn't "more aggressive", it's a race against Node's own startup
  // variance under load (the exact lesson hive-git-timeout.test.cjs already
  // hit and calibrated around). 600ms is still far short of the 3000ms delay,
  // so the deadline still definitely wins.
  await hive.flushGitBeforeQuit(600);

  // 1) The killed child must actually stop doing work. A single reading
  //    right after the kill is NOT proof either way — the heartbeat interval
  //    is 5ms, so a genuinely LIVE child's last write is also always within
  //    ~5ms of "now". The real proof is over an interval much longer than
  //    one heartbeat tick with no new write landing: a live child would have
  //    refreshed it many times by then; a dead one cannot have refreshed it
  //    even once.
  const readTs = () => Number(fs.readFileSync(heartbeatFile, 'utf8'));
  const tsAtKill = readTs();
  await new Promise((r) => setTimeout(r, 100)); // 20x the 5ms heartbeat interval
  const tsAfterWait = readTs();
  assert.equal(tsAfterWait, tsAtKill, 'the heartbeat must not advance at all after the kill — any advance means the child is still alive and writing');

  // Supplementary to the heartbeat proof above (which is the authoritative
  // one — see hive-git-timeout.test.cjs's own doc comment for why a bare
  // `process.kill(pid, 0)` check is unreliable on this box: a just-killed
  // process can still answer "alive" for a few ms during OS-level zombie
  // reaping). Polled with a short grace rather than checked once, to avoid
  // landing inside exactly that window and reporting a false failure.
  const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let stillAlive = isAlive(killedPid);
  for (let i = 0; stillAlive && i < 20; i++) {
    await new Promise((r) => setTimeout(r, 20));
    stillAlive = isAlive(killedPid);
  }
  assert.equal(stillAlive, false, `pid ${killedPid} must not still be alive/reachable well after shutdown killed it`);

  // 2) The second queued operation must never have been allowed to start.
  assert.equal(secondRan, false, 'gitShuttingDown must block a successor queued behind the killed operation');
  const startCount = (fs.readFileSync(logPath, 'utf8').match(/^start /gm) || []).length;
  assert.equal(startCount, 1, 'only the first (killed) operation may ever have logged a start line');
});

test('round 4: killing an EARLY phase inside a real doCommit() must not let it spawn the NEXT phase', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-flush-quit-internal-'));
  const logPath = path.join(home, 'log.txt');
  const heartbeatFile = path.join(home, 'heartbeat.txt');
  fs.writeFileSync(logPath, '');
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); }); // NOT flushGit() — masks exactly this bug

  const hive = new HiveManager(() => home);
  hive.gitBin = writeHeartbeatGit(home);
  process.env.FAKE_GIT_LOG = logPath;
  process.env.HEARTBEAT_FILE = heartbeatFile;
  process.env.HEARTBEAT_PHASE = 'add'; // the EARLY phase inside doCommit's retry loop
  process.env.FAKE_GIT_DELAY_MS = '3000';
  t.after(() => {
    for (const k of ['FAKE_GIT_LOG', 'HEARTBEAT_FILE', 'HEARTBEAT_PHASE', 'FAKE_GIT_DELAY_MS']) delete process.env[k];
  });

  // A REAL commit() call, not a direct enqueueGit — this is the exact shape
  // round 3's test could not exercise: doCommit() calling `add` then
  // (normally) `commit` as two SEQUENTIAL git() calls inside one admitted
  // queue link, not two separately-queued links.
  fs.mkdirSync(path.join(home, 'hive'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: path.join(home, 'hive') });
  hive.commit('should never land — add is about to hang past the deadline');

  await new Promise((r) => setImmediate(r)); // let the queue actually start `add`
  assert.ok(hive.currentGitPid, 'the add phase must have actually started');

  await hive.flushGitBeforeQuit(600); // same calibration as the round-3 test (bumped 300->600ms after a repeated-run stress test still occasionally raced Node's cold boot), see its own comment

  // The add phase's heartbeat must stop and stay stopped (same proof as the
  // round-3 test — see its comment for why a single reading isn't enough).
  const readTs = () => Number(fs.readFileSync(heartbeatFile, 'utf8'));
  const tsAtKill = readTs();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(readTs(), tsAtKill, 'the add phase must not advance after being killed');

  // The actual round-4 property: doCommit must NEVER have reached its next
  // git() call (`commit`) after `add` was killed — the whole point of
  // moving the gate into git() itself rather than leaving it in enqueueGit.
  // (doCommit also runs the untrack-cost-ledger/untrack-codex-homes probes
  // — `ls-files` calls — BEFORE `add`; those are expected and harmless,
  // not the property under test, so allowed rather than asserted against.)
  const log = fs.readFileSync(logPath, 'utf8');
  const phases = log.trim().split('\n').filter(Boolean).map((l) => l.split(' ')[1]);
  assert.equal(phases.filter((p) => p === 'add').length, 1, `add must have started exactly once — saw: ${JSON.stringify(phases)}`);
  assert.equal(phases.at(-1), 'add', `add must be the LAST phase that ever ran — nothing may start after it — saw: ${JSON.stringify(phases)}`);
  assert.ok(!phases.includes('commit'), `doCommit must never reach its commit phase after add was killed — saw: ${JSON.stringify(phases)}`);
});

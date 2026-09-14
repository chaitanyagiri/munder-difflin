'use strict';

/**
 * AEON-1523 (Pam's production-base review, 2026-09-14): `flushGit()` existed
 * but had zero production callers — `git grep flushGit -- src` found only
 * test usage — despite `hive.ts`'s own doc comment naming app shutdown as a
 * required caller. Production `teardownAndQuit()` calls `app.quit()`
 * synchronously and `will-quit` hard-exits after analytics/1200ms; neither
 * awaited the git queue. A file written and fire-and-forget `commit()`-queued
 * shortly before quit could therefore have its `git add`/`git commit` child
 * killed mid-flight by process exit — real, not theoretical: this is the
 * production counterpart of the exact lost-completion-contract class the
 * whole AEON-1510 conversion was built to survive in tests, just never wired
 * into the one place tests can't reach (a real Electron quit).
 *
 * `flushGitBeforeQuit(timeoutMs)` is `hive.ts`'s fix: race `flushGit()`
 * against a bound, so quit can never hang unboundedly on a wedged git
 * process. These tests prove BOTH directions of that race directly against
 * the real method (not a reimplemented pattern) using the same `gitBin`
 * fake-git technique as `hive-commit-retry.test.cjs`:
 *   - a commit that settles well within the bound is NOT lost — the method
 *     waits for it rather than racing ahead the instant it's called.
 *   - a commit slower than the bound does not hang the caller past the
 *     bound — proving the timeout half of the race actually fires.
 * `src/main/index.ts`'s `will-quit` handler itself isn't imported here (it
 * has real Electron/analytics side effects at module scope) — wiring it to
 * call this exact method is the fix; this file is the regression test for
 * the method the fix depends on.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

/** A "git" stand-in whose `commit` invocation takes `delayMs` (via a real,
 *  blocking `sleep` inside the child, not a fake — a real slow process) before
 *  behaving like normal git. Every other invocation (`add`, `init`, etc.)
 *  passes straight through to the real `git`. */
function writeSlowGit(dir, delayMs) {
  const script = path.join(dir, 'slow-git.js');
  fs.writeFileSync(script, `#!${process.execPath}
const { spawnSync } = require('child_process');
const args = process.argv.slice(2);
if (args.includes('commit')) {
  const until = Date.now() + ${delayMs};
  while (Date.now() < until) { /* busy-wait: a real slow git, not a fake delay */ }
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
  hive.gitBin = writeSlowGit(home, 50); // settles in ~50ms, well under the bound below

  hive.ensureHive(); // queues the init commit through the slow-but-not-that-slow fake
  await hive.flushGitBeforeQuit(2000);

  const root = path.join(home, 'hive');
  const log = spawnSync('git', ['log', '--format=%s'], { cwd: root, encoding: 'utf8' });
  assert.equal(log.stdout.trim(), 'hive: init', 'a commit well inside the bound must not be lost by a premature exit');
});

test('flushGitBeforeQuit gives up at the bound rather than hanging on a wedged git', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-flush-quit-slow-'));
  t.after(async () => { await hive.flushGit(); fs.rmSync(home, { recursive: true, force: true }); });

  const hive = new HiveManager(() => home);
  hive.gitBin = writeSlowGit(home, 1500); // far longer than the bound below

  hive.ensureHive();
  const start = Date.now();
  await hive.flushGitBeforeQuit(150); // deliberately short bound for this test
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 800, `must return at the bound (~150ms), not wait out the full 1500ms commit (took ${elapsed}ms)`);

  const root = path.join(home, 'hive');
  const log = spawnSync('git', ['log', '--format=%s'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(log.stdout.trim(), 'hive: init', 'this case IS the accepted loss: a commit slower than the bound is not waited for — proving the bound is a real bound, not a guarantee');
});

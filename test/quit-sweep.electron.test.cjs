'use strict';
/**
 * Regression test for TWO Windows quit bugs, exercised through the app's real
 * quit flow (see test/fixtures/quit-sweep-main.cjs for the full story):
 *
 * 1. The process-tree leak (276f782): PtyManager.killAll() deferred its
 *    `taskkill /T /F` backstop 4s on an unref'd timer, but the quit path exits
 *    the main process ~1.2s after killAll, so the sweep never ran and agent
 *    trees survived the app. Pre-fix, the recorded PIDs outlive Electron and
 *    the survivor assertion fails.
 * 2. The quit hang: in the real app, quitting teardownAndQuit-style with a
 *    window still open, plus will-quit's preventDefault-and-flush deferral,
 *    left Electron's internal is-quitting state wedged — a re-entrant
 *    app.quit() finisher was a silent no-op and the main process idled
 *    forever. The fix finishes with app.exit(0); the fixture runs that same
 *    flow and this test requires a clean exit 0 within the timeout. (The
 *    wedge itself only reproduces with the full app, so this guards the fixed
 *    pattern completing rather than red/green-reproducing the hang.)
 *
 * Both bugs live in the ELECTRON lifecycle (early exit killing unref'd timers;
 * quit state machine interleaving) and node-pty here is rebuilt for Electron's
 * ABI — so this test launches the real Electron binary with the fixture as its
 * main script, then asserts the fixture exited 0 and every recorded PID died.
 *
 * Self-contained, no framework — run with `node test/quit-sweep.electron.test.cjs`
 * (mirrors test/proc-kill.test.cjs). Windows-only by nature; elsewhere it exits
 * 0 after a smoke check (POSIX quits kill trees via pty-closure HUP instead).
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

if (process.platform !== 'win32') {
  console.log('  ok  (non-win32: the synchronous quit sweep is Windows-only — POSIX quits HUP the group via pty closure)');
  process.exit(0);
}

// From plain Node (not inside Electron), the electron package exports the
// path to the Electron executable.
const electronBin = require('electron');
assert.strictEqual(typeof electronBin, 'string', 'expected electron package to export the binary path');

const fixture = path.join(__dirname, 'fixtures', 'quit-sweep-main.cjs');
const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quit-sweep-')), 'pids.json');

function isAlive(pid) {
  const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8' });
  return out.includes(`"${pid}"`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // must launch as Electron, not as Node

  const child = spawn(electronBin, [fixture, `--pid-file=${pidFile}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    windowsHide: true
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  const exitCode = await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      // Hung fixture: reap it (and anything it spawned) so the TEST never leaks.
      try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: 10_000 }); } catch { /* gone */ }
      resolve('timeout');
    }, 60_000);
    child.on('exit', (code) => { clearTimeout(timeout); resolve(code); });
  });

  try {
    assert.notStrictEqual(exitCode, 'timeout', `electron fixture hung; output:\n${output}`);
    assert.ok(fs.existsSync(pidFile), `fixture never wrote the pid file; output:\n${output}`);
    const recorded = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(!recorded.error, `fixture bailed: ${recorded.error}; output:\n${output}`);
    assert.strictEqual(exitCode, 0, `electron exited ${exitCode}; output:\n${output}`);
    assert.ok(recorded.pids.length >= 2, `expected root+descendant, saw: ${recorded.pids.join(',')}`);

    await sleep(500); // let the OS finish reaping what taskkill force-killed
    const survivors = recorded.pids.filter(isAlive);
    if (survivors.length) {
      // Clean up the leak before failing, so a red run doesn't strand processes.
      for (const pid of survivors) {
        try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 10_000 }); } catch { /* gone */ }
      }
      assert.fail(`process tree survived Electron quit — leaked PIDs: ${survivors.join(',')} of ${recorded.pids.join(',')}`);
    }
    console.log(`  ok  quit sweep reaped the whole tree inside Electron (pids: ${recorded.pids.join(',')})`);
  } catch (e) {
    console.error(`FAIL  ${e.message}`);
    process.exit(1);
  }
})();

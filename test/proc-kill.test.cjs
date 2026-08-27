'use strict';
/**
 * procKill tests — prove the PID-release hardening works on a REAL process
 * tree. Self-contained, no framework — run with `node test/proc-kill.test.cjs`
 * (mirrors test/breaker.test.cjs). POSIX-only assertions (the Windows path is
 * `taskkill /T /F`, exercised in CI on a Windows runner if ever added); on
 * win32 this file exits 0 after a smoke import.
 *
 * Scenario mirroring the leak: a session leader that IGNORES SIGHUP (like a
 * wedged TUI) with a live child of its own. A bare pty kill() leaves both
 * running forever; ensureKilled() must reap the whole group.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const { spawn, execFileSync } = require('node:child_process');
const test = require('node:test');

const SRC = path.join(__dirname, '..', 'src', 'main', 'procKill.ts');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'prockill-'));
const js = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
fs.writeFileSync(path.join(out, 'procKill.js'), js, 'utf8');
const { isAlive, hardKillTree, ensureKilled } = require(path.join(out, 'procKill.js'));

if (process.platform === 'win32') {
  console.log('  ok  (win32: smoke import only — POSIX group semantics not applicable)');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Live pids in process group `pgid` (empty when the group is gone). */
function groupPids(pgid) {
  try {
    return execFileSync('pgrep', ['-g', String(pgid)], { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean).map(Number);
  } catch { return []; } // pgrep exits 1 when no match
}

/** Spawn a detached (own-process-group) leader that traps HUP, with a child. */
function spawnStubbornTree() {
  const proc = spawn('sh', ['-c', 'trap "" HUP; sleep 60 & wait'], { detached: true, stdio: 'ignore' });
  proc.unref();
  return proc.pid;
}

test('isAlive: true for a live process, false after it dies', async () => {
  const pid = spawnStubbornTree();
  await sleep(200);
  assert.ok(isAlive(pid), 'leader should be alive');
  hardKillTree(pid);
  await sleep(200);
  assert.ok(!isAlive(pid), 'leader should be dead after hardKillTree');
});

test('hardKillTree reaps the WHOLE group, not just the leader', async () => {
  const pid = spawnStubbornTree();
  await sleep(300);
  const before = groupPids(pid);
  assert.ok(before.length >= 2, `expected leader+child in group, saw: ${before.join(',')}`);
  hardKillTree(pid);
  await sleep(300);
  assert.deepEqual(groupPids(pid), [], 'group should be empty');
});

test('SIGHUP alone does NOT kill the stubborn leader (the leak)', async () => {
  const pid = spawnStubbornTree();
  await sleep(200);
  try { process.kill(pid, 'SIGHUP'); } catch { /* noop */ }
  await sleep(300);
  assert.ok(isAlive(pid), 'a HUP-trapping leader survives a bare SIGHUP — this is the leaked-PID case');
  hardKillTree(pid); // cleanup
});

test('ensureKilled escalates after the grace and releases every PID', async () => {
  const pid = spawnStubbornTree();
  await sleep(200);
  try { process.kill(pid, 'SIGHUP'); } catch { /* noop */ } // the polite kill that gets ignored
  ensureKilled(pid, 400);
  await sleep(1200);
  assert.ok(!isAlive(pid), 'leader must be gone after escalation');
  assert.deepEqual(groupPids(pid), [], 'no survivors in the group');
});

test('ensureKilled tolerates bad pids', async () => {
  ensureKilled(undefined);
  ensureKilled(-5);
  ensureKilled(0);
  ensureKilled(1.5);
});

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

const SRC = path.join(__dirname, '..', 'src', 'main', 'procKill.ts');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'prockill-'));
const js = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
fs.writeFileSync(path.join(out, 'procKill.js'), js, 'utf8');
const { isAlive, hardKillTree, ensureKilled, groupMembers, shouldSweep } = require(path.join(out, 'procKill.js'));

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

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

(async () => {
  await test('isAlive: true for a live process, false after it dies', async () => {
    const pid = spawnStubbornTree();
    await sleep(200);
    assert.ok(isAlive(pid), 'leader should be alive');
    hardKillTree(pid);
    await sleep(200);
    assert.ok(!isAlive(pid), 'leader should be dead after hardKillTree');
  });

  await test('hardKillTree reaps the WHOLE group, not just the leader', async () => {
    const pid = spawnStubbornTree();
    await sleep(300);
    const before = groupPids(pid);
    assert.ok(before.length >= 2, `expected leader+child in group, saw: ${before.join(',')}`);
    hardKillTree(pid);
    await sleep(300);
    assert.deepEqual(groupPids(pid), [], 'group should be empty');
  });

  await test('SIGHUP alone does NOT kill the stubborn leader (the leak)', async () => {
    const pid = spawnStubbornTree();
    await sleep(200);
    try { process.kill(pid, 'SIGHUP'); } catch { /* noop */ }
    await sleep(300);
    assert.ok(isAlive(pid), 'a HUP-trapping leader survives a bare SIGHUP — this is the leaked-PID case');
    hardKillTree(pid); // cleanup
  });

  await test('ensureKilled escalates after the grace and releases every PID', async () => {
    const pid = spawnStubbornTree();
    await sleep(200);
    try { process.kill(pid, 'SIGHUP'); } catch { /* noop */ } // the polite kill that gets ignored
    ensureKilled(pid, 400);
    await sleep(1200);
    assert.ok(!isAlive(pid), 'leader must be gone after escalation');
    assert.deepEqual(groupPids(pid), [], 'no survivors in the group');
  });

  await test('ensureKilled tolerates bad pids', async () => {
    ensureKilled(undefined);
    ensureKilled(-5);
    ensureKilled(0);
    ensureKilled(1.5);
  });

  await test('shouldSweep: sweeps survivors, skips recycled or empty groups, sweeps blind on ps failure', async () => {
    const snap = (pairs) => new Map(pairs);
    assert.equal(shouldSweep(snap([[5, 'a']]), snap([[5, 'a']])), true, 'same member survives -> reap');
    assert.equal(shouldSweep(snap([[5, 'a'], [6, 'b']]), snap([[6, 'b']])), true, 'any original survivor -> reap');
    assert.equal(shouldSweep(snap([[5, 'a']]), snap()), false, 'group gone -> nothing to reap');
    assert.equal(shouldSweep(snap([[5, 'a']]), snap([[5, 'zzz']])), false, 'same pid, new start time -> recycled, skip');
    assert.equal(shouldSweep(snap([[5, 'a']]), snap([[7, 'c']])), false, 'all strangers -> recycled, skip');
    assert.equal(shouldSweep(null, snap([[5, 'a']])), true, 'ps failed at schedule -> pre-guard behavior');
    assert.equal(shouldSweep(snap([[5, 'a']]), null), true, 'ps failed at sweep -> pre-guard behavior');
  });

  await test('groupMembers sees a real group and its start times', async () => {
    const pid = spawnStubbornTree();
    await sleep(300);
    const members = groupMembers(pid);
    assert.ok(members !== null, 'ps must be usable here');
    assert.ok(members.size >= 2, `expected leader+child, saw ${members.size}`);
    for (const started of members.values()) assert.ok(started.length > 0, 'every member carries a start time');
    hardKillTree(pid); // cleanup
  });

  await test('ensureKilled never group-kills a stranger group that inherited the pgid (T1007)', async () => {
    // Deterministic pid reuse cannot be forced, so prove the guard at its seam:
    // a snapshot of tree A (then fully killed) against the live membership of an
    // unrelated tree B must refuse the sweep.
    const a = spawnStubbornTree();
    await sleep(300);
    const before = groupMembers(a);
    hardKillTree(a);
    await sleep(300);
    const b = spawnStubbornTree();
    await sleep(300);
    assert.equal(shouldSweep(before, groupMembers(b)), false, 'stranger group must be spared');
    hardKillTree(b); // cleanup
    // And the live path stays intact: with the guard active, a genuinely
    // surviving group is still reaped (covered by the escalation test above).
  });

  process.exit(failures ? 1 : 0);
})();

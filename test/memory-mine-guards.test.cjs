'use strict';

/**
 * AEON-1513: a corrupt chromadb compactor made an ordinary mine/search balloon
 * to 9-196GB before crashing. These are the app-side backstops against it (or
 * anything shaped like it) happening again:
 *   (a) mineNow() defers while the reactor's floor-wide release gate is held
 *       (hive/locks/browser.lock present) — a mine competing with a live gate
 *       tier for CPU/memory is exactly the contention AEON-1513 hit live.
 *   (b) each mine child gets a fail-closed memory WATCHDOG (not an OS ceiling —
 *       probed directly and Darwin does not enforce RLIMIT_AS/RLIMIT_RSS on a
 *       real allocating child, see startMemoryWatchdog's doc comment in
 *       memory.ts) that kills the whole process tree the instant RSS crosses
 *       the trigger, or the instant a measurement comes back unmeasurable.
 *
 * Round 2 (Pam's CHANGES-REQUIRED + god's ruling, 2026-09-13): the first pass
 * only unit-tested the `ps` parser, never the kill/cleanup/retry branch itself
 * — "the reported 9/9 cannot distinguish this guard from dead ceiling wiring."
 * These tests prove the load-bearing branch: fail-closed on null, kill on
 * crossing the threshold, stop() actually stopping — all via node:test's
 * mock timers (no real waiting), plus one real-process integration test
 * (real spawn, real close event, real retry-path check) proving mineAgent
 * wires it all together end to end without needing gigabytes of real RSS.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const memoryModule = loadTs('src/main/memory.ts');
const { MemoryManager, readRssKb, startMemoryWatchdog } = memoryModule;

function managerWithCli(t, opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-memory-guards-'));
  const state = { bin: opts.bin ?? '/fake/bin/mempalace', enabled: opts.enabled !== false };
  const memory = new MemoryManager(() => home, () => ({ enabled: state.enabled, model: 'minilm' }));
  memory.bin = () => state.bin;
  t.after(() => { memory.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  return { memory, state, home };
}

// — gate defer —

test('mineNow defers while the reactor release gate lock is present', async (t) => {
  const { memory, home } = managerWithCli(t);
  fs.mkdirSync(path.join(home, 'hive', 'agents', 'someone'), { recursive: true });
  fs.writeFileSync(path.join(home, 'hive', 'agents', 'someone', 'memory.md'), 'hi');
  fs.mkdirSync(path.join(home, 'hive', 'locks'), { recursive: true });
  fs.writeFileSync(path.join(home, 'hive', 'locks', 'browser.lock'), '{"holder":"Dwight"}');

  let mined = false;
  memory.mineAgent = () => { mined = true; return Promise.resolve(); };

  await memory.mineNow();

  assert.equal(mined, false, 'a live-looking gate must defer the whole pass');
});

test('mineNow proceeds normally once the gate lock is gone', async (t) => {
  const { memory, home } = managerWithCli(t);
  fs.mkdirSync(path.join(home, 'hive', 'agents', 'someone'), { recursive: true });
  fs.writeFileSync(path.join(home, 'hive', 'agents', 'someone', 'memory.md'), 'hi');
  // No hive/locks/browser.lock at all — the common case.

  let mined = 0;
  memory.mineAgent = () => { mined += 1; return Promise.resolve(); };

  await memory.mineNow();

  assert.equal(mined, 1, 'no gate present — the pass must run');
});

test('gateHeld is a bare existence check (no liveness parsing)', (t) => {
  const { memory, home } = managerWithCli(t);
  const lockDir = path.join(home, 'hive', 'locks');
  fs.mkdirSync(lockDir, { recursive: true });

  assert.equal(memory.gateHeld(home), false, 'nothing written yet');

  fs.writeFileSync(path.join(lockDir, 'browser.lock'), 'not even valid json');
  assert.equal(memory.gateHeld(home), true, 'existence alone is the signal, garbage contents included');
});

// — readRssKb (the measurement primitive, not the guard itself) —

test('readRssKb parses a real ps rss= line for the current process', () => {
  const rssKb = readRssKb(process.pid);

  assert.equal(typeof rssKb, 'number');
  assert.ok(rssKb > 0, 'this test process itself has nonzero resident memory');
});

test('readRssKb returns null for a pid that does not exist', () => {
  // A pid that (almost certainly) never exists — ps exits nonzero, no rss= line.
  assert.equal(readRssKb(999999), null);
});

// — startMemoryWatchdog (the load-bearing branch itself, deterministic) —

test('watchdog kills immediately when a measurement is unmeasurable (fail-closed)', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const killed = [];

  const watchdog = startMemoryWatchdog(
    4242,
    { pollMs: 1000, triggerBytes: 8 * 1024 ** 3 },
    { readRssKb: () => null, killTree: (pid) => killed.push(pid) }
  );

  t.mock.timers.tick(1000);

  assert.deepEqual(killed, [4242], 'unmeasurable must be treated as already over budget, not skipped');
  watchdog.stop();
});

test('watchdog does not kill while under the trigger, kills once it crosses', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const killed = [];
  let rssKb = 1 * 1024 * 1024; // 1GB, well under an 8GB trigger

  const watchdog = startMemoryWatchdog(
    4242,
    { pollMs: 1000, triggerBytes: 8 * 1024 ** 3 },
    { readRssKb: () => rssKb, killTree: (pid) => killed.push(pid) }
  );

  t.mock.timers.tick(1000);
  assert.deepEqual(killed, [], 'under the trigger — must not fire');

  rssKb = 9 * 1024 * 1024; // 9GB, over the trigger
  t.mock.timers.tick(1000);
  assert.deepEqual(killed, [4242], 'over the trigger — must fire exactly once per crossing tick');

  watchdog.stop();
});

test('watchdog.stop() halts further polling — no kill after stop even if over budget', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const killed = [];

  const watchdog = startMemoryWatchdog(
    4242,
    { pollMs: 1000, triggerBytes: 1 }, // 1 byte — always over budget
    { readRssKb: () => 1024 * 1024, killTree: (pid) => killed.push(pid) }
  );
  watchdog.stop();

  t.mock.timers.tick(5000);

  assert.deepEqual(killed, [], 'stopped before any tick fired — must stay silent');
});

// — mineAgent integration: real process, injected watchdog deps, proves the
//   full kill -> cleanup -> retry wiring without allocating real memory. —

test('mineAgent kills a real child via the watchdog and re-arms the retry path', async (t) => {
  const { memory, home } = managerWithCli(t);
  const agentDir = path.join(home, 'hive', 'agents', 'watched');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'memory.md'), 'hi');

  // mineAgent runs `bin mine <agentDir> --wing <id> --agent <id>` — a real,
  // cheap, long-lived child that ignores that argv entirely and just sleeps,
  // so the test proves the KILL path fires, not that the child would have
  // exited on its own anyway.
  const sleepScript = path.join(home, 'sleep.js');
  fs.writeFileSync(sleepScript, `#!${process.execPath}\nsetTimeout(() => {}, 60000);\n`);
  fs.chmodSync(sleepScript, 0o755);
  memory.bin = () => sleepScript;

  let killedPid = null;
  let capturedChildPid = null;
  // 9GB, over the real 8GB trigger — proves the crossing logic, not just that
  // *some* number was read.
  memory.readRssKb = (pid) => { capturedChildPid = pid; return 9 * 1024 * 1024; };
  memory.killTree = (pid) => {
    killedPid = pid;
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  };

  await memory.mineNow();

  assert.ok(killedPid !== null, 'the watchdog must have called killTree');
  assert.equal(capturedChildPid, killedPid, 'killTree must be called with the same pid that was measured');
  assert.equal(
    memory.lastMined.has('watched'), false,
    'a killed mine must clear lastMined so the next tick retries it, same as a timeout'
  );
});

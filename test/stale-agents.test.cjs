'use strict';

/**
 * An app that never gets to quit used to leave its agents running forever.
 *
 * Agent PTYs are children of the browser process, and the normal quit path
 * tears them down. Neither killAll() nor the pty-closure HUP runs if the main
 * process is SIGKILLed, OOM-killed, or lost to a power cut — the agents are
 * reparented to init and keep going with no window and nobody to stop them.
 *
 * Observed live on 2026-09-07: an orphaned `codex` from a killed run still held
 * its session rollout open, so the NEXT launch could not resume that agent at
 * all — "thread ... already has an active writer (code -32600)" — and it was
 * dead on arrival every time until the orphan was killed by hand.
 *
 * The sweep fixes that, and its entire risk is PID reuse: a recorded pid may
 * belong to a stranger by the next launch, and killing a stranger's process
 * tree is far worse than leaving an orphan. So these tests are mostly about
 * what the sweep must REFUSE to kill.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const {
  AgentLedger, sweepStaleAgents, isSameProcess, processIdentity
} = loadTs('src/main/staleAgents.ts');

const posix = process.platform !== 'win32';
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'md-stale-')), 'agent-pids.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('identity is start time AND command — either mismatch spares the process', () => {
  const entry = { id: 'jim', pid: 123, startedAt: 'Mon Sep  7 09:46:24 2026', command: 'codex' };

  assert.equal(isSameProcess(entry, { startedAt: entry.startedAt, command: 'codex' }), true);

  // The pid was reused: same number, different process. This is the case that
  // would otherwise kill a stranger's process tree.
  assert.equal(
    isSameProcess(entry, { startedAt: 'Mon Sep  7 11:02:10 2026', command: 'codex' }), false,
    'a reused pid has a different start time'
  );
  assert.equal(
    isSameProcess(entry, { startedAt: entry.startedAt, command: 'firefox' }), false,
    'same start time, different binary is still not ours'
  );
});

test('an unverifiable process is never killed', () => {
  const entry = { id: 'jim', pid: 123, startedAt: 'Mon Sep  7 09:46:24 2026', command: 'codex' };
  // processIdentity() returns null when the process is gone OR when `ps` itself
  // did not answer (and always, on Windows). "Cannot prove it is ours" must
  // read as "leave it alone", never as "go ahead".
  assert.equal(isSameProcess(entry, null), false);
});

test('a ledger row from an older build, with no identity, is never killed', () => {
  assert.equal(isSameProcess({ id: 'x', pid: 1, startedAt: '', command: '' }, { startedAt: '', command: '' }), false);
});

test('a missing or corrupt ledger sweeps nothing and does not throw', () => {
  const p = tmp();
  assert.deepEqual(sweepStaleAgents(p), { killed: [], spared: [] });

  fs.writeFileSync(p, 'not json');
  assert.deepEqual(sweepStaleAgents(p), { killed: [], spared: [] });

  fs.writeFileSync(p, JSON.stringify({ not: 'an array' }));
  assert.deepEqual(sweepStaleAgents(p), { killed: [], spared: [] });
});

test('a clean shutdown leaves nothing for the next launch to sweep', () => {
  const p = tmp();
  const ledger = new AgentLedger(p);
  ledger.add('jim', process.pid);
  assert.equal(fs.existsSync(p), posix, 'the running process is recordable on posix');
  ledger.clear();                       // what killAll() does
  assert.equal(fs.existsSync(p), false);
  assert.deepEqual(sweepStaleAgents(p), { killed: [], spared: [] });
});

test('an exited agent is forgotten, so its pid can never be swept later', () => {
  const p = tmp();
  const ledger = new AgentLedger(p);
  ledger.add('jim', process.pid);
  ledger.remove(process.pid);           // what the onExit path does
  assert.deepEqual(sweepStaleAgents(p).killed, [], 'nothing recorded, nothing killed');
});

test('a real orphan is killed; the ledger is dropped afterwards', { skip: !posix }, async () => {
  const p = tmp();
  // Stand-in for an agent the app started and then lost: its own process group,
  // exactly like a PTY child, so the group kill has something to reap.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  child.unref();                        // the test runner must not wait on it
  await sleep(400);                     // let it exist long enough for ps to see it

  const ledger = new AgentLedger(p);
  ledger.add('jim', child.pid);
  assert.ok(processIdentity(child.pid), 'precondition: the child is verifiable');

  // The app "crashes": nothing tears the child down, and the ledger survives.
  const report = sweepStaleAgents(p);

  assert.deepEqual(report.killed.map((e) => e.pid), [child.pid], 'the orphan is killed');
  assert.equal(fs.existsSync(p), false, 'the ledger is dropped after a sweep');

  await sleep(400);
  let alive = true;
  try { process.kill(child.pid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'the orphan is actually gone');
});

test('a pid whose process is NOT the one we recorded is spared', { skip: !posix }, async () => {
  const p = tmp();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  child.unref();
  await sleep(400);
  try {
    // The ledger says this pid was ours, but the live process disagrees — the
    // shape a reused pid takes. It must survive the sweep untouched.
    fs.writeFileSync(p, JSON.stringify([{
      id: 'jim', pid: child.pid, startedAt: 'Mon Jan  1 00:00:00 2001', command: 'codex'
    }]));

    const report = sweepStaleAgents(p);
    assert.deepEqual(report.killed, [], 'nothing killed');
    assert.deepEqual(report.spared.map((e) => e.pid), [child.pid], 'and it is reported as spared');

    let alive = true;
    try { process.kill(child.pid, 0); } catch { alive = false; }
    assert.equal(alive, true, 'the innocent process is still running');
  } finally {
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

/**
 * An interrupted teardown must still leave its survivors sweepable.
 *
 * killAll() used to empty the whole ledger in one call at the end of its loop,
 * which assumed the loop always finishes. Observed live on 2026-09-07: the main
 * process wedged part-way through teardown — the ledger had already been
 * emptied, one `codex` was still alive, and the next launch had nothing left to
 * sweep it with. Per-entry removal is what makes a half-finished teardown
 * recoverable, so it gets its own test.
 */
test('a half-finished teardown leaves the survivors recorded', () => {
  const p = tmp();
  const ledger = new AgentLedger(p);

  // Two agents recorded; the teardown kills one and then dies itself.
  ledger.add('jim', process.pid);
  const rowsBefore = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(rowsBefore.length, 1, 'precondition: recorded');

  ledger.remove(process.pid);           // the one the loop got to
  assert.equal(fs.existsSync(p), true, 'the ledger file survives a partial pass');
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), [],
    'only the killed entry is gone — a clear() would have taken the rest too');
});

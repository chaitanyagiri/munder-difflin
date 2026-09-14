'use strict';

/**
 * AEON-1510 round 2 (Pam's CHANGES-REQUIRED, 2026-09-14): `git()`'s 8s timeout
 * used to settle its promise the instant SIGTERM was SENT, not once the
 * process actually closed. Since `enqueueGit()` chains the next queued git
 * operation onto that same promise, a process that delays or ignores SIGTERM
 * (or its own inline `gc.autoDetach=false` child) could still be touching
 * `.git/objects` while the NEXT queued operation's git process started —
 * breaking the single-writer guarantee at exactly the failure boundary the
 * whole queue exists to protect.
 *
 * Fixed: the timeout only requests termination and arms a bounded escalation
 * (SIGKILL the whole process tree via `hardKillTree`, unignorable, so `close`
 * is guaranteed within the grace window); the promise itself only settles on
 * the real `close` event.
 *
 * Per Pam's note, mock timers alone cannot prove this — the property is
 * PROCESS QUIESCENCE, not merely a timer firing. Naively comparing "when did
 * invocation 1's promise resolve" against "when did invocation 2 start" is
 * VACUOUS: the queue chain guarantees that ordering by construction whether
 * or not the underlying fix is correct (invocation 2 can only start after
 * invocation 1's promise resolves, full stop — that was never in question).
 *
 * A first attempt at an independent check used `process.kill(pid, 0)` from
 * invocation 2 to probe whether invocation 1's OS pid was still around —
 * that turned out to be a dead end: on this box a just-SIGKILLed process can
 * still answer `kill(pid, 0)` as "alive" for a few milliseconds afterward
 * (a zombie-reaping race between when Node's `close` event fires and when
 * the OS fully removes the process table entry) even though the process is
 * definitely dead and definitely not touching anything anymore. That race
 * doesn't reflect the actual safety property, so it isn't what this test
 * should measure.
 *
 * What actually matters — can invocation 1 still be DOING WORK — is measured
 * directly: invocation 1 writes a heartbeat timestamp to a shared file every
 * 20ms for as long as it's genuinely running (including while ignoring
 * SIGTERM). The instant it's SIGKILLed it can never write another heartbeat,
 * full stop, no ambiguity. Invocation 2 checks how stale that heartbeat is
 * the moment IT starts — a large gap proves invocation 1 had already stopped
 * doing work; a fresh heartbeat would mean it was still alive and running,
 * which is exactly the regression this test needs to catch.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

const HEARTBEAT_MS = 5;

/** A "git" stand-in. Always logs `start <ts>`. If SLOW=1, traps and ignores
 *  SIGTERM (only SIGKILL can end it), writes a heartbeat to HEARTBEAT_FILE
 *  every 20ms for as long as it's alive, and exits only after DELAY_MS. If
 *  CHECK_HEARTBEAT_FILE is set, it instead immediately checks how stale that
 *  heartbeat is and logs the result, then exits — invocation 2's probe. */
function writeFakeGit(dir) {
  const script = path.join(dir, 'fake-git.js');
  fs.writeFileSync(script, `#!${process.execPath}
const fs = require('fs');
const log = process.env.FAKE_GIT_LOG;
fs.appendFileSync(log, 'start ' + Date.now() + ' pid=' + process.pid + '\\n');

if (process.env.CHECK_HEARTBEAT_FILE) {
  let ageMs = -1;
  try {
    const last = Number(fs.readFileSync(process.env.CHECK_HEARTBEAT_FILE, 'utf8').trim());
    ageMs = Date.now() - last;
  } catch { ageMs = -1; } // no heartbeat file at all also counts as "stale"/never-ran
  fs.appendFileSync(log, 'heartbeat_age_ms ' + ageMs + '\\n');
  fs.appendFileSync(log, 'close ' + Date.now() + '\\n');
  process.exit(0);
} else if (process.env.FAKE_GIT_SLOW === '1') {
  process.on('SIGTERM', () => {}); // eat it — only SIGKILL can end this
  const hbFile = process.env.HEARTBEAT_FILE;
  const hbTimer = setInterval(() => { try { fs.writeFileSync(hbFile, String(Date.now())); } catch {} }, ${HEARTBEAT_MS});
  fs.writeFileSync(hbFile, String(Date.now()));
  setTimeout(() => {
    clearInterval(hbTimer);
    fs.appendFileSync(log, 'close ' + Date.now() + '\\n');
    process.exit(0);
  }, Number(process.env.FAKE_GIT_DELAY_MS || 0));
} else {
  fs.appendFileSync(log, 'close ' + Date.now() + '\\n');
  process.exit(0);
}
`, 'utf8');
  fs.chmodSync(script, 0o755);
  return script;
}

function parseLog(logPath) {
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
  return lines.map((line) => {
    const [kind, raw] = line.split(/ (.+)/);
    return { kind, raw };
  });
}

test('a queued git op that ignores SIGTERM does not let the next queued op start while it is still doing work', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-git-timeout-'));
  const logPath = path.join(dir, 'fake-git.log');
  const heartbeatFile = path.join(dir, 'heartbeat.txt');
  fs.writeFileSync(logPath, '', 'utf8');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const fakeGit = writeFakeGit(dir);
  process.env.FAKE_GIT_LOG = logPath;
  process.env.HEARTBEAT_FILE = heartbeatFile;
  t.after(() => {
    for (const k of ['FAKE_GIT_LOG', 'HEARTBEAT_FILE', 'FAKE_GIT_SLOW', 'FAKE_GIT_DELAY_MS', 'CHECK_HEARTBEAT_FILE']) delete process.env[k];
  });

  const hive = new HiveManager(() => dir);
  hive.gitBin = fakeGit;
  hive.gitTimeoutMs = 300;   // short vs 8s, but long enough for a real node child to boot and log its first line
  hive.gitKillGraceMs = 200; // ditto for the escalation window

  // Invocation 1: ignores SIGTERM, would run 3000ms unless escalated to
  // SIGKILL, heartbeating every 20ms the whole time it's genuinely alive.
  // Env set INSIDE the queued closure, not before enqueuing — closures only
  // run once their turn arrives, and a var set outside would already be
  // overwritten by invocation 2's setup by then.
  hive.enqueueGit(() => {
    process.env.FAKE_GIT_SLOW = '1';
    process.env.FAKE_GIT_DELAY_MS = '3000';
    delete process.env.CHECK_HEARTBEAT_FILE;
    return hive.git(['slow'], dir).then(() => {});
  });

  // Invocation 2: independently checks how stale invocation 1's heartbeat is
  // the instant IT starts — the actual property under test (was invocation 1
  // still doing work), not a promise-timing comparison that would pass
  // either way, and not a raw pid-liveness check (see file doc comment for
  // why that's a dead end on this box).
  hive.enqueueGit(() => {
    delete process.env.FAKE_GIT_SLOW;
    process.env.CHECK_HEARTBEAT_FILE = heartbeatFile;
    return hive.git(['fast'], dir).then(() => {});
  });

  await hive.flushGit();

  const events = parseLog(logPath);
  const starts = events.filter((e) => e.kind === 'start');
  assert.equal(starts.length, 2, 'both fake-git invocations must have actually run');

  const ageCheck = events.find((e) => e.kind === 'heartbeat_age_ms');
  assert.ok(ageCheck, 'invocation 2 must have run its heartbeat-staleness probe and logged a result');
  const ageMs = Number(ageCheck.raw);
  // A live invocation 1 heartbeats every 20ms, so a fresh (bug) heartbeat
  // would show an age well under HEARTBEAT_MS. A genuinely dead invocation 1
  // stopped heartbeating at the moment it was SIGKILLed, so its last
  // heartbeat is at least as old as the time since that kill — comfortably
  // more than one heartbeat interval by the time invocation 2 gets to run.
  assert.ok(
    ageMs > 15,
    `invocation 1's heartbeat must be stale (>15ms old) by the time invocation 2 starts — ` +
    `age=${ageMs}ms means it was still actively running (writing heartbeats) when it shouldn't have been`
  );
});

test('git() reports a timeout error (not a false success) when escalation was needed', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-git-timeout-result-'));
  const logPath = path.join(dir, 'fake-git.log');
  fs.writeFileSync(logPath, '', 'utf8');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const fakeGit = writeFakeGit(dir);
  process.env.FAKE_GIT_LOG = logPath;
  process.env.HEARTBEAT_FILE = path.join(dir, 'heartbeat.txt');
  process.env.FAKE_GIT_SLOW = '1';
  process.env.FAKE_GIT_DELAY_MS = '3000';
  t.after(() => {
    for (const k of ['FAKE_GIT_LOG', 'HEARTBEAT_FILE', 'FAKE_GIT_SLOW', 'FAKE_GIT_DELAY_MS']) delete process.env[k];
  });

  const hive = new HiveManager(() => dir);
  hive.gitBin = fakeGit;
  hive.gitTimeoutMs = 300;
  hive.gitKillGraceMs = 200;

  const start = Date.now();
  const result = await hive.git(['whatever'], dir);
  const elapsed = Date.now() - start;

  assert.equal(result.ok, false);
  assert.match(result.err, /timed out/i);
  // Resolves via escalation (timeout+grace ~= 500ms), not the process's own
  // 3000ms delay — proves the promise didn't just wait out the full delay.
  assert.ok(elapsed < 2000, `must resolve via escalation, not by waiting out the full 3000ms delay (took ${elapsed}ms)`);
});

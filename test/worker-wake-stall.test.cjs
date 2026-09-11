'use strict';
// The watchdog's blind spot: a worker that never took its first turn.
//
// Observed live 2026-09-06: a god-spawned worker sat 17 minutes on its work
// order — 0 tokens, no transcript, mail unread — and the watchdog never fired.
// Its rules infer "busy" from PTY output and "booting" from no output, but a
// TUI redraws its chrome without doing any work and the boot sequence itself is
// output. Telemetry is the CLI's own evidence of a turn: mail older than
// WORKER_WAKE_STALL_MS with no usage sample since it landed is a stalled
// worker, and the nudge goes in whatever the terminal is printing — and again
// after each cooldown, even though its ids were already announced (#358's
// edge trigger is for a worker that heard the announcement; a stalled one did
// not).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const {
  WorkerWakeWatchdog,
  isStalledWorker,
  activityEvidenceAt,
  WORKER_WAKE_IDLE_MS,
  WORKER_WAKE_STALL_MS,
  WORKER_WAKE_COOLDOWN_MS,
  WORKER_WAKE_HITL_REARM_MS
} = loadTs('src/main/workerWake.ts');

const NOW = 10_000_000; // far enough from epoch that "20 minutes ago" stays positive

/** A worker whose terminal is chatty (output 1s ago) — the shape that used to
 *  read as "mid-turn" forever. */
function chatty(overrides = {}) {
  return {
    agentId: 'stanley',
    ptyId: 'pty-stanley',
    lastOutputAt: NOW - 1_000,
    inboxIds: ['mail-1'],
    autoDeliveryPaused: false,
    paused: false,
    halted: false,
    ...overrides
  };
}

function watchdog() {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('pty-stanley', NOW - 20 * 60_000); // spawned 20 minutes ago
  return w;
}

test('isStalledWorker: old mail with no activity since it landed', () => {
  const mailAt = NOW - WORKER_WAKE_STALL_MS;
  assert.equal(isStalledWorker(chatty({ oldestMailAt: mailAt, lastActivityAt: 0 }), NOW), true);
  assert.equal(isStalledWorker(chatty({ oldestMailAt: mailAt, lastActivityAt: mailAt - 1 }), NOW), true, 'activity BEFORE the mail does not count');
  assert.equal(isStalledWorker(chatty({ oldestMailAt: mailAt, lastActivityAt: mailAt + 1 }), NOW), false, 'a turn after the mail = working it');
  assert.equal(isStalledWorker(chatty({ oldestMailAt: mailAt + 1, lastActivityAt: 0 }), NOW), false, 'younger than the stall window');
  assert.equal(isStalledWorker(chatty({ oldestMailAt: undefined, lastActivityAt: 0 }), NOW), false, 'unknown mail age → rule off (fail closed)');
  assert.equal(isStalledWorker(chatty({ oldestMailAt: 0, lastActivityAt: 0 }), NOW), false);
  assert.equal(isStalledWorker(chatty({ oldestMailAt: mailAt, lastActivityAt: 0, inboxIds: [] }), NOW), false, 'no mail, nothing to stall on');
});

test('activityEvidenceAt: only a turn counts — a zero-token sample at session start does not', () => {
  assert.equal(activityEvidenceAt({}), 0);
  assert.equal(activityEvidenceAt({ usage: null, spans: [] }), 0);
  assert.equal(activityEvidenceAt({ usage: { ts: 5_000, input: 0, output: 0 } }), 0, 'the boot-time sample');
  assert.equal(activityEvidenceAt({ usage: { ts: 5_000, input: 12, output: 0 } }), 5_000);
  assert.equal(activityEvidenceAt({ usage: { ts: 5_000, input: 0, output: 3 } }), 5_000);
  assert.equal(activityEvidenceAt({ usage: { ts: 5_000, input: 0, output: 0 }, spans: [{ ts: 7_000 }, { ts: 6_000 }] }), 7_000, 'a tool span is always a turn');
  assert.equal(activityEvidenceAt({ usage: { ts: 9_000, input: 1, output: 1 }, spans: [{ ts: 7_000 }] }), 9_000);
});

test('a worker whose only "activity" is the zero-token boot sample is stalled (the worker-holly case)', () => {
  const w = watchdog();
  const mailAt = NOW - 2 * 60_000;
  const bootSample = { ts: mailAt + 1_000, input: 0, output: 0 }; // stamped AFTER the mail
  const f = chatty({ oldestMailAt: mailAt, lastActivityAt: activityEvidenceAt({ usage: bootSample, spans: [] }) });
  assert.equal(f.lastActivityAt, 0);
  assert.equal(w.explain(f, NOW), null);
  assert.deepEqual(w.decide([f], NOW), ['stanley']);
});

test('a stalled worker is nudged even though its terminal is chatty (the 17-minute case)', () => {
  const w = watchdog();
  const f = chatty({ oldestMailAt: NOW - 17 * 60_000, lastActivityAt: 0 });
  assert.equal(w.explain(f, NOW), null);
  assert.deepEqual(w.decide([f], NOW), ['stanley']);
});

test('a stalled worker that NEVER produced output is nudged too (boot never happened)', () => {
  const w = watchdog();
  const f = chatty({ lastOutputAt: 0, oldestMailAt: NOW - 2 * 60_000, lastActivityAt: 0 });
  assert.deepEqual(w.decide([f], NOW), ['stanley']);
});

test('a stalled worker is nudged AGAIN after the cooldown although its mail ids were already announced', () => {
  const w = watchdog();
  const f = chatty({ oldestMailAt: NOW - 10 * 60_000, lastActivityAt: 0 });
  assert.deepEqual(w.decide([f], NOW), ['stanley']);
  assert.equal(w.explain(f, NOW + WORKER_WAKE_COOLDOWN_MS - 1), 'cooldown');
  assert.deepEqual(w.decide([f], NOW + WORKER_WAKE_COOLDOWN_MS), ['stanley'], 'retries every cooldown until the mail drains');
  // Once the CLI shows a turn after the mail, the edge trigger rules again:
  // same ids, already announced → held, exactly as #358 intends.
  const awake = chatty({ oldestMailAt: NOW - 10 * 60_000, lastActivityAt: NOW + WORKER_WAKE_COOLDOWN_MS + 5 });
  assert.equal(w.explain(awake, NOW + 2 * WORKER_WAKE_COOLDOWN_MS + WORKER_WAKE_IDLE_MS + 10), 'announced');
});

test('a chatty worker with a turn since the mail landed is mid-turn, not stalled', () => {
  const w = watchdog();
  const f = chatty({ oldestMailAt: NOW - 17 * 60_000, lastActivityAt: NOW - 5_000 });
  assert.equal(w.explain(f, NOW), 'mid-turn');
  assert.deepEqual(w.decide([f], NOW), []);
});

test('mail younger than the stall window keeps the original quiet-output rule', () => {
  const w = watchdog();
  const young = chatty({ oldestMailAt: NOW - 30_000, lastActivityAt: 0 });
  assert.equal(w.explain(young, NOW), 'mid-turn');
  const quiet = chatty({ oldestMailAt: NOW - 30_000, lastActivityAt: 0, lastOutputAt: NOW - WORKER_WAKE_IDLE_MS - 1 });
  assert.equal(w.explain(quiet, NOW), null);
});

test('facts without the new fields behave exactly as before (fail closed)', () => {
  const w = watchdog();
  assert.equal(w.explain(chatty(), NOW), 'mid-turn');
  assert.equal(w.explain(chatty({ lastOutputAt: 0 }), NOW), 'booting');
  const quiet = chatty({ lastOutputAt: NOW - WORKER_WAKE_IDLE_MS - 1 });
  assert.deepEqual(w.decide([quiet], NOW), ['stanley']);
  assert.equal(w.explain(quiet, NOW + WORKER_WAKE_COOLDOWN_MS + 1), 'announced', 'same mail is not re-announced (#358)');
});

test('the stall rule never overrides paused / halted / HITL / cooldown / boot grace', () => {
  const stalled = { oldestMailAt: NOW - 10 * 60_000, lastActivityAt: 0 };
  assert.equal(watchdog().explain(chatty({ ...stalled, paused: true }), NOW), 'paused');
  assert.equal(watchdog().explain(chatty({ ...stalled, halted: true }), NOW), 'halted');
  assert.equal(watchdog().explain(chatty({ ...stalled, autoDeliveryPaused: true }), NOW), 'delivery-paused');

  const hitl = watchdog();
  hitl.noteHook('stanley', 'Notification', 'Claude needs your permission to run Bash', NOW - WORKER_WAKE_HITL_REARM_MS + 1);
  assert.equal(hitl.explain(chatty(stalled), NOW), 'hitl');

  const fresh = new WorkerWakeWatchdog();
  fresh.noteSpawn('pty-stanley', NOW - 10_000);
  assert.equal(fresh.explain(chatty(stalled), NOW), 'boot-grace');
});

test('explain names every hold so the beat can log why a worker starves', () => {
  const w = watchdog();
  assert.equal(w.explain(chatty({ isGod: true }), NOW), 'god');
  assert.equal(w.explain(chatty({ inboxIds: [] }), NOW), 'no-mail');
  assert.equal(w.explain(chatty({ inboxIds: ['', 42] }), NOW), 'no-mail', 'junk ids do not count as mail');
  assert.equal(w.explain(chatty({ ptyId: undefined }), NOW), 'no-pty');
});

test('a hold is reported once per cooldown per worker, and forget() resets it', () => {
  const w = watchdog();
  assert.equal(w.shouldReportHold('stanley', NOW), true);
  assert.equal(w.shouldReportHold('stanley', NOW + 1_000), false);
  assert.equal(w.shouldReportHold('stanley', NOW + WORKER_WAKE_COOLDOWN_MS), true);
  assert.equal(w.shouldReportHold('other', NOW + 2_000), true, 'per worker');
  w.forget('stanley', 'pty-stanley');
  assert.equal(w.shouldReportHold('stanley', NOW + WORKER_WAKE_COOLDOWN_MS + 1_000), true);
});

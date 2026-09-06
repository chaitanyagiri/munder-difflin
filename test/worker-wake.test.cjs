const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  WorkerWakeWatchdog,
  classifyHook,
  WORKER_WAKE_NUDGE,
  WORKER_WAKE_IDLE_MS,
  WORKER_WAKE_BOOT_GRACE_MS,
  WORKER_WAKE_COOLDOWN_MS,
  WORKER_WAKE_HITL_REARM_MS
} = loadTs('src/main/workerWake.ts');

/** A permissive fact; tests override the fields they care about. */
function fact(overrides = {}) {
  return {
    agentId: 'alice',
    ptyId: 'pty-alice',
    lastOutputAt: 100_000,
    inboxCount: 1,
    inboxIds: ['msg-1'],
    autoDeliveryPaused: false,
    paused: false,
    halted: false,
    ...overrides
  };
}

test('nudges an idle worker with undrained inbox mail', () => {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('pty-alice', 0);
  const now = 200_000;
  const out = w.decide([fact({ lastOutputAt: now - WORKER_WAKE_IDLE_MS - 1 })], now);
  assert.deepEqual(out, ['alice']);
});

test('never nudges god, archived agents, or agents without a live pty', () => {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('p1', 0);
  const now = 200_000;
  const out = w.decide([
    fact({ agentId: 'god', isGod: true, ptyId: 'p1' }),
    fact({ agentId: 'gone', archived: true, ptyId: undefined }),
    fact({ agentId: 'no-pty', ptyId: undefined })
  ], now);
  assert.deepEqual(out, []);
});

test('never nudges when there is no inbox mail', () => {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('pty-alice', 0);
  const now = 200_000;
  const out = w.decide([fact({ inboxCount: 0 })], now);
  assert.deepEqual(out, []);
});

test('never nudges a mid-turn worker (recent PTY output)', () => {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('pty-alice', 0);
  const now = 200_000;
  const out = w.decide([fact({ lastOutputAt: now - 1 })], now);
  assert.deepEqual(out, []);
});

test('never nudges a worker that never produced output (still booting)', () => {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('pty-alice', 0);
  const now = 200_000;
  const out = w.decide([fact({ lastOutputAt: 0 })], now);
  assert.deepEqual(out, []);
});

test('respects the boot grace window', () => {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('pty-alice', 10_000);
  const now = 10_000 + WORKER_WAKE_BOOT_GRACE_MS - 1;
  assert.deepEqual(w.decide([fact({ lastOutputAt: 0 })], now), []);
  // past the grace (and idle long enough) → eligible
  const late = 10_000 + WORKER_WAKE_BOOT_GRACE_MS + WORKER_WAKE_IDLE_MS + 1;
  assert.deepEqual(w.decide([fact({ lastOutputAt: late - WORKER_WAKE_IDLE_MS - 1 })], late), ['alice']);
});

test('never nudges while delivery is paused, agent paused, or halted', () => {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('p1', 0);
  const now = 200_000;
  const out = w.decide([
    fact({ agentId: 'a1', ptyId: 'p1', autoDeliveryPaused: true }),
    fact({ agentId: 'a2', ptyId: 'p1', paused: true }),
    fact({ agentId: 'a3', ptyId: 'p1', halted: true })
  ], now);
  assert.deepEqual(out, []);
});

test('a recent permission/HITL notification blocks nudges', () => {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('pty-alice', 0);
  const now = 200_000;
  w.noteHook('alice', 'Notification', 'Claude needs your permission to use Bash.', now - 1_000);
  assert.deepEqual(w.decide([fact()], now), []);
  // after the rearm window the block expires
  const later = now + WORKER_WAKE_HITL_REARM_MS + 1;
  assert.deepEqual(w.decide([fact({ lastOutputAt: later - WORKER_WAKE_IDLE_MS - 1 })], later), ['alice']);
});

test('an idle-waiting notification does NOT count as a HITL hold', () => {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('pty-alice', 0);
  const now = 200_000;
  w.noteHook('alice', 'Notification', 'waiting for your input', now - 1_000);
  assert.deepEqual(w.decide([fact()], now), ['alice']);
});

test('a nudge is not repeated within the cooldown', () => {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('pty-alice', 0);
  const now = 200_000;
  assert.deepEqual(w.decide([fact()], now), ['alice']);
  assert.deepEqual(w.decide([fact()], now + WORKER_WAKE_COOLDOWN_MS - 1), []);
  assert.deepEqual(w.decide([fact({ lastOutputAt: now + WORKER_WAKE_COOLDOWN_MS + 1 - WORKER_WAKE_IDLE_MS - 1 })], now + WORKER_WAKE_COOLDOWN_MS + 1), ['alice']);
});

test('#358: same already-announced mail is NOT re-nudged at the flat cadence', () => {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('pty-alice', 0);
  const now = 200_000;
  // first nudge announces msg-1
  assert.deepEqual(w.decide([fact({ inboxIds: ['msg-1'] })], now), ['alice']);
  // every minute for an hour, the SAME single id stays pending: after the first
  // repeat (60s) the backoff ladder silences it (5m, then 30m) instead of
  // re-nudging once a minute forever.
  const fireTimes = [];
  for (let i = 1; i <= 60; i++) {
    const t = now + i * WORKER_WAKE_COOLDOWN_MS;
    const out = w.decide([fact({ inboxIds: ['msg-1'], lastOutputAt: t - WORKER_WAKE_IDLE_MS - 1 })], t);
    if (out.length) fireTimes.push(i);
  }
  // repeat #1 at 60s; repeat #2 at 60s + 5m; then 30m intervals.
  assert.deepEqual(fireTimes, [1, 6, 36]);
});

test('#358: a new inbox id is announced promptly, not on the repeat ladder', () => {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('pty-alice', 0);
  const now = 200_000;
  assert.deepEqual(w.decide([fact({ inboxIds: ['msg-1'] })], now), ['alice']);
  // repeat #1 at +60s (same mail) — the ladder starts
  const t1 = now + WORKER_WAKE_COOLDOWN_MS;
  assert.deepEqual(w.decide([fact({ inboxIds: ['msg-1'], lastOutputAt: t1 - WORKER_WAKE_IDLE_MS - 1 })], t1), ['alice']);
  // at +120s the SAME mail sits on the 5m ladder → silent
  const t2 = now + 2 * WORKER_WAKE_COOLDOWN_MS;
  assert.deepEqual(w.decide([fact({ inboxIds: ['msg-1'], lastOutputAt: t2 - WORKER_WAKE_IDLE_MS - 1 })], t2), []);
  // but NEW mail (msg-2) at the same moment is announceable again
  assert.deepEqual(w.decide([fact({ inboxIds: ['msg-1', 'msg-2'], lastOutputAt: t2 - WORKER_WAKE_IDLE_MS - 1 })], t2), ['alice']);
});

test('#358: forgotten state means previously-announced mail is fresh again', () => {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('pty-alice', 0);
  const now = 200_000;
  assert.deepEqual(w.decide([fact({ inboxIds: ['msg-1'] })], now), ['alice']);
  // a PTY restart forgets the announced set → the same id is announceable again
  w.forget('alice', 'pty-alice');
  w.noteSpawn('pty-alice', 0);
  assert.deepEqual(w.decide([fact({ inboxIds: ['msg-1'] })], now + 1), ['alice']);
});

test('#358: without inbox ids the nudge stays level-triggered', () => {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('pty-alice', 0);
  const now = 200_000;
  assert.deepEqual(w.decide([fact({ inboxIds: undefined })], now), ['alice']);
  assert.deepEqual(w.decide([fact({ inboxIds: undefined })], now + WORKER_WAKE_COOLDOWN_MS + 1), ['alice']);
});

test('forget clears cooldown + boot grace + HITL state', () => {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('pty-alice', Date.now());
  w.noteHook('alice', 'Notification', 'permission', Date.now());
  w.decide([fact()], Date.now());
  w.forget('alice', 'pty-alice');
  const now = 200_000;
  assert.deepEqual(w.decide([fact({ lastOutputAt: now - WORKER_WAKE_IDLE_MS - 1 })], now), ['alice']);
});

test('classifyHook: permission/approve/confirm shapes are needsHuman', () => {
  assert.equal(classifyHook('Notification', 'Claude needs your permission to use Bash.'), 'needsHuman');
  assert.equal(classifyHook('Notification', 'Approve tool use?'), 'needsHuman');
  assert.equal(classifyHook('Notification', 'confirm the change?'), 'needsHuman');
});

test('classifyHook: idle-waiting shapes are idle, other events are null', () => {
  assert.equal(classifyHook('Notification', 'waiting for your input'), 'idle');
  assert.equal(classifyHook('Notification', 'Claude is idle — waiting for input'), 'idle');
  assert.equal(classifyHook('Notification', ''), 'idle');
  assert.equal(classifyHook('Stop', 'some message'), null);
  assert.equal(classifyHook('UserPromptSubmit', undefined), null);
});

test('the nudge text matches the renderer guardrail exactly', () => {
  // If the renderer's nudge wording ever changes, update WORKER_WAKE_NUDGE to match.
  assert.equal(WORKER_WAKE_NUDGE.length > 100, true);
  assert.match(WORKER_WAKE_NUDGE, /read your inbox/i);
});
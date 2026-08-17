'use strict';

/**
 * #151 — worker inbox-wake watchdog (main-process half). A worker whose pty has
 * gone quiet while inbox mail sits undrained must be re-woken from MAIN: the
 * renderer's wake is a single timer with a single-shot dedup, and one missed
 * tick used to strand the mail until a full app restart.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { inboxWakeTick, WAKE_QUIET_MS, WAKE_RETRY_MS, HOOK_STALE_MS } = loadTs('src/main/inboxWake.ts');

const QUIET = WAKE_QUIET_MS + 1;

function deps(over = {}) {
  return {
    agents: { god: {}, w1: {} },
    godId: 'god',
    ptyFor: (id) => (id === 'god' || id === 'w1' ? `pty-${id}` : undefined),
    hookIdleFor: () => null, // hookless by default — pty recency decides
    idleFor: () => QUIET,
    inboxIds: (id) => (id === 'w1' ? ['2026-01-01T00-00-aaa'] : []),
    ...over
  };
}

test('fires for a quiet worker holding undrained mail', () => {
  const fires = inboxWakeTick(deps(), new Map(), 1_000_000);
  assert.equal(fires.length, 1);
  assert.equal(fires[0].agentId, 'w1');
  assert.equal(fires[0].newestId, '2026-01-01T00-00-aaa');
  assert.deepEqual(fires[0].inboxIds, ['2026-01-01T00-00-aaa'], 'renderer syncs its per-id dedup from these');
  assert.equal(fires[0].idleSource, 'pty', 'hookless — pty recency decided');
  assert.equal(fires[0].count, 1);
});

test('never fires for god, archived agents, or agents with no live pty', () => {
  const d = deps({
    agents: { god: {}, w1: { archived: true }, w2: {} },
    ptyFor: (id) => (id === 'god' ? 'pty-god' : undefined), // w2 has no pty
    inboxIds: () => ['mail-1'] // everyone "has" mail — none may fire
  });
  assert.equal(inboxWakeTick(d, new Map(), 1_000_000).length, 0);
});

test('a pty with recent output is mid-turn and is left alone (hookless)', () => {
  const d = deps({ idleFor: () => WAKE_QUIET_MS - 1 });
  assert.equal(inboxWakeTick(d, new Map(), 1_000_000).length, 0);
});

test('hook-idle wins over a constantly-repainting TUI (the claude idle prompt)', () => {
  // Observed live: an idle claude CLI repaints its prompt continuously, so pty
  // output recency reads "busy" forever. The Stop hook is the real signal.
  const d = deps({ hookIdleFor: () => QUIET, idleFor: () => 0 });
  assert.equal(inboxWakeTick(d, new Map(), 1_000_000).length, 1);
});

test('hook-busy (a turn in flight or a HITL prompt) never fires while the pty silence is plausible', () => {
  // A legitimately long QUIET tool call (a slow build emitting nothing): the
  // hook state says mid-turn and the silence is under HOOK_STALE_MS, so the
  // watchdog stays out of the way.
  const d = deps({ hookIdleFor: () => 0, idleFor: () => HOOK_STALE_MS - 1 });
  assert.equal(inboxWakeTick(d, new Map(), 1_000_000).length, 0);
});

test('a HUNG turn is not invisible: pty silence past HOOK_STALE_MS overrides a stuck busy hook', () => {
  // The CLI hangs, crashes without a Stop, or its hook delivery fails: hookIdleFor
  // returns 0 forever. A genuinely working turn keeps the pty emitting, so an
  // hour of true silence is the tell — the watchdog must still fire.
  const d = deps({ hookIdleFor: () => 0, idleFor: () => HOOK_STALE_MS + 1 });
  const fires = inboxWakeTick(d, new Map(), 1_000_000);
  assert.equal(fires.length, 1);
  assert.equal(fires[0].idleSource, 'pty', 'labeled as the override, not as hook idleness');
  assert.equal(fires[0].idleMs, HOOK_STALE_MS + 1);
});

test('the same undrained mail re-fires only after the retry window', () => {
  const state = new Map();
  const now = 1_000_000;
  assert.equal(inboxWakeTick(deps(), state, now).length, 1, 'first firing');
  assert.equal(inboxWakeTick(deps(), state, now + 60_000).length, 0, 'suppressed inside the window');
  const again = inboxWakeTick(deps(), state, now + WAKE_RETRY_MS + 1);
  assert.equal(again.length, 1, 're-fires once the window passes — the retry the renderer never had');
});

test('NEW mail re-fires immediately, even inside the retry window', () => {
  const state = new Map();
  const now = 1_000_000;
  inboxWakeTick(deps(), state, now);
  const d = deps({ inboxIds: () => ['2026-01-01T00-00-aaa', '2026-01-02T00-00-bbb'] });
  const fires = inboxWakeTick(d, state, now + 10_000);
  assert.equal(fires.length, 1);
  assert.equal(fires[0].newestId, '2026-01-02T00-00-bbb');
  assert.equal(fires[0].count, 2);
});

test('a drained inbox clears the per-agent state so later mail fires fresh', () => {
  const state = new Map();
  const now = 1_000_000;
  inboxWakeTick(deps(), state, now);
  assert.ok(state.has('w1'));
  inboxWakeTick(deps({ inboxIds: () => [] }), state, now + 10_000);
  assert.ok(!state.has('w1'), 'drained — forgotten');
  const fires = inboxWakeTick(deps(), state, now + 20_000);
  assert.equal(fires.length, 1, 'the same id arriving again is new mail, not a suppressed retry');
});

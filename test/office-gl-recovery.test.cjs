/**
 * The blank-office bug.
 *
 * Chromium caps live WebGL contexts per renderer process (~16) and evicts the
 * OLDEST when a new one pushes past the cap. The office floor's context is
 * created at app startup, so it is always the oldest; every terminal xterm opens
 * takes another one (@xterm/addon-webgl). On a busy floor the office is evicted,
 * Pixi says nothing at all, and the canvas is blank until the app restarts.
 *
 * CONFIRMED against the shipped v0.3.5 build over CDP: creating 24 extra WebGL
 * contexts produced "WARNING: Too many active WebGL contexts. Oldest context will
 * be lost." and fired `webglcontextlost` on the office canvas, while the terminal
 * logged its own graceful "[terminal] webgl context lost — falling back to DOM
 * renderer". The office had no such fallback. These tests pin the one it has now.
 */
const test = require('node:test');
const assert = require('node:assert');
const load = require('./load-ts.cjs');

const {
  installContextLossRecovery, DEFAULT_MAX_REBUILDS, DEFAULT_REBUILD_DELAY_MS,
  isContextUnavailableError, planInitFailure, DEFAULT_MAX_INIT_RETRIES
} = load('src/renderer/src/scene/office/glRecovery.ts');

/** A canvas stand-in: EventTarget is all the recovery code touches. */
function fakeCanvas() { return new EventTarget(); }
function lose(canvas) {
  // cancelable so defaultPrevented actually reports whether preventDefault ran —
  // that call is what allows the browser to hand the context back at all.
  const e = new Event('webglcontextlost', { cancelable: true });
  canvas.dispatchEvent(e);
  return e;
}
/** Collect scheduled callbacks instead of waiting on real timers. */
function fakeClock() {
  const queue = [];
  return {
    schedule: (fn, ms) => { queue.push({ fn, ms }); return queue.length; },
    runAll: () => { const q = queue.splice(0); q.forEach((j) => j.fn()); return q; },
    get pending() { return queue.length; },
    get delays() { return queue.map((j) => j.ms); }
  };
}

test('a lost context rebuilds the scene instead of leaving it blank', () => {
  const canvas = fakeCanvas();
  const clock = fakeClock();
  let rebuilds = 0;
  installContextLossRecovery(canvas, { onRebuild: () => rebuilds++, schedule: clock.schedule, log: () => {} });

  lose(canvas);
  assert.equal(rebuilds, 0, 'rebuild must be deferred, not immediate');
  assert.equal(clock.pending, 1);
  clock.runAll();
  assert.equal(rebuilds, 1, 'the scene never came back');
});

test('preventDefault is called — without it the context is gone for good', () => {
  const canvas = fakeCanvas();
  installContextLossRecovery(canvas, { onRebuild: () => {}, schedule: () => {}, log: () => {} });
  assert.equal(lose(canvas).defaultPrevented, true);
});

test('the rebuild is delayed so it does not race the eviction storm', () => {
  const canvas = fakeCanvas();
  const clock = fakeClock();
  installContextLossRecovery(canvas, { onRebuild: () => {}, schedule: clock.schedule, log: () => {} });
  lose(canvas);
  // Several contexts are usually created at once; claiming one straight back
  // just loses it again to the next terminal in the same burst.
  assert.ok(clock.delays[0] >= 500, `rebuild delay too short: ${clock.delays[0]}`);
  assert.equal(clock.delays[0], DEFAULT_REBUILD_DELAY_MS);
});

test('retries are capped, then it gives up LOUDLY rather than staying blank', () => {
  const canvas = fakeCanvas();
  const clock = fakeClock();
  let rebuilds = 0, gaveUp = 0;
  const logs = [];
  installContextLossRecovery(canvas, {
    onRebuild: () => rebuilds++, onGiveUp: () => gaveUp++,
    schedule: clock.schedule, log: (m) => logs.push(m)
  });

  for (let i = 0; i < DEFAULT_MAX_REBUILDS; i++) { lose(canvas); clock.runAll(); }
  assert.equal(rebuilds, DEFAULT_MAX_REBUILDS);
  assert.equal(gaveUp, 0, 'gave up while it still had budget');

  lose(canvas);
  clock.runAll();
  assert.equal(gaveUp, 1, 'a silently blank canvas is the bug — it must surface');
  assert.equal(rebuilds, DEFAULT_MAX_REBUILDS, 'kept rebuilding past the cap');

  // And it stays given-up: no infinite fight for a context we cannot keep.
  lose(canvas); clock.runAll();
  assert.equal(gaveUp, 1);
  assert.equal(rebuilds, DEFAULT_MAX_REBUILDS);
  assert.ok(logs.some((m) => /giving up/i.test(m)), 'nothing explains the blank floor');
});

test('uninstalling stops recovery — a torn-down scene must not resurrect itself', () => {
  const canvas = fakeCanvas();
  const clock = fakeClock();
  let rebuilds = 0;
  const off = installContextLossRecovery(canvas, { onRebuild: () => rebuilds++, schedule: clock.schedule, log: () => {} });

  // Loss already in flight when the component unmounts: the queued rebuild must
  // not fire against a destroyed Pixi app.
  lose(canvas);
  off();
  clock.runAll();
  assert.equal(rebuilds, 0, 'rebuilt after teardown');

  lose(canvas);
  assert.equal(clock.pending, 0, 'still listening after uninstall');
});

/**
 * The blank-office bug, second half: losing the context is survivable, but
 * NOT GETTING ONE IN THE FIRST PLACE was fatal.
 *
 * installContextLossRecovery() is wired up AFTER `app.init()` resolves, so it
 * never sees the case where the REBUILD it schedules cannot get a context
 * either. When the GPU process dies (a driver reset, a TDR, a Chromium GPU
 * crash) the floor loses its context, the rebuild fires 1500ms later, and the
 * GPU process is still coming back. getContext() returns null and Pixi throws
 *
 *   Error: This browser does not support WebGL. Try using the canvas renderer
 *       at _GlContextSystem.createContext (WebGLRenderer...)
 *       at async _Application.init (index...)
 *
 * which OfficeFloor painted onto the floor as a wall of minified frames, where
 * it stayed until the whole app was restarted. The browser supports WebGL
 * perfectly well; it just asked a second too early.
 *
 * CONFIRMED against the shipped v0.4.5 build over CDP on Windows/Intel UHD by
 * killing the app's --type=gpu-process out from under a live floor: it logged
 * the rebuild, and the rebuild produced exactly the stack above.
 *
 * Eviction pressure alone does NOT get here, which is why this is a separate
 * failure and not the one above: a getContext() that pushes past the ~16-context
 * cap evicts somebody else and succeeds, so the rebuild always wins its slot
 * back. Verified the same way — 24 held contexts plus a steady drip produced
 * eviction, a rebuild, and a healthy floor.
 */

test('Pixi\'s "does not support WebGL" is read as a busy GPU, not a dead browser', () => {
  // The verbatim message Pixi 8 throws out of GlContextSystem.createContext.
  assert.equal(isContextUnavailableError(
    new Error('This browser does not support WebGL. Try using the canvas renderer')), true);
  // Wording varies across Pixi/Chromium versions, so match the family.
  assert.equal(isContextUnavailableError(new Error('WebGL not supported')), true);
  assert.equal(isContextUnavailableError(new Error('WebGPU is not available')), true);
  assert.equal(isContextUnavailableError(new Error('Unable to create a WebGL context')), true);
  assert.equal(isContextUnavailableError(new Error('Failed to get rendering context')), true);
  // Wrapped by a caller that added its own framing.
  assert.equal(isContextUnavailableError(
    new Error('renderer boot failed', { cause: new Error('WebGL not supported') })), true);
});

test('a broken theme or texture is NOT mistaken for a busy GPU', () => {
  // Retrying these would just hide a real bug behind a 6-second delay.
  assert.equal(isContextUnavailableError(new Error('failed to load tileset office.png')), false);
  assert.equal(isContextUnavailableError(new Error('theme bundle is malformed')), false);
  assert.equal(isContextUnavailableError(new TypeError('map.tilesets is not iterable')), false);
  assert.equal(isContextUnavailableError(undefined), false);
  assert.equal(isContextUnavailableError(null), false);
});

test('an init that could not get a context retries instead of printing a stack', () => {
  const err = new Error('This browser does not support WebGL. Try using the canvas renderer');
  const plan = planInitFailure(err, 0);
  assert.equal(plan.action, 'retry', 'a stack trace on the floor is the bug');
  assert.equal(plan.attempt, 1);
  // Same reasoning as the rebuild delay: contexts free up as terminals close,
  // and asking again inside the same burst just fails again.
  assert.ok(plan.delayMs >= 500, `init retry delay too short: ${plan.delayMs}`);
  assert.equal(plan.delayMs, DEFAULT_REBUILD_DELAY_MS);
});

test('init retries are capped, then it says something a human can act on', () => {
  const err = new Error('This browser does not support WebGL. Try using the canvas renderer');
  for (let used = 0; used < DEFAULT_MAX_INIT_RETRIES; used++) {
    assert.equal(planInitFailure(err, used).action, 'retry', `gave up with budget left (used ${used})`);
    assert.equal(planInitFailure(err, used).attempt, used + 1);
  }
  assert.equal(planInitFailure(err, DEFAULT_MAX_INIT_RETRIES).action, 'give-up');
  assert.equal(planInitFailure(err, DEFAULT_MAX_INIT_RETRIES + 9).action, 'give-up');
});

test('a real init bug is reported immediately and never retried', () => {
  const bug = new TypeError('map.tilesets is not iterable');
  assert.equal(planInitFailure(bug, 0).action, 'report');
  // Still 'report' deep into the budget: retry count must not turn a bug into a
  // "close some terminals" message that sends the user chasing the wrong thing.
  assert.equal(planInitFailure(bug, DEFAULT_MAX_INIT_RETRIES).action, 'report');
});

test('recovery survives repeated losses across rebuilds, one budget per install', () => {
  const canvas = fakeCanvas();
  const clock = fakeClock();
  let rebuilds = 0;
  installContextLossRecovery(canvas, { onRebuild: () => rebuilds++, schedule: clock.schedule, log: () => {}, maxRebuilds: 1 });
  lose(canvas); clock.runAll();
  assert.equal(rebuilds, 1);
  // A fresh install (what the next mount does) gets its own budget.
  const canvas2 = fakeCanvas();
  installContextLossRecovery(canvas2, { onRebuild: () => rebuilds++, schedule: clock.schedule, log: () => {}, maxRebuilds: 1 });
  lose(canvas2); clock.runAll();
  assert.equal(rebuilds, 2);
});

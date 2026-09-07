'use strict';

/**
 * A dead renderer used to be invisible to the app, and permanent.
 *
 * Observed live on 2026-09-07 (v0.4.6, packaged AppImage, Hyprland/Wayland):
 * after ~25 minutes running a five-agent hive, the compositor raised
 * "Munder Difflin is not responding". `/proc` held the browser process, both
 * zygotes, the GPU process and the network service — and no renderer at all.
 * The window stayed mapped on its last painted frame while the main process
 * carried on routing the hive. `createWindow` bound no 'render-process-gone'
 * and no 'unresponsive', so nothing reloaded the window and nothing recorded
 * the death; the compositor's "Terminate" was the user's only way out, and it
 * would have killed every agent PTY along with the browser process.
 *
 * These tests pin the properties that make the recovery safe:
 *   1. an occasional crash always gets an automatic reload;
 *   2. a crash LOOP cannot become a reload loop — the budget is finite;
 *   3. the budget is a rolling window, so a long-lived session recovers again
 *      later instead of being permanently spent;
 *   4. deliberate teardown ('clean-exit', 'killed') is never "recovered" — a
 *      window we meant to close must not be resurrected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

// rendererHealth.ts imports `electron` at module scope for the wiring half of
// the file. The pure half under test needs none of it, so resolve the bare
// specifier to a stub rather than dragging the real binary in.
const stubs = new Map([['electron', {
  app: { getPath: () => path.join(require('node:os').tmpdir(), 'md-health-test'), on: () => {} },
  dialog: { showMessageBox: async () => ({ response: 1 }) }
}]]);
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (stubs.has(request)) return request;
  return origResolve.call(this, request, ...rest);
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (stubs.has(request)) return stubs.get(request);
  return origLoad.call(this, request, ...rest);
};

const loadTs = require('./load-ts.cjs');
const {
  ReloadBudget, BUDGET_LIMIT, BUDGET_WINDOW_MS,
  canPromptRenderer, shouldRecoverFrom, markRendererDead, markRendererAlive
} = loadTs('src/main/rendererHealth.ts');

/** A budget on a clock we control, so the rolling window is testable without
 *  waiting ten real minutes. */
function budgetAt(clock) {
  return new ReloadBudget(BUDGET_LIMIT, BUDGET_WINDOW_MS, () => clock.now);
}

test('a crashed renderer is reloaded — the window is never left frozen', () => {
  const clock = { now: 0 };
  const budget = budgetAt(clock);
  assert.equal(budget.allows(), true);
  assert.equal(budget.take(), true, 'the first crash must always be recovered');
});

test('a crash loop cannot become a reload loop', () => {
  const clock = { now: 0 };
  const budget = budgetAt(clock);
  for (let i = 0; i < BUDGET_LIMIT; i++) {
    assert.equal(budget.take(), true, `reload ${i + 1} is within budget`);
    clock.now += 500; // a renderer dying immediately on load
  }
  assert.equal(budget.allows(), false);
  assert.equal(budget.take(), false, 'past the budget we stop and ask instead');
  assert.equal(budget.used(), BUDGET_LIMIT);
});

test('the budget is a rolling window, not a lifetime quota', () => {
  const clock = { now: 0 };
  const budget = budgetAt(clock);
  for (let i = 0; i < BUDGET_LIMIT; i++) budget.take();
  assert.equal(budget.take(), false, 'spent inside the window');

  // A session left running for hours must still recover from a later, unrelated
  // crash — otherwise the first bad minute disables recovery for the whole day.
  clock.now += BUDGET_WINDOW_MS + 1;
  assert.equal(budget.used(), 0, 'old crashes age out of the window');
  assert.equal(budget.take(), true, 'a later crash is recovered again');
});

test('reload accounting only counts what it consumed', () => {
  const clock = { now: 0 };
  const budget = budgetAt(clock);
  budget.allows();
  budget.allows();
  assert.equal(budget.used(), 0, 'allows() must be read-only');
  budget.take();
  assert.equal(budget.used(), 1);
});

/**
 * The quit wedge, same root cause.
 *
 * Both quit paths (app 'before-quit' and the primary window's 'close') cancel
 * the quit and ask the RENDERER to draw the "you have running terminals"
 * warning. With the renderer dead there is nobody to answer: nothing sets the
 * allow-quit latch, so every later quit is cancelled the same way. Observed
 * live on 2026-09-07 — the frozen window survived SIGTERM and needed SIGKILL.
 *
 * The trap is that Electron keeps the WebContents object alive after its render
 * process dies, so the obvious guard (`isDestroyed()`) still reports false. Only
 * `isCrashed()` tells the truth, which is exactly what these tests pin.
 */

/** Minimal stand-in for a BrowserWindow: only the three flags the guard reads. */
function fakeWin({ destroyed = false, wcDestroyed = false, crashed = false } = {}) {
  return {
    isDestroyed: () => destroyed,
    webContents: { isDestroyed: () => wcDestroyed, isCrashed: () => crashed }
  };
}

test('a healthy window is still asked to confirm the quit', () => {
  assert.equal(canPromptRenderer(fakeWin()), true);
});

test('a CRASHED renderer is not asked — this is the SIGTERM wedge', () => {
  // isDestroyed() stays false after the render process dies; only isCrashed()
  // reports it. A guard that checked destruction alone would still cancel the
  // quit here, and the window would stay unclosable.
  const win = fakeWin({ crashed: true });
  assert.equal(win.isDestroyed(), false, 'precondition: the window object survives');
  assert.equal(win.webContents.isDestroyed(), false, 'precondition: so does the WebContents');
  assert.equal(canPromptRenderer(win), false, 'a crashed renderer cannot answer, so do not ask');
});

test('a torn-down window or WebContents is not asked either', () => {
  assert.equal(canPromptRenderer(fakeWin({ destroyed: true })), false);
  assert.equal(canPromptRenderer(fakeWin({ wcDestroyed: true })), false);
  assert.equal(canPromptRenderer(null), false, 'no window at all: quit, do not hang');
});

/**
 * Which deaths get recovered.
 *
 * 'killed' is the one that matters and the one that is easy to get wrong. It
 * reads like deliberate teardown, but Chromium reports it for ANY signal death
 * — the kernel OOM killer included, which is the likeliest way a renderer dies
 * under a busy hive. Verified against Electron on 2026-09-07: SIGKILL to the
 * render process reports { reason: 'killed', exitCode: 9 }. An earlier draft of
 * this fix excluded it, and the window stayed frozen exactly as before.
 */
test("'killed' is recovered — it is what an OOM kill reports", () => {
  assert.equal(shouldRecoverFrom('killed'), true);
});

test('genuine crashes are recovered', () => {
  for (const reason of ['crashed', 'oom', 'abnormal-exit', 'launch-failed', 'integrity-failure']) {
    assert.equal(shouldRecoverFrom(reason), true, `${reason} should be recovered`);
  }
});

test('a clean exit is NOT "recovered" — that window meant to close', () => {
  assert.equal(shouldRecoverFrom('clean-exit'), false);
});

/**
 * Our own observation of the death is what the guard trusts first.
 *
 * isCrashed() is documented to report a dead render process, but relying on it
 * alone was not enough in practice: measured against Electron 32 on 2026-09-07,
 * a window whose renderer had been SIGKILLed still passed an isCrashed()-only
 * guard, so the quit was cancelled and the app stayed unquittable — the exact
 * bug this was meant to fix. `render-process-gone` is a fact we witness, so the
 * guard consults that record before asking Electron.
 */
test('a window marked dead is not prompted, even if isCrashed() lies', () => {
  const win = fakeWin();                       // isCrashed() === false
  assert.equal(canPromptRenderer(win), true, 'precondition: it looks healthy');
  markRendererDead(win);
  assert.equal(canPromptRenderer(win), false, 'our own observation wins');
});

test('a reloaded renderer is prompted again', () => {
  const win = fakeWin();
  markRendererDead(win);
  assert.equal(canPromptRenderer(win), false);
  markRendererAlive(win);                      // did-finish-load after a reload
  assert.equal(canPromptRenderer(win), true, 'recovery must restore the warning');
});

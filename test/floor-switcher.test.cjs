'use strict';

/**
 * Floors already ran in parallel — each window owns its own PTYs, and
 * `backgroundThrottling: false` keeps an occluded floor's heartbeat loops
 * running. What was missing was any way to reach a particular one.
 *
 * The non-obvious half of that: every floor was called "Munder Difflin".
 * `createWindow` passes `title: 'Munder Difflin — Floor'`, but
 * src/renderer/index.html carries `<title>Munder Difflin</title>`, and in
 * Electron the PAGE title wins as soon as it loads — silently, with no error.
 * Verified on 2026-09-07 against a running build: every open window reported the
 * same title to the compositor, so the window manager's own switcher could not
 * tell them apart either. That is why the fix re-applies the title after load
 * and refuses `page-title-updated`, rather than trusting the constructor.
 *
 * These tests pin the naming and the cycling, which is where the behaviour lives.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  PRIMARY_TITLE, floorTitle, floorMenuLabel, floorAccelerator, cycleFloorIndex
} = loadTs('src/main/floors.ts');

test('the primary keeps the bare product name; floors are numbered from 2', () => {
  // Renaming the primary to "Floor 1" would be a downgrade — it is the window
  // users think of as "the app".
  assert.equal(floorTitle(0), PRIMARY_TITLE);
  assert.equal(floorTitle(1), 'Munder Difflin — Floor 2');
  assert.equal(floorTitle(2), 'Munder Difflin — Floor 3');
});

test('every floor gets a DISTINCT title — the whole point of the change', () => {
  const titles = [0, 1, 2, 3].map(floorTitle);
  assert.equal(new Set(titles).size, titles.length, 'titles must be unique');
});

test('the menu row reads the same way as the key that reaches it', () => {
  assert.equal(floorMenuLabel(0), `1  ${PRIMARY_TITLE}`);
  assert.equal(floorAccelerator(0), 'CmdOrCtrl+Alt+1');
  assert.equal(floorMenuLabel(1), '2  Munder Difflin — Floor 2');
  assert.equal(floorAccelerator(1), 'CmdOrCtrl+Alt+2');
});

test('accelerators stop at 9 rather than binding nonsense', () => {
  assert.equal(floorAccelerator(8), 'CmdOrCtrl+Alt+9');
  assert.equal(floorAccelerator(9), undefined, 'a 10th floor is clickable, not bound');
});

test('the accelerator avoids keys an agent TUI might want', () => {
  // A menu accelerator is claimed BEFORE the focused element sees the key, and
  // these windows are mostly full of agent TUIs. Ctrl+1 is plausible TUI input;
  // Ctrl+Alt+1 is not. Browser-style Ctrl+<n> would have stolen keystrokes.
  for (let i = 0; i < 9; i++) {
    assert.match(floorAccelerator(i), /^CmdOrCtrl\+Alt\+[1-9]$/);
  }
});

test('cycling wraps in both directions', () => {
  assert.equal(cycleFloorIndex(0, 3, 1), 1);
  assert.equal(cycleFloorIndex(2, 3, 1), 0, 'forward past the end wraps to the first');
  assert.equal(cycleFloorIndex(0, 3, -1), 2, 'back past the start wraps to the last');
  // Two floors held down on one key must flip, not stick.
  assert.equal(cycleFloorIndex(0, 2, 1), 1);
  assert.equal(cycleFloorIndex(1, 2, 1), 0);
});

test('cycling with nothing focused enters at the near end', () => {
  // findIndex returns -1 when no window is focused, or when the focused window
  // is not one of ours. Entering the list must still do something sensible.
  assert.equal(cycleFloorIndex(-1, 3, 1), 0);
  assert.equal(cycleFloorIndex(-1, 3, -1), 2);
  assert.equal(cycleFloorIndex(99, 3, 1), 0, 'an index past the end is treated the same');
});

test('cycling with no windows reports nothing to focus', () => {
  assert.equal(cycleFloorIndex(0, 0, 1), -1);
  assert.equal(cycleFloorIndex(-1, 0, -1), -1);
});

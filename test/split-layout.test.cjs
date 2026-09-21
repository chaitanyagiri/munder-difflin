'use strict';

/**
 * Split-pane geometry.
 *
 * The clamp is reached by three callers that never see each other — the splitter
 * drag, the orientation flip, and the persisted-size restore on boot — so the
 * invariants below are the only thing keeping them agreeing. The one that used
 * to be inline (`Math.min(1200, Math.max(320, px))`) silently assumed a vertical
 * divider, which is exactly the assumption a horizontal split breaks.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  clampSidebarSize, flipOrientation, parseOrientation,
  SIDEBAR_MIN, SIDEBAR_MAX, FLOOR_MIN, SIDEBAR_DEFAULT
} = loadTs('src/renderer/src/store/splitLayout.ts');

// — the pre-existing vertical behaviour must not move —

test('vertical keeps the historical 320..1200 bounds', () => {
  assert.equal(clampSidebarSize(10, 'vertical', 1920), 320);
  assert.equal(clampSidebarSize(99999, 'vertical', 4000), 1200);
  assert.equal(clampSidebarSize(420, 'vertical', 1920), 420);
});

test('vertical still reserves 360px of floor, as it always did', () => {
  // The old inline rule was `Math.min(max, Math.max(min, viewportWidth - 360))`.
  assert.equal(clampSidebarSize(9999, 'vertical', 1000), 640);
});

// — the horizontal axis is NOT the vertical one with different numbers —

test('horizontal allows a shorter sidebar than vertical allows a narrow one', () => {
  // 240px of terminal height is ~15 rows: usable. 240px of WIDTH is not.
  assert.equal(clampSidebarSize(0, 'horizontal', 1200), SIDEBAR_MIN.horizontal);
  assert.ok(SIDEBAR_MIN.horizontal < SIDEBAR_MIN.vertical);
});

test('horizontal reserves only 180px for the floor, so a thin strip is reachable', () => {
  // The whole point of the flip: drag the floor down to a strip. Reusing the
  // vertical 360 reserve would have made the target layout impossible.
  assert.equal(clampSidebarSize(9999, 'horizontal', 1000), 820);
  assert.ok(FLOOR_MIN.horizontal < FLOOR_MIN.vertical);
});

// — the squeeze: which pane gives when both minima cannot be met —

test('on a viewport too small for both, the sidebar min wins and the floor gives', () => {
  // 400px tall cannot satisfy 240 sidebar + 180 floor (=420). The terminal is
  // the pane carrying the work, so it keeps its floor; the office shrinks.
  assert.equal(clampSidebarSize(9999, 'horizontal', 400), SIDEBAR_MIN.horizontal);
  assert.equal(clampSidebarSize(0, 'horizontal', 400), SIDEBAR_MIN.horizontal);
});

test('the clamp never returns below the min, whatever the viewport', () => {
  for (const o of ['vertical', 'horizontal']) {
    for (const vp of [0, 1, 200, 500, 1000, 4000]) {
      assert.ok(clampSidebarSize(-999, o, vp) >= SIDEBAR_MIN[o], `${o}@${vp}`);
      assert.ok(clampSidebarSize(99999, o, vp) >= SIDEBAR_MIN[o], `${o}@${vp}`);
    }
  }
});

test('a non-finite size falls back to the orientation default, not NaN', () => {
  // A corrupt localStorage value must not propagate into a style property:
  // `width: NaN` silently collapses the pane to zero. Infinity is treated as
  // the same class of garbage as NaN rather than as "as large as possible" —
  // a restore that meant 620 should not silently become a maximised pane.
  for (const o of ['vertical', 'horizontal']) {
    assert.equal(clampSidebarSize(NaN, o, 1920), SIDEBAR_DEFAULT[o]);
    assert.equal(clampSidebarSize(Infinity, o, 1920), SIDEBAR_DEFAULT[o]);
    assert.equal(clampSidebarSize(-Infinity, o, 1920), SIDEBAR_DEFAULT[o]);
  }
});

test('the size is always an integer — a fractional px blurs the pixel-art floor', () => {
  assert.equal(clampSidebarSize(420.7, 'vertical', 1920), 421);
  assert.equal(Number.isInteger(clampSidebarSize(613.2, 'horizontal', 1400)), true);
});

// — flipping is lossless —

test('flip is its own inverse', () => {
  assert.equal(flipOrientation('vertical'), 'horizontal');
  assert.equal(flipOrientation('horizontal'), 'vertical');
  assert.equal(flipOrientation(flipOrientation('vertical')), 'vertical');
});

test('each orientation has its own default, so a flip cannot inherit the other axis', () => {
  // Sharing one scalar turns a 420px-WIDE sidebar into a 420px-TALL one, which
  // in horizontal mode is a tiny terminal under a huge floor — the inverse of
  // what the user asked for by flipping.
  assert.notEqual(SIDEBAR_DEFAULT.vertical, SIDEBAR_DEFAULT.horizontal);
});

// — untrusted persisted input —

test('parseOrientation defaults anything unrecognised to vertical', () => {
  assert.equal(parseOrientation('horizontal'), 'horizontal');
  assert.equal(parseOrientation('vertical'), 'vertical');
  for (const junk of [null, undefined, '', 'HORIZONTAL', 'row', 0, {}, []]) {
    assert.equal(parseOrientation(junk), 'vertical', JSON.stringify(junk));
  }
});

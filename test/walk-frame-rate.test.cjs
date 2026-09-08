'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { advanceAlongPath } = loadTs('src/renderer/src/scene/office/pathfinding.ts');

// An office character walks a tile path at a fixed px/sec. It used to advance at
// most ONE waypoint per frame and throw away the rest of that frame's movement,
// which made its speed a function of the frame rate: a stall every time it
// crossed a tile. At 120 fps that is one frame in forty. At 20 fps it is one in
// seven, and it reads as the character limping. These pin distance travelled to
// elapsed time and nothing else.

const TILE = 16;
const SPEED = 48;                                   // px/sec, Character.ts
const toPixel = (t) => ({ x: t.x * TILE + TILE / 2, y: t.y * TILE + TILE });
const straightPath = (n) => Array.from({ length: n }, (_, i) => ({ x: i + 1, y: 0 }));

/** Walk for `seconds` at `fps` and report how far along the path we got. */
function walk(fps, seconds, pathLength = 40) {
  const path = straightPath(pathLength);
  const start = toPixel({ x: 0, y: 0 });
  let { x, y } = start;
  const dt = 1 / fps;
  for (let i = 0; i < Math.round(seconds * fps); i++) {
    const step = advanceAlongPath(x, y, path, toPixel, SPEED * dt);
    x = step.x; y = step.y;
    if (step.consumed > 0) path.splice(0, step.consumed);
  }
  return Math.hypot(x - start.x, y - start.y);
}

/** The old one-waypoint-per-frame rule, kept here as the thing being fixed. */
function walkOneWaypointPerFrame(fps, seconds, pathLength = 40) {
  const path = straightPath(pathLength);
  const start = toPixel({ x: 0, y: 0 });
  let { x, y } = start;
  const dt = 1 / fps;
  for (let i = 0; i < Math.round(seconds * fps); i++) {
    const target = toPixel(path[0]);
    const dx = target.x - x, dy = target.y - y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) { x = target.x; y = target.y; path.shift(); continue; }
    const step = Math.min(SPEED * dt, dist);
    x += (dx / dist) * step; y += (dy / dist) * step;
  }
  return Math.hypot(x - start.x, y - start.y);
}

test('a character covers the same ground per second at any frame rate', () => {
  const at120 = walk(120, 2);
  for (const fps of [60, 30, 20, 15]) {
    const drift = Math.abs(walk(fps, 2) - at120);
    assert.ok(drift < 0.001, `${fps} fps drifted ${drift.toFixed(3)}px from 120 fps`);
  }
});

test('two seconds of walking is twice one second of it', () => {
  for (const fps of [120, 20]) {
    assert.ok(Math.abs(walk(fps, 2) - 2 * walk(fps, 1)) < 0.001, `${fps} fps is not linear in time`);
  }
});

test('the old rule really did slow down as the frame rate dropped', () => {
  // Guards the regression: if someone reinstates one-waypoint-per-frame, the
  // test above starts failing and this one explains why it mattered.
  const fast = walkOneWaypointPerFrame(120, 2);
  const slow = walkOneWaypointPerFrame(20, 2);
  assert.ok(slow < fast * 0.95,
    `expected the old rule to lose ground at 20 fps (120fps: ${fast.toFixed(1)}px, 20fps: ${slow.toFixed(1)}px)`);
});

test('a frame that spans several waypoints crosses all of them', () => {
  const path = straightPath(5);
  // Three tiles' worth of budget in a single frame.
  const step = advanceAlongPath(toPixel({ x: 0, y: 0 }).x, toPixel({ x: 0, y: 0 }).y, path, toPixel, TILE * 3);
  assert.equal(step.consumed, 3);
  assert.equal(step.leftover, 0);
});

test('running out of path returns the unspent budget instead of overshooting', () => {
  const path = straightPath(1);
  const start = toPixel({ x: 0, y: 0 });
  const step = advanceAlongPath(start.x, start.y, path, toPixel, TILE * 10);
  assert.equal(step.consumed, 1);
  assert.equal(step.x, toPixel({ x: 1, y: 0 }).x, 'lands exactly on the last waypoint');
  assert.ok(step.leftover > 0, 'and reports what it could not spend');
});

test('an empty path consumes nothing and moves nowhere', () => {
  const step = advanceAlongPath(10, 20, [], toPixel, 999);
  assert.deepEqual({ x: step.x, y: step.y, consumed: step.consumed }, { x: 10, y: 20, consumed: 0 });
});

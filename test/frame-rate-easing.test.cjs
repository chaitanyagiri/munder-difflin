'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { timeScaledLerp } = loadTs('src/renderer/src/scene/office/easing.ts');

// The office camera used to move a fixed fraction of the remaining distance per
// FRAME, which quietly made its easing a function of the display: the same pan
// finished twice as fast on a 120 Hz ProMotion panel as on a 60 Hz one, and would
// have crawled once the floor's ticker was capped. These pin the conversion.

const PER_FRAME = 0.08; // the camera's LERP_SPEED

/** Distance still remaining after easing for `seconds` at `hz`. */
function remainingAfter(seconds, hz) {
  const dt = 1 / hz;
  let remaining = 1;
  for (let t = 0; t < seconds - 1e-9; t += dt) remaining -= remaining * timeScaledLerp(PER_FRAME, dt);
  return remaining;
}

test('one frame at the reference rate is the authored fraction', () => {
  // Not assert.equal: the round trip through pow() lands a float ulp away.
  assert.ok(Math.abs(timeScaledLerp(PER_FRAME, 1 / 60) - PER_FRAME) < 1e-12);
});

test('the same wall-clock easing comes out at 30, 60 and 120 Hz', () => {
  const at60 = remainingAfter(1, 60);
  for (const hz of [30, 120, 144]) {
    assert.ok(Math.abs(remainingAfter(1, hz) - at60) < 1e-9,
      `${hz} Hz drifted from 60 Hz: ${remainingAfter(1, hz)} vs ${at60}`);
  }
});

test('a capped frame rate no longer slows the camera down', () => {
  // The bug, stated as a test: the raw per-frame constant covers half as much
  // ground in a second when the frame rate halves.
  const raw = (hz) => { let r = 1; for (let i = 0; i < hz; i++) r -= r * PER_FRAME; return r; };
  assert.ok(raw(60) > raw(120), 'sanity: the raw constant is rate-dependent');
  assert.ok(Math.abs(remainingAfter(1, 60) - remainingAfter(1, 120)) < 1e-9,
    'the scaled version is not');
});

test('no time elapsed means no movement', () => {
  assert.equal(timeScaledLerp(PER_FRAME, 0), 0);
  assert.equal(timeScaledLerp(PER_FRAME, -1), 0);
  assert.equal(timeScaledLerp(PER_FRAME, NaN), 0);
});

test('a long stall eases toward the target without overshooting it', () => {
  // Pixi clamps elapsedMS to minFPS, but the maths must hold anyway: a resumed
  // floor should snap to the target, never sail past it.
  for (const dt of [1, 10, 3600]) {
    const k = timeScaledLerp(PER_FRAME, dt);
    assert.ok(k > 0.99 && k <= 1, `dt=${dt}s produced ${k}`);
  }
});

test('the degenerate fractions stay degenerate at every rate', () => {
  assert.equal(timeScaledLerp(0, 1 / 60), 0);
  assert.equal(timeScaledLerp(1, 1 / 120), 1);
});

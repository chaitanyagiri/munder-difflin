'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { FLOOR_FPS_CHOICES, FLOOR_FPS_DEFAULT, resolveFloorFps } =
  loadTs('src/shared/floorFps.ts');

// The office scene's frame rate is user-settable, which means the value reaching
// Pixi's ticker comes off disk and cannot be trusted. Anything unrecognised has
// to land on the default rather than be passed through: below Pixi's own minFPS
// the ticker clamps elapsed time and every character silently walks slow, and a
// hand-edited 240 would reinstate exactly the cost this setting exists to cap.

test('every offered rate survives the round trip', () => {
  for (const choice of FLOOR_FPS_CHOICES) {
    assert.equal(resolveFloorFps(choice.fps), choice.fps, `${choice.label} was rejected`);
  }
});

test('the default is one of the offered rates', () => {
  assert.ok(FLOOR_FPS_CHOICES.some((c) => c.fps === FLOOR_FPS_DEFAULT));
});

test('uncapped is offered, and is zero — the value Pixi reads as no cap', () => {
  assert.ok(FLOOR_FPS_CHOICES.some((c) => c.fps === 0));
});

test('anything else falls back to the default', () => {
  for (const bad of [240, 1, -30, 22.5, NaN, Infinity, '30', null, undefined, {}, []]) {
    assert.equal(resolveFloorFps(bad), FLOOR_FPS_DEFAULT,
      `${String(bad)} should not have been accepted`);
  }
});

test('the choices are unique and each carries a label and a note', () => {
  const rates = FLOOR_FPS_CHOICES.map((c) => c.fps);
  assert.equal(new Set(rates).size, rates.length, 'a rate is listed twice');
  for (const c of FLOOR_FPS_CHOICES) {
    assert.ok(c.label && c.note, `${c.fps} is missing its label or note`);
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { ControlRegistry } = loadTs('src/main/control.ts');

test('auto-delivery pause is independent from tool pause and halt', () => {
  const control = new ControlRegistry();
  control.pauseAutoDelivery('dev1', true);

  assert.equal(control.isAutoDeliveryPaused('dev1'), true);
  assert.equal(control.snapshot('dev1').autoDeliveryPaused, true);
  assert.equal(control.snapshot('dev1').paused, false);
  assert.equal(control.snapshot('dev1').halted, false);

  control.resume('dev1');
  assert.equal(control.isAutoDeliveryPaused('dev1'), true, 'normal resume must not spend queued work');
  control.pauseAutoDelivery('dev1', false);
  assert.equal(control.isAutoDeliveryPaused('dev1'), false);
});

test('persisted delivery pauses replace stale in-memory state', () => {
  const control = new ControlRegistry();
  control.pauseAutoDelivery('old', true);
  control.replaceAutoDeliveryPauses(['dev2', 'dev3']);

  assert.equal(control.isAutoDeliveryPaused('old'), false);
  assert.equal(control.isAutoDeliveryPaused('dev2'), true);
  assert.equal(control.isAutoDeliveryPaused('dev3'), true);
});

test('steer queue is capped so a stalled agent cannot accumulate unbounded notes', () => {
  const control = new ControlRegistry();
  for (let i = 1; i <= 25; i++) control.steer('dev9', `note ${i}`);

  // Only the cap is retained, never all 25.
  assert.equal(control.snapshot('dev9').pendingSteers, 20);

  // FIFO + drop-oldest: the oldest notes are shed, so the survivors start at
  // note 6 and the newest (note 25) is the last one delivered.
  assert.equal(control.takeSteer('dev9'), 'note 6');
  let last = '';
  for (let i = 0; i < 19; i++) last = control.takeSteer('dev9'); // notes 7..25
  assert.equal(last, 'note 25');
  assert.equal(control.takeSteer('dev9'), undefined, 'queue fully drained');
});

test('whitespace-only steers are ignored and never fill the queue', () => {
  const control = new ControlRegistry();
  control.steer('dev9', '   ');
  control.steer('dev9', '');
  control.steer('dev9', 'real guidance');
  assert.equal(control.snapshot('dev9').pendingSteers, 1);
  assert.equal(control.takeSteer('dev9'), 'real guidance');
});

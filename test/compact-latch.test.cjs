'use strict';

// Regression guard for #270 — the compaction latch.
//
// The bug it fixed is SILENT AND SLOW: god latches out of compaction, nothing
// errors, no toast, no log line, and context simply stops compacting until
// something else breaks. Nothing guarded it. The code is correct as shipped;
// this is the missing guard, not a bug hunt, so nothing here refactors it.
//
// Two behaviours:
//   (a) fire() with an undeliverable agent enqueues NOTHING
//   (b) a failed delivery leaves lastCompactUsed UNCHANGED; a success updates it

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// queueDelivery.ts has zero imports by design ("kept structural so the gate is
// testable without dragging the store into the test"), so both primitives the
// latch depends on run for real here.
const { canDeliverToAgent, deliverWithAcknowledgement } = loadTs('src/renderer/src/hooks/queueDelivery.ts');

const QUIESCE = 30_000;

// ── (a) the gate that decides "undeliverable" ────────────────────────────────

test('(a) an agent blocked on a human prompt is undeliverable', () => {
  // The exact scenario #270 names: god 'blocked' on a human prompt. Enqueuing
  // anyway left a stuck /compact at the head of the queue that dedupe then
  // collapsed every later hourly attempt against, forever.
  assert.equal(canDeliverToAgent('blocked', 0, QUIESCE), false);
});

test('(a) idle delivers; a busy loop only delivers once it has gone quiet', () => {
  assert.equal(canDeliverToAgent('idle', null, QUIESCE), true);
  assert.equal(canDeliverToAgent('looping', QUIESCE - 1, QUIESCE), false);
  assert.equal(canDeliverToAgent('looping', QUIESCE, QUIESCE), true);
  // never polled / no output at all is not "quiet", it is unknown
  assert.equal(canDeliverToAgent('looping', null, QUIESCE), false);
});

// ── (b) the delivery result the latch is gated on ────────────────────────────

test('(b) a failed delivery reports false and never acknowledges', () => {
  let acknowledged = false;
  return deliverWithAcknowledgement(
    () => Promise.reject(new Error('pty gone')),
    () => { acknowledged = true; }
  ).then((sent) => {
    assert.equal(sent, false, 'a rejected send is not a delivery');
    assert.equal(acknowledged, false, 'the queue item is left for the next retry');
  });
});

test('(b) a successful delivery reports true and acknowledges once', () => {
  let acknowledged = 0;
  return deliverWithAcknowledgement(
    () => Promise.resolve(),
    () => { acknowledged += 1; }
  ).then((sent) => {
    assert.equal(sent, true);
    assert.equal(acknowledged, 1);
  });
});

// ── both guards are present, and placed where they have to be ────────────────
// useHive.ts is a React hook whose import graph cannot load under node:test, so
// its wiring is asserted against the source text — the house pattern. Removing
// either guard fails a test here, which is what the card asks for.

const hive = fs.readFileSync(
  path.resolve(__dirname, '..', 'src/renderer/src/hooks/useHive.ts'), 'utf8'
);

test('(a) fire() refuses an undeliverable agent BEFORE it enqueues', () => {
  assert.match(hive, /if \(!canDeliverToAgent\(a\.status, ptyQuietMs\(a\.ptyId, now\), QUIESCE_IDLE_MS\)\) continue;/);
  // the gate must sit ahead of the enqueue, not after it
  const gate = hive.indexOf("Gate #109-2");
  const enqueue = hive.indexOf('enqueueMessage', gate);
  assert.ok(gate > 0, 'the compaction-trigger gate is still there');
  assert.ok(enqueue > gate, 'the gate runs before the enqueue it protects');
});

test('(b) the latch is written ONLY on a delivery that happened', () => {
  assert.match(hive, /if \(sent && message\?\.compactUsed !== undefined\) \{/);
  // and there is no second, ungated write that would defeat it
  const writes = hive.match(/lastCompactUsed\.current\[[^\]]+\] = /g) ?? [];
  assert.equal(writes.length, 1, 'exactly one place writes the latch');
});

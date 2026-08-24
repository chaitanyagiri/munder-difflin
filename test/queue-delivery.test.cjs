'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { deliverWithAcknowledgement, canDeliverToAgent, checkPrecondition } =
  loadTs('src/renderer/src/hooks/queueDelivery.ts');

const QUIESCE_MS = 12_000; // mirrors QUIESCE_IDLE_MS in useHive

test('queue item is acknowledged only after delivery succeeds', async () => {
  let finish;
  let acknowledged = false;
  const sending = new Promise((resolve) => { finish = resolve; });
  const attempt = deliverWithAcknowledgement(
    () => sending,
    () => { acknowledged = true; }
  );

  assert.equal(acknowledged, false);
  finish();
  assert.equal(await attempt, true);
  assert.equal(acknowledged, true);
});

test('failed delivery remains unacknowledged for retry', async () => {
  let acknowledged = false;
  const sent = await deliverWithAcknowledgement(
    () => Promise.reject(new Error('PTY unavailable')),
    () => { acknowledged = true; }
  );
  assert.equal(sent, false);
  assert.equal(acknowledged, false);
});

test('an idle agent is deliverable without needing a quiescence reading', () => {
  assert.equal(canDeliverToAgent('idle', null, QUIESCE_MS), true);
  assert.equal(canDeliverToAgent('idle', 0, QUIESCE_MS), true);
});

test('a breaker-pinned agent drains once its terminal has genuinely gone quiet', () => {
  // The live stall: an agent over its token cap is pinned 'looping' by the
  // breaker on every beat, the quiescence fallback only un-pins 'working', so
  // under the old idle-only gate its queue never drained — including the
  // breaker's own steer message, the one thing meant to unwedge it.
  assert.equal(canDeliverToAgent('looping', QUIESCE_MS, QUIESCE_MS), true);
  assert.equal(canDeliverToAgent('looping', QUIESCE_MS + 5000, QUIESCE_MS), true);
  assert.equal(canDeliverToAgent('looping', QUIESCE_MS - 1, QUIESCE_MS), false,
    'still emitting bytes — do not type into a live stream');
});

test('unmeasured silence fails closed', () => {
  assert.equal(canDeliverToAgent('looping', null, QUIESCE_MS), false,
    'no reading is not evidence of quiet');
});

test('an agent sitting on an interactive prompt is never typed into', () => {
  // The drain submits with Enter, which would ANSWER a permission prompt that
  // nobody has read. No amount of silence makes that safe.
  for (const status of ['waiting', 'blocked']) {
    assert.equal(canDeliverToAgent(status, QUIESCE_MS * 100, QUIESCE_MS), false, status);
  }
});

test('a mid-turn agent still holds the prompt', () => {
  assert.equal(canDeliverToAgent('working', QUIESCE_MS * 100, QUIESCE_MS), false,
    'the quiescence fallback flips a finished turn to idle — the drain does not second-guess it');
  assert.equal(canDeliverToAgent('thinking', QUIESCE_MS * 100, QUIESCE_MS), false);
});

// --- delivery-time preconditions -------------------------------------------
// A queued message is decided at enqueue time and typed an arbitrary interval
// later. The inbox-wake nudge is only worth sending if the inbox is STILL
// non-empty when its turn comes: an already-awake agent routinely drains the
// whole inbox during the same turn the nudge was queued from, and delivering it
// afterwards burns a full turn discovering there is nothing to read.

const nudge = { precondition: 'inbox-nonempty' };
const inboxOf = (...ids) => () => Promise.resolve(ids.map((id) => ({ id })));

test('nudge is sent while its inbox still holds mail', async () => {
  assert.equal(await checkPrecondition(nudge, inboxOf('m1')), 'send');
});

test('nudge is DROPPED when the inbox was drained before delivery', async () => {
  // The regression: this is the state after the agent read and .done-ed its
  // whole inbox in the same turn the nudge was queued from.
  assert.equal(await checkPrecondition(nudge, inboxOf()), 'drop');
});

test('nudge is sent when the inbox cannot be read', async () => {
  // Fails OPEN on purpose: a spurious nudge costs one turn, a swallowed one can
  // leave real mail unread indefinitely.
  const unreadable = () => Promise.reject(new Error('ipc down'));
  assert.equal(await checkPrecondition(nudge, unreadable), 'send');
});

test('messages without a precondition never consult the inbox', async () => {
  let consulted = false;
  const verdict = await checkPrecondition({}, () => {
    consulted = true;
    return Promise.resolve([]);
  });
  assert.equal(verdict, 'send');
  assert.equal(consulted, false);
});

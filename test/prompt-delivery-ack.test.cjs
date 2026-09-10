'use strict';
// A queued message is delivered when the agent's CLI says it received it — not
// when the PTY took the bytes.
//
// "Ready to receive" is the TUI having painted anything plus a 400 ms settle:
// the boot banner, not the input box. Keystrokes typed before the CLI attaches
// its input handler are lost, and acknowledging on the write dropped the queue
// item, so nothing retried. Observed live twice (worker-stanley4 2026-09-06,
// worker-holly 2026-09-07): work order in the inbox, renderer queue empty,
// 0 tokens, no transcript, until a human typed "read your inbox" by hand.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const {
  PromptAckTracker,
  promptAckEventFor,
  promptNeedsConfirmation,
  deliverWithConfirmation,
  deliverWithAcknowledgement
} = loadTs('src/renderer/src/hooks/queueDelivery.ts');

test('providers whose shim runs on UserPromptSubmit require a confirmation; the rest keep write-is-delivery', () => {
  for (const p of ['claude', 'codex', 'gemini']) assert.equal(promptAckEventFor(p), 'UserPromptSubmit', p);
  for (const p of ['crush', 'antigravity', 'cursor', 'custom', 'kimi', 'grok', 'qwen', 'opencode', 'pi', 'copilot']) assert.equal(promptAckEventFor(p), null, p);
  assert.equal(promptNeedsConfirmation('claude', 'You have new hive inbox message(s) — read your inbox'), true);
  assert.equal(promptNeedsConfirmation('claude', '/compact keep the plan'), false, 'slash commands are handled by the TUI itself');
  assert.equal(promptNeedsConfirmation('claude', '  /clear'), false);
  assert.equal(promptNeedsConfirmation('crush', 'hello'), false);
});

test('waitFor resolves true when the agent reports a prompt submit after the typing', async () => {
  const t = new PromptAckTracker();
  const p = t.waitFor('holly', 1_000, 5_000);
  t.note('holly', 1_200);
  assert.equal(await p, true);
});

test('a submit that already happened after the typing resolves immediately', async () => {
  const t = new PromptAckTracker();
  t.note('holly', 1_500);
  assert.equal(await t.waitFor('holly', 1_000, 5_000), true);
});

test('a submit from BEFORE the typing is not a receipt (the boot-time race is exactly a stale signal)', async () => {
  const t = new PromptAckTracker();
  t.note('holly', 900);
  assert.equal(await t.waitFor('holly', 1_000, 30), false);
});

test('no submit within the timeout → unconfirmed, and later submits do not leak into a finished wait', async () => {
  const t = new PromptAckTracker();
  const p = t.waitFor('holly', 1_000, 30);
  assert.equal(await p, false);
  t.note('holly', 2_000);
  assert.equal(await t.waitFor('holly', 3_000, 30), false, 'a later wait with a later since still needs its own receipt');
});

test('receipts are per agent and forget() releases pending waits as unconfirmed', async () => {
  const t = new PromptAckTracker();
  const holly = t.waitFor('holly', 1_000, 5_000);
  const kevin = t.waitFor('kevin', 1_000, 5_000);
  t.note('kevin', 1_100);
  assert.equal(await kevin, true);
  t.forget('holly');
  assert.equal(await holly, false);
});

test('deliverWithConfirmation: acknowledged only after the CLI confirms', async () => {
  const calls = [];
  const out = await deliverWithConfirmation(
    async () => { calls.push('send'); },
    async () => { calls.push('confirm'); return true; },
    () => { calls.push('ack'); }
  );
  assert.equal(out, 'delivered');
  assert.deepEqual(calls, ['send', 'confirm', 'ack']);
});

test('deliverWithConfirmation: an unconfirmed send leaves the item unacknowledged (the caller retries)', async () => {
  let acked = false;
  const out = await deliverWithConfirmation(async () => {}, async () => false, () => { acked = true; });
  assert.equal(out, 'unconfirmed');
  assert.equal(acked, false);
});

test('deliverWithConfirmation: a rejected send is failed and never asks for confirmation', async () => {
  let confirmed = false;
  let acked = false;
  const out = await deliverWithConfirmation(
    () => Promise.reject(new Error('no pty')),
    async () => { confirmed = true; return true; },
    () => { acked = true; }
  );
  assert.equal(out, 'failed');
  assert.equal(confirmed, false);
  assert.equal(acked, false);
});

test('the legacy write-is-delivery helper is unchanged for callers that still use it', async () => {
  let acked = false;
  assert.equal(await deliverWithAcknowledgement(async () => {}, () => { acked = true; }), true);
  assert.equal(acked, true);
});

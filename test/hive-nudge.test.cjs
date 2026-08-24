'use strict';

/**
 * Regression for the repeated empty-inbox wake.
 *
 * The inbox nudge is QUEUED the moment fresh mail is seen and TYPED only once the
 * agent is idle and off cooldown, and it persists across a renderer reload. Mail
 * arriving while an agent is mid-turn therefore queues one nudge per 4s poll,
 * the agent drains its whole inbox on the first one, and every nudge behind it
 * lands on a directory the agent has already emptied — a delivery slot and a
 * model round-trip each, to be told there is nothing new. Three agents reported
 * it; one checked immediately and again at +2s and never found a file.
 *
 * The queue already holds exactly this invariant for `/compact`, for exactly this
 * reason ("idempotent in the worst way"). The nudge is the second command with
 * that property. These tests pin the predicate the invariant depends on, in the
 * spirit of the isCompactionCommand tests in provider-automation.test.cjs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { inboxNudgeText, isInboxNudge } = loadTs('src/shared/hiveNudge.ts');

// — the queue's one-pending-nudge invariant depends entirely on this predicate —

test('every nudge the app builds is recognised as one, whatever ids it carries', () => {
  for (const ids of [[], ['a'], ['2026-08-19T18-01-00-000Z-ryan-notify-race', 'b-2']]) {
    assert.equal(isInboxNudge(inboxNudgeText(ids)), true, JSON.stringify(ids));
  }
});

test('two nudges with different ids both match, so the duplicate is dropped', () => {
  // The real queued shape: a second poll names different mail. Matching the whole
  // string instead of the fixed head would never dedupe, which is the bug.
  const first = inboxNudgeText(['msg-1']);
  const second = inboxNudgeText(['msg-2', 'msg-3']);
  assert.notEqual(first, second);
  assert.equal([first].some((t) => isInboxNudge(t)) && isInboxNudge(second), true);
});

test('prose that merely mentions the inbox is NOT a nudge', () => {
  // The queue carries operator instructions too; dropping one as a duplicate
  // nudge would silently lose real work.
  assert.equal(isInboxNudge('Please check whether you have new hive inbox message(s)'), false);
  assert.equal(isInboxNudge('summarise your inbox'), false);
  assert.equal(isInboxNudge(''), false);
});

// — the payload —

test('the nudge names the messages that prompted it', () => {
  const text = inboxNudgeText(['2026-08-19T17-10-00-000Z-broadcast-retro-rule']);
  assert.match(text, /2026-08-19T17-10-00-000Z-broadcast-retro-rule/);
});

test('the nudge keeps the pending inbox authoritative, not the id list', () => {
  // A nudge suppressed by the one-pending rule leaves its ids unnamed, so an
  // agent that stopped at the list would miss that mail entirely.
  const text = inboxNudgeText(['msg-1']);
  assert.match(text, /authoritative/);
  assert.match(text, /inbox\/\.done\//);
});

test('a nudge with no ids is still a well-formed nudge', () => {
  const text = inboxNudgeText([]);
  assert.equal(isInboxNudge(text), true);
  assert.doesNotMatch(text, /at least:/);
});

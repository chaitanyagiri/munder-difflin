'use strict';

/**
 * Editing a queued message in place (issue #380).
 *
 * The dangerous parts are invisible in the UI, so they are pinned here:
 * `instruction` is a hidden delivery override (the drain types it INSTEAD of
 * `text`), `precondition` can silently drop a message at delivery time, and the
 * one-pending-/compact and one-pending-inbox-nudge invariants live in
 * enqueueMessage — an edit is a new write path that could route around all of
 * them. The pure helper owns every one of those decisions.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { applyQueuedMessageEdit } = loadTs('src/renderer/src/store/queueEdit.ts');

const msg = (over = {}) => ({ id: 'm1', text: 'original text', ts: 1111, ...over });

test('an edit replaces the text in place — same id, ts, slack, manual, and position', () => {
  const queue = [
    msg({ id: 'a', text: 'first' }),
    msg({ id: 'b', text: 'second', slack: { channel: 'C1', thread_ts: '9.9' }, manual: true }),
    msg({ id: 'c', text: 'third' })
  ];
  const res = applyQueuedMessageEdit(queue, 'b', 'second, corrected');
  assert.equal(res.ok, true);
  assert.deepEqual(res.queue.map((m) => m.id), ['a', 'b', 'c'], 'an edit is not a re-queue');
  const edited = res.queue[1];
  assert.equal(edited.text, 'second, corrected');
  assert.equal(edited.ts, 1111, 'the "queued 2m ago" hint must not restart');
  assert.deepEqual(edited.slack, { channel: 'C1', thread_ts: '9.9' }, 'Slack thread coordinates survive');
  assert.equal(edited.manual, true, 'a send-now release survives a typo fix');
});

test('the hidden instruction override and the delivery precondition are dropped by an edit', () => {
  // An edit box bound to `text` alone would report success and deliver the
  // ORIGINAL instruction; a stale precondition would silently drop the fixed
  // message. The operator's edited text becomes the one authoritative payload.
  const queue = [msg({ instruction: 'secret preamble + original', precondition: 'inbox-nonempty' })];
  const res = applyQueuedMessageEdit(queue, 'm1', 'what I actually meant');
  assert.equal(res.ok, true);
  assert.equal(res.queue[0].text, 'what I actually meant');
  assert.equal('instruction' in res.queue[0], false, 'override cleared — edited text is what delivers');
  assert.equal('precondition' in res.queue[0], false, 'a hand-rewritten message is meant to go');
});

test('empty, unchanged, and unknown-id edits are refused as no-ops', () => {
  const queue = [msg()];
  assert.deepEqual(applyQueuedMessageEdit(queue, 'm1', '   '), { ok: false, reason: 'empty' });
  assert.deepEqual(applyQueuedMessageEdit(queue, 'm1', 'original text'), { ok: false, reason: 'unchanged' });
  assert.deepEqual(applyQueuedMessageEdit(queue, 'nope', 'x'), { ok: false, reason: 'not-found' });
});

test('editing a message INTO /compact keeps the one-pending-compact invariant', () => {
  const queue = [msg({ id: 'a', text: 'please review the diff' }), msg({ id: 'b', text: '/compact keep auth decisions' })];
  const res = applyQueuedMessageEdit(queue, 'a', '/compact everything else');
  assert.deepEqual(res, { ok: false, reason: 'duplicate-compact' });
});

test('rewording the only queued /compact is still allowed', () => {
  // The invariant counts OTHER rows: the row being edited must not block itself.
  const queue = [msg({ id: 'a', text: '/compact keep auth decisions' })];
  const res = applyQueuedMessageEdit(queue, 'a', '/compact keep the db schema notes');
  assert.equal(res.ok, true);
  assert.equal(res.queue[0].text, '/compact keep the db schema notes');
});

test('editing a message into a second inbox nudge is refused like enqueue would', () => {
  const { inboxNudgeText } = loadTs('src/shared/hiveNudge.ts');
  const queue = [msg({ id: 'a', text: 'real work order' }), msg({ id: 'b', text: inboxNudgeText(['msg-1']) })];
  const res = applyQueuedMessageEdit(queue, 'a', inboxNudgeText(['msg-2']));
  assert.deepEqual(res, { ok: false, reason: 'duplicate-nudge' });
});

test('compactUsed survives only while the message still IS a compaction command', () => {
  const stillCompact = applyQueuedMessageEdit([msg({ text: '/compact old focus', compactUsed: 42 })], 'm1', '/compact new focus');
  assert.equal(stillCompact.ok, true);
  assert.equal(stillCompact.queue[0].compactUsed, 42, 'the tokens-at-enqueue reading still describes this row');
  const noLonger = applyQueuedMessageEdit([msg({ text: '/compact old focus', compactUsed: 42 })], 'm1', 'never mind, keep going');
  assert.equal(noLonger.ok, true);
  assert.equal('compactUsed' in noLonger.queue[0], false, 'a stale reading must not latch a compaction that never ran');
});

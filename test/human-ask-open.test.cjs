'use strict';
// "Waiting on the human" is defined by an OPEN ask, not by the card's status.
//
// The ASK ME tab, the kanban "?" badge and the floor board all used to require
// status === 'blocked' as well. The god appended a sign-off question to card F1
// while the card sat in "doing" (it had just reassigned it to a worker), so the
// ask was in the ledger and in none of the three surfaces. This is the shared
// definition every surface now imports.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { openQuestion, waitsOnHuman, openAsks, isDoneCard } = loadTs('src/shared/humanAsk.ts');

test('an open ask makes a card wait on the human whatever its status (the F1 case)', () => {
  const ask = { q: 'Sign F1?', askedAt: '2026-09-06T13:14:00.000Z' };
  for (const status of ['todo', 'doing', 'blocked', undefined]) {
    const card = { id: 'F1', title: 'Block POTASSIUM', status, humanQA: [ask] };
    assert.equal(waitsOnHuman(card), true, `status=${status}`);
    assert.equal(openQuestion(card), ask);
  }
});

// Existing hives carry unanswered humanQA entries on cards that finished long
// ago (the god closed the card without the human ever typing an answer). If a
// done card counted, every one of them would land in ASK ME at once the first
// time the upgraded app read the ledger.
test('a done card never waits on the human — its old unanswered question is history', () => {
  const stale = { id: 'T2', title: 'Shipped last week', status: 'done',
    humanQA: [{ q: 'Approve the copy?', askedAt: '2026-08-30T10:00:00.000Z' }] };
  assert.equal(isDoneCard(stale), true);
  assert.equal(waitsOnHuman(stale), false);
  assert.equal(openQuestion(stale), undefined);
  assert.deepEqual(openAsks({ tasks: [stale] }), []);
  // Reopening the card (the god moves it back) makes the same ask pending again.
  assert.equal(waitsOnHuman({ ...stale, status: 'blocked' }), true);
  assert.equal(isDoneCard({ status: 'blocked' }), false);
  assert.equal(isDoneCard(null), false);
});

test('answered or dismissed asks do not wait on the human, nor do cards without asks', () => {
  assert.equal(waitsOnHuman({ status: 'blocked', humanQA: [{ q: 'x', a: 'yes' }] }), false);
  assert.equal(waitsOnHuman({ status: 'blocked', humanQA: [{ q: 'x', dismissedAt: '2026-09-06T00:00:00.000Z' }] }), false);
  assert.equal(waitsOnHuman({ status: 'blocked', humanQA: [] }), false);
  assert.equal(waitsOnHuman({ status: 'blocked' }), false);
  assert.equal(waitsOnHuman(null), false);
  assert.equal(waitsOnHuman({ humanQA: 'not an array' }), false);
});

test('the newest open entry wins and malformed entries are skipped', () => {
  const card = { humanQA: [
    { q: 'first', a: 'answered' },
    null,
    { q: 42 },
    { q: 'older open', askedAt: '2026-09-06T11:00:00.000Z' },
    { q: 'newest open', askedAt: '2026-09-06T12:00:00.000Z' }
  ] };
  assert.equal(openQuestion(card).q, 'newest open');
});

test('openAsks reads the on-disk ledger shape or a bare array and keys each ask stably', () => {
  const ledger = { tasks: [
    { id: 'T4', title: 'Decision', status: 'done', humanQA: [{ q: 'Which?', a: 'parallel' }] },
    { id: 'F1', title: 'Block', status: 'doing', humanQA: [{ q: 'Sign?', askedAt: '2026-09-06T13:14:00.000Z' }] },
    { id: 'T7', title: 'Closed unanswered', status: 'done', humanQA: [{ q: 'Still open on a done card' }] },
    { title: 'untitled id', humanQA: [{ q: 'No id, no timestamp' }] }
  ] };
  const asks = openAsks(ledger);
  assert.deepEqual(asks.map((a) => a.taskId), ['F1', 'idx-3'], 'the done card T7 is left out');
  assert.equal(asks[0].title, 'Block');
  assert.equal(asks[0].question, 'Sign?');
  assert.equal(asks[0].askedAt, '2026-09-06T13:14:00.000Z');
  assert.equal(asks[0].key, openAsks(ledger)[0].key, 'keys are stable across reads');
  assert.equal(asks[1].askedAt, null);
  assert.deepEqual(openAsks(ledger.tasks).map((a) => a.key), asks.map((a) => a.key));
  assert.deepEqual(openAsks(null), []);
  assert.deepEqual(openAsks({ tasks: 'nope' }), []);
});

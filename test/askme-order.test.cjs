'use strict';

// ASK ME board ordering: newest question at the top, oldest at the bottom.
//
// Before this there was no comparator at all — position was an accident of
// where a card sat in a 440KB tasks.json — so these assert the ordering rule
// itself, not merely that a sort call exists.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { compareByNewestAsk, askedAtMs } = loadTs('src/renderer/src/components/askMeOrder.ts');

// A card's OPEN ask is what the board ranks by; the comparator takes that entry
// directly, exactly as AskMeTab passes openQuestion(t).
const ask = (askedAt) => (askedAt === undefined ? undefined : { askedAt });

function order(...times) {
  return times.map(ask).sort(compareByNewestAsk).map((e) => e?.askedAt ?? null);
}

test('the newest ask sorts first and the oldest last', () => {
  assert.deepEqual(
    order('2026-08-20T10:00:00Z', '2026-08-26T08:20:00Z', '2026-08-23T12:00:00Z'),
    ['2026-08-26T08:20:00Z', '2026-08-23T12:00:00Z', '2026-08-20T10:00:00Z']
  );
});

test('the founder scenario: a brand-new ask outranks a three-day-old one', () => {
  // The 08:20Z ask landed on a card created minutes earlier, so it sat at the
  // END of the array and rendered at the BOTTOM. It must now come first.
  const [first] = order('2026-08-23T09:00:00Z', '2026-08-26T08:20:00Z');
  assert.equal(first, '2026-08-26T08:20:00Z');
});

test('an unparseable or missing askedAt sorts last instead of throwing', () => {
  assert.deepEqual(
    order('not-a-date', '2026-08-26T08:20:00Z', undefined, '2026-08-20T10:00:00Z'),
    ['2026-08-26T08:20:00Z', '2026-08-20T10:00:00Z', 'not-a-date', null]
  );
  // The card carrying a bad timestamp loses its position, never the board.
  assert.doesNotThrow(() => order('garbage', undefined));
  assert.equal(askedAtMs({ askedAt: 'garbage' }), null);
  assert.equal(askedAtMs(undefined), null);
});

test('two asks at the same instant keep a stable relative order', () => {
  assert.equal(compareByNewestAsk(ask('2026-08-26T08:20:00Z'), ask('2026-08-26T08:20:00Z')), 0);
});

// ── the board actually applies it, to the OUTER list only ────────────────────

const tab = fs.readFileSync(
  path.resolve(__dirname, '..', 'src/renderer/src/components/AskMeTab.tsx'), 'utf8'
);

test('AskMeTab sorts the card list by each card open question', () => {
  assert.match(tab, /\.filter\(waitsOnHuman\)\s*\n\s*\.sort\(\(a, b\) => compareByNewestAsk\(openQuestion\(a\), openQuestion\(b\)\)\)/);
});

test('the humanQA history inside a card is never reversed', () => {
  // That array is a conversation rendered through the "VIEW N EARLIER ANSWERS"
  // collapse; reversing it would make a thread read backwards.
  assert.doesNotMatch(tab, /humanQA[^\n]*\.reverse\(\)/);
  assert.doesNotMatch(tab, /\.reverse\(\)/);
});

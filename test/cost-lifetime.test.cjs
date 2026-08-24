'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { CostLedgerTotals } = loadTs('src/main/costLifetime.ts');

/** One ledger row in the exact shape appendCostLedger writes. */
function row(agent, session, usd) {
  return JSON.stringify({
    agent_id: agent, session_id: session, ts: 0,
    input: 0, output: 0, cache_read: 0, cache_creation: 0, model: '', usd
  });
}

function ledgerWith(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-cost-'));
  const p = path.join(dir, 'cost-ledger.jsonl');
  fs.writeFileSync(p, lines.length ? `${lines.join('\n')}\n` : '');
  return p;
}

async function totalsFor(lines) {
  const t = new CostLedgerTotals();
  await t.refreshFully(ledgerWith(lines));
  return t;
}

test('no reset: lifetime is simply the last cumulative value', async () => {
  const t = await totalsFor([row('a', 's1', 1), row('a', 's1', 5), row('a', 's1', 9.25)]);
  assert.equal(t.usdFor('a'), 9.25);
});

test('one reset: the pre-reset peak is added to the open segment', async () => {
  // climbs to 20, restarts at 0, climbs to 3  ->  23, not 3
  const t = await totalsFor([
    row('a', 's1', 8), row('a', 's1', 20),
    row('a', 's1', 0), row('a', 's1', 3)
  ]);
  assert.equal(t.usdFor('a'), 23);
});

test('several resets in one session all accumulate', async () => {
  const t = await totalsFor([
    row('a', 's1', 10), row('a', 's1', 0),
    row('a', 's1', 7), row('a', 's1', 0),
    row('a', 's1', 2)
  ]);
  assert.equal(t.usdFor('a'), 19);
});

test('a sub-dollar reset still counts (a $1 threshold would miss this)', async () => {
  // Both of these occur in the live ledger: 0.92 -> 0.00 and 0.73 -> 0.00.
  const t = await totalsFor([
    row('a', 's1', 0.92), row('a', 's1', 0), row('a', 's1', 0.4)
  ]);
  assert.equal(Number(t.usdFor('a').toFixed(4)), 1.32);
});

test('the reset keeps the SAME session_id, which is the whole bug', async () => {
  const t = await totalsFor([row('a', 'same', 30), row('a', 'same', 0), row('a', 'same', 1)]);
  assert.equal(t.usdFor('a'), 31);
});

test('separate sessions for one agent sum together', async () => {
  const t = await totalsFor([row('a', 's1', 4), row('a', 's2', 6)]);
  assert.equal(t.usdFor('a'), 10);
});

test('agents are kept apart, and floorTotal sums the floor', async () => {
  const t = await totalsFor([
    row('a', 's1', 10), row('a', 's1', 0), row('a', 's1', 1),
    row('b', 's2', 5)
  ]);
  assert.equal(t.usdFor('a'), 11);
  assert.equal(t.usdFor('b'), 5);
  assert.equal(t.floorTotal(), 16);
});

test('an unknown agent is 0 once warm, and null before any fold', async () => {
  const cold = new CostLedgerTotals();
  assert.equal(cold.usdFor('nobody'), null, 'cold must not claim $0 as fact');
  assert.equal(cold.ready, false);
  const t = await totalsFor([row('a', 's1', 1)]);
  assert.equal(t.ready, true);
  assert.equal(t.usdFor('nobody'), 0);
});

test('INCREMENTAL: folding in two passes equals folding in one', async () => {
  const first = [row('a', 's1', 8), row('a', 's1', 20)];
  const rest = [row('a', 's1', 0), row('a', 's1', 3)];

  const p = ledgerWith(first);
  const t = new CostLedgerTotals();
  await t.refreshFully(p);
  assert.equal(t.usdFor('a'), 20);

  fs.appendFileSync(p, `${rest.join('\n')}\n`);
  await t.refreshFully(p);
  assert.equal(t.usdFor('a'), 23, 'appended lines must fold onto existing state');

  const oneShot = await totalsFor([...first, ...rest]);
  assert.equal(t.usdFor('a'), oneShot.usdFor('a'));
});

test('INCREMENTAL: a half-written trailing line is not lost or double counted', async () => {
  const p = ledgerWith([row('a', 's1', 5)]);
  const partial = row('a', 's1', 11);
  fs.appendFileSync(p, partial.slice(0, 20)); // torn mid-write, no newline

  const t = new CostLedgerTotals();
  await t.refreshFully(p);
  assert.equal(t.usdFor('a'), 5, 'the torn line must not be parsed');

  fs.appendFileSync(p, `${partial.slice(20)}\n`); // writer finishes the line
  await t.refreshFully(p);
  assert.equal(t.usdFor('a'), 11, 'the completed line must be folded exactly once');
});

test('re-reading an unchanged ledger does not double count', async () => {
  const p = ledgerWith([row('a', 's1', 10), row('a', 's1', 0), row('a', 's1', 4)]);
  const t = new CostLedgerTotals();
  await t.refreshFully(p);
  await t.refreshFully(p);
  await t.refreshFully(p);
  assert.equal(t.usdFor('a'), 14);
});

test('truncation or rotation rebuilds from scratch instead of going negative', async () => {
  const p = ledgerWith([row('a', 's1', 10), row('a', 's1', 25)]);
  const t = new CostLedgerTotals();
  await t.refreshFully(p);
  assert.equal(t.usdFor('a'), 25);

  fs.writeFileSync(p, `${row('a', 's1', 2)}\n`); // rotated: smaller than the offset
  await t.refreshFully(p);
  assert.equal(t.usdFor('a'), 2, 'stale offset must not survive a truncation');
});

test('malformed and empty lines are skipped, not fatal', async () => {
  const p = ledgerWith([row('a', 's1', 3)]);
  fs.appendFileSync(p, '\nnot json at all\n{"agent_id":null}\n');
  fs.appendFileSync(p, `${row('a', 's1', 7)}\n`);
  const t = new CostLedgerTotals();
  await t.refreshFully(p);
  assert.equal(t.usdFor('a'), 7);
});

test('a missing ledger leaves the last good totals in place', async () => {
  const p = ledgerWith([row('a', 's1', 9)]);
  const t = new CostLedgerTotals();
  await t.refreshFully(p);
  await t.refresh(path.join(path.dirname(p), 'does-not-exist.jsonl'));
  assert.equal(t.usdFor('a'), 9);
});

test('a non-numeric usd is treated as 0 rather than NaN-poisoning the total', async () => {
  const p = ledgerWith([row('a', 's1', 5)]);
  fs.appendFileSync(p, `${JSON.stringify({ agent_id: 'a', session_id: 's1', usd: 'lots' })}\n`);
  const t = new CostLedgerTotals();
  await t.refreshFully(p);
  assert.equal(Number.isFinite(t.usdFor('a')), true);
  assert.equal(t.usdFor('a'), 5);
});

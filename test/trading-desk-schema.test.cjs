'use strict';

/**
 * The trading desk reads state files written by a Python pipeline it does not
 * control. These pin the parsers' defensive contract: numeric strings are
 * numbers, missing fields are null (never a fake 0 where it matters), a
 * malformed row is counted and skipped rather than sinking the whole feed, and
 * the feed comes back newest-first with honest timestamps.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  parsePortfolio, parseExecutionsTail, parsePipelineStatus, parseRealizedPnl, parseForecasts, parseTradingMode,
} = loadTs('src/renderer/src/components/trading/schema.ts');

test('portfolio: broker-mirrored numeric strings become numbers; sign of position_fp survives', () => {
  const p = parsePortfolio({
    updated: '2026-09-21T11:30:41.967709+00:00',
    balance_dollars: 108.62,
    total_exposure_dollars: '31.34',
    positions: [
      { ticker: 'KXA-T1', title: 'A', position_fp: '-1.00', market_exposure_dollars: '0.920000', total_traded_dollars: '0.92', fees_paid_dollars: '0.0052', last_updated_ts: '2026-09-21T11:19:33.186132Z' },
      { ticker: 'KXB-T2', position_fp: '3', market_exposure_dollars: 'not-a-number' },
      { no_ticker: true },
      'garbage',
    ],
  });
  assert.equal(p.balance, 108.62);
  assert.equal(p.exposure, 31.34);
  assert.equal(p.savedProfits, null, 'absent field is null, not 0');
  assert.equal(p.positions.length, 2, 'rows without a ticker are dropped');
  assert.equal(p.positions[0].positionFp, -1);
  assert.equal(p.positions[0].exposure, 0.92);
  assert.equal(p.positions[0].fees, 0.0052);
  assert.ok(p.positions[0].lastUpdated > 0);
  assert.equal(p.positions[1].positionFp, 3);
  assert.equal(p.positions[1].exposure, 0);
  assert.throws(() => parsePortfolio([]), /expected a JSON object/);
  assert.throws(() => parseTradingMode({}), /missing "mode"/);
});

test('executions tail: bad lines are counted not fatal; rows come newest-first with the rejection text', () => {
  const rows = [
    { id: 'a', at: '2026-09-21T10:00:00+00:00', status: 'filled', mode: 'LIVE', verdict: { ticker: 'T1', side: 'YES', contracts: 7, executable_price: 0.18, size_dollars: 1.26, usable_edge: 0.0186, watchdog_action: 'ALLOW', reasons: [] }, mcp_result: { success: true, text: '{"order_id":"x"}' } },
    { id: 'b', at: '2026-09-21T11:00:00+00:00', status: 'rejected', verdict: { ticker: 'T1', side: 'YES', contracts: 7 }, mcp_result: { success: false, text: 'portfolio gate: already hold YES on T1; duplicate buy rejected' } },
  ];
  const content = [
    JSON.stringify(rows[0]),
    '{"id":"torn"} {"extra":1}', // two records glued on one line — the real file has one of these
    JSON.stringify(rows[1]),
    '',
  ].join('\n');
  const t = parseExecutionsTail(content, true);
  assert.equal(t.badLines, 1);
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[0].id, 'b', 'newest first');
  assert.equal(t.rows[0].resultText, rows[1].mcp_result.text);
  assert.equal(t.rows[0].success, false);
  assert.equal(t.rows[0].price, null, 'missing price is null, not 0');
  assert.equal(t.rows[1].usableEdge, 0.0186);
  assert.equal(t.rows[1].watchdogAction, 'ALLOW');
  assert.equal(t.newestAt, Date.parse(rows[1].at));
  assert.equal(t.oldestAt, Date.parse(rows[0].at));
  assert.equal(t.truncated, true);
});

test('pipeline status: workers keyed by name, dead ones keep alive=false; by_category is sorted', () => {
  const s = parsePipelineStatus({
    state: 'running', at: '2026-09-21T11:31:44+00:00', app: { alive: true },
    workers: { zeta: { alive: false, pid: 1, role: 'service' }, alpha: { alive: true, pid: 2, role: 'pipeline', resting: false }, junk: null },
  });
  assert.deepEqual(s.workers.map(w => w.name), ['alpha', 'zeta']);
  assert.equal(s.workers[1].alive, false);
  assert.equal(s.appAlive, true);

  const p = parseRealizedPnl({ realized_pnl_dollars: -5.85, wins: 12, losses: 18, by_category: { weather: -12.4, other: 6.6, bogus: 'x' }, stale: false });
  assert.deepEqual(p.byCategory, [{ category: 'other', pnl: 6.6 }, { category: 'weather', pnl: -12.4 }]);
  assert.equal(p.fees, null);

  const f = parseForecasts({ generated_at: '2026-09-21T12:00:00Z', rows: [{ ticker: 'T', agent: 'ff_nws', probability: 0.23 }, { ticker: 'T', probability: 'nan' }, { agent: 'x', probability: 0.5 }] });
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].agent, 'ff_nws');
});

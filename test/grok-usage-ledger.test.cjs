'use strict';

/**
 * #535 — Grok agents run fine but never reach the cost ledger.
 *
 * The telemetry env that makes an agent push OTel is injected for Claude Code
 * alone (hive.ts `ensureAgent`), and a Grok agent writes no Claude transcript,
 * so both of the collector's sources came back empty and every Grok agent read
 * as $0.00 / 0 tok forever — in fleet.json and by its total absence from
 * cost-ledger.jsonl. Its real numbers were on disk the whole time, in the Grok
 * CLI's own per-session `usage.json`.
 *
 * These cover the two halves of the fix: reading that file, and not writing the
 * same row to the ledger over and over once it can be read (the cumulative
 * snapshot is exactly the shape that produced #56's 2,417 duplicates).
 *
 * Sandboxes HOME so the path resolves into a throwaway dir rather than the
 * developer's real ~/.grok (mirrors test/telemetry-session-fallback.test.cjs).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

const loadTs = require('./load-ts.cjs');
const { TelemetryCollector } = loadTs('src/main/telemetry.ts');
const { CumulativeSampleGate } = loadTs('src/main/usage.ts');

const AGENT = 'ryan-mu1mcvvx';
const CWD = '/Users/someone/dev/portfolio';
const SESSION = '01a0a15a-0176-7f22-9a00-c81bcd4e3940';

/** The real shape `grok usage <session-id>` persists, trimmed to what we read. */
function writeUsageFile(totals) {
  const dir = path.join(FAKE_HOME, '.grok', 'sessions', encodeURIComponent(CWD), SESSION);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'usage.json'),
    JSON.stringify({
      sessionId: SESSION,
      updatedAt: '2026-09-14T20:23:52.899124+00:00',
      session: {
        inputTokens: 1782920,
        outputTokens: 14247,
        cachedReadTokens: 1524736,
        cacheCreationTokens: 0,
        reasoningTokens: 11404,
        totalTokens: 1797167,
        modelCalls: 24,
        // 10^10 ticks to the dollar → $0.5388.
        costUsdTicks: 5388341200,
        primaryModelId: 'grok-4.6-build',
        ...totals
      }
    })
  );
}

function collector({ cwd = CWD, sessionId = SESSION } = {}) {
  return new TelemetryCollector({
    resolveCwd: () => cwd,
    resolveSessionId: () => sessionId
  });
}

test('a Grok agent is costed from the CLI’s own usage.json', () => {
  writeUsageFile();

  const sample = collector().getAgentUsage(AGENT);

  assert.ok(sample, 'no sample — the Grok agent would show $0.00 forever (#535)');
  assert.equal(sample.input, 1782920);
  assert.equal(sample.output, 14247);
  assert.equal(sample.cacheRead, 1524736);
  assert.equal(sample.cacheCreation, 0);
  assert.equal(sample.model, 'grok-4.6-build');
  // Ticks, not dollars: reading the raw number would bill this at $5.4 billion.
  assert.equal(Number(sample.usd.toFixed(4)), 0.5388);
});

test('the sample carries a real session id, so the ledger accepts it', () => {
  writeUsageFile();

  const sample = collector().getAgentUsage(AGENT);

  // index.ts appends only `if (sample?.sessionId)`. The transcript fallback
  // returns '' on purpose to stay out; this one has to get in.
  assert.equal(sample.sessionId, SESSION);
});

test('no usage.json means no data, not a zeroed sample', () => {
  // Every Claude agent takes this path: its session id is not a directory
  // under ~/.grok/sessions, so the read throws and the next fallback runs.
  const sample = collector({ sessionId: 'claude-session-with-no-grok-file' }).getAgentUsage(AGENT);

  assert.equal(sample, null);
});

test('an unknown cwd or session id is not guessed at', () => {
  writeUsageFile();

  // null, not undefined — undefined would take the helper's default and quietly
  // assert nothing.
  assert.equal(collector({ cwd: null }).getAgentUsage(AGENT), null);
  assert.equal(collector({ sessionId: null }).getAgentUsage(AGENT), null);
});

test('an idle Grok agent does not re-append the same ledger row (#56)', () => {
  writeUsageFile();
  const gate = new CumulativeSampleGate();
  const read = () => collector().getAgentUsage(AGENT);

  assert.equal(gate.admits(read()), true, 'first sample must be recorded');
  // The beat fires every ~30s whether or not the agent did anything.
  assert.equal(gate.admits(read()), false);
  assert.equal(gate.admits(read()), false);

  // The agent takes a turn; the totals move and the row is real again.
  writeUsageFile({ outputTokens: 20000, costUsdTicks: 6000000000 });
  assert.equal(gate.admits(read()), true);
  assert.equal(gate.admits(read()), false);
});

test('the gate keeps agents apart and forgets on request', () => {
  writeUsageFile();
  const gate = new CumulativeSampleGate();
  const sample = collector().getAgentUsage(AGENT);

  assert.equal(gate.admits(sample), true);
  assert.equal(gate.admits({ ...sample, agentId: 'someone-else' }), true, 'per-agent, not global');
  assert.equal(gate.admits(sample), false);

  gate.forget(AGENT);
  assert.equal(gate.admits(sample), true, 'a respawned agent starts clean');
});

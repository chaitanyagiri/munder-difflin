'use strict';

/**
 * D11 — the circuit breaker's per-agent token cap is measured off
 * TelemetryCollector.getAgentUsage(), which falls back to transcriptFallback()
 * whenever an agent has no live OTel data yet (a just-spawned agent, above all).
 * That fallback called readAgentUsage(cwd) with NO session filter, so it summed
 * every `.jsonl` transcript ever written in that cwd's Claude project directory
 * — every other agent's history, and every past run's, not just this agent's.
 *
 * Confirmed live and reproduced here: a probe worker with zero LLM calls was
 * reaped citing 143,369,766 tokens (an equivalent worker's real usage, per
 * fleet.json, was 251,901) because its cwd was a long-lived shared repo whose
 * project directory carried tens of millions of tokens from unrelated past
 * sessions. The fix scopes the fallback to the agent's OWN current session id
 * (resolveSessionId, wired to hive.lastSession in index.ts) and, when no
 * session id is known yet for that agent (the true zero-usage instant right
 * after spawn), reports no data rather than someone else's history.
 *
 * Sandboxes HOME so projectDir() maps into a throwaway dir, never the real
 * ~/.claude/projects (mirrors test/transcript-usage.test.cjs).
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
const { projectDir, readAgentUsage } = loadTs('src/main/transcript.ts');

function assistantRecord(sessionId, outputTokens) {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    message: {
      model: 'claude-sonnet-5',
      usage: {
        input_tokens: 100,
        output_tokens: outputTokens,
        cache_read_input_tokens: outputTokens * 50, // dominates the total, like real turns do
        cache_creation_input_tokens: 0
      }
    }
  });
}

/** A fresh cwd with a project dir standing in for a long-lived, shared repo:
 *  one foreign/older session already left tens of millions of tokens behind. */
function makeSharedProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const dir = projectDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const foreignLines = Array.from({ length: 20 }, () => assistantRecord('foreign-session', 50_000));
  fs.writeFileSync(path.join(dir, 'foreign-session.jsonl'), `${foreignLines.join('\n')}\n`);
  return { cwd, dir };
}

test('D11: pre-fix fingerprint — an unfiltered read sums a shared cwd\'s whole history', () => {
  const { cwd } = makeSharedProject();
  const legacy = readAgentUsage(cwd); // no sessionId filter — the old transcriptFallback call
  assert.equal(legacy.outputTokens, 1_000_000, 'the foreign session alone should already be huge');
});

test('D11: transcript fallback attributes only the agent\'s own session, not the shared cwd\'s history', () => {
  const { cwd, dir } = makeSharedProject();
  fs.writeFileSync(path.join(dir, 'my-session.jsonl'), `${assistantRecord('my-session', 10)}\n`);

  const telemetry = new TelemetryCollector({
    resolveCwd: () => cwd,
    resolveSessionId: () => 'my-session'
  });
  const sample = telemetry.getAgentUsage('worker-x');
  assert.ok(sample, 'expected a sample from the agent\'s own transcript');
  assert.equal(sample.output, 10, 'must not include the foreign session\'s tokens');
});

test('D11: with no session id known yet, a brand-new agent reports no usage instead of the shared cwd\'s history', () => {
  const { cwd } = makeSharedProject();

  const telemetry = new TelemetryCollector({
    resolveCwd: () => cwd,
    resolveSessionId: () => undefined // no hook has fired for this agent yet
  });
  // Pre-fix this returned the foreign session's ~1,000,000-token pseudo-total —
  // the exact shape of the "reaped citing 143,369,766 tokens" incident.
  assert.equal(telemetry.getAgentUsage('worker-x'), null);
});

test('D11: a returned fallback sample keeps sessionId empty (preserves the #56 cost-ledger dedup gate)', () => {
  const { cwd, dir } = makeSharedProject();
  fs.writeFileSync(path.join(dir, 'my-session.jsonl'), `${assistantRecord('my-session', 10)}\n`);

  const telemetry = new TelemetryCollector({
    resolveCwd: () => cwd,
    resolveSessionId: () => 'my-session'
  });
  const sample = telemetry.getAgentUsage('worker-x');
  assert.equal(sample.sessionId, '', 'a transcript-fallback sample must never look like a live OTel session');
});

// ─── Bug 10: the respawn window ──────────────────────────────────────────────

function tokenBatch(agentId, sessionId, output) {
  return {
    resourceMetrics: [{
      resource: { attributes: [{ key: 'agent.id', value: { stringValue: agentId } }] },
      scopeMetrics: [{
        metrics: [{
          name: 'claude_code.token.usage',
          sum: {
            dataPoints: [{
              asInt: String(output),
              attributes: [
                { key: 'session.id', value: { stringValue: sessionId } },
                { key: 'type', value: { stringValue: 'output' } },
                { key: 'model', value: { stringValue: 'claude-sonnet-5' } }
              ]
            }]
          }
        }]
      }]
    }]
  };
}

async function postMetrics(endpoint, body) {
  const response = await fetch(`${endpoint}/v1/metrics`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  assert.equal(response.status, 200);
  await response.text();
}

test('bug 10: a forgetAgent-respawned agent reports no usage until its NEW session\'s first metric lands', async (t) => {
  const { cwd, dir } = makeSharedProject();
  // The DEAD prior session's transcript, huge against any cap.
  fs.writeFileSync(path.join(dir, 'dead-session.jsonl'), `${assistantRecord('dead-session', 50_000)}\n`);

  const telemetry = new TelemetryCollector({
    resolveCwd: () => cwd,
    // index.ts wires this to hive.lastSession — the id ensureAgent DELIBERATELY
    // preserves across a respawn (it is the --resume key), so during the
    // respawn window it still names the dead session.
    resolveSessionId: () => 'dead-session'
  });
  await telemetry.start();
  t.after(() => telemetry.stop());

  // The prior run had live OTel, then teardownPty forgot it (index.ts:456).
  await postMetrics(telemetry.endpoint(), tokenBatch('worker-x', 'dead-session', 900));
  assert.equal(telemetry.getAgentUsage('worker-x').output, 900, 'sanity: live data was flowing');
  telemetry.forgetAgent('worker-x');

  // The respawn window: aggregateLive is now null, but resolveSessionId still
  // hands back the PRESERVED dead id — the fallback must not read it.
  assert.equal(telemetry.getAgentUsage('worker-x'), null,
    'a just-respawned agent must report "no data", not its dead session\'s cumulative transcript totals');

  // Recovery: the new session's first OTel record unmutes the provider and
  // reports only the new session's spend.
  await postMetrics(telemetry.endpoint(), tokenBatch('worker-x', 'fresh-session', 10));
  const live = telemetry.getAgentUsage('worker-x');
  assert.ok(live, 'a live sample must exist once the new session\'s first metric lands');
  assert.equal(live.output, 10, 'must be the new session\'s spend, not the dead transcript\'s 900');
});

test('bug 10: forgetAgent does not mute agents that never had live data (D11 path unchanged)', () => {
  const { cwd, dir } = makeSharedProject();
  fs.writeFileSync(path.join(dir, 'my-session.jsonl'), `${assistantRecord('my-session', 10)}\n`);

  const telemetry = new TelemetryCollector({
    resolveCwd: () => cwd,
    resolveSessionId: () => 'my-session'
  });
  // A different agent is forgotten; worker-x's never-hooked fallback must keep
  // reading its own session transcript exactly as before the fix.
  telemetry.forgetAgent('some-other-agent');
  const sample = telemetry.getAgentUsage('worker-x');
  assert.ok(sample, 'an untouched agent keeps its transcript fallback');
  assert.equal(sample.output, 10);
});

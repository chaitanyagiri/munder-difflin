#!/usr/bin/env node
'use strict';

/**
 * Bug 10 repro — transcript fallback feeds a respawned agent's DEAD
 * prior-session totals to the circuit breaker until the new session's first
 * hook / OTel record lands.
 *
 * The chain, exercised here end to end with the real modules:
 *
 *   1. hive.ensureAgent deliberately spreads the PRIOR registry entry so
 *      `sessionId` survives a respawn — that preserved id is the `--resume`
 *      key (src/main/hive.ts:734-754). ensureAgent runs BEFORE the resume
 *      lookup in the spawn handler, so it cannot know whether this respawn
 *      will resume; the id is always preserved. Proven below with the real
 *      HiveManager.
 *   2. teardownPty runs on every pty:kill and calls breaker.forget +
 *      telemetry.forgetAgent (src/main/index.ts:454-456). forgetAgent clears
 *      the agent's live OTel accumulators, so aggregateLive() returns null
 *      until the NEW session's first metric arrives.
 *   3. A ~30s breaker beat lands in that window: runBreakerBeat pulls
 *      usageProvider.getAgentUsage(id) (src/main/index.ts:1207). The
 *      collector falls through to transcriptFallback
 *      (src/main/telemetry.ts:432-450), which filters on resolveSessionId =
 *      hive.lastSession (wired src/main/index.ts:255) — i.e. the PRESERVED
 *      dead id — and returns the prior session's CUMULATIVE transcript
 *      totals stamped ts=Date.now() and sessionId=''.
 *   4. The beat feeds that sample to breaker.tick UNCONDITIONALLY (only the
 *      ledger append index.ts:1215 and recordSession index.ts:1223 are gated
 *      on a truthy sessionId), so the per-agent token cap
 *      (breaker.ts:352-358) and both floor-wide top-spender arms
 *      costCapUsd / costCapTokens (breaker.ts:273-294) evaluate the
 *      brand-new agent against spend it did not do → escalate
 *      healthy → steering → constrained (hive mail + native toasts).
 *      Recovery only completes on further beats after live data lands.
 *
 * This contradicts the fallback's own documented D11 contract
 * (src/main/telemetry.ts:424-431): when nothing has hooked in for the agent
 * THIS run — "the true zero-usage case for a just-spawned agent" — it must
 * report "no data" rather than prior history. A fresh respawn is exactly that
 * state, defeated by the preserved id.
 *
 * Determinism: HOME is sandboxed to a temp dir so the fixture transcript never
 * touches the real ~/.claude/projects; the OTel "first hook" is a loopback
 * POST to the collector's own endpoint (the pattern
 * test/telemetry-forget-agent.test.cjs uses); breaker beats are synchronous
 * tick calls with explicit clocks. No timers, no PTY spawns, no external
 * network.
 *
 * FAILS on current code (the brand-new agent is escalated on its dead
 * session's totals). PASSES once the fallback reports "no data" for a
 * just-respawned agent whose only known session id is the preserved dead one.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

// Sandbox HOME before anything can read it: projectDir() maps
// <home>/.claude/projects under this throwaway root.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bug10-home-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

const loadTs = require(path.join(__dirname, '..', 'load-ts.cjs'));
const { TelemetryCollector } = loadTs('src/main/telemetry.ts');
const { CircuitBreaker } = loadTs('src/main/breaker.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { projectDir } = loadTs('src/main/transcript.ts');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

const AGENT = 'worker-x';
const DEAD_SESSION = 'dead-session-aaaa';
const FRESH_SESSION = 'fresh-session-bbbb';
const AGENT_CAP = 4_000_000;

/** One assistant record: the dead session's cumulative transcript usage —
 *  4.15M WORK tokens (input + output + cacheCreation; cacheRead excluded from
 *  workTokensOf), over the agent's 4M cap, and $16.05 estimated — over the
 *  $10 floor cost cap. */
function assistantRecord(sessionId) {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    message: {
      model: 'claude-sonnet-5',
      usage: {
        input_tokens: 100_000,
        output_tokens: 50_000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 4_000_000
      }
    }
  });
}

function makeBreaker(over = {}) {
  return new CircuitBreaker(() => ({
    enabled: true, hardStop: false, repeatedToolLimit: 8, errorStormLimit: 5,
    tokenVelocityPerMin: 60000, ...over
  }));
}

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

async function main() {
  // ── fixture: the agent's repo cwd, whose Claude project dir carries the
  // PRIOR session's transcript (4.15M work tokens, $16.05). ──
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bug10-proj-'));
  const projDirPath = projectDir(cwd);
  fs.mkdirSync(projDirPath, { recursive: true });
  fs.writeFileSync(
    path.join(projDirPath, `${DEAD_SESSION}.jsonl`),
    `${assistantRecord(DEAD_SESSION)}\n`
  );

  // ── the real hive registry: first spawn, then the prior session's hooks
  // record their session id (SessionStart → recordSession). ──
  const hive = new HiveManager(() => FAKE_HOME);
  await hive.ensureAgent({ id: AGENT, name: 'Worker X', provider: 'claude', cwd });
  hive.recordSession(AGENT, DEAD_SESSION);
  assert.equal(hive.lastSession(AGENT), DEAD_SESSION);

  // ── the real telemetry collector, wired EXACTLY like index.ts:250-256. ──
  const telemetry = new TelemetryCollector({
    resolveCwd: (id) => hive.registry().agents[id]?.cwd ?? null,
    resolveSessionId: (id) => hive.lastSession(id)
  });
  await telemetry.start();
  const endpoint = telemetry.endpoint();

  // The prior session ran with live OTel; then the operator tears the PTY
  // down — teardownPty resets the breaker AND forgets live usage
  // (index.ts:454-456), and archives the registry entry.
  await postMetrics(endpoint, tokenBatch(AGENT, DEAD_SESSION, 50_000));
  assert.equal(telemetry.getAgentUsage(AGENT).output, 50_000, 'sanity: live OTel was flowing for the prior session');
  const breaker = makeBreaker({ agentTokenCaps: { [AGENT]: AGENT_CAP } });
  breaker.forget(AGENT);       // index.ts:454
  telemetry.forgetAgent(AGENT); // index.ts:456 — live accumulators gone

  // ── the FRESH respawn: same agent id, resume:false (the Command Center
  // 'apply' flow) — the registry deliberately PRESERVES `sessionId`. ──
  await hive.ensureAgent({ id: AGENT, name: 'Worker X', provider: 'claude', cwd });

  check('premise: the fresh respawn preserves the dead session id in the registry (the --resume key)', () => {
    assert.equal(hive.lastSession(AGENT), DEAD_SESSION,
      'hive.ts:734-754 spreads the prior registry entry so sessionId survives a respawn');
  });

  // ── THE BUG WINDOW: no OTel metric, no hook has landed for the new session
  // yet, and a ~30s breaker beat fires. This is exactly what the beat pulls: ──
  const stale = telemetry.getAgentUsage(AGENT);
  console.log('\nObserved (current code):');
  console.log(`  getAgentUsage('${AGENT}') in the respawn window → ${JSON.stringify(stale)}`);
  console.log(`  dead session '${DEAD_SESSION}' transcript totals: input=100000 output=50000 cacheCreation=4000000`);
  console.log(`  workTokensOf(that sample) = ${(4_150_000).toLocaleString()} vs per-agent cap ${AGENT_CAP.toLocaleString()}\n`);

  check('seam: a just-respawned agent with no live data reports NO usage, not its dead session\'s cumulative totals', () => {
    assert.equal(stale, null,
      `BUG: nothing has hooked in for the new session this run, yet getAgentUsage returned the PRIOR session's ` +
      `cumulative transcript totals: ${JSON.stringify(stale)} — the D11 contract (telemetry.ts:424-431) says this ` +
      `state must report "no data" rather than prior history`);
  });

  if (stale) {
    // Diagnostic fingerprint (current code only): what the breaker is being fed.
    check('fingerprint: the sample the breaker is fed IS the dead session\'s cumulative spend', () => {
      assert.equal(stale.input, 100_000);
      assert.equal(stale.output, 50_000);
      assert.equal(stale.cacheCreation, 4_000_000);
      assert.equal(stale.sessionId, '', 'fallback samples keep sessionId empty (the #56 ledger gate)');
      assert.equal(stale.usd > 10, true, 'estimated cost of the DEAD session exceeds the $10 floor cap');
    });
  }

  // ── the breaker beat, modeled on runBreakerBeat (index.ts:1190-1261):
  // the respawned agent owns a live PTY, so it IS evaluated; the sample is
  // fed to breaker.tick unconditionally. ──
  const now0 = Date.now();
  const beat1 = breaker.tick(
    [{ agentId: AGENT, sample: telemetry.getAgentUsage(AGENT), progressing: true, lastWorkAt: now0 }],
    now0
  )[0];
  check('beat 1: the brand-new agent stays healthy — it is not escalated for the dead session\'s spend', () => {
    assert.equal(beat1.state.level, 'healthy',
      `BUG: the just-respawned agent was escalated to '${beat1.state.level}' (action '${beat1.action}') on its ` +
      `first beat — reason: "${beat1.state.reason}" — that spend belongs to the dead prior session`);
  });

  const now1 = now0 + 30_000;
  const beat2 = breaker.tick(
    [{ agentId: AGENT, sample: telemetry.getAgentUsage(AGENT), progressing: true, lastWorkAt: now1 }],
    now1
  )[0];
  check('beat 2: still healthy — no constrain (native toast) for spend the new session did not do', () => {
    assert.equal(beat2.state.level, 'healthy',
      `BUG: second beat escalated to '${beat2.state.level}' (action '${beat2.action}') — reason: "${beat2.state.reason}"`);
  });

  // ── floor-wide caps: same stale sample; worker-y is a live, honest agent. ──
  const workerY = {
    agentId: 'worker-y', sessionId: 'live-y', ts: Date.now(),
    input: 60_000, output: 40_000, cacheRead: 0, cacheCreation: 0,
    model: 'claude-sonnet-5', usd: 0.5
  };

  const costBeat = makeBreaker({ costCapUsd: 10 }).tick([
    { agentId: AGENT, sample: telemetry.getAgentUsage(AGENT), progressing: true },
    { agentId: 'worker-y', sample: workerY, progressing: true }
  ], Date.now());
  check('floor-wide costCapUsd: the respawned agent is not blamed as the floor\'s top spender', () => {
    const mine = costBeat.find((d) => d.state.agentId === AGENT);
    assert.equal(mine.state.level, 'healthy',
      `BUG: the floor cost cap blamed the just-respawned agent — level '${mine.state.level}', ` +
      `reason "${mine.state.reason}"`);
  });

  const tokenBeat = makeBreaker({ costCapTokens: 1_000_000 }).tick([
    { agentId: AGENT, sample: telemetry.getAgentUsage(AGENT), progressing: true },
    { agentId: 'worker-y', sample: workerY, progressing: true }
  ], Date.now());
  check('floor-wide costCapTokens: the respawned agent is not blamed as the floor\'s top spender', () => {
    const mine = tokenBeat.find((d) => d.state.agentId === AGENT);
    assert.equal(mine.state.level, 'healthy',
      `BUG: the floor token cap blamed the just-respawned agent — level '${mine.state.level}', ` +
      `reason "${mine.state.reason}"`);
  });

  // ── recovery (must keep working after any fix): the new session's
  // SessionStart hook records its id, and its first OTel metric arrives. ──
  hive.recordSession(AGENT, FRESH_SESSION);
  await postMetrics(endpoint, tokenBatch(AGENT, FRESH_SESSION, 10));
  const live = telemetry.getAgentUsage(AGENT);
  check('recovery: once the new session hooks in, usage reports the NEW session only', () => {
    assert.ok(live, 'a live sample must exist once OTel lands');
    assert.equal(live.sessionId, FRESH_SESSION);
    assert.equal(live.output, 10, 'must be the new session\'s spend, not the dead transcript\'s 50,000');
  });

  const now2 = Date.now();
  breaker.tick([{ agentId: AGENT, sample: telemetry.getAgentUsage(AGENT), progressing: true, lastWorkAt: now2 }], now2);
  const now3 = now2 + 30_000;
  const rec2 = breaker.tick([{ agentId: AGENT, sample: telemetry.getAgentUsage(AGENT), progressing: true, lastWorkAt: now3 }], now3)[0];
  check('recovery: with honest live data the agent de-escalates back to healthy', () => {
    assert.equal(rec2.state.level, 'healthy',
      `expected recovery to healthy, got '${rec2.state.level}' (reason "${rec2.state.reason}")`);
  });

  // ── cleanup + verdict ──
  telemetry.stop();
  for (const dir of [FAKE_HOME, cwd]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
  }

  if (failed) {
    console.error(`\n${failed} check(s) FAILED — bug reproduced: the transcript fallback feeds the breaker a ` +
      `respawned agent's dead prior-session totals until the new session's first hook lands.`);
  } else {
    console.log('\nAll checks passed — bug not reproduced.');
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error('repro crashed:', e);
  process.exitCode = 1;
});

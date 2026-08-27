'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { TelemetryCollector } = loadTs('src/main/telemetry.ts');

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

test('forgetAgent resets usage before the same agent id is respawned', async (t) => {
  const telemetry = new TelemetryCollector({ host: '127.0.0.1', port: 0 });
  await telemetry.start();
  t.after(() => telemetry.stop());
  const endpoint = telemetry.endpoint();

  await postMetrics(endpoint, tokenBatch('agent-1', 'dead-session', 900));
  assert.equal(telemetry.getAgentUsage('agent-1').output, 900);

  telemetry.forgetAgent('agent-1');

  await postMetrics(endpoint, tokenBatch('agent-1', 'respawn-session', 10));
  assert.equal(telemetry.getAgentUsage('agent-1').output, 10);
});

test('forgetAgent drops the dead session so its total cannot resurrect', async (t) => {
  const telemetry = new TelemetryCollector({ host: '127.0.0.1', port: 0 });
  await telemetry.start();
  t.after(() => telemetry.stop());
  const endpoint = telemetry.endpoint();

  await postMetrics(endpoint, tokenBatch('agent-1', 'dead-session', 900));
  assert.equal(telemetry.getAgentUsage('agent-1').output, 900);

  telemetry.forgetAgent('agent-1');

  // A late or duplicate sample for the SAME session id must accumulate from
  // zero, not re-attach the forgotten 900. Deleting only agentSessions and
  // leaving the sessions entry behind would let the dead total resurrect the
  // moment any further metric arrives for that session — reinstating the very
  // inherited usage this reset exists to clear.
  await postMetrics(endpoint, tokenBatch('agent-1', 'dead-session', 10));
  assert.equal(telemetry.getAgentUsage('agent-1').output, 10);
});

test('forgetAgent keeps usage for other agents', async (t) => {
  const telemetry = new TelemetryCollector({ host: '127.0.0.1', port: 0 });
  await telemetry.start();
  t.after(() => telemetry.stop());
  const endpoint = telemetry.endpoint();

  await postMetrics(endpoint, tokenBatch('agent-1', 'session-1', 500));
  await postMetrics(endpoint, tokenBatch('agent-2', 'session-2', 700));

  telemetry.forgetAgent('agent-1');

  assert.equal(telemetry.getAgentUsage('agent-1'), null);
  assert.equal(telemetry.getAgentUsage('agent-2').output, 700);
});

test('teardown resets telemetry when it forgets breaker state', () => {
  const indexPath = require('node:path').join(__dirname, '..', 'src', 'main', 'index.ts');
  const rawSource = require('node:fs').readFileSync(indexPath, 'utf8');
  const activeSource = rawSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  // Bounded to the teardown block: an unbounded slice would also match the call
  // if it were moved into any later function in the file.
  const start = activeSource.indexOf('breaker.forget(agentId)');
  const end = activeSource.indexOf('hive.stopProxyBridge(agentId)', start);
  assert.ok(start !== -1 && end > start, 'teardown block not found in index.ts');
  const afterBreakerReset = activeSource.slice(start, end);

  assert.match(afterBreakerReset, /telemetry\.forgetAgent\(agentId\)/);
});

'use strict';

const assert = require('assert');
const { mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { spawnSync } = require('child_process');

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${name}\n     ${err.message}`);
  }
}

function compileDebugControl() {
  const out = mkdtempSync(join(tmpdir(), 'munder-debug-control-test-'));
  const tsc = spawnSync('./node_modules/.bin/tsc', [
    'src/main/debugControl.ts',
    '--target', 'ES2022',
    '--module', 'CommonJS',
    '--moduleResolution', 'node',
    '--esModuleInterop',
    '--skipLibCheck',
    '--outDir', out,
  ], { encoding: 'utf8' });
  if (tsc.status !== 0) {
    rmSync(out, { recursive: true, force: true });
    throw new Error(`tsc failed\n${tsc.stdout}\n${tsc.stderr}`);
  }
  return out;
}

async function readJson(res) {
  return JSON.parse(await res.text());
}

(async () => {
  console.log('debug control endpoint tests');
  const out = compileDebugControl();
  const { DebugControlServer, DEBUG_CONTROL_ENDPOINT_VERSION } = require(join(out, 'debugControl.js'));
  const calls = [];
  const server = new DebugControlServer({
    port: 0,
    token: 'test-token',
    handlers: {
      health: () => ({ ok: true, endpointVersion: DEBUG_CONTROL_ENDPOINT_VERSION, harnessConfigured: true }),
      snapshot: () => ({ ok: true, hive: { agents: [] }, ptys: [], recentLog: [] }),
      workOrder: (payload) => { calls.push(['workOrder', payload]); return { ok: true, id: 'msg-1' }; },
      startClosingTime: () => ({ ok: true }),
      control: (agentId, action, payload) => { calls.push(['control', agentId, action, payload]); return { ok: true }; },
      killPty: (ptyId) => { calls.push(['killPty', ptyId]); return { ok: true }; },
      quitNow: () => ({ ok: true }),
    },
  });
  const started = await server.start();
  assert.strictEqual(started.ok, true, started.error);
  const base = started.url;

  await test('requires a debug token', async () => {
    const res = await fetch(`${base}/health`);
    assert.strictEqual(res.status, 401);
  });

  await test('accepts bearer token and returns health', async () => {
    const res = await fetch(`${base}/health`, { headers: { authorization: 'Bearer test-token' } });
    assert.strictEqual(res.status, 200);
    const body = await readJson(res);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.endpointVersion, 1);
  });

  await test('accepts x-munder-debug-token and returns snapshot', async () => {
    const res = await fetch(`${base}/snapshot`, { headers: { 'x-munder-debug-token': 'test-token' } });
    assert.strictEqual(res.status, 200);
    const body = await readJson(res);
    assert.deepStrictEqual(body.ptys, []);
    assert.deepStrictEqual(body.recentLog, []);
  });

  await test('rejects malformed JSON', async () => {
    const res = await fetch(`${base}/work-order`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
      body: '{bad',
    });
    assert.strictEqual(res.status, 400);
  });

  await test('dispatches work order payload', async () => {
    const res = await fetch(`${base}/work-order`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'god', body: 'hello' }),
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await readJson(res), { ok: true, id: 'msg-1' });
    assert.deepStrictEqual(calls[0], ['workOrder', { to: 'god', body: 'hello' }]);
  });

  await test('routes control and kill actions', async () => {
    await fetch(`${base}/control/agent-1/steer`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'pause soon' }),
    });
    await fetch(`${base}/pty/pty-1/kill`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
    });
    assert.deepStrictEqual(calls[1], ['control', 'agent-1', 'steer', { text: 'pause soon' }]);
    assert.deepStrictEqual(calls[2], ['killPty', 'pty-1']);
  });

  server.stop();
  rmSync(out, { recursive: true, force: true });
  if (failures > 0) process.exit(1);
  console.log('all passed');
})();

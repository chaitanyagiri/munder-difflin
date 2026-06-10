'use strict';

const assert = require('assert');
const { mkdtempSync, rmSync, existsSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { spawn, spawnSync } = require('child_process');
const { handleToolCall } = require('../tools/munder-mcp/index.cjs');

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
  const out = mkdtempSync(join(tmpdir(), 'munder-reliable-smoke-'));
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

function waitForBuffer(getText, pattern, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pattern.test(getText())) { resolve(); return; }
      if (Date.now() > deadline) { reject(new Error(`timed out waiting for ${pattern}`)); return; }
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function withFakeAgent(mode, fn) {
  const child = spawn(process.execPath, ['tools/smoke/fake-agent.cjs'], {
    cwd: process.cwd(),
    env: { ...process.env, MUNDER_FAKE_AGENT_MODE: mode },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err += d.toString(); });
  try {
    await waitForBuffer(() => out, /FAKE_AGENT_READY/);
    await fn(child, () => out, () => err);
  } finally {
    if (!child.killed) child.kill();
  }
}

function fakeMunderClient() {
  const state = {
    log: [],
    pty: { id: 'pty-fake', agentId: 'fake-worker', idleMs: 5000 },
    closingTime: { active: false, phase: 'cancelled', acked: 0, total: 1 },
  };
  return {
    state,
    health: async () => ({ ok: true, endpointVersion: 1, harnessConfigured: true }),
    snapshot: async () => ({
      ok: true,
      endpointVersion: 1,
      hive: {
        enabled: true,
        godId: 'god',
        agents: [
          { id: 'god', name: 'Michael', provider: 'claude', status: 'idle', isGod: true, inboxCount: 0, hasLivePty: true },
          { id: 'fake-worker', name: 'Fake Worker', provider: 'custom', status: 'idle', inboxCount: 0, hasLivePty: true },
        ],
      },
      ptys: [state.pty],
      closingTime: state.closingTime,
      recentLog: state.log,
    }),
    workOrder: async (payload) => {
      state.pty.idleMs = 0;
      state.log.push({ kind: 'message', to: payload.to || 'god', subject: payload.subject || 'Debug control work order' });
      setTimeout(() => { state.pty.idleMs = 5000; }, 100);
      return { ok: true, id: 'msg-smoke', to: payload.to || 'god' };
    },
    startClosingTime: async () => {
      state.closingTime = { active: true, phase: 'timeout', acked: 0, total: 1 };
      state.log.push({ kind: 'closing-time', subject: 'CLOSING TIME timeout observable' });
      return { ok: true };
    },
    steer: async () => ({ ok: true }),
    halt: async () => ({ ok: true }),
    kill: async () => ({ ok: true }),
  };
}

(async () => {
  console.log('reliable smoke harness tests');

  await test('fake agent emits deterministic work and closing-time ACK output', async () => {
    await withFakeAgent('ack', async (child, stdout) => {
      child.stdin.write('hello world\n');
      await waitForBuffer(stdout, /FAKE_AGENT_WORK_ORDER hello world/);
      child.stdin.write('closing time\n');
      await waitForBuffer(stdout, /CLOSING-TIME-ACK/);
    });
  });

  await test('fake agent can simulate no-ACK shutdown blocker', async () => {
    await withFakeAgent('no-ack', async (child, stdout) => {
      child.stdin.write('closing time\n');
      await waitForBuffer(stdout, /FAKE_AGENT_NO_ACK/);
      assert.ok(!/CLOSING-TIME-ACK/.test(stdout()));
    });
  });

  await test('debug endpoint starts and exposes health in-process', async () => {
    const out = compileDebugControl();
    const { DebugControlServer } = require(join(out, 'debugControl.js'));
    const server = new DebugControlServer({
      port: 0,
      token: 'smoke-token',
      handlers: {
        health: () => ({ ok: true, endpointVersion: 1 }),
        snapshot: () => ({ ok: true, hive: { agents: [] }, ptys: [], recentLog: [] }),
        workOrder: () => ({ ok: true }),
        startClosingTime: () => ({ ok: true }),
        control: () => ({ ok: true }),
        killPty: () => ({ ok: true }),
        quitNow: () => ({ ok: true }),
      },
    });
    const started = await server.start();
    assert.strictEqual(started.ok, true, started.error);
    const res = await fetch(`${started.url}/health`, { headers: { authorization: 'Bearer smoke-token' } });
    assert.strictEqual(res.status, 200);
    server.stop();
    rmSync(out, { recursive: true, force: true });
  });

  await test('MCP smoke flow sends work, waits for idle, and observes closing-time timeout', async () => {
    const client = fakeMunderClient();
    assert.strictEqual((await handleToolCall('munder_health', {}, client)).ok, true);
    const agents = await handleToolCall('munder_list_agents', {}, client);
    assert.ok(agents.agents.some((a) => a.id === 'fake-worker'));
    await handleToolCall('munder_send_work_order', {
      to: 'fake-worker',
      subject: 'SMOKE_WORK_ORDER',
      body: 'do deterministic fake work',
    }, client);
    await handleToolCall('munder_wait_for_text', { text: 'SMOKE_WORK_ORDER', timeoutMs: 2000 }, client);
    await handleToolCall('munder_wait_for_idle', { agentId: 'fake-worker', idleMs: 1000, timeoutMs: 3000 }, client);
    await handleToolCall('munder_start_closing_time', {}, client);
    await handleToolCall('munder_wait_for_text', { text: 'timeout observable', timeoutMs: 2000 }, client);
    assert.strictEqual(client.state.closingTime.phase, 'timeout');
  });

  await test('build output includes required Slack sidecar after build', async () => {
    assert.ok(existsSync('out/main/index.js'), 'run npm run build before the smoke test');
    assert.ok(existsSync('out/main/slack-trigger.cjs'), 'missing out/main/slack-trigger.cjs sidecar');
  });

  if (failures > 0) process.exit(1);
  console.log('all passed');
})();

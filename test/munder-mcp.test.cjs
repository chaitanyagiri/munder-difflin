'use strict';

const assert = require('assert');
const { createServer } = require('http');
const { handleToolCall, TOOLS } = require('../tools/munder-mcp/index.cjs');

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

function fakeClient() {
  const calls = [];
  return {
    calls,
    health: async () => ({ ok: true }),
    snapshot: async () => ({
      ok: true,
      hive: { agents: [{ id: 'god', name: 'Michael' }] },
      ptys: [{ id: 'pty-1', agentId: 'god', idleMs: 5000 }],
      recentLog: [{ subject: 'hello from hive' }],
    }),
    workOrder: async (payload) => { calls.push(['workOrder', payload]); return { ok: true, id: 'm1' }; },
    startClosingTime: async () => ({ ok: true }),
    steer: async (agentId, text) => { calls.push(['steer', agentId, text]); return { ok: true }; },
    halt: async (agentId) => { calls.push(['halt', agentId]); return { ok: true }; },
    kill: async (ptyId) => { calls.push(['kill', ptyId]); return { ok: true }; },
  };
}

(async () => {
  console.log('munder MCP wrapper tests');

  await test('exposes expected tool names', () => {
    const names = TOOLS.map((t) => t.name);
    for (const name of [
      'munder_health',
      'munder_snapshot',
      'munder_list_agents',
      'munder_send_work_order',
      'munder_wait_for_idle',
      'munder_wait_for_text',
      'munder_start_closing_time',
      'munder_steer_agent',
      'munder_halt_agent',
      'munder_kill_agent',
    ]) {
      assert.ok(names.includes(name), `${name} missing`);
    }
  });

  await test('maps health and list agents', async () => {
    const client = fakeClient();
    assert.deepStrictEqual(await handleToolCall('munder_health', {}, client), { ok: true });
    assert.deepStrictEqual(await handleToolCall('munder_list_agents', {}, client), {
      ok: true,
      agents: [{ id: 'god', name: 'Michael' }],
    });
  });

  await test('maps work order, steer, halt, and kill', async () => {
    const client = fakeClient();
    await handleToolCall('munder_send_work_order', { to: 'god', body: 'do it' }, client);
    await handleToolCall('munder_steer_agent', { agentId: 'god', text: 'wrap up' }, client);
    await handleToolCall('munder_halt_agent', { agentId: 'god' }, client);
    await handleToolCall('munder_kill_agent', { ptyId: 'pty-1' }, client);
    assert.deepStrictEqual(client.calls, [
      ['workOrder', { to: 'god', body: 'do it' }],
      ['steer', 'god', 'wrap up'],
      ['halt', 'god'],
      ['kill', 'pty-1'],
    ]);
  });

  await test('wait tools poll sanitized snapshot metadata', async () => {
    const client = fakeClient();
    assert.strictEqual((await handleToolCall('munder_wait_for_idle', { agentId: 'god', idleMs: 1000 }, client)).state, 'idle');
    assert.deepStrictEqual(await handleToolCall('munder_wait_for_text', { text: 'hello from hive' }, client), {
      ok: true,
      text: 'hello from hive',
    });
  });

  await test('client reports endpoint auth errors clearly', async () => {
    const server = createServer((req, res) => {
      assert.strictEqual(req.headers.authorization, 'Bearer token');
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    process.env.MUNDER_DEBUG_URL = `http://127.0.0.1:${port}`;
    process.env.MUNDER_DEBUG_TOKEN = 'token';
    const { createMunderClient } = require('../tools/munder-mcp/index.cjs');
    await assert.rejects(() => createMunderClient().health(), /401: unauthorized/);
    delete process.env.MUNDER_DEBUG_URL;
    delete process.env.MUNDER_DEBUG_TOKEN;
    await new Promise((resolve) => server.close(resolve));
  });

  if (failures > 0) process.exit(1);
  console.log('all passed');
})();

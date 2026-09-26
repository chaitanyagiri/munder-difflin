'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { CircuitBreaker } = loadTs('src/main/breaker.ts');

async function installedPiBridge(t) {
  const hiveHome = fs.mkdtempSync(path.join(os.tmpdir(), 'md-pi-bridge-hive-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'md-pi-bridge-user-'));
  t.after(() => fs.rmSync(hiveHome, { recursive: true, force: true }));
  t.after(() => fs.rmSync(fakeHome, { recursive: true, force: true }));

  const realHome = process.env.HOME;
  const realProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    const hive = new HiveManager(() => hiveHome);
    const injection = await hive.ensureAgent({
      id: 'pi-bridge-test',
      name: 'Pi Bridge Test',
      provider: 'pi',
      cwd: hiveHome
    });
    const piDir = injection.env.PI_CODING_AGENT_DIR;
    assert.ok(piDir, 'Pi agent directory should be injected');
    return {
      source: fs.readFileSync(path.join(piDir, 'extensions', 'hive-bridge.js'), 'utf8'),
      manifest: JSON.parse(fs.readFileSync(path.join(piDir, 'extensions.json'), 'utf8'))
    };
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = realProfile;
  }
}

function runBridge(source, options = {}) {
  const frames = [];
  const handlers = new Map();
  let connections = 0;
  const socket = {
    end(data) {
      frames.push(JSON.parse(String(data).trim()));
    },
    on(event, listener) {
      if (event === 'error' && options.socketError) process.nextTick(listener);
      return this;
    }
  };
  const net = {
    createConnection(_address, onConnect) {
      connections += 1;
      if (options.connectThrows) throw new Error('connect failed');
      if (!options.neverConnect && !options.socketError) process.nextTick(onConnect);
      return socket;
    }
  };
  const pi = options.pi ?? {
    on(event, handler) {
      if (options.registrationFailure === event) throw new Error('registration failed');
      handlers.set(event, handler);
    }
  };
  const mod = { exports: {} };
  const env = {
    AGENT_ID: 'pi-bridge-test',
    ...(options.withoutSocket ? {} : { HIVE_SOCK: '\\\\.\\pipe\\munder-pi-test' }),
    ...(options.autoApprove ? { HIVE_AUTO_APPROVE: '1' } : {})
  };

  vm.runInNewContext(source, {
    module: mod,
    exports: mod.exports,
    require(request) {
      if (request === 'node:net') return net;
      throw new Error(`unexpected require: ${request}`);
    },
    process: { env },
    globalThis: { pi }
  }, { filename: 'hive-bridge.js', timeout: 1000 });

  return {
    frames,
    handlers,
    activate: mod.exports,
    connections: () => connections,
    flush: () => new Promise((resolve) => setImmediate(resolve))
  };
}

function makeBreaker() {
  return new CircuitBreaker(() => ({
    enabled: true,
    hardStop: false,
    repeatedToolLimit: 8,
    errorStormLimit: 5,
    tokenVelocityPerMin: 60_000
  }));
}

function tick(breaker, now) {
  return breaker.tick([{
    agentId: 'pi-bridge-test',
    sample: null,
    progressing: true
  }], now)[0];
}

test('generated Pi bridge preserves tool identity and breaker semantics', async (t) => {
  const { source, manifest } = await installedPiBridge(t);

  await t.test('installs the repaired bridge manifest', () => {
    assert.equal(manifest.name, 'munder-hive-bridge');
    assert.equal(manifest.version, '0.3.2');
    assert.equal(manifest.main, 'extensions/hive-bridge.js');
    assert.equal(manifest.auto, true);
  });

  await t.test('maps confirmed Pi fields on both tool boundaries', async () => {
    const bridge = runBridge(source);
    const event = { toolName: 'bash', input: { command: 'git status' } };
    bridge.handlers.get('tool_call')(event);
    bridge.handlers.get('tool_result')(event);
    await bridge.flush();

    assert.deepEqual(bridge.frames, [
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'bash',
        tool_input: { command: 'git status' },
        agent_id: 'pi-bridge-test'
      },
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'bash',
        tool_input: { command: 'git status' },
        agent_id: 'pi-bridge-test'
      }
    ]);
  });

  await t.test('retains legacy fallbacks with confirmed fields taking precedence', async () => {
    const bridge = runBridge(source);
    bridge.handlers.get('tool_result')({ name: 'read', args: { path: 'README.md' } });
    bridge.handlers.get('tool_result')({ tool: { name: 'write' }, args: { path: 'a.txt' } });
    bridge.handlers.get('tool_result')({
      toolName: 'confirmed',
      name: 'legacy',
      tool: { name: 'nested-legacy' },
      input: { value: 'confirmed' },
      args: { value: 'legacy' }
    });
    await bridge.flush();

    assert.deepEqual(bridge.frames.map(({ tool_name, tool_input }) => ({ tool_name, tool_input })), [
      { tool_name: 'read', tool_input: { path: 'README.md' } },
      { tool_name: 'write', tool_input: { path: 'a.txt' } },
      { tool_name: 'confirmed', tool_input: { value: 'confirmed' } }
    ]);
  });

  await t.test('preserves defined falsy inputs instead of falling back', async () => {
    const bridge = runBridge(source);
    for (const input of ['', false, 0]) {
      bridge.handlers.get('tool_result')({ toolName: 'bash', input, args: { legacy: true } });
    }
    await bridge.flush();
    assert.deepEqual(bridge.frames.map((frame) => frame.tool_input), ['', false, 0]);
  });

  await t.test('round-trips JSON-like text and transport-sensitive characters without parsing inner input', async () => {
    const bridge = runBridge(source);
    const raw = 'quote " slash \\ CRLF\r\n backtick ` path C:\\Users\\name\\repo {"unfinished":';
    bridge.handlers.get('tool_result')({ toolName: 'bash', input: { command: raw } });
    await bridge.flush();
    assert.equal(bridge.frames[0].tool_input.command, raw);
  });

  await t.test('fails open for absent or malformed events and transport failures', async () => {
    const malformed = runBridge(source);
    for (const event of [null, undefined, {}, { tool: null }]) {
      assert.doesNotThrow(() => malformed.handlers.get('tool_result')(event));
    }
    const hostile = { name: 'legacy-safe', args: { path: 'fallback.txt' } };
    Object.defineProperties(hostile, {
      toolName: { get() { throw new Error('toolName getter failed'); } },
      input: { get() { throw new Error('input getter failed'); } }
    });
    assert.doesNotThrow(() => malformed.handlers.get('tool_result')(hostile));
    await malformed.flush();
    assert.equal(malformed.frames.length, 5);
    assert.deepEqual(malformed.frames[4], {
      hook_event_name: 'PostToolUse',
      tool_name: 'legacy-safe',
      tool_input: { path: 'fallback.txt' },
      agent_id: 'pi-bridge-test'
    });

    const missingSocket = runBridge(source, { withoutSocket: true });
    assert.doesNotThrow(() => missingSocket.handlers.get('tool_result')({ toolName: 'read', input: {} }));
    assert.equal(missingSocket.connections(), 0);

    const connectFailure = runBridge(source, { connectThrows: true });
    assert.doesNotThrow(() => connectFailure.handlers.get('tool_result')({ toolName: 'read', input: {} }));

    const socketFailure = runBridge(source, { socketError: true });
    assert.doesNotThrow(() => socketFailure.handlers.get('tool_result')({ toolName: 'read', input: {} }));
    await socketFailure.flush();
    assert.equal(socketFailure.frames.length, 0);

    const stalledSocket = runBridge(source, { neverConnect: true });
    assert.doesNotThrow(() => stalledSocket.handlers.get('tool_result')({ toolName: 'read', input: {} }));
    assert.equal(stalledSocket.frames.length, 0, 'fire-and-forget bridge must not wait for a connection');
  });

  await t.test('contains serialization and callback failures without affecting auto-approval', async () => {
    const cyclic = {};
    cyclic.self = cyclic;
    const bridge = runBridge(source, { autoApprove: true });
    const result = bridge.handlers.get('tool_call')({
      toolName: 'write',
      input: cyclic,
      approve() { throw new Error('approval callback failed'); }
    });
    await bridge.flush();
    assert.equal(result.approve, true);
    assert.deepEqual(Object.keys(result), ['approve']);
    assert.equal(bridge.frames.length, 0, 'unserializable frames are dropped instead of collapsed');
  });

  await t.test('contains extension registration failures', () => {
    const missingApi = runBridge(source, { pi: {} });
    assert.equal(missingApi.activate({}), false);

    const failed = runBridge(source, { registrationFailure: 'tool_result' });
    assert.equal(failed.activate({
      on(event) {
        if (event === 'tool_result') throw new Error('registration failed');
      }
    }), false);
  });

  await t.test('keeps 13 distinct Pi calls healthy through the real breaker', async () => {
    const bridge = runBridge(source);
    const breaker = makeBreaker();
    for (let i = 1; i <= 13; i += 1) {
      bridge.handlers.get('tool_result')({
        toolName: 'bash',
        input: { command: `cmd-${String(i).padStart(2, '0')}` }
      });
    }
    await bridge.flush();
    const postFrames = bridge.frames.filter((frame) => frame.hook_event_name === 'PostToolUse');
    assert.equal(new Set(postFrames.map((frame) => JSON.stringify([frame.tool_name, frame.tool_input]))).size, 13);
    for (const frame of postFrames) {
      breaker.recordToolUse('pi-bridge-test', frame.tool_name, frame.tool_input);
    }
    assert.equal(tick(breaker, 1_000_000).state.level, 'healthy');
    assert.equal(tick(breaker, 1_030_000).state.level, 'healthy');
  });

  await t.test('still constrains eight genuinely identical Pi calls', async () => {
    const bridge = runBridge(source);
    const breaker = makeBreaker();
    for (let i = 0; i < 8; i += 1) {
      bridge.handlers.get('tool_result')({ toolName: 'bash', input: { command: 'git status' } });
    }
    await bridge.flush();
    for (const frame of bridge.frames) {
      breaker.recordToolUse('pi-bridge-test', frame.tool_name, frame.tool_input);
    }
    const first = tick(breaker, 1_000_000);
    const second = tick(breaker, 1_030_000);
    assert.equal(first.state.level, 'steering');
    assert.equal(second.state.level, 'constrained');
    assert.match(second.state.reason, /8× identical tool call \(bash\)/);
  });
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'md-codex-usage-'));
const fakeHome = path.join(fixtureRoot, 'home');
const agentCodexHome = path.join(fixtureRoot, 'hive', 'agents', 'worker-1', '.codex');
const ownSessions = path.join(agentCodexHome, 'sessions');
fs.mkdirSync(path.join(fakeHome, '.codex', 'sessions'), { recursive: true });
fs.mkdirSync(ownSessions, { recursive: true });
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;

test.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};

const loadTs = require('./load-ts.cjs');
const { parseCodexUsageTail, readCodexUsage } = loadTs('src/main/codexUsage.ts');
const { TelemetryCollector } = loadTs('src/main/telemetry.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const { CircuitBreaker } = loadTs('src/main/breaker.ts');

function tokenRow({
  timestamp = '2026-09-26T10:00:00.000Z',
  total = { input_tokens: 100, cached_input_tokens: 30, output_tokens: 40 },
  last = { input_tokens: 1, cached_input_tokens: 1, output_tokens: 1 },
  ...extra
} = {}) {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } },
    ...extra
  });
}

function writeSessionFile(name, content, root = ownSessions) {
  const dir = path.join(root, '2026', '09', '26');
  fs.mkdirSync(dir, { recursive: true });
  const filename = path.join(dir, name);
  fs.writeFileSync(filename, content);
  return filename;
}

test('parseCodexUsageTail uses the newest valid cumulative totals and maps token kinds exactly', () => {
  const older = tokenRow({
    timestamp: '2026-09-26T09:00:00.000Z',
    total: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 7, cache_write_input_tokens: 3 }
  });
  const newest = tokenRow({
    total: {
      input_tokens: 100,
      cached_input_tokens: 30,
      output_tokens: 40,
      reasoning_output_tokens: 900
    },
    last: { input_tokens: 999, cached_input_tokens: 888, output_tokens: 777 }
  });
  const tail = [older, newest, '{"type":"event_msg","payload":', '{"type":"unknown"}'].join('\n');

  assert.deepEqual(parseCodexUsageTail(tail), {
    input: 70,
    cacheRead: 30,
    cacheCreation: 0,
    output: 40,
    ts: Date.parse('2026-09-26T10:00:00.000Z')
  });
});

test('parseCodexUsageTail rejects invalid token values instead of falling back to them', async (t) => {
  const invalid = [
    ['negative', { input_tokens: -1, cached_input_tokens: 0, output_tokens: 1 }],
    ['fractional', { input_tokens: 1.5, cached_input_tokens: 0, output_tokens: 1 }],
    ['cached exceeds input', { input_tokens: 4, cached_input_tokens: 5, output_tokens: 1 }],
    ['negative cache write', { input_tokens: 4, cached_input_tokens: 1, output_tokens: 1, cache_write_input_tokens: -1 }]
  ];
  for (const [name, total] of invalid) {
    await t.test(name, () => assert.equal(parseCodexUsageTail(tokenRow({ total })), null));
  }
  assert.equal(parseCodexUsageTail('not json\n{"type":"event_msg"}\n{"type":"event_msg","payload":'), null);
});

test('readCodexUsage reads an own-session JSONL line spanning a 64 KiB block boundary', async () => {
  const expected = { input: 70, cacheRead: 30, cacheCreation: 0, output: 40 };
  const filename = writeSessionFile('long.jsonl', `${tokenRow({ padding: 'x'.repeat(70 * 1024) })}\n`);

  const actual = await readCodexUsage(filename, agentCodexHome);
  assert.deepEqual(actual && { input: actual.input, cacheRead: actual.cacheRead, cacheCreation: actual.cacheCreation, output: actual.output }, expected);
});

test('readCodexUsage never searches earlier than the final 1 MiB', async () => {
  const filename = writeSessionFile('beyond-tail.jsonl', `${tokenRow()}\n${'{}\n'.repeat(350_000)}`);
  assert.equal(await readCodexUsage(filename, agentCodexHome), null);
});

test('readCodexUsage accepts own-session JSONL and returns null for mundane invalid paths', async () => {
  const own = writeSessionFile('own.jsonl', `${tokenRow()}\n`);
  assert.ok(await readCodexUsage(own, agentCodexHome), 'own session should be accepted');

  const wrongExtension = writeSessionFile('own.txt', `${tokenRow()}\n`);
  assert.equal(await readCodexUsage(wrongExtension, agentCodexHome), null, 'non-jsonl should be rejected');

  const outside = writeSessionFile('outside.jsonl', `${tokenRow()}\n`, path.join(fixtureRoot, 'outside'));
  assert.equal(await readCodexUsage(outside, agentCodexHome), null, 'outside path should be rejected');
  assert.equal(await readCodexUsage(path.join(ownSessions, 'missing.jsonl'), agentCodexHome), null, 'missing file should not throw');
});

test('readCodexUsage rejects JSONL beneath agent home but outside its sessions directory', async () => {
  const agentHomeFile = path.join(agentCodexHome, 'not-a-session.jsonl');
  fs.writeFileSync(agentHomeFile, `${tokenRow()}\n`);
  assert.equal(await readCodexUsage(agentHomeFile, agentCodexHome), null);
});

test('readCodexUsage rejects another Codex session from the fake global home', async () => {
  const foreign = writeSessionFile('foreign.jsonl', `${tokenRow()}\n`, path.join(fakeHome, '.codex', 'sessions'));
  assert.equal(await readCodexUsage(foreign, agentCodexHome), null);
});

test('readCodexUsage realpath rejects a link escaping the own sessions directory', async (t) => {
  const outside = writeSessionFile('linked.jsonl', `${tokenRow()}\n`, path.join(fixtureRoot, 'link-target'));
  const link = path.join(ownSessions, 'linked-outside');
  try {
    fs.symlinkSync(path.dirname(outside), link, 'junction');
  } catch (error) {
    if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`links unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.equal(await readCodexUsage(path.join(link, path.basename(outside)), agentCodexHome), null);
});

test('HookServer forwards only complete Codex usage boundaries', () => {
  const seen = [];
  const hive = {
    recordSession() {},
    isGod() { return false; }
  };
  const server = new HookServer(
    hive,
    () => null,
    () => ({ notifications: false }),
    undefined,
    undefined,
    undefined,
    undefined,
    (event) => seen.push(event)
  );
  const base = { agent_id: 'worker-1', transcript_path: '/tmp/session.jsonl', session_id: 'session-1', model: 'gpt-5' };

  for (const hook_event_name of ['PostToolUse', 'Stop', 'PostCompact']) server.handle({ ...base, hook_event_name });
  server.handle({ ...base, hook_event_name: 'PreToolUse' });
  server.handle({ ...base, hook_event_name: 'Stop', session_id: undefined });

  assert.deepEqual(seen, ['PostToolUse', 'Stop', 'PostCompact'].map((event) => ({
    agentId: 'worker-1',
    event,
    transcriptPath: '/tmp/session.jsonl',
    sessionId: 'session-1',
    model: 'gpt-5'
  })));
});

test('ingestAgentUsage exposes snapshots, deduplicates them, and replaces a new session at zero USD', () => {
  const pushed = [];
  const emitted = [];
  const telemetry = new TelemetryCollector({ emit: (channel, payload) => emitted.push({ channel, payload }) });
  telemetry.onAgentUsage((sample) => pushed.push(sample));
  const first = {
    agentId: 'worker-1', sessionId: 'session-1', ts: 100,
    input: 70, output: 40, cacheRead: 30, cacheCreation: 0, model: 'gpt-5', usd: 0
  };

  telemetry.ingestAgentUsage(first);
  telemetry.ingestAgentUsage({ ...first });
  assert.deepEqual(telemetry.getAgentUsage('worker-1'), first);
  assert.deepEqual(telemetry.snapshot(), { usage: [first], spans: {} });
  assert.equal(pushed.length, 1);
  assert.equal(emitted.length, 1);

  const next = { ...first, sessionId: 'session-2', ts: 200, input: 3, output: 2 };
  telemetry.ingestAgentUsage(next);
  assert.deepEqual(telemetry.getAgentUsage('worker-1'), next);
  assert.deepEqual(telemetry.snapshot().usage, [next]);
  assert.equal(pushed.length, 2);
  assert.equal(emitted.length, 2);
  assert.equal(next.usd, 0);
});

function breaker(cap) {
  return new CircuitBreaker(() => ({
    enabled: true,
    hardStop: false,
    repeatedToolLimit: 8,
    errorStormLimit: 5,
    tokenVelocityPerMin: 60_000,
    agentTokenCaps: { 'worker-1': cap }
  }));
}

function breakerSample(cacheRead, cacheCreation = 200) {
  return {
    agentId: 'worker-1', sessionId: 'session-1', ts: 100,
    input: 500, output: 400, cacheRead, cacheCreation, model: 'gpt-5', usd: 0
  };
}

test('the per-agent breaker cap counts input, output, and cache creation', () => {
  const decision = breaker(1_099).tick([{
    agentId: 'worker-1', sample: breakerSample(0), progressing: true
  }], 100)[0];
  assert.equal(decision.state.level, 'steering');
  assert.equal(decision.action, 'steer');
});

test('a large cache read alone does not cross the per-agent breaker cap', () => {
  const decision = breaker(1_000).tick([{
    agentId: 'worker-1', sample: breakerSample(5_000_000, 0), progressing: true
  }], 100)[0];
  assert.equal(decision.state.level, 'healthy');
  assert.equal(decision.action, 'none');
});

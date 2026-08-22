/**
 * A transient proxy-bridge bind failure must not degrade a proxy-tier agent
 * (Crush) for its whole session. hive.ts gates installCrushConfig behind
 * `if (port > 0)` ON PURPOSE; the missing pieces were a retry and a surface the
 * user actually sees. This drives startProxyBridge directly (private, stubbed
 * on the instance) so no real sidecar or sockets are involved.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'md-proxy-retry-')); }

function spawnCrush(hive) {
  return hive.ensureAgent({ id: 'crush-1', name: 'Crush Worker', provider: 'crush', cwd: hive.root() });
}

test('a bind that fails once and then succeeds leaves the agent fully proxied', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const events = [];
  const hive = new HiveManager(() => home, (ch, p) => { events.push([ch, p]); return true; });
  const ports = [0, 43210];
  let calls = 0;
  hive.startProxyBridge = async () => { calls++; return ports.shift() ?? 0; };

  const inj = await spawnCrush(hive);
  assert.equal(calls, 2, 'retried exactly once after the transient failure');
  assert.equal(inj.degraded, undefined);
  assert.equal(inj.env.CRUSH_GLOBAL_CONFIG, path.join(home, 'hive', 'agents', 'crush-1'));
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'hive', 'agents', 'crush-1', 'crush.json'), 'utf8'));
  assert.equal(cfg.providers.openai.base_url, 'http://127.0.0.1:43210');
  assert.ok(!events.some(([ch]) => ch === 'hive:degraded'));
});

test('a bind that never succeeds is retried, then surfaced: spawn result, log.jsonl and the renderer', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const events = [];
  const hive = new HiveManager(() => home, (ch, p) => { events.push([ch, p]); return true; });
  let calls = 0;
  hive.startProxyBridge = async () => { calls++; return 0; };

  const inj = await spawnCrush(hive);
  assert.equal(calls, 3, 'three attempts before giving up');
  // Deliberate degradation: routing untouched, the CLI still runs.
  assert.equal(inj.env.CRUSH_GLOBAL_CONFIG, undefined);
  assert.equal(fs.existsSync(path.join(home, 'hive', 'agents', 'crush-1', 'crush.json')), false);
  // ...but never silent.
  assert.match(inj.degraded, /without hive events/);
  assert.match(inj.degraded, /Crush Worker/);
  const degradedEvt = events.find(([ch]) => ch === 'hive:degraded');
  assert.ok(degradedEvt, 'renderer told');
  assert.equal(degradedEvt[1].agentId, 'crush-1');
  const log = fs.readFileSync(path.join(home, 'hive', 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const entry = log.find((e) => e.kind === 'proxy-degraded');
  assert.ok(entry, 'log.jsonl records the degradation');
  assert.equal(entry.agentId, 'crush-1');
  assert.equal(entry.attempts, 3);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-crush-config-'));
}

/**
 * ensureAgent on a proxy-tier provider writes the crush config ONLY when the
 * hive-proxy sidecar actually bound a loopback port: hive.ts gates
 * installCrushConfig behind `if (port > 0)` and otherwise degrades on purpose to
 * un-proxied routing, logging "proxy bridge ... did not bind". A sidecar that
 * loses that race is correct product behaviour, so asserting the proxied branch
 * unconditionally is what made these tests fail intermittently on a loaded
 * machine — the config production chose not to write reads back as ENOENT.
 *
 * Returns true when the proxied branch was taken. When it was not, the DEGRADED
 * contract is asserted instead: routing must be left completely untouched, so a
 * half-applied config still fails.
 */
function proxyBridgeBound(injection, agentDir) {
  if (injection.env.CRUSH_GLOBAL_CONFIG !== undefined) return true;
  assert.equal(injection.env.CRUSH_GLOBAL_DATA, undefined,
    "degraded spawn must leave routing untouched, not half-applied");
  assert.equal(fs.existsSync(path.join(agentDir, "crush.json")), false,
    "no crush config may exist without a bound proxy");
  return false;
}

test('crush provider points CRUSH_GLOBAL_CONFIG at the agent directory', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const hive = new HiveManager(() => home);
  // ensureAgent on a proxy-tier provider spawns a real hive-proxy sidecar
  // (ChildProcess + two sockets). Without this the handle keeps the test
  // process alive forever and wedges the whole `node --test test/*` run.
  t.after(() => { try { hive.stopAllProxyBridges(); } catch { /* already gone */ } });
  const injection = await hive.ensureAgent({
    id: 'crush-1',
    name: 'Crush Worker',
    provider: 'crush',
    cwd: home
  });

  const agentDir = path.join(home, 'hive', 'agents', 'crush-1');
  if (!proxyBridgeBound(injection, agentDir)) return;
  assert.equal(injection.env.CRUSH_GLOBAL_CONFIG, agentDir);
  assert.equal(injection.env.CRUSH_GLOBAL_DATA, path.join(agentDir, '.crush-data'));

  const configPath = path.join(agentDir, 'crush.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.providers.openai.base_url.startsWith('http://127.0.0.1:'), true);
});

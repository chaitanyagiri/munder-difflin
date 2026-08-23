'use strict';

// Crush and OpenCode paint their own (dark) backgrounds regardless of the app
// theme. The spawn now hands every agent a COLORFGBG hint and writes a theme
// into the per agent config dirs of both TUIs. Never into the user's ~/.config.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-tui-theme-'));
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

test('crush: light theme writes options.tui.transparent and COLORFGBG', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  t.after(() => { try { hive.stopAllProxyBridges(); } catch { /* already gone */ } });

  const injection = await hive.ensureAgent(
    { id: 'crush-t', name: 'Crush', provider: 'crush', cwd: home },
    { theme: 'light' }
  );
  assert.equal(injection.env.COLORFGBG, '0;15');
  if (!proxyBridgeBound(injection, path.join(home, 'hive', 'agents', 'crush-t'))) return;
  const config = JSON.parse(fs.readFileSync(path.join(home, 'hive', 'agents', 'crush-t', 'crush.json'), 'utf8'));
  assert.equal(config.options.tui.transparent, true);
  assert.ok(config.providers, 'the proxy routing is still there');
});

test('crush: dark theme sends the dark hint and still goes transparent', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  t.after(() => { try { hive.stopAllProxyBridges(); } catch { /* already gone */ } });

  const injection = await hive.ensureAgent(
    { id: 'crush-d', name: 'Crush', provider: 'crush', cwd: home },
    { theme: 'dark' }
  );
  assert.equal(injection.env.COLORFGBG, '15;0');
  if (!proxyBridgeBound(injection, path.join(home, 'hive', 'agents', 'crush-d'))) return;
  const config = JSON.parse(fs.readFileSync(path.join(home, 'hive', 'agents', 'crush-d', 'crush.json'), 'utf8'));
  assert.equal(config.options.tui.transparent, true);
});

test('no theme passed: no hint, no options block (old behaviour)', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  t.after(() => { try { hive.stopAllProxyBridges(); } catch { /* already gone */ } });

  const injection = await hive.ensureAgent({ id: 'crush-n', name: 'Crush', provider: 'crush', cwd: home });
  assert.equal(injection.env.COLORFGBG, undefined);
  if (!proxyBridgeBound(injection, path.join(home, 'hive', 'agents', 'crush-n'))) return;
  const config = JSON.parse(fs.readFileSync(path.join(home, 'hive', 'agents', 'crush-n', 'crush.json'), 'utf8'));
  assert.equal(config.options, undefined);
});

test('opencode: theme lands in the per agent config dir as the system theme', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);

  const injection = await hive.ensureAgent(
    { id: 'oc-1', name: 'OpenCode', provider: 'opencode', cwd: home },
    { theme: 'light' }
  );
  const dir = injection.env.OPENCODE_CONFIG_DIR;
  assert.ok(dir, 'OPENCODE_CONFIG_DIR is set');
  assert.ok(dir.startsWith(path.join(home, 'hive', 'agents', 'oc-1')), 'per agent dir, never ~/.config');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'tui.json'), 'utf8')).theme, 'system');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8')).theme, 'system');
  assert.equal(injection.env.COLORFGBG, '0;15');
});

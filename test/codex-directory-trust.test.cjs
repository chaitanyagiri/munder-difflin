'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { codexRemoteAliasPath } = loadTs('src/shared/codexRemote.ts');

/** A per-agent CODEX_HOME starts life as a virgin config dir, so Codex asks
 *  "do you trust this directory?" on the first turn and a headless agent sits
 *  on the prompt forever. Pressing Yes persists exactly this table, and
 *  pre-seeding it suppresses the prompt (verified on Codex 0.149.1 — no flag or
 *  env does; `--dangerously-bypass-approvals-and-sandbox` does not). */
function trustTable(cwd) {
  return `[projects."${cwd}"]\ntrust_level = "trusted"`;
}

/** A hive home plus a `$HOME` whose `~/.codex/config.toml` is under our control:
 *  installCodexHooks seeds the generated config from the user's, so the test has
 *  to own that file to say anything about what survives. */
function sandbox(t, userConfig) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-codex-trust-')));
  const fakeHome = path.join(home, 'user-home');
  fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
  if (userConfig !== undefined) {
    fs.writeFileSync(path.join(fakeHome, '.codex', 'config.toml'), userConfig, 'utf8');
  }
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
}

async function prepCodexAgent(home, id, cwd) {
  const hive = new HiveManager(() => home);
  const injection = await hive.ensureAgent({ id, name: id, provider: 'codex', cwd });
  const codexHome = injection.env.CODEX_HOME;
  assert.ok(codexHome, 'a codex spawn must get an isolated CODEX_HOME');
  return { codexHome, config: fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8') };
}

test('codex spawn prep trusts the agent\'s final working directory', async (t) => {
  const home = sandbox(t);
  // Codex canonicalizes the directory it prompts about, so the entry has to be
  // stored realpath-resolved or it simply does not match and the prompt returns.
  const repo = path.join(home, 'repo');
  const via = path.join(home, 'symlinked-repo');
  fs.mkdirSync(repo, { recursive: true });
  fs.symlinkSync(repo, via, 'dir');

  const { config } = await prepCodexAgent(home, 'codex-trust-1', via);
  assert.ok(config.includes(trustTable(repo)), `no trust entry for ${repo} in:\n${config}`);
});

test('a working directory needing TOML escaping is escaped, not interpolated', async (t) => {
  const home = sandbox(t);
  const repo = path.join(home, 'we"ird\\repo');
  fs.mkdirSync(repo, { recursive: true });

  const { config } = await prepCodexAgent(home, 'codex-trust-2', repo);
  const escaped = `${home}/we\\"ird\\\\repo`;
  assert.ok(config.includes(trustTable(escaped)), `path was not TOML-escaped in:\n${config}`);
});

test('the user\'s own codex settings survive the trust entry', async (t) => {
  const home = sandbox(t, 'model = "gpt-5-codex"\n');
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo, { recursive: true });

  const { config } = await prepCodexAgent(home, 'codex-trust-3', repo);
  assert.ok(config.includes('model = "gpt-5-codex"'), `user setting was lost:\n${config}`);
  assert.ok(config.includes(trustTable(repo)), `no trust entry for ${repo} in:\n${config}`);
});

test('the short home alias used for remote control sees the trust entry', async (t) => {
  const home = sandbox(t);
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo, { recursive: true });

  const { codexHome } = await prepCodexAgent(home, 'codex-trust-4', repo);
  // Remote control runs the CLI against a short symlinked spelling of the same
  // home (macOS caps a Unix socket path at 104 bytes). Built here under the test
  // root rather than the production CODEX_REMOTE_ALIAS_ROOT so the test owns it.
  const alias = codexRemoteAliasPath(codexHome, 'codex-trust-4', path.join(home, 'alias'));
  fs.mkdirSync(path.dirname(alias), { recursive: true });
  fs.symlinkSync(codexHome, alias, 'dir');

  const config = fs.readFileSync(path.join(alias, 'config.toml'), 'utf8');
  assert.ok(config.includes(trustTable(repo)), `no trust entry for ${repo} in:\n${config}`);
});

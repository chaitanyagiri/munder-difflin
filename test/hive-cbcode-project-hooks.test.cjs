'use strict';

/**
 * T80 — cbcode floor-bridge recovery.
 *
 * cbcode strips the `--settings` flag we pass (its injectClaudeSettingsOverlay
 * replaces the flag-tier file with a gateway-headers overlay), so the lifecycle
 * hooks never register. The fix delivers the SAME generated hookSettings through
 * the project tier cbcode leaves alone: `<cwd>/.claude/settings.local.json`.
 *
 * These tests pin the three guarantees god asked for:
 *   1) a cbcode agent DOES get the project-tier hooks file (bridge recovered);
 *   2) the write is ADDITIVE — a pre-existing file's keys and hook arrays survive,
 *      ours are appended, never clobbered (Coinbase rule #2);
 *   3) a stock `claude` agent is UNCHANGED — no project-tier file is written.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-cbcode-'));
}
function projectSettings(cwd) {
  return path.join(cwd, '.claude', 'settings.local.json');
}

test('a cbcode agent gets the SAME hooks written to <cwd>/.claude/settings.local.json', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);

  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home }, { isCbcode: true });

  const target = projectSettings(home);
  assert.equal(fs.existsSync(target), true, 'cbcode must get a project-tier settings.local.json');
  const written = JSON.parse(fs.readFileSync(target, 'utf8'));
  // Same generator as the --settings file: the full lifecycle set + statusLine.
  for (const ev of ['Stop', 'SessionStart', 'PreToolUse', 'PostToolUse', 'PostCompact']) {
    assert.ok(Array.isArray(written.hooks[ev]) && written.hooks[ev].length >= 1, `hooks.${ev} present`);
  }
  assert.ok(written.statusLine && typeof written.statusLine.command === 'string', 'statusLine (context gauge) present');
  // It must be the identical shim the --settings path uses (agentDir/settings.json).
  const flagFile = JSON.parse(fs.readFileSync(path.join(home, 'hive', 'agents', 'a1', 'settings.json'), 'utf8'));
  assert.deepEqual(written.hooks.Stop, flagFile.hooks.Stop, 'project-tier hooks equal the --settings hooks (one format)');
});

test('the write is ADDITIVE — pre-existing keys and hooks are preserved, ours appended', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);

  // A settings.local.json already on disk (user- or cbcode-authored): a bespoke
  // top-level key, a statusLine, and a Stop hook of their own.
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const preExisting = {
    permissions: { allow: ['Bash(ls:*)'] },
    statusLine: { type: 'command', command: 'user-status-line', padding: 9 },
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'user-stop-hook' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'user-pretooluse' }] }]
    }
  };
  fs.writeFileSync(projectSettings(home), JSON.stringify(preExisting, null, 2), 'utf8');

  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home }, { isCbcode: true });

  const merged = JSON.parse(fs.readFileSync(projectSettings(home), 'utf8'));
  // 1) the user's unrelated key is untouched
  assert.deepEqual(merged.permissions, { allow: ['Bash(ls:*)'] }, 'unrelated key preserved');
  // 2) existing wins on a scalar/object conflict → the user's statusLine survives
  assert.equal(merged.statusLine.command, 'user-status-line', 'existing statusLine not clobbered');
  assert.equal(merged.statusLine.padding, 9);
  // 3) hook arrays CONCATENATE — the user's entry stays first, ours is appended
  const stopCmds = merged.hooks.Stop.map((e) => e.hooks[0].command);
  assert.equal(stopCmds[0], 'user-stop-hook', 'user Stop hook kept and first');
  assert.equal(stopCmds.length, 2, 'our Stop hook was appended, not replaced');
  assert.ok(stopCmds[1].includes('cth-hook'), 'the appended hook is our cth-hook shim');
  const preCmds = merged.hooks.PreToolUse.map((e) => e.hooks[0].command);
  assert.ok(preCmds.includes('user-pretooluse'), 'user PreToolUse hook preserved');
  // 4) an event only WE bring (SessionStart) is added
  assert.ok(Array.isArray(merged.hooks.SessionStart) && merged.hooks.SessionStart.length >= 1, 'our SessionStart added');
});

test('a corrupt pre-existing settings.local.json is left untouched, never clobbered', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);

  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(projectSettings(home), '{ this is not json', 'utf8');

  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home }, { isCbcode: true });

  assert.equal(fs.readFileSync(projectSettings(home), 'utf8'), '{ this is not json',
    'an unparseable file is preserved, not overwritten');
});

test('a stock claude agent (isCbcode falsy) writes NO project-tier file', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);

  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });

  assert.equal(fs.existsSync(projectSettings(home)), false,
    'stock claude path is unchanged — it relies on --settings, no repo write');
});

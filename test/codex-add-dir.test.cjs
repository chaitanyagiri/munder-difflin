'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};

const { HiveManager } = loadTs('src/main/hive.ts');
const { codexSandboxAllowsExtraRoots } = loadTs('src/shared/agentProvider.ts');

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'md-codex-add-dir-')); }
function count(values, wanted) { return values.filter((value) => value === wanted).length; }

const sandboxCases = [
  ['no flag', [], false],
  ['-s read-only', ['-s', 'read-only'], false],
  ['--sandbox read-only', ['--sandbox', 'read-only'], false],
  ['-s workspace-write', ['-s', 'workspace-write'], true],
  ['--sandbox workspace-write', ['--sandbox', 'workspace-write'], true],
  ['--sandbox=workspace-write', ['--sandbox=workspace-write'], true],
  ['danger-full-access', ['--sandbox', 'danger-full-access'], true],
  ['--full-auto', ['--full-auto'], true],
  ['full bypass', ['--dangerously-bypass-approvals-and-sandbox'], true],
  ['dangling -s', ['-s'], false],
  ['last sandbox read-only wins', ['-s', 'workspace-write', '-s', 'read-only'], false],
  ['last sandbox workspace-write wins', ['-s', 'read-only', '-s', 'workspace-write'], true],
  ['sandbox read-only overrides --full-auto', ['--full-auto', '-s', 'read-only'], false]
];

for (const [name, args, expected] of sandboxCases) {
  test(`codexSandboxAllowsExtraRoots: ${name}`, () => {
    assert.equal(codexSandboxAllowsExtraRoots(args), expected);
  });
}

test('ensureAgent omits Codex --add-dir without a writable sandbox', async () => {
  const home = tmpHome();
  const hive = new HiveManager(() => home);
  const inj = await hive.ensureAgent(
    { id: 'jim-read-only', name: 'Jim', provider: 'codex', cwd: home },
    { launchArgs: ['--model', 'x'] }
  );

  assert.equal(inj.args.includes('--add-dir'), false);
  assert.equal(count(inj.args, '--dangerously-bypass-hook-trust'), 1);
  assert.match(inj.args.at(-1), /^You are "Jim" \(jim-read-only\),/);
});

test('ensureAgent adds every Codex writable root once and keeps the prompt last', async () => {
  const home = tmpHome();
  const hive = new HiveManager(() => home);
  const palace = path.join(home, 'palace');
  const inj = await hive.ensureAgent(
    { id: 'jim-write', name: 'Jim', provider: 'codex', cwd: home },
    { launchArgs: ['-s', 'workspace-write'], extraWritableDirs: [palace] }
  );
  const agentDir = path.join(home, 'hive', 'agents', 'jim-write');
  const hiveRoot = path.join(home, 'hive');
  const addDirs = inj.args.flatMap((arg, i) => arg === '--add-dir' ? [inj.args[i + 1]] : []);

  assert.equal(count(addDirs, agentDir), 1);
  assert.equal(count(addDirs, hiveRoot), 1);
  assert.ok(addDirs.includes(palace));
  assert.equal(count(inj.args, '--dangerously-bypass-hook-trust'), 1);
  assert.match(inj.args.at(-1), /^You are "Jim" \(jim-write\),/);
});

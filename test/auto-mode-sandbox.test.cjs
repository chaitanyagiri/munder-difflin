/**
 * Auto mode keeps the OS sandbox ON.
 *
 * The app used to spawn every auto-mode agent with no sandbox at all (codex
 * `--dangerously-bypass-approvals-and-sandbox`; Claude with its opt-in sandbox
 * never enabled) for one reason: a hive worker writes to its agent folder under
 * <harnessHome>/hive/agents/<id>/, which sits OUTSIDE the project cwd. That is a
 * path-layout problem. Fix: keep the sandbox and declare those paths writable —
 * codex via `--add-dir`, Claude via `sandbox.filesystem.allowWrite` plus
 * `permissions.additionalDirectories` in the per-session settings file.
 *
 * The list also names the agent's OWN project cwd (#449). It used to carry only
 * the paths outside cwd, on the evidence that bypass mode still wrote cwd
 * itself; once `allowWrite` is present it is the whole answer, so agents lost
 * the ability to write in the directory they were hired to work in.
 */
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
const { autoModeFlagForProvider } = loadTs('src/shared/agentProvider.ts');

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'md-sandbox-')); }

test('codex auto mode is workspace-write with approvals off, never the full bypass', () => {
  const flag = autoModeFlagForProvider('codex');
  assert.equal(flag, '-a never -s workspace-write');
  assert.ok(!flag.includes('dangerously'));
});

test('a Claude agent gets a native sandbox that still allows its agent dir and the hive root', async () => {
  const home = tmpHome();
  const hive = new HiveManager(() => home);
  const palace = path.join(home, 'palace');
  const inj = await hive.ensureAgent(
    { id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home },
    { extraWritableDirs: [palace] }
  );
  const i = inj.args.indexOf('--settings');
  assert.ok(i >= 0, 'claude spawn carries --settings');
  const settings = JSON.parse(fs.readFileSync(inj.args[i + 1], 'utf8'));
  const agentDir = path.join(home, 'hive', 'agents', 'jim-1');
  const hiveRoot = path.join(home, 'hive');
  assert.equal(settings.sandbox.enabled, true);
  assert.notEqual(settings.sandbox.failIfUnavailable, true, 'Windows must still spawn');
  assert.deepEqual(settings.sandbox.filesystem.allowWrite, [home, agentDir, hiveRoot, palace],
    'the project cwd comes first, then the paths outside it');
  // Both layers, or the agent deadlocks: Edit/Write allowed but `mv … .done/` denied.
  assert.deepEqual(settings.permissions.additionalDirectories, settings.sandbox.filesystem.allowWrite);
  // No bypass of the sandbox anywhere in the injected args.
  assert.ok(!inj.args.some((a) => /dangerously/.test(a)));
});

test('the agent can write in the project it was hired to work in (#449)', async () => {
  // The reported shape: a project cwd that is NOT a parent of the hive, so
  // nothing else in the list happens to cover it. Before this fix every write
  // under the project — git commits, build output, rm, test artifacts — came
  // back "Operation not permitted".
  const home = tmpHome();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'md-project-'));
  const hive = new HiveManager(() => home);
  const inj = await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: project });
  const settings = JSON.parse(fs.readFileSync(inj.args[inj.args.indexOf('--settings') + 1], 'utf8'));

  assert.ok(settings.sandbox.filesystem.allowWrite.includes(project),
    'the project cwd is writable');
  assert.ok(settings.permissions.additionalDirectories.includes(project),
    'both layers, or Edit/Write is allowed while Bash is denied');
  // The hive paths it also needs are still there.
  assert.ok(settings.sandbox.filesystem.allowWrite.includes(path.join(home, 'hive', 'agents', 'jim-1')));
  assert.ok(settings.sandbox.filesystem.allowWrite.includes(path.join(home, 'hive')));
});

test('the cwd is named once, even when it is also passed as a writable dir', async () => {
  const home = tmpHome();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'md-project-'));
  const hive = new HiveManager(() => home);
  const inj = await hive.ensureAgent(
    { id: 'jim-1', name: 'Jim', provider: 'claude', cwd: project },
    { extraWritableDirs: [project] }
  );
  const settings = JSON.parse(fs.readFileSync(inj.args[inj.args.indexOf('--settings') + 1], 'utf8'));
  const seen = settings.sandbox.filesystem.allowWrite.filter((d) => d === project);
  assert.equal(seen.length, 1, 'no duplicate entry');
});

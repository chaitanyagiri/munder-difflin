'use strict';

/**
 * Sandboxed auto mode (config.sandboxedAutoMode).
 *
 * Auto mode historically DROPPED the OS sandbox each engine ships — Claude's
 * `bypassPermissions`, Codex's `--dangerously-bypass-approvals-and-sandbox` — for one
 * concrete reason: the HIVE PROTOCOL makes every worker write to `$AGENT_DIR`
 * (inbox→.done, memory.md, outbox JSON), a different path tree from its PTY cwd, and a
 * workspace-scoped sandbox blocks that.
 *
 * These tests pin the fix: the scoped flag is selected, and the extra WRITABLE ROOTS are
 * declared in the per-agent config we already author for each engine — so autonomy is
 * kept and the blast radius is bounded. They also pin the two ways this could silently
 * regress: a provider with no scoped mode must NOT lose its auto flag, and with the mode
 * off nothing may be written at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  providerPreset,
  autoModeFlagForProvider,
  providerIsSandboxable
} = loadTs('src/shared/agentProvider.ts');
const { buildSpawnCommand } = loadTs('src/renderer/src/store/config.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const auto = { defaultCommand: 'claude', autoMode: true };
const autoSandboxed = { ...auto, sandboxedAutoMode: true };

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-sandbox-mode-'));
}

// ─── flag selection ──────────────────────────────────────────────────────────

test('claude swaps bypassPermissions for a scoped mode when sandboxed', () => {
  assert.equal(buildSpawnCommand(auto, undefined, 'claude'), 'claude --permission-mode bypassPermissions');
  assert.equal(buildSpawnCommand(autoSandboxed, undefined, 'claude'), 'claude --permission-mode acceptEdits');
});

test('codex swaps the dangerous bypass for -a never -s workspace-write', () => {
  assert.equal(
    buildSpawnCommand(auto, undefined, 'codex'),
    'codex --dangerously-bypass-approvals-and-sandbox'
  );
  assert.equal(buildSpawnCommand(autoSandboxed, undefined, 'codex'), 'codex -a never -s workspace-write');
});

test('claude never gets --permission-mode auto: it is account-gated and rejected at startup', () => {
  // Spawning into a rejected flag would fail the whole agent, so the scoped mode has to
  // be one every account can use.
  assert.equal(providerPreset('claude').sandboxedAutoFlag.includes('auto'), false);
});

test('an engine with no scoped sandbox keeps its auto flag rather than losing autonomy', () => {
  const grok = providerPreset('grok');
  assert.equal(grok.sandboxedAutoFlag, undefined);
  assert.equal(providerIsSandboxable('grok'), false);
  assert.equal(buildSpawnCommand(autoSandboxed, undefined, 'grok'), buildSpawnCommand(auto, undefined, 'grok'));
  assert.equal(autoModeFlagForProvider('grok', { sandboxed: true }), grok.autoModeFlag);
});

test('sandboxedAutoMode is inert while auto mode is off', () => {
  const off = { defaultCommand: 'claude', autoMode: false, sandboxedAutoMode: true };
  assert.equal(buildSpawnCommand(off, undefined, 'claude'), 'claude');
  assert.equal(buildSpawnCommand(off, undefined, 'codex'), 'codex');
});

// ─── writable roots: Claude (per-agent settings.json) ────────────────────────

function settingsOf(home, id) {
  const p = path.join(home, 'hive', 'agents', id, 'settings.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

test('claude: the agent dir is declared to BOTH the tool layer and the bash sandbox', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);

  await hive.ensureAgent(
    { id: 'c1', name: 'C', provider: 'claude', cwd: home },
    { sandboxedAutoMode: true }
  );

  const s = settingsOf(home, 'c1');
  assert.ok(s, 'the per-agent settings file should exist');
  const dir = path.join(home, 'hive', 'agents', 'c1');
  // additionalDirectories governs the Edit/Write TOOLS; sandbox.filesystem.allowWrite
  // governs BASH SUBPROCESSES. Only one of the two and the agent deadlocks halfway
  // through the protocol (e.g. the tool is allowed but `mv … .done/` is denied).
  assert.deepEqual(s.permissions.additionalDirectories, [dir]);
  assert.equal(s.sandbox.enabled, true);
  assert.deepEqual(s.sandbox.filesystem.allowWrite, [dir]);
});

test('claude: with the mode off the settings file carries no sandbox keys at all', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);

  await hive.ensureAgent({ id: 'c2', name: 'C', provider: 'claude', cwd: home }, {});

  const s = settingsOf(home, 'c2');
  assert.ok(s, 'the per-agent settings file should still exist (hooks live there)');
  assert.equal('permissions' in s, false);
  assert.equal('sandbox' in s, false);
});

// ─── writable roots: Codex (--add-dir on argv) ───────────────────────────────

/** Every `--add-dir <path>` pair in a spawn injection's args, in order. */
function addDirs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--add-dir') out.push(args[i + 1]);
  return out;
}

test('codex: the agent dir rides in as --add-dir, ahead of the positional prompt', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);

  const inj = await hive.ensureAgent(
    { id: 'x1', name: 'X', provider: 'codex', cwd: home },
    { sandboxedAutoMode: true }
  );

  const dir = path.join(home, 'hive', 'agents', 'x1');
  assert.deepEqual(addDirs(inj.args), [dir]);
  // Codex takes its initial prompt POSITIONALLY, so every flag must precede it.
  const last = inj.args.indexOf('--add-dir');
  assert.ok(last < inj.args.length - 2, 'flags must come before the positional prompt');
});

test('codex: no --add-dir when the mode is off', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);

  const inj = await hive.ensureAgent({ id: 'x2', name: 'X', provider: 'codex', cwd: home }, {});
  assert.deepEqual(addDirs(inj.args), []);
});

// ─── which roots get granted ─────────────────────────────────────────────────

test('god gets HIVE_ROOT — it writes board.md/tasks.json — collapsed to ONE grant', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);

  await hive.ensureAgent(
    { id: 'g1', name: 'God', provider: 'claude', cwd: home, isGod: true },
    { sandboxedAutoMode: true }
  );

  const roots = settingsOf(home, 'g1').sandbox.filesystem.allowWrite;
  // HIVE_ROOT already contains agents/g1, so listing both would overstate the grant.
  assert.deepEqual(roots, [path.join(home, 'hive')]);
});

test('a non-absolute extra root is dropped instead of shipped into the policy', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);

  await hive.ensureAgent(
    { id: 'c3', name: 'C', provider: 'claude', cwd: home },
    { sandboxedAutoMode: true, extraWritableRoots: ['relative/palace', '', path.join(home, 'palace')] }
  );

  const roots = settingsOf(home, 'c3').sandbox.filesystem.allowWrite;
  assert.deepEqual(roots, [path.join(home, 'hive', 'agents', 'c3'), path.join(home, 'palace')]);
});

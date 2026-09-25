'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-memory-scope-config-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: {
    app: { getPath: () => userData },
    Notification: class { show() {} static isSupported() { return false; } }
  }
};

const { semanticMemoryAllowed } = loadTs('src/shared/agentProvider.ts');
const { buildPtyEnv } = loadTs('src/main/ptyEnv.ts');
const { readConfig } = loadTs('src/main/config.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const MEMORY_KEYS = [
  'MEMPALACE_PALACE_PATH',
  'MEMPALACE_EMBEDDING_MODEL',
  'MEMPALACE_EMBEDDING_DEVICE'
];

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

function writeRawConfig(value) {
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(value), 'utf8');
}

function tmpHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-memory-scope-hive-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function promptFrom(injection) {
  const i = injection.args.indexOf('--append-system-prompt');
  return i >= 0 ? injection.args[i + 1] : injection.args.at(-1);
}

function claudeWritableDirs(injection) {
  const i = injection.args.indexOf('--settings');
  assert.ok(i >= 0, 'Claude spawn carries --settings');
  return JSON.parse(fs.readFileSync(injection.args[i + 1], 'utf8'));
}

function codexAddedDirs(injection) {
  return injection.args.flatMap((arg, i) => arg === '--add-dir' ? [injection.args[i + 1]] : []);
}

test('semanticMemoryAllowed implements active, all, none, selected and rejected combinations', () => {
  for (const [memoryActive, providers, provider, expected] of [
    [false, undefined, 'claude', false],
    [false, [], 'claude', false],
    [false, ['claude'], 'claude', false],
    [false, ['claude'], 'codex', false],
    [true, undefined, 'claude', true],
    [true, [], 'claude', false],
    [true, ['claude', 'codex'], 'claude', true],
    [true, ['claude'], 'codex', false]
  ]) {
    assert.equal(
      semanticMemoryAllowed(memoryActive, providers, provider),
      expected,
      `${memoryActive}/${JSON.stringify(providers)}/${provider}`
    );
  }
});

test('readConfig treats every non-array semanticMemoryProviders value as undefined', () => {
  for (const value of [null, 'claude', { provider: 'claude' }, 1, true]) {
    writeRawConfig({ semanticMemoryProviders: value });
    assert.equal(readConfig().semanticMemoryProviders, undefined, JSON.stringify(value));
  }
});

test('readConfig removes invalid providers and duplicates while preserving order', () => {
  writeRawConfig({
    semanticMemoryProviders: ['codex', 'bogus', 'claude', 'codex', null, 7, 'claude']
  });
  assert.deepEqual(readConfig().semanticMemoryProviders, ['codex', 'claude']);
});

test('buildPtyEnv removes inherited MemPalace variables and preserves unrelated environment', () => {
  const env = buildPtyEnv(
    {
      PATH: '/parent/bin',
      KEEP_ME: 'yes',
      MEMPALACE_PALACE_PATH: '/secret/palace',
      MEMPALACE_EMBEDDING_MODEL: 'model',
      MEMPALACE_EMBEDDING_DEVICE: 'cpu'
    },
    '/resolved/bin',
    undefined,
    'linux',
    MEMORY_KEYS
  );
  assert.deepEqual(MEMORY_KEYS.filter((key) => key in env), []);
  assert.equal(env.KEEP_ME, 'yes');
  assert.equal(env.PATH, '/resolved/bin');
});

test('buildPtyEnv removes differently-cased inherited MemPalace variables on Windows', () => {
  const env = buildPtyEnv(
    {
      Path: 'C:\\parent',
      KEEP_ME: 'yes',
      MemPalace_Palace_Path: 'C:\\palace',
      mempalace_embedding_model: 'model',
      Mempalace_Embedding_Device: 'cpu'
    },
    'C:\\resolved',
    undefined,
    'win32',
    MEMORY_KEYS
  );
  assert.deepEqual(
    Object.keys(env).filter((key) => key.toUpperCase().startsWith('MEMPALACE_')),
    []
  );
  assert.equal(env.KEEP_ME, 'yes');
  assert.equal(env.PATH, 'C:\\resolved');
});

test('HiveManager.ensureAgent scopes the memory prompt and Palace write access for Claude', async (t) => {
  const home = tmpHome(t);
  const hive = new HiveManager(() => home);
  const palace = path.join(home, 'palace');
  const allowed = await hive.ensureAgent(
    { id: 'claude-on', name: 'Claude On', provider: 'claude', cwd: home },
    { semanticMemory: true, extraWritableDirs: [palace] }
  );
  const denied = await hive.ensureAgent(
    { id: 'claude-off', name: 'Claude Off', provider: 'claude', cwd: home },
    { semanticMemory: false, extraWritableDirs: [] }
  );

  assert.match(promptFrom(allowed), /Semantic memory:/);
  assert.doesNotMatch(promptFrom(denied), /Semantic memory:/);

  const allowedSettings = claudeWritableDirs(allowed);
  const deniedSettings = claudeWritableDirs(denied);
  assert.ok(allowedSettings.sandbox.filesystem.allowWrite.includes(palace));
  assert.ok(allowedSettings.permissions.additionalDirectories.includes(palace));
  assert.ok(!deniedSettings.sandbox.filesystem.allowWrite.includes(palace));
  assert.ok(!deniedSettings.permissions.additionalDirectories.includes(palace));
});

test('HiveManager.ensureAgent scopes the memory prompt and --add-dir Palace access for Codex', async (t) => {
  const home = tmpHome(t);
  const hive = new HiveManager(() => home);
  const palace = path.join(home, 'palace');
  const allowed = await hive.ensureAgent(
    { id: 'codex-on', name: 'Codex On', provider: 'codex', cwd: home },
    { semanticMemory: true, extraWritableDirs: [palace], launchArgs: ['-s', 'workspace-write'] }
  );
  const denied = await hive.ensureAgent(
    { id: 'codex-off', name: 'Codex Off', provider: 'codex', cwd: home },
    { semanticMemory: false, extraWritableDirs: [], launchArgs: ['-s', 'workspace-write'] }
  );

  assert.match(promptFrom(allowed), /Semantic memory:/);
  assert.doesNotMatch(promptFrom(denied), /Semantic memory:/);
  assert.ok(codexAddedDirs(allowed).includes(palace));
  const deniedDirs = codexAddedDirs(denied);
  assert.ok(deniedDirs.length > 0);
  assert.ok(!deniedDirs.includes(palace));
});

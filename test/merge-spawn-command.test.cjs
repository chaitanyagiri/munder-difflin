'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { mergeSpawnCommand } = loadTs('src/renderer/src/store/config.ts');
const { tokenizeCommand } = loadTs('src/shared/commandLine.ts');

const codexConfig = (autoMode) => ({ defaultCommand: 'codex', autoMode });
const claudeConfig = (autoMode) => ({ defaultCommand: 'claude', autoMode });

test('Codex model switch preserves -s workspace-write with auto mode off', () => {
  const actual = mergeSpawnCommand(
    'other-codex --model old -s workspace-write --profile work --log-level debug',
    codexConfig(false),
    'new',
    'codex',
    'codex'
  );

  assert.deepEqual(tokenizeCommand(actual), [
    'codex', '--model', 'new', '-s', 'workspace-write',
    '--profile', 'work', '--log-level', 'debug'
  ]);
});

test('Codex model switch emits the current auto mode once and keeps workspace-write once', () => {
  const actual = mergeSpawnCommand(
    'codex --model old -a never -s workspace-write --full-auto --dangerously-bypass-approvals-and-sandbox',
    codexConfig(true),
    'new',
    'codex',
    'codex'
  );
  const tokens = tokenizeCommand(actual);

  assert.deepEqual(tokens, ['codex', '--model', 'new', '-a', 'never', '-s', 'workspace-write']);
  assert.equal(tokens.filter((token) => token === '-a').length, 1);
  assert.equal(tokens.filter((token) => token === '-s').length, 1);
});

test('Codex preserves long sandbox form and read-only user restrictions', () => {
  const actual = mergeSpawnCommand(
    'codex -m old --sandbox workspace-write -s read-only',
    codexConfig(false),
    'new',
    'codex',
    'codex'
  );

  assert.deepEqual(tokenizeCommand(actual), [
    'codex', '--model', 'new', '--sandbox', 'workspace-write', '-s', 'read-only'
  ]);
});

test('Codex preserves --add-dir with a spaced path as one token', () => {
  const actual = mergeSpawnCommand(
    'codex --model old --add-dir "C:\\Users\\Ada Lovelace\\work tree"',
    codexConfig(false),
    'new',
    'codex',
    'codex'
  );

  assert.equal(actual, 'codex --model new --add-dir "C:\\Users\\Ada Lovelace\\work tree"');
  assert.deepEqual(tokenizeCommand(actual), [
    'codex', '--model', 'new', '--add-dir', 'C:\\Users\\Ada Lovelace\\work tree'
  ]);
});

test('Codex removes old approval-lowering flags when auto mode is off', () => {
  const actual = mergeSpawnCommand(
    'codex -a never --ask-for-approval=never --full-auto --dangerously-bypass-approvals-and-sandbox --profile safe',
    codexConfig(false),
    undefined,
    'codex',
    'codex'
  );

  assert.deepEqual(tokenizeCommand(actual), ['codex', '--profile', 'safe']);
});

test('Codex auto mode replaces duplicate old auto flags with one canonical flag', () => {
  const actual = mergeSpawnCommand(
    'codex -a never --ask-for-approval never -s workspace-write --sandbox workspace-write --full-auto',
    codexConfig(true),
    undefined,
    'codex',
    'codex'
  );

  assert.deepEqual(tokenizeCommand(actual), ['codex', '-a', 'never', '-s', 'workspace-write']);
});

test('Claude keeps --add-dir and removes bypass permission mode when auto mode is off', () => {
  const actual = mergeSpawnCommand(
    'claude --model old --add-dir "/tmp/team hive" --permission-mode bypassPermissions --dangerously-skip-permissions --verbose',
    claudeConfig(false),
    'new',
    'claude',
    'claude'
  );

  assert.deepEqual(tokenizeCommand(actual), [
    'claude', '--model', 'new', '--add-dir', '/tmp/team hive', '--verbose'
  ]);
});

test('Claude permission bypass follows auto mode and appears exactly once', () => {
  const actual = mergeSpawnCommand(
    'claude --permission-mode bypassPermissions --dangerously-skip-permissions --add-dir "/tmp/team hive"',
    claudeConfig(true),
    'new',
    'claude',
    'claude'
  );
  const tokens = tokenizeCommand(actual);

  assert.deepEqual(tokens, [
    'claude', '--model', 'new', '--permission-mode', 'bypassPermissions',
    '--add-dir', '/tmp/team hive'
  ]);
  assert.equal(tokens.filter((token) => token === '--permission-mode').length, 1);
});

test('provider switch from Codex to Claude discards every previous extra', () => {
  const actual = mergeSpawnCommand(
    'codex --model old -s read-only --add-dir "/tmp/keep only for codex" --profile work',
    claudeConfig(false),
    'claude-sonnet',
    'claude',
    'codex'
  );

  assert.equal(actual, 'claude --model claude-sonnet');
});

test('empty previous command returns only the rebuilt base', () => {
  const actual = mergeSpawnCommand('   ', codexConfig(true), 'new', 'codex', 'codex');

  assert.equal(actual, 'codex --model new -a never -s workspace-write');
});

test('--model=X and resume parameters are replaced instead of preserved', () => {
  const actual = mergeSpawnCommand(
    'codex --model=old resume session-1 --resume session-2 --profile work',
    codexConfig(false),
    'new',
    'codex',
    'codex'
  );

  assert.deepEqual(tokenizeCommand(actual), ['codex', '--model', 'new', '--profile', 'work']);
});

test('merged output round-trips through tokenizeCommand without splitting user values', () => {
  const actual = mergeSpawnCommand(
    'codex --model old --add-dir "D:\\shared projects\\hive" --profile "night shift"',
    codexConfig(false),
    'new',
    'codex',
    'codex'
  );

  assert.deepEqual(tokenizeCommand(actual), [
    'codex', '--model', 'new', '--add-dir', 'D:\\shared projects\\hive',
    '--profile', 'night shift'
  ]);
});

'use strict';

/**
 * D9 — an ephemeral worker (startEphemeralWorkerWatcher) and a voice-hire spawn
 * both call the shared spawnAgentCore directly, bypassing the renderer's Add
 * Agent flow. Only that renderer flow (buildSpawnCommand) ever baked autoMode's
 * bypass-permissions flag into a spawn — so both main-only paths reached Claude
 * with no flag and no args-array equivalent, regardless of the user's global
 * autoMode setting.
 *
 * Confirmed live: a worker spawned this way deadlocked — a cross-session message
 * to it came back "held for the recipient user's approval" with no surface for
 * anyone to ever grant that approval, since the worker also had no GUI card (D7).
 *
 * argsWithAutoModeFlag (src/shared/agentProvider.ts) is the fix: spawnAgentCore
 * now applies it to EVERY Claude spawn's args, so a main-only spawn gets the same
 * posture a GUI hire already had baked into its command string. It must be a
 * no-op for the GUI path (whose args already carry the flag from
 * buildSpawnCommand + tokenizeCommand) or agents would launch with the flag
 * duplicated on the command line.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { argsWithAutoModeFlag } = loadTs('src/shared/agentProvider.ts');

test('a main-only spawn (ephemeral worker, voice hire) gets the bypass flag when autoMode is on', () => {
  assert.deepEqual(
    argsWithAutoModeFlag([], true, 'claude'),
    ['--permission-mode', 'bypassPermissions']
  );
});

test('autoMode off leaves a main-only spawn in the same ask-first posture as a GUI hire', () => {
  assert.deepEqual(argsWithAutoModeFlag([], false, 'claude'), []);
});

test('a GUI hire\'s args (already tokenized from buildSpawnCommand) are left untouched, not duplicated', () => {
  const guiArgs = ['--model', 'claude-sonnet-5', '--permission-mode', 'bypassPermissions'];
  assert.deepEqual(argsWithAutoModeFlag(guiArgs, true, 'claude'), guiArgs);
});

test('other args on a main-only spawn are preserved alongside the appended flag', () => {
  assert.deepEqual(
    argsWithAutoModeFlag(['--model', 'claude-sonnet-5'], true, 'claude'),
    ['--model', 'claude-sonnet-5', '--permission-mode', 'bypassPermissions']
  );
});

test('the input array is never mutated in place', () => {
  const input = ['--model', 'claude-sonnet-5'];
  const result = argsWithAutoModeFlag(input, true, 'claude');
  assert.deepEqual(input, ['--model', 'claude-sonnet-5']);
  assert.notEqual(result, input);
});

test('a provider with no auto-mode flag (custom) is left alone', () => {
  assert.deepEqual(argsWithAutoModeFlag(['--foo'], true, 'custom'), ['--foo']);
});

test('codex\'s multi-token auto flag is applied the same way as Claude\'s two-token flag', () => {
  assert.deepEqual(
    argsWithAutoModeFlag(['--model', 'gpt-5.6-sol'], true, 'codex'),
    ['--model', 'gpt-5.6-sol', '-a', 'never', '-s', 'workspace-write']
  );
});

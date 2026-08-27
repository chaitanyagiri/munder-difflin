'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  inferAgentProvider,
  isAgentProvider,
  providerPreset
} = loadTs('src/shared/agentProvider.ts');
const {
  buildSpawnCommand,
  decodeProviderModel,
  encodeProviderModel,
  modelProvidersForAgent,
  modelsForProvider
} = loadTs('src/renderer/src/store/config.ts');

const autoConfig = { defaultCommand: 'claude', autoMode: true };

test('Kimi is a first-class inferred provider with autonomous defaults', () => {
  assert.equal(isAgentProvider('kimi'), true);
  assert.equal(inferAgentProvider('kimi --auto'), 'kimi');
  const preset = providerPreset('kimi');
  assert.equal(preset.defaultCommand, 'kimi');
  assert.equal(preset.autoFlag, '--auto');
  assert.equal(preset.supportsModel, true);
  assert.equal(preset.canReceiveInbox, false);
  assert.equal(preset.positionalInitialPrompt, undefined);
});

test('Gemini CLI has hooks, interactive seeding, resume, and current yolo mode', () => {
  assert.equal(isAgentProvider('gemini'), true);
  assert.equal(inferAgentProvider('/usr/local/bin/gemini --model pro'), 'gemini');
  const preset = providerPreset('gemini');
  assert.equal(preset.defaultCommand, 'gemini');
  assert.equal(preset.autoFlag, '--approval-mode=yolo');
  assert.equal(preset.supportsModel, true);
  assert.equal(preset.canReceiveInbox, true);
  assert.deepEqual(preset.bridge, { kind: 'hooks', shim: 'gemini' });
  assert.equal(preset.initialPromptFlag, '-i');
  assert.equal(preset.resumeFlag, '--resume');
  assert.equal(preset.installCommand, 'npm install -g @google/gemini-cli');
});

test('Grok is a first-class inferred provider with hooks, resume, and always-approve', () => {
  assert.equal(isAgentProvider('grok'), true);
  assert.equal(inferAgentProvider('/Users/test/.local/bin/grok --model grok-4.5'), 'grok');
  const preset = providerPreset('grok');
  assert.equal(preset.defaultCommand, 'grok');
  assert.equal(preset.autoFlag, '--permission-mode bypassPermissions');
  assert.equal(preset.supportsModel, true);
  assert.equal(preset.canReceiveInbox, true);
  assert.equal(preset.hookBridge, 'grok');
  assert.equal(preset.positionalInitialPrompt, true);
  assert.equal(preset.resumeFlag, '--resume');
});

test('provider commands use matching models and equivalent bypass modes', () => {
  assert.equal(
    buildSpawnCommand(autoConfig, 'claude-sonnet-5', 'claude'),
    'claude --model claude-sonnet-5 --permission-mode bypassPermissions'
  );
  assert.equal(
    buildSpawnCommand(autoConfig, 'gpt-5.6-sol', 'codex'),
    'codex --model gpt-5.6-sol --dangerously-bypass-approvals-and-sandbox'
  );
  assert.equal(
    buildSpawnCommand(autoConfig, 'grok-4.5', 'grok'),
    'grok --model grok-4.5 --permission-mode bypassPermissions'
  );
  assert.equal(
    buildSpawnCommand(autoConfig, 'kimi-code/k3', 'kimi'),
    'kimi --model kimi-code/k3 --auto'
  );
  assert.equal(
    buildSpawnCommand(autoConfig, 'pro', 'gemini'),
    'gemini --model pro --approval-mode=yolo'
  );
});

test('model picker options stay provider-specific', () => {
  assert.equal(
    modelsForProvider('claude').find((model) => model.id === 'claude-opus-5')?.label,
    'Opus 5 · 1M'
  );
  assert.deepEqual(
    modelsForProvider('codex').map((model) => model.id),
    [
      undefined,
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex-spark'
    ]
  );
  assert.deepEqual(
    modelsForProvider('grok').map((model) => model.id),
    [undefined, 'grok-4.6', 'grok-4.5']
  );
  assert.deepEqual(
    modelsForProvider('kimi').map((model) => model.id),
    [
      undefined,
      'kimi-code/k3',
      'kimi-code/kimi-for-coding',
      'kimi-code/kimi-for-coding-highspeed'
    ]
  );
  assert.deepEqual(
    modelsForProvider('gemini').map((model) => model.id),
    [undefined, 'auto', 'pro', 'flash', 'flash-lite']
  );
  assert.deepEqual(modelsForProvider('custom'), []);
});

test('Command Center model choices round-trip provider and model', () => {
  const encoded = encodeProviderModel('antigravity', 'Gemini 3.1 Pro (High)');
  assert.deepEqual(
    decodeProviderModel(encoded),
    { provider: 'antigravity', model: 'Gemini 3.1 Pro (High)' }
  );
  assert.deepEqual(
    decodeProviderModel(encodeProviderModel('kimi')),
    { provider: 'kimi', model: undefined }
  );
  assert.equal(decodeProviderModel('unknown:model'), null);
});

test('codex recommends the verified ChatGPT default', () => {
  const recommended = providerPreset('codex').recommendedOrchestratorModel;
  const codexIds = modelsForProvider('codex').map((model) => model.id);

  assert.equal(recommended, 'gpt-5.6-sol');
  assert.ok(
    codexIds.includes(recommended),
    `codex recommends ${recommended}, which its picker does not offer`
  );
});

test('God only sees providers that can drain hive inbox messages', () => {
  // God-eligible = supportsModel && canReceiveInbox: kimi and copilot are
  // excluded (no inbox drain path), custom is excluded (no model picker).
  // Cursor is interactive (no -p) so it IS god-eligible.
  assert.deepEqual(
    modelProvidersForAgent(true).map((preset) => preset.id),
    ['claude', 'codex', 'grok', 'gemini', 'antigravity', 'qwen', 'opencode', 'crush', 'pi', 'cursor']
  );
  assert.deepEqual(
    modelProvidersForAgent(false).map((preset) => preset.id),
    ['claude', 'codex', 'grok', 'kimi', 'gemini', 'antigravity', 'qwen', 'opencode', 'crush', 'pi', 'copilot', 'cursor']
  );
});

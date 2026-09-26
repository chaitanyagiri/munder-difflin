'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { argsForAutoMode } = loadTs('src/shared/agentProvider.ts');

const AUTO_FLAGS = {
  claude: ['--permission-mode', 'bypassPermissions'],
  codex: ['-a', 'never', '-s', 'workspace-write'],
  grok: ['--permission-mode', 'bypassPermissions'],
  kimi: ['--auto'],
  gemini: ['--approval-mode=yolo'],
  antigravity: ['--dangerously-skip-permissions'],
  qwen: ['--yolo'],
  opencode: [],
  crush: ['--yolo'],
  pi: ['--approve'],
  copilot: ['-s', '--allow-all-tools', '--no-ask-user'],
  cursor: ['--force', '--trust'],
  custom: []
};

for (const [provider, flag] of Object.entries(AUTO_FLAGS)) {
  test(`on: ${provider} appends its auto flag once without disturbing existing args`, () => {
    const input = ['--model', 'model-x', '--resume', 'session-7', 'prompt text'];
    const once = argsForAutoMode(input, true, provider);
    assert.deepEqual(once, [...input, ...flag]);
    assert.deepEqual(argsForAutoMode(once, true, provider), once);
  });
}

const RESTRICTIVE_STANCES = [
  ['claude', ['--permission-mode', 'plan']],
  ['claude', ['--permission-mode=plan']],
  ['grok', ['--permission-mode', 'plan']],
  ['grok', ['--permission-mode=plan']],
  ['codex', ['-s', 'read-only']],
  ['codex', ['--sandbox', 'read-only']],
  ['codex', ['--sandbox=read-only']],
  ['codex', ['-a', 'on-request']],
  ['codex', ['--ask-for-approval=on-request']],
  ['gemini', ['--approval-mode', 'default']],
  ['gemini', ['--approval-mode=default']]
];

for (const [provider, stance] of RESTRICTIVE_STANCES) {
  test(`on: ${provider} preserves explicit stance ${stance.join(' ')}`, () => {
    const input = ['--model', 'model-x', ...stance, 'prompt text'];
    assert.deepEqual(argsForAutoMode(input, true, provider), input);
  });
}

const OFF_CASES = {
  claude: {
    input: ['--model', 'c', '--permission-mode', 'bypassPermissions', '--permission-mode=plan', '--dangerously-skip-permissions', 'prompt'],
    want: ['--model', 'c', '--permission-mode=plan', 'prompt']
  },
  grok: {
    input: ['--permission-mode=bypassPermissions', '--resume', 'r1', '--permission-mode', 'plan', 'prompt'],
    want: ['--resume', 'r1', '--permission-mode', 'plan', 'prompt']
  },
  codex: {
    input: ['--model', 'o3', '-a', 'never', '-a=never', '--ask-for-approval', 'never', '--ask-for-approval=never', '-s', 'workspace-write', '--sandbox', 'read-only', '--sandbox=read-only', '-a', 'on-request', '-a=on-request', '--full-auto', '--dangerously-bypass-approvals-and-sandbox', '--unknown', 'value', 'prompt'],
    want: ['--model', 'o3', '-s', 'workspace-write', '--sandbox', 'read-only', '--sandbox=read-only', '-a', 'on-request', '-a=on-request', '--unknown', 'value', 'prompt']
  },
  kimi: { input: ['--auto', '--model', 'k', 'prompt'], want: ['--model', 'k', 'prompt'] },
  gemini: {
    input: ['--approval-mode', 'yolo', '--approval-mode=default', '--resume', 'r2', 'prompt'],
    want: ['--approval-mode=default', '--resume', 'r2', 'prompt']
  },
  antigravity: { input: ['-i', 'seed', '--dangerously-skip-permissions', '--conversation', 'c1'], want: ['-i', 'seed', '--conversation', 'c1'] },
  qwen: { input: ['--model', 'q', '--yolo', '--unknown', 'x'], want: ['--model', 'q', '--unknown', 'x'] },
  opencode: { input: ['--model', 'local/x', '--prompt', 'seed'], want: ['--model', 'local/x', '--prompt', 'seed'] },
  crush: { input: ['--yolo', '--model', 'cr', 'position'], want: ['--model', 'cr', 'position'] },
  pi: { input: ['--model', 'p', '--approve', '--no-tools', 'prompt'], want: ['--model', 'p', '--no-tools', 'prompt'] },
  copilot: {
    input: ['-s', '--allow-all-tools', '--no-ask-user', '--model', 'cp', '--resume', 'r3', 'prompt'],
    want: ['-s', '--no-ask-user', '--model', 'cp', '--resume', 'r3', 'prompt']
  },
  cursor: { input: ['--force', '--model', 'cu', '--trust', '--resume', 'r4'], want: ['--model', 'cu', '--resume', 'r4'] },
  custom: { input: ['--yolo', '--force', '--anything', 'prompt'], want: ['--yolo', '--force', '--anything', 'prompt'] }
};

for (const [provider, { input, want }] of Object.entries(OFF_CASES)) {
  test(`off: ${provider} removes only its approval-lowering forms`, () => {
    assert.deepEqual(argsForAutoMode(input, false, provider), want);
  });
}

test('off: equal-value forms are removed value-exactly and other values survive', () => {
  const cases = [
    ['claude', ['--permission-mode=bypassPermissions', '--permission-mode=plan'], ['--permission-mode=plan']],
    ['grok', ['--permission-mode=bypassPermissions', '--permission-mode=ask'], ['--permission-mode=ask']],
    ['codex', ['-a=never', '-a=on-request', '--ask-for-approval=never', '--ask-for-approval=on-request'], ['-a=on-request', '--ask-for-approval=on-request']],
    ['gemini', ['--approval-mode=yolo', '--approval-mode=default'], ['--approval-mode=default']]
  ];
  for (const [provider, input, want] of cases) {
    assert.deepEqual(argsForAutoMode(input, false, provider), want, provider);
  }
});

test('neither mode mutates the caller-owned array for any provider', () => {
  for (const provider of Object.keys(AUTO_FLAGS)) {
    for (const enabled of [true, false]) {
      const input = ['--model', 'm', ...(AUTO_FLAGS[provider] ?? []), '--unknown', 'x', 'prompt'];
      const before = [...input];
      argsForAutoMode(input, enabled, provider);
      assert.deepEqual(input, before, `${provider}, enabled=${enabled}`);
    }
  }
});

test('spawnAgentCore applies argsForAutoMode once for every provider before the Claude-only block', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/index.ts'), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('async function spawnAgentCore(');
  const end = source.indexOf("\nipcMain.handle('pty:write'", start);
  assert.ok(start >= 0 && end > start, 'spawnAgentCore source slice exists');

  const core = source.slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  const calls = core.match(/argsForAutoMode\s*\(/g) ?? [];
  assert.equal(calls.length, 1, 'spawnAgentCore must call argsForAutoMode exactly once');

  const call = core.indexOf('argsForAutoMode(');
  const claudeOnly = core.indexOf('if (opts.hive && claudeProvider)');
  assert.ok(call >= 0 && call < claudeOnly, 'normalization must be outside and before the Claude-only block');
  assert.match(core.slice(core.lastIndexOf('\n', call) + 1, core.indexOf('\n', call)),
    /^  opts\.args = argsForAutoMode\(opts\.args \?\? \[\], readConfig\(\)\.autoMode === true, provider\);$/,
    'the top-level call must use the resolved provider and global auto-mode state');
});

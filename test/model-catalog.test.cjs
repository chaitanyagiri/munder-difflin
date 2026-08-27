'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const catalog = require('../src/shared/modelCatalog.json');

const {
  ASSISTANT_MODEL,
  modelsForProvider,
  modelsForProviderAtVersion,
  runningAppVersion
} = loadTs('src/renderer/src/store/config.ts');

/** Every model the pickers offered while the lists were hardcoded TypeScript
 *  arrays, as `[id, label]` pairs — the providers whose full list no other test
 *  pins (provider-config.test.cjs pins codex/grok/kimi/gemini/custom). Moving
 *  the lists into JSON must not change one byte of what a user sees, and these
 *  literals are the only record of what shipped before the move. */
const SHIPPED = {
  claude: [
    ["claude-fable-5", "Fable 5"],
    ["claude-opus-5", "Opus 5 · 1M"],
    ["claude-opus-4-8", "Opus 4.8"],
    ["claude-opus-4-8[1m]", "Opus 4.8 · 1M"],
    ["claude-sonnet-5", "Sonnet 5"],
    ["claude-sonnet-4-6", "Sonnet 4.6"],
    ["claude-sonnet-4-6[1m]", "Sonnet 4.6 · 1M"],
    ["claude-haiku-4-5-20251001", "Haiku 4.5"]
  ],
  antigravity: [
    [undefined, "CLI default"],
    ["Gemini 3.1 Pro (High)", "Gemini 3.1 Pro · High"],
    ["Gemini 3.1 Pro (Low)", "Gemini 3.1 Pro · Low"],
    ["Gemini 3.5 Flash (High)", "Gemini 3.5 Flash · High"],
    ["Gemini 3.5 Flash (Medium)", "Gemini 3.5 Flash · Med"],
    ["Gemini 3.5 Flash (Low)", "Gemini 3.5 Flash · Low"],
    ["Claude Sonnet 4.6 (Thinking)", "Claude Sonnet 4.6"],
    ["Claude Opus 4.6 (Thinking)", "Claude Opus 4.6"],
    ["GPT-OSS 120B (Medium)", "GPT-OSS 120B"]
  ],
  qwen: [
    [undefined, "default"],
    ["qwen3-coder-plus", "Qwen3 Coder Plus"],
    ["qwen3-coder", "Qwen3 Coder"],
    ["qwen-max", "Qwen Max"]
  ],
  opencode: [
    [undefined, "CLI default"],
    ["anthropic/claude-sonnet-4-5", "Claude Sonnet 4.5 (Anthropic)"],
    ["anthropic/claude-haiku-4-5", "Claude Haiku 4.5 (Anthropic)"],
    ["openai/gpt-5", "GPT-5 (OpenAI)"],
    ["openai/gpt-5-mini", "GPT-5 mini (OpenAI)"],
    ["openrouter/anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5 (OpenRouter)"],
    ["google/gemini-2.5-pro", "Gemini 2.5 Pro (Google)"],
    ["local/llama3", "Local · OpenAI-compatible (set base-URL)"]
  ],
  crush: [
    [undefined, "Crush default (config)"],
    ["anthropic/claude-sonnet-4-5", "Claude Sonnet 4.5 (Anthropic)"],
    ["anthropic/claude-opus-4-1", "Claude Opus (Anthropic)"],
    ["openai/gpt-4o", "GPT-4o (OpenAI)"],
    ["openai/o3", "o3 (OpenAI)"],
    ["gemini/gemini-2.5-pro", "Gemini 2.5 Pro"],
    ["openrouter/auto", "OpenRouter (auto)"],
    ["openai/local", "Local · OpenAI-compatible (set base-URL)"]
  ],
  pi: [
    [undefined, "default"],
    ["anthropic/claude-sonnet-4-5", "Claude Sonnet 4.5 (Anthropic)"],
    ["anthropic/claude-opus-4-1", "Claude Opus (Anthropic)"],
    ["openai/gpt-5", "GPT-5 (OpenAI)"],
    ["google/gemini-2.5-pro", "Gemini 2.5 Pro (Google)"],
    ["groq/llama-3.3-70b", "Llama 3.3 70B (Groq)"],
    ["local/llama3", "Local · OpenAI-compatible (set base-URL)"]
  ],
  copilot: [
    [undefined, "default (Claude Sonnet 4.5)"],
    ["auto", "Auto (Copilot picks)"],
    ["claude-sonnet-4.5", "Claude Sonnet 4.5"],
    ["claude-sonnet-4", "Claude Sonnet 4"],
    ["gpt-5.4", "GPT-5.4"],
    ["gpt-5", "GPT-5"]
  ],
  cursor: [
    [undefined, "CLI default (auto)"],
    ["auto", "Auto"],
    ["gpt-5.6-luna-high", "GPT-5.6 Luna 1M High (cheap)"],
    ["gpt-5.6-sol-medium", "GPT-5.6 Sol 1M"],
    ["gpt-5.6-sol-high", "GPT-5.6 Sol 1M High"],
    ["composer-2.5", "Composer 2.5"],
    ["composer-2.5-fast", "Composer 2.5 Fast"],
    ["gpt-5.2", "GPT-5.2"],
    ["claude-opus-4-8-high", "Opus 4.8 1M"],
    ["claude-sonnet-5-thinking-high", "Sonnet 5 1M Thinking"]
  ],
};

/** A stand-in catalog: the real one is deliberately all-unbounded (the port had
 *  to be behaviour-identical), so the version bounds can only be exercised
 *  against models invented here. `modelsForProviderAtVersion` takes the provider
 *  map as its last argument for exactly this reason — the test drives the real
 *  filter, not a copy of it. */
const BOUNDED = {
  claude: [
    { id: 'unbounded', label: 'Unbounded', minAppVersion: null, maxAppVersion: null },
    { id: 'no-bound-keys', label: 'No bound keys at all' },
    { id: 'since-0.5.0', label: 'Ships in a later release', minAppVersion: '0.5.0', maxAppVersion: null },
    { id: 'since-0.4.5', label: 'Ships in this release', minAppVersion: '0.4.5', maxAppVersion: null },
    { id: 'until-0.4.4', label: 'Retired one release ago', minAppVersion: null, maxAppVersion: '0.4.4' },
    { id: 'until-0.4.5', label: 'Retired after this release', minAppVersion: null, maxAppVersion: '0.4.5' },
    { id: 'window', label: 'Only inside a window', minAppVersion: '0.4.0', maxAppVersion: '0.4.9' }
  ]
};

const ids = (models) => models.map((model) => model.id);

test('the pickers offer exactly the models that shipped before the catalog', () => {
  for (const [provider, expected] of Object.entries(SHIPPED)) {
    assert.deepEqual(
      modelsForProvider(provider).map((model) => [model.id, model.label]),
      expected,
      provider
    );
  }
});

test('the Claude list still offers the 1M-context assistant model', () => {
  // The hardcoded array built this entry out of the ASSISTANT_MODEL constant.
  // The catalog carries the id as a literal, so this is now the only thing
  // holding the picker entry and the constant together.
  assert.ok(ids(modelsForProvider('claude')).includes(ASSISTANT_MODEL));
});

test('the catalog is the schema config.ts expects', () => {
  assert.equal(catalog.version, 1);
  assert.deepEqual(
    Object.keys(catalog.providers).sort(),
    ['antigravity', 'claude', 'copilot', 'codex', 'crush', 'cursor', 'custom',
      'gemini', 'grok', 'kimi', 'opencode', 'pi', 'qwen'].sort()
  );
});

test('a model is offered only by the app versions its bounds cover', () => {
  assert.deepEqual(ids(modelsForProviderAtVersion('claude', '0.4.5', BOUNDED)), [
    'unbounded',
    'no-bound-keys',
    'since-0.4.5',
    'until-0.4.5',
    'window'
  ]);
  assert.deepEqual(ids(modelsForProviderAtVersion('claude', '0.5.0', BOUNDED)), [
    'unbounded',
    'no-bound-keys',
    'since-0.5.0',
    'since-0.4.5'
  ]);
  assert.deepEqual(ids(modelsForProviderAtVersion('claude', '0.3.0', BOUNDED)), [
    'unbounded',
    'no-bound-keys',
    'until-0.4.4',
    'until-0.4.5'
  ]);
});

test('both bounds are inclusive of the release named in them', () => {
  assert.ok(ids(modelsForProviderAtVersion('claude', '0.4.5', BOUNDED)).includes('since-0.4.5'));
  assert.ok(ids(modelsForProviderAtVersion('claude', '0.4.5', BOUNDED)).includes('until-0.4.5'));
  assert.ok(!ids(modelsForProviderAtVersion('claude', '0.4.4', BOUNDED)).includes('since-0.4.5'));
  assert.ok(!ids(modelsForProviderAtVersion('claude', '0.4.6', BOUNDED)).includes('until-0.4.5'));
});

test('a version the filter cannot read hides nothing', () => {
  // A picker that silently loses every model is far worse than one that offers
  // a model the running build cannot use, so an unreadable version fails open.
  assert.deepEqual(ids(modelsForProviderAtVersion('claude', '', BOUNDED)), ids(BOUNDED.claude));
});

test('an unknown provider falls back to the Claude list, custom to nothing', () => {
  assert.deepEqual(modelsForProvider('not-a-provider'), modelsForProvider('claude'));
  assert.deepEqual(modelsForProvider('custom'), []);
});

test('the filter reads the version the app was built with', () => {
  // electron-vite defines __APP_VERSION__ from package.json at build time; the
  // renderer already reads it that way for the update badge.
  globalThis.__APP_VERSION__ = '1.2.3';
  try {
    assert.equal(runningAppVersion(), '1.2.3');
  } finally {
    delete globalThis.__APP_VERSION__;
  }
  assert.equal(runningAppVersion(), '');
});

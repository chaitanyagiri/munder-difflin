'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const loadTs = require('./load-ts.cjs');
const { BUNDLED_SKILL_IDS, validateHireManifest } = loadTs('src/shared/hire.ts');
const { MCP_CATALOG } = loadTs('src/shared/mcpCatalog.ts');

const ROOT = path.resolve(__dirname, '..');

function loadGalleryValidator() {
  const source = fs.readFileSync(path.join(ROOT, 'docs/hires/validator.js'), 'utf8');
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'docs/hires/validator.js' });
  return context.window.HireSpec.validate;
}

const validateInGallery = loadGalleryValidator();

function manifest(overrides = {}) {
  return {
    spec: 'munder-difflin/hire@1',
    name: 'Parity check',
    ...overrides
  };
}

const parityCases = [
  {
    name: 'accepts a minimal manifest',
    raw: manifest(),
    expected: true
  },
  {
    name: 'accepts the provider alias and safe flags in split and inline forms',
    raw: manifest({
      provider: 'agy',
      commandFlags: ['--model', 'claude-sonnet-4-6', '--max-turns=80', '--output-format=json', '--verbose']
    }),
    expected: true
  },
  {
    name: 'accepts Cursor plus allowlisted skills and MCP servers',
    raw: manifest({
      provider: 'cursor',
      skills: ['md-hive-sync', 'md-audit'],
      mcpServers: ['fetch', 'github-token']
    }),
    expected: true
  },
  {
    name: 'accepts surrounding whitespace that the runtime trims from an https homepage',
    raw: manifest({ homepage: '  https://example.com/hire  ' }),
    expected: true
  },
  {
    name: 'rejects a permission-escalating flag',
    raw: manifest({ commandFlags: ['--permission-mode', 'bypassPermissions'] }),
    expected: false
  },
  {
    name: 'rejects an arbitrary provider-selection flag',
    raw: manifest({ commandFlags: ['--provider', 'attacker-controlled'] }),
    expected: false
  },
  {
    name: 'rejects the Codex config override short flag',
    raw: manifest({ commandFlags: ['-c', 'model_providers.evil.base_url=https://attacker.example'] }),
    expected: false
  },
  {
    name: 'rejects a second bare value after the safe flag value is consumed',
    raw: manifest({ commandFlags: ['--model', 'safe-model', 'unexpected'] }),
    expected: false
  },
  {
    name: 'rejects an unknown skill id',
    raw: manifest({ skills: ['read-secrets'] }),
    expected: false
  },
  {
    name: 'rejects more than eight skills',
    raw: manifest({ skills: Array(9).fill('md-audit') }),
    expected: false
  },
  {
    name: 'rejects a non-string skill id',
    raw: manifest({ skills: ['md-audit', 42] }),
    expected: false
  },
  {
    name: 'rejects an unknown MCP catalog id',
    raw: manifest({ mcpServers: ['attacker-server'] }),
    expected: false
  },
  {
    name: 'rejects more than eight MCP servers',
    raw: manifest({ mcpServers: Array(9).fill('fetch') }),
    expected: false
  },
  {
    name: 'rejects a non-string MCP catalog id',
    raw: manifest({ mcpServers: ['fetch', null] }),
    expected: false
  }
];

for (const { name, raw, expected } of parityCases) {
  test(`runtime and gallery validator ${name}`, () => {
    const runtime = validateHireManifest(raw);
    const gallery = validateInGallery(raw);

    assert.equal(runtime.ok, expected, `runtime errors: ${runtime.errors.join('; ')}`);
    assert.equal(
      gallery.ok,
      expected,
      `gallery result must match runtime; gallery errors: ${Array.from(gallery.errors).join('; ')}`
    );
    if (!expected) assert.ok(gallery.errors.length > 0, 'invalid input must explain why it was rejected');
  });
}

function findHireManifests(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return findHireManifests(fullPath);
    return entry.name.endsWith('.hire.json') ? [fullPath] : [];
  });
}

test('every published hire manifest passes both validators', () => {
  const files = findHireManifests(path.join(ROOT, 'docs/hires/manifests'));
  assert.ok(files.length > 0, 'expected published hire manifests');

  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const runtime = validateHireManifest(raw);
    const gallery = validateInGallery(raw);
    const relative = path.relative(ROOT, file);
    assert.equal(runtime.ok, true, `${relative}: runtime rejected: ${runtime.errors.join('; ')}`);
    assert.equal(gallery.ok, true, `${relative}: gallery rejected: ${Array.from(gallery.errors).join('; ')}`);
  }
});

test('every runtime provider and allowlisted capability id passes the gallery validator', () => {
  for (const provider of ['claude', 'antigravity', 'agy', 'codex', 'cursor']) {
    assert.equal(validateInGallery(manifest({ provider })).ok, true, `provider ${provider}`);
  }
  for (const skill of BUNDLED_SKILL_IDS) {
    assert.equal(validateInGallery(manifest({ skills: [skill] })).ok, true, `skill ${skill}`);
  }
  for (const { id } of MCP_CATALOG) {
    assert.equal(validateInGallery(manifest({ mcpServers: [id] })).ok, true, `MCP server ${id}`);
  }
});

test('runtime and gallery validators agree across every manifest field boundary', () => {
  const fieldCases = [
    {},
    { spec: undefined },
    { spec: 'munder-difflin/hire@2' },
    { name: undefined },
    { name: '' },
    { name: ' '.repeat(3) },
    { name: 'n'.repeat(40) },
    { name: 'n'.repeat(41) },
    { name: 42 },
    { description: null },
    { description: 'd'.repeat(200) },
    { description: 'd'.repeat(201) },
    { goal: 'g'.repeat(4000) },
    { goal: 'g'.repeat(4001) },
    { character: 'c'.repeat(25) },
    { accent: false },
    { model: 'Gemini 3.1 Pro (High)' },
    { model: 'model%PATH%' },
    { model: 'model&command' },
    { model: 'm'.repeat(81) },
    { provider: 'claude' },
    { provider: 'agy' },
    { provider: 'custom' },
    { provider: 42 },
    { commandFlags: [] },
    { commandFlags: Array(17).fill('--verbose') },
    { commandFlags: [42] },
    { commandFlags: ['value-first'] },
    { commandFlags: ['--model', 'safe', '--output-format=json'] },
    { commandFlags: ['--MODEL', 'safe'] },
    { commandFlags: ['--model', 'unsafe%value'] },
    { capabilities: null },
    { capabilities: Array(13).fill('tag') },
    { capabilities: ['valid', 42, ''] },
    { isolate: true },
    { isolate: 'true' },
    { tokenCap: 1 },
    { tokenCap: 1e10 },
    { tokenCap: 0 },
    { tokenCap: 1.5 },
    { tokenCap: 1e10 + 1 },
    { author: 'a'.repeat(81) },
    { homepage: null },
    { homepage: '   ' },
    { homepage: 'http://example.com' },
    { homepage: 'https://example.com' },
    { homepage: '  https://example.com/hire  ' },
    { skills: null },
    { skills: [] },
    { skills: [' md-audit '] },
    { skills: ['unknown'] },
    { mcpServers: null },
    { mcpServers: [] },
    { mcpServers: [' fetch '] },
    { mcpServers: ['unknown'] }
  ];

  for (const overrides of fieldCases) {
    const raw = manifest(overrides);
    const runtime = validateHireManifest(raw);
    const gallery = validateInGallery(raw);
    assert.equal(
      gallery.ok,
      runtime.ok,
      `${JSON.stringify(overrides)}\nruntime: ${runtime.errors.join('; ')}\ngallery: ${Array.from(gallery.errors).join('; ')}`
    );
  }
});

test('the published JSON schema reflects runtime providers and allowlists', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/hires/spec/hire.schema.json'), 'utf8'));
  assert.deepEqual(
    schema.properties.provider.enum,
    ['claude', 'antigravity', 'agy', 'codex', 'cursor']
  );
  assert.deepEqual(schema.properties.skills.items.enum, Array.from(BUNDLED_SKILL_IDS));
  assert.deepEqual(schema.properties.mcpServers.items.enum, MCP_CATALOG.map(({ id }) => id));

  const commandTokenPattern = new RegExp(schema.properties.commandFlags.items.pattern);
  for (const token of ['--model', '--model=claude-sonnet-4-6', '--max-turns', '80', '--output-format=json', '--verbose']) {
    assert.equal(commandTokenPattern.test(token), true, `schema should accept ${token}`);
  }
  for (const token of ['--provider', '--permission-mode=bypassPermissions', '%PATH%']) {
    assert.equal(commandTokenPattern.test(token), false, `schema should reject ${token}`);
  }
});

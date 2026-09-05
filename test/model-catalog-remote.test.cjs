'use strict';

/**
 * The REMOTE model catalog: the parser that guards the network payload, and the
 * overlay that merges it onto the list compiled into the build.
 *
 * The failure this file exists to prevent: a bad edit to docs/model-catalog.json
 * on main reaching every installed copy of the app and emptying a picker — or
 * worse, putting an attacker-shaped string on an agent's spawn command line. The
 * parser is total by contract, so every case below asserts the FALLBACK, not an
 * exception.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const baked = require('../src/shared/modelCatalog.json');

const { parseModelCatalog, CATALOG_SCHEMA_VERSION } =
  loadTs('src/shared/modelCatalogPayload.ts');
const { applyRemoteModelCatalog, modelsForProvider, agentModels } =
  loadTs('src/renderer/src/store/config.ts');

const ok = (providers) => ({ version: CATALOG_SCHEMA_VERSION, providers });

/** Every test that changes the live catalog must put it back, or the next file
 *  in the run inherits a catalog that never shipped. */
test.afterEach(() => applyRemoteModelCatalog(null));

// ─── the parser ─────────────────────────────────────────────────────────────

test('a well-formed catalog parses to exactly what it says', () => {
  const parsed = parseModelCatalog(ok({
    claude: [{ id: 'claude-fable-5-1', label: 'Fable 5.1' }],
    codex: [{ label: 'CLI default' }, { id: 'gpt-6-astra', label: 'GPT-6 Astra' }]
  }));
  assert.deepEqual(parsed, {
    version: 1,
    providers: {
      claude: [{ label: 'Fable 5.1', id: 'claude-fable-5-1' }],
      codex: [{ label: 'CLI default' }, { label: 'GPT-6 Astra', id: 'gpt-6-astra' }]
    }
  });
});

test('the shipped remote file is itself a valid catalog', () => {
  // docs/model-catalog.json is what actually goes over the wire. If it does not
  // survive its own parser, every app in the field silently keeps the baked list
  // and nobody finds out until a model is missing.
  const remote = require('../docs/model-catalog.json');
  const parsed = parseModelCatalog(remote);
  assert.ok(parsed, 'docs/model-catalog.json must parse');
  assert.deepEqual(
    Object.keys(parsed.providers).sort(),
    Object.keys(baked.providers).sort(),
    'the remote file should cover the same providers as the baked one'
  );
});

test('the remote file and the baked file agree on every model', () => {
  // They are seeded from each other. Drift here means a fresh install shows one
  // list for a few hours and a different one after the first refresh, which
  // reads as a bug in the picker rather than as two files out of sync.
  const remote = require('../docs/model-catalog.json');
  assert.deepEqual(remote.providers, baked.providers);
});

test('a version this build does not know is rejected whole', () => {
  assert.equal(parseModelCatalog({ version: 2, providers: { claude: [{ label: 'X' }] } }), null);
  assert.equal(parseModelCatalog({ providers: { claude: [{ label: 'X' }] } }), null);
  assert.equal(parseModelCatalog({ version: '1', providers: { claude: [{ label: 'X' }] } }), null);
});

test('anything that is not a catalog falls back rather than throwing', () => {
  for (const junk of [null, undefined, 0, 'catalog', [], [{ label: 'X' }], {},
    ok(null), ok([]), ok('claude')]) {
    assert.equal(parseModelCatalog(junk), null, JSON.stringify(junk) ?? String(junk));
  }
});

test('a row with no readable label is dropped, not rendered blank', () => {
  const parsed = parseModelCatalog(ok({
    claude: [{ id: 'no-label' }, { label: '   ' }, { label: 42 }, { id: 'kept', label: 'Kept' }]
  }));
  assert.deepEqual(parsed.providers.claude, [{ label: 'Kept', id: 'kept' }]);
});

test('an id is never allowed to carry a newline onto a command line', () => {
  // The id is spliced in as the --model value. A newline or a NUL is the one
  // input on this path with teeth, so it is neutralised rather than passed on.
  const parsed = parseModelCatalog(ok({
    claude: [{ id: 'gpt-6-astra\n--dangerously-skip-permissions', label: 'Nice\u0000 model' }]
  }));
  const [model] = parsed.providers.claude;
  assert.ok(!/[\u0000-\u001f\u007f]/.test(model.id), model.id);
  assert.ok(!/[\u0000-\u001f\u007f]/.test(model.label), model.label);
  assert.equal(model.id, 'gpt-6-astra --dangerously-skip-permissions');
});

test('ids and labels are length-capped', () => {
  const parsed = parseModelCatalog(ok({
    claude: [{ id: 'x'.repeat(500), label: 'y'.repeat(500) }]
  }));
  const [model] = parsed.providers.claude;
  assert.equal(model.id.length, 120);
  assert.equal(model.label.length, 60);
});

test('an empty id means "pass no --model flag", the same as no id at all', () => {
  const parsed = parseModelCatalog(ok({ codex: [{ id: '', label: 'CLI default' }] }));
  assert.deepEqual(parsed.providers.codex, [{ label: 'CLI default' }]);
});

test('a duplicated id renders once', () => {
  const parsed = parseModelCatalog(ok({
    claude: [{ id: 'a', label: 'First' }, { id: 'a', label: 'Second' }, { label: 'No id' }]
  }));
  assert.deepEqual(parsed.providers.claude.map((m) => m.label), ['First', 'No id']);
});

test('a provider whose rows all fail is dropped, an empty one is honoured', () => {
  const parsed = parseModelCatalog(ok({
    claude: [{ nope: true }, 'not an object'],   // all rows fail → drop the key
    custom: [],                                  // deliberately offers nothing
    grok: [{ id: 'grok-4.6', label: 'Grok 4.6' }]
  }));
  assert.deepEqual(Object.keys(parsed.providers).sort(), ['custom', 'grok']);
  assert.deepEqual(parsed.providers.custom, []);
});

test('a provider key that is not a slug never reaches the map', () => {
  const parsed = parseModelCatalog(ok({
    '__proto__': [{ id: 'x', label: 'X' }],
    'has space': [{ id: 'x', label: 'X' }],
    '9lives': [{ id: 'x', label: 'X' }],
    claude: [{ id: 'x', label: 'X' }]
  }));
  assert.deepEqual(Object.keys(parsed.providers), ['claude']);
  assert.equal(Object.prototype.hasOwnProperty.call({}, 'polluted'), false);
});

test('version bounds survive the parse', () => {
  const parsed = parseModelCatalog(ok({
    claude: [{ id: 'x', label: 'X', minAppVersion: '0.4.7', maxAppVersion: null }]
  }));
  assert.deepEqual(parsed.providers.claude, [{ label: 'X', id: 'x', minAppVersion: '0.4.7' }]);
});

// ─── the overlay ────────────────────────────────────────────────────────────

test('a remote provider replaces that list; the others keep the baked one', () => {
  const before = modelsForProvider('codex');
  assert.ok(applyRemoteModelCatalog(parseModelCatalog(ok({
    claude: [{ id: 'claude-next-9', label: 'Next 9' }]
  }))));
  assert.deepEqual(modelsForProvider('claude'), [{ id: 'claude-next-9', label: 'Next 9' }]);
  assert.deepEqual(modelsForProvider('codex'), before, 'codex was not in the remote copy');
});

test('the Claude-only surfaces read the overlay, not a snapshot', () => {
  // agentModels() is a function precisely because a const array would have been
  // captured at module load and would still be showing the baked list here.
  applyRemoteModelCatalog(parseModelCatalog(ok({
    claude: [{ id: 'claude-next-9', label: 'Next 9' }]
  })));
  assert.deepEqual(agentModels(), [{ id: 'claude-next-9', label: 'Next 9' }]);
});

test('clearing the overlay restores the models the build shipped with', () => {
  applyRemoteModelCatalog(parseModelCatalog(ok({ claude: [{ id: 'x', label: 'X' }] })));
  assert.equal(applyRemoteModelCatalog(null), true);
  assert.deepEqual(
    modelsForProvider('claude').map((m) => m.id),
    baked.providers.claude.map((m) => m.id)
  );
});

test('applying the same catalog twice reports no change', () => {
  const remote = parseModelCatalog(ok({ claude: [{ id: 'x', label: 'X' }] }));
  assert.equal(applyRemoteModelCatalog(remote), true);
  assert.equal(applyRemoteModelCatalog(remote), false, 'no pointless re-render event');
});

test('the version filter still runs over remote entries', () => {
  applyRemoteModelCatalog(parseModelCatalog(ok({
    claude: [
      { id: 'always', label: 'Always' },
      { id: 'later', label: 'Later', minAppVersion: '99.0.0' }
    ]
  })));
  // No __APP_VERSION__ define outside a build, so the filter fails open and
  // offers both — the deliberate "never hide every model" behaviour.
  assert.deepEqual(modelsForProvider('claude').map((m) => m.id), ['always', 'later']);
  globalThis.__APP_VERSION__ = '0.4.6';
  try {
    assert.deepEqual(modelsForProvider('claude').map((m) => m.id), ['always']);
  } finally {
    delete globalThis.__APP_VERSION__;
  }
});

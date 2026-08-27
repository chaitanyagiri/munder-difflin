'use strict';

/**
 * MCP toggle state helpers.
 *
 * applyToggle writes the requested map, then returns the persisted map used by
 * the component. resolveEnabledFor supplies catalog defaults for omitted ids.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { applyToggle, resolveEnabledFor } = loadTs('src/renderer/src/components/mcpToggleLogic.ts');

const { MCP_CATALOG } = loadTs('src/shared/mcpCatalog.ts');
const GITHUB_TOKEN_ID = 'github-token';

// ── applyToggle — the state-transition path ──────────────────────────────────

test('applyToggle returns mcpDefaults from getConfig when the write succeeds', async () => {
  const deps = {
    updateConfig: async () => ({}),
    getConfig: async () => ({ mcpDefaults: { [GITHUB_TOKEN_ID]: { enabled: true } } })
  };
  const result = await applyToggle(GITHUB_TOKEN_ID, true, {}, deps);
  assert.deepEqual(result[GITHUB_TOKEN_ID], { enabled: true });
});

test('applyToggle merges the id change into currentDefaults when calling updateConfig', async () => {
  const captured = [];
  const deps = {
    updateConfig: async (patch) => { captured.push(patch); return {}; },
    getConfig: async () => ({ mcpDefaults: { [GITHUB_TOKEN_ID]: { enabled: true } } })
  };
  const currentDefaults = { 'some-other-server': { enabled: true } };
  await applyToggle(GITHUB_TOKEN_ID, true, currentDefaults, deps);
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0].mcpDefaults, {
    'some-other-server': { enabled: true },
    [GITHUB_TOKEN_ID]: { enabled: true }
  });
});

// ── resolveEnabledFor — catalog fallback path ────────────────────────────────

test('resolveEnabledFor falls back to the catalog defaultEnabled for an unset id', () => {
  const entry = MCP_CATALOG.find((e) => e.id === GITHUB_TOKEN_ID);
  assert.ok(entry, `${GITHUB_TOKEN_ID} must exist in the catalog`);
  const result = resolveEnabledFor({}, GITHUB_TOKEN_ID);
  assert.equal(result, entry.defaultEnabled ?? false);
});

test('resolveEnabledFor returns false for a completely unknown id', () => {
  assert.equal(resolveEnabledFor({}, 'not-a-real-server'), false);
});

test('resolveEnabledFor respects explicit false even when catalog default is true', () => {
  // Fixture catalog: one entry with defaultEnabled:true
  const fixtureCatalog = [{ id: GITHUB_TOKEN_ID, defaultEnabled: true, tier: 'safe-readonly', label: 'x', description: '' }];
  const overrides = { [GITHUB_TOKEN_ID]: { enabled: false } };
  assert.equal(resolveEnabledFor(overrides, GITHUB_TOKEN_ID, fixtureCatalog), false,
    'explicit human opt-out must beat the catalog default');
});

test('resolveEnabledFor uses the injected catalog, not a shared constant', () => {
  // This test uses a FIXTURE catalog with a custom id — never in the real catalog.
  // If resolveEnabledFor shared the catalog constant with the test, this id would
  // not be found and the fallback (false) would mask a wrong catalog lookup.
  const fixtureCatalog = [{ id: 'fixture-server', defaultEnabled: true, tier: 'safe-readonly', label: 'x', description: '' }];
  assert.equal(resolveEnabledFor({}, 'fixture-server', fixtureCatalog), true,
    'catalog param drives the defaultEnabled fallback');
  assert.equal(resolveEnabledFor({}, 'fixture-server'), false,
    'real catalog has no fixture-server, so fallback is false — confirms injection works');
});

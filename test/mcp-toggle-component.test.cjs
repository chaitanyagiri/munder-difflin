'use strict';

/**
 * Component coverage for the stale configuration prop regression.
 *
 * test/mcp-toggle-state.test.cjs covers the two functions that were extracted
 * out of McpDefaultsSettings. It does not cover McpDefaultsSettings. Comment
 * out the `setMcpDefaults(await applyToggle(...))` line and every one of those
 * tests stays green while the stale-prop bug returns in full. So these tests
 * mount the real component, click the real button, and read the real rendered
 * label.
 *
 * The control under test is a consent control. `github-token` is tier `secret`
 * with defaultEnabled:false — it is only ever on because a human turned it on.
 * The component must render the persisted value after a toggle and remount.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
// MUST come before loadTs of any component — it seeds require.cache for react.
const { mount, flatten, text } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const { McpDefaultsSettings } = loadTs('src/renderer/src/components/McpDefaultsSettings.tsx');

// The id under test, written out literally. NOT imported from the catalog: a
// test that asks the implementation which id to check cannot notice the id
// changing, and this one must always name an upstream catalog entry.
const GITHUB_TOKEN = 'github-token';

/** The label the toggle button renders for a catalog id: 'on' | 'off'. */
function buttonLabel(tree, id) {
  const hit = flatten(tree).find((e) => e.key === id && e.node.type === 'button');
  assert.ok(hit, `no toggle button rendered for "${id}"`);
  return text(hit.node).join('');
}

/** Click the toggle button for a catalog id, exactly as a user would. */
function click(tree, id) {
  const hit = flatten(tree).find((e) => e.key === id && e.node.type === 'button');
  assert.ok(hit, `no toggle button rendered for "${id}"`);
  assert.equal(typeof hit.node.props.onClick, 'function', 'the button must be clickable');
  hit.node.props.onClick();
}

/**
 * Stand in for the preload bridge. `disk` is the real subject: updateConfig
 * writes into it and getConfig reads back out of it.
 */
function fakeBridge({ disk = {} } = {}) {
  const calls = { updateConfig: [], getConfig: 0 };
  const state = { mcpDefaults: { ...disk } };
  global.window = {
    cth: {
      updateConfig: async (patch) => {
        calls.updateConfig.push(patch);
        state.mcpDefaults = { ...patch.mcpDefaults };
        return {};
      },
      getConfig: async () => { calls.getConfig += 1; return { mcpDefaults: { ...state.mcpDefaults } }; }
    }
  };
  return { calls, state };
}

/** Let the click's async chain settle. */
const settle = () => new Promise((r) => setImmediate(r));

test.afterEach(() => { delete global.window; });

// ── 1. the component renders from the resolver, not from nothing ─────────────

test('an unset consent-tier server renders off', () => {
  fakeBridge();
  const inst = mount(McpDefaultsSettings, { config: { mcpDefaults: {} } });
  assert.equal(buttonLabel(inst.tree, GITHUB_TOKEN), 'off',
    'github-token is secret tier, defaultEnabled:false — unset must read as NOT granted');
});

test('a stored grant renders on', () => {
  fakeBridge();
  const inst = mount(McpDefaultsSettings, { config: { mcpDefaults: { [GITHUB_TOKEN]: { enabled: true } } } });
  assert.equal(buttonLabel(inst.tree, GITHUB_TOKEN), 'on');
});

// ── 2. the wiring — this is what the extracted-function tests cannot see ─────

test('clicking the toggle writes the merged map and re-renders from the disk read', async () => {
  const { calls } = fakeBridge({ disk: { 'other-server': { enabled: true } } });
  const inst = mount(McpDefaultsSettings, {
    config: { mcpDefaults: { 'other-server': { enabled: true } } }
  });
  assert.equal(buttonLabel(inst.tree, GITHUB_TOKEN), 'off');

  click(inst.tree, GITHUB_TOKEN);
  await settle();

  assert.equal(calls.updateConfig.length, 1, 'the click must reach updateConfig');
  assert.deepEqual(calls.updateConfig[0].mcpDefaults, {
    'other-server': { enabled: true },
    [GITHUB_TOKEN]: { enabled: true }
  }, 'the patch replaces mcpDefaults wholesale, so it must carry the other entries');
  assert.ok(calls.getConfig >= 1, 'the component must RE-READ after writing, not trust the write');

  assert.equal(buttonLabel(inst.render(), GITHUB_TOKEN), 'on',
    'the rendered label must follow the persisted config read');
  assert.ok(text(inst.render()).join('').includes(`${GITHUB_TOKEN}: enabled`),
    'the confirmation note must name what was granted');
});

test('a failed write leaves the label alone and says so', async () => {
  // A disk that never accepts the write, and never claims it did.
  global.window = {
    cth: {
      updateConfig: async () => { throw new Error('EACCES'); },
      getConfig: async () => ({ mcpDefaults: {} })
    }
  };
  const inst = mount(McpDefaultsSettings, { config: { mcpDefaults: {} } });
  click(inst.tree, GITHUB_TOKEN);
  await settle();
  assert.equal(buttonLabel(inst.render(), GITHUB_TOKEN), 'off',
    'a throw must never leave the control claiming the grant went through');
  assert.ok(text(inst.render()).join('').includes('could not save'));
});

// ── 3. the stale-prop bug, on REMOUNT ──────────────────────────────────────────

test('the granted state survives closing and reopening the panel', async () => {
  // SettingsModal renders <McpDefaultsSettings config={config} /> only while
  // activeSection === 'Connections', and SettingsModal's own `config` prop is
  // App's, which App loads once at start-up and never refreshes after a save.
  // So switching settings sections and back is a real REMOUNT against a config
  // object that still says the grant never happened.
  const stale = { mcpDefaults: { [GITHUB_TOKEN]: { enabled: false } } };
  const { state } = fakeBridge({ disk: { [GITHUB_TOKEN]: { enabled: false } } });

  const first = mount(McpDefaultsSettings, { config: stale });
  click(first.tree, GITHUB_TOKEN);
  await settle();
  assert.equal(buttonLabel(first.render(), GITHUB_TOKEN), 'on');
  assert.equal(state.mcpDefaults[GITHUB_TOKEN].enabled, true, 'the grant is on disk');

  // …user switches to another settings section and comes back. Same stale prop.
  const second = mount(McpDefaultsSettings, { config: stale });
  await settle();
  assert.equal(buttonLabel(second.render(), GITHUB_TOKEN), 'on',
    'seeding from the prop alone re-runs the original stale-prop bug: '
    + 'the write landed, and the control shows off');
});

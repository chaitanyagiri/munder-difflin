'use strict';

/**
 * The provider-descriptor refactor is a NO-OP for MemPalace: an existing config
 * with no memoryProvider key must produce the same binary name, the same env
 * vars and byte-identical argv as the literals the descriptors replaced
 * (memory.ts:368 / :436-437 / :443-444 and the env at :201-214, pre-refactor).
 * These tests pin those bytes — if anyone moves an argv, they fail.
 *
 * The lumberroom entry is pinned against the CLI's actual Rust dispatch:
 * `search --limit/--namespace`, `bootstrap --project`, `whoami` exiting 2 when
 * unauthenticated — and against the design decisions that it has NO mine argv,
 * NO local store, and NO per-agent scope.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { MEMORY_PROVIDERS, memoryProviderById } = loadTs('src/main/memoryProviders.ts');
const mp = MEMORY_PROVIDERS.mempalace;
const lr = MEMORY_PROVIDERS.lumberroom;

// ─── mempalace: byte-identical to the pre-refactor literals ──────────────────

test('mempalace bin name is unchanged', () => {
  assert.equal(mp.bin, 'mempalace');
});

test('mempalace search argv matches the old literals exactly', () => {
  assert.deepEqual(
    mp.searchArgs('how do we deploy', { results: 5 }),
    ['search', 'how do we deploy', '--results', '5']
  );
  assert.deepEqual(
    mp.searchArgs('q', { scope: 'worker-1', results: 12 }),
    ['search', 'q', '--results', '12', '--wing', 'worker-1']
  );
});

test('mempalace wake-up argv matches the old literals exactly', () => {
  assert.deepEqual(mp.wakeUpArgs(), ['wake-up']);
  assert.deepEqual(mp.wakeUpArgs('god'), ['wake-up', '--wing', 'god']);
});

test('mempalace mine argv matches the old literal exactly', () => {
  assert.deepEqual(
    mp.mineArgs('/hive/agents/jim', 'jim'),
    ['mine', '/hive/agents/jim', '--wing', 'jim', '--agent', 'jim']
  );
});

test('mempalace env emits the same vars as the old childEnv/env', () => {
  assert.deepEqual(
    mp.env({ palacePath: '/home/palace', model: 'minilm', device: undefined }),
    { MEMPALACE_PALACE_PATH: '/home/palace', MEMPALACE_EMBEDDING_MODEL: 'minilm' }
  );
  assert.deepEqual(
    mp.env({ palacePath: null, model: 'embeddinggemma', device: 'cpu' }),
    {
      MEMPALACE_PALACE_PATH: '',
      MEMPALACE_EMBEDDING_MODEL: 'embeddinggemma',
      MEMPALACE_EMBEDDING_DEVICE: 'cpu'
    }
  );
});

test('mempalace keeps its per-agent wing scope and local palace dir', () => {
  assert.equal(mp.scopeForAgent('worker-2'), 'worker-2');
  assert.equal(mp.localStorePath('/harness'), path.join('/harness', 'palace'));
  assert.equal(mp.auth, undefined, 'a local directory needs no credential');
});

test('an absent or unknown memoryProvider key resolves to mempalace', () => {
  assert.equal(memoryProviderById(undefined), mp);
  assert.equal(memoryProviderById('mempalace'), mp);
  assert.equal(memoryProviderById('something-else'), mp);
  assert.equal(memoryProviderById('lumberroom'), lr);
});

// ─── lumberroom: pinned to the CLI's real flags and the design decisions ─────

test('lumberroom search uses --limit and --namespace (there is no --results)', () => {
  assert.deepEqual(
    lr.searchArgs('deploy steps', { results: 5 }),
    ['search', 'deploy steps', '--limit', '5']
  );
  assert.deepEqual(
    lr.searchArgs('q', { scope: 'project:munder-difflin', results: 3 }),
    ['search', 'q', '--limit', '3', '--namespace', 'project:munder-difflin']
  );
});

test('lumberroom digest is `bootstrap`, scoped by --project only', () => {
  assert.deepEqual(lr.wakeUpArgs(), ['bootstrap']);
  assert.deepEqual(lr.wakeUpArgs('my-repo'), ['bootstrap', '--project', 'my-repo']);
});

test('lumberroom has NO mine argv — `ingest` is not a directory miner', () => {
  assert.equal(lr.mineArgs, undefined);
});

test('lumberroom drops the per-agent scope — namespaces are per-subject', () => {
  assert.equal(lr.scopeForAgent('worker-2'), undefined);
});

test('lumberroom has no local store — an app reset must not wipe anything', () => {
  assert.equal(lr.localStorePath, undefined);
});

test('lumberroom auth probe is `whoami`, unauthenticated = exit 2', () => {
  assert.deepEqual(lr.auth.probeArgs, ['whoami']);
  assert.equal(lr.auth.unauthenticatedExit, 2);
  assert.equal(lr.auth.loginCommand, 'lumberroom login');
});

test('lumberroom injects no env — the CLI resolves its own config and token', () => {
  assert.deepEqual(lr.env({ palacePath: null, model: 'minilm', device: 'cpu' }), {});
});

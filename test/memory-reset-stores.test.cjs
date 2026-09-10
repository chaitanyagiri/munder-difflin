'use strict';

/**
 * app:resetAll must erase EVERY provider's local store, not just the one
 * currently configured. A user who ran mempalace for months, switched to
 * lumberroom, then hit Reset app kept <harnessHome>/palace on disk — reset
 * only ever asked memory.palacePath() for the CURRENTLY selected provider.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { MemoryManager } = loadTs('src/main/memory.ts');

function manager(provider) {
  return new MemoryManager(() => '/harness', () => ({ enabled: true, model: 'minilm', provider }));
}

test('allLocalStorePaths returns every provider with a local store, regardless of which is selected', () => {
  const withMempalace = manager('mempalace');
  const withLumberroom = manager('lumberroom');

  // Both must return mempalace's palace path — lumberroom has none of its own
  // (it's remote-backed) but its local store list must still include
  // whatever mempalace left behind.
  assert.deepEqual(withMempalace.allLocalStorePaths(), [path.join('/harness', 'palace')]);
  assert.deepEqual(withLumberroom.allLocalStorePaths(), [path.join('/harness', 'palace')]);
});

test('allLocalStorePaths is empty with no home (nothing to erase)', () => {
  const memory = new MemoryManager(() => null, () => ({ enabled: true, model: 'minilm', provider: 'mempalace' }));
  assert.deepEqual(memory.allLocalStorePaths(), []);
});

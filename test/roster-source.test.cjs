'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { chooseRosterSource } = loadTs('src/renderer/src/store/rosterSource.ts');

const HIVE_A = '/hives/a';
const HIVE_B = '/hives/b';

const file = (counts = {}) => ({
  agents: [], archived: [], restorable: [], ...counts
});
const someone = { id: 'agent-1', name: 'Dwight', cwd: HIVE_A };

// --- the file wins whenever it has a roster --------------------------------

test('a populated roster file is used, whatever localStorage says', () => {
  const src = chooseRosterSource({
    fileRoster: file({ agents: [someone] }),
    currentHome: HIVE_A,
    storedHome: HIVE_B
  });
  assert.deepEqual(src, { useFileRoster: true, useLocalFallback: false });
});

test('a file holding only archived or only restorable entries still counts', () => {
  for (const slice of ['archived', 'restorable']) {
    const src = chooseRosterSource({
      fileRoster: file({ [slice]: [someone] }),
      currentHome: HIVE_A,
      storedHome: HIVE_A
    });
    assert.equal(src.useFileRoster, true, `${slice}-only roster should win`);
  }
});

// --- the localStorage fallback is scoped to one hive -----------------------
// localStorage is partitioned by origin, so all hives share one. Reading it in
// a hive it was not written for is what carried a whole team — restorable
// entries and their `cwd` — from one workspace into the next.

test('localStorage is adopted in the hive it was written for', () => {
  const src = chooseRosterSource({
    fileRoster: null, currentHome: HIVE_A, storedHome: HIVE_A
  });
  assert.deepEqual(src, { useFileRoster: false, useLocalFallback: true });
});

test('localStorage is NOT adopted in a different hive', () => {
  const src = chooseRosterSource({
    fileRoster: null, currentHome: HIVE_B, storedHome: HIVE_A
  });
  assert.deepEqual(src, { useFileRoster: false, useLocalFallback: false },
    'a brand-new hive must open on an empty floor, not on the last one');
});

test('an empty roster file does not license a cross-hive read', () => {
  // The empty-guard says an empty file must not beat localStorage. It must not
  // turn into permission to read ANOTHER hive's localStorage either.
  const src = chooseRosterSource({
    fileRoster: file(), currentHome: HIVE_B, storedHome: HIVE_A
  });
  assert.equal(src.useLocalFallback, false);
});

test('an empty roster file still yields to localStorage in its own hive', () => {
  const src = chooseRosterSource({
    fileRoster: file(), currentHome: HIVE_A, storedHome: HIVE_A
  });
  assert.deepEqual(src, { useFileRoster: false, useLocalFallback: true });
});

// --- upgrading, and the dev ↔ packaged origin split ------------------------

test('an unstamped localStorage is adopted once', () => {
  // Everyone upgrading into this has agents in localStorage and no stamp yet.
  // Refusing that read would blank their floor on the first launch.
  const src = chooseRosterSource({
    fileRoster: null, currentHome: HIVE_A, storedHome: null
  });
  assert.equal(src.useLocalFallback, true);
});

test('an origin with no roster of its own reads nothing and loses nothing', () => {
  // The packaged build on its first launch: its own localStorage is empty and
  // unstamped, so the fallback is allowed — and returns nothing. The roster
  // comes back from the file, which is what the mirror is for.
  const src = chooseRosterSource({
    fileRoster: file({ agents: [someone] }), currentHome: HIVE_A, storedHome: null
  });
  assert.equal(src.useFileRoster, true);
});

test('no hive selected yet falls back rather than dropping the roster', () => {
  const src = chooseRosterSource({
    fileRoster: null, currentHome: null, storedHome: HIVE_A
  });
  assert.equal(src.useLocalFallback, true);
});

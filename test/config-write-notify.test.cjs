'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// config.ts resolves its file through Electron's app.getPath(). Point that one
// dependency at a throwaway userData root so this test never touches the real
// application config.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-config-notify-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { app: { getPath: () => userData } }
};

const { writeConfig, readConfig, onConfigWritten, setAgentTokenCap, resetConfig } = loadTs('src/main/config.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

// A real app has a config on disk and reads it at start-up, which settles the
// one-shot migration. Do the same first, so no test below races it.
writeConfig({});
readConfig();


test('a config write notifies subscribers with the persisted config', () => {
  const seen = [];
  const off = onConfigWritten((next) => seen.push(next));

  writeConfig({ orchestratorMaySpawn: true });

  // What subscribers end up holding is the contract; one save can legitimately
  // write more than once, so the number of notifications is not.
  assert.ok(seen.length >= 1);
  assert.deepEqual(seen[seen.length - 1], readConfig());
  assert.equal(seen[seen.length - 1].orchestratorMaySpawn, true);
  off();
});

// Token caps and the reset below each save by their own route. These two keep
// the announcement where every route passes through it.
test('a token-cap write notifies too, not just writeConfig', () => {
  const seen = [];
  const off = onConfigWritten((next) => seen.push(next));

  setAgentTokenCap('jim', 100);

  assert.ok(seen.length >= 1);
  assert.deepEqual(seen[seen.length - 1], readConfig());
  assert.equal(seen[seen.length - 1].agentTokenCaps.jim, 100);
  off();
});

test('resetting the config notifies as well', () => {
  const seen = [];
  const off = onConfigWritten((next) => seen.push(next));

  resetConfig();

  // A reset hands its caller a slightly fuller view than it stores, so check the
  // reset reached subscribers rather than comparing the two.
  assert.ok(seen.length >= 1);
  assert.equal(seen[seen.length - 1].onboardingComplete, false);
  off();
});

test('unsubscribing stops the notifications', () => {
  const seen = [];
  const off = onConfigWritten((next) => seen.push(next));
  writeConfig({ notifications: true });
  const countWhileSubscribed = seen.length;
  assert.ok(countWhileSubscribed >= 1);

  off();
  writeConfig({ notifications: false });

  assert.equal(seen.length, countWhileSubscribed);
});

test('a listener that throws neither fails the write nor starves the next listener', () => {
  const reached = [];
  const offBad = onConfigWritten(() => { throw new Error('window is gone'); });
  const offGood = onConfigWritten((next) => reached.push(next));

  // The write itself must still return normally and still land on disk.
  const returned = writeConfig({ autoMode: true });

  assert.equal(returned.autoMode, true);
  assert.equal(readConfig().autoMode, true);
  assert.ok(reached.length >= 1);
  offBad(); offGood();
});

// The window fills one copy of the config from both a read and this
// announcement, so a screen must never get a fuller answer from one than the
// other. Saving part of a setting is where that would show.
test('subscribers receive the same shape a config read returns', () => {
  const seen = [];
  const off = onConfigWritten((next) => seen.push(next));

  writeConfig({ contextTrigger: { compact: { enabled: true } } });

  assert.deepEqual(seen[seen.length - 1], readConfig());
  off();
});

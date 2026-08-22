'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { RosterStore, rosterPath, rosterBackupDir } = loadTs('src/main/roster.ts');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-roster-'));
}

/** A store bound to `home`. A fresh instance is a fresh RUN — which is what the
 *  empty-guard keys off, so "another instance" is how a restart is simulated. */
function storeAt(home) {
  return new RosterStore(() => home);
}

function backupsIn(home) {
  const dir = rosterBackupDir(home);
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

function snapshot(agents = [], extra = {}) {
  return {
    version: 1,
    savedAt: new Date(0).toISOString(),
    agents,
    archived: [],
    restorable: [],
    queues: {},
    selectedId: null,
    ...extra
  };
}

test('a roster round-trips through the file', () => {
  const home = tmpHome();
  const store = storeAt(home);
  assert.equal(store.read(), null); // nothing written yet

  assert.equal(store.write(snapshot([{ id: 'a', name: 'Dwight', note: 'beets' }])).ok, true);

  const back = store.read();
  assert.equal(back.agents.length, 1);
  assert.equal(back.agents[0].note, 'beets');
  assert.equal(back.version, 1);
});

test('an empty first write cannot wipe a roster that is already on disk', () => {
  // The failure this exists for: opening the packaged build for the first time.
  // Its localStorage is a different origin, so the store boots with zero agents
  // and its first mirror write would otherwise flatten the real roster.
  const home = tmpHome();
  storeAt(home).write(snapshot([{ id: 'a', name: 'Dwight' }]));

  const nextRun = storeAt(home);
  const res = nextRun.write(snapshot([]));
  assert.equal(res.ok, false);
  assert.equal(res.skipped, 'empty-first-write');
  assert.equal(nextRun.read().agents.length, 1, 'the roster on disk survived');
});

test('emptying the roster is allowed once the run has written normally', () => {
  // Deleting every agent is a real thing a user does. Only the FIRST write of a
  // run is suspect; refusing later ones would make deletion impossible.
  const home = tmpHome();
  const store = storeAt(home);
  store.write(snapshot([{ id: 'a', name: 'Dwight' }]));
  assert.equal(store.write(snapshot([])).ok, true);
  assert.equal(store.read().agents.length, 0);
});

test('every previous version is kept, even within the same millisecond', () => {
  // Three writes back-to-back land in one tick, so a timestamp-only filename
  // collides and the later copy silently replaces the earlier one. A backup
  // folder that loses backups is worse than no backup folder.
  const home = tmpHome();
  const store = storeAt(home);
  store.write(snapshot([{ id: 'a' }]));
  store.write(snapshot([{ id: 'a' }, { id: 'b' }]));
  store.write(snapshot([{ id: 'a' }, { id: 'b' }, { id: 'c' }]));

  // Three writes, two of which had a previous file to copy first.
  assert.equal(backupsIn(home).length, 2);
  const sizes = backupsIn(home).map((f) =>
    JSON.parse(fs.readFileSync(path.join(rosterBackupDir(home), f), 'utf8')).agents.length);
  assert.deepEqual(sizes.sort(), [1, 2], 'both prior versions survived, not just the last');
});

test('a refused write still backs up whatever was on disk', () => {
  const home = tmpHome();
  storeAt(home).write(snapshot([{ id: 'a' }]));
  storeAt(home).write(snapshot([])); // declined
  assert.ok(backupsIn(home).some((f) => f.includes('declined')));
});

test('a refusal does not disarm the guard: repeated empty writes stay refused', () => {
  // Seen live 2026-08-16: the first empty write of a run was declined, but the
  // decline set the has-written flag — so when a renderer reload re-sent the
  // same empty snapshot, the second write went through and flattened the file.
  // The guard must hold until a NON-empty write proves the renderer has a roster.
  const home = tmpHome();
  storeAt(home).write(snapshot([{ id: 'a', name: 'Dwight' }]));

  const nextRun = storeAt(home);
  assert.equal(nextRun.write(snapshot([])).skipped, 'empty-first-write');
  const second = nextRun.write(snapshot([]));
  assert.equal(second.ok, false);
  assert.equal(second.skipped, 'empty-first-write');
  assert.equal(nextRun.read().agents.length, 1, 'the roster on disk survived both');

  // A non-empty write disarms it; a later empty write is then a real deletion.
  assert.equal(nextRun.write(snapshot([{ id: 'a', name: 'Dwight' }])).ok, true);
  assert.equal(nextRun.write(snapshot([])).ok, true);
  assert.equal(nextRun.read().agents.length, 0);
});

test('a corrupt file reads as "no opinion" rather than as an empty roster', () => {
  // The renderer treats null as "use localStorage". Returning an empty roster
  // instead would show a blank floor and then mirror that blank back to disk.
  const home = tmpHome();
  fs.writeFileSync(rosterPath(home), '{ this is not json');
  assert.equal(storeAt(home).read(), null);
});

test('a snapshot missing its arrays is rejected, not half-written', () => {
  const home = tmpHome();
  const store = storeAt(home);
  store.write(snapshot([{ id: 'a' }]));
  assert.equal(store.write({ version: 1, agents: 'nope' }).ok, false);
  assert.equal(store.read().agents.length, 1);
  assert.equal(fs.existsSync(`${rosterPath(home)}.tmp`), false, 'no temp file left behind');
});

test('no harnessHome means no file operations at all', () => {
  const store = new RosterStore(() => null);
  assert.equal(store.read(), null);
  assert.equal(store.write(snapshot([{ id: 'a' }])).ok, false);
  store.archive(); // must not throw
});

test('reset archives the roster instead of destroying it', () => {
  const home = tmpHome();
  const store = storeAt(home);
  store.write(snapshot([{ id: 'a', note: 'do not lose me' }]));

  store.archive();
  assert.equal(fs.existsSync(rosterPath(home)), false, 'active roster cleared');
  assert.equal(store.read(), null);

  const saved = backupsIn(home).filter((f) => f.includes('reset'));
  assert.equal(saved.length, 1);
  const body = JSON.parse(fs.readFileSync(path.join(rosterBackupDir(home), saved[0]), 'utf8'));
  assert.equal(body.agents[0].note, 'do not lose me');
});

test('worktree paths and notes survive the round trip verbatim', () => {
  // These two only ever lived in localStorage, so they are the whole reason the
  // file exists.
  const home = tmpHome();
  const agent = {
    id: 'w1',
    name: 'Jim',
    cwd: '/Users/x/HarnessAgents/worktrees/w1',
    worktreePath: '/Users/x/HarnessAgents/worktrees/w1',
    note: '- shipping the queue fix\n- then the roster'
  };
  const store = storeAt(home);
  store.write(snapshot([agent]));
  assert.deepEqual(store.read().agents[0], agent);
});

test('queues and selection round-trip, and a bad queues field degrades to empty', () => {
  const home = tmpHome();
  const store = storeAt(home);
  store.write(snapshot([{ id: 'a' }], {
    queues: { a: [{ id: 'q1', text: 'ship it' }] },
    selectedId: 'a'
  }));
  const back = store.read();
  assert.equal(back.queues.a[0].text, 'ship it');
  assert.equal(back.selectedId, 'a');

  store.write(snapshot([{ id: 'a' }], { queues: null, selectedId: 42 }));
  const coerced = store.read();
  assert.deepEqual(coerced.queues, {});
  assert.equal(coerced.selectedId, null);
});

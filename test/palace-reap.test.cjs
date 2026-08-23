'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { quarantineDirsToReap, quarantineStampMs } =
  loadTs('src/main/palaceReap.ts');

const at = (y, mo, d, h, mi, s) => new Date(y, mo - 1, d, h, mi, s).getTime();
const NOW = at(2026, 8, 22, 12, 0, 0);
const names = (...n) => n.map((name) => ({ name }));

// Real names from the affected palace. Note the second one: MemPalace inherits
// whatever Chroma named the segment, and Finder-style " 2" duplicates DO occur,
// so the pattern has to survive a space and a digit before the suffix.
const DRIFT = '47258cb2-e535-4990-9dc7-829966c6ff07.drift-20260809-000813';
const DRIFT_DUP = '47258cb2-e535-4990-9dc7-829966c6ff07 2.drift-20260812-191936';
const CORRUPT = '83f1acc5-5589-4c47-b457-996f22add88e.corrupt-20260810-005310';
const LIVE = '83f1acc5-5589-4c47-b457-996f22add88e';

// --- what counts as a quarantine --------------------------------------------
// The whole risk of this feature is deleting something that is not ours. The
// live segments are bare UUIDs; only MemPalace's exact strftime suffix counts.

test('the live collection directory is never a candidate', () => {
  assert.equal(quarantineStampMs(LIVE), null);
  assert.deepEqual(quarantineDirsToReap(names(LIVE), NOW, { keep: 0, minAgeMs: 0 }), []);
});

test('chroma.sqlite3 and other palace files are never candidates', () => {
  assert.deepEqual(
    quarantineDirsToReap(names('chroma.sqlite3', 'roster.json'), NOW, { keep: 0, minAgeMs: 0 }),
    []
  );
});

test('both quarantine kinds are recognised, including a duplicated segment name', () => {
  assert.equal(quarantineStampMs(DRIFT), at(2026, 8, 9, 0, 8, 13));
  assert.equal(quarantineStampMs(DRIFT_DUP), at(2026, 8, 12, 19, 19, 36));
  assert.equal(quarantineStampMs(CORRUPT), at(2026, 8, 10, 0, 53, 10));
});

test('a near-miss suffix is left alone', () => {
  // No timestamp, wrong digit counts, or the marker sitting mid-name rather
  // than at the end: all of these must read as "not mine".
  for (const n of [
    'seg.drift',
    'seg.drift-2026-08-09',
    'seg.drift-20260809-00081',
    'seg.corrupt-20260809-000813.bak',
    'seg.drifted-20260809-000813'
  ]) {
    assert.equal(quarantineStampMs(n), null, n);
  }
});

// --- what actually gets deleted ---------------------------------------------

test('the newest few are kept so there is still something to diagnose with', () => {
  const all = names(
    'a.drift-20260822-010000',
    'a.drift-20260822-020000',
    'a.drift-20260822-030000',
    'a.drift-20260822-040000'
  );
  const doomed = quarantineDirsToReap(all, NOW, { keep: 2, minAgeMs: 0 });
  assert.deepEqual(doomed, ['a.drift-20260822-020000', 'a.drift-20260822-010000']);
});

test('a fresh quarantine is never touched, even past the keep count', () => {
  // 04:00 and 03:00 are kept by count; 02:00 is only 10 minutes old at this
  // "now" and could still be mid-recovery, so it survives too.
  const now = at(2026, 8, 22, 2, 5, 0);
  const all = names(
    'a.drift-20260822-020000',
    'a.drift-20260822-010000',
    'a.drift-20260821-010000'
  );
  const doomed = quarantineDirsToReap(all, now, { keep: 0, minAgeMs: 10 * 60_000 });
  assert.deepEqual(doomed, ['a.drift-20260822-010000', 'a.drift-20260821-010000'],
    'the 02:00 one is 5 minutes old and stays');
});

test('nothing to do on a healthy palace', () => {
  assert.deepEqual(quarantineDirsToReap(names(LIVE, 'chroma.sqlite3'), NOW), []);
});

test('drift and corrupt are ranked together, not kept separately', () => {
  // `keep` is a budget for the palace, not per kind — otherwise a palace
  // producing both kinds keeps twice as much as asked.
  const all = names(
    'a.drift-20260822-030000',
    'b.corrupt-20260822-020000',
    'a.drift-20260822-010000'
  );
  assert.deepEqual(
    quarantineDirsToReap(all, NOW, { keep: 1, minAgeMs: 0 }),
    ['b.corrupt-20260822-020000', 'a.drift-20260822-010000']
  );
});

test('the real palace state reaps the backlog and keeps the newest two', () => {
  // 357 drift + 4 corrupt + the live segment + the sqlite file, which is what
  // this machine actually looked like when the bug was reported.
  const entries = [{ name: LIVE }, { name: 'chroma.sqlite3' }];
  for (let i = 0; i < 357; i += 1) {
    entries.push({ name: `a.drift-20260820-${String(i).padStart(6, '0')}` });
  }
  entries.push({ name: CORRUPT });
  const doomed = quarantineDirsToReap(entries, NOW, { keep: 2, minAgeMs: 0 });
  assert.equal(doomed.length, 356);
  assert.ok(!doomed.includes(LIVE));
  assert.ok(!doomed.includes('chroma.sqlite3'));
});

test('ties inside the same second are ordered deterministically', () => {
  const all = names('b.drift-20260822-010000', 'a.drift-20260822-010000');
  assert.deepEqual(
    quarantineDirsToReap(all, NOW, { keep: 1, minAgeMs: 0 }),
    ['a.drift-20260822-010000']
  );
});

// --- backing off while the palace is quarantining ---------------------------
// Mining into a palace that just quarantined only produces another copy: the
// segment it rebuilds is the one the next open quarantines again.

const { nextMineDelayMs } = loadTs('src/main/palaceReap.ts');
const BASE = 600_000;
const MAX = 1_800_000;

test('a clean pass mines at the base interval', () => {
  assert.equal(nextMineDelayMs(BASE, BASE, MAX, false), BASE);
});

test('each pass that quarantines doubles the wait', () => {
  const first = nextMineDelayMs(BASE, BASE, MAX, true);
  assert.equal(first, 1_200_000);
  assert.equal(nextMineDelayMs(first, BASE, MAX, true), MAX);
});

test('the backoff is capped, so recall never goes badly stale', () => {
  assert.equal(nextMineDelayMs(MAX, BASE, MAX, true), MAX);
  assert.equal(nextMineDelayMs(MAX * 4, BASE, MAX, true), MAX);
});

test('one clean pass snaps straight back — no slow climb down', () => {
  assert.equal(nextMineDelayMs(MAX, BASE, MAX, false), BASE,
    'the palace stopped quarantining, so there is nothing left to back off from');
});

test('a delay below base is never used to shrink the interval', () => {
  assert.equal(nextMineDelayMs(1_000, BASE, MAX, true), 1_200_000);
});

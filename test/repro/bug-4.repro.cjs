'use strict';

/**
 * BUG 4 repro — registry.json (the hive's identity file) is written NON-atomically
 * by three of its six writers, so a crash/power-loss mid-write tears the file and
 * the next boot silently loses the whole floor's identity record.
 *
 * The six writers (src/main/hive.ts at HEAD c7c8921f):
 *   ATOMIC (tmp + renameSync, atomicWriteJson at 2657-2661):
 *     - ensureAgent      (756)
 *     - setArchived      (1010)
 *     - recordSession    (1118)
 *   NON-ATOMIC (bare in-place writeFileSync, writeJson at 2654-2656):
 *     - patchAgentRole   (985)
 *     - setAgentHold     (1042)
 *     - renameAgent      (1076)
 *
 * Commit 8cf185fc (2026-08-19, "fix(hive): atomically write registry.json and
 * drain cursor.json") converted the first three, describing exactly this torn
 * write: "bare writeFileSync ... truncates before writing and can leave a
 * torn/corrupt file if the process dies mid-write — losing agent registration".
 * patchAgentRole / setAgentHold / renameAgent were missed.
 *
 * The failure scenario: the user renames an agent or toggles hold from the UI;
 * the process crashes mid-writeFileSync while registry.json is truncated.
 * registry() (1764-1768) maps ANY unreadable registry.json to
 * { godId: null, agents: {} } — so the floor comes back with no god id, no
 * roster, no recorded --resume sessionIds, no hold flags. ensureHive only
 * writes registry.json when it is ABSENT (597-599), so a torn file is never
 * repaired; nothing else restores it. isGod() is false, a message to 'human'
 * resolves to the literal id 'god' which has no inbox and is dropped
 * (routeMessage 1563-1640), and broadcast fan-out iterates an empty roster.
 *
 * How this repro works, deterministically (no Electron, no PTYs, no network):
 * hive.ts compiles to `(0, node_fs_1.writeFileSync)(...)` — a property lookup on
 * the shared `node:fs` module object at every call site — so the repro swaps
 * `fs.writeFileSync` at that boundary to
 *   (a) OBSERVE whether each mutator writes registry.json directly (bug) or
 *       through a `registry.json.tmp-*` file (atomic), and
 *   (b) SIMULATE a process death mid-write: writeFileSync has already opened the
 *       destination with O_TRUNC, so the crash leaves a torn fragment of the
 *       intended content behind and the write never completes.
 * On the atomic writers the same crash only ever casualties a disposable
 * `registry.json.tmp-*` file and the live registry survives untouched — that is
 * the property the fix must give all six writers, demonstrated here by control.
 *
 * FAILS on current main (three mutators write in place + full identity amnesia).
 * PASSES once patchAgentRole / setAgentHold / renameAgent route through
 * atomicWriteJson like their siblings.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

// ── fixtures ────────────────────────────────────────────────────────────────

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-bug4-registry-'));
}

/** A live three-agent floor: god + two workers, one with a recorded Claude
 *  session id (the durable --resume key). Everything the registry exists to
 *  remember. */
async function floor(home) {
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: home });
  hive.recordSession('jim-1', 'sess-jim-resume-key');
  return hive;
}

/** Registry write-shape watcher: runs `fn` with fs.writeFileSync wrapped and
 *  classifies every registry.json write as 'direct' (in-place — the bug) or
 *  'tmp' (atomic tmp+rename — the fix). Other files are ignored. Sync or async. */
function watchRegistryWrites(fn) {
  const original = fs.writeFileSync;
  const writes = [];
  fs.writeFileSync = function patched(p, data, opts) {
    const base = path.basename(String(p));
    if (base === 'registry.json') writes.push('direct');
    else if (base.startsWith('registry.json.tmp-')) writes.push('tmp');
    return original.call(fs, p, data, opts);
  };
  const restore = () => { fs.writeFileSync = original; };
  let out;
  try {
    out = fn();
  } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.then(restore, (e) => { restore(); throw e; }).then(() => writes);
  restore();
  return writes;
}

/** Power-loss simulator: any writeFileSync whose target is registry.json (or
 *  its tmp predecessor) truncates the destination to a fragment — exactly what
 *  the open(O_TRUNC) has already done before the bytes land — then throws as
 *  the process dies. Returns the basenames of the files it killed. */
function crashMidRegistryWrite(fn) {
  const original = fs.writeFileSync;
  const casualties = [];
  fs.writeFileSync = function patched(p, data, opts) {
    const target = String(p);
    if (path.basename(target).startsWith('registry.json')) {
      const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      // The torn file: O_TRUNC already zeroed it; only a fragment was flushed.
      original(target, text.slice(0, Math.max(Math.floor(text.length / 4), 1)), 'utf8');
      casualties.push(path.basename(target));
      fs.writeFileSync = original; // the process is dead; stop intercepting
      throw new Error('simulated power loss during writeFileSync');
    }
    return original.call(fs, p, data, opts);
  };
  const restore = () => { fs.writeFileSync = original; };
  let out;
  try {
    out = fn();
  } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.then(restore, (e) => { restore(); throw e; }).then(() => casualties);
  restore();
  return casualties;
}

/** The `delivered` array of the most recent routed message from log.jsonl —
 *  what routeMessage actually reached, not what was intended. */
function lastDelivered(home) {
  const lines = fs.readFileSync(path.join(home, 'hive', 'log.jsonl'), 'utf8').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const event = JSON.parse(lines[i]);
    if (event.kind === 'message') return event.delivered;
  }
  return null;
}

/** Everything a healthy floor must still answer after the crash window. */
function assertFloorSurvived(hive, label) {
  const reg = hive.registry();
  assert.equal(reg.godId, 'god-1', `${label}: godId must survive a mid-write crash (registry() silently returns godId:null on a torn file)`);
  assert.deepEqual(Object.keys(reg.agents).sort(), ['god-1', 'jim-1', 'pam-1'],
    `${label}: the roster must survive a mid-write crash`);
  assert.equal(hive.lastSession('jim-1'), 'sess-jim-resume-key',
    `${label}: the recorded --resume session id must survive a mid-write crash`);
  assert.equal(hive.isGod('god-1'), true, `${label}: isGod() must still be true`);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(hive.root(), 'registry.json'), 'utf8')),
    `${label}: registry.json on disk must still be parseable`);
}

// ── 1. the mechanism: three writers bypass tmp+rename ───────────────────────

test('patchAgentRole, setAgentHold and renameAgent write registry.json in place (no tmp+rename)', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = await floor(home);

  // Control: the writers the project already made atomic NEVER touch
  // registry.json directly — only a disposable tmp file, renamed over it.
  assert.deepEqual(await watchRegistryWrites(() => hive.ensureAgent({ id: 'dwight-1', name: 'Dwight', provider: 'claude', cwd: home })),
    ['tmp'], 'ensureAgent (the reference atomic writer) must go through tmp+rename');
  assert.deepEqual(watchRegistryWrites(() => hive.setArchived('dwight-1', true)),
    ['tmp'], 'setArchived (the reference atomic writer) must go through tmp+rename');
  assert.deepEqual(watchRegistryWrites(() => hive.recordSession('pam-1', 'sess-pam-1')),
    ['tmp'], 'recordSession (the reference atomic writer) must go through tmp+rename');

  // The three mutators under test.
  assert.deepEqual(watchRegistryWrites(() => hive.patchAgentRole('jim-1', 'Senior claims adjuster')),
    ['tmp'], 'patchAgentRole writes registry.json IN PLACE (bare writeFileSync) — a crash mid-write tears the identity file');
  assert.deepEqual(watchRegistryWrites(() => hive.setAgentHold('jim-1', true)),
    ['tmp'], 'setAgentHold writes registry.json IN PLACE (bare writeFileSync) — a crash mid-write tears the identity file');
  assert.deepEqual(watchRegistryWrites(() => hive.renameAgent('jim-1', 'Jim Halpert')),
    ['tmp'], 'renameAgent writes registry.json IN PLACE (bare writeFileSync) — a crash mid-write tears the identity file');
});

// ── 2. the consequence, renameAgent: one torn write erases the floor ────────

test('a crash mid-rename tears registry.json and the next boot finds an empty hive that is never repaired', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = await floor(home);

  // Baseline: the floor is alive and mail to the human reaches god.
  hive.send({ to: 'human', subject: 'status', body: 'hello' }, 'jim-1');
  assert.deepEqual(lastDelivered(home), ['god-1'], 'baseline: mail to "human" resolves to god and is delivered');

  // The user renames Jim from the UI; the process dies mid-writeFileSync.
  const casualties = await crashMidRegistryWrite(() => hive.renameAgent('jim-1', 'Jim Halpert'));
  assert.equal(casualties.length, 1, 'the simulated crash must fire during the rename write');
  assert.match(casualties[0], /^registry\.json\.tmp-/,
    'the crash casualty must be a disposable registry.json.tmp-* file — registry.json itself must never be opened in place (on current main it IS the casualty)');

  assertFloorSurvived(hive, 'after the crash');

  // Next boot: a fresh HiveManager over the same home. ensureHive only writes
  // registry.json when ABSENT, so it cannot paper over the tear — and nothing
  // else in the codebase repairs it either.
  const rebooted = new HiveManager(() => home);
  rebooted.ensureHive();
  assertFloorSurvived(rebooted, 'after reboot');

  // The floor is now a ghost town that reports itself healthy: mail to the
  // human resolves to the literal id 'god' (godId is null), which has no
  // inbox — the message is dropped with no bounce.
  hive.send({ to: 'human', subject: 'need a decision', body: 'blocked' }, 'pam-1');
  assert.deepEqual(lastDelivered(home), ['god-1'],
    'after the crash, mail to "human" must still reach the living god, not vanish into a nonexistent agents/god inbox');

  // Broadcast fan-out iterates the registry roster — which is now {}.
  hive.send({ to: 'broadcast', subject: 'standup', body: 'roll call' }, 'pam-1');
  assert.deepEqual([...lastDelivered(home)].sort(), ['god-1', 'jim-1'].sort(),
    'after the crash, a broadcast must still fan out to the living agents');
});

// ── 3. the consequence, setAgentHold: same amnesia ──────────────────────────

test('a crash mid-hold-toggle tears registry.json: hold flag, session id and god id are all lost', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = await floor(home);

  const casualties = await crashMidRegistryWrite(() => hive.setAgentHold('jim-1', true));
  assert.equal(casualties.length, 1, 'the simulated crash must fire during the hold write');
  assert.match(casualties[0], /^registry\.json\.tmp-/,
    'the crash casualty must be a disposable registry.json.tmp-* file — registry.json itself must never be opened in place (on current main it IS the casualty)');

  assertFloorSurvived(hive, 'after the crash');
  assert.ok(hive.registry().agents['jim-1'], 'jim-1 must still exist on the floor');
  // NOTE: the in-flight hold toggle itself is lost to the crash (the write that
  // was killed was carrying it) — that is the same best-effort semantics the
  // atomic control below documents for recordSession. What must never happen is
  // the CURRENT behavior, where the crash erases the whole registry (godId,
  // roster, every session id) instead of just the in-flight flag.
});

// ── 4. the consequence, patchAgentRole: same amnesia ────────────────────────

test('a crash mid-role-patch tears registry.json: role, session id and god id are all lost', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = await floor(home);

  const casualties = await crashMidRegistryWrite(() => hive.patchAgentRole('jim-1', 'Senior claims adjuster'));
  assert.equal(casualties.length, 1, 'the simulated crash must fire during the role write');
  assert.match(casualties[0], /^registry\.json\.tmp-/,
    'the crash casualty must be a disposable registry.json.tmp-* file — registry.json itself must never be opened in place (on current main it IS the casualty)');

  assertFloorSurvived(hive, 'after the crash');
  assert.ok(hive.registry().agents['jim-1'], 'jim-1 must still exist on the floor');
  // NOTE: the in-flight role patch itself is lost to the crash (the write that
  // was killed was carrying it) — the same best-effort semantics as the control.
  // What must never happen is the CURRENT behavior, where the crash erases the
  // whole registry instead of just the in-flight edit.
});

// ── 5. control: an atomic writer under the identical crash ──────────────────

test('CONTROL — the same crash during an atomic registry writer only kills the tmp file; the floor survives', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = await floor(home);

  const casualties = await crashMidRegistryWrite(() => hive.recordSession('pam-1', 'sess-pam-2'));
  assert.equal(casualties.length, 1, 'the simulated crash must fire during the recordSession write');
  assert.match(casualties[0], /^registry\.json\.tmp-/,
    'on an atomic writer the crash casualty is the disposable tmp file, never registry.json');

  assertFloorSurvived(hive, 'after the crash');
  assert.equal(hive.lastSession('pam-1'), undefined,
    'the in-flight session write is lost (acceptable — it is best-effort), but nothing else is');
});

'use strict';

/**
 * Two live windows must not clobber <harnessHome>/roster.json.
 *
 * Every renderer window (the primary plus each floor, which get isolated
 * `persist:floor-N` partitions) runs src/renderer/src/store/store.ts. That
 * module reads roster.json exactly once, at module load, into a per-window
 * mirror, and flushes the ENTIRE snapshot {agents, archived, restorable,
 * queues, selectedId} via `roster:write` 500ms after any persist* call and
 * again on beforeunload. Main's single RosterStore replaces the file wholesale
 * and refuses only an empty-first write — a stale but NON-empty snapshot went
 * straight through, deleting whatever the other window had created since this
 * one booted.
 *
 * The fix is a merge-before-write in `flushRosterNow`: before each flush the
 * file's current contents are read and merged under the window's own copies,
 * adopting only ids the window has NEVER held (tracked in `rosterSeen`). An id
 * the window knows but no longer carries is its own deliberate deletion and is
 * NOT re-adopted — otherwise deleting an agent would be impossible.
 *
 * These tests boot the REAL store.ts twice against ONE real RosterStore
 * (exactly how main wires every window's IPC to one `roster`), faking only the
 * DOM boundary (window / localStorage / cth bridge). Each evaluation is one
 * Electron renderer: its own module registry, its own mirror, its own 500ms
 * debounce.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const REPO = path.resolve(__dirname, '..');
const loadTs = require('./load-ts.cjs');

const { RosterStore, rosterPath } = loadTs('src/main/roster.ts');
const { chooseRosterSource } = loadTs('src/renderer/src/store/rosterSource.ts');

const STORE_TS = path.join(REPO, 'src', 'renderer', 'src', 'store', 'store.ts');
/** The store's own debounce is 500ms (store.ts); wait past it. */
const FLUSH_WAIT_MS = 800;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function agent(id, name, extra = {}) {
  return {
    id,
    name,
    character: 'dwight',
    accent: 'blue',
    description: `${name}'s job`,
    project: '/hive',
    tmuxTarget: `tmux-${id}`,
    cwd: '/hive',
    status: 'idle',
    action: '',
    progress: 0,
    ...extra
  };
}

function snapshot(agents, extra = {}) {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    agents,
    archived: [],
    restorable: [],
    queues: {},
    selectedId: null,
    ...extra
  };
}

function tmpHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-roster-mw-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function readRoster(home) {
  return JSON.parse(fs.readFileSync(rosterPath(home), 'utf8'));
}

/**
 * Boot one renderer window: evaluate the real store.ts against a fake `window`.
 * A fresh module evaluation per window is what Electron gives you — each
 * renderer has its own module registry, its own mirror, its own debounce.
 */
function bootRenderer(home, rosterStore) {
  const writes = [];   // every roster:write result this window observed
  const ls = new Map(); // this window's localStorage (own partition)
  const unload = [];   // beforeunload listeners (the close-flush path)
  const win = {
    localStorage: {
      getItem: (k) => (ls.has(k) ? ls.get(k) : null),
      setItem: (k, v) => { ls.set(String(k), String(v)); },
      removeItem: (k) => { ls.delete(String(k)); }
    },
    addEventListener: (type, fn) => { if (type === 'beforeunload') unload.push(fn); },
    cth: {
      // preload/index.ts — both windows talk to the SAME RosterStore instance,
      // exactly as index.ts wires every window's IPC to one `roster`.
      harnessHomeSync: () => home,
      rosterReadSync: () => rosterStore.read(),
      rosterWrite: (snap) =>
        Promise.resolve(rosterStore.write(snap)).then((res) => { writes.push(res); return res; })
    }
  };

  function resolveTs(fromDir, request) {
    const base = request.startsWith('@shared/')
      ? path.resolve(REPO, 'src', 'shared', request.slice('@shared/'.length))
      : path.resolve(fromDir, request);
    for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
  }

  const cache = new Map();
  function loadFile(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const source = fs.readFileSync(filename, 'utf8');
    const output = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        strict: true,
        esModuleInterop: true
      },
      fileName: filename,
      reportDiagnostics: true
    });
    if (output.diagnostics?.length) {
      throw new Error(ts.formatDiagnosticsWithColorAndContext(output.diagnostics, {
        getCurrentDirectory: () => REPO,
        getCanonicalFileName: (n) => n,
        getNewLine: () => '\n'
      }));
    }
    const mod = { exports: {} };
    cache.set(filename, mod);
    const localRequire = (request) => {
      if (request.startsWith('.') || request.startsWith('@shared/')) {
        const resolved = resolveTs(path.dirname(filename), request);
        if (resolved) return loadFile(resolved);
      }
      return require(request);
    };
    // `window` is a parameter so this evaluation sees its own renderer surface.
    const run = new Function('module', 'exports', 'require', '__filename', '__dirname', 'window', output.outputText);
    run(mod, mod.exports, localRequire, filename, path.dirname(filename), win);
    return mod.exports;
  }

  const storeExports = loadFile(STORE_TS);
  return { useStore: storeExports.useStore, writes, ls, unload };
}

// ── the regression ───────────────────────────────────────────────────────────

test('a floor flushing its stale snapshot cannot delete an agent the primary hired', async (t) => {
  const home = tmpHome(t);
  const roster = new RosterStore(() => home);

  // T(-1): roster.json as the previous run left it — Dwight only.
  fs.writeFileSync(
    rosterPath(home),
    JSON.stringify(snapshot([agent('dwight', 'Dwight')], { selectedId: 'dwight' }), null, 2),
    'utf8'
  );

  // T0 — primary A and floor B boot, each priming its mirror from the file at
  // ITS OWN boot.
  const A = bootRenderer(home, roster);
  const B = bootRenderer(home, roster);
  const a0 = A.useStore.getState();
  const b0 = B.useStore.getState();
  assert.equal(a0.agents.length, 1);
  assert.equal(a0.agents[0].id, 'dwight');
  assert.equal(b0.agents.length, 1);

  // T1 — the user hires Pam in the PRIMARY; its flush lands in main.
  A.useStore.getState().addAgent(agent('agent-x', 'Pam'));
  await sleep(FLUSH_WAIT_MS);
  assert.equal(A.writes.length, 1);
  assert.equal(A.writes[0].ok, true, "primary's flush reached main");
  assert.ok(
    readRoster(home).agents.some((a) => a.id === 'agent-x'),
    'roster.json holds the hire after the primary flushes'
  );

  // T2 — the user edits a note in the FLOOR window. B's mirror is still the T0
  // snapshot; its flush writes the WHOLE snapshot. This used to delete Pam.
  B.useStore.getState().setAgentNote('dwight', 'beets');
  await sleep(FLUSH_WAIT_MS);
  assert.equal(B.writes.length, 1, "floor's flush was invoked (the write reached main)");

  const afterNote = readRoster(home);
  const ids = afterNote.agents.map((a) => a.id);
  assert.ok(
    ids.includes('agent-x'),
    `agent-x must survive the floor's stale full-snapshot flush (file agents: [${ids.join(', ')}])`
  );
  assert.ok(ids.includes('dwight'), 'the floor edit keeps its own agent too');

  // And the note edit itself is durable — the merge must not swallow B's write.
  const dwight = afterNote.agents.find((a) => a.id === 'dwight');
  assert.equal(dwight.note, 'beets', 'the note the floor wrote is on disk');
});

test('closing a floor flushes its stale snapshot without deleting the other window\'s hires', async (t) => {
  const home = tmpHome(t);
  const roster = new RosterStore(() => home);
  fs.writeFileSync(rosterPath(home), JSON.stringify(snapshot([agent('dwight', 'Dwight')])), 'utf8');

  const A = bootRenderer(home, roster);
  const B = bootRenderer(home, roster);
  A.useStore.getState().addAgent(agent('agent-x', 'Pam'));
  await sleep(FLUSH_WAIT_MS);
  assert.ok(readRoster(home).agents.some((a) => a.id === 'agent-x'));

  // Closing the floor fires beforeunload → flushRosterNow. Same clobber path
  // as the debounced flush, so it must be covered by the same merge.
  assert.equal(typeof B.unload[0], 'function', 'store registers a beforeunload flush');
  B.unload[0]();
  await sleep(FLUSH_WAIT_MS);

  const afterClose = readRoster(home);
  assert.ok(
    afterClose.agents.some((a) => a.id === 'agent-x'),
    `agent-x must survive the floor's close flush (file agents: [${afterClose.agents.map((a) => a.id).join(', ')}])`
  );
});

test('a window that deletes an agent must not have it resurrected by its own flush', async (t) => {
  // The other half of the fix: the merge adopts only ids the window has NEVER
  // held. An id it held at boot and then removed is ITS deletion — re-adopting
  // it from disk would make deleting an agent impossible.
  const home = tmpHome(t);
  const roster = new RosterStore(() => home);
  fs.writeFileSync(rosterPath(home), JSON.stringify(snapshot([agent('dwight', 'Dwight')])), 'utf8');

  const A = bootRenderer(home, roster);
  const B = bootRenderer(home, roster);
  // A hires Pam (so the file has something B has never seen), then B removes
  // Dwight and flushes.
  A.useStore.getState().addAgent(agent('agent-x', 'Pam'));
  await sleep(FLUSH_WAIT_MS);

  B.useStore.getState().removeAgent('dwight');
  await sleep(FLUSH_WAIT_MS);
  assert.equal(B.writes.length, 1);

  const after = readRoster(home);
  const ids = after.agents.map((a) => a.id);
  assert.ok(!ids.includes('dwight'), `the removal must stick (file agents: [${ids.join(', ')}])`);
  assert.ok(ids.includes('agent-x'), 'the other window\'s hire still survives');
});

test('a floor\'s flush adopts the other window\'s queued messages', async (t) => {
  const home = tmpHome(t);
  const roster = new RosterStore(() => home);
  fs.writeFileSync(rosterPath(home), JSON.stringify(snapshot([agent('dwight', 'Dwight')])), 'utf8');

  const A = bootRenderer(home, roster);
  const B = bootRenderer(home, roster);

  // A hires Pam and parks a message for her, then flushes.
  A.useStore.getState().addAgent(agent('pam', 'Pam'));
  A.useStore.getState().enqueueMessage('pam', 'ship the roster fix');
  await sleep(FLUSH_WAIT_MS);
  const mid = readRoster(home);
  assert.ok(mid.agents.some((a) => a.id === 'pam'), 'setup: A hired Pam');
  assert.ok(mid.queues.pam?.some((m) => m.text === 'ship the roster fix'), 'setup: A queued a message');

  // B (never saw any of it) queues for Dwight, forcing a flush of its full
  // snapshot. Pre-fix this dropped BOTH Pam and her parked message.
  B.useStore.getState().enqueueMessage('dwight', 'and the queue merge');
  await sleep(FLUSH_WAIT_MS);
  assert.equal(B.writes.length, 1);

  const after = readRoster(home);
  assert.ok(
    after.queues.pam?.some((m) => m.text === 'ship the roster fix'),
    `A's parked message must survive B's flush (file queues: ${JSON.stringify(Object.keys(after.queues ?? {}))})`
  );
  assert.ok(after.queues.dwight?.some((m) => m.text === 'and the queue merge'), 'B\'s own message survives too');
  assert.ok(
    after.agents.some((a) => a.id === 'pam'),
    `A's hire must survive B's flush (file agents: [${(after.agents ?? []).map((a) => a.id).join(', ')}])`
  );
});

test('the relaunched window still prefers the file the fix keeps truthful', async (t) => {
  // rosterSource pins that a non-empty file beats localStorage. With the merge
  // in place that file is now the union of both windows' work, so this choice
  // is safe instead of the deletion vector it used to be.
  const home = tmpHome(t);
  const roster = new RosterStore(() => home);
  fs.writeFileSync(rosterPath(home), JSON.stringify(snapshot([agent('dwight', 'Dwight')])), 'utf8');

  const A = bootRenderer(home, roster);
  const B = bootRenderer(home, roster);
  A.useStore.getState().addAgent(agent('agent-x', 'Pam'));
  await sleep(FLUSH_WAIT_MS);
  B.useStore.getState().setAgentNote('dwight', 'beets');
  await sleep(FLUSH_WAIT_MS);

  const file = readRoster(home);
  const src = chooseRosterSource({ fileRoster: file, currentHome: home, storedHome: home });
  assert.deepEqual(src, { useFileRoster: true, useLocalFallback: false });
  const ids = file.agents.map((a) => a.id);
  assert.ok(ids.includes('agent-x') && ids.includes('dwight'),
    `next launch reads a file holding BOTH windows' agents (file agents: [${ids.join(', ')}])`);
});

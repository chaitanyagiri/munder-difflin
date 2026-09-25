'use strict';

/**
 * Repro for bug 16 — two live windows clobber <harnessHome>/roster.json.
 *
 * Every renderer window (the primary plus each floor, which get isolated
 * `persist:floor-N` partitions at src/main/index.ts:2314) runs
 * src/renderer/src/store/store.ts. That module reads roster.json exactly once,
 * at module load (store.ts:374-376), into a per-window mirror, and flushes the
 * ENTIRE snapshot {agents, archived, restorable, queues, selectedId} via
 * `roster:write` 500ms after any persist* call (store.ts:416-436) and again on
 * beforeunload (store.ts:441-443). Main's single RosterStore
 * (src/main/roster.ts:129-169, the one `roster` instance at index.ts:280)
 * replaces the file wholesale; its only protection is the empty-first-write
 * guard (roster.ts:138: entryCount(existing)>0 && entryCount(snap)===0), which
 * does NOT block a stale but NON-empty snapshot. The file is never re-read
 * after boot and there is no `roster:changed` push (index.ts:3447-3450 defines
 * only readSync/read/write, no fs.watch), so the later writer's
 * boot-time-stale snapshot overwrites agents, notes, archived/restorable
 * entries and queued messages created in the other window.
 *
 * What this script does (all real app code; only the DOM boundary is faked):
 *   - ONE real RosterStore bound to a temp home = main's single `roster`
 *     instance that both windows' IPC writes land on.
 *   - ONE real evaluation of store.ts per fake `window` = one Electron
 *     renderer window. window.cth is faked exactly as preload/index.ts exposes
 *     it (rosterReadSync:1370, rosterWrite:1381, harnessHomeSync:1379); the
 *     store's own mirror, 500ms debounce and flush run for real.
 *   - T0  both windows boot; mirrors primed with Dwight, from roster.json.
 *   - T1  the PRIMARY hires Pam -> its flush writes roster.json with Pam.
 *   - T2  the FLOOR edits Dwight's note -> its stale full-snapshot flush
 *         overwrites the file without Pam.
 *
 * Fails on current code (Pam is silently deleted from roster.json). Passes
 * under any fix that stops a window from overwriting durable state it never
 * saw — a merge in main, a stale-write refusal, or a roster:changed push that
 * makes the renderer re-read before flushing.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const REPO = path.resolve(__dirname, '..', '..');
const loadTs = require(path.join(REPO, 'test', 'load-ts.cjs'));

const { RosterStore, rosterPath, rosterBackupDir } = loadTs('src/main/roster.ts');
const { chooseRosterSource } = loadTs('src/renderer/src/store/rosterSource.ts');

const STORE_TS = path.join(REPO, 'src', 'renderer', 'src', 'store', 'store.ts');
/** The store's own debounce is 500ms (store.ts:435); wait past it. */
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

/**
 * Boot one renderer window: evaluate the real store.ts against a fake `window`.
 * A fresh module evaluation per window is what Electron gives you — each
 * renderer has its own module registry, its own mirror, its own debounce.
 */
function bootRenderer(label, home, rosterStore, log) {
  const writes = []; // every roster:write result this window observed
  const ls = new Map(); // this window's localStorage (own partition)
  const unload = []; // beforeunload listeners (the close-flush path)
  const win = {
    localStorage: {
      getItem: (k) => (ls.has(k) ? ls.get(k) : null),
      setItem: (k, v) => { ls.set(String(k), String(v)); },
      removeItem: (k) => { ls.delete(String(k)); }
    },
    addEventListener: (type, fn) => { if (type === 'beforeunload') unload.push(fn); },
    cth: {
      // preload/index.ts — both windows talk to the SAME RosterStore instance,
      // exactly as index.ts:3447-3450 wires every window's IPC to one `roster`.
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
  const state = storeExports.useStore.getState();
  log(`[T0] ${label} booted: store.ts evaluated, mirror primed from roster.json with ` +
      `[${state.agents.map((a) => a.id).join(', ') || 'nothing'}]`);
  return { label, useStore: storeExports.useStore, state, writes, ls, unload };
}

(async () => {
  const problems = [];
  const observations = [];
  const log = (...a) => console.log(...a);
  const expect = (desc, cond, detail) => {
    if (cond) log(`  ok: ${desc}`);
    else {
      problems.push(`${desc}${detail ? ` — ${detail}` : ''}`);
      log(`  FAIL: ${desc}${detail ? ` — ${detail}` : ''}`);
    }
  };
  const observe = (line) => { observations.push(line); log(`  .. ${line}`); };

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-bug16-'));
  // ONE instance for both windows, as index.ts:280 constructs it in main.
  const roster = new RosterStore(() => home);

  // T(-1): roster.json as the previous run left it — Dwight only.
  fs.writeFileSync(
    rosterPath(home),
    JSON.stringify(snapshot([agent('dwight', 'Dwight')], { selectedId: 'dwight' }), null, 2),
    'utf8'
  );
  log(`temp harnessHome: ${home}\n`);

  // T0 — multiWindow defaults true (config.ts:450); primary A and floor B are
  // both open, each with its own module instance primed from the file at ITS
  // OWN boot. Neither ever re-reads roster.json again (no roster:changed push).
  const A = bootRenderer('primary A', home, roster, log);
  const B = bootRenderer('floor B', home, roster, log);

  expect('both windows booted with the pre-hire roster (dwight only)',
    A.state.agents.length === 1 && A.state.agents[0].id === 'dwight' &&
    B.state.agents.length === 1 && B.state.agents[0].id === 'dwight',
    `A=[${A.state.agents.map((a) => a.id)}] B=[${B.state.agents.map((a) => a.id)}]`);

  // T1 — the user hires Pam in the PRIMARY.
  log('\n[T1] primary A: addAgent(agent-x "Pam") -> 500ms debounce -> roster:write');
  A.useStore.getState().addAgent(agent('agent-x', 'Pam'));
  await sleep(FLUSH_WAIT_MS);

  expect("primary's flush reached main (setup sanity)",
    A.writes.length === 1 && A.writes[0].ok === true,
    `writes=${JSON.stringify(A.writes)}`);
  const afterHire = JSON.parse(fs.readFileSync(rosterPath(home), 'utf8'));
  expect('roster.json now holds dwight + agent-x',
    afterHire.agents.some((a) => a.id === 'agent-x') && afterHire.agents.some((a) => a.id === 'dwight'),
    `file agents: [${afterHire.agents.map((a) => a.id).join(', ')}]`);
  log(`[T1] roster.json: [${afterHire.agents.map((a) => a.id).join(', ')}]`);

  // T2 — the user edits a note in the FLOOR window. B's mirror is still the
  // T0 snapshot; its flush writes the WHOLE snapshot (store.ts:416-436).
  log('\n[T2] floor B: setAgentNote(dwight, "beets") -> 500ms debounce -> roster:write');
  B.useStore.getState().setAgentNote('dwight', 'beets');
  await sleep(FLUSH_WAIT_MS);

  expect("floor's flush was invoked (the write reached main)", B.writes.length === 1,
    `writes=${JSON.stringify(B.writes)}`);
  observe('floor B write result: ' + (B.writes[0] ? JSON.stringify(B.writes[0]) : 'none') +
    ' — main refused NOTHING: the only guard (roster.ts:138) blocks an empty-first write ' +
    '(entryCount(existing)>0 && entryCount(snap)===0); this stale snapshot is non-empty ' +
    '(1 agent), so the wholesale replace proceeds');

  const afterNote = JSON.parse(fs.readFileSync(rosterPath(home), 'utf8'));
  log(`[T2] roster.json after the floor's stale full-snapshot flush: ` +
      `[${afterNote.agents.map((a) => a.id).join(', ')}]`);

  // THE BUG — the file no longer holds what the primary wrote at T1.
  expect('agent-x survives in roster.json after the floor flushes its stale snapshot',
    afterNote.agents.some((a) => a.id === 'agent-x'),
    `roster.json agents: [${afterNote.agents.map((a) => a.id).join(', ')}] — agent-x was ` +
    'deleted by a window whose mirror was primed before the hire');

  // End state at next launch: the non-empty file always beats localStorage
  // (rosterSource.ts:52, pinned by test/roster-source.test.cjs), so the primary
  // localStorage copy of Pam is never consulted again.
  const src = chooseRosterSource({ fileRoster: afterNote, currentHome: home, storedHome: home });
  expect('a relaunched window loads the clobbered FILE, not the primary localStorage',
    src.useFileRoster === true, `chooseRosterSource -> ${JSON.stringify(src)}`);
  const lsAgents = JSON.parse(A.ls.get('cth.agents') ?? '[]');
  expect('the primary localStorage still holds agent-x (data alive in a live origin, unreachable next launch)',
    Array.isArray(lsAgents) && lsAgents.some((a) => a.id === 'agent-x'),
    `cth.agents: [${(lsAgents || []).map((a) => a.id).join(', ')}]`);

  // Only the append-only roster-backups/ copy preserves Pam — true whenever the
  // clobber happened (the bug being proven). Under a fix the agent survives in
  // the live file, so this assertion is only made when the clobber occurred.
  const backupDir = rosterBackupDir(home);
  const backups = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];
  const withX = backups.filter((f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(backupDir, f), 'utf8'))
        .agents.some((a) => a.id === 'agent-x');
    } catch { return false; }
  });
  observe(`roster-backups/ copies containing agent-x: ${withX.length} of ${backups.length} ` +
    `(${backups.join(', ')})`);
  if (!afterNote.agents.some((a) => a.id === 'agent-x')) {
    expect('only the append-only backup folder still holds agent-x', withX.length >= 1);
  }

  console.log('');
  if (problems.length) {
    console.error('='.repeat(78));
    console.error(`BUG CONFIRMED — ${problems.length} assertion(s) failed:`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error('Two live windows clobber roster.json: each renderer flushes its own');
    console.error('boot-time-stale FULL snapshot (store.ts:416-436), main replaces the file');
    console.error('wholesale (roster.ts:129-169, guard only blocks empty-first writes at :138),');
    console.error('and there is no re-read and no roster:changed push (index.ts:3447-3450).');
    console.error('='.repeat(78));
    process.exit(1);
  }
  console.log('PASS — durable agent survived the other window\'s flush (bug fixed?)');
  console.log(`(temp home left for inspection: ${home})`);
})().catch((e) => {
  console.error('repro crashed:', e);
  process.exit(1);
});

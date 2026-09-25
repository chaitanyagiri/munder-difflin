'use strict';

/**
 * REGRESSION TEST — voice kill used to pass a HIVE AGENT registry id into a
 * PTY-ID-keyed kill, so renderer-hired agents were never killed, never archived
 * in the hive, and never got their worktree removed — while their floor card was
 * archived anyway. The fix (src/main/index.ts, the voice killAgent) resolves the
 * hive id to its live PTY id with ptyForAgent FIRST — the same thing the
 * breaker-stop path (index.ts:1256) already did — then kills + tears down THAT,
 * and only then broadcasts the card archive.
 *
 * THE TWO ID SPACES:
 *   - hive agent registry id: the key of registry.json's `agents` map.
 *   - PTY session id: the key of PtyManager.sessions / ptyToAgent /
 *     worktreePaths (src/main/pty.ts:778 kill(id) looks up `sessions.get(id)`).
 *
 * A RENDERER hire (AddAgentModal.tsx ~400) deliberately splits them:
 *     const id = uniqueId(name);        // hive id, e.g. "oscar1"
 *     const ptyId = `pty-${id}`;        // PTY id — DIFFERENT string
 * and pty:spawn then records the ownership pair:
 *     ptyToAgent.set(opts.id, opts.hive.id)          (index.ts:2919)
 *     worktreePaths.set(opts.id, wtPath)             (index.ts:2722)
 * both keyed by the PTY id, with the hive id only as the VALUE. index.ts has the
 * reverse lookup — ptyForAgent (index.ts:1098-1102) — and the breaker-stop path
 * uses it (index.ts:1256). The voice kill now uses it too; before the fix it
 * passed the bare hive id straight to ptyManager.kill/teardownPty, which missed
 * every session for a renderer-hired agent.
 *
 * THE VOICE PATH (all real in this test):
 *   1. 'realtime:action' {verb:'kill', agentId:'oscar'}  (renderer tool call)
 *      → resolveAgent (realtimeActions.ts:211) matches by NAME against the
 *        registry and returns r.id = the HIVE registry id ("oscar1").
 *   2. buildKill (realtimeActions.ts:527) closes over r.id; after the verbal
 *      confirm ('realtime:action:confirm' {phrase:'confirm'}) it calls
 *      deps.killAgent("oscar1").
 *   3. deps.killAgent is the voice killAgent in index.ts, extracted VERBATIM
 *      here (plus the real teardownPty + ptyForAgent), so the production code is
 *      what executes, not a copy that could drift.
 *
 * WHAT IS REAL HERE: the real HiveManager on a temp harness home (registry.json,
 * ensureAgent, setArchived, git-committed), the REAL realtimeActions.ts voice
 * spine driven through its ipcMain.handle handlers (propose + distinct-token
 * confirm), the real PtyManager spawning a REAL node-pty PTY (running plain
 * `node -e "setInterval..."` — no claude, no network), the REAL git worktree
 * machinery (addWorktree/removeWorktree from src/main/git.ts, real `git
 * worktree add/remove`), and the kill path itself extracted VERBATIM from
 * src/main/index.ts at run time (killAgent + teardownPty + ptyForAgent), so the
 * production code is what executes, not a copy that could drift. Faked only at
 * module boundaries: electron → an ipcMain-recording stub (no display;
 * realtimeActions only touches ipcMain); the four side-effect deps teardownPty
 * closes over that are inert for a non-worker agent (integrationBroker/breaker/
 * telemetry/syncKeepAwake); and liveWebContents → a recording webContents — the
 * exact seam index.ts injects.
 *
 * THE SCENARIO: Oscar is hired from the UI (hive id "oscar1", pty id
 * "pty-oscar1", isolated git worktree). The operator says "kill oscar", then
 * "confirm". The voice spine resolves Oscar and calls killAgent("oscar1").
 *
 * PASSES since the fix: the kill resolves oscar1 → pty-oscar1, the child
 * process dies, the registry flips archived:true, the worktree is removed, the
 * maps are cleaned, and the single hive:agentArchived broadcast agrees with the
 * registry. A drift guard below FAILS if the extracted killAgent stops
 * resolving through ptyForAgent (i.e. if someone reintroduces the bare-id kill).
 * The CONTROL test pins that the same voice path still works end-to-end for a
 * voice-hired agent (pty id == hive id), so the suite covers both id shapes.
 *
 * Run: node --test test/repro/bug-8.repro.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');

const loadTs = require('../load-ts.cjs');

// ─── 0. Module-boundary stubs (installed before any src/ module loads) ──────

// realtimeActions.ts does `import { ipcMain } from 'electron'` at module load.
// No display, no Electron: a recording ipcMain is the whole stub — the test
// invokes the captured handlers directly, exactly as the renderer would.
const ipcHandlers = new Map(); // channel -> handler
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    ipcMain: {
      handle(channel, fn) { ipcHandlers.set(channel, fn); },
      on() {}
    }
  }
};

// ─── 1. Real modules ─────────────────────────────────────────────────────────

const { PtyManager } = loadTs('src/main/pty.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { ControlRegistry } = loadTs('src/main/control.ts');
const { WorkerWakeWatchdog } = loadTs('src/main/workerWake.ts');
const { addWorktree, removeWorktree } = loadTs('src/main/git.ts');
const { hardKillTree } = loadTs('src/main/procKill.ts');
const { registerRealtimeActionIpc } = loadTs('src/main/realtimeActions.ts');

// ─── 2. Extract the REAL kill path from src/main/index.ts ───────────────────
// Verbatim source extraction by brace matching (the test/repro convention), so
// the production code is what executes, not a copy that could drift.

const REPO = path.resolve(__dirname, '..', '..');
const INDEX_SRC = fs.readFileSync(path.join(REPO, 'src', 'main', 'index.ts'), 'utf8');

function assertBraceBalancedSlice(src, start, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('repro setup: unbalanced braces in extracted source');
}

/** Pull one top-level `function name(...) {...}` out of index.ts. */
function extractFn(src, name) {
  const marker = `function ${name}(`;
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `repro setup: cannot find ${name}() in src/main/index.ts — it moved; update this repro`);
  const open = src.indexOf('{', src.indexOf(')', start));
  assert.ok(open >= 0, `repro setup: cannot find ${name}() body`);
  return assertBraceBalancedSlice(src, start, open);
}

/** Pull an object-literal property `name: (id) => {...}` out of index.ts —
 *  here, the voice killAgent in index.ts. */
function extractProp(src, name) {
  const marker = `${name}: (id) => {`;
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `repro setup: cannot find ${name} in src/main/index.ts — it moved; update this repro`);
  const open = start + marker.length - 1; // index of the '{'
  return assertBraceBalancedSlice(src, start, open);
}

const KILL_AGENT_SRC = extractProp(INDEX_SRC, 'killAgent');
const TEARDOWN_SRC = extractFn(INDEX_SRC, 'teardownPty');
// The repo's own resolve-before-kill lookup (index.ts:1098-1102); the breaker
// stop and (since this fix) the voice killAgent both resolve through it.
const PTY_FOR_AGENT_SRC = extractFn(INDEX_SRC, 'ptyForAgent');
// Drift guard: the extracted killAgent must still RESOLVE the spoken hive id to
// its live PTY id before killing, must tear down THAT pty id, and must keep the
// card broadcast. This is the regression this test exists for — if any needle
// stops matching, the id-space mismatch below is back.
for (const needle of [
  'const ptyId = ptyForAgent(id);',
  'if (!ptyId) return { ok: false, error:',
  'ptyManager.kill(ptyId)',
  'teardownPty(ptyId)',
  "send('hive:agentArchived', { id })"
]) {
  assert.ok(KILL_AGENT_SRC.includes(needle), `repro setup: killAgent no longer contains ${needle} — the id-space fix may have regressed; update this repro`);
}

/** Wrap the verbatim production bodies with the module-level dependencies they
 *  close over in index.ts, injected from the harness (bug-3 pattern). */
const makeKillPath = (() => {
  const wrapper = `
module.exports = function makeKillPath(deps) {
  const ptyManager = deps.ptyManager;
  const liveWebContents = deps.liveWebContents;
  const liveWorkers = deps.liveWorkers;
  const integrationBroker = deps.integrationBroker;
  const ptyToAgent = deps.ptyToAgent;
  const workerWake = deps.workerWake;
  const breaker = deps.breaker;
  const telemetry = deps.telemetry;
  const hive = deps.hive;
  const worktreePaths = deps.worktreePaths;
  const worktreeOrigins = deps.worktreeOrigins;
  const removeWorktree = deps.removeWorktree;
  const finalizeWorkerWorktree = deps.finalizeWorkerWorktree;
  const syncKeepAwake = deps.syncKeepAwake;
${TEARDOWN_SRC}
${PTY_FOR_AGENT_SRC}
  const killPath = { ${KILL_AGENT_SRC} };
  return killPath;
};
`;
  const out = ts.transpileModule(wrapper, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: 'extracted-kill-path.ts'
  });
  const mod = { exports: null };
  new Function('module', 'exports', out.outputText)(mod, mod.exports);
  return mod.exports;
})();

// ─── 3. Harness: a floor with one hired agent + the real voice spine ────────

/** A live child that only an explicit kill can stop. No claude, no network. */
const IDLE_CHILD = 'setInterval(function(){},1<<30)';

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pollUntil(fn, timeoutMs, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if (fn()) return true; } catch { /* keep polling */ }
    if (Date.now() > deadline) return false;
    await sleep(stepMs);
  }
}

/** Recording webContents — the liveWebContents() stand-in (index.ts:1354). */
function recordingWC() {
  return { sent: [], isDestroyed: () => false, send(ch, p) { this.sent.push({ channel: ch, payload: p }); } };
}

/**
 * Build a floor with one agent hired the way the RENDERER hires (AddAgentModal:
 * hive id != pty id) or the way VOICE hires (id == pty id), per `voiceHire`.
 * Everything id-adjacent is the real production shape:
 *   - hive.ensureAgent registers the HIVE id (real registry.json, git commit);
 *   - a real PtyManager PTY runs under the PTY id, with a REAL live child;
 *   - ptyToAgent / worktreePaths / worktreeOrigins mirror index.ts:2722/2919
 *     (keyed by PTY id, hive id as the value);
 *   - the worktree is a real `git worktree add` (src/main/git.ts).
 */
async function makeWorld(t, { agentId, name, voiceHire }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-bug8-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'md-bug8-repo-'));
  const ptyId = voiceHire ? agentId : `pty-${agentId}`;
  const spawnedPids = [];
  // The bug under test leaves a LIVE session behind; without this, node-pty's
  // socket handles keep the node process alive after the tests finish.
  const managers = [];

  t.after(() => {
    for (const mgr of managers) { try { mgr.killAll(); } catch { /* best-effort */ } }
    for (const pid of spawnedPids) { try { hardKillTree(pid); } catch { /* already gone */ } }
    for (const dir of [home, repo]) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ } }
  });

  // A real git repo to hire into (the spawn/isolation path requires one).
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'readme.md'), 'base\n');
  g('config', 'user.email', 'repro@example.com');
  g('config', 'user.name', 'Repro');
  g('add', '-A');
  g('commit', '-q', '-m', 'base');

  // Real hive on a temp harnessHome — same wiring as index.ts:236
  // (new HiveManager(() => readConfig().harnessHome)).
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: agentId, name, provider: 'claude', cwd: repo });
  assert.equal(hive.registry().agents[agentId]?.archived, false, 'repro setup: agent registered live');

  // Real isolated worktree, exactly as spawnAgentCore provisions one
  // (index.ts:2711-2726) and keyed the way it keys it.
  const wtPath = path.join(home, 'worktrees', agentId);
  const wt = await addWorktree(repo, wtPath, 'main');
  assert.equal(wt.ok, true, `repro setup: addWorktree failed: ${wt.error}`);
  const worktreePaths = new Map([[ptyId, wtPath]]);
  const worktreeOrigins = new Map([[ptyId, repo]]);

  // A REAL PTY (node-pty) whose child is a live plain-node process.
  const mgr = new PtyManager();
  managers.push(mgr);
  const spawned = mgr.spawn({ id: ptyId, cwd: repo, command: process.execPath, args: ['-e', IDLE_CHILD] });
  assert.equal(spawned.ok, true, `repro setup: pty spawn failed: ${spawned.error}`);
  const session = mgr.list().find((p) => p.id === ptyId);
  assert.ok(session, 'repro setup: session missing after spawn');
  const childPid = session.pid;
  spawnedPids.push(childPid);
  assert.ok(pidAlive(childPid), 'repro setup: the PTY child should be alive');

  // index.ts:2919 — ownership is recorded PTY-id → HIVE-id.
  const ptyToAgent = new Map([[ptyId, agentId]]);

  // The voice kill deps (index.ts) — verbatim bodies + real seams.
  const floorWC = recordingWC();
  const killCalls = [];
  const killPath = makeKillPath({
    ptyManager: mgr,
    liveWebContents: () => floorWC,
    liveWorkers: new Map(), // renderer hires are not ephemeral workers
    integrationBroker: { revoke() {} },
    ptyToAgent,
    workerWake: new WorkerWakeWatchdog(),
    breaker: { forget() {} },
    telemetry: { forgetAgent() {} },
    hive,
    worktreePaths,
    worktreeOrigins,
    removeWorktree,
    finalizeWorkerWorktree: () => { throw new Error('not a worker — must never be reached'); },
    syncKeepAwake: () => {}
  });
  const killAgent = (id) => { killCalls.push(id); return killPath.killAgent(id); };

  // The REAL voice spine (realtimeActions.ts), registered against a real
  // ControlRegistry — the same shape index.ts:4448 wires.
  const control = new ControlRegistry();
  registerRealtimeActionIpc({
    hiveEnabled: () => hive.enabled(),
    hiveSend: (partial, from) => hive.send(partial, from),
    hiveTasks: () => hive.tasks(),
    hiveAddTask: () => true,
    hivePatchTask: () => true,
    hiveDeleteTask: () => true,
    hiveRegistry: () => hive.registry(),
    hiveLog: (event) => { try { hive.appendLog(event); } catch { /* best-effort */ } },
    controlPause: (id, on) => control.pause(id, on),
    controlSteer: (id, text) => control.steer(id, text),
    controlHalt: (id) => control.halt(id),
    controlSnapshot: (id) => control.snapshot(id),
    killAgent,
    spawnAgent: async () => ({ ok: false, error: 'unused in this repro' }),
    listMissions: () => [],
    saveMissions: () => {},
    controlResume: () => {},
    controlAutoDelivery: () => {},
    controlGateTool: () => {},
    setArchived: (id, archived) => { hive.setArchived(id, archived); return { ok: true }; },
    enqueueToAgent: () => {},
    getConfigValue: () => undefined,
    patchConfig: () => {}
  });

  const propose = (agentRef) => ipcHandlers.get('realtime:action')(null, { verb: 'kill', agentId: agentRef });
  const confirm = (phrase) => ipcHandlers.get('realtime:action:confirm')(null, { phrase: phrase || 'confirm' });
  const cancel = () => ipcHandlers.get('realtime:action:cancel')(null, {});

  return { home, repo, hive, mgr, ptyId, agentId, childPid, wtPath, ptyToAgent, worktreePaths, floorWC, killCalls, propose, confirm, cancel };
}

// ─── 4. Tests ────────────────────────────────────────────────────────────────

test('precondition: a renderer hire is live under BOTH id spaces — hive id registered, PTY under pty-<id>, real child running', async (t) => {
  const w = await makeWorld(t, { agentId: 'oscar1', name: 'Oscar', voiceHire: false });

  // The two id spaces are out of sync BY DESIGN of the renderer hire:
  assert.equal(w.hive.registry().agents['oscar1'].name, 'Oscar', 'the HIVE registry knows oscar1');
  assert.ok(w.mgr.list().some((p) => p.id === 'pty-oscar1'), 'the PTY session is keyed pty-oscar1');
  assert.ok(!w.mgr.list().some((p) => p.id === 'oscar1'), 'no PTY is keyed by the bare hive id');
  assert.equal(w.ptyToAgent.get('pty-oscar1'), 'oscar1', 'ownership map: pty id -> hive id (index.ts:2919)');
  assert.ok(fs.existsSync(w.wtPath), 'the isolated worktree exists');
  assert.ok(pidAlive(w.childPid), `child pid ${w.childPid} is running`);
});

test('mechanism: the voice spine resolves "kill Oscar" to the HIVE registry id and stages a confirm — killAgent is not called until then', async (t) => {
  const w = await makeWorld(t, { agentId: 'oscar1', name: 'Oscar', voiceHire: false });

  const proposed = await w.propose('Oscar');
  assert.equal(proposed.ok, true, `propose rejected: ${proposed.spoken}`);
  assert.equal(proposed.needsConfirm, true, 'kill is destructive — two-phase confirm required');
  assert.match(proposed.spoken, /Oscar/, 'the proposal names the resolved agent');
  assert.deepEqual(w.killCalls, [], 'killAgent must not run until the verbal confirm');

  // A bare affirmation must NOT authorize the kill (the spine's safety surface).
  const bare = await w.confirm('yes');
  assert.equal(bare.ok, false, 'a bare "yes" must be rejected');
  assert.deepEqual(w.killCalls, [], 'still not killed');
  await w.cancel();
  assert.deepEqual(w.killCalls, [], 'cancel released the pending');
});

test('REGRESSION: voice "kill oscar" + confirm kills the renderer-hired agent — process dies, hive archived, worktree removed, card broadcast agrees', async (t) => {
  const w = await makeWorld(t, { agentId: 'oscar1', name: 'Oscar', voiceHire: false });

  // Pre-state: everything live, agent unarchived.
  assert.ok(pidAlive(w.childPid), 'precondition: child running');
  assert.equal(w.hive.registry().agents['oscar1'].archived, false, 'precondition: unarchived');
  assert.ok(fs.existsSync(w.wtPath), 'precondition: worktree present');

  // The full voice flow against the REAL spine + REAL kill path. killAgent is
  // handed the HIVE id ("oscar1"); the PTY session is keyed "pty-oscar1".
  const proposed = await w.propose('Oscar');
  assert.equal(proposed.ok, true, `propose failed: ${proposed.spoken}`);
  const committed = await w.confirm('confirm');

  // The kill resolved oscar1 → pty-oscar1 and reported success.
  assert.deepEqual(w.killCalls, ['oscar1'], 'the spine still hands killAgent the HIVE registry id');
  assert.match(committed.spoken, /^Killed Oscar\./,
    `killAgent must kill under the RESOLVED pty id, not answer "no pty: oscar1": ${committed.spoken}`);

  // The child process actually received the kill.
  assert.ok(await pollUntil(() => !pidAlive(w.childPid), 10_000),
    `the PTY child (pid ${w.childPid}) must die — ptyManager.kill("oscar1") alone never signalled it`);

  // The pty session and ownership map were torn down under the PTY id.
  assert.ok(!w.mgr.list().some((p) => p.id === 'pty-oscar1'),
    `sessions after the kill: ${JSON.stringify(w.mgr.list().map((p) => p.id))}`);
  assert.ok(!w.ptyToAgent.has('pty-oscar1'),
    'teardownPty must run under the pty id to find the ptyToAgent entry');

  // The hive agent is archived for real (not just on the floor).
  assert.equal(w.hive.registry().agents['oscar1']?.archived, true,
    'teardownPty must reach hive.setArchived — a "killed" agent can\'t stay live in the hive');

  // The isolated worktree was removed.
  assert.ok(await pollUntil(() => !fs.existsSync(w.wtPath), 6_000),
    `${w.wtPath} must be removed — teardownPty must see the worktree keyed "pty-oscar1"`);

  // A voice kill is MAIN-initiated; the renderer never removes the card itself,
  // so exactly one archive broadcast must fire — and it must agree with the
  // hive (registry.archived === true by now) so the UI never shows a lie.
  const archBcasts = w.floorWC.sent.filter((m) => m.channel === 'hive:agentArchived');
  assert.deepEqual(archBcasts.map((m) => m.payload), [{ id: 'oscar1' }],
    `expected exactly one hive:agentArchived {id:"oscar1"}, got ${JSON.stringify(archBcasts.map((m) => m.payload))}`);
  assert.equal(w.hive.registry().agents['oscar1']?.archived, true,
    'the card broadcast must be truthful: the registry is archived when the card is');
});

test('control: the SAME voice path still kills a VOICE-hired agent cleanly (pty id == hive id) — the fix changes nothing there', async (t) => {
  const w = await makeWorld(t, { agentId: 'vera1', name: 'Vera', voiceHire: true });

  const proposed = await w.propose('Vera');
  assert.equal(proposed.ok, true, `propose failed: ${proposed.spoken}`);
  const committed = await w.confirm('confirm');
  assert.match(committed.spoken, /^Killed Vera\./, `the identical voice flow must kill when the ids align: ${committed.spoken}`);
  assert.deepEqual(w.killCalls, ['vera1']);

  assert.ok(await pollUntil(() => !pidAlive(w.childPid), 10_000),
    `the voice-hired agent's child (pid ${w.childPid}) dies — same code path, only the pty-id shape differs`);
  assert.ok(!w.mgr.list().some((p) => p.id === 'vera1'), 'the pty session is gone');
  assert.ok(!w.ptyToAgent.has('vera1'), 'the ownership map is cleaned');
  assert.equal(w.hive.registry().agents['vera1']?.archived, true, 'the hive entry is archived for real');
  assert.ok(await pollUntil(() => !fs.existsSync(w.wtPath), 6_000), 'the worktree is removed');

  const archBcasts = w.floorWC.sent.filter((m) => m.channel === 'hive:agentArchived');
  assert.deepEqual(archBcasts.map((m) => m.payload), [{ id: 'vera1' }],
    'the archive broadcast fired — and this time it agrees with the registry');
});

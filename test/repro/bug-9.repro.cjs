'use strict';

// Repro for: killing a missing-CLI install PTY through the `pty:kill` IPC path
// leaks its pendingInstallRelaunch entry, which a later same-id session can
// spuriously consume.
//
// The chain (all REAL code, loaded straight from src/):
//
//   1. src/main/index.ts:2640-2694 — spawnAgentCore's missing-CLI short-circuit:
//      the engine binary is absent, so the provider's installer runs IN the
//      agent's PTY (shellScript route) and, once it is running,
//      index.ts:2678 arms the auto restart-and-continue:
//
//          pendingInstallRelaunch.set(opts.id, { opts, owner, bin, rung: rung.kind });
//
//   2. src/main/index.ts:586-623 — the PTY exit handler is the ONLY consumer of
//      that map: on the installer's exit it deletes the entry, and for exitCode 0
//      broadcasts `pty:relaunch:<id>` and re-runs spawnAgentCore with the STORED
//      spawn opts. A repo-wide search finds no other reader and no other delete.
//
//   3. src/main/index.ts:3021-3029 — the `pty:kill` IPC handler (closing the
//      terminal tab / Stop) calls ptyManager.kill(id) then teardownPty(id).
//      PtyManager.kill (src/main/pty.ts:778-790) deletes the session
//      SYNCHRONOUSLY, so when node-pty's onExit for the killed installer later
//      fires, it fails the stale-session identity guard
//      (`sessions.get(id) !== session`, pty.ts:714) and is swallowed: the exit
//      handler never runs for a killed PTY. teardownPty (index.ts:437-494)
//      archives agents/workers/worktrees but NEVER touches
//      pendingInstallRelaunch, and the code's own comment (index.ts:429-433)
//      documents that every kill site must do its own teardown — none of them
//      knows about this map. So a cancelled install leaves its entry armed for
//      the process lifetime.
//
//   4. Renderer pty ids are REUSED: restart/revive/restore re-spawn with the
//      agent's existing a.ptyId (useRestoreTeam.ts:112 `a.ptyId ?? pty-${a.id}`,
//      useHive.ts revive, CommandCenterPanel restart = killPty + spawnPty on
//      a.ptyId). A later, UNRELATED session with the same id therefore shares
//      the map key with the cancelled install.
//
//   5. When that unrelated session's process exits 0 (the user's agent finished
//      or the tab was closed cleanly), its onExit DOES pass the identity guard,
//      reaches the exit handler, finds the STALE entry, deletes it, and treats
//      the unrelated clean exit as a completed CLI install:
//        - `pty:relaunch:<id>` is broadcast to the renderer,
//        - spawnAgentCore re-runs the CANCELLED spawn's stored opts (stale cwd,
//          stale command, stale hive/token state) as a phantom extra process,
//        - a false agent_install_finished{outcome:'agent_launched'} analytics
//          event is emitted for an install that was cancelled.
//      Repeat the cancel and the map grows one stale entry per cancelled install,
//      each waiting to hijack a future same-id exit.
//
// The CONTROL below pins the legitimate path so a fix cannot simply refuse
// every relaunch: an install that is NOT killed exits 0 naturally, consumes its
// own entry, and DOES relaunch — and after that natural consumption a later
// same-id clean exit spawns nothing extra. Only the kill-before-consumption
// path leaks.
//
// Deterministic, offline, no display, no real PTYs, no real provider CLIs:
// the REAL src/main/index.ts (exit handler + ipcMain.handle('pty:spawn'/'pty:kill')
// + spawnAgentCore) and the REAL src/main/pty.ts session/identity-guard logic
// run; faked only at module boundaries:
//   - electron       → stub (app.whenReady never resolves, so no boot side
//                      effects; ipcMain.handle recorded so the repro drives the
//                      real IPC handlers);
//   - node-pty.spawn → FakePty (kill() does NOT deliver onExit — node-pty's
//                      exit callback is async, which is exactly why the killed
//                      installer's onExit arrives after kill() emptied the map);
//   - command probes → the engine binary is MISSING (this dev machine actually
//                      has `claude` installed, so the probe is patched to model
//                      the machine the bug fires on), npm/node present → the
//                      npm install rung arms;
//   - nodeInstall    → node usable; resolveNodeInstaller never hits nodejs.org;
//   - procKill       → ensureKilled recorded, not executed (no taskkill/ps);
//   - config         → ensureClaudePermissionsAccepted no-op (it would write the
//                      real ~/.claude), HOME sandboxed to a temp dir.
//
// Run: node test/repro/bug-9.repro.cjs
//
// FAILS on current main: after the unrelated same-id session exits cleanly, the
// stale entry fires `pty:relaunch:<id>`, a phantom third PTY re-runs the
// CANCELLED install's command/cwd, and a bogus agent_install_finished
// {outcome:'agent_launched'} is captured.
// PASSES after a correct fix (the kill path — pty:kill handler, teardownPty, or
// PtyManager.kill — must delete the pendingInstallRelaunch entry for the killed
// id, since the identity guard guarantees the killed process's own onExit never
// can): the controls still relaunch, the killed installs never do.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const loadTs = require(path.join(__dirname, '..', 'load-ts.cjs'));

// ─── 0. Sandboxes + module-boundary stubs (installed before any src/ load) ──

const ROOTS = {
  userData: fs.mkdtempSync(path.join(os.tmpdir(), 'md-bug9-userdata-')),
  home: fs.mkdtempSync(path.join(os.tmpdir(), 'md-bug9-home-'))
};
// Sandbox HOME before anything can read it: nothing in this repro may touch the
// real ~/.claude (config.ts writes settings there via os.homedir()).
process.env.HOME = ROOTS.home;
process.env.USERPROFILE = ROOTS.home;
delete process.env.DO_NOT_TRACK; // analytics must be live to catch the bogus event

// The posthog keys are TS `declare const` in analytics.ts — define them so the
// REAL analytics singleton captures into a fake client instead of staying dark.
globalThis.__POSTHOG_KEY__ = 'bug9-repro-key';
globalThis.__POSTHOG_HOST__ = '';

const ipcHandlers = new Map(); // channel -> handler (real handlers recorded)

// --- electron stub (same pattern as test/repro/bug-7.repro.cjs) -------------
const electronPath = require.resolve('electron');
class MockWebContents {
  constructor(label) {
    this.__label = label;
    this._destroyed = false;
    this.sent = []; // { channel, payload }
  }
  isDestroyed() { return this._destroyed; }
  send(channel, payload) { this.sent.push({ channel, payload }); }
}
class MockBrowserWindow {
  constructor() {
    this.webContents = new MockWebContents('wc');
    this._destroyed = false;
    this._listeners = {};
  }
  isDestroyed() { return this._destroyed; }
  on(ev, fn) { (this._listeners[ev] ??= []).push(fn); return this; }
  once(ev, fn) { return this.on(ev, fn); }
  emit(ev, ...args) { for (const fn of this._listeners[ev] ?? []) fn(...args); }
  loadFile() { return Promise.resolve(); }
  loadURL() { return Promise.resolve(); }
  focus() {}
  destroy() { this._destroyed = true; }
  static getAllWindows() { return []; }
  static fromWebContents(wc) { return wc && wc.__owner ? wc.__owner : null; }
}
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      _listeners: {},
      on(ev, fn) { (this._listeners[ev] ??= []).push(fn); return this; },
      // NEVER resolves: keeps the whenReady-only boot block (analytics.init,
      // auto-updater, servers) from running. All wiring under test —
      // setExitHandler (index.ts:586) and the ipcMain.handle registrations
      // (pty:spawn 2585, pty:kill 3021) — happens at module LOAD.
      whenReady() { return new Promise(() => {}); },
      quit() {}, exit() {}, relaunch() {},
      requestSingleInstanceLock() { return true; },
      setAsDefaultProtocolClient() {},
      setLoginItemSettings() {}, getLoginItemSettings() { return {}; },
      isPackaged: false,
      getAppPath() { return path.join(__dirname, '..', '..'); },
      getPath(name) { return ROOTS.userData; },
      getVersion() { return '0.4.6-repro'; }
    },
    BrowserWindow: MockBrowserWindow,
    ipcMain: {
      handle(channel, fn) { ipcHandlers.set(channel, fn); },
      on() {}
    },
    dialog: { showMessageBoxSync() { return 1; }, showMessageBox() { return Promise.resolve({ response: 0 }); }, showOpenDialog() { return Promise.resolve({ canceled: true }); }, showErrorBox() {} },
    Menu: { buildFromTemplate() { return {}; }, setApplicationMenu() {} },
    Notification: function NotificationMock() { this.show = () => {}; },
    powerMonitor: { on() {} },
    powerSaveBlocker: { start() { return 1; }, stop() {}, isStarted() { return false; } },
    screen: { on() {}, getAllDisplays() { return []; }, getPrimaryDisplay() { return null; } },
    shell: { openExternal() { return Promise.resolve(); }, openPath() { return Promise.resolve(''); }, showItemInFolder() {} },
    clipboard: { writeText() {}, readText() { return ''; }, readImage() { return null; } }
  }
};

// --- node-pty stub: record spawns; kill() does NOT deliver onExit. ----------
//
// This models the real timing the bug lives in: node-pty's exit callback is
// asynchronous. PtyManager.kill() (pty.ts:778) deletes the session from its map
// BEFORE that callback fires, so the callback fails the identity guard
// (pty.ts:714) and the main-process exit handler never learns the PTY died —
// leaving pendingInstallRelaunch armed forever. The repro fires the late
// onExit BY HAND (fireExit), exactly when the real node-pty would.
const ptyRequirePath = require.resolve('node-pty');
const fakePtys = [];
let fakePtySeq = 9100;
class FakePty {
  constructor(file, args, opt) {
    this.file = file;
    this.args = args;
    this.opt = opt;
    this.pid = ++fakePtySeq;
    this.killed = false;
    this.cols = (opt && opt.cols) || 100;
    this.rows = (opt && opt.rows) || 30;
    this._dataCbs = [];
    this._exitCbs = [];
    fakePtys.push(this);
  }
  onData(cb) { this._dataCbs.push(cb); }
  onExit(cb) { this._exitCbs.push(cb); }
  write() {}
  resize() {}
  kill() { this.killed = true; } // no synchronous exit delivery — the async
  // onExit is what the repro delivers by hand, as node-pty eventually does.
  fireExit(exitCode, signal) {
    for (const cb of [...this._exitCbs]) cb({ exitCode, signal });
  }
}
require.cache[ptyRequirePath] = {
  id: ptyRequirePath,
  filename: ptyRequirePath,
  loaded: true,
  exports: {
    __esModule: true,
    spawn(file, args, opt) { return new FakePty(file, args, opt); }
  }
};

// --- posthog-node stub: capture into an array; never any network. -----------
const posthogPath = require.resolve('posthog-node');
const capturedEvents = [];
class FakePostHog {
  constructor(key, opts) { this.key = key; this.opts = opts; }
  capture(ev) { capturedEvents.push(ev); }
  async shutdown() { return; }
}
require.cache[posthogPath] = {
  id: posthogPath,
  filename: posthogPath,
  loaded: true,
  exports: { PostHog: FakePostHog }
};

// ─── 1. Load the REAL modules; patch only what must not touch the machine ──

// The REAL analytics singleton — armed with the fake PostHog client so the
// bogus agent_install_finished event is observable without any network.
const analytics = loadTs('src/main/analytics.ts');
analytics.analytics.init({ stateDir: ROOTS.userData, appVersion: '0.4.6-repro', enabled: true });

// pty.ts first, so its class exists to patch before index.ts news it up.
const ptyModule = loadTs('src/main/pty.ts');
const { PtyManager } = ptyModule;

// index.ts constructs its own `ptyManager` internally (index.ts:111) and exports
// nothing — capture that exact instance (whose exit handler is the one at
// index.ts:586) by wrapping the constructor while index.ts loads.
let managerInstance = null;
const RealPtyManager = ptyModule.PtyManager;
ptyModule.PtyManager = class CapturedPtyManager extends RealPtyManager {
  constructor(...args) {
    super(...args);
    managerInstance = this;
  }
};

// Command probes: the engine binary is MISSING (the missing-CLI scenario); npm
// and node resolve. Patched on the prototype so NO where/which/shell probe runs
// (this dev machine actually has `claude`; the patch is what models the machine
// in the failure scenario).
const MISSING_BIN = 'definitely-missing-cli-xyz';
PtyManager.prototype.isCommandAvailable = function (command) {
  return command !== MISSING_BIN;
};
PtyManager.prototype.resolveCommand = function (command) {
  const fake = process.platform === 'win32'
    ? `C:\\fake\\bin\\${command}.exe`
    : `/fake/bin/${command}`;
  return { path: fake, found: true };
};

// shellEnv: keep spawn() off any interactive login shell.
const shellEnv = loadTs('src/main/shellEnv.ts');
shellEnv.userShellPath = () => process.env.PATH || '/usr/bin:/bin';

// nodeInstall: node is usable (npm rung arms the relaunch), and
// resolveNodeInstaller must never hit nodejs.org (npm rung short-circuits it).
const nodeInstall = loadTs('src/main/nodeInstall.ts');
nodeInstall.detectNodeVersion = () => 'v22.11.0';
nodeInstall.nodeIsUsable = () => true;
nodeInstall.resolveNodeInstaller = async () => null;

// procKill: record instead of running taskkill/ps sweeps against fake pids.
const procKill = loadTs('src/main/procKill.ts');
const ensuredKilledPids = [];
procKill.ensureKilled = function (pid) { ensuredKilledPids.push(pid); };
procKill.hardKillTree = function () {};
// config: the healthy respawn re-runs ensureClaudePermissionsAccepted
// (index.ts:2929) which writes the REAL ~/.claude — no-op it. HOME is also
// sandboxed above as belt and braces.
const configModule = loadTs('src/main/config.ts');
configModule.ensureClaudePermissionsAccepted = function () {};

// index.ts: registers the REAL exit handler (index.ts:586) and the REAL
// 'pty:spawn' / 'pty:kill' IPC handlers at module load.
loadTs('src/main/index.ts');

// ─── 1b. Optional fix simulation (BUG9_FIXED=1) ─────────────────────────────
//
// BUG9_FIXED=1 runs the SAME scenario against a minimally corrected kill path,
// to show the repro's assertions are the post-fix contract (every failing
// assertion above then holds). index.ts exports nothing, so the pendingInstall-
// Relaunch map is captured by its unique value shape: {opts, owner, bin, rung}
// — scanned on every set/delete through Map.prototype spies right after load.
// The simulated fix is exactly the minimal correct one: the `pty:kill` IPC
// handler — which must already do its own teardown because the identity guard
// swallows the killed process's onExit — also deletes the id's relaunch entry
// when it kills an install PTY.
const FIXED = process.env.BUG9_FIXED === '1';
let pendingMap = null; // the module-private pendingInstallRelaunch Map
if (FIXED) {
  // index.ts's map is module-private; find it by its unique value shape — the
  // only Map in the process whose values are install-relaunch records
  // ({opts, owner, bin, rung}). The spy sees the arming .set() (index.ts:2678)
  // fire during the control spawn below, and is restored right after.
  const origSet = Map.prototype.set;
  Map.prototype.set = function (k, v) {
    if (
      v && typeof v === 'object' && !Array.isArray(v) &&
      'bin' in v && 'rung' in v && 'opts' in v && 'owner' in v
    ) {
      pendingMap = this;
      Map.prototype.set = origSet; // identified — restore the prototype
    }
    return origSet.call(this, k, v);
  };
}

// ─── 2. Drive the scenario through the real IPC + exit-handler code ────────

const CTL_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'md-bug9-ctl-'));       // control: install completes
const INSTALL_CWD_1 = fs.mkdtempSync(path.join(os.tmpdir(), 'md-bug9-inst1-')); // bug: cancelled install
const INSTALL_CWD_2A = fs.mkdtempSync(path.join(os.tmpdir(), 'md-bug9-inst2a-')); // leak accumulation
const INSTALL_CWD_2B = fs.mkdtempSync(path.join(os.tmpdir(), 'md-bug9-inst2b-'));
const LATER_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'md-bug9-later-'));   // bug scenario's reused-id session
const UNRELATED_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'md-bug9-later2-')); // leak id 2a's reused session
const UNRELATED_CWD_2 = fs.mkdtempSync(path.join(os.tmpdir(), 'md-bug9-later3-')); // leak id 2b's reused session

const ptySpawnHandler = ipcHandlers.get('pty:spawn');
const ptyKillHandler = ipcHandlers.get('pty:kill');
const realKillRef = ptyKillHandler; // original (unfixed) kill handler, for the fix-sim wrapper

function ptysForCwd(cwd) {
  return fakePtys.filter((p) => p.opt && p.opt.cwd === cwd);
}
function sentTo(wc, channel) {
  return wc.sent.filter((m) => m.channel === channel);
}
function installFinishedEvents() {
  return capturedEvents.filter((e) => e.event === 'agent_install_finished');
}
function flush() {
  return new Promise((resolve) => setImmediate(() => setTimeout(resolve, 25)));
}

async function main() {
  const results = [];
  const check = (name, fn) => {
    try { fn(); results.push({ name, ok: true }); console.log(`  ok   - ${name}`); }
    catch (e) { results.push({ name, ok: false, error: e }); console.log(`  FAIL - ${name}\n         ${e.message}`); }
  };

  if (!ptySpawnHandler || !ptyKillHandler) {
    throw new Error('ipcMain.handle("pty:spawn"/"pty:kill") never registered — harness broken');
  }

  // ── CONTROL: an install that is allowed to FINISH consumes its own entry —
  // the relaunch fires (this must keep working after any fix), and a later
  // same-id clean exit finds NOTHING left to consume.
  console.log('\n[control] missing-CLI install runs to a clean exit {exitCode: 0}');
  const wcCtl = new MockWebContents('control-floor');
  wcCtl.__owner = new MockBrowserWindow();
  wcCtl.__owner.webContents = wcCtl;
  const ctlRes = await ptySpawnHandler(
    { sender: wcCtl },
    { id: 'bug9-ctl', cwd: CTL_CWD, command: MISSING_BIN, provider: 'claude', cols: 80, rows: 24 }
  );
  const ctlInstallPty = ptysForCwd(CTL_CWD)[0];
  check('control: missing CLI → install PTY running the npm install rung', () => {
    assert.equal(ctlRes.ok, true, `pty:spawn returned ${JSON.stringify(ctlRes)}`);
    assert.equal(ptysForCwd(CTL_CWD).length, 1, 'expected exactly one install PTY');
    assert.ok(
      JSON.stringify(ctlInstallPty.args).includes('npm install -g @anthropic-ai/claude-code'),
      `install PTY should carry the npm rung script, got ${JSON.stringify(ctlInstallPty.args)}`
    );
  });
  ctlInstallPty.fireExit(0, 0); // the installer finished cleanly
  await flush();
  check('control: clean install exit consumes the entry and relaunches (must keep working)', () => {
    assert.equal(sentTo(wcCtl, 'pty:relaunch:bug9-ctl').length, 1,
      `owner got: ${JSON.stringify(wcCtl.sent.map((m) => m.channel))}`);
    assert.equal(ptysForCwd(CTL_CWD).length, 2, 'the relaunched agent PTY must exist');
  });
  const relaunchedCtl = ptysForCwd(CTL_CWD)[1];
  relaunchedCtl.fireExit(0, 0); // the relaunched agent later exits cleanly too
  await flush();
  check('control: after natural consumption a later same-id exit spawns nothing extra', () => {
    assert.equal(sentTo(wcCtl, 'pty:relaunch:bug9-ctl').length, 1, 'the entry must be consumed exactly once');
    assert.equal(ptysForCwd(CTL_CWD).length, 2, 'no phantom third PTY after the entry was consumed');
  });
  const installFinishedBaseline = installFinishedEvents().length; // control's ONE legit event

  // In FIXED mode the pendingInstallRelaunch map has now been armed (control),
  // so it is identified and the minimal correct fix is applied at the kill
  // seam: the pty:kill handler must delete the entry — the identity guard
  // (pty.ts:714) guarantees the killed installer's own onExit never can.
  if (FIXED) {
    if (!pendingMap) throw new Error('pendingInstallRelaunch map was never armed — fix-sim harness broken');
    const realKill = ptyKillHandler;
    ipcHandlers.set('pty:kill', (evt, id) => {
      const res = realKillRef(evt, id);
      if (res && res.ok && pendingMap.has(id)) pendingMap.delete(id);
      return res;
    });
  }

  // ── THE BUG: same arming, but the user CANCELS the install via the
  // `pty:kill` IPC path (closing the terminal tab) before it finishes.
  console.log('\n[bug] missing-CLI install → pty:kill (tab closed) → the killed onExit is swallowed');
  const wcBug = new MockWebContents('bug-floor');
  wcBug.__owner = new MockBrowserWindow();
  wcBug.__owner.webContents = wcBug;
  const bugRes = await ptySpawnHandler(
    { sender: wcBug },
    { id: 'bug9-leak', cwd: INSTALL_CWD_1, command: MISSING_BIN, provider: 'claude', cols: 80, rows: 24 }
  );
  const installPty = ptysForCwd(INSTALL_CWD_1)[0];
  check('bug precondition: install PTY armed (npm rung) and running', () => {
    assert.equal(bugRes.ok, true, `pty:spawn returned ${JSON.stringify(bugRes)}`);
    assert.equal(ptysForCwd(INSTALL_CWD_1).length, 1, 'expected exactly one install PTY');
    assert.ok(JSON.stringify(installPty.args).includes('npm install -g @anthropic-ai/claude-code'),
      'install PTY should run the npm install rung');
    assert.ok(capturedEvents.some((e) => e.event === 'agent_install_started'),
      'agent_install_started should have been tracked when the entry was armed');
  });

  // The user closes the terminal tab: ipcMain 'pty:kill' (index.ts:3021).
  const killRes = ipcHandlers.get('pty:kill')(null, 'bug9-leak');
  check('mechanism: pty:kill killed the install PTY and tore the session down', () => {
    assert.deepEqual(killRes, { ok: true }, `pty:kill returned ${JSON.stringify(killRes)}`);
    assert.equal(installPty.killed, true, 'the install PTY was not killed');
    assert.ok(ensuredKilledPids.includes(installPty.pid), 'kill did not run its ensureKilled sweep');
    assert.ok(!managerInstance.list().some((p) => p.id === 'bug9-leak'),
      'session still in the map — the leak below could not be demonstrated');
  });

  // node-pty's ASYNC onExit for the killed installer now arrives — after kill()
  // already deleted the session, so the identity guard (pty.ts:714) swallows it:
  // the exit handler NEVER runs for this PTY, and the armed entry survives.
  installPty.fireExit(0, 0);
  await flush();
  check('mechanism: the killed installer\'s late exit is swallowed (no exit event, no spawn)', () => {
    assert.equal(sentTo(wcBug, 'pty:exit:bug9-leak').length, 0,
      'the identity guard should swallow the killed process\'s exit');
    assert.equal(ptysForCwd(INSTALL_CWD_1).length, 1, 'no new PTY may appear from a killed PTY');
    assert.equal(sentTo(wcBug, 'pty:relaunch:bug9-leak').length, 0,
      'nothing may relaunch while the id is dead — but the armed entry is still in the map');
  });

  // The renderer reuses the pty id (restart/revive/restore reuse a.ptyId): an
  // UNRELATED, perfectly healthy session is spawned with the SAME id.
  console.log('\n[bug] the same pty id is later reused by an unrelated healthy session');
  const laterRes = await ptySpawnHandler(
    { sender: wcBug },
    { id: 'bug9-leak', cwd: LATER_CWD, command: 'claude', provider: 'claude', cols: 80, rows: 24 }
  );
  const healthyPty = ptysForCwd(LATER_CWD)[0];
  check('bug precondition: an unrelated healthy session now owns the SAME pty id', () => {
    assert.equal(laterRes.ok, true, `pty:spawn returned ${JSON.stringify(laterRes)}`);
    assert.ok(healthyPty, 'no PTY for the unrelated session');
    assert.ok(managerInstance.list().some((p) => p.id === 'bug9-leak'), 'the reused id is live');
  });

  // That unrelated agent does its work and exits CLEANLY (exit 0). Its onExit
  // PASSES the identity guard — and finds the cancelled install's stale entry.
  const finishedBefore = installFinishedEvents().length;
  healthyPty.fireExit(0, 0);
  await flush();
  await flush();

  check('mechanism: the unrelated clean exit DID reach the exit handler (pty:exit sent)', () => {
    assert.equal(sentTo(wcBug, 'pty:exit:bug9-leak').length, 1,
      `pty:exit sends: ${JSON.stringify(sentTo(wcBug, 'pty:exit:bug9-leak'))}`);
  });

  // THE BUG, assertion 1: the stale entry is consumed by the unrelated exit and
  // `pty:relaunch:<id>` is broadcast.
  check('BUG: the unrelated clean exit must NOT broadcast pty:relaunch for the cancelled install', () => {
    const relaunches = sentTo(wcBug, 'pty:relaunch:bug9-leak');
    assert.equal(relaunches.length, 0,
      'the UNRELATED session\'s clean exit consumed the CANCELLED install\'s stale ' +
      'pendingInstallRelaunch entry: pty:kill (index.ts:3021) kills + tears down but never ' +
      'deletes the entry, and the killed installer\'s own onExit is swallowed by the ' +
      'session-identity guard (pty.ts:714), so the entry leaked until this exit fired ' +
      'pty:relaunch as if the install had just completed');
  });

  // THE BUG, assertion 2: spawnAgentCore re-ran the CANCELLED spawn's stored
  // opts — a phantom PTY in the OLD cwd running the OLD (missing) command.
  check('BUG: the unrelated exit must not spawn a phantom re-running the cancelled install', () => {
    const spawns = ptysForCwd(INSTALL_CWD_1);
    assert.equal(spawns.length, 1,
      `a phantom PTY re-ran the CANCELLED install's spawn opts (${spawns.length} PTYs in the ` +
      `cancelled install's cwd; phantom file=${spawns[1] ? spawns[1].file : 'n/a'}): the exit ` +
      'handler re-ran spawnAgentCore({...pending.opts, noAutoInstall:true}) with the stale ' +
      'cwd/command of the spawn the user cancelled');
  });

  // THE BUG, assertion 3: a false activation-funnel event credits the cancel.
  check('BUG: the unrelated exit must NOT emit a bogus agent_install_finished', () => {
    const finished = installFinishedEvents();
    assert.equal(finished.length, finishedBefore,
      `bogus analytics: agent_install_finished was emitted for the CANCELLED install when the ` +
      `unrelated session exited 0 — captured: ${JSON.stringify(finished.slice(finishedBefore))}. ` +
      'No install ran to completion; the event lies about the activation funnel.');
  });

  // ── THE LEAK, scaled: every cancelled install leaves one more armed entry.
  console.log('\n[leak] two more cancelled installs → two more stale entries, each hijacking a later same-id exit');
  const wcLeak = new MockWebContents('leak-floor');
  wcLeak.__owner = new MockBrowserWindow();
  wcLeak.__owner.webContents = wcLeak;
  for (const [id, cwd] of [['bug9-leak-2a', INSTALL_CWD_2A], ['bug9-leak-2b', INSTALL_CWD_2B]]) {
    const r = await ptySpawnHandler(
      { sender: wcLeak },
      { id, cwd, command: MISSING_BIN, provider: 'claude', cols: 80, rows: 24 }
    );
    assert.equal(r.ok, true, `install spawn for ${id} failed: ${JSON.stringify(r)}`);
    assert.equal(ptysForCwd(cwd).length, 1, `install PTY for ${id} missing`);
    const kr = ipcHandlers.get('pty:kill')(null, id);
    assert.deepEqual(kr, { ok: true }, `pty:kill for ${id} returned ${JSON.stringify(kr)}`);
    ptysForCwd(cwd)[0].fireExit(0, 0); // killed installer's late onExit — swallowed
    await flush();
  }
  check('leak precondition: both cancelled installs are dead with no relaunch fired yet', () => {
    assert.equal(sentTo(wcLeak, 'pty:relaunch:bug9-leak-2a').length, 0);
    assert.equal(sentTo(wcLeak, 'pty:relaunch:bug9-leak-2b').length, 0);
  });
  // Later, the renderer reuses BOTH ids for unrelated healthy sessions. Each
  // id gets its OWN throwaway cwd so the two healthy PTYs can be told apart.
  const healthyReused = {}; // id → the FakePty of the unrelated session
  for (const [id, cwd] of [['bug9-leak-2a', UNRELATED_CWD], ['bug9-leak-2b', UNRELATED_CWD_2]]) {
    const r = await ptySpawnHandler(
      { sender: wcLeak },
      { id, cwd, command: 'claude', provider: 'claude', cols: 80, rows: 24 }
    );
    assert.equal(r.ok, true, `healthy respawn for ${id} failed: ${JSON.stringify(r)}`);
    assert.equal(ptysForCwd(cwd).length, 1, `healthy respawn PTY for ${id} missing`);
    healthyReused[id] = ptysForCwd(cwd)[0];
  }
  const finishedBeforeLeak = installFinishedEvents().length;
  for (const id of ['bug9-leak-2a', 'bug9-leak-2b']) {
    healthyReused[id].fireExit(0, 0); // the unrelated session exits cleanly
    await flush();
  }
  check('BUG: EACH cancelled install leaks an entry that hijacks a later same-id exit (map grows unboundedly)', () => {
    const relaunches = [
      ...sentTo(wcLeak, 'pty:relaunch:bug9-leak-2a'),
      ...sentTo(wcLeak, 'pty:relaunch:bug9-leak-2b')
    ];
    assert.equal(relaunches.length, 0,
      `${relaunches.length} stale relaunches fired for two CANCELLED installs: every ` +
      '`pty:kill` of an install PTY leaves its pendingInstallRelaunch entry armed forever, ' +
      'and each later same-id clean exit consumes one — broadcasting pty:relaunch and ' +
      're-running the cancelled spawn. Nothing bounds the growth.');
    assert.equal(ptysForCwd(INSTALL_CWD_2A).length, 1,
      `phantom PTY re-ran cancelled install 2a (${ptysForCwd(INSTALL_CWD_2A).length} PTYs in its cwd)`);
    assert.equal(ptysForCwd(INSTALL_CWD_2B).length, 1,
      `phantom PTY re-ran cancelled install 2b (${ptysForCwd(INSTALL_CWD_2B).length} PTYs in its cwd)`);
    const finished = installFinishedEvents();
    assert.equal(finished.length, finishedBeforeLeak,
      `bogus agent_install_finished events for cancelled installs: ` +
      `${JSON.stringify(finished.slice(finishedBeforeLeak))}`);
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} assertions hold.`);
  if (failed.length > 0) {
    console.log('\nBUG REPRODUCED — failing assertions:');
    for (const f of failed) console.log(` - ${f.name}\n   ${f.error.message}`);
    console.log(
      '\n(pendingInstallRelaunch.set(opts.id, ...) at src/main/index.ts:2678 is consumed ONLY by\n' +
      ' the PTY exit handler (index.ts:586-623). The pty:kill path (index.ts:3021-3029) calls\n' +
      ' ptyManager.kill(), which deletes the session synchronously (pty.ts:778-790), so the\n' +
      ' killed installer\'s async onExit fails the identity guard (pty.ts:714) and never\n' +
      ' reaches the handler; teardownPty (index.ts:437-494) never clears the map either. The\n' +
      ' entry leaks until a later same-id session exits 0 — renderer restart/revive/restore\n' +
      ' reuse a.ptyId — and then fires pty:relaunch, re-runs the cancelled spawn\'s stale opts,\n' +
      ' and emits a false agent_install_finished{outcome:"agent_launched"}. A correct fix\n' +
      ' deletes the entry on the kill path; the control proves a real completed install must\n' +
      ' keep relaunching.)'
    );
  } else {
    console.log('No bug: killed installs no longer leak their pendingInstallRelaunch entry (fixed behaviour).');
  }
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => {
    for (const dir of Object.values(ROOTS)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ }
    }
    for (const dir of [CTL_CWD, INSTALL_CWD_1, INSTALL_CWD_2A, INSTALL_CWD_2B, UNRELATED_CWD, UNRELATED_CWD_2]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ }
    }
    process.exit(code);
  })
  .catch((e) => {
    console.error('\nrepro harness error (not a bug assertion):', e);
    process.exit(1);
  });

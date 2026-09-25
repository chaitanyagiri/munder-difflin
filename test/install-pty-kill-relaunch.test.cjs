'use strict';

/**
 * Killing a missing-CLI install PTY through the `pty:kill` IPC path (closing the
 * terminal tab) leaked its pendingInstallRelaunch entry, which a later session
 * reusing the same pty id could spuriously consume.
 *
 * The chain, all REAL code:
 *   1. spawnAgentCore's missing-CLI short-circuit runs the engine's installer in
 *      the agent's PTY and arms the auto restart-and-continue:
 *      pendingInstallRelaunch.set(opts.id, { opts, owner, bin, rung }).
 *   2. The PTY exit handler is the ONLY consumer: on a clean exit it deletes the
 *      entry, broadcasts pty:relaunch:<id> and re-runs spawnAgentCore with the
 *      STORED spawn opts.
 *   3. The `pty:kill` handler calls ptyManager.kill(id), which deletes the
 *      session SYNCHRONOUSLY — so when node-pty's async onExit for the killed
 *      installer later fires, it fails the session-identity guard
 *      (sessions.get(id) !== session) and is swallowed. The exit handler never
 *      runs, and teardownPty (which every kill site calls precisely because of
 *      that guard) never touched this map: the entry leaked for the process
 *      lifetime, one per cancelled install.
 *   4. Renderer pty ids are REUSED (restart/revive/restore re-spawn on a.ptyId),
 *      so a later UNRELATED session with the same id whose process exits 0
 *      found the stale entry and "completed" the cancelled install: a phantom
 *      pty:relaunch + spawnAgentCore re-run with the stale cwd/command, plus a
 *      bogus agent_install_finished{outcome:'agent_launched'}.
 *
 * The fix: teardownPty deletes the id's relaunch entry. The killed installer's
 * own onExit can never reach the exit handler (the identity guard guarantees
 * that), so the kill path is the only place the entry can be cleared — while a
 * NATURAL clean exit still consumes it first (handler runs, then teardown).
 *
 * Drives the REAL index.ts exit handler + ipcMain.handle('pty:spawn'/'pty:kill')
 * and the REAL pty.ts session/identity-guard logic; faked only at module
 * boundaries (electron, node-pty, command probes, network), the same stub
 * pattern as install-pty-signal-exit.test.cjs. app.whenReady() never resolves,
 * which keeps the whenReady-only boot block from running.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// Sandbox HOME before anything loads: config.ts writes settings via os.homedir(),
// and nothing in this test may touch the real ~/.claude.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-kill-relaunch-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

// The posthog keys are TS `declare const` in analytics.ts — define them so the
// REAL analytics singleton captures into the fake client instead of staying dark
// (the bogus agent_install_finished event is one of the observable failures).
globalThis.__POSTHOG_KEY__ = 'kill-relaunch-test-key';
globalThis.__POSTHOG_HOST__ = '';
delete process.env.DO_NOT_TRACK; // analytics must be live to catch the bogus event

// ─── module-boundary stubs (installed before any src/ module loads) ─────────

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-kill-relaunch-userdata-'));
const tmpDirs = [home, userData];
function tmpCwd(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `md-kill-relaunch-${name}-`));
  tmpDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ }
  }
});

const ipcHandlers = new Map(); // channel -> handler (real handlers recorded)
class MockWebContents {
  constructor() {
    this._destroyed = false;
    this.sent = []; // { channel, payload }
  }
  isDestroyed() { return this._destroyed; }
  send(channel, payload) { this.sent.push({ channel, payload }); }
}
class MockBrowserWindow {
  constructor() {
    this.webContents = new MockWebContents();
    this._destroyed = false;
  }
  isDestroyed() { return this._destroyed; }
  on() { return this; }
  once() { return this; }
  loadFile() { return Promise.resolve(); }
  loadURL() { return Promise.resolve(); }
  static getAllWindows() { return []; }
  static fromWebContents(wc) { return wc && wc.__owner ? wc.__owner : null; }
}

const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: {
    app: {
      on() {},
      // NEVER resolves: keeps the whenReady-only boot block (analytics.init,
      // auto-updater, servers, beat timers) from running. All wiring under test —
      // setExitHandler and the ipcMain.handle('pty:spawn'/'pty:kill')
      // registrations — happens at module LOAD.
      whenReady() { return new Promise(() => {}); },
      quit() {}, exit() {}, relaunch() {},
      requestSingleInstanceLock() { return true; },
      setAsDefaultProtocolClient() {},
      isPackaged: false,
      getAppPath() { return path.join(__dirname, '..'); },
      getPath() { return userData; },
      getVersion() { return '0.0.0-test'; }
    },
    BrowserWindow: MockBrowserWindow,
    ipcMain: {
      handle(channel, fn) { ipcHandlers.set(channel, fn); },
      on() {}
    },
    dialog: { showMessageBoxSync() { return 1; }, showOpenDialog() { return Promise.resolve({ canceled: true }); }, showErrorBox() {} },
    Menu: { buildFromTemplate() { return {}; }, setApplicationMenu() {} },
    Notification: function NotificationMock() { this.show = () => {}; },
    powerMonitor: { on() {} },
    powerSaveBlocker: { start() { return 1; }, stop() {}, isStarted() { return false; } },
    screen: { on() {}, getAllDisplays() { return []; }, getPrimaryDisplay() { return null; } },
    shell: { openExternal() { return Promise.resolve(); }, openPath() { return Promise.resolve(''); }, showItemInFolder() {} },
    clipboard: { writeText() {}, readText() { return ''; }, readImage() { return null; } }
  }
};

// node-pty stub: record spawns; kill() does NOT deliver onExit. This models the
// real timing the bug lives in — node-pty's exit callback is asynchronous, so
// PtyManager.kill() deletes the session BEFORE the callback fires and the
// identity guard swallows it. The test fires the late onExit by hand (fireExit),
// exactly when the real node-pty would.
const ptyRequirePath = require.resolve('node-pty');
const fakePtys = [];
class FakePty {
  constructor(_file, args, opt) {
    this.args = args;
    this.opt = opt;
    this.pid = 4400 + fakePtys.length;
    this.killed = false;
    this._exitCbs = [];
    fakePtys.push(this);
  }
  onData() {}
  onExit(cb) { this._exitCbs.push(cb); }
  write() {}
  resize() {}
  kill() { this.killed = true; } // no synchronous exit delivery — the async
  // onExit is what the test delivers by hand, as node-pty eventually does.
  fireExit(exitCode, signal) { for (const cb of [...this._exitCbs]) cb({ exitCode, signal }); }
}
require.cache[ptyRequirePath] = {
  id: ptyRequirePath, filename: ptyRequirePath, loaded: true,
  exports: { __esModule: true, spawn(file, args, opt) { return new FakePty(file, args, opt); } }
};

// posthog-node stub: capture into an array; never any network.
const capturedEvents = [];
const posthogPath = require.resolve('posthog-node');
class FakePostHog {
  capture(ev) { capturedEvents.push(ev); }
  async shutdown() {}
}
require.cache[posthogPath] = {
  id: posthogPath, filename: posthogPath, loaded: true, exports: { PostHog: FakePostHog }
};

// ─── load the REAL modules; patch only what must not touch the machine ──────

const analytics = loadTs('src/main/analytics.ts');
analytics.analytics.init({ stateDir: userData, appVersion: '0.0.0-test', enabled: true });

// index.ts arms module-level pollers at LOAD (e.g. RealtimeFloorWatcher's 5s
// interval; only the completion watcher unrefs its own). node:test waits for
// the loop to drain, so unref every interval armed from here on: they keep
// ticking while the test runs but cannot hold the process open afterwards.
const realSetInterval = global.setInterval;
global.setInterval = function (fn, ms, ...args) {
  const timer = realSetInterval(fn, ms, ...args);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
};

// pty.ts first, so its class exists to patch (and to capture the manager
// instance index.ts constructs internally — index.ts exports nothing).
const ptyModule = loadTs('src/main/pty.ts');
const RealPtyManager = ptyModule.PtyManager;
let managerInstance = null;
ptyModule.PtyManager = class CapturedPtyManager extends RealPtyManager {
  constructor(...args) {
    super(...args);
    managerInstance = this;
  }
};

// Command probes: the engine binary is MISSING (the missing-CLI scenario); npm
// and node resolve. Patched on the prototype so NO where/which/shell probe runs
// (this dev machine may actually have the engine installed; the patch models the
// machine the bug fires on).
const MISSING_BIN = 'definitely-missing-cli-xyz';
RealPtyManager.prototype.isCommandAvailable = function (command) {
  return command !== MISSING_BIN;
};
RealPtyManager.prototype.resolveCommand = function (command) {
  return { path: `/fake/bin/${command}`, found: true };
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

// procKill: record the sweep instead of running taskkill/ps against fake pids.
const procKill = loadTs('src/main/procKill.ts');
const ensuredKilledPids = [];
procKill.ensureKilled = function (pid) { ensuredKilledPids.push(pid); };
procKill.hardKillTree = function () {};

// The relaunch re-run calls ensureClaudePermissionsAccepted(opts.cwd), which
// would write the USER'S real ~/.claude — must be a no-op under the stub (HOME
// above is sandboxed as belt and braces).
const configModule = loadTs('src/main/config.ts');
configModule.ensureClaudePermissionsAccepted = function () {};

// Loading index.ts registers the REAL exit handler and the 'pty:spawn' /
// 'pty:kill' IPC handlers at module load.
loadTs('src/main/index.ts');

// ─── driving helpers ─────────────────────────────────────────────────────────

const ptySpawnHandler = ipcHandlers.get('pty:spawn');
const ptyKillHandler = ipcHandlers.get('pty:kill');

function ptysForCwd(cwd) {
  return fakePtys.filter((p) => p.opt && p.opt.cwd === cwd);
}
function sentTo(wc, channel) {
  return wc.sent.filter((m) => m.channel === channel);
}
function installFinishedEvents() {
  return capturedEvents.filter((e) => e.event === 'agent_install_finished');
}

/** Let pending microtasks/timers (a void spawnAgentCore re-run) settle. */
function flush() {
  return new Promise((resolve) => setImmediate(() => setTimeout(resolve, 25)));
}

/** A floor webContents wired the way BrowserWindow.fromWebContents resolves. */
function makeFloor() {
  const win = new MockBrowserWindow();
  const wc = win.webContents;
  wc.__owner = win;
  return { win, wc };
}

/** Spawn a missing-CLI install PTY through the REAL IPC handler. */
async function spawnInstall(id, cwd, wc) {
  const floor = wc ? { wc } : makeFloor();
  const res = await ptySpawnHandler(
    { sender: floor.wc },
    { id, cwd, command: MISSING_BIN, provider: 'claude', cols: 80, rows: 24 }
  );
  assert.equal(res.ok, true, `pty:spawn returned ${JSON.stringify(res)}`);
  const installPty = ptysForCwd(cwd)[0];
  assert.ok(installPty, 'no FakePty was created for the install cwd');
  assert.ok(String(installPty.args).includes('npm install -g @anthropic-ai/claude-code'),
    'the install PTY should be running the npm install rung');
  return { ...floor, installPty };
}

/** Spawn an ordinary (CLI present) agent session on a pty id, on a GIVEN floor
 *  when passed — the renderer restores/restarts an agent onto its SAME floor. */
async function spawnHealthy(id, cwd, wc) {
  const floor = wc ? { wc } : makeFloor();
  const res = await ptySpawnHandler(
    { sender: floor.wc },
    { id, cwd, command: 'claude', provider: 'claude', cols: 80, rows: 24 }
  );
  assert.equal(res.ok, true, `pty:spawn returned ${JSON.stringify(res)}`);
  const pty = ptysForCwd(cwd)[0];
  assert.ok(pty, 'no FakePty was created for the healthy cwd');
  return { ...floor, healthyPty: pty };
}

// ─── the tests ───────────────────────────────────────────────────────────────

test('CONTROL: an install that runs to a clean exit still consumes its entry and relaunches', async () => {
  const cwd = tmpCwd('ctl');
  const { wc, installPty } = await spawnInstall('kill-relaunch-ctl', cwd);

  installPty.fireExit(0, 0); // the installer finished cleanly
  await flush();

  // THE RELAUNCH MUST KEEP WORKING — a fix that refuses every relaunch would
  // break the auto restart-and-continue this whole map exists for.
  assert.equal(sentTo(wc, 'pty:relaunch:kill-relaunch-ctl').length, 1,
    `owner got: ${JSON.stringify(wc.sent.map((m) => m.channel))}`);
  assert.equal(ptysForCwd(cwd).length, 2, 'the relaunched agent PTY must exist');

  // The relaunched agent later exits cleanly too: the entry was consumed, so
  // nothing extra may spawn.
  ptysForCwd(cwd)[1].fireExit(0, 0);
  await flush();
  assert.equal(sentTo(wc, 'pty:relaunch:kill-relaunch-ctl').length, 1,
    'the entry must be consumed exactly once');
  assert.equal(ptysForCwd(cwd).length, 2, 'no phantom third PTY after consumption');
});

test('THE BUG: killing an install PTY via pty:kill must not leave its relaunch entry armed', async () => {
  const installCwd = tmpCwd('killed');
  const laterCwd = tmpCwd('reused');
  const { wc, installPty } = await spawnInstall('kill-relaunch-leak', installCwd);
  assert.ok(capturedEvents.some((e) => e.event === 'agent_install_started'),
    'agent_install_started should have been tracked when the entry was armed');

  // The user closes the terminal tab: the pty:kill IPC path.
  const killRes = ptyKillHandler(null, 'kill-relaunch-leak');
  assert.deepEqual(killRes, { ok: true }, `pty:kill returned ${JSON.stringify(killRes)}`);
  assert.equal(installPty.killed, true, 'the install PTY was not killed');
  assert.ok(ensuredKilledPids.includes(installPty.pid), 'kill did not run its ensureKilled sweep');
  assert.ok(!managerInstance.list().some((p) => p.id === 'kill-relaunch-leak'),
    'session still in the map — the leak below could not be demonstrated');

  // node-pty's ASYNC onExit for the killed installer now arrives — after kill()
  // already deleted the session, so the identity guard swallows it: the exit
  // handler NEVER runs for this PTY.
  installPty.fireExit(0, 0);
  await flush();
  assert.equal(sentTo(wc, 'pty:exit:kill-relaunch-leak').length, 0,
    'the identity guard should swallow the killed process\'s exit');
  assert.equal(sentTo(wc, 'pty:relaunch:kill-relaunch-leak').length, 0,
    'nothing may relaunch while the id is dead');

  // The renderer reuses the pty id (restart/revive/restore reuse a.ptyId): an
  // UNRELATED, perfectly healthy session is spawned with the SAME id, on the
  // same floor (an agent revived in its tab).
  const { healthyPty } = await spawnHealthy('kill-relaunch-leak', laterCwd, wc);
  assert.ok(managerInstance.list().some((p) => p.id === 'kill-relaunch-leak'),
    'the reused id is live');

  // That unrelated agent finishes and exits CLEANLY (exit 0). Its onExit PASSES
  // the identity guard — it must find NOTHING left to consume.
  const finishedBefore = installFinishedEvents().length;
  healthyPty.fireExit(0, 0);
  await flush();
  await flush();

  assert.equal(sentTo(wc, 'pty:exit:kill-relaunch-leak').length, 1,
    `pty:exit sends: ${JSON.stringify(sentTo(wc, 'pty:exit:kill-relaunch-leak'))}`);

  // THE REGRESSION: the unrelated clean exit must not be treated as a completed
  // install — no relaunch broadcast, no phantom re-run of the cancelled spawn's
  // stale opts, no bogus analytics event.
  assert.equal(sentTo(wc, 'pty:relaunch:kill-relaunch-leak').length, 0,
    'the UNRELATED session\'s clean exit consumed the CANCELLED install\'s stale ' +
    'pendingInstallRelaunch entry: pty:kill kills + tears down but never deletes ' +
    'the entry, and the killed installer\'s own onExit is swallowed by the ' +
    'session-identity guard, so the entry leaked until this exit fired ' +
    'pty:relaunch as if the install had just completed');
  assert.equal(ptysForCwd(installCwd).length, 1,
    `a phantom PTY re-ran the CANCELLED install's spawn opts (${ptysForCwd(installCwd).length} ` +
    'PTYs in the cancelled install\'s cwd): the exit handler re-ran ' +
    'spawnAgentCore({...pending.opts, noAutoInstall:true}) with the stale ' +
    'cwd/command of the spawn the user cancelled');
  assert.equal(installFinishedEvents().length, finishedBefore,
    `bogus analytics: agent_install_finished was emitted for the CANCELLED install — ` +
    `captured: ${JSON.stringify(installFinishedEvents().slice(finishedBefore))}. ` +
    'No install ran to completion; the event lies about the activation funnel.');
});

test('the leak does not accumulate: two more killed installs leave nothing for a later same-id exit', async () => {
  // Every cancelled install used to leave one more armed entry, each waiting to
  // hijack a future same-id clean exit. Both ids get their own throwaway cwds so
  // the PTYs can be told apart.
  const killed = [];
  for (const id of ['kill-relaunch-2a', 'kill-relaunch-2b']) {
    const cwd = tmpCwd(id);
    const { wc, installPty } = await spawnInstall(id, cwd);
    const kr = ptyKillHandler(null, id);
    assert.deepEqual(kr, { ok: true }, `pty:kill for ${id} returned ${JSON.stringify(kr)}`);
    assert.equal(installPty.killed, true, `${id} was not killed`);
    ptysForCwd(cwd)[0].fireExit(0, 0); // killed installer's late onExit — swallowed
    await flush();
    killed.push({ id, cwd, wc });
  }
  assert.ok(killed.every((k) => sentTo(k.wc, `pty:relaunch:${k.id}`).length === 0),
    'precondition: no cancelled install may relaunch while its id is dead');

  // Later, the renderer reuses BOTH ids for unrelated healthy sessions (same
  // floors — restore/revive re-spawn on the agent's existing a.ptyId).
  const reused = [];
  for (const { id, wc } of killed) {
    const cwd = tmpCwd(`${id}-later`);
    const { healthyPty } = await spawnHealthy(id, cwd, wc);
    reused.push({ id, cwd, wc, healthyPty });
  }
  const finishedBefore = installFinishedEvents().length;
  for (const { healthyPty } of reused) {
    healthyPty.fireExit(0, 0); // the unrelated session exits cleanly
    await flush();
  }

  for (const { id, cwd, wc } of reused) {
    assert.equal(sentTo(wc, `pty:relaunch:${id}`).length, 0,
      `${id}: a stale relaunch fired for a CANCELLED install — every pty:kill of an ` +
      'install PTY must drop its pendingInstallRelaunch entry, or the map grows one ' +
      'stale entry per cancelled install, each hijacking a later same-id exit');
    assert.equal(ptysForCwd(cwd).length, 1,
      `${id}: a phantom PTY re-ran the cancelled install's spawn opts`);
  }
  assert.equal(installFinishedEvents().length, finishedBefore,
    `bogus agent_install_finished events for cancelled installs: ` +
    `${JSON.stringify(installFinishedEvents().slice(finishedBefore))}`);
});

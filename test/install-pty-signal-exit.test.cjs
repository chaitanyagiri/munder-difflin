'use strict';

/**
 * The install-relaunch exit handler read a SIGNALED death as a clean install.
 *
 * node-pty reports a signal death on POSIX as {exitCode: 0, signal: N} — its
 * ExitEvent is zero-initialised and `exit_code` is set only under WIFEXITED,
 * so a WIFSIGNALED death leaves the code at 0 and carries the signal instead
 * (src/unix/pty.cc). The install-PTY exit handler in src/main/index.ts gated
 * the missing-CLI auto restart-and-continue on `exitCode === 0` alone, and
 * PtyManager.killByOwner — the floor-window 'closed' path — kills WITHOUT
 * deleting the session, so the dying onExit passes the identity guard in
 * pty.ts and REACHES the handler. Closing a floor mid-install therefore
 * "completed" the install: pendingInstallRelaunch was consumed, `pty:relaunch`
 * was broadcast into the window the user just closed, and spawnAgentCore
 * re-ran a duplicate attempt — plus a false agent_launched analytics event —
 * though no install ever happened.
 *
 * The rule the handler was missing is the one hive.recordAgentExit already
 * documents and applies: a signal must be checked independently of the code.
 *
 * Drives the REAL index.ts exit handler and the REAL PtyManager; faked only
 * at module boundaries (electron, node-pty, command probes, network), the
 * same stub pattern as config-write-notify.test.cjs. app.whenReady() never
 * resolves, which is exactly what keeps the whenReady-only boot block
 * (analytics, model catalog, updaters, beat timers) from running.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// The posthog keys are TS `declare const` in analytics.ts — define them
// defensively so even an accidental analytics.init() cannot ReferenceError.
globalThis.__POSTHOG_KEY__ = '';
globalThis.__POSTHOG_HOST__ = '';

// ─── module-boundary stubs (installed before any src/ module loads) ─────────

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-install-signal-'));
test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

const ipcHandlers = new Map(); // channel -> handler
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
      // NEVER resolves: keeps the whenReady-only boot block from running. All
      // wiring under test (setExitHandler, ipcMain.handle('pty:spawn')) happens
      // at module LOAD, not in whenReady.
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
    dialog: { showMessageBoxSync() { return 1; }, showOpenDialog() { return Promise.resolve({ canceled: true }); } },
    Menu: { buildFromTemplate() { return {}; }, setApplicationMenu() {} },
    Notification: function NotificationMock() { this.show = () => {}; },
    powerMonitor: { on() {} },
    powerSaveBlocker: { start() { return 1; }, stop() {}, isStarted() { return false; } },
    screen: { on() {}, getAllDisplays() { return []; }, getPrimaryDisplay() { return null; } },
    shell: { openExternal() { return Promise.resolve(); }, openPath() { return Promise.resolve(''); }, showItemInFolder() {} },
    clipboard: { writeText() {}, readText() { return ''; }, readImage() { return null; } }
  }
};

// node-pty stub: FakePty.fireExit models the POSIX ExitEvent semantics — a
// signaled death MUST be delivered as {exitCode: 0, signal: N} (the zero-init
// shape), because that is the exact input the handler misread.
const ptyRequirePath = require.resolve('node-pty');
const fakePtys = [];
class FakePty {
  constructor(_file, args, opt) {
    this.args = args;
    this.opt = opt;
    this.pid = 1000 + fakePtys.length;
    this.killed = false;
    this._exitCbs = [];
    fakePtys.push(this);
  }
  onData() {}
  onExit(cb) { this._exitCbs.push(cb); }
  write() {}
  resize() {}
  kill() { this.killed = true; }
  fireExit(exitCode, signal) { for (const cb of [...this._exitCbs]) cb({ exitCode, signal }); }
}
require.cache[ptyRequirePath] = {
  id: ptyRequirePath, filename: ptyRequirePath, loaded: true,
  exports: { __esModule: true, spawn(file, args, opt) { return new FakePty(file, args, opt); } }
};

// ─── load pty.ts + index.ts ─────────────────────────────────────────────────

// index.ts arms module-level pollers at LOAD (e.g. RealtimeFloorWatcher's 5s
// interval; only the completion watcher unrefs its timer). Under the repro this
// didn't matter because it ends with process.exit — node:test instead waits
// for the loop to drain, so unref every interval armed from here on: they keep
// ticking while the test runs but cannot hold the process open afterwards.
const realSetInterval = global.setInterval;
global.setInterval = function (fn, ms, ...args) {
  const timer = realSetInterval(fn, ms, ...args);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
};

// Load pty.ts first so its class exists to patch (and to capture the manager
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

// Command probes: the engine CLI 'claude' is missing (the missing-CLI
// scenario); npm/node resolve. Patched on the prototype so no shell probe runs.
RealPtyManager.prototype.isCommandAvailable = function (command) {
  return command === 'npm' || command === 'node';
};
RealPtyManager.prototype.resolveCommand = function (command) {
  return { path: `/fake/bin/${command}`, found: true };
};

// shellEnv: keep spawn() off the interactive login shell (POSIX only).
const shellEnv = loadTs('src/main/shellEnv.ts');
shellEnv.userShellPath = () => process.env.PATH || '/usr/bin:/bin';

// nodeInstall: node usable → npm rung; resolveNodeInstaller must never hit
// nodejs.org (it isn't reached while npm is available anyway).
const nodeInstall = loadTs('src/main/nodeInstall.ts');
nodeInstall.detectNodeVersion = () => 'v22.11.0';
nodeInstall.nodeIsUsable = () => true;
nodeInstall.resolveNodeInstaller = async () => null;

// procKill: record the sweep instead of running ps/taskkill timers.
const procKill = loadTs('src/main/procKill.ts');
const ensuredKilledPids = [];
procKill.ensureKilled = function (pid) { ensuredKilledPids.push(pid); };
procKill.hardKillTree = function () {};

// The relaunch re-run calls ensureClaudePermissionsAccepted(opts.cwd), which
// would write the USER'S real ~/.claude — must be a no-op under the stub.
const configModule = loadTs('src/main/config.ts');
configModule.ensureClaudePermissionsAccepted = function () {};

// Loading index.ts registers the exit handler and the 'pty:spawn' IPC handler.
loadTs('src/main/index.ts');

// ─── driving helpers ─────────────────────────────────────────────────────────

const ptySpawnHandler = ipcHandlers.get('pty:spawn');

/** Let pending microtasks/timers (the void spawnAgentCore re-run) settle. */
function flush() {
  return new Promise((resolve) => setImmediate(() => setTimeout(resolve, 25)));
}

function sentTo(wc, channel) {
  return wc.sent.filter((m) => m.channel === channel);
}

/** Spawn a missing-CLI install PTY through the REAL IPC handler and return
 *  { wc, installPty } — the owner's webContents and its FakePty. */
async function spawnInstallPty(id) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `md-install-signal-${id}-`));
  const win = new MockBrowserWindow();
  const wc = win.webContents;
  wc.__owner = win;
  const res = await ptySpawnHandler(
    { sender: wc },
    { id, cwd, command: 'claude', provider: 'claude', cols: 80, rows: 24 }
  );
  assert.equal(res.ok, true, `pty:spawn returned ${JSON.stringify(res)}`);
  const installPty = fakePtys.find((p) => p.opt.cwd === cwd);
  assert.ok(installPty, 'no FakePty was created for the install cwd');
  assert.ok(String(installPty.args).includes('npm install -g @anthropic-ai/claude-code'),
    'the install PTY should be running the npm install rung');
  return { win, wc, installPty, cwd };
}

// ─── the tests ───────────────────────────────────────────────────────────────

test('CONTROL: a clean installer exit still auto-relaunches into the same window', async () => {
  const { wc, installPty, cwd } = await spawnInstallPty('install-signal-ctl');

  assert.ok(managerInstance.list().some((p) => p.id === 'install-signal-ctl'),
    'the install PTY session must be live before its exit');

  installPty.fireExit(0, 0); // what a successful install looks like on POSIX
  await flush();

  assert.equal(sentTo(wc, 'pty:relaunch:install-signal-ctl').length, 1,
    `owner got: ${JSON.stringify(wc.sent.map((m) => m.channel))}`);
  assert.equal(fakePtys.filter((p) => p.opt.cwd === cwd).length, 2,
    'a clean install must re-run spawnAgentCore (second spawn for the id)');
});

test('a SIGHUP-killed installer (floor closed via killByOwner) must not relaunch or re-spawn', async () => {
  const { wc, installPty, cwd } = await spawnInstallPty('install-signal-hup');

  // The user closes the floor window → index.ts killByOwner(wc). It must kill
  // the process but LEAVE THE SESSION IN PLACE — that is exactly why the dying
  // onExit passes the identity guard in pty.ts and reaches the exit handler.
  managerInstance.killByOwner(wc);
  assert.equal(installPty.killed, true, 'killByOwner did not kill the install PTY');
  assert.ok(ensuredKilledPids.includes(installPty.pid), 'killByOwner did not run its ensureKilled sweep');
  assert.ok(managerInstance.list().some((p) => p.id === 'install-signal-hup'),
    'killByOwner deleted the session — onExit would be identity-guarded away and this scenario could not occur');

  // node-pty's async onExit delivers the POSIX signaled-death shape.
  installPty.fireExit(0, 1); // SIGHUP
  await flush();
  await flush();

  // The renderer is told the truth about the death — including the signal.
  const exits = sentTo(wc, 'pty:exit:install-signal-hup');
  assert.equal(exits.length, 1, `pty:exit sends: ${JSON.stringify(exits)}`);
  assert.deepEqual(exits[0].payload, { exitCode: 0, signal: 1 });

  // THE REGRESSION: a signaled install death must NOT be consumed as a clean
  // install success — no relaunch broadcast, no duplicate agent attempt.
  assert.equal(sentTo(wc, 'pty:relaunch:install-signal-hup').length, 0,
    'a SIGNALED installer death (exitCode 0, signal 1/SIGHUP) was treated as a clean ' +
    'install success: the exit handler never checks info.signal, so it broadcast ' +
    'pty:relaunch into the window the user just closed');
  assert.equal(fakePtys.filter((p) => p.opt.cwd === cwd).length, 1,
    'spawnAgentCore re-ran after a signaled installer death — a duplicate agent attempt ' +
    'keyed off an install that never finished');
});

test('a failed install (non-zero exit) still reports honestly and does not relaunch', async () => {
  const { wc, installPty, cwd } = await spawnInstallPty('install-signal-fail');

  installPty.fireExit(1, 0); // the installer could not finish unattended
  await flush();

  assert.equal(sentTo(wc, 'pty:relaunch:install-signal-fail').length, 0,
    'a failed install must leave its manual-fix message, not relaunch');
  assert.equal(fakePtys.filter((p) => p.opt.cwd === cwd).length, 1,
    'a failed install must not spawn a duplicate agent attempt');
});

'use strict';

// Repro for: the install-relaunch exit handler reads a SIGNALED death
// (exitCode 0 + non-zero signal) as a clean install success, because
// killByOwner leaves the session in place.
//
// src/main/index.ts:586-623 — the PTY exit handler arms the missing-CLI
// "auto restart-and-continue": when an install PTY exits, the handler looks up
// pendingInstallRelaunch (armed at index.ts:2678 by the missing-CLI branch of
// spawnAgentCore) and, at index.ts:609, gates the relaunch on:
//
//     if (exitCode === 0) {   // ← signal is never checked
//       ...
//       wc.send(`pty:relaunch:${id}`);
//       void spawnAgentCore({ ...pending.opts, noAutoInstall: true }, pending.owner);
//       return;
//     }
//
// But node-pty reports a SIGNAL death as {exitCode: 0, signal: N} on POSIX:
// node_modules/node-pty/src/unix/pty.cc:110 zero-initialises ExitEvent and sets
// exit_code ONLY under WIFEXITED (pty.cc:189-190); WIFSIGNALED sets
// signal_code (pty.cc:192-193). A process killed by a signal therefore reaches
// JS with exitCode 0 and a non-zero signal. The repo knows this:
// src/main/hive.ts:2561-2571 (recordAgentExit) documents "node-pty reports
// exitCode 0 in that case, so signal must be checked independently of the
// code" — and checks `signal !== 0` for abnormal. This handler does not.
//
// Why the handler even SEES that exit: PtyManager.kill() (src/main/pty.ts:778)
// deletes the session synchronously, so the dying process's onExit fails the
// identity guard (`sessions.get(id) !== session`, pty.ts:714) and is dropped.
// But killByOwner (pty.ts:353-364 — the floor-window 'closed' path,
// index.ts:2438) kills WITHOUT deleting the session: the onExit passes the
// guard, emits `pty:exit`, and reaches the handler.
//
// FAILURE SCENARIO (reproduced below): a missing-CLI install PTY is running in
// a floor window, pendingInstallRelaunch armed. The user closes the floor →
// killByOwner SIGHUPs the installer shell (POSIX `$SHELL -lc` wrapper,
// pty.ts:612-613). node-pty delivers {exitCode: 0, signal: 1}. The handler
// reads exitCode 0 as a completed install: pendingInstallRelaunch is consumed,
// `pty:relaunch:<id>` is broadcast into the window the user just closed, and
// spawnAgentCore re-runs a duplicate agent attempt — plus a false
// 'agent_launched' analytics event — though no install ever happened.
//
// Deterministic, offline, no real PTY/claude/npm: the REAL PtyManager.spawn /
// onExit / killByOwner (src/main/pty.ts) and the REAL exit handler
// (src/main/index.ts) run; faked only at module boundaries:
//   - electron       → stub (no display; app.whenReady never resolves, so no
//                      analytics/network boot), ipcMain.handle recorded so the
//                      repro can drive the real 'pty:spawn' IPC handler;
//   - node-pty.spawn → FakePty whose fireExit models the vendored POSIX
//                      ExitEvent semantics above (kill() = SIGHUP-then-exit);
//   - command probes (isCommandAvailable/resolveCommand/commandPath) →
//     'claude' missing, npm/node present, so the npm install rung arms;
//   - nodeInstall.ts (cached exports) → node usable, resolveNodeInstaller
//     never hits the network (npm rung short-circuits it anyway);
//   - procKill.ensureKilled → recorded, not executed (no ps/taskkill);
//   - config.ensureClaudePermissionsAccepted → no-op (would write the real
//     ~/.claude).
//
// FAILS on current code: the signaled death is consumed, `pty:relaunch:<id>`
// is sent to the closed window and a second spawn runs. PASSES after a correct
// fix (the handler must also require the absence of a non-zero signal — the
// clean-exit CONTROL below pins that a real clean exit still relaunches).
// Run: node test/repro/bug-7.repro.cjs

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const loadTs = require(path.join(__dirname, '..', 'load-ts.cjs'));

// ─── 0. Module-boundary stubs (installed before any src/ module loads) ──────

const ROOTS = { userData: fs.mkdtempSync(path.join(os.tmpdir(), 'md-bug7-userdata-')) };
const CTL_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'md-bug7-ctl-'));
const BUG_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'md-bug7-floor-'));

// The posthog keys are TS `declare const` (analytics.ts:41-42) — define them
// defensively so even an accidental analytics.init() cannot ReferenceError.
globalThis.__POSTHOG_KEY__ = '';
globalThis.__POSTHOG_HOST__ = '';

// --- electron stub: no Electron, no display. Same pattern as
// test/config-write-notify.test.cjs / test/repro/bug-17.repro.cjs, plus a
// RECORDING ipcMain so the repro can invoke the real 'pty:spawn' handler, and
// an app.whenReady() that never resolves so the whenReady-only boot block
// (analytics.init, model catalog, auto-updater, servers) never runs.
const ipcHandlers = new Map(); // channel -> handler
const ipcEvents = [];
class MockWebContents {
  constructor(label) {
    this.__label = label;
    this._destroyed = false;
    this.sent = []; // { channel, payload }
  }
  isDestroyed() { return this._destroyed; }
  send(channel, payload) { this.sent.push({ channel, payload }); }
  destroy() { this._destroyed = true; }
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
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      _listeners: {},
      on(ev, fn) { (this._listeners[ev] ??= []).push(fn); return this; },
      // NEVER resolves: keeps the whenReady block (analytics.init,
      // loadModelCatalog, initAutoUpdater, servers) from running. All bug
      // wiring (setExitHandler index.ts:586, ipcMain.handle('pty:spawn')
      // index.ts:2585) happens at module LOAD, not in whenReady.
      whenReady() { return new Promise(() => {}); },
      quit() {}, exit() {}, relaunch() {},
      requestSingleInstanceLock() { return true; },
      setAsDefaultProtocolClient() {},
      setLoginItemSettings() {}, getLoginItemSettings() { return {}; },
      isPackaged: false,
      getAppPath() { return path.join(__dirname, '..', '..'); },
      getPath(name) { return ROOTS.userData; },
      getVersion() { return '0.0.0-repro'; }
    },
    BrowserWindow: MockBrowserWindow,
    ipcMain: {
      handle(channel, fn) { ipcHandlers.set(channel, fn); },
      on(_ch, _fn) { ipcEvents.push(_ch); }
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

// --- node-pty stub: record spawns; deliver exits with POSIX semantics. ------
//
// node-pty 1.1.0 POSIX exit shape (the thing being modelled):
//   src/unix/pty.cc:110  struct ExitEvent { int exit_code = 0; int signal_code = 0; }  (zero-init)
//   src/unix/pty.cc:189  if (WIFEXITED(...))  exit_event->exit_code = WEXITSTATUS(...)
//   src/unix/pty.cc:192  if (WIFSIGNALED(...)) exit_event->signal_code = WTERMSIG(...)
//   lib/terminal.js:93   this.on('exit', (exitCode, signal) => fire({exitCode, signal}))
// → a clean exit is {exitCode: N, signal: 0}; a signaled death is
//   {exitCode: 0, signal: N} — and killByOwner's SIGHUP death is the latter.
const ptyRequirePath = require.resolve('node-pty');
const fakePtys = [];
let fakePtySeq = 4242;
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
  // node-pty's kill: closes the master fd → SIGHUP to the foreground group.
  kill() { this.killed = true; }
  /** Model the async waitpid → ExitEvent → JS onExit delivery with an exact
   *  POSIX exit shape. exitCode must be 0 for a signaled death (pty.cc leaves
   *  exit_code at its zero-init when only WIFSIGNALED holds). */
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

// ─── load the REAL modules and patch only what must not touch the machine ──

// 1) pty.ts first, so its class exists to patch before index.ts news it up.
const ptyModule = loadTs('src/main/pty.ts');
const { PtyManager } = ptyModule;

// index.ts constructs its own `ptyManager` internally (index.ts:111) and
// exports nothing — capture that exact instance (the one whose exit handler is
// the buggy one) by wrapping the constructor while index.ts loads.
let managerInstance = null;
const RealPtyManager = ptyModule.PtyManager;
ptyModule.PtyManager = class CapturedPtyManager extends RealPtyManager {
  constructor(...args) {
    super(...args);
    managerInstance = this;
  }
};

// 2) Command probes: 'claude' is missing (the missing-CLI scenario), npm/node
//    resolve. Patched on the prototype so NO where/which/shell probe runs.
PtyManager.prototype.isCommandAvailable = function (command) {
  return command === 'npm' || command === 'node';
};
PtyManager.prototype.resolveCommand = function (command) {
  const fake = process.platform === 'win32'
    ? `C:\\fake\\bin\\${command}.exe`
    : `/fake/bin/${command}`;
  return { path: fake, found: true };
};

// 3) shellEnv: keep spawn() off the interactive login shell (POSIX only).
const shellEnv = loadTs('src/main/shellEnv.ts');
shellEnv.userShellPath = () => process.env.PATH || '/usr/bin:/bin';

// 4) nodeInstall: node is usable (npm rung), and resolveNodeInstaller must
//    never hit nodejs.org (it isn't reached anyway while npmAvailable=true).
const nodeInstall = loadTs('src/main/nodeInstall.ts');
nodeInstall.detectNodeVersion = () => 'v22.11.0';
nodeInstall.nodeIsUsable = () => true;
nodeInstall.resolveNodeInstaller = async () => null;

// 5) procKill: record ensureKilled instead of running ps/taskkill timers.
const procKill = loadTs('src/main/procKill.ts');
const ensuredKilledPids = [];
procKill.ensureKilled = function (pid) { ensuredKilledPids.push(pid); };
procKill.hardKillTree = function () {};

// 6) config: the relaunch re-run calls ensureClaudePermissionsAccepted(opts.cwd)
//    (index.ts:2929) — that writes the USER'S REAL ~/.claude settings, so it
//    must be a no-op here. Everything else in config.ts is real.
const configModule = loadTs('src/main/config.ts');
configModule.ensureClaudePermissionsAccepted = function () {};

// 7) index.ts: registers the buggy exit handler (line 586) and the real
//    'pty:spawn' IPC handler (line 2585) at module load.
console.log('[setup] loading src/main/index.ts (real PtyManager + real exit handler)');
loadTs('src/main/index.ts');

// ─── drive the scenario through the real IPC + exit-handler code ───────────

function flush() {
  return new Promise((resolve) => setImmediate(() => setTimeout(resolve, 25)));
}
function sentTo(wc, channel) {
  return wc.sent.filter((m) => m.channel === channel);
}

async function main() {
  const results = [];
  const check = (name, fn) => {
    try { fn(); results.push({ name, ok: true }); console.log(`  ok   - ${name}`); }
    catch (e) { results.push({ name, ok: false, error: e }); console.log(`  FAIL - ${name}\n         ${e.message}`); }
  };

  const ptySpawnHandler = ipcHandlers.get('pty:spawn');
  if (!ptySpawnHandler) throw new Error('ipcMain.handle("pty:spawn") was never registered — harness broken');

  // ── CONTROL: a genuinely clean installer exit must relaunch (both before and
  // after a correct fix). This proves the harness arms the real
  // pendingInstallRelaunch machinery and that only the SIGNAL is what the bug
  // misreads.
  console.log('\n[control] missing-CLI install PTY, then a CLEAN exit {exitCode: 0, signal: 0}');
  const winCtl = new MockBrowserWindow();
  const wcCtl = new MockWebContents('control-floor');
  wcCtl.__owner = winCtl;
  winCtl.webContents = wcCtl;
  const ctlRes = await ptySpawnHandler(
    { sender: wcCtl },
    { id: 'bug7-ctl', cwd: CTL_CWD, command: 'claude', provider: 'claude', cols: 80, rows: 24 }
  );
  const ctlInstallPty = fakePtys.find((p) => p.opt.cwd === CTL_CWD);
  check('control: install PTY spawned for the missing claude CLI', () => {
    assert.equal(ctlRes.ok, true, `pty:spawn returned ${JSON.stringify(ctlRes)}`);
    assert.ok(ctlInstallPty, 'no FakePty was created for the control cwd');
    assert.ok(String(ctlInstallPty.args).includes('npm install -g @anthropic-ai/claude-code'),
      'the install PTY should be running the npm install rung');
  });
  check('control precondition: exactly one pty on record for the control id', () => {
    assert.ok(managerInstance.list().some((p) => p.id === 'bug7-ctl'));
  });
  ctlInstallPty.fireExit(0, 0); // clean finish — what a successful install looks like
  await flush();
  check('control: clean exit relaunches — pty:relaunch sent to the owning floor', () => {
    assert.equal(sentTo(wcCtl, 'pty:relaunch:bug7-ctl').length, 1,
      `owner got: ${JSON.stringify(wcCtl.sent.map((m) => m.channel))}`);
  });
  check('control: clean exit re-runs spawnAgentCore (second spawn for the id)', () => {
    assert.equal(fakePtys.filter((p) => p.opt.cwd === CTL_CWD).length, 2);
  });

  // ── THE BUG: same setup, but the installer is SIGHUP'd — the user closes
  // the floor window (killByOwner) and node-pty reports the signaled death the
  // POSIX way: {exitCode: 0, signal: 1}.
  console.log('\n[bug] missing-CLI install PTY, floor closed (killByOwner), signaled death {exitCode: 0, signal: 1}');
  const winBug = new MockBrowserWindow();
  const wcBug = new MockWebContents('bug-floor');
  wcBug.__owner = winBug;
  winBug.webContents = wcBug;
  const bugRes = await ptySpawnHandler(
    { sender: wcBug },
    { id: 'bug7-install', cwd: BUG_CWD, command: 'claude', provider: 'claude', cols: 80, rows: 24 }
  );
  const installPty = fakePtys.find((p) => p.opt.cwd === BUG_CWD);
  check('bug precondition: install PTY running and pendingInstallRelaunch armed', () => {
    assert.equal(bugRes.ok, true, `pty:spawn returned ${JSON.stringify(bugRes)}`);
    assert.ok(installPty, 'no FakePty for the bug cwd');
    assert.equal(fakePtys.filter((p) => p.opt.cwd === BUG_CWD).length, 1);
    assert.ok(managerInstance.list().some((p) => p.id === 'bug7-1' || p.id === 'bug7-install'));
  });

  // The user closes the floor: index.ts:2438 → ptyManager.killByOwner(wc).
  // killByOwner must kill the process but LEAVE THE SESSION IN PLACE — that is
  // exactly why the dying onExit passes the identity guard (pty.ts:714).
  managerInstance.killByOwner(wcBug);
  check('mechanism: killByOwner killed the install PTY but left its session in the map', () => {
    assert.equal(installPty.killed, true, 'killByOwner did not kill the PTY');
    assert.ok(ensuredKilledPids.includes(installPty.pid), 'killByOwner did not run its ensureKilled sweep');
    assert.ok(
      managerInstance.list().some((p) => p.id === 'bug7-install'),
      'killByOwner deleted the session — onExit would be identity-guarded away and the bug below could not fire'
    );
  });

  // node-pty's async onExit now delivers the POSIX signaled-death shape:
  // WIFSIGNALED, WTERMSIG = 1 (SIGHUP) → {exitCode: 0, signal: 1}.
  installPty.fireExit(0, 1);
  await flush();
  await flush();

  check('mechanism: the renderer saw the signaled death shape {exitCode: 0, signal: 1}', () => {
    const exits = sentTo(wcBug, 'pty:exit:bug7-install');
    assert.equal(exits.length, 1, `pty:exit sends: ${JSON.stringify(exits)}`);
    assert.deepEqual(exits[0].payload, { exitCode: 0, signal: 1 });
  });

  // THE BUG, assertion 1: a signaled install death is consumed as a clean
  // install success and `pty:relaunch:<id>` is broadcast into the floor the
  // user just closed.
  check('BUG: SIGHUP-killed installer is consumed as a clean install — no pty:relaunch may be sent', () => {
    const relaunches = sentTo(wcBug, 'pty:relaunch:bug7-install');
    assert.equal(relaunches.length, 0,
      'a SIGNALED installer death (exitCode 0, signal 1/SIGHUP) was treated as a clean install ' +
      'success: the exit handler (index.ts:609 `if (exitCode === 0)`) never checks info.signal, ' +
      'so it broadcast pty:relaunch and re-ran spawnAgentCore although no install happened');
  });

  // THE BUG, assertion 2: spawnAgentCore re-ran — a duplicate agent attempt
  // spawned into the closed floor, keyed off an install that never finished.
  check('BUG: the killed install must not spawn a duplicate agent attempt', () => {
    const spawns = fakePtys.filter((p) => p.opt.cwd === BUG_CWD).length;
    assert.equal(spawns, 1,
      `spawnAgentCore re-ran after a signaled installer death (${spawns} spawns for id bug7-install): ` +
      'the relaunch branch consumed pendingInstallRelaunch and spawned the agent attempt into a window that no longer exists');
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} assertions hold.`);
  if (failed.length > 0) {
    console.log('\nBUG REPRODUCED — failing assertions:');
    for (const f of failed) console.log(` - ${f.name}\n   ${f.error.message}`);
    console.log(
      '\n(The install-relaunch exit handler at src/main/index.ts:609 reads a signaled death —\n' +
      ' node-pty POSIX shape {exitCode: 0, signal: N}, see node-pty src/unix/pty.cc:189-193 —\n' +
      ' as a clean install success because killByOwner (src/main/pty.ts:353-364) leaves the\n' +
      ' session in place, so the dying onExit passes the identity guard at pty.ts:714.)'
    );
  } else {
    console.log('No bug: the signaled install death was treated as abnormal (fixed behaviour).');
  }
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => {
    try { fs.rmSync(ROOTS.userData, { recursive: true, force: true }); } catch { /* tmp */ }
    process.exit(code);
  })
  .catch((e) => {
    console.error('\nrepro harness error (not a bug assertion):', e);
    try { fs.rmSync(ROOTS.userData, { recursive: true, force: true }); } catch { /* tmp */ }
    process.exit(1);
  });

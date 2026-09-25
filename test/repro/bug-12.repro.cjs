'use strict';

// Repro for: postSlackReply and downloadSlackFile have no socket timeout, so a
// stalled Slack connection permanently wedges the done-summary poller and hangs
// replies (src/main/slack.ts:353-394, src/main/index.ts:1468-1532).
//
// CLAIM
//   postSlackReply issues a raw node:https POST to slack.com with NO timeout:
//   no `timeout` request option, no req.setTimeout, no socket timeout. Node has
//   no default timeout for an in-flight request, so if slack.com accepts the
//   TCP/TLS connection but never responds (stalled middlebox, hung proxy,
//   network partition after handshake), neither 'end' nor 'error' ever fires
//   and the returned promise NEVER SETTLES.
//
//   Callers await it with no race:
//     (a) pollSlackDoneTasks (src/main/index.ts:1585-1642) sets
//         slackDonePolling = true (1605), awaits postSlackReply (1619), and
//         resets the flag only in the finally (1640). A never-settling promise
//         wedges the 5s done-summary poller for the PROCESS LIFETIME: every
//         later tick returns at the `if (slackDonePolling) return` guard
//         (1586). stopSlackDoneObserver/startSlackDoneObserver never touch the
//         flag, so even Stop→Start in Settings keeps the wedge — only an app
//         restart clears it.
//     (b) the SlackReplyServer /reply handler (slack.ts:482) awaits
//         postSlackReply directly, so an agent's direct reply never resolves.
//     (c) downloadSlackFile (src/main/index.ts:1468-1532) has the same missing
//         timeout and is awaited inside onMessage (index.ts:1675) — AFTER
//         slack.ts already sent the unconditional 200 ack (slack.ts:277-278) —
//         so an inbound message with an attachment is acknowledged and then
//         silently dropped.
//   The transient-error path the code designed for ("will retry",
//   index.ts:1633-1637) never runs: a stall produces no error at all.
//
// CONTRAST: src/main/fetchText.ts:32 sets req.setTimeout — the omission is an
// inconsistency, not a design choice.
//
// WHAT THIS REPRO DOES (deterministic, offline, no real Slack, no display)
//   Everything real except the network peer:
//     - the REAL postSlackReply / SlackWebhookServer / SlackReplyServer from
//       src/main/slack.ts and the REAL pollSlackDoneTasks + downloadSlackFile +
//       'slack:start'/'slack:stop' IPC handlers from src/main/index.ts, loaded
//       through test/load-ts.cjs (the repo's own test loader);
//     - electron → a stub; node-pty → a stub; better-sqlite3 → a stub (its
//       Electron-ABI binding cannot load in plain Node); tunnelmole → a stub
//       (no network). app.whenReady never resolves, so the whenReady-only boot
//       block stays out; everything the bug needs registers at module load.
//     - slack.com / files.slack.com → a LOCAL TLS server that completes the
//       handshake, reads the request, then sends NOTHING (no response, no FIN,
//       no RST) — exactly the stalled-connection scenario. A tiny https.request
//       shim redirects the hostname while leaving the request untouched. The
//       embedded self-signed cert (CN=slack.com, SAN slack.com /
//       files.slack.com / 127.0.0.1, valid to 2036) needs no openssl at runtime.
//     - a live floor window (mock) so liveWebContents() resolves and the real
//       onMessage path can be observed forwarding to the renderer.
//
//   The poller is driven through the REAL public entry point: the 'slack:start'
//   IPC handler → startSlackServer → startSlackDoneObserver's 5s timer, with a
//   real HiveManager over a throwaway harnessHome. A RESPONDING-slack.com
//   control proves the harness delivers the summary when Slack answers; the
//   stall sections then show what a held connection does instead.
//
// CHECKS (all phrased as the DESIRED behavior, so the suite FAILS on the
// current code and PASSES once the promise can settle — e.g. after adding a
// request/socket timeout like fetchText.ts has):
//   1. control: a done card is reported to a responding slack.com.
//   2. postSlackReply SETTLES against a stalled connection.
//   3. the 5s poller KEEPS POLLING after a stalled attempt (the finally ran).
//   4. Stop→Start in Settings RE-ARMS the observer after a stall.
//   5. the loopback /reply endpoint ANSWERS the in-flight request.
//   6. an acked inbound file message is STILL FORWARDED when the download
//      stalls.
//
// Run: node test/repro/bug-12.repro.cjs   (~2 min: real 5s poller cadence)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const tls = require('node:tls');
const { createHmac } = require('node:crypto');

const REPO = path.resolve(__dirname, '..', '..');
const loadTs = require(path.join(REPO, 'test', 'load-ts.cjs'));

// Deadlines. Generous on purpose: a correct fix may use any sane timeout
// (fetchText.ts uses 12s) — every deadline must clear the fix's timeout plus
// the poller's 5s cadence. On the buggy code NOTHING ever settles, so the
// deadlines only cost wall-clock, never flake.
const TICK_MS = 5_000;
const SETTLE_DEADLINE_MS = 20_000;   // one request must settle within this
const WEDGE_WINDOW_MS = 22_000;      // > TICK + a 12s fix timeout
const FORWARD_DEADLINE_MS = 20_000;  // download timeout + onMessage tail

// ─── embedded self-signed cert for the fake slack.com (valid to 2036) ───────
const STALL_KEY = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCuCqcv9CFD2zmU',
  'Oh4xGMhKE0/AVGJ9Q9bP5crWH6tPKp7cUgc4y7D4swVFaoy56MhP+xgvDQxbXKp2',
  'XC5kjvRrfJCmFA4APwRPxW/XsgDyuS7mpQe+Ik0tEietc3epBnIUa0P1UBNiPlup',
  'aG+JbXQfNKxdzd/hF9uca+TTPJIlr1POAZreX8ufutlaJRhmbcBDiBgYU23mGgLV',
  'npDT1aZhizTmvefJ38JjU3JuhsLP7we+7qH+2pu/0LLa/DRB0ENaoujmw3QpHvCh',
  'zLtCgwNj2vMul6dMT3+ik7pnQfO/DFXgTJhEVs5hGclVVTg84W2AuwlT7IaLjCQ1',
  'nwIQlHyHAgMBAAECggEAC4C5vxIgFreJDTJwJ2ePaVHwbfJF1iijLHdwGgnazS8w',
  'c7haMNdJmY5fdVCO/4SSpLKgTQ/MNsefnpYGHPBT2DzR5KAjssF3e/w9IaDqriAu',
  'KOFUay0iM63lAHJGwN2jsZTLV43U0iPz8/TqlkctKxjUoZiHSP3GLob1Bz8UG7ho',
  'N3CADE2IO4Z1hgwN3AF0HSE4tFrL61ehPITHkoFiV9Ciwjc+Y0EZDWjfinHG9Znh',
  'MHww/hG/wv4d8MT5ZZtvuS8massQ7YFx7cVwQ9LEU+M9HvdGMa4VsYJN0MtBhBWG',
  'ndqkeiU9oPzb9butO1S0SuBWbDgRxhFG2XbPyMhc4QKBgQDs7dT9agUjpJ2dfjH9',
  'YsboZ+LE+GCZRHBVR86VZY+Qx9/Nla5FEHt3A7lS5nWZYwLTGrog13sV2oRnVe6C',
  'R+kQT9GhUxEwxWtxBAsNaG0vvjPhohMqgVN1VRPq6JzYJhsddFMEzyQkQvS5UnUs',
  'OAZUK4KAZLyZKuIXpFUaXSDRYQKBgQC8DPXyTpVQEDtX5xXznooVQo1PP8Zep+Uo',
  'zWAn6uwcU3y8/mCZYt4OSole5klI54oFKTiVeC5FhPgUJd/4VQxTTgYcWOQStvu5',
  'lRsgs3XUMwzP3+MSFksgSHnK4QQQ9/I2mMJEPoQIGxoLCozkgkYgENUMdlqR2aSW',
  'SlPKO6xO5wKBgEiuDJBQXZM5hEAz3hHkoy/X7nCN4NQjcnI2vOCHbyrypWzjZbo5',
  '/CXeNpN/rsOG4+7uW/qHH3LsvYEVkzzT4mLmmV/ro3JanULmAp3yUsw6hJ/KoCaB',
  '1aBAoQOGp9aGmfrHHFB1WpjlET1oVhlidk6LqlTIkjJKPWETQCf+OXsBAoGBAIfs',
  '6l3B1YVwpiRsoV5dqzugxlmRJIbI3wh2ItnXoeD7q79EM3jLkOxNjivtUu2Chy4h',
  '1Iedvfx8F4Egu1pZxzXzwND+o6SvZRaIo3oonbPLTqh3ET/Co3zrRjWSHglR3179',
  'XfZMJc1iIZn3f02wqJWG9Sgz6FViNuh3Q0d7iJnjAoGBAKht+rTQO9Thd07XYdVi',
  'So+K6RNAs9AoWH4eDzxytOtkRucdAvbpuqK5DN+G5UfCW0x4WlyvBtgNnpmOrm6P',
  'ZqiW1NDsZoLpMliFUtEtV1VIQLCtR0/dz6HFZIVnWEtzJNwkoXAkQB/d39gzgHdZ',
  'Ou3D4RctcHfhlHOnKfEp6/nC',
  '-----END PRIVATE KEY-----',
].join('\n');

const STALL_CERT = [
  '-----BEGIN CERTIFICATE-----',
  'MIIDNzCCAh+gAwIBAgIUDTCZioH/P1HpflLN1Nw8ifKUSvUwDQYJKoZIhvcNAQEL',
  'BQAwFDESMBAGA1UEAwwJc2xhY2suY29tMB4XDTI2MDkxOTE5NTcyNFoXDTM2MDkx',
  'NjE5NTcyNFowFDESMBAGA1UEAwwJc2xhY2suY29tMIIBIjANBgkqhkiG9w0BAQEF',
  'AAOCAQ8AMIIBCgKCAQEArgqnL/QhQ9s5lDoeMRjIShNPwFRifUPWz+XK1h+rTyqe',
  '3FIHOMuw+LMFRWqMuejIT/sYLw0MW1yqdlwuZI70a3yQphQOAD8ET8Vv17IA8rku',
  '5qUHviJNLRInrXN3qQZyFGtD9VATYj5bqWhviW10HzSsXc3f4RfbnGvk0zySJa9T',
  'zgGa3l/Ln7rZWiUYZm3AQ4gYGFNt5hoC1Z6Q09WmYYs05r3nyd/CY1NybobCz+8H',
  'vu6h/tqbv9Cy2vw0QdBDWqLo5sN0KR7wocy7QoMDY9rzLpenTE9/opO6Z0HzvwxV',
  '4EyYRFbOYRnJVVU4POFtgLsJU+yGi4wkNZ8CEJR8hwIDAQABo4GAMH4wHQYDVR0O',
  'BBYEFHEG9itNMvKpYSrIrUrDsiNMSDKSMB8GA1UdIwQYMBaAFHEG9itNMvKpYSrI',
  'rUrDsiNMSDKSMA8GA1UdEwEB/wQFMAMBAf8wKwYDVR0RBCQwIoIJc2xhY2suY29t',
  'gg9maWxlcy5zbGFjay5jb22HBH8AAAEwDQYJKoZIhvcNAQELBQADggEBAHRorjBd',
  'Lmm7JIRMONDxV0dfyoH4WQg8lACpnwzZ4315AILGns1LLmgiUjxMODHJ1vIgRzRS',
  'fWdOItk1kBBoc5J6agopdIOy3mbi6+xHy72Bx9Fbxxv/HGOgyAf7EbvmCvtL3q6T',
  '17H+9Zj7lYzB6haMeiktrWtXq4+n/dBwZOJMDPMqH+/gzYPhrzAJ/t7mWBXcu5qb',
  'BX9hNcTQTxdQHdN4EUYN1EBBf6p8vclUMVxjbBaMhG0vKL5NAoqiLEX6t/QD8Ey0',
  'aj1V8/R01qA5bmWiHc73CpIaT4PS+NKrKWGmmdAqCJ1UlpLA6+oFMc1h6YqONzQt',
  'HWhRZ1QXBM3+CzI=',
  '-----END CERTIFICATE-----',
].join('\n');

// ─── throwaway homes so nothing touches the real user profile ───────────────
const ROOTS = {
  userData: fs.mkdtempSync(path.join(os.tmpdir(), 'md-bug12-userdata-')),
  harnessHome: null,
};
ROOTS.harnessHome = fs.mkdtempSync(path.join(os.tmpdir(), 'md-bug12-hive-'));

// ─── electron stub (same pattern as test/repro/bug-7.repro.cjs) ─────────────
const ipcHandlers = new Map(); // channel -> handler
class MockWebContents {
  constructor(label) {
    this.__label = label;
    this._destroyed = false;
    this.sent = []; // { channel, payload }
    this.session = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} };
    this.__handlers = {};
  }
  isDestroyed() { return this._destroyed; }
  send(channel, payload) { this.sent.push({ channel, payload }); }
  setWindowOpenHandler() { return { action: 'deny' }; }
  on(ev, fn) { (this.__handlers[ev] ??= []).push(fn); return this; }
  once(ev, fn) { return this.on(ev, fn); }
  off(ev, fn) {
    const a = this.__handlers[ev] ?? [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
    return this;
  }
  destroy() { this._destroyed = true; }
}
class MockBrowserWindow {
  static instances = []; // lets the repro grab windows the app created
  constructor() {
    MockBrowserWindow.instances.push(this);
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
  show() {}
  close() {}
  isMinimized() { return false; }
  restore() {}
  isMaximized() { return false; }
  getBounds() { return { x: 0, y: 0, width: 1280, height: 800 }; }
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
      on() { return this; },
      // NEVER resolves: keeps the whenReady-only boot block (analytics.init,
      // model-catalog fetch, auto-updater polling) out of the run.
      whenReady() { return new Promise(() => {}); },
      quit() {}, exit() {}, relaunch() {},
      requestSingleInstanceLock() { return true; },
      setAsDefaultProtocolClient() {},
      setLoginItemSettings() {}, getLoginItemSettings() { return {}; },
      isPackaged: false,
      getAppPath() { return REPO; },
      getPath(name) { return ROOTS.userData; },
      getVersion() { return '0.0.0-repro'; }
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

// ─── node-pty stub: never spawns a real terminal ─────────────────────────────
const ptyRequirePath = require.resolve('node-pty');
require.cache[ptyRequirePath] = {
  id: ptyRequirePath, filename: ptyRequirePath, loaded: true,
  exports: { __esModule: true, spawn() { throw new Error('node-pty stub: no PTY in this repro'); } }
};

// ─── better-sqlite3 stub: only `new Database(path)` + pragmas/prepare run in
//     this scenario (persist.open() is wrapped in try/catch in whenReady, and
//     getKv/setKv degrade to no-ops when closed).
const sqliteRequirePath = require.resolve('better-sqlite3');
class FakeDatabase {
  constructor() { this._stmts = new Map(); }
  pragma() { return 0; }
  prepare(sql) {
    if (!this._stmts.has(sql)) {
      this._stmts.set(sql, {
        run() { return { changes: 0, lastInsertRowid: 1 }; },
        get() { return undefined; },
        all() { return []; },
        iterate() { return [][Symbol.iterator](); }
      });
    }
    return this._stmts.get(sql);
  }
  exec() {}
  transaction(fn) { return fn; }
  close() {}
}
function DatabaseCtor() { return new FakeDatabase(); }
require.cache[sqliteRequirePath] = {
  id: sqliteRequirePath, filename: sqliteRequirePath, loaded: true,
  exports: DatabaseCtor
};
DatabaseCtor.default = DatabaseCtor;

// ─── tunnelmole stub: startSlackServer opens a public tunnel; return a fake
//     URL instantly so the integration starts offline.
const tunnelmoleRequirePath = require.resolve('tunnelmole');
require.cache[tunnelmoleRequirePath] = {
  id: tunnelmoleRequirePath, filename: tunnelmoleRequirePath, loaded: true,
  exports: { tunnelmole: async () => 'https://fake-tunnelmole.example' }
};

// ─── keep every patchable boundary off the real machine ─────────────────────
const configModule = loadTs('src/main/config.ts');
configModule.ensureClaudePermissionsAccepted = function () {};
const procKill = loadTs('src/main/procKill.ts');
procKill.ensureKilled = function () {};
procKill.hardKillTree = function () {};
const shellEnv = loadTs('src/main/shellEnv.ts');
if (typeof shellEnv.userShellPath === 'function') {
  shellEnv.userShellPath = () => process.env.PATH || '/usr/bin:/bin';
}
const nodeInstall = loadTs('src/main/nodeInstall.ts');
nodeInstall.detectNodeVersion = () => 'v24.19.0';
nodeInstall.nodeIsUsable = () => true;
nodeInstall.resolveNodeInstaller = async () => null;

// ─── load the REAL modules under test ────────────────────────────────────────
console.log('[setup] loading src/main/index.ts (real poller + slack IPC + downloadSlackFile)');
const slack = loadTs('src/main/slack.ts');
const { postSlackReply } = slack;
loadTs('src/main/index.ts');

// ─── the fake Slack: a local TLS server that answers (control) or STALLS ────
let stallMode = false;
const requestLog = [];   // { path, mode }
const liveSockets = new Set();
const stallSockets = new Set(); // sockets a stall is currently holding

function startFakeSlack() {
  return new Promise((resolve) => {
    const server = tls.createServer(
      { key: STALL_KEY, cert: STALL_CERT },
      (socket) => {
        liveSockets.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => { liveSockets.delete(socket); stallSockets.delete(socket); });
        socket.on('data', (chunk) => {
          const head = String(chunk).split('\r\n')[0] ?? '';
          const reqPath = head.split(' ')[1] ?? '';
          if (requestLog.length < 500) requestLog.push({ path: reqPath, mode: stallMode ? 'stall' : 'respond' });
          if (stallMode) {
            // Request received — then NOTHING. No response, no FIN, no RST:
            // exactly the stalled-middlebox scenario the claim describes.
            stallSockets.add(socket);
            return;
          }
          const body = '{"ok":true}';
          socket.end(
            'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n' +
            `content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`
          );
        });
      }
    );
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Point the REAL client code at the fake Slack. slack.ts and index.ts both
 *  reach `request` through the module object at call time, so patching the
 *  property redirects every request while leaving the request options intact
 *  (hostname stays slack.com/files.slack.com; SNI matches the cert). */
function installSlackRedirect(port) {
  const https = require('node:https');
  const realRequest = https.request;
  https.request = function patchedRequest(opts, cb) {
    if (opts && typeof opts === 'object' &&
        (opts.hostname === 'slack.com' || opts.hostname === 'files.slack.com')) {
      opts = {
        ...opts,
        hostname: '127.0.0.1',
        port,
        servername: opts.hostname,
        rejectUnauthorized: false
      };
    }
    return realRequest.call(https, opts, cb);
  };
  return function uninstall() { https.request = realRequest; };
}

// ─── harness helpers ─────────────────────────────────────────────────────────
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Resolve 'settled' | 'pending' — never throws, never rejects. */
function settleState(promise, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve('pending'); } }, timeoutMs);
    Promise.resolve(promise).then(
      () => { if (!done) { done = true; clearTimeout(timer); resolve('settled'); } },
      () => { if (!done) { done = true; clearTimeout(timer); resolve('settled'); } }
    );
  });
}

const TASKS_PATH = () => path.join(ROOTS.harnessHome, 'hive', 'tasks.json');
function writeTaskCard(card) {
  fs.mkdirSync(path.dirname(TASKS_PATH()), { recursive: true });
  fs.writeFileSync(TASKS_PATH(), JSON.stringify({ tasks: [card] }));
}
function makeCard(id, status) {
  return {
    id, title: 'Ship the report', description: 'Quarterly numbers, compiled.',
    status, dependsOn: [], priority: 1, createdAt: '2026-09-20T00:00:00.000Z',
    slack: { channel: 'C9999999', thread_ts: '1758000000.000100' }
  };
}

// ─── results ─────────────────────────────────────────────────────────────────
const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); console.log(`  ok   - ${name}`); }
  catch (e) { results.push({ name, ok: false, error: e }); console.log(`  FAIL - ${name}\n         ${e.message.split('\n')[0]}`); }
}

async function main() {
  const slackStart = ipcHandlers.get('slack:start');
  const slackStop = ipcHandlers.get('slack:stop');
  if (!slackStart || !slackStop) throw new Error('slack IPC handlers were never registered — harness broken');

  const { writeConfig, readConfig } = configModule;
  const enableSlack = async () => {
    writeConfig({
      harnessHome: ROOTS.harnessHome,
      slackEnabled: true,
      slackSigningSecret: 'whsec-bug12-signing-secret',
      slackBotToken: 'xoxb-bug12-bot-token',
      slackProactivePosting: true,
      slackPort: await findFreePort()
    });
  };
  await enableSlack();
  // Sanity: the config roundtrip must work through the stubbed userData.
  assert.equal(readConfig().slackBotToken, 'xoxb-bug12-bot-token', 'config write/read roundtrip failed');
  assert.equal(readConfig().slackEnabled, true, 'slackEnabled did not persist');

  const fakeSlack = await startFakeSlack();
  const fakePort = fakeSlack.address().port;
  const restoreHttps = installSlackRedirect(fakePort);

  try {
    // ────────────────────────────────────────────────────────────────────────
    // SECTION 1 (CONTROL): a RESPONDING fake slack.com — the poller reports a
    // newly-done Slack-origin card. Proves the wiring under test is live.
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n[control] fake slack.com RESPONDS — the done-summary poller delivers');
    writeTaskCard(makeCard('bug12-card-1', 'doing')); // not done at baseline
    const startRes = await slackStart();
    check('control: slack:start succeeds (webhook + reply endpoint + poller)', () => {
      assert.equal(startRes.ok, true, `slack:start returned ${JSON.stringify(startRes)}`);
    });
    await sleep(TICK_MS + 1_000);           // first tick seeds the baseline
    writeTaskCard(makeCard('bug12-card-1', 'done')); // live transition
    await sleep(TICK_MS + 2_000);           // next tick must post
    check('control: the poller posted the done summary to slack.com (chat.postMessage seen)', () => {
      assert.ok(
        requestLog.some((r) => r.path === '/api/chat.postMessage' && r.mode === 'respond'),
        `no post was seen; requests: ${JSON.stringify(requestLog)}`
      );
    });

    // ────────────────────────────────────────────────────────────────────────
    // SECTION 2 (THE BUG): slack.com now STALLS after the handshake.
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n[bug] slack.com accepts the connection, then never responds');
    stallMode = true;
    slackStop();
    await sleep(50);
    await enableSlack();

    writeTaskCard(makeCard('bug12-card-2', 'doing'));
    const startRes2 = await slackStart();
    check('bug: slack:start (re)started cleanly against the stalling endpoint', () => {
      assert.equal(startRes2.ok, true, `slack:start returned ${JSON.stringify(startRes2)}`);
    });
    await sleep(TICK_MS + 1_000);           // first tick seeds the baseline
    writeTaskCard(makeCard('bug12-card-2', 'done')); // live transition
    await sleep(TICK_MS + 2_000);           // next tick attempts the post → stalls
    check('bug precondition: the poller attempted the post into the stalled endpoint', () => {
      assert.ok(
        requestLog.some((r) => r.path === '/api/chat.postMessage' && r.mode === 'stall'),
        `no attempt was seen; requests: ${JSON.stringify(requestLog)}`
      );
    });

    // The in-flight tick is now wedged on the never-settling await. On healthy
    // code the attempt settles (timeout → transient error → retry), so further
    // ticks keep attempting the still-unnotified card.
    console.log('[bug] waiting out the wedge window to see whether the poller keeps polling...');
    const before = requestLog.length;
    await sleep(WEDGE_WINDOW_MS);
    const keptPolling = requestLog.slice(before).some((r) => r.path === '/api/chat.postMessage');
    check('bug: the 5s poller KEEPS POLLING after the stalled attempt (not wedged)', () => {
      assert.equal(keptPolling, true,
        `the poller went SILENT for ${WEDGE_WINDOW_MS}ms after the stall: the in-flight ` +
        `postSlackReply promise never settled, slackDonePolling stayed true, and every ` +
        `later tick returned at the re-entrancy guard (src/main/index.ts:1586). ` +
        `requests after the stall: ${JSON.stringify(requestLog.slice(before))}`
      );
    });

    // Unit-level: the exported postSlackReply itself must settle.
    const probe = postSlackReply({ botToken: 'xoxb-bug12-bot-token', channel: 'C1', thread_ts: '1.1', text: 'x' });
    const probeState = await settleState(probe, SETTLE_DEADLINE_MS);
    check(`bug: postSlackReply SETTLES within ${SETTLE_DEADLINE_MS / 1000}s against a stalled connection`, () => {
      assert.equal(probeState, 'settled',
        `postSlackReply was still pending after ${SETTLE_DEADLINE_MS}ms: no timeout option, ` +
        `no req.setTimeout, no socket timeout — the promise can never settle (slack.ts:353-394)`
      );
    });

    // ────────────────────────────────────────────────────────────────────────
    // SECTION 3: Stop→Start must re-arm the observer (the flag is only reset
    // in the poller's finally — never by the lifecycle functions). Scoped to
    // this section's request window so Section 2's stall can't satisfy it.
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n[bug] Settings Stop→Start while the stall is in flight');
    const mark3 = requestLog.length;
    slackStop();
    await sleep(50);
    await enableSlack();
    writeTaskCard(makeCard('bug12-card-3', 'doing'));
    const startRes3 = await slackStart();
    assert.equal(startRes3.ok, true, `restart returned ${JSON.stringify(startRes3)}`);
    await sleep(TICK_MS + 1_000);           // new observer's baseline tick
    writeTaskCard(makeCard('bug12-card-3', 'done'));
    await sleep(TICK_MS + 2_000);
    const afterRestart = requestLog.slice(mark3);
    check('bug: Stop→Start RE-ARMS the poller — the restarted observer attempts the post', () => {
      assert.ok(
        afterRestart.some((r) => r.path === '/api/chat.postMessage'),
        'the restarted observer NEVER polled: the wedged in-flight tick kept ' +
        'slackDonePolling=true across the restart, so every tick of the new timer ' +
        'returned at the guard. Only an app restart would clear it. ' +
        `requests after the restart: ${JSON.stringify(afterRestart)}`
      );
    });

    // ────────────────────────────────────────────────────────────────────────
    // SECTION 4: the loopback /reply endpoint must answer the in-flight reply.
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n[bug] agent direct reply through the loopback /reply endpoint');
    const replyCfg = JSON.parse(fs.readFileSync(path.join(ROOTS.userData, 'slack-reply.json'), 'utf8'));
    const replyOutcome = await new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: replyCfg.port, method: 'POST', path: '/reply',
          headers: { 'x-md-reply-token': replyCfg.token, 'content-type': 'application/json' },
          timeout: SETTLE_DEADLINE_MS },
        (res) => {
          let b = '';
          res.on('data', (c) => { b += c; });
          res.on('end', () => resolve({ answered: true, status: res.statusCode, body: b }));
        }
      );
      req.on('timeout', () => { req.destroy(); resolve({ answered: false }); });
      req.on('error', () => resolve({ answered: false }));
      req.end(JSON.stringify({ channel: 'C1', thread_ts: '1.1', text: 'agent reply' }));
    });
    check(`bug: the loopback /reply endpoint ANSWERS within ${SETTLE_DEADLINE_MS / 1000}s`, () => {
      assert.equal(replyOutcome.answered, true,
        `the /reply endpoint never answered the in-flight request: its handler awaits ` +
        `postSlackReply directly (slack.ts:482) and that promise never settles. ` +
        `The agent's direct reply hangs forever.`
      );
    });

    // ────────────────────────────────────────────────────────────────────────
    // SECTION 5: inbound message WITH an attachment — acked, then forwarded?
    // Drives the REAL webhook server + REAL onMessage (downloadSlackFiles →
    // renderer forward), with the file URL pointed at the stalling endpoint.
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n[bug] inbound file message: acked, then the attachment download stalls');
    // Drive the real 'window:newFloor' handler so liveWebContents() resolves;
    // the handler returns only {ok}, so grab the instance from the mock registry.
    const beforeFloor = MockBrowserWindow.instances.length;
    const newFloorRes = ipcHandlers.get('window:newFloor')();
    assert.ok(newFloorRes && newFloorRes.ok === true, 'could not open a floor window for liveWebContents()');
    const floorWin = MockBrowserWindow.instances[beforeFloor];
    assert.ok(floorWin, 'floor window was not created');
    const wc = floorWin.webContents;
    const webhookPort = readConfig().slackPort;

    const raw = JSON.stringify({
      type: 'event_callback',
      authorizations: [{ user_id: 'UBOT12' }],
      event: {
        type: 'message', subtype: 'file_share', channel: 'C9999999',
        text: '<@UBOT12> here is the file', ts: '1758001234.000100',
        files: [{ id: 'F1', url_private: `https://files.slack.com/files-pri/F1/data.csv`, name: 'data.csv', mimetype: 'text/csv' }]
      }
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = 'v0=' + createHmac('sha256', 'whsec-bug12-signing-secret').update(`v0:${ts}:${raw}`).digest('hex');
    const ackStatus = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: webhookPort, method: 'POST', path: '/',
          headers: { 'content-type': 'application/json', 'x-slack-signature': sig, 'x-slack-request-timestamp': ts } },
        (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }
      );
      req.on('error', reject);
      req.end(raw);
    });
    await sleep(1_000); // let the download's TLS handshake reach the fake server
    check('bug section precondition: the webhook 200-acked the file message (Slack is satisfied)', () => {
      assert.equal(ackStatus, 200, `ack status was ${ackStatus}`);
      assert.ok(
        requestLog.some((r) => r.path.startsWith('/files-pri/')),
        'the attachment download was never attempted'
      );
    });
    await sleep(FORWARD_DEADLINE_MS);
    check(`bug: the acked file message is STILL FORWARDED (download stall must not drop it)`, () => {
      const forwarded = wc.sent.filter((m) => m.channel === 'slack:incomingMessage');
      assert.equal(forwarded.length, 1,
        `the message was 200-acked to Slack but never reached the renderer: onMessage awaits ` +
        `downloadSlackFiles (index.ts:1675), whose stalled request never settles, so the ` +
        `inbound message is silently dropped after being acknowledged. ` +
        `renderer got: ${JSON.stringify(wc.sent.map((m) => m.channel))}`
      );
    });

    // ────────────────────────────────────────────────────────────────────────
    // VERDICT
    // ────────────────────────────────────────────────────────────────────────
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length > 0) {
      console.error('\nBUG REPRODUCED — desired behaviors that DO NOT hold:');
      for (const f of failed) console.error('  ✗ ' + f.name);
      process.exitCode = 1;
    } else {
      console.log('\nAll checks passed — stalled connections no longer wedge the poller (bug fixed).');
    }
  } finally {
    restoreHttps();
    try { const h = ipcHandlers.get('slack:stop'); if (h) h(); } catch { /* noop */ }
    for (const s of [...liveSockets, ...stallSockets]) { try { s.destroy(); } catch { /* noop */ } }
    try { fakeSlack.close(); } catch { /* noop */ }
    try { require('node:https').globalAgent.destroy(); } catch { /* noop */ }
  }

  // The wedged promises hold their TLS sockets open; destroy everything and
  // force the exit (pending timers would otherwise keep the loop alive).
  for (const s of [...liveSockets, ...stallSockets]) { try { s.destroy(); } catch { /* noop */ } }
  setTimeout(() => process.exit(process.exitCode || 0), 250).unref();
}

main().catch((e) => {
  console.error('\nREPRO ERROR:', e.message ?? e);
  process.exit(1);
});

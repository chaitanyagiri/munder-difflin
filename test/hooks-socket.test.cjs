'use strict';
/**
 * The hook socket (HIVE_SOCK) is the ONE endpoint every lifecycle hook, proxy
 * emit and cost sample travels through. Upstream issue #277: it was silently
 * unbound for a whole session — the app was up, `hooks.sock` did not exist,
 * every hook's connect() failed and exited 0 (which the CLI reads as "allow"),
 * fleet.json never appeared, and NOTHING was logged. These tests pin down the
 * behaviour that makes that impossible to miss, and closes the one way we know
 * a live socket can vanish under a running app:
 *   1. a successful bind is reported (console + log.jsonl + fleet-visible health);
 *   2. a failed bind is reported and retried, and toasts once the back-off is spent;
 *   3. stop() removes only the socket file IT bound — never another instance's
 *      (an old instance hanging on quit + a relaunch is the #277 shape);
 *   4. the beat re-binds when the socket file disappears under a listening server;
 *   5. the beat never steals a socket another live server owns;
 *   6. a hive with no root yet is not silent either.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
const toasts = [];
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: {
    Notification: class {
      constructor(opts) { this.opts = opts; }
      show() { toasts.push(this.opts); }
      static isSupported() { return true; }
    }
  }
};

const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const CONFIG = { notifications: true };

const posixOnly = { skip: process.platform === 'win32' ? 'named pipes have no socket file' : false };

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-'));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  const servers = [];
  const make = () => { const s = new HookServer(hive, () => null, () => CONFIG, undefined, undefined); servers.push(s); return s; };
  t.after(() => { for (const s of servers) { try { s.stop(); } catch { /* noop */ } } fs.rmSync(home, { recursive: true, force: true }); });
  toasts.length = 0;
  return { home, hive, make, sock: hive.sockPath() };
}

/** What a shim does: connect, send one JSON line, read the reply. */
function roundTrip(sock, payload = { hook_event_name: 'Unknown', agent_id: 'jim-1' }) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\n'));
    let resp = '';
    c.setEncoding('utf8');
    c.on('data', (d) => { resp += d; });
    c.on('end', () => resolve(resp));
    c.on('error', reject);
  });
}

function hookLog(hive) {
  const p = path.join(hive.root(), 'log.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === 'hooks');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Poll until `fn()` is truthy (start() binds asynchronously). */
async function waitFor(fn, ms = 3000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (fn()) return true; await sleep(20); }
  return false;
}

test('a successful bind is reported: log.jsonl, health, and a shim round-trip', async (t) => {
  const { hive, make, sock } = await floor(t);
  const a = make();
  a.start();
  assert.ok(await waitFor(() => fs.existsSync(sock)), 'socket file appears');
  assert.equal(await roundTrip(sock), '{}', 'a shim gets a JSON reply');
  const log = hookLog(hive);
  assert.deepEqual(log.map((e) => e.state), ['listening'], 'the bind is recorded where an operator can find it');
  assert.equal(log[0].path, sock);
  const h = a.health();
  assert.equal(h.listening, true, JSON.stringify(h));
  assert.equal(h.path, sock);
  assert.equal(h.lastError, null);
  assert.equal(h.attempts, 0);
  assert.equal(h.orphans, 0);
  assert.ok(typeof h.since === 'number');
});

test('a failed bind is loud and retried, and toasts once the back-off is spent', async (t) => {
  const { home } = await floor(t);
  const logs = [];
  // A hive whose socket path cannot be bound (its directory does not exist).
  const hive = { sockPath: () => path.join(home, 'nope', 'hooks.sock'), appendLog: (e) => logs.push(e) };
  const a = new HookServer(hive, () => null, () => CONFIG, undefined, undefined);
  t.after(() => a.stop());
  const h = await a.ensureListening();
  assert.equal(h.listening, false);
  assert.ok(['ENOENT', 'EACCES'].includes(h.lastError), JSON.stringify(h)); // macOS says EACCES for a missing dir
  assert.equal(h.attempts, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].kind, 'hooks');
  assert.equal(logs[0].state, 'bind-failed');
  assert.equal(logs[0].code, h.lastError);
  assert.equal(toasts.length, 0, 'the first failure retries quietly');
  // Exhaust the back-off (each call is one attempt; the timers would do the same).
  for (let i = 0; i < 6; i++) await a.ensureListening();
  assert.ok(a.health().attempts >= 6, `attempts=${a.health().attempts}`);
  assert.equal(toasts.length, 1, 'exactly one toast per outage');
  assert.match(toasts[0].title, /hooks are down/i);
  assert.match(toasts[0].body, /allowed/i);
});

test('stop() removes only the socket file it bound — never another instance\'s', posixOnly, async (t) => {
  const { make, sock } = await floor(t);
  const a = make();
  a.start();
  assert.ok(await waitFor(() => fs.existsSync(sock)));
  // The #277 shape: A lingers on quit, its socket file goes away, a relaunched
  // instance B binds the same path, then A finally finishes quitting.
  fs.rmSync(sock);
  const b = make();
  b.start();
  assert.ok(await waitFor(() => fs.existsSync(sock)));
  assert.equal(await roundTrip(sock), '{}', 'B serves');
  a.stop();
  await sleep(50);
  assert.ok(fs.existsSync(sock), 'B\'s socket file survives A.stop()');
  assert.equal(await roundTrip(sock), '{}', 'B still serves');
  b.stop();
  await sleep(50);
  assert.ok(!fs.existsSync(sock), 'B removes its own file');
});

test('the beat re-binds when the socket file disappears under a listening server', posixOnly, async (t) => {
  const { hive, make, sock } = await floor(t);
  const a = make();
  await a.ensureListening();
  fs.rmSync(sock);
  await assert.rejects(roundTrip(sock), /ENOENT/, 'with the file gone every shim fails to connect');
  assert.equal(a.health().listening, true, 'and the server itself cannot tell');
  const h = await a.ensureListening();
  assert.equal(h.listening, true, JSON.stringify(h));
  assert.equal(await roundTrip(sock), '{}');
  assert.deepEqual(hookLog(hive).map((e) => `${e.state}${e.code ? ':' + e.code : ''}`), ['listening', 'lost:ENOENT', 'listening']);
});

test('the beat never steals a socket another live server owns', posixOnly, async (t) => {
  const { make, sock } = await floor(t);
  const a = make();
  await a.ensureListening();
  fs.rmSync(sock);
  const b = make();
  await b.ensureListening();
  const h = await a.ensureListening();
  assert.equal(h.listening, false, JSON.stringify(h));
  assert.equal(h.lastError, 'EADDRINUSE');
  assert.equal(h.orphans, 1, 'A abandoned its listener rather than closing it (libuv would unlink B\'s path)');
  assert.equal(await roundTrip(sock), '{}', 'B keeps serving');
  b.stop();
  // Once the owner is gone, A takes the path back (a scheduled retry may race
  // an explicit call, so settle rather than assert the first answer).
  for (let i = 0; i < 20 && !(await a.ensureListening()).listening; i++) await sleep(50);
  assert.equal(a.health().listening, true);
  assert.equal(await roundTrip(sock), '{}');
});

test('a hive with no root yet is not silent, and binds once the root appears', async (t) => {
  const { home } = await floor(t);
  const logs = [];
  let root = null;
  const hive = { sockPath: () => (root ? path.join(root, 'hooks.sock') : null), appendLog: (e) => logs.push(e) };
  const a = new HookServer(hive, () => null, () => CONFIG, undefined, undefined);
  t.after(() => a.stop());
  const h = await a.ensureListening();
  assert.equal(h.listening, false);
  assert.equal(h.lastError, 'NOROOT');
  assert.equal(h.path, null);
  root = home;
  const h2 = await a.ensureListening();
  assert.equal(h2.listening, true, JSON.stringify(h2));
  assert.equal(logs.at(-1).state, 'listening');
});

'use strict';

/**
 * Public-tunnel provider (src/main/tunnel.ts).
 *
 * The defect this module exists to fix: both SlackWebhookServer and WebhookServer used
 * to call tunnelmole directly and carried the same comment — "no documented close
 * handle; teardown is best-effort" — so stopping the bridge left the public URL alive
 * until the app quit. A cloudflared quick tunnel is an ordinary child process, so the
 * handle it returns can really close.
 *
 * The child is injected, so these run with no network, no cloudflared install, and no
 * real tunnel.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const loadTs = require('./load-ts.cjs');

const {
  extractQuickTunnelUrl,
  selectProvider,
  cloudflaredAvailable,
  openTunnel
} = loadTs('src/main/tunnel.ts');

/** The banner cloudflared actually prints, split the way a stream chunks it. */
const BANNER_LINES = [
  '2026-08-14T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...\n',
  '2026-08-14T10:00:01Z INF +----------------------------------------------------+\n',
  '2026-08-14T10:00:01Z INF |  Your quick Tunnel has been created! Visit it at    |\n',
  '2026-08-14T10:00:01Z INF |  (it may take some time to be reachable):           |\n',
  '2026-08-14T10:00:01Z INF |  https://sour-pine-mercury-mars.trycloudflare.com   |\n',
  '2026-08-14T10:00:01Z INF +----------------------------------------------------+\n'
];
const EXPECTED_URL = 'https://sour-pine-mercury-mars.trycloudflare.com';

/** A stand-in for the cloudflared child process. */
function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

// ─── URL extraction ──────────────────────────────────────────────────────────

test('the URL is found inside the box-drawn banner', () => {
  assert.equal(extractQuickTunnelUrl(BANNER_LINES.join('')), EXPECTED_URL);
});

test('extraction works on a buffer split mid-URL across chunks', () => {
  // The whole reason the parser matches the ACCUMULATED buffer rather than each chunk:
  // a stream chunk boundary can land in the middle of the hostname.
  let buf = '';
  let found = null;
  for (const piece of ['INF |  https://sour-pine-', 'mercury-mars.trycloudflare', '.com  |\n']) {
    buf += piece;
    found = found ?? extractQuickTunnelUrl(buf);
  }
  assert.equal(found, EXPECTED_URL);
});

test('no URL in ordinary log noise, and a look-alike domain is not matched', () => {
  assert.equal(extractQuickTunnelUrl('INF Requesting new quick Tunnel...\n'), null);
  assert.equal(extractQuickTunnelUrl('https://evil-trycloudflare.com.attacker.test/x'), null);
});

// ─── provider selection ──────────────────────────────────────────────────────

const withCloudflared = { resolve: () => '/usr/local/bin/cloudflared' };
const withoutCloudflared = { resolve: () => '' };

test('auto prefers cloudflared and falls back to tunnelmole', () => {
  assert.equal(selectProvider('auto', withCloudflared), 'cloudflared');
  assert.equal(selectProvider('auto', withoutCloudflared), 'tunnelmole');
  assert.equal(cloudflaredAvailable(withoutCloudflared), false);
});

test('an explicit provider is honoured even when the binary is missing', () => {
  // A misconfiguration must surface as an error later, not silently fall back to the
  // provider the user pinned away from.
  assert.equal(selectProvider('cloudflared', withoutCloudflared), 'cloudflared');
  assert.equal(selectProvider('tunnelmole', withCloudflared), 'tunnelmole');
});

// ─── the handle ──────────────────────────────────────────────────────────────

test('a cloudflared tunnel resolves with a closable handle', async () => {
  const child = fakeChild();
  let spawned = null;
  const killed = [];
  const p = openTunnel(3847, {
    deps: {
      ...withCloudflared,
      spawn: (bin, args) => { spawned = { bin, args }; return child; },
      kill: (pid) => killed.push(pid)
    }
  });
  for (const line of BANNER_LINES) child.stderr.emit('data', Buffer.from(line));

  const handle = await p;
  assert.equal(handle.url, EXPECTED_URL);
  assert.equal(handle.provider, 'cloudflared');
  assert.equal(typeof handle.close, 'function');
  // 127.0.0.1, never localhost: the servers bind IPv4 loopback, and localhost can
  // resolve to ::1 — which would forward into a closed port.
  assert.deepEqual(spawned.args, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:3847']);
  assert.equal(spawned.bin, '/usr/local/bin/cloudflared');
  // close() must be safe to call twice — stop() is idempotent and callers may retry —
  // and must signal EXACTLY once: after the first kill the OS can recycle the pid, so
  // a second signal would land on somebody else's process.
  handle.close();
  handle.close();
  assert.deepEqual(killed, [4242]);
});

test('a child that exits before printing a URL rejects instead of hanging', async () => {
  const child = fakeChild();
  const p = openTunnel(3847, {
    deps: { ...withCloudflared, spawn: () => child }
  });
  child.stderr.emit('data', Buffer.from('ERR failed to connect\n'));
  child.emit('exit', 1);

  await assert.rejects(p, (e) => {
    assert.match(e.message, /cloudflared exited/);
    assert.match(e.message, /failed to connect/, 'the tail of the log should be reported');
    return true;
  });
});

test('a silent child times out rather than blocking the bridge forever', async () => {
  const child = fakeChild();
  const killed = [];
  const p = openTunnel(3847, {
    timeoutMs: 30,
    deps: { ...withCloudflared, spawn: () => child, kill: (pid) => killed.push(pid) }
  });
  await assert.rejects(p, /timed out/);
  // The abandoned child must not be left running — that is the leak this module fixes.
  assert.deepEqual(killed, [4242]);
});

test('late output after settling cannot resolve or throw a second time', async () => {
  const child = fakeChild();
  const p = openTunnel(3847, { deps: { ...withCloudflared, spawn: () => child } });
  for (const line of BANNER_LINES) child.stderr.emit('data', Buffer.from(line));
  await p;
  // A long-running tunnel keeps logging after start; none of it may re-settle the
  // promise or hit a removed listener.
  child.stderr.emit('data', Buffer.from('INF connection established\n'));
  child.emit('exit', 0);
});

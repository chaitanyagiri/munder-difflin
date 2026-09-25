'use strict';

/**
 * Slack API calls must be hard-capped by a socket timeout.
 *
 * The bug it prevents: postSlackReply (src/main/slack.ts) and downloadSlackFile
 * (src/main/index.ts) issue raw `node:https` requests with NO timeout anywhere.
 * Node has no default socket timeout, so a peer that accepts the TCP/TLS
 * connection but never responds (stalled middlebox, network partition after
 * handshake) leaves the promise pending FOREVER — and the callers await it bare:
 *
 *   - pollSlackDoneTasks (src/main/index.ts) sets slackDonePolling = true, awaits
 *     postSlackReply, and resets the flag only in its finally — a never-settling
 *     promise wedges the 5s done-summary poller for the process lifetime;
 *   - the SlackReplyServer /reply handler awaits postSlackReply directly, so the
 *     agent's direct reply never answers;
 *   - onMessage awaits downloadSlackFiles AFTER the webhook already 200-acked
 *     Slack, so an inbound attachment message is acknowledged and then silently
 *     dropped.
 *
 * The transient-retry path the poller explicitly designed for ("will retry")
 * never runs: a stall produces no error at all. fetchText.ts already arms
 * req.setTimeout — this pins the same cap onto the Slack calls.
 *
 * postSlackReply is behaviorally tested here (slack.ts is deliberately free of
 * any electron import). downloadSlackFile lives in index.ts, which imports
 * electron and cannot load in a plain test — it is pinned by source checks, the
 * same approach test/update-check-timeout.test.cjs uses for updater.ts. The full
 * end-to-end stall scenario (poller wedge, /reply hang, acked-then-dropped
 * message) lives in test/repro/bug-12.repro.cjs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const https = require('node:https');
const net = require('node:net');
const loadTs = require('./load-ts.cjs');

const { postSlackReply } = loadTs('src/main/slack.ts');

// Generous on purpose: the fix's own timeout (12s, matching fetchText.ts) must
// clear this deadline. On the buggy code nothing settles, so the deadline only
// costs wall-clock, never flakes.
const CONTROL_DEADLINE_MS = 5_000;   // a responding endpoint answers in ms
const STALL_DEADLINE_MS = 25_000;    // > the 12s fix timeout

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

// ─── the fake Slack: answers (control) or STALLS after the handshake ────────
let stallMode = false;
const liveSockets = new Set();

/** Start the fake Slack TLS server; resolves once it is listening. */
function startFakeSlack() {
  return new Promise((resolve) => {
    const server = tls.createServer(
      { key: STALL_KEY, cert: STALL_CERT },
      (socket) => {
        liveSockets.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => liveSockets.delete(socket));
        socket.on('data', () => {
          if (stallMode) {
            // Request received — then NOTHING. No response, no FIN, no RST:
            // exactly the stalled-middlebox scenario the claim describes.
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

function replyOpts() {
  return { botToken: 'xoxb-test-token', channel: 'C1', thread_ts: '1.1', text: 'x' };
}

// Point the REAL client code at the fake Slack. slack.ts reaches `request`
// through the module object at call time, so patching the property redirects
// every request while leaving the request options intact (SNI stays slack.com).
const httpsModule = require('node:https');
const realRequest = httpsModule.request;
let fakeSlack = null;

test.before(async () => {
  fakeSlack = await startFakeSlack();
  httpsModule.request = function patchedRequest(opts, cb) {
    if (opts && typeof opts === 'object' && opts.hostname === 'slack.com') {
      opts = {
        ...opts,
        hostname: '127.0.0.1',
        port: fakeSlack.address().port,
        servername: opts.hostname,
        rejectUnauthorized: false
      };
    }
    return realRequest.call(httpsModule, opts, cb);
  };
});

test.after(() => {
  httpsModule.request = realRequest;
  for (const s of [...liveSockets]) { try { s.destroy(); } catch { /* noop */ } }
  try { httpsModule.globalAgent.destroy(); } catch { /* noop */ }
  try { fakeSlack?.close(); } catch { /* noop */ }
});

test('control: postSlackReply resolves {ok:true} against a responding Slack endpoint', async () => {
  stallMode = false;
  const res = await Promise.race([
    postSlackReply(replyOpts()),
    new Promise((_, rej) => setTimeout(() => rej(new Error('control endpoint never answered')), CONTROL_DEADLINE_MS))
  ]);
  assert.equal(res.ok, true, `a responding Slack must resolve ok:true, got ${JSON.stringify(res)}`);
});

test('postSlackReply SETTLES (ok:false) against a stalled connection', async () => {
  stallMode = true; // accept the connection, then send nothing — forever
  const started = Date.now();
  const state = await settleState(postSlackReply(replyOpts()), STALL_DEADLINE_MS);
  assert.equal(state, 'settled',
    `postSlackReply was still pending after ${STALL_DEADLINE_MS}ms against a stalled ` +
    `endpoint: with no timeout option and no req.setTimeout, Node's (absent) default ` +
    `socket timeout never fires, the promise never settles, and every caller that ` +
    `awaits it — the done-summary poller, the /reply handler — hangs forever`
  );
  // And it must come back as a transient failure (ok:false), not a resolution.
  const elapsed = Date.now() - started;
  assert.ok(elapsed < STALL_DEADLINE_MS, 'a settled result must arrive inside the deadline');
});

test('the settled result is a transient failure, so the poller retries', async () => {
  stallMode = true;
  const res = await Promise.race([
    postSlackReply(replyOpts()),
    new Promise((_, rej) => setTimeout(() => rej(new Error('never settled')), STALL_DEADLINE_MS))
  ]);
  assert.equal(res.ok, false, 'a timed-out post must be ok:false');
  assert.ok(res.error, `a timed-out post must carry an error (got ${JSON.stringify(res)}); ` +
    'the poller treats error-bearing failures as transient and retries the next tick');
});

test('downloadSlackFile arms a socket timeout (source check — index.ts imports electron)', () => {
  // index.ts cannot load in a plain test, so pin the fix in the source the same
  // way test/update-check-timeout.test.cjs pins updater.ts. A regression that
  // deletes the timeout must not pass silently; the full end-to-end download
  // stall lives in test/repro/bug-12.repro.cjs.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const fnStart = src.indexOf('function downloadSlackFile');
  assert.notStrictEqual(fnStart, -1, 'downloadSlackFile not found in src/main/index.ts');
  const body = src.slice(fnStart, src.indexOf('async function downloadSlackFiles', fnStart));
  assert.ok(
    /req\.setTimeout\(/.test(body) && /req\.destroy\(/.test(body),
    'downloadSlackFile must arm req.setTimeout and destroy the request on it; a ' +
    'stalled download never settles, and onMessage awaits it AFTER the webhook ' +
    'already 200-acked Slack — the inbound message is silently dropped'
  );
  const m = src.match(/const SLACK_DOWNLOAD_TIMEOUT_MS = ([0-9_]+);/);
  assert.ok(m, 'the download timeout must use a named constant, not a bare number');
  const ms = Number(m[1].replace(/_/g, ''));
  assert.ok(Number.isFinite(ms) && ms > 0 && ms <= 60_000,
    'the cap must be finite and sane (0 < ms <= 60s), or it is not really a cap');
});

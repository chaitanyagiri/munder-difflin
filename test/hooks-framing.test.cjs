'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { Notification: class { static isSupported() { return false; } } }
};

const { HookServer } = loadTs('src/main/hooks.ts');
const MAX_HOOK_FRAME_BYTES = 256 * 1024;
let socketSequence = 0;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function socketPath(base) {
  const id = `${process.pid}-${Date.now()}-${socketSequence++}`;
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\md-hooks-frame-${id}`
    : path.join(base, `hooks-${id}.sock`);
}

async function openServer(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hooks-frame-'));
  const sock = socketPath(base);
  const routed = [];
  const logs = [];
  const hive = {
    sockPath: () => sock,
    appendLog: (entry) => logs.push(entry)
  };
  const server = new HookServer(hive, () => null, () => ({ notifications: false }));

  // Exercise the real net.Server framing path while isolating these tests from
  // HookServer's unrelated routing behavior.
  server.handle = (payload) => {
    routed.push(payload);
    return {};
  };

  server.start();
  assert.ok(server.server, 'HookServer did not create its net.Server');
  if (!server.server.listening) await once(server.server, 'listening');

  t.after(() => {
    server.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { sock, routed, logs };
}

async function sendChunks(sock, chunks, pauseMs = 0, timeoutMs = 1000) {
  const socket = net.createConnection(sock);
  socket.on('error', () => { /* rejection may reset the client connection */ });
  await once(socket, 'connect');

  const response = [];
  socket.on('data', (chunk) => response.push(chunk));
  const closed = new Promise((resolve) => {
    socket.once('end', () => resolve(true));
    socket.once('close', () => resolve(true));
  });

  for (let i = 0; i < chunks.length; i += 1) {
    socket.write(chunks[i]);
    if (pauseMs > 0 && i < chunks.length - 1) await delay(pauseMs);
  }

  const didClose = await Promise.race([
    closed,
    delay(timeoutMs).then(() => false)
  ]);
  if (!didClose) socket.destroy();
  return { didClose, response: Buffer.concat(response).toString('utf8') };
}

function framedPayloadWithByteLength(byteLength) {
  const empty = Buffer.byteLength(JSON.stringify({ message: '' }), 'utf8');
  assert.ok(byteLength >= empty);
  const text = JSON.stringify({ message: 'x'.repeat(byteLength - empty) });
  assert.equal(Buffer.byteLength(text, 'utf8'), byteLength);
  return Buffer.from(`${text}\n`, 'utf8');
}

function splitInside(frame, character) {
  const start = frame.indexOf(Buffer.from(character, 'utf8'));
  assert.notEqual(start, -1, `test frame does not contain ${character}`);
  return start + 1;
}

test('CJK payload survives a split inside a multibyte code point', async (t) => {
  const { sock, routed } = await openServer(t);
  const payload = { message: '靽桀儔皜祈岫' };
  const frame = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  const split = splitInside(frame, '靽');

  const result = await sendChunks(sock, [frame.subarray(0, split), frame.subarray(split)], 25);

  assert.equal(result.didClose, true);
  assert.deepEqual(routed, [payload]);
});

test('emoji payload survives a split inside a four-byte code point', async (t) => {
  const { sock, routed } = await openServer(t);
  const payload = { message: 'deploy 🚀 ready' };
  const frame = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  const split = splitInside(frame, '🚀');

  const result = await sendChunks(sock, [frame.subarray(0, split), frame.subarray(split)], 25);

  assert.equal(result.didClose, true);
  assert.deepEqual(routed, [payload]);
});

test('ordinary fragmented frame retains existing one-request behavior', async (t) => {
  const { sock, routed } = await openServer(t);
  const payload = { hook_event_name: 'Stop', message: 'plain ASCII' };
  const frame = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');

  const result = await sendChunks(sock, [
    frame.subarray(0, 5),
    frame.subarray(5, 17),
    frame.subarray(17)
  ], 10);

  assert.equal(result.didClose, true);
  assert.deepEqual(routed, [payload]);
  assert.equal(result.response, '{}');
});

test('oversized incomplete frame is rejected without routing a payload', async (t) => {
  const { sock, routed, logs } = await openServer(t);

  const result = await sendChunks(sock, [Buffer.alloc(MAX_HOOK_FRAME_BYTES + 1, 0x78)], 0, 400);

  assert.equal(result.didClose, true, 'server retained an oversized incomplete frame');
  assert.deepEqual(routed, []);
  assert.equal(result.response, '');
  assert.deepEqual(logs, [{
    kind: 'hook-frame-rejected',
    reason: 'frame-too-large',
    bytes: MAX_HOOK_FRAME_BYTES + 1,
    limit: MAX_HOOK_FRAME_BYTES
  }]);
});

test('payload exactly at the byte limit is accepted', async (t) => {
  const { sock, routed } = await openServer(t);
  const frame = framedPayloadWithByteLength(MAX_HOOK_FRAME_BYTES);

  const result = await sendChunks(sock, [frame]);

  assert.equal(result.didClose, true);
  assert.equal(routed.length, 1);
  assert.equal(routed[0].message.length > 0, true);
  assert.equal(result.response, '{}');
});

test('payload one byte above the limit is rejected', async (t) => {
  const { sock, routed, logs } = await openServer(t);
  const frame = framedPayloadWithByteLength(MAX_HOOK_FRAME_BYTES + 1);

  const result = await sendChunks(sock, [frame]);

  assert.equal(result.didClose, true);
  assert.deepEqual(routed, []);
  assert.equal(result.response, '');
  assert.deepEqual(logs, [{
    kind: 'hook-frame-rejected',
    reason: 'frame-too-large',
    bytes: MAX_HOOK_FRAME_BYTES + 1,
    limit: MAX_HOOK_FRAME_BYTES
  }]);
});

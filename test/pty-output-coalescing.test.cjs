'use strict';

/**
 * PTY output used to reach the renderer one node-pty read at a time.
 *
 * `proc.onData` fires once per read, and an agent CLI redrawing its TUI emits a
 * long train of tiny writes. Each one became its own `pty:data:<id>` — a
 * structured clone, an IPC hop and a separate renderer main-thread task, per
 * chunk, for every live session at once, whether or not that terminal was even
 * on screen. Observed live on 2026-09-07: five agents, one of them pegged at
 * ~97% CPU for 25 minutes, and a window the compositor eventually declared
 * unresponsive.
 *
 * The fix coalesces a session's output into one message per frame. What it must
 * NOT do is change the stream, so these tests pin all four properties:
 *   1. a burst of chunks collapses into a single IPC message;
 *   2. the bytes and their order survive coalescing exactly;
 *   3. a large burst is flushed on size rather than held for the timer;
 *   4. output still precedes the exit banner — a process's dying words must not
 *      land after the "process exited" line.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const Module = require('node:module');

// node-pty is a native module rebuilt for Electron's ABI; electron itself is a
// binary. Neither is needed to exercise the buffering, so stub both.
let lastFake = null;
function makeFakeProc() {
  const proc = {
    pid: 4242,
    _data: null,
    _exit: null,
    onData(cb) { proc._data = cb; },
    onExit(cb) { proc._exit = cb; },
    write() {},
    resize() {},
    kill() {}
  };
  lastFake = proc;
  return proc;
}

const stubs = new Map([
  ['node-pty', { spawn: () => makeFakeProc() }],
  ['electron', { app: { getPath: () => os.tmpdir() } }]
]);
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (stubs.has(request)) return request;
  return origResolve.call(this, request, ...rest);
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (stubs.has(request)) return stubs.get(request);
  return origLoad.call(this, request, ...rest);
};

const loadTs = require('./load-ts.cjs');
const { PtyManager } = loadTs('src/main/pty.ts');

/** A stand-in for a window's webContents that just records what was sent. */
function recorder() {
  const sent = [];
  return { sent, isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) };
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/** Spawn one session against the fake pty. `node` is used because spawn()
 *  resolves the command for real before handing it to (stubbed) node-pty. */
function spawnSession(mgr, wc, id = 'sess-1') {
  const res = mgr.spawn({ id, cwd: os.tmpdir(), command: 'node' }, wc);
  assert.equal(res.ok, true, `spawn failed: ${res.error}`);
  assert.ok(lastFake && lastFake._data, 'expected the manager to subscribe to pty output');
  return lastFake;
}

test('a burst of chunks becomes ONE ipc message, bytes and order intact', async () => {
  const mgr = new PtyManager();
  const wc = recorder();
  const proc = spawnSession(mgr, wc);

  const chunks = ['\x1b[2J', 'Building', ' ', 'the', ' ', 'floor', '...\r\n'];
  for (const c of chunks) proc._data(c);

  assert.equal(wc.sent.length, 0, 'nothing is sent synchronously — that is the point');
  await tick(40);

  const data = wc.sent.filter((m) => m.channel === 'pty:data:sess-1');
  assert.equal(data.length, 1, `expected 1 coalesced message, got ${data.length}`);
  assert.equal(data[0].payload, chunks.join(''), 'coalescing must not alter the stream');
});

test('a large burst flushes on size instead of waiting for the timer', async () => {
  const mgr = new PtyManager();
  const wc = recorder();
  const proc = spawnSession(mgr, wc, 'big');

  // Over the 64 KiB threshold: a build log must not be held back by a frame timer.
  proc._data('x'.repeat(64 * 1024 + 1));
  const immediate = wc.sent.filter((m) => m.channel === 'pty:data:big');
  assert.equal(immediate.length, 1, 'an oversized burst is flushed at once');
  assert.equal(immediate[0].payload.length, 64 * 1024 + 1);
});

test("a process's dying output still precedes its exit banner", async () => {
  const mgr = new PtyManager();
  const wc = recorder();
  const proc = spawnSession(mgr, wc, 'dying');

  // The whole reason the tail is kept: the last bytes explain the death. They
  // are worthless if the terminal prints them after "process exited".
  proc._data('error: cannot find module\r\n');
  proc._exit({ exitCode: 1, signal: undefined });

  const channels = wc.sent.map((m) => m.channel);
  const dataAt = channels.indexOf('pty:data:dying');
  const exitAt = channels.indexOf('pty:exit:dying');
  assert.notEqual(dataAt, -1, 'buffered output must be flushed on exit, not dropped');
  assert.notEqual(exitAt, -1, 'the exit event must still be delivered');
  assert.ok(dataAt < exitAt, 'output must arrive before the exit banner');
  assert.equal(wc.sent[dataAt].payload, 'error: cannot find module\r\n');
});

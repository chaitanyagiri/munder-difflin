'use strict';

/**
 * End-to-end: a PTY whose process dies by SIGNAL must reach the exit handler
 * with that signal AND with the output it printed on the way out.
 *
 * The unit tests for `recordAgentExit` call it directly. This one drives the
 * real `PtyManager`, because the original defect was NOT in the recording — it
 * was that `signal` never left `pty.ts`. `onExit` had `{ exitCode, signal }` in
 * hand and forwarded only `exitCode`, so every caller downstream was blind to
 * signal deaths by construction.
 *
 * The scenario is the one observed live on 2026-08-24: a provider that prints
 * a panic and dies of SIGILL, which node-pty reports as exitCode 0 + signal 4.
 * An exitCode-only handler sees "0" and calls that a clean finish.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { PtyManager } = loadTs('src/main/pty.ts');

const POSIX = process.platform !== 'win32';

function waitForExit(mgr) {
  return new Promise((resolve) => {
    mgr.setExitHandler((id, exitCode, info) => resolve({ id, exitCode, info }));
  });
}

test('a SIGILL death forwards the signal and the output that explains it', { skip: !POSIX }, async () => {
  const mgr = new PtyManager();
  const done = waitForExit(mgr);

  // Print a recognisable banner, flush it, then kill ourselves with SIGILL —
  // the exact shape of the crash that motivated this change.
  const res = mgr.spawn({
    id: 'e2e-sigill',
    cwd: process.cwd(),
    command: '/bin/sh',
    args: ['-c', 'echo "panic(main thread): Illegal instruction"; sleep 0.2; kill -ILL $$']
  });
  assert.equal(res.ok, true, `spawn failed: ${res.error}`);

  const { id, exitCode, info } = await done;
  assert.equal(id, 'e2e-sigill');

  // THE REGRESSION GUARD: signal must survive the trip out of pty.ts.
  assert.equal(info.signal, 4, 'SIGILL (4) must be forwarded, not dropped');

  // And the exit code alone must NOT be what a caller keys on — this asserts
  // the very trap the old handler fell into.
  assert.notEqual(
    typeof info.signal === 'number' && info.signal !== 0 ? 'abnormal' : 'clean',
    'clean',
    'a signal death must not classify as clean'
  );

  assert.match(info.tail ?? '', /Illegal instruction/, 'the dying output must be captured');
  assert.equal(typeof info.command, 'string', 'the command must be passed by value');
  assert.ok((info.command ?? '').length > 0, 'the session is deleted before the handler, so command cannot be looked up later');
});

test('a clean exit reports no signal', { skip: !POSIX }, async () => {
  const mgr = new PtyManager();
  const done = waitForExit(mgr);

  const res = mgr.spawn({
    id: 'e2e-clean',
    cwd: process.cwd(),
    command: '/bin/sh',
    args: ['-c', 'echo done; exit 0']
  });
  assert.equal(res.ok, true, `spawn failed: ${res.error}`);

  const { exitCode, info } = await done;
  assert.equal(exitCode, 0);
  assert.ok(!info.signal, 'a clean exit must not report a signal');
});

test('a non-zero exit is reported as a code, not a signal', { skip: !POSIX }, async () => {
  const mgr = new PtyManager();
  const done = waitForExit(mgr);

  const res = mgr.spawn({
    id: 'e2e-code',
    cwd: process.cwd(),
    command: '/bin/sh',
    args: ['-c', 'echo "command not found"; exit 127']
  });
  assert.equal(res.ok, true, `spawn failed: ${res.error}`);

  const { exitCode, info } = await done;
  assert.equal(exitCode, 127);
  assert.ok(!info.signal);
  assert.match(info.tail ?? '', /command not found/);
});

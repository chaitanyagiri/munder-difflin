'use strict';

/**
 * Two auth-gating transients in active():
 *
 *  1. authenticated() is null both "no auth needed" (mempalace) AND "not
 *     probed yet" (lumberroom, before the first whoami). active() used to
 *     treat both the same way (`!== false`), so an agent spawned before the
 *     very first probe landed still got the semantic-memory prompt line and
 *     burned its first turn on a `lumberroom search` that exits 2.
 *     Fixed: fail closed — an auth-gated provider needs authenticated() ===
 *     true, not just "not yet known false".
 *
 *  2. A stale `false` (captured before a successful `lumberroom login` run
 *     outside the app) must be able to clear itself the next time a command
 *     actually runs and succeeds, not only on the next TTL-gated probe.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { MemoryManager } = loadTs('src/main/memory.ts');

function fakeCli(t, exitCode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-cli-'));
  const bin = path.join(dir, 'lumberroom');
  fs.writeFileSync(bin, `#!/bin/sh\nexit ${exitCode}\n`, { mode: 0o755 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return bin;
}

function managerWithLumberroom(t, bin) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-memory-'));
  const memory = new MemoryManager(() => home, () => ({ enabled: true, model: 'minilm', provider: 'lumberroom' }));
  memory.bin = () => bin;
  t.after(() => { memory.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  return memory;
}

test('an auth-gated provider is NOT active before its first probe (fails closed, not open)', (t) => {
  const memory = managerWithLumberroom(t, fakeCli(t, 0));

  assert.equal(memory.authenticated(), null, 'unprobed yet');
  assert.equal(memory.active(), false, 'must not spawn agents into a memory prompt that will fail');
});

test('an auth-gated provider becomes active once a probe confirms authenticated', async (t) => {
  const memory = managerWithLumberroom(t, fakeCli(t, 0));

  memory.refresh(); // fires probeAuth()
  const start = Date.now();
  while (memory.authenticated() !== true) {
    if (Date.now() - start > 5000) throw new Error('timed out waiting for probe');
    await new Promise((r) => setTimeout(r, 20));
  }

  assert.equal(memory.active(), true);
});

test('a provider with no auth block (mempalace) is unaffected — null never blocks it', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-memory-'));
  const memory = new MemoryManager(() => home, () => ({ enabled: true, model: 'minilm', provider: 'mempalace' }));
  memory.bin = () => '/fake/bin/mempalace';
  t.after(() => { memory.stop(); fs.rmSync(home, { recursive: true, force: true }); });

  assert.equal(memory.authenticated(), null, 'mempalace has no auth block');
  assert.equal(memory.active(), true, 'null must still mean active when there is nothing to authenticate');
});

test('a stale false auth cache clears the moment a command actually succeeds', async (t) => {
  const memory = managerWithLumberroom(t, fakeCli(t, 2)); // starts "unauthenticated"

  memory.refresh();
  const start = Date.now();
  while (memory.authenticated() !== false) {
    if (Date.now() - start > 5000) throw new Error('timed out waiting for probe');
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(memory.active(), false, 'stale false correctly blocks activity');

  // The user ran `lumberroom login` outside the app — swap in a CLI that now
  // succeeds, then run a real command through the manager's own search().
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-cli-'));
  const loggedInBin = path.join(dir, 'lumberroom');
  fs.writeFileSync(loggedInBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  memory.bin = () => loggedInBin;

  const result = await memory.search('anything');

  assert.equal(result.ok, true, 'search must actually run despite the stale false, not bail out');
  assert.equal(memory.authenticated(), true, 'the successful exit code cleared the stale false');
  assert.equal(memory.active(), true);
});

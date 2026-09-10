'use strict';

/**
 * tools:status called `memory.resetBinCache(); memory.status()` — status()
 * only ever READS authCache, never probes. probeAuth() is private and only
 * invoked from refresh(). SetupPanel/OnboardingWizard poll tools:status (not
 * hive:memoryStatus), so a fresh lumberroom install never got its first
 * whoami probe from that surface: authenticated stayed null forever and the
 * checklist read "installed — checking sign-in…" for the whole session.
 *
 * refresh() calls probeAuth() (fire-and-forget spawn, doesn't block) then
 * returns status() immediately — the probe resolves a moment later.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { MemoryManager } = loadTs('src/main/memory.ts');

/** A fake `lumberroom` whose `whoami` exits 0 (signed in). */
function fakeAuthedCli(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-cli-'));
  const bin = path.join(dir, 'lumberroom');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return bin;
}

function managerWithAuthProvider(t, bin) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-memory-'));
  const memory = new MemoryManager(() => home, () => ({ enabled: true, model: 'minilm', provider: 'lumberroom' }));
  memory.bin = () => bin;
  t.after(() => { memory.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  return memory;
}

async function waitFor(pred, timeoutMs = 5000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('status() alone never resolves authenticated — it only reads the cache, never probes', async (t) => {
  const memory = managerWithAuthProvider(t, fakeAuthedCli(t));

  memory.status();
  memory.status();
  memory.status();
  await new Promise((r) => setTimeout(r, 200)); // give a wrongly-firing probe time to land

  assert.equal(memory.status().authenticated, null, 'no probe was ever triggered');
});

test('refresh() triggers the auth probe without blocking, and it resolves shortly after', async (t) => {
  const memory = managerWithAuthProvider(t, fakeAuthedCli(t));

  const immediate = memory.refresh();
  assert.equal(immediate.authenticated, null, 'refresh returns synchronously — probe is fire-and-forget');

  await waitFor(() => memory.status().authenticated === true);
  assert.equal(memory.status().authenticated, true);
});

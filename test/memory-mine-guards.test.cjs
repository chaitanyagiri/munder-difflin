'use strict';

/**
 * AEON-1513: a corrupt chromadb compactor made an ordinary mine/search balloon
 * to 9-196GB before crashing. The rebuild fixed the known corruption; these two
 * guards are the app-side backstop against it (or anything shaped like it)
 * happening again:
 *   (a) mineNow() defers while the reactor's floor-wide release gate is held
 *       (hive/locks/browser.lock present) — a mine competing with a live gate
 *       tier for CPU/memory is exactly the contention AEON-1513 hit live.
 *   (b) each mine child gets a hard memory ceiling (16GB via polled `ps -o rss=`)
 *       so a future stuck backlog gets killed instead of ballooning unbounded.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const memoryModule = loadTs('src/main/memory.ts');
const { MemoryManager, readRssKb } = memoryModule;

function managerWithCli(t, opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-memory-guards-'));
  const state = { bin: opts.bin ?? '/fake/bin/mempalace', enabled: opts.enabled !== false };
  const memory = new MemoryManager(() => home, () => ({ enabled: state.enabled, model: 'minilm' }));
  memory.bin = () => state.bin;
  t.after(() => { memory.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  return { memory, state, home };
}

test('mineNow defers while the reactor release gate lock is present', async (t) => {
  const { memory, home } = managerWithCli(t);
  fs.mkdirSync(path.join(home, 'hive', 'agents', 'someone'), { recursive: true });
  fs.writeFileSync(path.join(home, 'hive', 'agents', 'someone', 'memory.md'), 'hi');
  fs.mkdirSync(path.join(home, 'hive', 'locks'), { recursive: true });
  fs.writeFileSync(path.join(home, 'hive', 'locks', 'browser.lock'), '{"holder":"Dwight"}');

  let mined = false;
  memory.mineAgent = () => { mined = true; return Promise.resolve(); };

  await memory.mineNow();

  assert.equal(mined, false, 'a live-looking gate must defer the whole pass');
});

test('mineNow proceeds normally once the gate lock is gone', async (t) => {
  const { memory, home } = managerWithCli(t);
  fs.mkdirSync(path.join(home, 'hive', 'agents', 'someone'), { recursive: true });
  fs.writeFileSync(path.join(home, 'hive', 'agents', 'someone', 'memory.md'), 'hi');
  // No hive/locks/browser.lock at all — the common case.

  let mined = 0;
  memory.mineAgent = () => { mined += 1; return Promise.resolve(); };

  await memory.mineNow();

  assert.equal(mined, 1, 'no gate present — the pass must run');
});

test('gateHeld is a bare existence check (no liveness parsing)', (t) => {
  const { memory, home } = managerWithCli(t);
  const lockDir = path.join(home, 'hive', 'locks');
  fs.mkdirSync(lockDir, { recursive: true });

  assert.equal(memory.gateHeld(home), false, 'nothing written yet');

  fs.writeFileSync(path.join(lockDir, 'browser.lock'), 'not even valid json');
  assert.equal(memory.gateHeld(home), true, 'existence alone is the signal, garbage contents included');
});

test('readRssKb parses a real ps rss= line for the current process', () => {
  const rssKb = readRssKb(process.pid);

  assert.equal(typeof rssKb, 'number');
  assert.ok(rssKb > 0, 'this test process itself has nonzero resident memory');
});

test('readRssKb returns null for a pid that does not exist', () => {
  // A pid that (almost certainly) never exists — ps exits nonzero, no rss= line.
  assert.equal(readRssKb(999999), null);
});

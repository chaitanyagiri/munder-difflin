'use strict';

/**
 * AEON-1487: commit() now measures queue-entry-to-settle latency and warns + samples on a
 * breach. Confirms the watchdog fires when latency crosses the threshold and stays silent
 * when it doesn't, without needing a real slow git call or a real `sample` binary.
 *
 * Consolidated onto the AEON-1522/1523 architecture (AEON-1576): `commit()` is fire-and-forget
 * (`void`, not `Promise<void>` — the pathspec follow-up moved it back to that shape) and the
 * queue-drain method is `flushGit()`, not this card's original `flushCommits()` name. `captureWarn`
 * below fires `commit()` then awaits `flushGit()` to observe completion, instead of awaiting
 * `commit()`'s own return value.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-commit-latency-'));
}

function captureWarn(fn) {
  const lines = [];
  const orig = console.warn;
  console.warn = (...args) => { lines.push(args.join(' ')); };
  return Promise.resolve(fn()).finally(() => { console.warn = orig; }).then(() => lines);
}

test('a fast commit does not warn or sample', async (t) => {
  const home = tmpHome();
  const hive = new HiveManager(() => home);
  t.after(async () => {
    await hive.flushGit();
    fs.rmSync(home, { recursive: true, force: true });
  });
  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });

  const lines = await captureWarn(async () => { hive.commit('fast commit'); await hive.flushGit(); });
  assert.equal(lines.some((l) => l.includes('AEON-1487')), false, 'a normal-speed commit must not warn');
});

test('a slow commit warns exactly once and does not throw', async (t) => {
  const home = tmpHome();
  const hive = new HiveManager(() => home);
  t.after(async () => {
    await hive.flushGit();
    fs.rmSync(home, { recursive: true, force: true });
  });
  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });
  // ensureAgent's own commit() call is fire-and-forget (none of the 9 call sites await it,
  // by design) -- drain it through the REAL doCommit before overriding, or a still-queued
  // earlier commit can pick up the slow override too and warn for the wrong reason.
  await hive.flushGit();

  // Simulate the queue latency AEON-1487 measures without needing a genuinely slow git call:
  // doCommit is a plain overridable property at runtime (same pattern as
  // proxy-bridge-retry.test.cjs's hive.startProxyBridge override).
  const realDoCommit = hive.doCommit.bind(hive);
  hive.doCommit = async (message) => {
    await new Promise((r) => setTimeout(r, 1100));
    return realDoCommit(message);
  };

  const lines = await captureWarn(async () => { hive.commit('slow commit'); await hive.flushGit(); });
  const warnLines = lines.filter((l) => l.includes('AEON-1487'));
  assert.equal(warnLines.length, 1, 'exactly one breach warning per slow commit');
  assert.match(warnLines[0], /commit queue latency \d+ms exceeds 1000ms/);
});

test('two slow commits inside the sample cooldown warn twice but only sample once', async (t) => {
  const home = tmpHome();
  const hive = new HiveManager(() => home);
  t.after(async () => {
    await hive.flushGit();
    fs.rmSync(home, { recursive: true, force: true });
  });
  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });
  await hive.flushGit();

  const realDoCommit = hive.doCommit.bind(hive);
  hive.doCommit = async (message) => {
    await new Promise((r) => setTimeout(r, 1050));
    return realDoCommit(message);
  };

  const lines1 = await captureWarn(async () => { hive.commit('slow 1'); await hive.flushGit(); });
  const lines2 = await captureWarn(async () => { hive.commit('slow 2'); await hive.flushGit(); });
  const all = [...lines1, ...lines2].filter((l) => l.includes('AEON-1487'));
  assert.equal(all.length, 2, 'both breaches still warn -- the cooldown is on sampling, not on the warning');

  // The sample itself is best-effort and fire-and-forget (may fail silently if `sample` is
  // unavailable), so this only checks the diagnostics dir gets created at most once worth of
  // activity -- absence is fine on a non-macOS CI box, presence must not mean "sampled twice".
  const diagDir = path.join(home, 'hive', 'diagnostics');
  if (fs.existsSync(diagDir)) {
    const files = fs.readdirSync(diagDir).filter((f) => f.includes('commit-latency'));
    assert.ok(files.length <= 1, `cooldown must prevent a second sample within 60s, got ${files.length}`);
  }
});

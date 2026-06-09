'use strict';

const assert = require('assert');
const { CompactGate, DEFAULT_THRESHOLD, DEFAULT_COOLDOWN_MS, DEFAULT_REFRESH_AFTER_FIRES } =
  require('../src/main/compact-gate.cjs');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${name}\n     ${err.message}`);
  }
}

(async () => {
  console.log('compact gate tests (COMPACT PROTOCOL)');

  // ─── Defaults ──────────────────────────────────────────────────────────────

  await test('exported defaults match spec', async () => {
    assert.strictEqual(DEFAULT_THRESHOLD, 0.50);
    assert.strictEqual(DEFAULT_COOLDOWN_MS, 90_000);
    assert.strictEqual(DEFAULT_REFRESH_AFTER_FIRES, 3);
  });

  // ─── Feature flag ──────────────────────────────────────────────────────────

  await test('disabled gate → always skip regardless of context %', async () => {
    const g = new CompactGate({ enabled: false });
    assert.strictEqual(g.check('a', 1.0), 'skip');
    assert.strictEqual(g.check('a', 0.99), 'skip');
  });

  // ─── 50% threshold ─────────────────────────────────────────────────────────

  await test('below threshold → skip', async () => {
    const g = new CompactGate({ enabled: true, threshold: 0.50 });
    assert.strictEqual(g.check('a', 0.49), 'skip');
  });

  await test('exactly at threshold → compact', async () => {
    const g = new CompactGate({ enabled: true, threshold: 0.50 });
    assert.strictEqual(g.check('a', 0.50), 'compact');
  });

  await test('above threshold → compact', async () => {
    const g = new CompactGate({ enabled: true, threshold: 0.50 });
    assert.strictEqual(g.check('a', 0.80), 'compact');
  });

  // ─── Single-flight ─────────────────────────────────────────────────────────

  await test('second check while pending → blocked (single-flight)', async () => {
    const g = new CompactGate({ enabled: true, threshold: 0.50 });
    assert.strictEqual(g.check('a', 0.75), 'compact');
    assert.strictEqual(g.check('a', 0.80), 'blocked');
    assert.strictEqual(g.check('a', 0.99), 'blocked');
  });

  await test('different agents are independent (single-flight is per-agent)', async () => {
    const g = new CompactGate({ enabled: true, threshold: 0.50 });
    assert.strictEqual(g.check('a', 0.75), 'compact');
    assert.strictEqual(g.check('b', 0.75), 'compact'); // 'b' not blocked by 'a'
    assert.strictEqual(g.check('a', 0.80), 'blocked'); // 'a' still blocked
  });

  // ─── Dedup cooldown across services ────────────────────────────────────────

  await test('cooldown blocks all services after compacted', async () => {
    const g = new CompactGate({ enabled: true, threshold: 0.50, cooldownMs: 300 });
    g.check('a', 0.75);          // puts in pending
    g.onCompacted('a');           // clears pending, starts 300ms cooldown
    assert.ok(g.isBlocked('a'), 'blocked immediately after compacted');
    assert.strictEqual(g.check('a', 0.75), 'blocked', 'check returns blocked during cooldown');
  });

  await test('cooldown expires → not blocked', async () => {
    const g = new CompactGate({ enabled: true, threshold: 0.50, cooldownMs: 100 });
    g.check('a', 0.75);
    g.onCompacted('a');
    await sleep(150);
    assert.ok(!g.isBlocked('a'), 'not blocked after cooldown expires');
    assert.strictEqual(g.check('a', 0.75), 'compact', 'can compact again after cooldown');
  });

  await test('isBlocked returns false when not pending and no cooldown', async () => {
    const g = new CompactGate({ enabled: true, threshold: 0.50 });
    assert.ok(!g.isBlocked('a'));
  });

  // ─── 3-fire → REFRESH escalation ───────────────────────────────────────────

  await test('fires 1 and 2 produce compact, fire 3 produces refresh', async () => {
    const g = new CompactGate({ enabled: true, threshold: 0.50, cooldownMs: 0, refreshAfterFires: 3 });
    assert.strictEqual(g.check('a', 0.75), 'compact', 'fire 1');
    g.onCompacted('a');
    assert.strictEqual(g.check('a', 0.75), 'compact', 'fire 2');
    g.onCompacted('a');
    assert.strictEqual(g.check('a', 0.75), 'refresh', 'fire 3 → REFRESH');
  });

  await test('counter continues after refresh: fires 4,5 compact, fire 6 refresh', async () => {
    const g = new CompactGate({ enabled: true, threshold: 0.50, cooldownMs: 0, refreshAfterFires: 3 });
    // fires 1–3
    g.check('a', 0.75); g.onCompacted('a');
    g.check('a', 0.75); g.onCompacted('a');
    g.check('a', 0.75); g.onCompacted('a'); // fire 3 = refresh
    // fires 4–6
    assert.strictEqual(g.check('a', 0.75), 'compact', 'fire 4');
    g.onCompacted('a');
    assert.strictEqual(g.check('a', 0.75), 'compact', 'fire 5');
    g.onCompacted('a');
    assert.strictEqual(g.check('a', 0.75), 'refresh', 'fire 6 → REFRESH');
  });

  // ─── Counter reset on context drop ─────────────────────────────────────────

  await test('context drops to threshold/2 → fire counter resets', async () => {
    const g = new CompactGate({ enabled: true, threshold: 0.50, cooldownMs: 0, refreshAfterFires: 3 });
    // Two fires (fires 1 and 2 — next would be refresh on 3)
    g.check('a', 0.75); g.onCompacted('a');
    g.check('a', 0.75); g.onCompacted('a');
    // Context drops well below threshold (< 0.25)
    g.check('a', 0.20); // should reset counter and return 'skip'
    // Now the counter is reset — next three fires should be 1,2,compact then 3=refresh
    assert.strictEqual(g.check('a', 0.75), 'compact', 'fire 1 after reset');
    g.onCompacted('a');
    assert.strictEqual(g.check('a', 0.75), 'compact', 'fire 2 after reset');
    g.onCompacted('a');
    assert.strictEqual(g.check('a', 0.75), 'refresh', 'fire 3 after reset → REFRESH');
  });

  await test('context between threshold/2 and threshold → no counter reset', async () => {
    const g = new CompactGate({ enabled: true, threshold: 0.50, cooldownMs: 0, refreshAfterFires: 3 });
    g.check('a', 0.75); g.onCompacted('a'); // fire 1
    g.check('a', 0.75); g.onCompacted('a'); // fire 2
    // Context drops to 30% — above threshold/2 (25%) so no reset
    g.check('a', 0.30); // skip, but no reset
    assert.strictEqual(g.check('a', 0.75), 'refresh', 'fire 3 without reset → REFRESH');
  });

  // ─── remove() cleans up all state ──────────────────────────────────────────

  await test('remove clears pending, cooldown, and fire count', async () => {
    const g = new CompactGate({ enabled: true, threshold: 0.50, cooldownMs: 10_000, refreshAfterFires: 3 });
    g.check('a', 0.75); // pending + fire 1
    g.onCompacted('a'); // cooldown active
    g.remove('a');
    assert.ok(!g.isBlocked('a'), 'not blocked after remove');
    assert.strictEqual(g.check('a', 0.75), 'compact', 'fire 1 again (counter reset by remove)');
  });

  // ─── Summary ───────────────────────────────────────────────────────────────

  console.log(failures === 0 ? '\nall passed' : `\n${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
})();

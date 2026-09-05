'use strict';
/**
 * Circuit-breaker policy tests. Self-contained, no test framework — run with
 * `node test/breaker.test.cjs` (mirrors test/agent-provider.test.cjs). breaker.ts
 * only has type-only imports, so it transpiles standalone with the bundled
 * `typescript` compiler.
 *
 * Focus: the no-progress false-positive fixes (upstream issue #109 + fleet
 * evidence — compaction / inbox-ack bursts and background work tripping
 * "no-progress: generating tokens without coordinating"):
 *   1. compaction exemption — PreCompact→PostCompact (with safety cap) skips the
 *      Δoutput-based trips;
 *   2. recent DISTINCT tool activity counts as progress (an agent running varied
 *      tools is working — true loops are still caught by repeatedToolLimit);
 *   3. the no-progress arm requires 2 consecutive tripping beats (debounce) so a
 *      one-beat blip never fires a steer.
 * Plus regression guards for the pre-existing trips (loop, error storm, velocity).
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const SRC = path.join(__dirname, '..', 'src', 'main', 'breaker.ts');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-'));
const js = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
fs.writeFileSync(path.join(out, 'breaker.js'), js, 'utf8');
const { CircuitBreaker } = require(path.join(out, 'breaker.js'));

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

/** A breaker with fixed config (no caps, hardStop off). */
function makeBreaker(over = {}) {
  return new CircuitBreaker(() => ({
    enabled: true, hardStop: false, repeatedToolLimit: 8, errorStormLimit: 5,
    tokenVelocityPerMin: 60000, ...over
  }));
}

/** Cumulative sample helper. */
function sample(agentId, ts, output, input = 1000) {
  return { agentId, sessionId: 's1', ts, input, output, cacheRead: 0, cacheCreation: 0, model: 'm', usd: 0 };
}

const T0 = 1_000_000_000_000; // fixed epoch base so tests are deterministic
const BEAT = 30_000;

/** Run one beat for a single agent; returns its decision. */
function beat(b, id, s, progressing, now) {
  return b.tick([{ agentId: id, sample: s, progressing }], now)[0];
}

// ── regression: pre-existing trips still fire ────────────────────────────────

test('repeated identical tool calls trip the loop arm', () => {
  const b = makeBreaker();
  for (let i = 0; i < 8; i++) b.recordToolUse('a', 'Bash', { cmd: 'same' });
  const d = beat(b, 'a', null, true, T0);
  assert.equal(d.state.level, 'steering');
  assert.match(d.state.reason, /looping/);
});

test('error storm trips', () => {
  const b = makeBreaker();
  for (let i = 0; i < 5; i++) b.recordError('a');
  const d = beat(b, 'a', null, true, T0);
  assert.equal(d.state.level, 'steering');
  assert.match(d.state.reason, /error storm/);
});

test('token velocity spike trips on the second sample', () => {
  const b = makeBreaker();
  beat(b, 'a', sample('a', T0, 0), true, T0);
  const d = beat(b, 'a', sample('a', T0 + BEAT, 40_000), true, T0 + BEAT); // 80k/min
  assert.equal(d.state.level, 'steering');
  assert.match(d.state.reason, /velocity/);
});

// ── fix 3: no-progress needs 2 consecutive tripping beats ───────────────────

test('no-progress does NOT trip on a single beat (debounce)', () => {
  const b = makeBreaker();
  beat(b, 'a', sample('a', T0, 0), false, T0);
  const d = beat(b, 'a', sample('a', T0 + BEAT, 500), false, T0 + BEAT);
  assert.equal(d.state.level, 'healthy', `reason: ${d.state.reason}`);
});

test('sustained no-progress still trips (second consecutive beat)', () => {
  const b = makeBreaker();
  beat(b, 'a', sample('a', T0, 0), false, T0);
  beat(b, 'a', sample('a', T0 + BEAT, 500), false, T0 + BEAT);
  const d = beat(b, 'a', sample('a', T0 + 2 * BEAT, 1000), false, T0 + 2 * BEAT);
  assert.equal(d.state.level, 'steering');
  assert.match(d.state.reason, /no-progress/);
});

test('a progressing beat resets the no-progress debounce', () => {
  const b = makeBreaker();
  beat(b, 'a', sample('a', T0, 0), false, T0);
  beat(b, 'a', sample('a', T0 + BEAT, 500), false, T0 + BEAT);       // count 1
  beat(b, 'a', sample('a', T0 + 2 * BEAT, 600), true, T0 + 2 * BEAT); // reset
  const d = beat(b, 'a', sample('a', T0 + 3 * BEAT, 1100), false, T0 + 3 * BEAT); // count 1 again
  assert.equal(d.state.level, 'healthy', `reason: ${d.state.reason}`);
});

// ── fix 1: compaction exemption ──────────────────────────────────────────────

test('compaction exempts the no-progress trip', () => {
  const b = makeBreaker();
  beat(b, 'a', sample('a', T0, 0), false, T0);
  b.recordCompactStart('a', T0 + 1);
  // Two beats of token burst with stale coordination — would trip without the fix.
  beat(b, 'a', sample('a', T0 + BEAT, 5000), false, T0 + BEAT);
  const d = beat(b, 'a', sample('a', T0 + 2 * BEAT, 9000), false, T0 + 2 * BEAT);
  assert.equal(d.state.level, 'healthy', `reason: ${d.state.reason}`);
});

test('compaction exempts the velocity trip', () => {
  const b = makeBreaker();
  beat(b, 'a', sample('a', T0, 0), true, T0);
  b.recordCompactStart('a', T0 + 1);
  const d = beat(b, 'a', sample('a', T0 + BEAT, 40_000), true, T0 + BEAT); // 80k/min burst
  assert.equal(d.state.level, 'healthy', `reason: ${d.state.reason}`);
});

test('trips resume after compaction end + trailing grace', () => {
  const b = makeBreaker();
  const GRACE = 120_000; // must cover POST_COMPACT_GRACE_MS
  beat(b, 'a', sample('a', T0, 0), false, T0);
  b.recordCompactStart('a', T0 + 1);
  b.recordCompactEnd('a', T0 + 2);
  const t1 = T0 + GRACE + BEAT;
  const t2 = t1 + BEAT;
  beat(b, 'a', sample('a', t1, 5000), false, t1);
  const d = beat(b, 'a', sample('a', t2, 6000), false, t2);
  assert.equal(d.state.level, 'steering', `reason: ${d.state.reason}`);
});

test('compaction safety cap: exemption expires even without PostCompact', () => {
  const b = makeBreaker();
  const CAP = 10 * 60_000; // must exceed COMPACT_GRACE_MS
  beat(b, 'a', sample('a', T0, 0), false, T0);
  b.recordCompactStart('a', T0 + 1); // PostCompact never arrives
  const t1 = T0 + CAP + BEAT;
  const t2 = t1 + BEAT;
  beat(b, 'a', sample('a', t1, 5000), false, t1);
  const d = beat(b, 'a', sample('a', t2, 6000), false, t2);
  assert.equal(d.state.level, 'steering', `reason: ${d.state.reason}`);
});

test('recordCompactEnd without a compaction in flight is a no-op', () => {
  const b = makeBreaker();
  beat(b, 'a', sample('a', T0, 0), false, T0);
  b.recordCompactEnd('a', T0 + 1); // e.g. SessionStart on a fresh session
  beat(b, 'a', sample('a', T0 + BEAT, 500), false, T0 + BEAT);
  const d = beat(b, 'a', sample('a', T0 + 2 * BEAT, 1000), false, T0 + 2 * BEAT);
  assert.equal(d.state.level, 'steering', `reason: ${d.state.reason}`); // still trips normally
});

// ── #376: a live human conversation counts as progress ──────────────────────
// A conversation is prose in, prose out — no hive files, no tool spans — and
// the measured incidents fired 19s and 30s after an operator prompt, while the
// file-based progress signal had been stale for over an hour.

test('a recent human prompt exempts the no-progress trip (mid-conversation)', () => {
  const b = makeBreaker();
  beat(b, 'a', sample('a', T0, 0), false, T0);
  // The incident shape: operator prompts ~30s before each beat; the agent
  // answers in prose (Δoutput > 0) and touches nothing else.
  b.recordUserPrompt('a', T0 + BEAT - 30_000);
  beat(b, 'a', sample('a', T0 + BEAT, 800), false, T0 + BEAT);
  b.recordUserPrompt('a', T0 + 2 * BEAT - 19_000);
  const d = beat(b, 'a', sample('a', T0 + 2 * BEAT, 1600), false, T0 + 2 * BEAT);
  assert.equal(d.state.level, 'healthy', `reason: ${d.state.reason}`);
});

test('one prompt covers a long answer for the whole progress window', () => {
  const b = makeBreaker();
  beat(b, 'a', sample('a', T0, 0), false, T0);
  b.recordUserPrompt('a', T0 + 1000); // one question, then a long prose answer
  for (let i = 1; i <= 9; i++) { // 9 beats = 4.5 min, inside the 300s window
    const t = T0 + i * BEAT;
    const d = beat(b, 'a', sample('a', t, i * 700), false, t);
    assert.equal(d.state.level, 'healthy', `beat ${i}: ${d.state.reason}`);
  }
});

test('the conversation clock EXPIRES: a stale prompt does not blind the arm', () => {
  const b = makeBreaker();
  beat(b, 'a', sample('a', T0, 0), false, T0);
  b.recordUserPrompt('a', T0); // one prompt, then the agent burns tokens alone
  const t1 = T0 + 320_000;     // past the 300s window
  const t2 = t1 + BEAT;
  beat(b, 'a', sample('a', t1, 5000), false, t1);
  const d = beat(b, 'a', sample('a', t2, 6000), false, t2);
  assert.equal(d.state.level, 'steering', `reason: ${d.state.reason}`);
});

test('a human prompt does not exempt the loop, error-storm, or velocity arms', () => {
  const b = makeBreaker();
  b.recordUserPrompt('a', T0 - 1000);
  for (let i = 0; i < 8; i++) b.recordToolUse('a', 'Bash', { cmd: 'same' });
  assert.equal(beat(b, 'a', null, true, T0).state.level, 'steering'); // loop still trips

  const b2 = makeBreaker();
  b2.recordUserPrompt('a', T0 - 1000);
  beat(b2, 'a', sample('a', T0, 0), true, T0);
  const d = beat(b2, 'a', sample('a', T0 + BEAT, 40_000), true, T0 + BEAT); // 80k/min
  assert.equal(d.state.level, 'steering', `reason: ${d.state.reason}`); // velocity still trips
});

// ── fix 2: recent distinct tool activity counts as progress ─────────────────

test('recent distinct tool calls exempt the no-progress trip', () => {
  const b = makeBreaker();
  beat(b, 'a', sample('a', T0, 0), false, T0);
  // Varied tool stream (background workflow / interactive work) right before each beat.
  b.recordToolUse('a', 'Read', { file: 'x' }, T0 + BEAT - 1000);
  beat(b, 'a', sample('a', T0 + BEAT, 5000), false, T0 + BEAT);
  b.recordToolUse('a', 'Read', { file: 'y' }, T0 + 2 * BEAT - 1000);
  const d = beat(b, 'a', sample('a', T0 + 2 * BEAT, 9000), false, T0 + 2 * BEAT);
  assert.equal(d.state.level, 'healthy', `reason: ${d.state.reason}`);
});

test('REPEATED identical tool calls do not count as progress', () => {
  const b = makeBreaker();
  b.recordToolUse('a', 'Bash', { cmd: 'same' }, T0 - 10 * 60_000); // distinct stamp long ago
  beat(b, 'a', sample('a', T0, 0), false, T0);
  b.recordToolUse('a', 'Bash', { cmd: 'same' }, T0 + BEAT - 1000); // repeat — no fresh stamp
  beat(b, 'a', sample('a', T0 + BEAT, 500), false, T0 + BEAT);
  b.recordToolUse('a', 'Bash', { cmd: 'same' }, T0 + 2 * BEAT - 1000);
  const d = beat(b, 'a', sample('a', T0 + 2 * BEAT, 1000), false, T0 + 2 * BEAT);
  assert.equal(d.state.level, 'steering', `reason: ${d.state.reason}`);
  assert.match(d.state.reason, /no-progress/);
});

// ── toolKey stays cheap AND discriminating on huge inputs ────────────────────

test('huge identical Write inputs still register as repeats (loop arm)', () => {
  const b = makeBreaker();
  const huge = { file_path: '/x.txt', content: 'A'.repeat(1_000_000) };
  for (let i = 0; i < 8; i++) b.recordToolUse('a', 'Write', huge);
  const d = beat(b, 'a', null, true, T0);
  assert.equal(d.state.level, 'steering');
  assert.match(d.state.reason, /looping/);
});

test('huge inputs differing early still count as distinct calls', () => {
  const b = makeBreaker();
  for (let i = 0; i < 8; i++) {
    b.recordToolUse('a', 'Write', { file_path: `/f${i}.txt`, content: 'A'.repeat(500_000) });
  }
  const d = beat(b, 'a', null, true, T0);
  assert.equal(d.state.level, 'healthy', `reason: ${d.state.reason}`);
});

// ── recovery still works ─────────────────────────────────────────────────────

test('a healthy beat de-escalates one level', () => {
  const b = makeBreaker();
  for (let i = 0; i < 8; i++) b.recordToolUse('a', 'Bash', { cmd: 'same' });
  beat(b, 'a', null, true, T0);                       // → steering
  b.recordToolUse('a', 'Read', { file: 'new' });       // distinct call clears the loop
  const d = beat(b, 'a', null, true, T0 + BEAT);
  assert.equal(d.state.level, 'healthy');
});

process.exit(failures ? 1 : 0);

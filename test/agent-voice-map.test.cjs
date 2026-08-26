'use strict';

/**
 * Per-agent Talk — the voice MAP invariants.
 *
 * Every agent should sound different and consistent: god is always `cedar`, each
 * known worker has its own hand-picked voice, and no two agents on the current roster
 * collide. Like the scope test, `agentVoice.ts` pulls the realtime SDK / store, so it
 * can't be `require`d in a plain node test — we pin the map by parsing its source
 * literals, which fails loudly if the pool or the hand-picks regress.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const read = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8');
const agentVoice = read('src/renderer/src/realtime/agentVoice.ts');
const session = read('src/renderer/src/realtime/session.ts');

// OpenAI's documented gpt-realtime voice set (the model the app targets).
const GPT_REALTIME_VOICES = new Set([
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'cedar', 'marin'
]);

// --- parse the source literals -------------------------------------------------

const poolMatch = agentVoice.match(/WORKER_VOICE_POOL\s*=\s*\[([\s\S]*?)\]/);
assert.ok(poolMatch, 'WORKER_VOICE_POOL array literal must exist');
const pool = [...poolMatch[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);

const handpickMatch = agentVoice.match(/HANDPICK[^{]*\{([\s\S]*?)\}/);
assert.ok(handpickMatch, 'HANDPICK object literal must exist');
const handpick = {};
for (const m of handpickMatch[1].matchAll(/(\w+)\s*:\s*'([a-z]+)'/g)) handpick[m[1]] = m[2];

// --- god is always cedar; workers never are ------------------------------------

test('god keeps cedar and no worker ever does', () => {
  assert.ok(/GOD_VOICE\s*=\s*'cedar'/.test(agentVoice), 'GOD_VOICE must be cedar');
  assert.ok(session.includes("const REALTIME_VOICE = 'cedar'"), "god's session voice stays cedar");
  assert.ok(!pool.includes('cedar'), 'the worker pool must not contain cedar');
  assert.ok(
    !Object.values(handpick).includes('cedar'),
    'no hand-picked worker voice may be cedar'
  );
});

// --- the pool is real, and workers pick from it --------------------------------

test('the worker pool is valid gpt-realtime voices and is actually used', () => {
  assert.ok(pool.length >= 5, 'the pool needs enough voices to keep agents distinct');
  for (const v of pool) assert.ok(GPT_REALTIME_VOICES.has(v), `'${v}' is not a gpt-realtime voice`);
  assert.strictEqual(new Set(pool).size, pool.length, 'the pool has no duplicate voices');
  assert.ok(/export function voiceForAgent\b/.test(agentVoice), 'voiceForAgent(target) must exist');
  assert.ok(
    session.includes('voiceForAgent(tgt)'),
    'the worker connect path must choose its voice via voiceForAgent(tgt)'
  );
});

// --- hand-picks: known agents distinct, drawn from the pool --------------------

test('known agents have distinct, appropriate, in-pool voices (no roster collision)', () => {
  for (const who of ['jim', 'pam', 'dwight', 'oscar', 'angela']) {
    assert.ok(handpick[who], `roster agent '${who}' must have a hand-picked voice`);
    assert.ok(pool.includes(handpick[who]), `'${who}' -> '${handpick[who]}' must be a pool voice`);
  }
  assert.strictEqual(handpick.pam, 'marin', 'Pam keeps the marin voice she shipped with');
  assert.notStrictEqual(handpick.jim, handpick.pam, 'Jim and Pam must not sound the same');
  const vals = Object.values(handpick);
  assert.strictEqual(new Set(vals).size, vals.length, 'hand-picked voices collide — the current roster would clash');
});

// --- determinism: same agent -> same voice, always -----------------------------

test('the mapping is deterministic (no Date / Math.random)', () => {
  const fnStart = agentVoice.indexOf('function hashString');
  const region = agentVoice.slice(fnStart, agentVoice.indexOf('export function voiceForAgent') + 400);
  assert.ok(!/Math\.random|Date\.now|new Date/.test(region), 'voice choice must be stable across sessions');
});

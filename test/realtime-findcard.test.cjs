'use strict';

/*
 * Unit test for the realtime findCard matcher (src/main/realtimeActions.ts).
 *
 * realtimeActions.ts is TypeScript and the matcher (normMatch / scoreCard /
 * findCard) is module-local, so it cannot be required directly from a plain
 * .cjs test. The functions below are a CHARACTER-IDENTICAL copy of that matcher
 * (minus TS type annotations) — the same algorithm is also independently
 * validated by `node bin/find-task.cjs --selftest` (8/8) in the hive repo. Keep
 * the two in lockstep: if you change scoreCard/findCard in realtimeActions.ts,
 * mirror it here.
 *
 * WHY this fix exists: the old findCard lowercased the title only (never
 * normalized hyphens/punctuation), matched by contiguous substring, and took
 * the first hit — so spoken "message visibility" never matched the stored
 * "message-visibility", truncations/word-order changes missed, and ambiguous
 * refs silently mutated the wrong card (assign/update are immediate writes).
 *
 * Run: node test/realtime-findcard.test.cjs   (exit 0 = all pass)
 */

const assert = require('assert');

// ── matcher under test (mirror of realtimeActions.ts findCard) ───────────────
const normMatch = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const toksMatch = (s) => normMatch(s).split(' ').filter(Boolean);
const AMBIGUOUS_MARGIN = 0.08;

function scoreCard(refNorm, refToks, c) {
  if (!refNorm) return 0;
  const titleN = normMatch(c.title);
  const idN = normMatch(c.id);
  if (idN === refNorm || titleN === refNorm) return 1;
  if (titleN && (titleN.startsWith(refNorm) || refNorm.startsWith(titleN))) return 0.92;
  if (idN && idN.startsWith(refNorm)) return 0.9;
  const hay = new Set(toksMatch(c.title).concat(toksMatch(c.id)));
  const coverage = refToks.length ? refToks.filter((w) => hay.has(w)).length / refToks.length : 0;
  const hayArr = [...hay];
  const prefixCov = refToks.length
    ? refToks.filter((w) => hayArr.some((h) => h.startsWith(w) || w.startsWith(h))).length / refToks.length
    : 0;
  if (coverage === 1) return 0.85;
  if (titleN.includes(refNorm) || idN.includes(refNorm)) return Math.max(0.7, coverage);
  if (prefixCov === 1) return 0.78;
  return Math.max(coverage, prefixCov) * 0.7;
}

function findCard(tasks, ref) {
  const refNorm = normMatch(ref);
  const refToks = toksMatch(ref);
  const scored = tasks
    .map((c) => ({ c, s: scoreCard(refNorm, refToks, c) }))
    .filter((x) => x.s >= 0.45)
    .sort((a, b) => b.s - a.s);
  if (!scored.length) return { card: null };
  const top = scored[0];
  const close = scored.filter((x) => x.s >= top.s - AMBIGUOUS_MARGIN);
  if (close.length > 1) return { card: null, ambiguous: close.slice(0, 3).map((x) => x.c) };
  return { card: top.c };
}

// ── fixtures (same synthetic cards as bin/find-task.cjs --selftest) ──────────
const TASKS = [
  { id: 'build-orchestrator-message-visibility-cli-ab12', title: 'Build orchestrator message-visibility CLI (hive-msg.cjs)', status: 'done' },
  { id: 'rt-2-realtime-session', title: 'Realtime Michael 2: WebRTC session — mic capture, VAD, barge-in', status: 'done' },
  { id: 'rt-3-toggle-ui', title: 'Realtime Michael 3: mic toggle + live state dot on AgentCard', status: 'done' },
  { id: 'test-3-playwright-e2e', title: 'Test harness 3: Playwright _electron E2E config + launch fixture', status: 'todo' },
  { id: 'ondev-d-oss-model-catalog', title: 'On-device D: research the open-source model catalog', status: 'done' },
];
const find = (q) => findCard(TASKS, q);

// ── harness (mirrors test/slack.test.cjs) ────────────────────────────────────
let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${name}\n     ${err.message}`);
  }
}

console.log('realtime findCard matcher tests (hyphen/punct, truncation, reorder, ambiguity)');

// 1. punctuation/hyphen tolerance: spoken form has no hyphen
test('punct: "message visibility" -> message-visibility CLI', () => {
  assert.ok(find('message visibility').card?.id.startsWith('build-orchestrator'));
});
// 2. truncated whole-query prefix
test('truncation: "build orchestr" -> message-visibility CLI', () => {
  assert.ok(find('build orchestr').card?.id.startsWith('build-orchestrator'));
});
// 3. word-order independence
test('reorder: "visibility orchestrator message" -> message-visibility CLI', () => {
  assert.ok(find('visibility orchestrator message').card?.id.startsWith('build-orchestrator'));
});
// 4. truncated single word (per-token prefix)
test('word-prefix: "playwright e2e" -> test-3', () => {
  assert.strictEqual(find('playwright e2e').card?.id, 'test-3-playwright-e2e');
});
// 5. exact id (after normalization)
test('exact-id: "test-3-playwright-e2e"', () => {
  assert.strictEqual(find('test-3-playwright-e2e').card?.id, 'test-3-playwright-e2e');
});
// 6. ambiguity: "realtime michael" matches rt-2 AND rt-3 closely -> must flag, not guess
test('ambiguous: "realtime michael" flags disambiguation (no silent write)', () => {
  const r = find('realtime michael');
  assert.strictEqual(r.card, null, 'must not pick a card when ambiguous');
  assert.ok(Array.isArray(r.ambiguous) && r.ambiguous.length >= 2, 'lists the close candidates');
});
// 7. a clear single match must NOT be flagged ambiguous
test('not-ambiguous: "playwright" resolves cleanly', () => {
  const r = find('playwright');
  assert.strictEqual(r.card?.id, 'test-3-playwright-e2e');
  assert.ok(!r.ambiguous, 'clean match is not flagged ambiguous');
});
// 8. garbage -> no match, no write
test('no-match: "buy groceries" -> none', () => {
  const r = find('buy groceries');
  assert.strictEqual(r.card, null);
  assert.ok(!r.ambiguous);
});

console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}.`);
process.exit(failures ? 1 : 0);

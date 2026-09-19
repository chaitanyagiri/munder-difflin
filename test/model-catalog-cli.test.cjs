'use strict';

/**
 * The LIVE model catalog: the parsers that read `opencode models` / `agy models`
 * and the merge that lays their answer over the curated list.
 *
 * The failures this file exists to prevent, all three of which shipped once:
 *  - reading agy's SLUG column instead of its display-name column, which yields
 *    a `--model` value agy rejects and a dedupe that never matches its curated
 *    twin, so the picker fills with duplicates that cannot be selected;
 *  - a curated entry being displaced by the raw slug that names the same model,
 *    losing its readable label and any version bounds;
 *  - the appended tail arriving in the CLI's own order, which is no order at all
 *    to someone scrolling or filtering ~380 rows.
 *
 * The parsers are total by contract — a CLI that prints chatter, blank lines or
 * nothing at all must yield a list, never an exception — so the cases below
 * assert the FALLBACK rather than a throw.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { parseOpenCodeModels, parseAgyModels, mergeCliModels } =
  loadTs('src/main/modelCatalog.ts');

// ─── `opencode models` ──────────────────────────────────────────────────────

test('opencode: every slug becomes an entry that is its own label', () => {
  assert.deepEqual(
    parseOpenCodeModels('anthropic/claude-sonnet-4-5\nopencode/big-pickle\n'),
    [
      { id: 'anthropic/claude-sonnet-4-5', label: 'anthropic/claude-sonnet-4-5' },
      { id: 'opencode/big-pickle', label: 'opencode/big-pickle' }
    ]
  );
});

test('opencode: a slug may carry more than one path segment', () => {
  assert.deepEqual(
    parseOpenCodeModels('nvidia-direct/deepseek-ai/deepseek-v4-flash'),
    [{
      id: 'nvidia-direct/deepseek-ai/deepseek-v4-flash',
      label: 'nvidia-direct/deepseek-ai/deepseek-v4-flash'
    }]
  );
});

test('opencode: blank lines, comments and prefix-less chatter are skipped', () => {
  assert.deepEqual(
    parseOpenCodeModels('Fetching…\n\n# a comment\n  anthropic/claude-haiku-4-5  \n'),
    [{ id: 'anthropic/claude-haiku-4-5', label: 'anthropic/claude-haiku-4-5' }]
  );
});

test('opencode: no output is an empty list, not a throw', () => {
  assert.deepEqual(parseOpenCodeModels(''), []);
});

// ─── `agy models` ───────────────────────────────────────────────────────────

test('agy: the DISPLAY NAME is the id, because that is what --model takes', () => {
  assert.deepEqual(
    parseAgyModels('gemini-3.1-pro-high\tGemini 3.1 Pro (High)\n'),
    [{ id: 'Gemini 3.1 Pro (High)', label: 'Gemini 3.1 Pro (High)' }]
  );
});

test('agy: the tab-less status line is skipped', () => {
  assert.deepEqual(
    parseAgyModels('Fetching available models...\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)'),
    [{ id: 'Claude Sonnet 4.6 (Thinking)', label: 'Claude Sonnet 4.6 (Thinking)' }]
  );
});

test('agy: a display name containing a tab keeps every part of itself', () => {
  assert.deepEqual(
    parseAgyModels('slug\tGemini\t3.8 Flash'),
    [{ id: 'Gemini\t3.8 Flash', label: 'Gemini\t3.8 Flash' }]
  );
});

test('agy: a row with no display name is dropped, never backfilled from the slug', () => {
  // Backfilling would put the slug on the command line, which is the exact
  // value agy refuses — a dropped row is strictly better than an unusable one.
  assert.deepEqual(parseAgyModels('gpt-oss-120b-medium\t   '), []);
});

test('agy: no output is an empty list, not a throw', () => {
  assert.deepEqual(parseAgyModels(''), []);
});

// ─── the merge ──────────────────────────────────────────────────────────────

test('a curated entry wins over the live row naming the same model', () => {
  const base = [{ id: 'Gemini 3.1 Pro (High)', label: 'Gemini 3.1 Pro · High', maxAppVersion: '9.9.9' }];
  const merged = mergeCliModels(base, [
    { id: 'Gemini 3.1 Pro (High)', label: 'Gemini 3.1 Pro (High)' }
  ]);
  // Not appended, and the curated label and bound both survive.
  assert.deepEqual(merged, base);
});

test('the curated order is preserved and only the new tail is sorted', () => {
  const base = [{ label: 'CLI default' }, { id: 'zzz/curated', label: 'Curated' }];
  const merged = mergeCliModels(base, [
    { id: 'b/two', label: 'b/two' },
    { id: 'a/one', label: 'a/one' },
    { id: 'c/three', label: 'c/three' }
  ]);
  assert.deepEqual(merged.map((m) => m.id),
    [undefined, 'zzz/curated', 'a/one', 'b/two', 'c/three']);
});

test('a CLI that prints the same slug twice still yields one entry', () => {
  const merged = mergeCliModels([], [
    { id: 'a/one', label: 'a/one' },
    { id: 'a/one', label: 'a/one' }
  ]);
  assert.deepEqual(merged, [{ id: 'a/one', label: 'a/one' }]);
});

test('an empty live list leaves the curated list exactly as it was', () => {
  const base = [{ label: 'CLI default' }, { id: 'a/one', label: 'One' }];
  assert.deepEqual(mergeCliModels(base, []), base);
});

test('an empty curated list is filled entirely by the live one', () => {
  assert.deepEqual(
    mergeCliModels([], [{ id: 'b/two', label: 'b/two' }, { id: 'a/one', label: 'a/one' }]),
    [{ id: 'a/one', label: 'a/one' }, { id: 'b/two', label: 'b/two' }]
  );
});

test('the curated "no --model flag" entry is never treated as a duplicate', () => {
  // Its id is undefined; a live row can never collide with it, and it must not
  // swallow the first live row by comparing equal to it.
  const merged = mergeCliModels([{ label: 'CLI default' }], [{ id: 'a/one', label: 'a/one' }]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, undefined);
});

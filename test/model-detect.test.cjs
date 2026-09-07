'use strict';

/**
 * The model pickers used to be two hand-written layers deep and nothing else:
 * the list baked into the build, and docs/model-catalog.json fetched from main.
 * Both drift. Measured on 2026-09-07 against the CLIs on one machine, the
 * shipped catalog listed 4 of the 10 models `codex` actually had, and none of
 * the Gemini 3.8 or 3.6 families `agy` reported.
 *
 * Detection adds a third layer: what the installed CLI says about itself. These
 * tests pin the four properties that make that layer safe to turn on.
 *
 * The one that is easy to get wrong, and is the reason this file exists:
 * `agy models` prints `slug<TAB>display name`, but `agy --model` REJECTS the
 * slug. Verified against the CLI:
 *
 *   $ agy --model gemini-3.8-flash-high --print hi
 *   Error: invalid model selection ... is not recognized as a known model
 *   Available models:
 *     Gemini 3.8 Flash (High)
 *     ...
 *
 * So the id has to be the second column. Detecting the obvious-looking first
 * column would produce a picker in which every single row fails at spawn.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { parseAgyModels, detectCodexModels, DETECTABLE_PROVIDERS } =
  loadTs('src/main/modelDetect.ts');

/** Real `agy models` output, including the progress line it prints first. */
const AGY_OUTPUT = [
  'Fetching available models...',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
  ''
].join('\n');

test('agy: the id is the DISPLAY NAME, because that is what --model accepts', () => {
  const rows = parseAgyModels(AGY_OUTPUT);
  assert.deepEqual(
    rows.map((r) => r.id),
    ['Gemini 3.8 Flash (High)', 'Gemini 3.8 Flash (Low)', 'Claude Opus 4.6 (Thinking)']
  );
  // The slug is what the first column looks like, and what a reasonable reading
  // of `agy models` would pick. It is exactly the wrong answer.
  assert.ok(
    !rows.some((r) => r.id.includes('gemini-3.8-flash-high')),
    'the slug must never reach a --model flag'
  );
});

test('agy: a line with no tab is skipped, not guessed at', () => {
  // "Fetching available models..." is not a model. Neither is a blank line.
  assert.equal(parseAgyModels(AGY_OUTPUT).length, 3);
  assert.equal(parseAgyModels('no tabs here\nnor here\n').length, 0);
});

test('codex: reads the cache the CLI maintains itself, keeping slugs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-detect-'));
  fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.codex', 'models_cache.json'), JSON.stringify({
    models: [
      { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra' },
      { slug: 'gpt-5.5', display_name: 'GPT-5.5' }
    ]
  }));

  const res = detectCodexModels(dir);
  assert.ok(res, 'the cache file should be detected');
  // The CLI default row is kept first: it is a real choice, and losing it would
  // make turning detection on a downgrade for anyone relying on it.
  assert.equal(res.models[0].id, undefined, 'first row is the "no --model flag" row');
  assert.deepEqual(res.models.slice(1).map((m) => m.id), ['gpt-6-astra', 'gpt-5.5']);
});

test('codex: a missing or corrupt cache detects nothing rather than something wrong', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-detect-'));
  assert.equal(detectCodexModels(dir), null, 'no cache file');

  fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
  const cache = path.join(dir, '.codex', 'models_cache.json');

  fs.writeFileSync(cache, 'not json at all');
  assert.equal(detectCodexModels(dir), null, 'unparseable');

  fs.writeFileSync(cache, JSON.stringify({ models: 'not an array' }));
  assert.equal(detectCodexModels(dir), null, 'wrong shape');

  // Valid JSON, valid shape, no usable rows — must not return a picker holding
  // only the default row, because the caller reads a non-null result as
  // "replace the curated list with this".
  fs.writeFileSync(cache, JSON.stringify({ models: [{ display_name: 'no slug' }] }));
  assert.equal(detectCodexModels(dir), null, 'no usable ids');
});

test('an oversized id is dropped before it can reach a --model flag', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-detect-'));
  fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.codex', 'models_cache.json'), JSON.stringify({
    models: [{ slug: 'x'.repeat(5000), display_name: 'huge' }, { slug: 'gpt-5.5' }]
  }));
  const res = detectCodexModels(dir);
  assert.deepEqual(res.models.slice(1).map((m) => m.id), ['gpt-5.5']);
});

test('only CLIs that can actually be asked are detectable', () => {
  // `claude --model` takes an alias or a full name and offers no list; the
  // gemini CLI has no enumeration either. Adding them here would mean inventing
  // a list, which is strictly worse than the curated one.
  assert.deepEqual([...DETECTABLE_PROVIDERS], ['codex', 'antigravity']);
});

'use strict';

/**
 * mempalace's `auto` device resolves to CoreML on Apple Silicon, and CoreML
 * embeds EVERYTHING to NaN with the quantized embeddinggemma graph — chroma
 * then rejects every upsert and no memory is ever indexed, while queries
 * embedded through the same path break recall. The app pins cpu on macOS.
 * These tests pin the pin: darwin only, and never over a user's own choice.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { mempalaceDevice } = loadTs('src/main/memory.ts');

test('darwin pins cpu — CoreML is the only accelerator auto can pick there, and it NaNs', () => {
  assert.equal(mempalaceDevice('darwin', undefined), 'cpu');
});

test('other platforms keep mempalace\'s own default (no var emitted)', () => {
  assert.equal(mempalaceDevice('linux', undefined), undefined);
  assert.equal(mempalaceDevice('win32', undefined), undefined);
});

test('an explicit MEMPALACE_EMBEDDING_DEVICE always wins — the pin emits nothing', () => {
  // The escape hatch: the exported value flows through the inherited env
  // untouched, including the one-command NaN repro (=coreml).
  assert.equal(mempalaceDevice('darwin', 'coreml'), undefined);
  assert.equal(mempalaceDevice('darwin', 'cpu'), undefined);
  assert.equal(mempalaceDevice('linux', 'cuda'), undefined);
});

test('an empty exported value is not a choice — the darwin default still applies', () => {
  assert.equal(mempalaceDevice('darwin', ''), 'cpu');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { isComposingKey } = loadTs('src/shared/imeGuard.ts');

// A React synthetic keyboard event: the fields we read live on `nativeEvent`,
// because React's SyntheticKeyboardEvent does not re-expose `isComposing`.
const synthetic = (isComposing, keyCode) => ({ nativeEvent: { isComposing, keyCode } });
// A raw DOM KeyboardEvent carries them directly.
const raw = (isComposing, keyCode) => ({ isComposing, keyCode });

test('an Enter that confirms an IME candidate is swallowed (React synthetic)', () => {
  assert.equal(isComposingKey(synthetic(true, 229)), true);
});

test('the NEXT Enter, after composition ends, is handled normally', () => {
  assert.equal(isComposingKey(synthetic(false, 13)), false);
});

test('a raw DOM KeyboardEvent is read directly when there is no nativeEvent', () => {
  assert.equal(isComposingKey(raw(true, 229)), true);
  assert.equal(isComposingKey(raw(false, 13)), false);
});

test('keyCode 229 alone is enough, for the compositionend/keydown race', () => {
  // WebKit and Chromium can report the confirming keydown with isComposing
  // ALREADY false. 229 is the only remaining signal that this was the IME.
  assert.equal(isComposingKey(synthetic(false, 229)), true);
  assert.equal(isComposingKey(raw(false, 229)), true);
});

test('229 cannot swallow a genuine Enter, which is always keyCode 13', () => {
  assert.equal(isComposingKey(synthetic(undefined, 13)), false);
});

test('a missing or empty event degrades to "not composing" instead of throwing', () => {
  assert.equal(isComposingKey(null), false);
  assert.equal(isComposingKey(undefined), false);
  assert.equal(isComposingKey({}), false);
  assert.equal(isComposingKey({ nativeEvent: {} }), false);
});

test('nativeEvent wins over a stale field on the synthetic wrapper', () => {
  // React copies some fields onto the synthetic event; the native one is truth.
  assert.equal(isComposingKey({ isComposing: false, nativeEvent: { isComposing: true } }), true);
});

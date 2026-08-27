'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { DEFAULT_GOD_NAME, resolveGodName } = loadTs('src/shared/godIdentity.ts');

test('a persisted rename wins over the default', () => {
  assert.equal(resolveGodName('Savvas'), 'Savvas');
  assert.equal(resolveGodName('  Savvas  '), 'Savvas'); // trimmed, like renameAgent() trims on write
});

test('nothing persisted yet falls back to the default', () => {
  assert.equal(resolveGodName(undefined), DEFAULT_GOD_NAME);
  assert.equal(resolveGodName(null), DEFAULT_GOD_NAME);
  assert.equal(resolveGodName(''), DEFAULT_GOD_NAME);
  assert.equal(resolveGodName('   '), DEFAULT_GOD_NAME); // whitespace-only is not a real name
});

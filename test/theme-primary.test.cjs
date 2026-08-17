'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  LEGACY_THEME_IDS,
  PRIMARY_APP_NAME,
  PRIMARY_BOSS_NAME,
  PRIMARY_THEME_ID,
  normalizeThemeId,
} = loadTs('src/shared/theme.ts');

test('default theme is Planet Express', () => {
  assert.equal(PRIMARY_THEME_ID, 'planetexpress');
  assert.equal(PRIMARY_APP_NAME, 'Planet Express');
});

test('legacy stored theme values normalize to Planet Express', () => {
  for (const legacyThemeId of LEGACY_THEME_IDS) {
    assert.equal(normalizeThemeId(legacyThemeId), 'planetexpress');
  }
  assert.equal(normalizeThemeId('office'), 'planetexpress');
  assert.equal(normalizeThemeId('brooklyn99'), 'planetexpress');
  assert.equal(normalizeThemeId('unknown'), 'planetexpress');
  assert.equal(normalizeThemeId(null), 'planetexpress');
  assert.equal(normalizeThemeId(undefined), 'planetexpress');
});

test('boss-visible identity resolves to Farnsworth', () => {
  assert.equal(PRIMARY_BOSS_NAME, 'Professor Farnsworth');
});

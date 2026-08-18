'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const cast = read('src/renderer/src/scene/office/cast.ts');
const portraits = read('src/renderer/src/scene/office/portraitArt.ts');
const lines = read('src/renderer/src/scene/office/cafeteriaLines.ts');
const hive = read('src/renderer/src/hooks/useHive.ts');
const modal = read('src/renderer/src/components/AddAgentModal.tsx');

const identities = [
  ['holt', 'Raymond Holt'],
  ['terry', 'Terry Jeffords'],
  ['jake', 'Jake Peralta'],
  ['amy', 'Amy Santiago'],
  ['rosa', 'Rosa Diaz'],
  ['charles', 'Charles Boyle'],
  ['gina', 'Gina Linetti'],
  ['hitchcock', 'Hitchcock'],
  ['scully', 'Scully'],
];

test('all nine precinct identities are selectable presets with procedural recipes', () => {
  for (const [id, displayName] of identities) {
    assert.match(cast, new RegExp(`name: '${id}'.*displayName: '${displayName}'`));
    assert.match(portraits, new RegExp(`\\n  ${id}:\\s+\\{`));
  }
  assert.match(modal, /PRECINCT_CAST\.map/);
  assert.match(modal, /setDescription\(c\.description\)/);
  assert.match(modal, /setGoal\(c\.goal\)/);
});

test('legacy cast IDs normalize without remaining selectable presets', () => {
  for (const oldId of ['michael', 'jim', 'pam', 'dwight', 'kevin', 'angela', 'oscar', 'stanley', 'phyllis', 'andy', 'kelly', 'ryan', 'toby', 'creed', 'meredith']) {
    assert.match(cast, new RegExp(`${oldId}: '[a-z]+'`));
    assert.doesNotMatch(cast, new RegExp(`name: '${oldId}'`));
  }
  assert.match(cast, /export function normalizeCharacterName/);
});

test('Holt is the god display identity and reuses configured god engine fields', () => {
  assert.match(cast, /GOD_CHARACTER: CharacterName = 'holt'/);
  assert.match(hive, /const godProvider = config\.godProvider \?\? 'claude'/);
  assert.match(hive, /const godModel = config\.godModel/);
  assert.match(hive, /name: 'Raymond Holt'/);
  assert.match(hive, /character: GOD_CHARACTER/);
  assert.match(hive, /provider: godProvider/);
  assert.match(hive, /model: godModel/);
});

test('active precinct character content contains no retired quotes or likeness recipes', () => {
  const content = `${cast}\n${portraits}\n${lines}`;
  for (const retired of [
    'Dunder Mifflin', 'Schrute', 'Pretzel Day', "that's what she said",
    'World’s Best Boss', 'Battlestar Galactica', 'I DECLARE',
  ]) assert.doesNotMatch(content, new RegExp(retired, 'i'));
  assert.match(portraits, /not derived from actor photos/);
});

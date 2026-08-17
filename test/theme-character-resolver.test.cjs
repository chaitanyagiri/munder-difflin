'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  resolveThemeCharacter,
  resolveThemeWorkerCharacter,
  themeWorkerCastMembers,
} = loadTs('src/renderer/src/scene/office/themeCharacterResolver.ts');

const planetTheme = {
  cast: {
    byName: {
      'professor-farnsworth': { name: 'professor-farnsworth' },
      leela: { name: 'leela' },
      fry: { name: 'fry' },
      bender: { name: 'bender' },
      hermes: { name: 'hermes' },
    },
    defaultCharacter: 'fry',
  },
  boss: {
    character: 'professor-farnsworth',
  },
};

test('god always resolves to the active theme boss', () => {
  assert.equal(
    resolveThemeCharacter(planetTheme, { id: 'god', character: 'jim', isGod: true }),
    'professor-farnsworth',
  );
});

test('a valid stored worker character is preserved', () => {
  assert.equal(
    resolveThemeCharacter(planetTheme, { id: 'agent-1', character: 'leela' }),
    'leela',
  );
});

test('an invalid worker character resolves deterministically without using the boss', () => {
  const first = resolveThemeCharacter(planetTheme, { id: 'agent-1', character: 'jim' });
  const second = resolveThemeCharacter(planetTheme, { id: 'agent-1', character: 'jim' });
  assert.equal(first, second);
  assert.notEqual(first, 'professor-farnsworth');
  assert.ok(planetTheme.cast.byName[first], `resolved character ${first} is not in the active cast`);
});

test('invalid existing workers are spread across the active worker cast', () => {
  const resolved = new Set(
    Array.from({ length: 12 }, (_, i) =>
      resolveThemeCharacter(planetTheme, { id: `legacy-worker-${i}`, character: 'dwight' })
    )
  );
  assert.ok(resolved.size > 1, 'every legacy worker collapsed to one fallback character');
  assert.equal(resolved.has('professor-farnsworth'), false);
});

test('worker cast members exclude the active theme boss', () => {
  assert.deepEqual(
    themeWorkerCastMembers(planetTheme).map((member) => member.name),
    ['leela', 'fry', 'bender', 'hermes'],
  );
});

test('worker character resolver preserves valid worker characters', () => {
  assert.equal(resolveThemeWorkerCharacter(planetTheme, 'leela'), 'leela');
});

test('worker character resolver falls back from boss requests to the default worker', () => {
  assert.equal(
    resolveThemeWorkerCharacter(planetTheme, 'professor-farnsworth'),
    'fry',
  );
});

test('worker character resolver falls back from unknown requests to the default worker', () => {
  assert.equal(resolveThemeWorkerCharacter(planetTheme, 'jim'), 'fry');
});

test('worker character resolver falls back to the first worker if the theme default is the boss', () => {
  const bossDefaultTheme = {
    cast: {
      byName: {
        'professor-farnsworth': { name: 'professor-farnsworth' },
        leela: { name: 'leela' },
      },
      defaultCharacter: 'professor-farnsworth',
    },
    boss: {
      character: 'professor-farnsworth',
    },
  };

  assert.equal(resolveThemeWorkerCharacter(bossDefaultTheme), 'leela');
});

test('a boss-only theme still has a safe fallback', () => {
  const bossOnly = {
    cast: {
      byName: { michael: { name: 'michael' } },
      defaultCharacter: 'michael',
    },
    boss: { character: 'michael' },
  };
  assert.equal(resolveThemeCharacter(bossOnly, { id: 'worker', character: 'pam' }), 'michael');
});

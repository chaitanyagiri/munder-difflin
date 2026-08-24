'use strict';

/**
 * The list of files kept out of an agent's mempalace/git index exists TWICE:
 * `src/main/hive.ts` writes it when an agent spawns, `src/main/memory.ts` writes
 * it on every mine cycle — and only the latter reaches agents that are not
 * currently running. Both carry a "MUST STAY IN SYNC" comment, which is exactly
 * the kind of invariant that drifts silently: adding a line to one file alone
 * has no visible symptom until a repo bloats again (PR #128: 7.5GB of .git from
 * versioned Codex transcripts). Pin it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => {
  const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const m = src.match(/const MINE_IGNORE_LINES = (\[[^\]]*\]);/);
  assert.ok(m, `MINE_IGNORE_LINES not found in ${rel}`);
  return JSON.parse(m[1].replace(/'/g, '"'));
};

test('MINE_IGNORE_LINES is identical in hive.ts and memory.ts', () => {
  const fromHive = read('src/main/hive.ts');
  const fromMemory = read('src/main/memory.ts');
  assert.deepEqual(fromMemory, fromHive);
  assert.ok(fromHive.includes('.codex/'), 'Codex homes must stay out of the index');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const config = fs.readFileSync(path.join(root, 'src/main/config.ts'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/src/i18n/locales/en.json'), 'utf8'));

const builtIns = [
  ['OPS_STANDUP_MISSION', 'ops-standup'],
  ['HEARTBEAT_MISSION', 'heartbeat'],
  ['COMPACT_MAINTENANCE_MISSION', 'compact-maintenance']
];

test('shipped mission labels stay aligned with their English translation keys', () => {
  // If config.ts changes without en.json, every built-in suddenly counts as
  // user-renamed and stops translating at display time.
  for (const [constant, id] of builtIns) {
    const match = config.match(new RegExp(`export const ${constant}[\\s\\S]*?label: '([^']+)'`));
    assert.ok(match, `${constant} label not found`);
    assert.equal(match[1], en.missions[id]);
  }
});

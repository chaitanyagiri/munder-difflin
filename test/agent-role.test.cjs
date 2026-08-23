'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  isDurableRole,
  preferredAgentRole,
  roleForHiveSpawn
} = loadTs('src/shared/agentRole.ts');

test('status captions are not durable roles', () => {
  for (const text of ['on standby', 'standby', 'idle', 'awaiting', 'a fresh harness', 'reconnecting…', '']) {
    assert.equal(isDurableRole(text), false, text);
  }
  assert.equal(isDurableRole('Head of Marketing — owns marketing-control-room'), true);
});

test('preferredAgentRole keeps a hire role over standby', () => {
  const hire = 'Head of Marketing — owns marketing-control-room and coordinates structured marketing work across the portfolio.';
  assert.equal(preferredAgentRole('on standby', hire), hire);
  assert.equal(preferredAgentRole(hire, 'on standby'), hire);
  assert.equal(preferredAgentRole('on standby', 'idle', true), 'on standby');
  assert.equal(preferredAgentRole(undefined, undefined, true), 'orchestrator (god)');
});

test('roleForHiveSpawn omits a transient roster caption', () => {
  assert.equal(roleForHiveSpawn({ description: 'on standby' }), undefined);
  assert.equal(
    roleForHiveSpawn({ description: 'SRT product steward — owns marketing execution' }),
    'SRT product steward — owns marketing execution'
  );
  assert.equal(
    roleForHiveSpawn({ description: 'on standby', isGod: true }),
    'orchestrator (god)'
  );
});

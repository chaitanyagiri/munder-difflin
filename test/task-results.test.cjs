'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { readTaskResultNotices } = loadTs('src/renderer/src/realtime/taskResults.ts');

test('reads only new human-facing God results and keeps the result key stable', () => {
  const raw = {
    tasks: [
      { id: 'parent-1', title: 'Ship it', status: 'done', assignee: 'god', result: 'Shipped and verified.' },
      { id: 'worker-1', title: 'Implement it', status: 'done', assignee: 'jim', result: 'Implemented.' },
      { id: 'active-1', title: 'Still working', status: 'doing', assignee: 'god', result: 'Not done.' },
      { id: 'slack-1', title: 'Slack work', status: 'done', assignee: 'god', result: 'Already posted to Slack.', slack: { channel: 'C', thread_ts: 'T' } }
    ]
  };

  const notices = readTaskResultNotices(raw, 'god');
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0], {
    key: 'parent-1:Shipped and verified.',
    taskId: 'parent-1',
    title: 'Ship it',
    result: 'Shipped and verified.',
    missingResult: false
  });
});

test('emits a missing-result signal and a new key when the result is later filled', () => {
  const missing = readTaskResultNotices({
    tasks: [{ id: 'parent-1', title: 'Ship it', status: 'done', assignee: 'god' }]
  }, 'god');
  assert.equal(missing[0].missingResult, true);
  assert.equal(missing[0].key, 'parent-1:<missing>');

  const filled = readTaskResultNotices({
    tasks: [{ id: 'parent-1', title: 'Ship it', status: 'done', assignee: 'god', result: 'Now documented.' }]
  }, 'god');
  assert.equal(filled[0].missingResult, false);
  assert.equal(filled[0].key, 'parent-1:Now documented.');
  assert.notEqual(filled[0].key, missing[0].key);
});

'use strict';
// Hook events reach EVERY floor window; the approval dialog reaches one.
//
// Each window runs its own queue drain, and a delivery is acknowledged only
// when the agent's UserPromptSubmit comes back (PromptAckTracker). Main used to
// send hook events through liveWebContents(), which is `mainWindow`, which
// follows focus — so with a second floor open the unfocused floor never saw its
// confirmations and typed every message again. `control:approvalRequest` stays
// on the live window: one prompt, one answer.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { fanOutHookSink } = loadTs('src/main/hooks.ts');

function window(name, log) {
  return { name, send: (channel, payload) => log.push(`${name} ${channel} ${JSON.stringify(payload)}`) };
}

test('hive:hookEvent and hive:contextUpdate go to every window, including the unfocused floor', () => {
  const log = [];
  const main = window('main', log);
  const floor = window('floor', log);
  const sink = fanOutHookSink(() => [main, floor], () => main);
  sink.send('hive:hookEvent', { agentId: 'holly', event: 'UserPromptSubmit' });
  sink.send('hive:contextUpdate', { agentId: 'holly', tokens: 10 });
  assert.deepEqual(log, [
    'main hive:hookEvent {"agentId":"holly","event":"UserPromptSubmit"}',
    'floor hive:hookEvent {"agentId":"holly","event":"UserPromptSubmit"}',
    'main hive:contextUpdate {"agentId":"holly","tokens":10}',
    'floor hive:contextUpdate {"agentId":"holly","tokens":10}'
  ]);
});

test('control:approvalRequest goes to the live window only', () => {
  const log = [];
  const main = window('main', log);
  const floor = window('floor', log);
  const sink = fanOutHookSink(() => [main, floor], () => floor);
  sink.send('control:approvalRequest', { agentId: 'holly', tool: 'Bash' });
  assert.deepEqual(log, ['floor control:approvalRequest {"agentId":"holly","tool":"Bash"}']);
});

test('the window list is read on every send, and a window that throws (torn down) does not stop the others', () => {
  const log = [];
  const main = window('main', log);
  const dead = { send: () => { throw new Error('Object has been destroyed'); } };
  const floor = window('floor', log);
  let windows = [main];
  const sink = fanOutHookSink(() => windows, () => null);
  sink.send('hive:hookEvent', 1);
  windows = [dead, floor];
  sink.send('hive:hookEvent', 2);
  sink.send('control:approvalRequest', 3);
  assert.deepEqual(log, ['main hive:hookEvent 1', 'floor hive:hookEvent 2'], 'no live window for the approval → dropped quietly, as before');
});

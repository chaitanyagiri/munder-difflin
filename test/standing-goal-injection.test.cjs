'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

// hooks.ts imports Electron's Notification class. Node tests only exercise the
// hook return value, so provide the tiny surface needed to load the module.
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};

const { HookServer } = loadTs('src/main/hooks.ts');

function harness(initialGoal = 'Ship the release safely.') {
  let goal = initialGoal;
  const hive = {
    recordSession() {},
    isGod() { return false; }
  };
  const server = new HookServer(
    hive,
    () => null,
    () => ({ notifications: false }),
    undefined,
    undefined,
    () => goal
  );
  const fire = (event, sessionId = 'session-1', agentId = 'jim-1') => server.handle({
    agent_id: agentId,
    hook_event_name: event,
    session_id: sessionId
  });
  return { fire, setGoal: (next) => { goal = next; } };
}

const context = (res) => res?.hookSpecificOutput?.additionalContext ?? '';

test('an unchanged standing goal is injected once, not on every prompt', () => {
  const { fire } = harness();

  assert.match(context(fire('SessionStart')), /Ship the release safely/);
  assert.equal(context(fire('UserPromptSubmit')), '');
  assert.equal(context(fire('UserPromptSubmit')), '');
});

test('a goal edit is delivered on the next prompt and only once', () => {
  const { fire, setGoal } = harness();
  fire('SessionStart');

  setGoal('Prepare the customer handoff.');
  assert.match(context(fire('UserPromptSubmit')), /Prepare the customer handoff/);
  assert.equal(context(fire('UserPromptSubmit')), '');
});

test('a new session receives the standing goal even when its text is unchanged', () => {
  const { fire } = harness();
  fire('SessionStart', 'session-1');

  assert.match(context(fire('SessionStart', 'session-2')), /Ship the release safely/);
  assert.equal(context(fire('UserPromptSubmit', 'session-2')), '');
});

test('a prompt that arrives before SessionStart still receives the goal once', () => {
  const { fire } = harness();

  assert.match(context(fire('UserPromptSubmit')), /Ship the release safely/);
  assert.equal(context(fire('UserPromptSubmit')), '');
});

test('clearing a goal explicitly revokes the old briefing', () => {
  const { fire, setGoal } = harness();
  fire('SessionStart');

  setGoal(null);
  assert.match(context(fire('UserPromptSubmit')), /Cleared by the operator/);
  assert.equal(context(fire('UserPromptSubmit')), '');
});

test('goal delivery state is isolated per agent', () => {
  const { fire } = harness();
  fire('SessionStart', 'session-1', 'jim-1');

  assert.match(context(fire('UserPromptSubmit', 'session-1', 'pam-1')), /Ship the release safely/);
  assert.equal(context(fire('UserPromptSubmit', 'session-1', 'jim-1')), '');
});

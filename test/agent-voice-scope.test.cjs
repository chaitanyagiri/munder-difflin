'use strict';

/**
 * Per-agent Talk — the two invariants the feature is only safe under.
 *
 * Talk used to be god-only: one persona ("You are Michael…") and the hive-wide
 * read + ACTION tools (hire, kill, pause, archive, dispatch, settings). Putting the
 * same button on a worker card is only acceptable while two things stay true:
 *
 *  1. A WORKER voice session gets self-scoped tools ONLY. If a worker's session ever
 *     reached `realtimeActionTools()` / `window.cth.realtimeAction`, anyone who can
 *     talk to Pam could kill agents through her — an escalation the card's UI gives
 *     no hint of. The worker tool file must therefore contain no action spine at all.
 *  2. god's own session is UNCHANGED. The orchestrator voice is the one path that was
 *     already QA'd and shipped; parameterizing connect() must not have moved his
 *     persona, his voice, his tool set, or his floor/completion subscriptions.
 *
 * Both are source-level invariants (the modules pull the realtime SDK, the zustand
 * store and React, so they cannot be required in a plain node test) — pinned the way
 * the renderer-guardrail assertions elsewhere in this suite are.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const read = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8');

const agentVoice = read('src/renderer/src/realtime/agentVoice.ts');
const session = read('src/renderer/src/realtime/session.ts');

// --- 1. a worker's voice cannot act on the floor ---------------------------

test('worker voice tools never reach the hive action spine', () => {
  assert.ok(
    !/realtimeAction\b/.test(agentVoice),
    'agentVoice must not call window.cth.realtimeAction — that is god\'s write path'
  );
  assert.ok(
    !/realtimeActionTools/.test(agentVoice),
    'agentVoice must not import or register the orchestrator action tools'
  );
});

test('worker voice tools are self-scoped — no destructive verbs', () => {
  for (const verb of ['spawn_agent', 'kill_agent', 'pause_agent', 'halt_agent', 'archive_agent', 'update_setting', 'dispatch_agent']) {
    assert.ok(!agentVoice.includes(verb), `worker voice must not expose ${verb}`);
  }
});

test('the relay into the agent session goes through the gated paths only', () => {
  // enqueueMessage rides the renderer queue (idle-only, boot grace, draft safety,
  // auto-delivery pause); controlSteer injects at the next hook. Anything else —
  // writing the PTY directly — would bypass every delivery gate the app has.
  assert.ok(agentVoice.includes('enqueueMessage('), 'idle delivery must use the message queue');
  assert.ok(agentVoice.includes('controlSteer('), 'busy delivery must use the steer note');
  assert.ok(!/ptyWrite|writeToPty|sendInput/.test(agentVoice), 'never write an agent PTY directly');
});

// --- 2. god's session is untouched -----------------------------------------

test('god still runs the Michael persona, his voice, and the full tool set', () => {
  assert.ok(
    session.includes('You are Michael — the voice of the orchestrator'),
    "god's persona must stay verbatim"
  );
  assert.ok(session.includes("const REALTIME_VOICE = 'cedar'"), "god's voice must stay cedar");
  assert.ok(
    session.includes('tools: [...realtimeReadTools(), ...realtimeActionTools()]'),
    'god keeps the hive read + action tools'
  );
  assert.ok(
    session.includes('instructions: MICHAEL_PERSONA'),
    'the god branch must still be built from MICHAEL_PERSONA'
  );
});

test('the worker branch does not borrow god\'s floor/completion channels', () => {
  const worker = session.slice(
    session.indexOf('async function connectWorker'),
    session.indexOf('export async function connect(')
  );
  assert.ok(worker.length > 0, 'connectWorker must exist ahead of connect()');
  for (const godOnly of ['realtimeSetSessionLive', 'onRealtimeFloorDelta', 'onRealtimeCompletion', 'realtimeSessionSummary', 'MICHAEL_PERSONA']) {
    assert.ok(!worker.includes(godOnly), `the worker session must not use ${godOnly} — that is the orchestrator's picture of the hive`);
  }
});

test('a worker session is audibly distinct from Michael', () => {
  assert.ok(agentVoice.includes("export const AGENT_VOICE = 'marin'"), 'workers speak with marin');
  assert.ok(
    !session.includes("const REALTIME_VOICE = 'marin'"),
    'and Michael keeps cedar, so the user can hear who picked up'
  );
});

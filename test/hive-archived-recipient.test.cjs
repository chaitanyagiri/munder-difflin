'use strict';
// Mail to an ARCHIVED agent is filed, and its sender is told nobody is there.
//
// An archived agent (terminal gone) keeps its inbox, so a message to it lands
// there, is logged as delivered, and stays unread. Filing it is right — a
// worker re-hired under the same id reads it on its first turn, and a released
// worker's inbox is settled only up to its done signal — but the sender learned
// nothing: god kept mailing dead agents for hours (seen live 2026-08-16), and a
// request to a worker nobody re-hired was simply lost. Now a message that
// expects an answer (request / query / propose) is filed AND its sender gets an
// immediate inform saying so; inform-only mail is filed quietly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-archived-to-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker-jim', name: 'Jim', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: home });
  hive.setArchived('worker-jim', true);
  return { home, hive };
}

const entries = (hive, kind) => hive.logTail(500).filter((e) => e.kind === kind);

test('a request to an archived agent is filed in its inbox and the sender is informed at once', async (t) => {
  const { hive } = await floor(t);
  const sent = hive.send({ to: 'worker-jim', act: 'request', subject: 'T15 — start the build', body: 'go' }, 'god-1');

  const filed = hive.inbox('worker-jim');
  assert.equal(filed.length, 1, 'the mail is filed, so a re-hire under the same id reads it');
  assert.equal(filed[0].subject, 'T15 — start the build', 'filed verbatim, not rewritten');

  const [notice] = hive.inbox('god-1');
  assert.ok(notice, 'the sender hears about it');
  assert.equal(notice.act, 'inform');
  assert.equal(notice.from, 'system');
  assert.equal(notice.in_reply_to, sent.id, 'threaded on the original message');
  assert.equal(notice.requires_reply, false, 'a notice never asks for an answer (no ping-pong)');
  assert.match(notice.subject, /^\[no one is there to answer — "worker-jim" is archived\] T15 — start the build$/);
  assert.match(notice.body, /re-hired under the same id/);

  const [logged] = entries(hive, 'archived-recipient');
  assert.deepEqual({ from: logged.from, to: logged.to, id: logged.id, act: logged.act },
    { from: 'god-1', to: 'worker-jim', id: sent.id, act: 'request' });
  const [routed] = entries(hive, 'message').filter((e) => e.id === sent.id);
  assert.deepEqual(routed.delivered, ['worker-jim'], 'the message log still reports the delivery that happened');
});

test('query and propose are told too; an inform / done to an archived agent is filed quietly', async (t) => {
  const { hive } = await floor(t);
  hive.send({ to: 'worker-jim', act: 'query', subject: 'status?', body: '' }, 'god-1');
  hive.send({ to: 'worker-jim', act: 'propose', subject: 'plan B', body: '' }, 'god-1');
  assert.equal(hive.inbox('god-1').length, 2);
  hive.send({ to: 'worker-jim', act: 'inform', subject: 'FYI', body: 'anchors' }, 'god-1');
  hive.send({ to: 'worker-jim', act: 'done', subject: 'closing', body: '' }, 'pam-1');
  assert.equal(hive.inbox('god-1').length, 2, 'no notice for mail that expects no answer');
  assert.equal(hive.inbox('pam-1').length, 0);
  assert.equal(hive.inbox('worker-jim').length, 4, 'everything is filed all the same');
  assert.equal(entries(hive, 'archived-recipient').length, 4);
});

test('a live agent other than god is informed the same way; a sender off the roster is not', async (t) => {
  const { hive } = await floor(t);
  hive.send({ to: 'worker-jim', act: 'request', subject: 'from Pam', body: '' }, 'pam-1');
  assert.equal(hive.inbox('pam-1').length, 1);
  assert.equal(hive.inbox('god-1').length, 0, 'the notice goes to the sender, not to god');
  // The UI / harness sends as "system", which has no inbox to inform.
  hive.send({ to: 'worker-jim', act: 'request', subject: 'from the UI', body: '' }, 'system');
  assert.equal(hive.inbox('god-1').length, 0);
  assert.equal(hive.inbox('worker-jim').length, 2);
});

test('once the agent is back on the floor, mail to it is ordinary again', async (t) => {
  const { hive } = await floor(t);
  hive.setArchived('worker-jim', false);
  hive.send({ to: 'worker-jim', act: 'request', subject: 'welcome back', body: '' }, 'god-1');
  assert.equal(hive.inbox('worker-jim').length, 1);
  assert.equal(hive.inbox('god-1').length, 0);
  assert.equal(entries(hive, 'archived-recipient').length, 0);
});

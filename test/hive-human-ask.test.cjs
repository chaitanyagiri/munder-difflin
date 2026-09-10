'use strict';
// A god → "human" ask must reach the human.
//
// Before this: "human" resolved to the god (the human's proxy on the floor) and
// the sender WAS the god, so the never-deliver-to-self filter left no target. The
// message was logged with delivered=[] and shown nowhere — 17 such messages in
// one afternoon (sign-offs, credential requests, a runbook confirmation), while
// the god told the human "awaiting your answer — ASK ME tab" and the tab was
// empty. The ledger is where the human looks, so an ask becomes a card there.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { HiveManager } = loadTs('src/main/hive.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-human-ask-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const emitted = [];
  const hive = new HiveManager(() => home, (channel, payload) => { emitted.push({ channel, payload }); return true; });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  return { home, hive, emitted };
}

const cards = (hive) => JSON.parse(fs.readFileSync(path.join(hive.root(), 'tasks.json'), 'utf8')).tasks;
const entries = (hive, kind) => hive.logTail(500).filter((e) => e.kind === kind);

test('a god request to the human becomes a blocked ASK ME card carrying the body as the open ask', async (t) => {
  const { hive } = await floor(t);
  hive.send({ to: 'human', act: 'request', subject: 'F1 ready — sign the deploy?', body: 'Collateral measured 0 over 16 days. Deploy the DROP?' }, 'god-1');

  const all = cards(hive);
  assert.equal(all.length, 1, 'exactly one card materialized');
  const card = all[0];
  assert.equal(card.status, 'blocked');
  assert.equal(card.title, 'F1 ready — sign the deploy?');
  assert.equal(card.assignee, 'god-1');
  assert.ok(card.id.startsWith('ask-'), `card id derives from the message id: ${card.id}`);
  assert.equal(card.humanQA.length, 1);
  assert.equal(card.humanQA[0].q, 'Collateral measured 0 over 16 days. Deploy the DROP?');
  assert.ok(card.humanQA[0].askedAt, 'the ask is timestamped so ASK ME can order it');
  assert.equal(card.humanQA[0].a, undefined, 'the ask is OPEN');

  const [logged] = entries(hive, 'message');
  assert.deepEqual(logged.delivered, ['human'], 'the log reads as delivered to the human, not as a silent drop');
  assert.equal(entries(hive, 'human-ask').length, 1);
  assert.equal(hive.inbox('god-1').length, 0, 'must never loop back into the god inbox');
});

test('query and propose to the human are asks too; the subject stands in for a missing body', async (t) => {
  const { hive } = await floor(t);
  hive.send({ to: 'human', act: 'query', subject: 'Which sensor first?' }, 'god-1');
  hive.send({ to: 'human', act: 'propose', subject: 'Parallelize wave 2', body: 'F2 and F6 side by side.' }, 'god-1');
  const all = cards(hive);
  assert.equal(all.length, 2);
  assert.equal(all[0].humanQA[0].q, 'Which sensor first?');
  assert.equal(all[1].humanQA[0].q, 'F2 and F6 side by side.');
});

test('a god inform to the human is an FYI: no card, logged as a human-fyi drop, not as delivered', async (t) => {
  const { hive } = await floor(t);
  hive.send({ to: 'human', act: 'inform', subject: 'VT key stored', body: 'Kept in .secrets, redacted from the board.' }, 'god-1');
  assert.equal(cards(hive).length, 0, 'an FYI must not grow the kanban');
  const drops = entries(hive, 'drop').filter((e) => e.reason === 'human-fyi');
  assert.equal(drops.length, 1);
  assert.equal(drops[0].from, 'god-1');
  const [logged] = entries(hive, 'message');
  assert.deepEqual(logged.delivered, [], 'an FYI nobody received must not read as delivered');
});

test('a WORKER asking "human" still lands with the god (the proxy) and never becomes a card', async (t) => {
  const { hive } = await floor(t);
  hive.send({ to: 'human', act: 'request', subject: 'Need creds', body: 'ssh to serverhp' }, 'jim-1');
  assert.equal(hive.inbox('god-1').length, 1, 'the god triages worker asks');
  assert.equal(cards(hive).length, 0);
  const [logged] = entries(hive, 'message');
  assert.deepEqual(logged.delivered, ['god-1']);
});

test('the same message id never yields two cards', async (t) => {
  const { hive } = await floor(t);
  hive.send({ id: 'fixed-1', to: 'human', act: 'request', subject: 'Sign?', body: 'yes/no' }, 'god-1');
  hive.send({ id: 'fixed-1', to: 'human', act: 'request', subject: 'Sign?', body: 'yes/no' }, 'god-1');
  assert.equal(cards(hive).length, 1);
  const logged = entries(hive, 'message');
  assert.deepEqual(logged[0].delivered, ['human']);
  assert.deepEqual(logged[1].delivered, [], 'the duplicate reads as undelivered rather than pretending');
});

test('a new open ask is announced once, whichever way it enters the ledger, and never on the first read', async (t) => {
  const { hive, emitted } = await floor(t);
  const seen = [];
  hive.setHumanAskNotifier((ask) => seen.push(ask));
  const ledgerPath = path.join(hive.root(), 'tasks.json');

  // An ask already on disk at boot is NOT re-announced by the first read.
  fs.writeFileSync(ledgerPath, JSON.stringify({ tasks: [
    { id: 'T4', title: 'Decision', status: 'blocked', humanQA: [{ q: 'Which front?', askedAt: '2026-09-06T11:12:00.000Z' }] }
  ] }, null, 2));
  hive.tasks();
  assert.equal(seen.length, 0, 'boot snapshot only');

  // The god hand-appends an ask to a card it left in "doing" (the F1 case).
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  ledger.tasks.push({ id: 'F1', title: 'Block POTASSIUM', status: 'doing', humanQA: [{ q: 'Sign F1?', askedAt: '2026-09-06T13:14:00.000Z' }] });
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
  hive.tasks();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].taskId, 'F1');
  assert.equal(seen[0].title, 'Block POTASSIUM');
  assert.equal(seen[0].question, 'Sign F1?');
  assert.ok(emitted.some((e) => e.channel === 'hive:humanAsk' && e.payload.taskId === 'F1'), 'the renderer is told too');

  // Re-reading does not re-announce; answering does not either.
  hive.tasks();
  assert.equal(seen.length, 1);
  assert.ok(hive.patchTask('F1', { humanQA: [{ q: 'Sign F1?', askedAt: '2026-09-06T13:14:00.000Z', a: 'yes', answeredAt: '2026-09-06T13:20:00.000Z' }] }));
  hive.tasks();
  assert.equal(seen.length, 1);

  // A god → human message materialized by routing is announced on the next read.
  hive.send({ to: 'human', act: 'request', subject: 'Runbook OK?', body: '3 points' }, 'god-1');
  hive.tasks();
  assert.equal(seen.length, 2);
  assert.ok(seen[1].taskId.startsWith('ask-'));
  assert.equal(seen[1].title, 'Runbook OK?');
});

test('the protocol handed to agents documents the message path and the status-independent rule', async (t) => {
  const { hive } = await floor(t);
  const protocol = fs.readFileSync(path.join(hive.root(), 'PROTOCOL.md'), 'utf8');
  assert.match(protocol, /When the GOD sends\s+`"to": "human"`/);
  assert.match(protocol, /the harness creates a\s+blocked card titled with the subject/i);
  assert.match(protocol, /WHATEVER the card's status/);
});

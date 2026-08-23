'use strict';

/**
 * Regression for the silent unknown-recipient drop. `deliver()` returned early
 * when `agents/<to>/inbox` did not exist — no write, no bounce, no log — while
 * `routeOnce` still archived the outbox file to `.sent/` and `log.jsonl` still
 * recorded `kind:"message"`. A mis-addressed message therefore ceased to exist
 * with every observability surface reporting success; on one floor 14 of 32
 * messages vanished that way before anyone noticed.
 *
 * Unknown-recipient was the only delivery failure with neither a bounce (the
 * prep-assistant and hookless-provider cases have one) nor a drop log (the
 * hop-cap case has one). It now has both, and the message log reports the
 * targets that actually took delivery rather than the sender's intent.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-unknown-to-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  return { home, hive };
}

const entries = (hive, kind) => hive.logTail(500).filter((e) => e.kind === kind);

test('mail to an id with no inbox bounces to god and is logged as a drop', async (t) => {
  const { hive } = await floor(t);

  // "jim" is the display name; the contract is the agent id, so nothing resolves.
  hive.send({ to: 'jim', act: 'request', subject: 'T15 — start the build', body: 'go' }, 'god-1');

  assert.equal(hive.inbox('jim-1').length, 0, 'nothing should reach the real agent');

  const dropped = entries(hive, 'drop').filter((e) => e.reason === 'no-inbox');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].to, 'jim');
  assert.equal(dropped[0].from, 'god-1');

  const bounced = hive.inbox('god-1');
  assert.equal(bounced.length, 1);
  assert.match(bounced[0].subject, /^\[undeliverable — no agent "jim"/);
  assert.match(bounced[0].subject, /T15 — start the build$/);
  assert.equal(bounced[0].body, 'go', 'the bounce carries the original body');
});

test('the message log records delivered targets, not intent', async (t) => {
  const { hive } = await floor(t);

  hive.send({ to: 'jim-1', act: 'inform', subject: 'landed' }, 'god-1');
  hive.send({ to: 'scheduler', act: 'inform', subject: 'standup' }, 'jim-1');

  const [ok, lost] = entries(hive, 'message');
  assert.deepEqual(ok.delivered, ['jim-1']);
  assert.deepEqual(lost.delivered, [], 'a message nobody received must not read as delivered');
});

test('an unknown recipient does not stop the rest of a broadcast', async (t) => {
  const { hive } = await floor(t);
  // A registry entry whose agent directory was never created — the same shape a
  // stale roster leaves behind.
  const reg = JSON.parse(fs.readFileSync(path.join(hive.root(), 'registry.json'), 'utf8'));
  reg.agents['ghost-1'] = { id: 'ghost-1', name: 'Ghost', provider: 'claude', cwd: '.' };
  fs.writeFileSync(path.join(hive.root(), 'registry.json'), JSON.stringify(reg, null, 2));

  hive.send({ to: 'broadcast', act: 'inform', subject: 'all hands' }, 'god-1');

  assert.equal(hive.inbox('jim-1').length, 1, 'the live agent still gets the broadcast');
  const [msg] = entries(hive, 'message');
  assert.deepEqual(msg.delivered, ['jim-1']);
  assert.equal(entries(hive, 'drop').filter((e) => e.to === 'ghost-1').length, 1);
});

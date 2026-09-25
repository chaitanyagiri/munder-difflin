'use strict';

/**
 * Regression for the inoperative HOP_CAP loop guard. routeMessage() checked
 * `msg.hops > HOP_CAP` with a "loop guard — drop a runaway message" comment,
 * but the harness never incremented hops and every bounce path spread `...msg`
 * unchanged: normalize copied the agent-supplied value verbatim, so the guard
 * compared a frozen 0 against 12 forever while a god↔hookless-worker relay
 * loop delivered a duplicate bounce (plus a log line and a git commit) every
 * router tick. Conversely an outbox JSON echoing `hops: 13` — a field
 * PROTOCOL.md says the HARNESS fills in — had its first delivery dropped.
 *
 * The fix makes hops harness-owned end to end: normalize clamps the
 * agent-carried value into [0, HOP_CAP] so a copied-forward count can neither
 * fake a runaway loop nor read as one, and the four harness bounce paths now
 * go through bounceToGod(), the only place the counter moves (+1 per bounce),
 * where the cap fuse actually fires — and only on a real relay loop.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

/** The cap constant from src/main/hive.ts (module-private, not exported). */
const HOP_CAP = 12;
/** Comfortably past the cap: a working fuse must fire long before this many. */
const RELAYS = 30;

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hop-cap-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  // hopless-1 runs kimi — no hook bridge, canReceiveInbox:false, so every
  // direct mail to it bounces to god (the hookless path). No PTY, no sidecar,
  // no net: routing exercises the bounce ladder with nothing running but the
  // router itself.
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker-1', name: 'Dwight', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'hopless-1', name: 'Kimi', provider: 'kimi', cwd: home });
  const outbox = (id) => path.join(home, 'hive', 'agents', id, 'outbox');
  return { hive, outbox };
}

/** Write one agent-authored outbox message, exactly as an agent process would. */
function writeOutbox(outbox, filename, partial) {
  fs.writeFileSync(path.join(outbox, filename), JSON.stringify(partial), 'utf8');
}

const dropEntries = (hive, reason) =>
  hive.logTail(5000).filter((e) => e.kind === 'drop' && e.reason === reason);

test('a god↔hookless-worker relay loop is bounded and hops climbs to the cap', async (t) => {
  const { hive, outbox } = await floor(t);

  // The documented echo loop: god mails the hookless worker, the harness
  // bounces to god, god's scripted relay re-sends to the worker, and so on.
  // The god relays FAITHFULLY — it copies what it received (subject, body,
  // conversation, in_reply_to and hops verbatim) into its own outbox, exactly
  // the fields PROTOCOL.md's send schema describes, and lets the harness do
  // the rest.
  writeOutbox(outbox('god-1'), 'm-000.json', {
    to: 'hopless-1', act: 'request', subject: 'PING — coordinate with me',
    body: 'worker asks hookless peer to sync', conversation: 'conv-echo'
  });

  const hopsSeen = [];
  for (let i = 1; i <= RELAYS; i++) {
    hive.routeOnce();
    const bounces = hive.inbox('god-1').filter((m) => m.subject.startsWith('[undeliverable'));
    const bounce = bounces[bounces.length - 1] ?? null;
    if (bounces.length < i) break; // post-fix: the fuse dropped the relay — loop is bounded
    hopsSeen.push(bounce.hops);
    writeOutbox(outbox('god-1'), `relay-${String(i).padStart(3, '0')}.json`, {
      to: 'hopless-1',
      act: 'request',
      subject: bounce.subject,
      body: bounce.body,
      conversation: bounce.conversation,
      in_reply_to: bounce.id,
      hops: bounce.hops // carry the counter the schema says exists
    });
  }
  hive.routeOnce();

  const bounces = hive.inbox('god-1').filter((m) => m.subject.startsWith('[undeliverable — "hopless-1"'));

  assert.ok(
    hopsSeen.length > 0 && hopsSeen[0] === 1,
    `the harness must increment hops on its own bounce (first bounce read: ${hopsSeen[0]}) — ` +
    'the counter is harness-owned, not a frozen agent-supplied 0'
  );
  assert.deepEqual(
    hopsSeen, hopsSeen.map((_, i) => i + 1),
    `each harness bounce must carry the next hop (seen: ${JSON.stringify(hopsSeen)})`
  );
  assert.ok(
    bounces.length <= HOP_CAP,
    `${bounces.length} relay passes were delivered — the HOP_CAP=${HOP_CAP} fuse ` +
    `did not bound the ${RELAYS}-pass loop (each pass writes a duplicate bounce, ` +
    'a log line, and a hive git commit)'
  );
  assert.ok(
    dropEntries(hive, 'hop-cap').length > 0,
    'a relay loop that passes the cap must be dropped with reason "hop-cap"'
  );
});

test('an agent-authored hops value cannot trip the fuse on a first delivery', async (t) => {
  const { hive, outbox } = await floor(t);

  // An agent echoing the schema documentation writes a hops value into its
  // outbox JSON — e.g. one copied from a forwarded thread. PROTOCOL.md promises
  // "The harness fills in `id`, `from`, `hops`, and timestamps", so a
  // sender-authored number must never read as a runaway loop.
  writeOutbox(outbox('god-1'), 'capped.json', {
    to: 'worker-1', act: 'inform', subject: 'status report', body: 'all green',
    hops: HOP_CAP + 1
  });
  hive.routeOnce();

  assert.equal(
    dropEntries(hive, 'hop-cap').length, 0,
    `an agent-authored hops:${HOP_CAP + 1} must not be read as a runaway loop — ` +
    'the guard fires only on bounces the harness itself counted'
  );
  assert.ok(
    hive.inbox('worker-1').some((m) => m.subject === 'status report'),
    'a first delivery must never be dropped because of a number the agent wrote in the hops field'
  );
  const [delivered] = hive.inbox('worker-1');
  assert.ok(
    delivered.hops <= HOP_CAP,
    `no persisted message may carry hops past the cap (delivered: ${delivered.hops})`
  );
});

test('honest mail with no hops field still delivers', async (t) => {
  const { hive, outbox } = await floor(t);

  writeOutbox(outbox('god-1'), 'ok.json', {
    to: 'worker-1', act: 'inform', subject: 'plain mail', body: 'no hops field at all'
  });
  assert.equal(hive.routeOnce(), 1);
  assert.equal(hive.inbox('worker-1').length, 1, 'the documented send path must keep working');
  assert.equal(dropEntries(hive, 'hop-cap').length, 0);
});

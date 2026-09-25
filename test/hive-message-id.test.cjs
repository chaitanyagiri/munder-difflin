'use strict';

/**
 * Regression coverage for the agent-authored message id flowing unvalidated into
 * the inbox filename (deliver(), src/main/hive.ts). PROTOCOL.md promises agents
 * "The harness fills in `id`, `from`, `hops`, and timestamps", but normalize()
 * kept the sender's id verbatim (`partial.id ?? generated`) and deliver() used it
 * directly as a filesystem name:
 *
 *   this.atomicWriteJson(join(inbox, `${msg.id}.json`), msg);
 *
 * The outbox JSON is authored by the agent process, so any id it emitted reached
 * the path, three ways:
 *   1. SILENT COLLISION-OVERWRITE — two outbox messages with the same id: the
 *      second write clobbered the first while log.jsonl recorded both as
 *      delivered. The first mail was simply gone.
 *   2. PATH-LIKE ID → SILENT QUARANTINE — an id like `reports/week` made
 *      writeFileSync throw (no intermediate directory); routeOnce's outer catch
 *      quarantined the file as `.sent/bad-*` with NO drop log and NO bounce, so
 *      the mail vanished while nothing observable said why.
 *   3. TRAVERSAL — an id containing `../` escaped the recipient's inbox (and the
 *      hive tree) via join()'s lexical resolution, writing agent-chosen JSON
 *      outside the hive.
 *
 * The fix: the harness OWNS the id — normalize() always generates it, so the
 * mail filename is harness-controlled no matter what an agent emits. The
 * routeOnce catch-all (the only quarantine without one) also logs its drop now.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-msg-id-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker-1', name: 'Creed', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'worker-2', name: 'Pam', provider: 'claude', cwd: home });
  const outbox = (id) => path.join(home, 'hive', 'agents', id, 'outbox');
  const inbox = (id) => path.join(home, 'hive', 'agents', id, 'inbox');
  return { home, hive, outbox, inbox };
}

/** Write one agent-authored outbox message, exactly as an agent process would. */
function writeOutbox(outbox, filename, partial) {
  const file = path.join(outbox, filename);
  fs.writeFileSync(file, JSON.stringify(partial), 'utf8');
  return file;
}

const entries = (hive, kind) => hive.logTail(500).filter((e) => e.kind === kind);

test('a duplicate agent-authored id must not destroy the first message', async (t) => {
  const { hive, outbox } = await floor(t);

  // Agent worker-1's templating bug emits two messages with the same id. Both
  // are valid mail; the recipient must be able to read BOTH.
  writeOutbox(outbox('worker-1'), 'a.json', {
    id: 'dup-1', to: 'worker-2', act: 'inform', subject: 'FIRST — the real brief', body: 'deploy step 1'
  });
  assert.equal(hive.routeOnce(), 1);
  writeOutbox(outbox('worker-1'), 'b.json', {
    id: 'dup-1', to: 'worker-2', act: 'inform', subject: 'SECOND — unrelated chatter', body: 'idle chat'
  });
  assert.equal(hive.routeOnce(), 1);

  const subjects = hive.inbox('worker-2').map((m) => m.subject);
  assert.deepEqual(
    subjects, ['FIRST — the real brief', 'SECOND — unrelated chatter'],
    'both messages must be readable by the recipient'
  );
});

test('a path-like id is delivered like any other mail — not quarantined unlogged', async (t) => {
  const { hive, outbox } = await floor(t);

  // On the old code this id made writeFileSync throw ENOENT (no intermediate
  // dir), the outer catch quarantined the file as .sent/bad-m.json, and NOTHING
  // observable recorded the loss. The harness now owns the id, so the mail
  // routes normally no matter what id the agent emitted.
  writeOutbox(outbox('worker-2'), 'm.json', {
    id: 'reports/week', to: 'god-1', act: 'inform', subject: 'weekly report', body: 'the numbers'
  });
  assert.equal(hive.routeOnce(), 1);

  const delivered = hive.inbox('god-1');
  assert.equal(delivered.length, 1, 'a valid message must route no matter what id the sender wrote');
  assert.equal(delivered[0].subject, 'weekly report');
  assert.equal(fs.existsSync(path.join(outbox('worker-2'), '.sent', `bad-m.json`)), false,
    'nothing should have been quarantined');
});

test('a traversal id never writes outside the recipient inbox and never reads as delivered', async (t) => {
  const { home, hive, outbox } = await floor(t);

  // From the recipient's inbox, four `..` climb out of the hive tree entirely:
  // <hive>/agents/god-1/inbox → <home>. join() resolved them lexically and the
  // payload landed OUTSIDE the hive while log.jsonl recorded `delivered: ["god-1"]`.
  const escapedFile = path.join(home, 'ESCAPED.json');
  assert.equal(fs.existsSync(escapedFile), false, 'precondition: the target does not exist');
  writeOutbox(outbox('worker-1'), 'evil.json', {
    id: '../../../../ESCAPED', to: 'god-1', act: 'inform', subject: 'escaped', body: 'outside the hive'
  });
  assert.equal(hive.routeOnce(), 1);

  assert.equal(
    fs.existsSync(escapedFile), false,
    `PATH ESCAPE: agent-chosen JSON was written outside the recipient's inbox (and outside the ` +
    `hive tree) at ${escapedFile}`
  );

  // If the log claims the message was delivered, the mail must actually be in
  // the recipient's inbox — the log reports what took delivery, not intent.
  const claimed = entries(hive, 'message').filter(
    (e) => Array.isArray(e.delivered) && e.delivered.includes('god-1')
  );
  for (const e of claimed) {
    assert.ok(
      hive.inbox('god-1').some((m) => m.subject === 'escaped'),
      `the log records delivered: ["god-1"] for id ${JSON.stringify(e.id)}, but no such message is ` +
      'in god-1\'s inbox — the escape was logged as a successful delivery'
    );
  }
});

test('the harness generates the id and the inbox filename matches it', async (t) => {
  // Pins the documented case (PROTOCOL.md: agents never send an id) so the
  // ownership fix cannot drift: no id → harness generates one, mail lands in
  // the recipient's inbox as <id>.json.
  const { hive, outbox, inbox } = await floor(t);
  writeOutbox(outbox('worker-2'), 'ok.json', {
    to: 'worker-1', act: 'request', subject: 'plain mail', body: 'no id at all'
  });
  assert.equal(hive.routeOnce(), 1);
  const got = hive.inbox('worker-1');
  assert.equal(got.length, 1);
  assert.ok(got[0].id, 'the harness generated an id');
  assert.equal(got[0].subject, 'plain mail');
  assert.equal(fs.existsSync(path.join(inbox('worker-1'), `${got[0].id}.json`)), true);
});

test('a delivery that throws is logged as a drop and quarantined, never silent', async (t) => {
  // The outer catch is the one quarantine without a log line (the two
  // malformed-json paths beside it both log). Force the delivery to throw the
  // way a filesystem error would — `deliver` is private to TypeScript only, so
  // the test can shadow it on the instance — and pin that the failure becomes
  // observable instead of vanishing into .sent/bad-*.
  const { hive, outbox } = await floor(t);
  writeOutbox(outbox('worker-1'), 'boom.json', {
    to: 'worker-2', act: 'inform', subject: 'will fail at the write', body: 'x'
  });

  const realDeliver = hive.deliver;
  hive.deliver = () => { throw new Error('simulated ENOENT'); };
  try {
    assert.equal(hive.routeOnce(), 0);
  } finally {
    hive.deliver = realDeliver;
  }

  assert.equal(hive.inbox('worker-2').length, 0, 'nothing was delivered');
  assert.equal(fs.existsSync(path.join(outbox('worker-1'), '.sent', 'bad-boom.json')), true,
    'the file is quarantined so the router does not spin on it');
  const dropped = entries(hive, 'drop').filter((e) => e.reason === 'delivery-failed');
  assert.equal(dropped.length, 1, 'the drop must be logged — before the fix this path was silent');
  assert.equal(dropped[0].from, 'worker-1');
  assert.equal(dropped[0].file, 'boom.json');
});

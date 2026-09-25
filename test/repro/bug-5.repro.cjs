'use strict';

/**
 * Repro for the agent-authored message id flowing unvalidated into the inbox
 * filename (deliver(), src/main/hive.ts:1544).
 *
 * PROTOCOL.md (hive.ts:2837) promises agents: "The harness fills in `id`, `from`,
 * `hops`, and timestamps." It does not — normalize() (hive.ts:1523) keeps the
 * sender's id verbatim (`partial.id ?? generated`), and deliver() uses it
 * directly as a filesystem name:
 *
 *   this.atomicWriteJson(join(inbox, `${msg.id}.json`), msg);
 *
 * The outbox JSON is authored by the agent process (an LLM), so any id it emits
 * reaches the path. Three failure modes, each pinned below by asserting the
 * behavior a correct fix must produce. All three FAIL on current main:
 *
 *   1. SILENT COLLISION-OVERWRITE — two outbox messages with the same id: the
 *      second atomicWriteJson clobbers the first. The log records two `message`
 *      entries with `delivered` targets; the first mail is simply gone.
 *
 *   2. PATH-LIKE ID → SILENT QUARANTINE — an id like `reports/week` makes
 *      writeFileSync throw (no intermediate directory), routeOnce's outer catch
 *      (hive.ts:1752-1755) renames the file to `.sent/bad-*` with NO drop log
 *      and NO bounce. The mail vanishes while nothing observable says why.
 *      (The malformed-JSON quarantine paths at 1729/1736 DO log; only this
 *      throwing-delivery path is unlogged.)
 *
 *   3. TRAVERSAL — an id containing `..` escapes the recipient's inbox (and the
 *      hive tree) via join()'s lexical resolution, writing agent-chosen JSON
 *      outside the hive while log.jsonl records `delivered: [<target>]`.
 *
 * Each test asserts the post-fix contract: the harness owns the id (or at
 * minimum contains it), a delivery that did not happen is logged as a drop,
 * and nothing is ever written outside the recipient's inbox. The final test
 * pins the legitimate case so a fix cannot simply refuse every message.
 *
 * Run: node test/repro/bug-5.repro.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-bug5-id-path-'));
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

test('[bug-5 / 1] a duplicate agent-authored id must not destroy the first message', async (t) => {
  const { hive, outbox, inbox } = await floor(t);

  // Agent worker-1's templating bug emits two messages with the same id.
  // Both are valid mail; the recipient must be able to read BOTH.
  writeOutbox(outbox('worker-1'), 'a.json', {
    id: 'dup-1', to: 'worker-2', act: 'inform', subject: 'FIRST — the real brief', body: 'deploy step 1'
  });
  assert.equal(hive.routeOnce(), 1);
  writeOutbox(outbox('worker-1'), 'b.json', {
    id: 'dup-1', to: 'worker-2', act: 'inform', subject: 'SECOND — unrelated chatter', body: 'idle chat'
  });
  assert.equal(hive.routeOnce(), 1);

  const subjects = hive.inbox('worker-2').map((m) => m.subject);
  assert.ok(
    subjects.includes('FIRST — the real brief'),
    `SILENT LOSS: the first message was overwritten by the second — worker-2's inbox holds only [${subjects.join('; ')}], ` +
    'while log.jsonl recorded the first send as delivered'
  );
  assert.equal(
    subjects.length, 2,
    `both messages must be readable by the recipient; got [${subjects.join('; ')}]`
  );
});

test('[bug-5 / 2] a path-like id must deliver or drop-with-log — never vanish silently', async (t) => {
  const { hive, outbox, inbox } = await floor(t);

  // On current main this id makes writeFileSync throw ENOENT (no intermediate
  // dir), routeOnce's outer catch quarantines the file as .sent/bad-m.json,
  // and NOTHING observable records the loss: no drop log, no bounce, and
  // routeOnce returns 0 — while the sender was told the harness delivers.
  writeOutbox(outbox('worker-2'), 'm.json', {
    id: 'reports/week', to: 'god-1', act: 'inform', subject: 'weekly report', body: 'the numbers'
  });
  hive.routeOnce();

  const delivered = hive.inbox('god-1');
  const dropped = entries(hive, 'drop');
  assert.ok(
    delivered.length > 0 || dropped.length > 0,
    'SILENT LOSS: the mail is gone from the outbox (quarantined as bad-m.json) with NO drop log ' +
    'entry and NO bounce — the sender believes it was delivered. A delivery failure must be ' +
    'observable (delivered to the inbox, or logged as a drop), like the malformed-json and ' +
    'no-inbox paths already are.'
  );
});

test('[bug-5 / 3] a traversal id must never write outside the recipient inbox', async (t) => {
  const { home, hive, outbox, inbox } = await floor(t);

  // From the recipient's inbox, four `..` climb out of the hive tree entirely:
  // <hive>/agents/god-1/inbox → <home>. join() resolves them lexically, the
  // parent exists, so atomicWriteJson lands the payload OUTSIDE the hive —
  // and log.jsonl records it as `delivered: ["god-1"]`.
  const escapedFile = path.join(home, 'ESCAPED.json');
  assert.equal(fs.existsSync(escapedFile), false, 'precondition: the target does not exist');
  writeOutbox(outbox('worker-1'), 'evil.json', {
    id: '../../../../ESCAPED', to: 'god-1', act: 'inform', subject: 'escaped', body: 'outside the hive'
  });
  hive.routeOnce();

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

test('[bug-5 / 4] the legitimate case keeps working — sender omits id, harness delivers', async (t) => {
  // Pins the documented case (PROTOCOL.md: agents never send an id) so a fix
  // cannot simply refuse every message: no id → harness generates one, mail
  // lands in the recipient's inbox as <id>.json.
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

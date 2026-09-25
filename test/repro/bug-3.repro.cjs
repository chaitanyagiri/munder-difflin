'use strict';

/**
 * BUG repro — the worker-wake paths ignore the registry `onHold` claim, so
 * the main-process wake beat types a nudge + Enter into the PTY of an agent
 * the human has claimed 1:1 — fusing onto the operator's half-composed line —
 * and broadcast fan-out delivers into held inboxes.
 *
 * `onHold` is the operator's "1:1 with the human" claim:
 *   - setAgentHold (src/main/hive.ts ~1032) writes it to registry.json and
 *     patches fleet.json in the same operation specifically so that "one more
 *     dispatch can still land on someone the human has just claimed" is
 *     avoided, and
 *   - god's injected roster renders it as `ON HOLD — 1:1 with the human` with
 *     "do NOT message them, do NOT dispatch to them" (hive.ts ~2497).
 *
 * But the machine-side wakers never read it:
 *   - runWorkerWakeBeat (src/main/index.ts ~5139) builds WorkerWakeFacts from
 *     control.snapshot (paused/halted/autoDeliveryPaused only — control.ts
 *     118-127); WorkerWakeFacts (workerWake.ts 71-86) has no onHold field and
 *     WorkerWakeWatchdog.decide (workerWake.ts 120-147) checks only those
 *     flags plus timing guards. setAgentHold never calls control.pause, so
 *     hold and the ControlRegistry flags are disjoint state stores.
 *   - nudgeWorker -> ptyManager.write sees only child OUTPUT quiescence
 *     (lastOutputAt bumps in pty.ts proc.onData): a human's half-composed
 *     line sitting idle 12s is indistinguishable from a finished turn, so the
 *     beat types WORKER_WAKE_NUDGE + a bare Enter onto it — the input-fusion
 *     hazard the renderer queue was built to prevent (useHive.ts 681-689),
 *     which the main-process beat bypasses entirely.
 *   - selectBroadcastTargets (src/shared/broadcast.ts) fans `to:'broadcast'`
 *     mail into held agents' inboxes; routeMessage/deliver (hive.ts
 *     1541-1639) have no hold check either.
 *
 * WHAT IS REAL HERE: the real HiveManager on a temp hive home (registry.json,
 * setAgentHold, atomic inbox delivery), the real ControlRegistry, the real
 * WorkerWakeWatchdog, the real selectBroadcastTargets + message router, the
 * real inboxNudgeText — and the beat itself is EXTRACTED VERBATIM from
 * src/main/index.ts (nudgeWorker + runWorkerWakeBeat) at run time, so the
 * production code is what executes, not a copy that could drift. The only
 * fake is the PTY backend: a recording stand-in for ptyManager at the exact
 * seam the beat uses (lastOutputAt + write). No claude spawn, no display, no
 * network, no real PTY — fully deterministic.
 *
 * THE SCENARIO: the operator holds worker `jim` for a private 1:1, types a
 * half-composed line into jim's terminal, and pauses to think. A god mail
 * lands in jim's inbox. 12s of output silence (a thinking pause — the agent
 * emits nothing, and human keyboard input into the PTY is invisible to
 * lastOutputAt) passes every decide() guard, and the beat types the nudge
 * plus a bare Enter onto the operator's line.
 *
 * A correct fix (onHold carried into the wake decision — WorkerWakeFacts +
 * decide(), or an equivalent beat-level or bridge-level guard — and held
 * agents skipped by broadcast fan-out) makes every test here pass without
 * touching this file.
 *
 * Run: node test/repro/bug-3.repro.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const loadTs = require('../load-ts.cjs');

const {
  WorkerWakeWatchdog,
  WORKER_WAKE_IDLE_MS
} = loadTs('src/main/workerWake.ts');
const { ControlRegistry } = loadTs('src/main/control.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { selectBroadcastTargets } = loadTs('src/shared/broadcast.ts');
const { inboxNudgeText } = loadTs('src/shared/hiveNudge.ts');

// ---------------------------------------------------------------------------
// Extract the REAL beat from src/main/index.ts so the repro exercises the
// production code, not a copy that could drift from it.
// ---------------------------------------------------------------------------

const REPO = path.resolve(__dirname, '..', '..');
const INDEX_SRC = fs.readFileSync(path.join(REPO, 'src', 'main', 'index.ts'), 'utf8');

/** Pull one top-level function's source out of index.ts by brace matching. */
function extractFn(src, name) {
  const marker = `function ${name}(`;
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `repro setup: cannot find ${name}() in src/main/index.ts — the beat moved; update this repro`);
  const open = src.indexOf('{', src.indexOf(')', start));
  assert.ok(open >= 0, `repro setup: cannot find ${name}() body`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`repro setup: unbalanced braces extracting ${name}`);
}

// Wrap the verbatim production functions with the module-level dependencies
// they close over in index.ts, injected from the harness.
const makeBeatImpl = (() => {
  const wrapper = `
module.exports = function makeBeat(deps) {
  const hive = deps.hive;
  const control = deps.control;
  const ptyManager = deps.ptyManager;
  const workerWake = deps.workerWake;
  const ptyForAgent = deps.ptyForAgent;
  const inboxNudgeText = deps.inboxNudgeText;
${extractFn(INDEX_SRC, 'nudgeWorker')}
${extractFn(INDEX_SRC, 'runWorkerWakeBeat')}
  return { nudgeWorker, runWorkerWakeBeat };
};
`;
  const out = ts.transpileModule(wrapper, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: 'extracted-beat.ts'
  });
  const mod = { exports: null };
  new Function('module', 'exports', out.outputText)(mod, mod.exports);
  return mod.exports;
})();

function makeBeat(hive, control, ptys, workerWake) {
  return makeBeatImpl({
    hive,
    control,
    ptyManager: ptys,
    workerWake,
    ptyForAgent: (id) => (id === 'jim-1' ? 'pty-jim' : undefined),
    inboxNudgeText
  });
}

// ---------------------------------------------------------------------------
// Fake PTY backend — ptyManager stand-in at the seam the beat uses.
// Records every write; lastOutputAt is driven by the test. A real session's
// lastOutputAt only bumps on child OUTPUT (pty.ts proc.onData) — a human
// typing into the PTY produces none, which is exactly the blind spot this
// bug lives in.
// ---------------------------------------------------------------------------

/** The operator's half-composed line, sitting in the PTY input box. */
const OPERATOR_HALF_LINE = 'so jim, about the release plan, I think we sho';

function fakePty() {
  const written = [];
  const lastOut = {};
  return {
    written,
    lastOutputAt(id) { return lastOut[id]; },
    setOutput(id, at) { lastOut[id] = at; },
    write(id, data) { written.push({ id, data }); return { ok: true }; }
  };
}

// ---------------------------------------------------------------------------
// Floor: real HiveManager on a temp home — god + one claude worker, the same
// shape test/hive-roster-injection.test.cjs uses.
// ---------------------------------------------------------------------------

async function freshFloor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hold-wake-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* tmp */ } });
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  const control = new ControlRegistry();
  return { home, hive, control };
}

/** Drop a message directly into an agent's inbox — the data-plane state the
 *  wake beat consumes, however it got there (the router delivers into held
 *  inboxes; see the broadcast test below; god's inform path does the same). */
function deliverMail(hive, to, from, subject) {
  hive.send({ from, to, act: 'inform', subject, body: 'x' }, from);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('precondition: the hold is real — ON HOLD in the registry, routed around in god\'s roster, invisible to ControlRegistry', async (t) => {
  const { hive, control } = await freshFloor(t);

  hive.writeFleetSnapshot({ ts: Date.now(), agents: [{ id: 'jim-1', name: 'Jim', role: 'agent' }] });
  assert.deepEqual(hive.setAgentHold('jim-1', true), { ok: true, onHold: true });
  assert.equal(hive.registry().agents['jim-1'].onHold, true, 'setAgentHold records the claim');

  // The hold is a real, rendered product state for god…
  const roster = hive.rosterContext() ?? '';
  assert.match(roster, /ON HOLD — 1:1 with the human/);

  // …yet the ControlRegistry snapshot the wake beat consumes shows NOTHING:
  const snap = control.snapshot('jim-1');
  assert.equal(snap.paused, false);
  assert.equal(snap.halted, false);
  assert.equal(snap.autoDeliveryPaused, false);
});

test('BUG 1: the main-process wake beat types WORKER_WAKE_NUDGE + Enter into a HELD agent\'s PTY', async (t) => {
  const { hive, control } = await freshFloor(t);
  const ptys = fakePty();
  const workerWake = new WorkerWakeWatchdog();
  workerWake.noteSpawn('pty-jim', 0); // spawn long past boot grace

  // Operator holds jim for a private 1:1…
  assert.deepEqual(hive.setAgentHold('jim-1', true), { ok: true, onHold: true }, 'precondition: hold set');
  // …types a half-composed line into jim's terminal, and pauses to think.
  // The agent emits nothing for 13s: output quiescence — the ONLY signal the
  // main process has — looks exactly like a finished turn.
  ptys.setOutput('pty-jim', Date.now() - WORKER_WAKE_IDLE_MS - 1_000);

  // A god mail lands in the held agent's inbox. (Delivered directly, so this
  // test isolates the WAKE half of the bug from the routing half proven in
  // BUG 2 — whichever side a fix lands on, the held PTY must not be typed.)
  deliverMail(hive, 'jim-1', 'god-1', 'standup notes');
  assert.equal(hive.inbox('jim-1').length, 1, 'precondition: undrained mail in the held inbox');

  // The beat fires (WORKER_WAKE_POLL_MS = 15s) — the REAL index.ts code.
  makeBeat(hive, control, ptys, workerWake).runWorkerWakeBeat();
  await new Promise((r) => setTimeout(r, 250)); // nudgeWorker's Enter lands 140ms later

  // THE BUG: no guard in decide() or the beat knows about onHold, so the
  // nudge + a bare Enter are typed straight onto the operator's line.
  const typed = ptys.written.filter((w) => w.id === 'pty-jim').map((w) => w.data);
  assert.deepEqual(typed, [],
    'the wake beat typed into a HELD agent\'s PTY (onHold = "1:1 with the human"): '
    + JSON.stringify(typed)
    + ` — the Enter fuses onto the operator's half-composed line "${OPERATOR_HALF_LINE}" and submits it`);
});

test('BUG 2: broadcast fan-out delivers into a held agent\'s inbox', async (t) => {
  const { hive } = await freshFloor(t);
  hive.setAgentHold('jim-1', true);
  assert.equal(hive.registry().agents['jim-1'].onHold, true, 'precondition: jim is on hold');

  // The exact selection routeMessage uses for to:'broadcast'.
  const targets = selectBroadcastTargets(hive.registry().agents, 'god-1');
  assert.equal(targets.includes('jim-1'), false,
    `selectBroadcastTargets fans a broadcast to a HELD agent ([${targets.join(', ')}]) — the dispatch the hold flag exists to stop`);

  // And end-to-end through the real router: the mail physically lands.
  hive.send({ from: 'god-1', to: 'broadcast', act: 'inform', subject: 'standup', body: 'sync' }, 'god-1');
  assert.equal(hive.inbox('jim-1').length, 0,
    'a broadcast was delivered into a held agent\'s inbox — the orchestrator and the human now share that terminal');
});

test('control: the beat honors the ControlRegistry guards it does read — paused stops the nudge', async (t) => {
  const { hive, control } = await freshFloor(t);
  const ptys = fakePty();
  ptys.setOutput('pty-jim', Date.now() - WORKER_WAKE_IDLE_MS - 1_000);
  const workerWake = new WorkerWakeWatchdog();
  workerWake.noteSpawn('pty-jim', 0);
  deliverMail(hive, 'jim-1', 'god-1', 'task');

  control.pause('jim-1', true);
  makeBeat(hive, control, ptys, workerWake).runWorkerWakeBeat();
  await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual(ptys.written, [],
    'paused → no nudge. This is the guard class (ControlRegistry flags) the beat DOES honor — onHold is simply absent from it');
});

test('sanity: the same pipeline still wakes an UN-HELD idle worker (the watchdog works; only hold is ignored)', async (t) => {
  const { hive, control } = await freshFloor(t);
  const ptys = fakePty();
  ptys.setOutput('pty-jim', Date.now() - WORKER_WAKE_IDLE_MS - 1_000);
  const workerWake = new WorkerWakeWatchdog();
  workerWake.noteSpawn('pty-jim', 0);
  deliverMail(hive, 'jim-1', 'god-1', 'task');

  makeBeat(hive, control, ptys, workerWake).runWorkerWakeBeat();
  await new Promise((r) => setTimeout(r, 250));

  const texts = ptys.written.map((w) => w.data);
  assert.ok(texts.some((d) => d.startsWith('You have new hive inbox message(s)')),
    'an un-held idle worker with mail must still be nudged (a correct fix only narrows the held case): ' + JSON.stringify(texts));
  assert.ok(texts.includes('\r'), 'the nudge is submitted with a trailing Enter (the real pattern)');
});

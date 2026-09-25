'use strict';
/**
 * Regression test - bug 13: "Wedged compact permanently starves the agent's
 * whole message queue: 'compacting' status is unreachable by the quiescence
 * sweep while the drain is strictly head-of-line".
 *
 * The chain under test (all REAL code, loaded straight from src/):
 *
 *   1. useHive.ts effect #2 (onHiveHookEvent): a PreCompact hook event sets the
 *      agent's status to 'compacting' (useHive.ts:492). No PostCompact ever
 *      arrives - the CLI hung or crashed mid-compact, and no hook fires on a
 *      crash. The quiescence sweep (useHive.ts:663) only flips 'working'
 *      agents back to 'idle', so the agent is wedged in 'compacting' for good.
 *   2. canDeliverToAgent (queueDelivery.ts) must therefore admit a 'compacting'
 *      agent whose terminal has been silent for quiesceMs - the same evidence
 *      the gate already trusts for a breaker-pinned 'looping' agent - or the
 *      status blocks delivery in BOTH the flush() pre-filter (useHive.ts:931)
 *      and the dispatch() gate (useHive.ts:810) forever.
 *   3. The drain is strictly head-of-line (`messageQueues[srcId]?.[0]`,
 *      useHive.ts:804): one stuck compact blocks every later message,
 *      including the inbox-wake nudges whose whole purpose is to unstick
 *      the agent.
 *
 * The test drives the REAL useHive() hook bodies under Node:
 *  - the module graph (store, terminalPool, shared/*) is loaded with the
 *    test/load-ts.cjs transpile pattern extended with the '@/' alias and the
 *    Vite asset suffixes (?url / ?raw / .css);
 *  - React's hook dispatcher is faked so useHive() runs headless and its
 *    effect bodies can be executed and their interval callbacks ticked by
 *    hand (no renderer, no real timers);
 *  - window.cth (the preload IPC bridge) is stubbed at the module boundary:
 *    one live PTY for the agent that emits NOTHING after the wedge (the hung
 *    CLI), a non-empty hive inbox, successful PTY writes;
 *  - Date.now is virtualized so an hour of quiescence passes in milliseconds.
 *
 * The fix under test lives in src/ (canDeliverToAgent admits a quiesced
 * 'compacting' agent); this file only exercises it. Run:
 *   node test/repro/bug-13.repro.cjs
 *       -> every assertion passes: the wedged agent's queue drains in order.
 *   (On the pre-fix code the final queue-depth assertion failed with exit 1.)
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');

const ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Module loader: test/load-ts.cjs transpile pattern + '@/' alias + Vite stubs
// ---------------------------------------------------------------------------

const cache = new Map();

function resolveTs(fromDir, request) {
  let base;
  if (request.startsWith('@shared/')) {
    base = path.resolve(ROOT, 'src/shared', request.slice('@shared/'.length));
  } else if (request.startsWith('@/')) {
    base = path.resolve(ROOT, 'src/renderer/src', request.slice('@/'.length));
  } else {
    base = path.resolve(fromDir, request);
  }
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  const stripped = base.replace(/[?](url|raw)$/, ''); // Vite ?url / ?raw suffixes
  if (stripped !== base && fs.existsSync(stripped)) return stripped;
  return null;
}

function loadFile(filename) {
  if (cache.has(filename)) return cache.get(filename).exports;
  const mod = { exports: {} };
  cache.set(filename, mod);
  if (filename.endsWith('.css')) return mod.exports;             // side-effect only
  if (/\.(png|tmj)$/.test(filename)) { mod.exports = filename; return mod.exports; }
  if (filename.endsWith('.json')) {
    mod.exports = JSON.parse(fs.readFileSync(filename, 'utf8'));
    return mod.exports;
  }
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true,
      esModuleInterop: true
    },
    fileName: filename
  });
  const localRequire = (request) => {
    if (/\.css$/.test(request)) return {};
    if (request.startsWith('.') || request.startsWith('@/') || request.startsWith('@shared/')) {
      const resolved = resolveTs(path.dirname(filename), request);
      if (resolved) return loadFile(resolved);
    }
    return require(request);
  };
  const run = new Function('module', 'exports', 'require', '__filename', '__dirname', output.outputText);
  run(mod, mod.exports, localRequire, filename, path.dirname(filename));
  return mod.exports;
}

// ---------------------------------------------------------------------------
// Boundary stubs
// ---------------------------------------------------------------------------

globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.document = {
  createElement: () => ({ style: {} }),
  addEventListener() {},
  removeEventListener() {},
  fonts: undefined,
  visibilityState: 'visible'
};
window.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const useStore = loadFile(path.resolve(ROOT, 'src/renderer/src/store/store.ts')).useStore;

// The preload bridge. The agent's PTY is live but SILENT from before the wedge
// on (lastOutputAt frozen an hour in the past): the hung-CLI premise.
const BOOT_AT = Date.now();
const PTY_LAST_OUTPUT_AT = BOOT_AT - 60_000;

const written = []; // every payload typed into the agent's PTY
window.cth = {
  harnessHomeSync: () => null,
  onHiveHookEvent: (cb) => { window.cth._hookEvent = cb; return () => {}; },
  onBreakerState: () => () => {},
  onHiveContextUpdate: () => () => {},
  onHiveTerminalHandoff: () => () => {},
  onSlackMessage: () => () => {},
  onHiveEnqueue: () => () => {},
  onHiveAgentSpawned: () => () => {},
  onHiveAgentArchived: () => () => {},
  onRealtimeEnqueue: () => () => {},
  onContextTrigger: () => () => {},
  onAutoCompact: () => () => {},
  onPowerResume: () => () => {},
  hiveRegistry: () => Promise.resolve({ agents: {} }),
  hivePatchAgentRole: () => Promise.resolve({}),
  listPtys: () => Promise.resolve([{
    id: 'pty-w1', cwd: 'C:/tmp/proj', command: 'claude', pid: 4242,
    lastOutputAt: PTY_LAST_OUTPUT_AT, hasOutput: true
  }]),
  hiveInbox: () => Promise.resolve([{ id: 'm-1' }, { id: 'm-2' }]),
  controlSnapshot: () => Promise.resolve(null),
  writePty: (_ptyId, payload) => { written.push(payload); return Promise.resolve({ ok: true }); },
  spawnPty: () => Promise.resolve({ ok: true }),
  killPty: () => Promise.resolve({ ok: true }),
  resizePty: () => Promise.resolve({ ok: true }),
  gitIsRepo: () => Promise.resolve(false),
  agentContext: () => Promise.resolve(null),
  hiveAddTask: () => Promise.resolve({}),
  hiveTasks: () => Promise.resolve({ tasks: [] }),
  getConfig: () => Promise.resolve({}),
  slackReply: () => Promise.resolve({}),
  trackMessageSent: () => Promise.resolve()
};

// The shipped gate under test - the fix itself lives in src/renderer/src/hooks/
// queueDelivery.ts and is unit-tested in test/queue-delivery.test.cjs.
const { canDeliverToAgent } = loadFile(path.resolve(ROOT, 'src/renderer/src/hooks/queueDelivery.ts'));

// ---------------------------------------------------------------------------
// Drive the real useHive() with a minimal hook dispatcher
// ---------------------------------------------------------------------------

const armedIntervals = [];
const manualTimeouts = [];
const realSetInterval = global.setInterval;
const realSetTimeout = global.setTimeout;
global.setInterval = function captureInterval(fn, ms) { armedIntervals.push({ fn, ms }); return 0; };
global.setTimeout = function captureTimeout(fn, ms) { manualTimeouts.push({ fn, ms }); return 0; };
global.clearInterval = () => {};
global.clearTimeout = () => {};

// Virtual clock: the quiescence window (12s), the drain cooldown (4.5s) and the
// PTY silence are all measured with Date.now(); advancing it makes an hour of
// floor time elapse deterministically between real microtask settles.
let virtualNow = BOOT_AT;
const realDateNow = Date.now;
Date.now = () => virtualNow;

const hooks = [];
const effects = [];
let hookIdx = 0;
const dispatcher = {
  useRef(init) { const i = hookIdx++; hooks[i] ||= { current: init }; return hooks[i]; },
  useEffect(fn) { const i = hookIdx++; if (!effects[i]) effects[i] = { fn }; return undefined; },
  useSyncExternalStore(_sub, getSnap) { return getSnap(); },
  useDebugValue() {},
  useState(init) {
    const i = hookIdx++;
    hooks[i] ||= { value: typeof init === 'function' ? init() : init };
    return [hooks[i].value, (v) => { hooks[i].value = typeof v === 'function' ? v(hooks[i].value) : v; }];
  },
  useMemo(fn) { const i = hookIdx++; hooks[i] ||= { value: fn() }; return hooks[i].value; },
  useCallback(fn) { return fn; }
};

React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current = dispatcher;
loadFile(path.resolve(ROOT, 'src/renderer/src/hooks/useHive.ts')).useHive({
  onboardingComplete: true,
  harnessHome: 'C:/tmp/hive'
});
React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current = null;

// Capture the loop bodies the effects arm (by cadence, in effect order:
// 15000 = context poll #2c, 4000 = quiescence sweep #2e, 4000 = inbox wake #3,
// 1500 = seed #3b, 3000 = queue drain #4). Resolved lazily inside the scenario
// function - the intervals arm only after the effect loop below has run.
let sweep, wake, drain;

async function tick(loop, settleMs) {
  await loop.fn();
  await new Promise((r) => realSetTimeout(r, settleMs));
}

function fail(err) {
  console.error('\nREGRESSION FAILED (bug-13):');
  console.error(err && err.message ? err.message : err);
  const a = useStore.getState().agents.find((x) => x.id === 'w1');
  console.error(`  agent status: ${a ? a.status : '<gone>'}`);
  console.error(`  queue depth:  ${(useStore.getState().messageQueues['w1'] ?? []).length}`);
  console.error(`  pty writes:   ${written.length}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

// Execute every captured effect body once, in declaration order, so the
// subscriptions register and the loops arm. The timer restore happens INSIDE
// the async flow: restoring it at module top level would race the effect loop
// (the IIFE suspends at its first await) and the later effects would arm real
// 15s/4s intervals instead of being captured.
(async () => {
  // The dispatcher hands refs/states/memos and effects a shared slot index, so
  // `effects` is sparse (its holes are the non-effect hook slots).
  for (const effect of effects) {
    if (!effect) continue;
    await effect.fn();
    await new Promise((r) => realSetTimeout(r, 10));
  }
  // Restore real timers for the scenario itself. Every restored setTimeout
  // advances the virtual clock by its delay before running: the modules' internal
  // promise sleeps (the PTY-readiness poll's 100ms backoff, submitToPty's settle)
  // are wall-clock waits in the app, and under the virtual clock they must also
  // move Date.now() forward or the readiness handshake (elapsed >= 400ms) never
  // completes and every delivery fails its 30s readiness timeout.
  global.setInterval = realSetInterval;
  global.setTimeout = (fn, ms, ...rest) =>
    realSetTimeout((...cb) => { virtualNow += Math.max(ms ?? 1, 1); return fn(...cb); }, Math.min(ms ?? 1, 50), ...rest);
  await runScenario();
  process.exit(0);
})().catch((e) => fail(e));

async function runScenario() {
  sweep = armedIntervals.filter((x) => x.ms === 4000)[0];
  wake = armedIntervals.filter((x) => x.ms === 4000)[1];
  drain = armedIntervals.find((x) => x.ms === 3000);
  assert.ok(sweep && wake && drain, 'sweep/wake/drain interval bodies captured from the real effects');

  const state = () => useStore.getState().agents.find((a) => a.id === 'w1');
  const queue = () => useStore.getState().messageQueues['w1'] ?? [];

  // One live worker mid-turn; the user queues a message behind the running turn.
  useStore.getState().addAgent({
    id: 'w1', name: 'Wilhelmina', character: 'jim', accent: 'coral',
    description: 'worker', project: 'proj', tmuxTarget: '', cwd: 'C:/tmp/proj',
    status: 'idle', action: '', progress: 0, currentStation: 'desk',
    ptyId: 'pty-w1', command: 'claude', provider: 'claude', recentTextTs: BOOT_AT
  });
  useStore.getState().updateAgent('w1', { status: 'working', action: 'using Read' });
  useStore.getState().enqueueMessage('w1', 'Please summarize the auth module.');

  // The user then runs /compact (or the context trigger does). PreCompact
  // arrives; the CLI hangs mid-compact, so PostCompact never fires and no hook
  // fires on a crash.
  assert.equal(typeof window.cth._hookEvent, 'function', 'hook-event handler registered');
  window.cth._hookEvent({ agentId: 'w1', event: 'PreCompact' });
  assert.equal(state().status, 'compacting', 'PreCompact set status compacting (useHive.ts:492)');

  // The user keeps talking and hive mail keeps arriving while the agent is wedged.
  useStore.getState().enqueueMessage('w1', 'did the compact finish?');
  useStore.getState().enqueueMessage('w1', 'god directive: report status to god.');
  // Hive mail arrives; the wake loop (#3) polls the inbox and queues its nudge.
  // Two wake-only ticks (no drain, no sweep) - the nudge must exist before the
  // delivery phase so the starvation claim covers the system's own unstick
  // mechanism, and so the one-pending-nudge dedupe has already collapsed the
  // repeated polls into a single queued nudge.
  await tick(wake, 10);
  virtualNow += 60_000;
  await tick(wake, 10);
  assert.equal(queue().length, 4, 'three user/system messages + one nudge queued before delivery resumes');
  const nudgeCount = queue().filter((m) => m.text.startsWith('You have new hive inbox message(s)')).length;
  assert.equal(nudgeCount, 1, 'the wake loop queued exactly one inbox nudge (one-pending dedupe)');

  // One minute of floor time per wedge cycle: the sweep polls and the wake loop
  // keeps polling. Over an hour passes. (No drain ticks yet - the wedge phase
  // demonstrates what the sweep does and does not rescue; delivery is phase two.)
  for (let i = 0; i < 70; i++) {
    virtualNow += 60_000;
    await tick(sweep, 10);
    await tick(wake, 10);
  }
  const quietMs = virtualNow - PTY_LAST_OUTPUT_AT;

  // Documented gap - the sweep cannot rescue 'compacting': after >1h of PTY
  // silence the agent is still wedged (the sweep only flips status === 'working').
  // That is fine: the fix admits a quiesced 'compacting' agent through the
  // delivery gate; it does not rewrite the avatar's status.
  assert.equal(
    state().status, 'compacting',
    'after 70 quiescence sweeps across >1h of PTY silence the agent is STILL compacting - ' +
    'the sweep skips every status except "working" (useHive.ts:663)'
  );

  // The fix: a terminal silent for over an hour - far past QUIESCE_IDLE_MS - is
  // the same evidence the gate already trusts for a breaker-pinned 'looping'
  // agent, so 'compacting' must release the prompt too. On the pre-fix code
  // this returned false and the queue below starved forever.
  const gate = canDeliverToAgent(state().status, quietMs, 12_000);
  assert.equal(
    gate, true,
    "canDeliverToAgent must admit a 'compacting' agent once its PTY has been silent " +
    'past quiesceMs - PreCompact has no timeout and no crash fires PostCompact, so ' +
    'the status alone must never hold the queue (queueDelivery.ts)'
  );
  // ...but a compacting agent that is still emitting bytes keeps the prompt, and
  // unmeasured silence still fails closed - the fix is not a blanket unlock.
  assert.equal(canDeliverToAgent('compacting', 0, 12_000), false,
    'still emitting bytes mid-compact - do not type into a live compact');
  assert.equal(canDeliverToAgent('compacting', null, 12_000), false,
    'unmeasured silence is not evidence of quiet');

  // Delivery phase: drain cycles with a settle long enough for each write chain
  // (readiness handshake + text + Enter) to finish before the clock jumps again.
  for (let i = 0; i < 12 && queue().length > 0; i++) {
    virtualNow += 60_000;
    await tick(sweep, 10);
    await tick(drain, 1500);
    await tick(wake, 10);
  }

  const remaining = queue().length;
  assert.equal(
    remaining, 0,
    `REGRESSION: agent wedged in "compacting" starves its whole message queue - after >1h of PTY silence ` +
    `and ${70 + 12} sweep/drain cycles the queue still holds ${remaining} message(s) with ` +
    `${written.length} PTY writes (canDeliverToAgent('compacting', ${quietMs}ms, 12000) = ${gate}, ` +
    `and the quiescence sweep never rescues 'compacting', so nothing below the head can move)`
  );
  assert.ok(written.length >= 8, `expected >=8 PTY writes (4 messages x text+Enter), got ${written.length}`);
  assert.ok(written.some((p) => p.includes('Please summarize the auth module')), 'user message delivered');
  assert.ok(written.some((p) => p.includes('did the compact finish?')), 'second user message delivered');
  assert.ok(written.some((p) => p.includes('god directive: report status to god')), 'god directive delivered');
  assert.ok(written.some((p) => p.includes('You have new hive inbox message(s)')), 'inbox nudge delivered');

  console.log(
    `PASS: wedged agent deliverable again, queue drained in order (${written.length} PTY writes)`
  );
  process.exit(0);
}

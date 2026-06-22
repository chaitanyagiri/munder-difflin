// Deterministic acceptance verify for the keep-alive power-hardening fix
// (card impl-keepalive-hardening). Run: `node scripts/verify-keepalive-catchup.mjs`
//
// This repo ships no test runner, and src/main/index.ts cannot be imported outside
// Electron (top-level `electron` + native deps). So this script mirrors the EXACT
// production catch-up logic — the `remaining = Math.max(0, intervalMs - (now -
// lastFiredAt))` arming line plus the setTimeout -> setInterval settle from
// syncMissions(), and the "re-arm on wake" of onSystemResume() — under a
// controllable fake clock, and asserts the guarantees the fix rests on:
//   1. A mission overdue across sleep fires EXACTLY ONCE on resume (coalesced
//      catch-up — never N replays of every tick missed while asleep).
//   2. After the catch-up it settles back to its steady interval cadence.
//   3. A mission NOT yet due does not fire early on resume.
//   4. Overlapping resume + unlock-screen events collapse to ONE catch-up fire
//      (onSystemResume is idempotent: clear-then-arm).
//   5. PRE-FIX REGRESSION: the hive message router is a setInterval (routeOnce
//      every ~1.5s) that freezes across true system sleep just like the beats;
//      the old onSystemResume re-armed the scheduler + beats but NOT the router,
//      so an outbox that piled up while asleep stayed undelivered after wake.
//   6. FIX: the new onSystemResume re-arms the router AND flushes the backlog
//      immediately on wake (no tick wait) — god->worker mail delivers on resume.
//   7. FIX: the re-armed router keeps draining subsequent mail at its cadence.

// ---- fake clock + timer queue (libuv-style monotonic; we control advancement) --
let nowMs = 1_000_000;            // arbitrary "boot" instant
let nextId = 1;
const timers = new Map();         // id -> { fireAt, fn, kind, intervalMs }
const setT = (fn, delay) => { const id = nextId++; timers.set(id, { fireAt: nowMs + delay, fn, kind: 'timeout' }); return id; };
const setI = (fn, delay) => { const id = nextId++; timers.set(id, { fireAt: nowMs + delay, fn, kind: 'interval', intervalMs: delay }); return id; };
const clr  = (id) => { timers.delete(id); };
function advance(ms) {
  const target = nowMs + ms;
  while (true) {
    let next = null;
    for (const [id, t] of timers) if (t.fireAt <= target && (next === null || t.fireAt < timers.get(next).fireAt)) next = id;
    if (next === null) { nowMs = target; return; }
    const t = timers.get(next);
    nowMs = t.fireAt;
    if (t.kind === 'interval') t.fireAt += t.intervalMs; else timers.delete(next);
    t.fn();
  }
}

// ---- production logic mirror (verbatim shape from src/main/index.ts) -----------
let fireCount = 0;
let missionsUpdatedEmits = 0;
const missionTimers = new Map();
function clearMissionTimers() {
  for (const e of missionTimers.values()) { if (e.timeout) clr(e.timeout); if (e.interval) clr(e.interval); }
  missionTimers.clear();
}
function syncMissions(m) {
  clearMissionTimers();
  const fire = () => { fireCount++; m.lastFiredAt = nowMs; missionsUpdatedEmits++; /* mirrors liveWebContents().send('missions:updated') */ };
  const remaining = Math.max(0, m.intervalMs - (nowMs - (m.lastFiredAt ?? 0)));   // <- the exact line from index.ts
  const entry = {};
  entry.timeout = setT(() => { fire(); entry.interval = setI(fire, m.intervalMs); }, remaining);
  missionTimers.set(m.id, entry);
}
const onSystemResume = (m) => { syncMissions(m); };   // resume's scheduler re-arm (beats/keep-awake are not timer-fire-counted here)

// ---- assertions ----------------------------------------------------------------
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };
const reset = () => { fireCount = 0; missionsUpdatedEmits = 0; clearMissionTimers(); };

const HOUR = 60 * 60 * 1000;

// (1)+(2) Overdue across a long sleep -> ONE catch-up fire, then steady cadence.
reset();
let m = { id: 'standup', intervalMs: HOUR, lastFiredAt: nowMs - 5 * HOUR };  // slept ~5h past a 1h interval
onSystemResume(m);                 // wake: re-arm scheduler
advance(0);                        // flush the remaining=0 catch-up timeout
ok(fireCount === 1, `overdue-by-5h fires exactly ONCE on resume (not 5x) -> fireCount=${fireCount}`);
ok(missionsUpdatedEmits === 1, `missions:updated emitted on the catch-up fire -> emits=${missionsUpdatedEmits}`);
advance(HOUR);
ok(fireCount === 2, `settles to interval: +1 fire after one more hour -> fireCount=${fireCount}`);
advance(HOUR);
ok(fireCount === 3, `still steady: +1 fire after the next hour -> fireCount=${fireCount}`);

// (3) Not yet due -> no early fire on resume.
reset();
m = { id: 'soon', intervalMs: HOUR, lastFiredAt: nowMs - 10 * 60 * 1000 };   // fired 10m ago
onSystemResume(m);
advance(0);
ok(fireCount === 0, `mission fired 10m ago does NOT fire early on resume -> fireCount=${fireCount}`);
advance(49 * 60 * 1000);
ok(fireCount === 0, `still not due at +49m -> fireCount=${fireCount}`);
advance(2 * 60 * 1000);
ok(fireCount === 1, `fires once it reaches its due time (~+51m) -> fireCount=${fireCount}`);

// (4) Idempotent: resume + unlock-screen back-to-back -> ONE catch-up fire.
reset();
m = { id: 'standup', intervalMs: HOUR, lastFiredAt: nowMs - 3 * HOUR };
onSystemResume(m);                 // 'resume'
onSystemResume(m);                 // 'unlock-screen' immediately after — must cancel the pending 0-timer, re-arm
advance(0);
ok(fireCount === 1, `resume+unlock collapse to ONE catch-up fire (idempotent) -> fireCount=${fireCount}`);

// ---- router re-arm on wake (the god->worker delivery fix) -----------------------
// Mirror of the hive message router: a setInterval that drains every agent's
// outbox into recipient inboxes (hive.startRouter/stopRouter/routeOnce). Like the
// always-on beats it freezes across true system sleep; the fix re-arms it AND
// flushes the backlog in onSystemResume's new router block.
const ROUTER_MS = 1500;
let queue = 0;          // outbox messages awaiting routing (e.g. god's pile-up)
let delivered = 0;      // messages routed into recipient inboxes
let routerTimer = null;
const routeOnce   = () => { const n = queue; queue = 0; delivered += n; return n; }; // mirrors hive.routeOnce()
const startRouter = () => { if (routerTimer === null) routerTimer = setI(routeOnce, ROUTER_MS); }; // idempotent, like hive.startRouter
const stopRouter  = () => { if (routerTimer !== null) { clr(routerTimer); routerTimer = null; } };
const resumeOld   = () => { /* BUG: scheduler/beats re-armed, router left frozen */ };
const resumeNew   = () => { stopRouter(); startRouter(); routeOnce(); };  // the new onSystemResume router block

reset();
startRouter();
queue = 1; advance(ROUTER_MS);
ok(delivered === 1, `awake: router drains a freshly-written outbox within one tick -> delivered=${delivered}`);

stopRouter();                 // true system sleep halts the libuv interval (dead until re-armed)
queue += 3;                   // god's outbox accumulates while the floor is asleep
advance(100 * ROUTER_MS);     // wall-clock passes; the frozen timer never fires
ok(delivered === 1, `asleep: frozen router does NOT drain the backlog -> delivered=${delivered}`);

// (5) PRE-FIX: old resume leaves the router dead -> the backlog never delivers.
resumeOld();
advance(100 * ROUTER_MS);
ok(delivered === 1, `pre-fix resume: backlog STAYS undelivered (reproduces the bug) -> delivered=${delivered}`);

// (6) FIX: new resume re-arms + flushes immediately on wake (no tick wait).
resumeNew();
advance(0);
ok(delivered === 4, `fixed resume: backlog flushed immediately on wake -> delivered=${delivered}`);

// (7) FIX: the re-armed router keeps draining subsequent mail at its cadence.
queue += 2; advance(ROUTER_MS);
ok(delivered === 6, `fixed resume: re-armed router drains subsequent mail -> delivered=${delivered}`);

console.log(failures === 0 ? '\nALL CHECKS PASS' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

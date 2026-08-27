'use strict';

// message_sent (v0.4.7) — the end of the activation funnel: a COUNT of the
// messages a HUMAN sends to an agent, and nothing else.
//
// Three things are asserted here, and the third is the one that matters most:
//
//  1. the event passes the analytics allowlist, enforces its closed `surface`
//     enum, stays anonymous, and is suppressed by every opt-out;
//  2. the counter counts at the SUBMIT boundary, not per keystroke;
//  3. the WIRING. A miscounted event is a wrong number, which someone notices.
//     A mis-WIRED one records zero forever while CI stays green, and reads as
//     "nobody talks to their agents" — the fails-open shape this repo has been
//     bitten by repeatedly. So the IPC channel name, the surface literals at
//     each call site, and the doc/code lockstep are all asserted against the
//     source text (index.ts imports electron and cannot load under plain node —
//     the same pattern the rest of the suite uses for main-process wiring).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

globalThis.__POSTHOG_KEY__ = 'test-key';
globalThis.__POSTHOG_HOST__ = 'https://example.invalid';
delete process.env.DO_NOT_TRACK;

const captured = [];
class FakePostHog {
  capture(payload) { captured.push(payload); }
  async shutdown() {}
}
const posthogPath = require.resolve('posthog-node');
require.cache[posthogPath] = {
  id: posthogPath, filename: posthogPath, loaded: true, exports: { PostHog: FakePostHog }
};

const { Analytics, MESSAGE_SURFACES, isRendererMessageSurface } = loadTs('src/main/analytics.ts');

const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
const main = read('src/main/index.ts');
const preload = read('src/preload/index.ts');
const telemetryDoc = read('TELEMETRY.md');

function bootedAnalytics(opts = {}) {
  const a = new Analytics();
  a.init({
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'md-msg-count-')),
    appVersion: '0.4.7',
    enabled: opts.enabled !== false
  });
  captured.length = 0; // drop first_run / app_launched from init
  return a;
}

const messageEvents = () => captured.filter((c) => c.event === 'message_sent');

// ── the event and its closed enum ────────────────────────────────────────────

test('every surface in the enum is accepted and lands as the surface property', () => {
  const a = bootedAnalytics();
  for (const surface of MESSAGE_SURFACES) a.trackMessageSent(surface);
  assert.deepEqual(messageEvents().map((c) => c.properties.surface), [...MESSAGE_SURFACES]);
  assert.equal(messageEvents()[0].properties.app_version, '0.4.7');
});

test('a surface outside the enum sends nothing at all', () => {
  const a = bootedAnalytics();
  // Not "sends the event with the property dropped" — sends NOTHING. track()'s
  // allowlist filters property KEYS, not VALUES, so a bad value would otherwise
  // ride along as free-form text, which TELEMETRY.md promises never happens.
  for (const junk of ['slack', '', 'TERMINAL', '/Users/someone/secret-repo', null, 42, {}]) {
    a.trackMessageSent(junk);
  }
  assert.equal(messageEvents().length, 0);
});

test('the event carries a count and nothing else — no content in any shape', () => {
  const a = bootedAnalytics();
  // The one and only property is `surface`. Anything a future call site tried to
  // smuggle alongside it — text, a length, a hash — is dropped by the allowlist.
  a.track('message_sent', {
    surface: 'composer',
    text: 'deploy the thing to prod',
    length: '24',
    body_hash: 'ab12cd34',
    agent_id: 'kevin-mt6kt4po'
  });
  const props = messageEvents()[0].properties;
  assert.equal(props.surface, 'composer');
  for (const k of ['text', 'length', 'body_hash', 'agent_id']) {
    assert.equal(props[k], undefined, `${k} must never be sent`);
  }
  // …and the properties that DO survive are only the surface plus the common
  // stamp every event already carries. This catches a new leak by exhaustion,
  // not by naming it in advance.
  assert.deepEqual(
    Object.keys(props).sort(),
    ['$ip', '$process_person_profile', 'app_version', 'arch', 'os', 'surface']
  );
});

test('it is a meter, not an adoption flag: repeats are not deduped', () => {
  // feature_used dedups per session on purpose; this one must not, or the count
  // the founder asked for would flatten to "at least one message, ever".
  const a = bootedAnalytics();
  for (let i = 0; i < 5; i++) a.trackMessageSent('terminal');
  assert.equal(messageEvents().length, 5);
});

test('the event stays anonymous by construction', () => {
  const a = bootedAnalytics();
  a.trackMessageSent('hive');
  assert.equal(messageEvents()[0].properties.$process_person_profile, false);
  assert.equal(messageEvents()[0].properties.$ip, null);
});

// ── every opt-out suppresses it, like every other event ──────────────────────

test('the Settings opt-out suppresses it at boot', () => {
  const a = bootedAnalytics({ enabled: false });
  a.trackMessageSent('composer');
  assert.equal(messageEvents().length, 0);
});

test('flipping the Settings switch off mid-session stops it instantly', () => {
  const a = bootedAnalytics();
  a.trackMessageSent('composer');
  a.setEnabled(false);
  a.trackMessageSent('composer');
  a.trackMessageSent('terminal');
  assert.equal(messageEvents().length, 1, 'only the pre-opt-out message counts');
  a.setEnabled(true);
  a.trackMessageSent('steer');
  assert.equal(messageEvents().length, 2, 'and it resumes when switched back on');
});

test('DO_NOT_TRACK suppresses it, re-checked at send so it cannot be raced', () => {
  const a = bootedAnalytics();
  process.env.DO_NOT_TRACK = '1';
  try {
    a.trackMessageSent('terminal');
    assert.equal(messageEvents().length, 0);
  } finally {
    delete process.env.DO_NOT_TRACK;
  }
});

test('a build with no PostHog key never sends it', () => {
  const key = globalThis.__POSTHOG_KEY__;
  globalThis.__POSTHOG_KEY__ = '';
  try {
    const a = bootedAnalytics();
    a.trackMessageSent('terminal');
    assert.equal(messageEvents().length, 0);
  } finally {
    globalThis.__POSTHOG_KEY__ = key;
  }
});

test('nothing is counted after the session has ended', () => {
  const a = bootedAnalytics();
  return a.endSession().then(() => {
    a.trackMessageSent('terminal');
    assert.equal(messageEvents().length, 0);
  });
});

// ── the renderer seam: narrower than the enum, on purpose ────────────────────

test('the renderer may name only the two surfaces main cannot see for itself', () => {
  assert.equal(isRendererMessageSurface('terminal'), true);
  assert.equal(isRendererMessageSurface('composer'), true);
  // steer and hive are counted in main at their own IPC handlers. If the
  // renderer could name them too, a future call site would double-count.
  assert.equal(isRendererMessageSurface('steer'), false);
  assert.equal(isRendererMessageSurface('hive'), false);
  for (const junk of ['', 'slack', null, undefined, 7, {}, ['terminal']]) {
    assert.equal(isRendererMessageSurface(junk), false, `junk: ${String(junk)}`);
  }
});

// ── WIRING: the part that fails open ─────────────────────────────────────────

test('the renderer IPC channel name is identical on both sides of the bridge', () => {
  // A typo here is silent in both directions and the counter reads zero forever.
  const CHANNEL = "'analytics:messageSent'";
  assert.ok(main.includes(`ipcMain.handle(${CHANNEL}`), 'main must handle the channel');
  assert.ok(preload.includes(`ipcRenderer.invoke(${CHANNEL}`), 'preload must invoke the same channel');
});

test('the renderer cannot name the event, only the surface', () => {
  // The channel takes a surface and the handler hard-codes the event name, so a
  // compromised or buggy renderer cannot invent an event or attach a property.
  assert.match(main, /ipcMain\.handle\('analytics:messageSent', \(_evt, surface: unknown\) => \{/);
  assert.match(main, /if \(!isRendererMessageSurface\(surface\)\) return \{ ok: false \};/);
  assert.match(main, /analytics\.trackMessageSent\(surface\);/);
});

test('the bridge takes a surface and nothing that could carry a message', () => {
  const sig = preload.match(/trackMessageSent: \(([^)]*)\)/);
  assert.ok(sig, 'preload must expose trackMessageSent');
  assert.equal(sig[1], "surface: 'terminal' | 'composer'", 'one closed-enum argument, no text parameter');
});

test('a telemetry failure can never break sending a message', () => {
  // The bridge swallows both outcomes, and both call sites are fire-and-forget.
  assert.match(preload, /ipcRenderer\.invoke\('analytics:messageSent', surface\)\.then\(\(\) => undefined, \(\) => undefined\)/);
});

test('the terminal counts at the submit boundary, not at pty:write', () => {
  const pool = read('src/renderer/src/components/terminalPool.ts');
  // pty:write fires on every keystroke — counting there is the keystroke trap.
  assert.ok(!main.includes("ipcMain.handle('pty:write'") ||
    !/pty:write[\s\S]{0,400}?trackMessageSent/.test(main), 'pty:write must not count messages');
  // The count sits in the onData handler, gated on an actual submitted line.
  assert.match(pool, /if \(submitted && !pasted\) void window\.cth\.trackMessageSent\('terminal'\);/);
  // …and `submitted` is only ever set where a non-trivial line was flushed.
  assert.match(pool, /if \(t\.length >= 2\) \{\s*entry\.onPrompt\?\.\(t\);\s*submitted = true;\s*\}/);
  // …and a bracketed paste is excluded, so a multi-line paste is not N messages.
  assert.match(pool, /const pasted = data\.includes\('\\x1b\[200~'\);/);
});

test('the composer counts its own submit, not the shared enqueue action', () => {
  const composer = read('src/renderer/src/components/MessageQueueComposer.tsx');
  // enqueueMessage is also how work orders, Slack inbound, nudges and compact
  // commands reach an agent. Counting inside it would count all of those.
  assert.match(composer, /enqueueMessage\(agent\.id, body\);\n(?:\s*\/\/.*\n)*\s*void window\.cth\.trackMessageSent\('composer'\);/);
  const store = read('src/renderer/src/store/store.ts');
  assert.ok(!store.includes('trackMessageSent'), 'the store action must not count');
});

test('the composer inherits the IME guard instead of restating it', () => {
  const composer = read('src/renderer/src/components/MessageQueueComposer.tsx');
  // An Enter that picks an IME candidate is not a submit. The count sits inside
  // queueIt(), which the key handler only reaches past isComposingKey — so a
  // Japanese or Chinese user cannot inflate their own count on candidate
  // selection. Assert the guard is still the first thing that handler does.
  assert.match(composer, /const onKey = \(e: KeyboardEvent<HTMLTextAreaElement>\) => \{\s*if \(isComposingKey\(e\)\) return;/);
});

test('only human hive messages are counted, never agent-to-agent traffic', () => {
  assert.match(main, /if \(sender === 'human'\) analytics\.trackMessageSent\('hive'\);/);
  // Counted at the IPC handler, which is the only place `from` exists; hive.send
  // itself is called all over main by agents.
  const hive = read('src/main/hive.ts');
  assert.ok(!hive.includes('trackMessageSent'), 'hive.ts must not count');
});

test('steer is counted at the IPC seam, not inside control.steer', () => {
  assert.match(main, /control\.steer\(agentId, text\);\n(?:\s*\/\/.*\n)*\s*analytics\.trackMessageSent\('steer'\);/);
  // closingTime and the voice action layer call control.steer directly and are
  // not a person typing; counting inside control.ts would sweep them in.
  const control = read('src/main/control.ts');
  assert.ok(!control.includes('trackMessageSent'), 'control.ts must not count');
});

// ── doc/code lockstep ────────────────────────────────────────────────────────

test('TELEMETRY.md documents message_sent and every value of its enum', () => {
  assert.ok(telemetryDoc.includes('`message_sent`'), 'the event must be in the doc');
  for (const surface of MESSAGE_SURFACES) {
    assert.ok(telemetryDoc.includes(`\`${surface}\``), `surface ${surface} must be documented`);
  }
});

test('every event in the allowlist is described in TELEMETRY.md, and vice versa', () => {
  // The published policy and the code have contradicted each other twice in this
  // repo's history. This makes a third contradiction fail the build instead of
  // shipping: the doc's event table and the allowlist must name the same events.
  const analyticsSrc = read('src/main/analytics.ts');
  const block = analyticsSrc.slice(
    analyticsSrc.indexOf('const EVENTS'),
    analyticsSrc.indexOf('/** The only values `feature_used')
  );
  const inCode = [...block.matchAll(/^\s{2}([a-z_]+): new Set<string>/gm)].map((m) => m[1]);
  assert.ok(inCode.includes('message_sent') && inCode.length >= 10, `parsed events: ${inCode}`);

  const rows = telemetryDoc.slice(telemetryDoc.indexOf('The events:'), telemetryDoc.indexOf('### About'));
  const inDoc = [...rows.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);

  assert.deepEqual(inCode.slice().sort(), inDoc.slice().sort(),
    'analytics.ts EVENTS and the TELEMETRY.md table must list exactly the same events');
});

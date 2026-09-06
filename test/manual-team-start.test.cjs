'use strict';

/**
 * Manual-start mode: with `config.manualTeamStart` on, NOTHING auto-boots on
 * launch — not the god agent, not the previous session's team — until the
 * user clicks Start. Off (the default), behavior is byte-for-byte what it was
 * before this feature: the two existing auto-boot effects fire the moment
 * their own preconditions are met, exactly as `restart-cancel.test.cjs` pins a
 * different wiring bug the same way — by reading the source, because the bug
 * this guards is a wiring bug, not a pure-function bug. Nothing here is
 * mountable: this repo has no React test harness, so the contract is pinned
 * the same way every other cross-file wiring rule in this suite is.
 *
 * What has to hold, across every file this touches:
 *   1. The default is OFF, and an absent value reads as off — a config saved
 *      before this field existed must not suddenly stop auto-starting.
 *   2. BOTH auto-boot effects (god in useHive.ts, the team in
 *      useRestoreTeam.ts) check the SAME gate — gating only one would leave
 *      Michael running with a silent, roleless team, or vice versa.
 *   3. The gate reads a store flag reactively (not a one-time snapshot), so
 *      clicking Start unblocks an effect that already mounted and bailed.
 *   4. The flag is session state, never persisted — the whole point is that
 *      every fresh launch waits for the click again.
 *   5. There are two ways to click Start (header + the empty-floor panel),
 *      and both call the exact same store action — a header-only fix would
 *      leave a stale button on the empty floor.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

// Normalized to LF: a Windows checkout of this same, byte-identical git blob
// can materialize with CRLF line endings (core.autocrlf), which would silently
// break every `\n`-anchored indexOf/regex below despite the committed content
// being unchanged.
const read = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

test('the default is off, in the one place that actually ships a default', () => {
  const src = read('src/main/config.ts');
  const defaults = src.slice(src.indexOf('const DEFAULTS: HarnessConfig = {'));
  assert.match(defaults, /manualTeamStart:\s*false,/,
    'an absent/old config must read as the pre-existing auto-start behavior');
});

test('the type exists on all three layers config crosses', () => {
  for (const rel of ['src/main/config.ts', 'src/renderer/src/store/config.ts', 'src/preload/index.ts']) {
    assert.match(read(rel), /manualTeamStart\?\s*:\s*boolean|manualTeamStart:\s*boolean/, rel);
  }
});

test('the store carries session-only start state, not persisted', () => {
  const src = read('src/renderer/src/store/store.ts');
  assert.match(src, /teamStartRequested:\s*boolean;/, 'the field must exist on State');
  assert.match(src, /requestTeamStart:\s*\(\)\s*=>\s*void;/, 'and the action to flip it');
  assert.match(src, /teamStartRequested:\s*false,/, 'initialized false — every launch waits again');
  assert.match(src, /requestTeamStart:\s*\(\)\s*=>\s*set\(\{\s*teamStartRequested:\s*true\s*\}\)/,
    'a plain in-memory flip; nothing here writes to localStorage or the roster file');
});

test('god\'s boot effect is gated, and reads the flag REACTIVELY', () => {
  const src = read('src/renderer/src/hooks/useHive.ts');
  const section = src.slice(src.indexOf('Bootstrap the god agent'));
  const effect = section.slice(0, section.indexOf('\n  }, ['));

  // Snapshotting the flag once (e.g. via getState() only, inside the effect
  // body) would never re-run when Start is clicked — nothing would tell React
  // to look again. It has to come from useStore's hook form, subscribed.
  assert.match(effect, /useStore\(\(s\)\s*=>\s*s\.teamStartRequested\)/,
    'the flag must be a reactive subscription, not a one-time getState() read');
  assert.match(effect, /if\s*\(config\.manualTeamStart\s*&&\s*!teamStartRequested\)\s*return;/,
    'the gate: manual mode AND not yet clicked → do not boot');

  const depsLine = section.match(/}, \[[^\]]*\]\);/)[0];
  assert.match(depsLine, /config\?\.manualTeamStart/, 'a config change must re-run the effect');
  assert.match(depsLine, /teamStartRequested/, 'and so must the click');
});

test('the team\'s auto-restore effect is gated the identical way', () => {
  const src = read('src/renderer/src/hooks/useRestoreTeam.ts');
  // The reactive subscription is set up just BEFORE the effect that reads it
  // (a hook can't call useSyncExternalStore from inside a useEffect body), so
  // this looks at the whole neighborhood rather than only the effect itself.
  const neighborhood = src.slice(
    src.indexOf('const teamStartRequested ='),
    src.indexOf('return { restoring: isRestoring')
  );
  const effect = neighborhood.slice(
    neighborhood.indexOf('useEffect(() => {\n    if (autoStarted'),
    neighborhood.indexOf('\n  }, [')
  );

  assert.match(neighborhood, /useSyncExternalStore\(/,
    'reactive, not a one-shot getState() — same reasoning as the god effect');
  assert.match(effect, /if\s*\(config\.manualTeamStart\s*&&\s*!teamStartRequested\)\s*return;/,
    'the SAME gate condition as useHive — a mismatch here is how you get a running '
    + 'Michael with a team still waiting, or the reverse');

  const depsLine = neighborhood.match(/}, \[[^\]]*\]\);/)[0];
  assert.match(depsLine, /config\?\.manualTeamStart/);
  assert.match(depsLine, /teamStartRequested/);
});

test('App.tsx computes waitingToStart AFTER config exists', () => {
  // The exact bug this pins: `config` is declared via useState further down
  // the component, so a `waitingToStart` computed above it is a TDZ error —
  // not a logic bug, a compile error, but one that only shows up in
  // `tsc --noEmit`, never in an editor's live squiggles for a file this size.
  const src = read('src/renderer/src/App.tsx');
  const configDeclAt = src.indexOf('const [config, setConfig] = useState<HarnessConfig | null>(null);');
  const waitingAt = src.indexOf('const waitingToStart =');
  assert.ok(configDeclAt >= 0 && waitingAt >= 0, 'both must exist');
  assert.ok(waitingAt > configDeclAt, 'waitingToStart must be computed after config is declared');
});

test('the header Start button and the empty-floor panel call the SAME action', () => {
  const src = read('src/renderer/src/App.tsx');
  const readyToStart = read('src/renderer/src/components/ReadyToStart.tsx');

  // Both surfaces exist and are gated on the same flag.
  assert.match(src, /\{waitingToStart && \(\s*<PixelButton/, 'the header button only renders while waiting');
  assert.match(src, /\{agentCount === 0 && waitingToStart && <ReadyToStart \/>\}/,
    'the empty-floor panel takes priority over both MichaelBooting and the plain empty-floor prompt');

  assert.match(src, /onClick=\{requestTeamStart\}/, 'the header button calls the store action directly');
  assert.match(readyToStart, /onClick=\{requestTeamStart\}/, 'so does the panel — a second action here would drift');

  // MichaelBooting must not render while waiting: it means "something is
  // happening", and nothing is.
  assert.match(src, /agentCount === 0 && !waitingToStart && godStatus === 'booting' && <MichaelBooting \/>/);
});

test('every godStatus === booting check in App.tsx is guarded by waitingToStart', () => {
  // godStatus defaults to 'booting' and stays there for as long as the boot
  // effect is held off, so an ungated check here says "Michael is clocking
  // in" indefinitely for something that is not happening. This is not
  // hypothetical: the sidebar's "no agent selected" panel shipped with
  // exactly this bug in the first version of this feature.
  const src = read('src/renderer/src/App.tsx');
  const checks = [...src.matchAll(/godStatus === 'booting'/g)];
  assert.ok(checks.length >= 1, 'the file must still have at least one such check to guard');
  for (const m of checks) {
    // Wide enough to reach back across a whole guarded JSX panel (the sidebar
    // branch is a ternary chain: `waitingToStart ? (<panel/>) : godStatus ===
    // 'booting' ? …`, and that first panel's markup sits between the two).
    const before = src.slice(Math.max(0, m.index - 1500), m.index);
    assert.match(before, /!waitingToStart|waitingToStart \? /,
      'every godStatus-booting branch must be reached only when NOT waiting for Start');
  }
});

test('the restorable list lets you set a duty without spawning the agent', () => {
  // The whole point of manual-start mode is assigning roles before Start —
  // the store already carries `duty` on every Agent, and hivePatchAgentDuty
  // never required a live PTY, so this is a UI gap, not a backend one.
  const store = read('src/renderer/src/store/store.ts');
  assert.match(store, /setRestorableAgentDuty:\s*\(id:\s*string,\s*duty:\s*AgentDuty\)\s*=>\s*void;/);
  assert.match(store, /setRestorableAgentDuty:\s*\(id,\s*duty\)\s*=>/, 'and it must be implemented');

  const strip = read('src/renderer/src/components/AgentStrip.tsx');
  const list = strip.slice(strip.indexOf('{restorableAgents.map((a: Agent) =>'));
  assert.match(list, /setRestorableAgentDuty\(a\.id, duty\)/, 'the local mirror is kept in sync');
  assert.match(list, /hivePatchAgentDuty\(a\.id, duty\)/, 'and the hive registry — the durable, gate-relevant write');
  assert.match(list, /AGENT_DUTIES\.map/, 'options come from the shared duty set, not a hand-typed list');
});

test('the Settings toggle writes manualTeamStart, defaulting off from an absent value', () => {
  const src = read('src/renderer/src/components/SettingsModal.tsx');
  assert.match(src, /useState<boolean>\(cfgX\.manualTeamStart === true\)/,
    '=== true, not !== false — an absent value must read as OFF here, the opposite '
    + 'polarity of autoMode further up in this same file, which defaults ON');
  assert.match(src, /stage\(\{ manualTeamStart: next \} as Partial<HarnessConfig>\)/);
});

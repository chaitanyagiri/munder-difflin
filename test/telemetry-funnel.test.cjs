'use strict';

// Activation-funnel telemetry (v0.4.7): the 5 new events must pass the analytics
// allowlist, enforce their closed enums (drop any unknown key), stay anonymous, and
// be wired at the four spawn-funnel sites in index.ts. index.ts imports electron and
// cannot load under plain node, so its wiring is asserted against the source text —
// the same pattern the rest of the suite uses for main-process wiring.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// Stub the build-time key + PostHog BEFORE analytics.ts loads, exactly like
// update-applied.test.cjs, so the class runs end to end with no network or key.
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

const { Analytics } = loadTs('src/main/analytics.ts');

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-telemetry-funnel-'));
}

function bootedAnalytics() {
  const a = new Analytics();
  a.init({ stateDir: freshDir(), appVersion: '0.4.7', enabled: true });
  captured.length = 0; // drop the first_run / app_launched from init
  return a;
}

// ── the allowlist accepts the new events and enforces their enums ─────────────

test('all five funnel events are on the allowlist and carry their properties', () => {
  const a = bootedAnalytics();
  a.track('onboarding_completed', { provider: 'gemini' });
  a.track('agent_spawn_attempted', { provider: 'claude' });
  a.track('agent_spawn_failed', { provider: 'codex', reason: 'cli_missing' });
  a.track('agent_install_started', { provider: 'claude', rung: 'npm' });
  a.track('agent_install_finished', { provider: 'claude', rung: 'npm', outcome: 'install_failed' });

  const byEvent = Object.fromEntries(captured.map((c) => [c.event, c.properties]));
  assert.equal(byEvent.onboarding_completed.provider, 'gemini');
  assert.equal(byEvent.agent_spawn_attempted.provider, 'claude');
  assert.equal(byEvent.agent_spawn_failed.reason, 'cli_missing');
  assert.equal(byEvent.agent_install_started.rung, 'npm');
  assert.equal(byEvent.agent_install_finished.outcome, 'install_failed');
  // Common props still stamped on the new events.
  assert.equal(byEvent.agent_spawn_attempted.app_version, '0.4.7');
});

test('an unknown property on a new event is dropped, never sent', () => {
  const a = bootedAnalytics();
  // A caller that tries to smuggle a free-form value must not leak it.
  a.track('agent_spawn_failed', { provider: 'claude', reason: 'spawn_error', cwd: '/Users/someone/secret-repo' });
  const props = captured.find((c) => c.event === 'agent_spawn_failed').properties;
  assert.equal(props.reason, 'spawn_error');
  assert.equal(props.cwd, undefined, 'the un-allowlisted key must be dropped');
});

test('the new events stay anonymous by construction', () => {
  const a = bootedAnalytics();
  a.track('agent_install_finished', { provider: 'claude', rung: 'native', outcome: 'agent_launched' });
  const props = captured.find((c) => c.event === 'agent_install_finished').properties;
  assert.equal(props.$process_person_profile, false);
});

// ── index.ts wires the funnel at the four spawn sites ─────────────────────────

const main = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/index.ts'), 'utf8');

test('agent_spawn_attempted fires once per attempt, gated against the install relaunch', () => {
  assert.match(main, /if \(!opts\.noAutoInstall\) analytics\.track\('agent_spawn_attempted', \{ provider \}\);/);
});

test('the real spawn reports both success and failure', () => {
  assert.match(main, /if \(res\.ok\) analytics\.track\('agent_spawned', \{ provider \}\);/);
  assert.match(main, /else analytics\.track\('agent_spawn_failed', \{ provider, reason: spawnFailReason\(res\.error\) \}\);/);
});

test('the missing-CLI branch distinguishes installer-running, Mode 2, and spawn error', () => {
  assert.match(main, /analytics\.track\('agent_install_started', \{ provider, rung: rung\.kind \}\);/);
  assert.match(main, /analytics\.track\('agent_spawn_failed', \{ provider, reason: 'cli_missing' \}\);/);
});

test('the install-PTY exit reports whether the auto-installer completed', () => {
  assert.match(main, /analytics\.track\('agent_install_finished', \{ provider, rung: pending\.rung, outcome: 'agent_launched' \}\);/);
  assert.match(main, /analytics\.track\('agent_install_finished', \{ provider, rung: pending\.rung, outcome: 'install_failed' \}\);/);
});

test('onboarding completion is reported on the false to true transition', () => {
  assert.match(main, /if \(!wasOnboarded && next\.onboardingComplete\) \{/);
  assert.match(main, /analytics\.track\('onboarding_completed', \{ provider: next\.godProvider \?\? 'claude' \}\);/);
});

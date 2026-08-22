'use strict';

/**
 * The app is often launched from inside a Claude Code session, and the parent
 * session's identity markers used to flow into every agent PTY. One of them
 * (CLAUDE_CODE_CHILD_SESSION) silently disables transcript saving, which broke
 * --resume for every agent of a run — invisible until someone needed a resume.
 * These tests pin the layering rule: inherited env is stripped of the parent's
 * Claude identity by PREFIX, config-not-identity names survive, and per-agent
 * values always win.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { buildPtyEnv } = loadTs('src/main/ptyEnv.ts');

/** The twelve markers dumped from a live Claude Code session in review of the
 *  fix — the original hardcoded list caught only the first five. */
const LIVE_SESSION_MARKERS = {
  CLAUDE_CODE_CHILD_SESSION: 'true',
  CLAUDE_CODE_SESSION_ID: 'abc-123',
  CLAUDE_PID: '4242',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/claude.sock',
  CLAUDE_CODE_MESSAGING_TOKEN: 'tok',
  CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1',
  CLAUDE_EFFORT: 'high',
  CLAUDE_CODE_EXECPATH: '/usr/local/bin/claude',
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX: 'rc'
};

test('every live-session identity marker is stripped from the inherited env', () => {
  const env = buildPtyEnv({ HOME: '/Users/x', ...LIVE_SESSION_MARKERS }, '/bin', undefined, 'darwin');
  for (const k of Object.keys(LIVE_SESSION_MARKERS)) {
    assert.ok(!(k in env), `${k} must not leak into an agent PTY`);
  }
  assert.equal(env.HOME, '/Users/x');
});

test('markers the CLI has not invented yet are stripped by the prefix rule', () => {
  const env = buildPtyEnv(
    { CLAUDE_CODE_SOME_FUTURE_THING: 'x', CLAUDE_NEXT_YEAR: 'y' },
    '/bin', undefined, 'darwin'
  );
  assert.ok(!('CLAUDE_CODE_SOME_FUTURE_THING' in env));
  assert.ok(!('CLAUDE_NEXT_YEAR' in env));
});

test('operator configuration sharing the prefix survives: config dir, auth, backend', () => {
  const env = buildPtyEnv(
    {
      CLAUDE_CONFIG_DIR: '/Users/x/.claude-alt',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      ...LIVE_SESSION_MARKERS
    },
    '/bin', undefined, 'darwin'
  );
  assert.equal(env.CLAUDE_CONFIG_DIR, '/Users/x/.claude-alt');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth');
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '1');
  assert.equal(env.CLAUDE_CODE_USE_VERTEX, '1');
  assert.ok(!('CLAUDE_CODE_SESSION_ID' in env), 'keep-list must not weaken the strip');
});

test('names that merely start with CLAUDE are not the prefix and survive', () => {
  const env = buildPtyEnv({ CLAUDES_HOUSE: 'blue', ANTHROPIC_API_KEY: 'k' }, '/bin', undefined, 'darwin');
  assert.equal(env.CLAUDES_HOUSE, 'blue');
  assert.equal(env.ANTHROPIC_API_KEY, 'k');
});

test('per-agent env wins over the strip AND over the defaults', () => {
  const env = buildPtyEnv(
    LIVE_SESSION_MARKERS,
    '/bin',
    { CLAUDE_CODE_SESSION_ID: 'deliberate', TERM: 'vt100', AGENT_ID: 'a1' },
    'darwin'
  );
  // A marker set on purpose by the app (or a future per-agent env feature) is
  // NOT wiped — only the inherited layer is stripped.
  assert.equal(env.CLAUDE_CODE_SESSION_ID, 'deliberate');
  assert.equal(env.TERM, 'vt100');
  assert.equal(env.AGENT_ID, 'a1');
});

test('app defaults land: PATH, terminal identity, color', () => {
  const env = buildPtyEnv({ PATH: '/stale' }, '/resolved/bin', undefined, 'darwin');
  assert.equal(env.PATH, '/resolved/bin');
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.COLORTERM, 'truecolor');
  assert.equal(env.FORCE_COLOR, '1');
});

test('locale: UTF-8 defaults on darwin, the user\'s exported locale wins, win32 untouched', () => {
  const bare = buildPtyEnv({}, '/bin', undefined, 'darwin');
  assert.equal(bare.LANG, 'en_US.UTF-8');
  assert.equal(bare.LC_CTYPE, 'en_US.UTF-8');

  const exported = buildPtyEnv({ LANG: 'es_ES.UTF-8', LC_ALL: 'fr_FR.UTF-8' }, '/bin', undefined, 'linux');
  assert.equal(exported.LANG, 'es_ES.UTF-8');
  assert.equal(exported.LC_CTYPE, 'fr_FR.UTF-8');

  const win = buildPtyEnv({}, 'C:\\bin', undefined, 'win32');
  assert.ok(!('LANG' in win));
  assert.ok(!('LC_CTYPE' in win));
});

test('omitEnv deletes an inherited name outright, rather than blanking it', () => {
  // A github.com token inherited into a `*.ghe.com` agent is a value whose mere
  // presence is the bug: the Copilot CLI prefers it over the correctly-scoped
  // keyring credential and posts it to a tenant that can only 401. An empty
  // GH_TOKEN is not the same thing as no GH_TOKEN, so this really removes it.
  const env = buildPtyEnv(
    { GH_TOKEN: 'ghp_dotcom', GITHUB_TOKEN: 'also_dotcom', HOME: '/Users/x' },
    '/bin',
    { COPILOT_GH_HOST: 'microsoft.ghe.com' },
    'darwin',
    ['GH_TOKEN', 'GITHUB_TOKEN']
  );
  assert.ok(!('GH_TOKEN' in env), 'omitted names must be absent, not empty');
  assert.ok(!('GITHUB_TOKEN' in env));
  assert.equal(env.COPILOT_GH_HOST, 'microsoft.ghe.com');
  assert.equal(env.HOME, '/Users/x', 'the rest of the environment is untouched');
});

test('a deliberate per-agent value outranks the omit list, like the Claude strip', () => {
  const env = buildPtyEnv(
    { GH_TOKEN: 'inherited' },
    '/bin',
    { GH_TOKEN: 'scoped-to-this-host' },
    'darwin',
    ['GH_TOKEN']
  );
  assert.equal(env.GH_TOKEN, 'scoped-to-this-host');
});

test('no omit list means no change', () => {
  const env = buildPtyEnv({ GH_TOKEN: 'keep' }, '/bin', undefined, 'darwin');
  assert.equal(env.GH_TOKEN, 'keep');
});

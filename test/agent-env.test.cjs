'use strict';
/**
 * Per-agent env (#105) tests. Self-contained, no test framework — run with
 * `node test/agent-env.test.cjs` (mirrors test/agent-provider.test.cjs). The
 * module under test is dependency-free TypeScript (src/shared/agentEnv.ts), so
 * we transpile it with the bundled `typescript` compiler into a temp dir and
 * require the result. Covers key validation, the denylist, merge precedence,
 * tilde expansion, Claude config-dir resolution, and sensitive-value masking.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const SHARED = path.join(__dirname, '..', 'src', 'shared');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'agentenv-'));
const src = fs.readFileSync(path.join(SHARED, 'agentEnv.ts'), 'utf8');
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
fs.writeFileSync(path.join(out, 'agentEnv.js'), js, 'utf8');
const ae = require(path.join(out, 'agentEnv.js'));

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

const HOME = '/Users/tester';

// ── key validation ───────────────────────────────────────────────────────────
check('accepts a plain key', () => {
  assert.strictEqual(ae.envKeyIssue('CLAUDE_CONFIG_DIR'), null);
});
check('rejects malformed keys', () => {
  assert.ok(ae.envKeyIssue('9BAD'));
  assert.ok(ae.envKeyIssue('has space'));
  assert.ok(ae.envKeyIssue('has-dash'));
  assert.ok(ae.envKeyIssue(''));
});
check('rejects exact denylisted keys', () => {
  for (const k of ['PATH', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) {
    assert.ok(ae.envKeyIssue(k), `${k} should be denied`);
  }
});
check('rejects denylisted prefixes', () => {
  for (const k of ['DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'AGENT_ID', 'HIVE_ROOT', 'CTH_X']) {
    assert.ok(ae.envKeyIssue(k), `${k} should be denied`);
  }
});
check('denylist is case-insensitive on exact names', () => {
  assert.ok(ae.envKeyIssue('Path'));
  assert.ok(ae.envKeyIssue('node_options'));
});

// ── validateAgentEnv ─────────────────────────────────────────────────────────
check('undefined/empty env validates to {}', () => {
  assert.deepStrictEqual(ae.validateAgentEnv(undefined, HOME), { ok: true, env: {} });
  assert.deepStrictEqual(ae.validateAgentEnv({}, HOME), { ok: true, env: {} });
});
check('valid env passes through with tilde expansion', () => {
  const r = ae.validateAgentEnv({ CLAUDE_CONFIG_DIR: '~/.claude-personal', FOO: 'bar' }, HOME);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.env, { CLAUDE_CONFIG_DIR: `${HOME}/.claude-personal`, FOO: 'bar' });
});
check('a denylisted key fails validation with the key named', () => {
  const r = ae.validateAgentEnv({ NODE_OPTIONS: '--require evil' }, HOME);
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('NODE_OPTIONS'));
});
check('a non-string value fails validation', () => {
  const r = ae.validateAgentEnv({ FOO: 42 }, HOME);
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('FOO'));
});

// ── expandTilde ──────────────────────────────────────────────────────────────
check('expands leading ~/ and bare ~', () => {
  assert.strictEqual(ae.expandTilde('~/x/y', HOME), `${HOME}/x/y`);
  assert.strictEqual(ae.expandTilde('~', HOME), HOME);
});
check('does not expand mid-string or ~user', () => {
  assert.strictEqual(ae.expandTilde('a~b', HOME), 'a~b');
  assert.strictEqual(ae.expandTilde('~other/x', HOME), '~other/x');
});

// ── mergeAgentEnv ────────────────────────────────────────────────────────────
check('per-agent env overrides defaults', () => {
  const merged = ae.mergeAgentEnv({ A: '1', B: '2' }, { B: '3', C: '4' });
  assert.deepStrictEqual(merged, { A: '1', B: '3', C: '4' });
});

// ── claudeConfigDirFrom ──────────────────────────────────────────────────────
check('returns expanded CLAUDE_CONFIG_DIR when set', () => {
  assert.strictEqual(
    ae.claudeConfigDirFrom({ CLAUDE_CONFIG_DIR: '~/.claude-personal' }, HOME),
    `${HOME}/.claude-personal`
  );
});
check('returns null when unset/empty/undefined env', () => {
  assert.strictEqual(ae.claudeConfigDirFrom({}, HOME), null);
  assert.strictEqual(ae.claudeConfigDirFrom({ CLAUDE_CONFIG_DIR: '' }, HOME), null);
  assert.strictEqual(ae.claudeConfigDirFrom(undefined, HOME), null);
});

// ── maskSensitiveEnv ─────────────────────────────────────────────────────────
check('masks values whose key looks secret, keeps the rest', () => {
  const masked = ae.maskSensitiveEnv({
    OPENAI_API_KEY: 'sk-abc', MY_TOKEN: 't', DB_SECRET: 's', PASSWORD: 'p',
    CLAUDE_CONFIG_DIR: '/x'
  });
  assert.deepStrictEqual(masked, {
    OPENAI_API_KEY: '•••', MY_TOKEN: '•••', DB_SECRET: '•••', PASSWORD: '•••',
    CLAUDE_CONFIG_DIR: '/x'
  });
});

process.exit(failures ? 1 : 0);

# Per-Agent Environment Variables (Issue #105) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users set env vars (e.g. `CLAUDE_CONFIG_DIR=~/.claude-personal`) per agent and globally, so separate Claude Code profiles work — including telemetry, resume, and permissions-acceptance following the override.

**Architecture:** Env is plain `Record<string, string>` data riding the existing spawn path (renderer `spawnPty` → `spawnAgentCore` → `PtyManager.spawn`, whose `env` merge already exists). A dependency-free `src/shared/agentEnv.ts` owns validation/denylist/tilde-expansion/masking so main, renderer, and tests share one implementation. Merge order: `process.env` → `defaultAgentEnv` (Settings) → per-agent env → internal injections (hive/BYOK/broker always win).

**Tech Stack:** Electron (main/preload/renderer), TypeScript, React, node-pty. Tests are framework-free `.cjs` scripts that transpile shared TS in-process (see `test/agent-provider.test.cjs`).

**Spec:** `docs/superpowers/specs/2026-07-08-per-agent-env-vars-design.md`

## Global Constraints

- `npm run typecheck` (node + web) must stay green — it is the CI gate.
- `src/shared/` files must stay dependency-free: no `electron`, no `node:*` imports, no UI imports.
- New UI derives from design tokens (`var(--cth-…)` CSS vars, existing `PixelButton`/`Row`/`inputStyle` idioms). No ad-hoc colors/fonts.
- Env denylist (exact): `PATH`, `NODE_OPTIONS`, `ELECTRON_RUN_AS_NODE`. Denylist prefixes: `DYLD_`, `LD_`, `AGENT_`, `HIVE_`, `CTH_`.
- Env key regex: `/^[A-Za-z_][A-Za-z0-9_]*$/`.
- A rejected key **fails the spawn** with a specific error — never a silent drop.
- Hire manifests may NOT import env vars (warning surfaced when a manifest carries one).
- Commit after every task with a conventional-commits message.

---

### Task 1: Shared env module `src/shared/agentEnv.ts` (TDD)

**Files:**
- Create: `src/shared/agentEnv.ts`
- Create: `test/agent-env.test.cjs`

**Interfaces (Produces — later tasks rely on these exact signatures):**
```ts
export const ENV_KEY_RE: RegExp;
export type EnvValidation =
  | { ok: true; env: Record<string, string> }
  | { ok: false; error: string };
export function envKeyIssue(key: string): string | null;
export function expandTilde(value: string, home: string): string;
export function validateAgentEnv(env: Record<string, string> | undefined, home: string): EnvValidation;
export function mergeAgentEnv(defaults: Record<string, string>, perAgent: Record<string, string>): Record<string, string>;
export function claudeConfigDirFrom(env: Record<string, string> | undefined, home: string): string | null;
export function maskSensitiveEnv(env: Record<string, string>): Record<string, string>;
```

- [ ] **Step 1: Write the failing test**

Create `test/agent-env.test.cjs` (mirrors `test/agent-provider.test.cjs`'s transpile-and-require pattern):

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/agent-env.test.cjs`
Expected: FAIL — `ENOENT ... src/shared/agentEnv.ts` (module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/shared/agentEnv.ts`:

```ts
/**
 * Per-agent environment variables (#105) — validation, merge, and display rules.
 *
 * Users can attach env vars to an agent (Add Agent modal) and set a global
 * default (Settings). The headline use case is Claude Code profiles:
 * CLAUDE_CONFIG_DIR=~/.claude-personal. Env is plain data end-to-end — there is
 * NO shell in the spawn path, which is also why we expand a leading `~` here.
 *
 * Shared between main and renderer; keep it dependency-free (no electron, no
 * node imports — `home` is always passed in) so tests can transpile it standalone.
 */

/** Valid env key: what a POSIX shell would accept as an identifier. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Keys that can hijack the child process or break the harness's own plumbing.
 *  Checked case-insensitively. PATH is owned by pty.ts (the resolved interactive
 *  shell PATH); NODE_OPTIONS / ELECTRON_RUN_AS_NODE / DYLD_* / LD_* are
 *  code-injection vectors; AGENT_* / HIVE_* / CTH_* are the hive's identity
 *  namespace and must never be user-settable. */
const DENY_EXACT = new Set(['PATH', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']);
const DENY_PREFIXES = ['DYLD_', 'LD_', 'AGENT_', 'HIVE_', 'CTH_'];

/** Why this key is not allowed, or null if it's fine. */
export function envKeyIssue(key: string): string | null {
  if (!ENV_KEY_RE.test(key)) {
    return `invalid env key "${key}" (letters, digits, underscore; can't start with a digit)`;
  }
  const upper = key.toUpperCase();
  if (DENY_EXACT.has(upper)) return `env key "${key}" is reserved and can't be overridden`;
  for (const p of DENY_PREFIXES) {
    if (upper.startsWith(p)) return `env key "${key}" is reserved (${p}*) and can't be overridden`;
  }
  return null;
}

/** Expand a LEADING `~` (bare or `~/…`) to the home dir. No shell in the spawn
 *  path means a literal `~` would reach the child unexpanded. `~user` forms are
 *  left alone — resolving other users' homes is a shell feature we don't want. */
export function expandTilde(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/')) return home + value.slice(1);
  return value;
}

export type EnvValidation =
  | { ok: true; env: Record<string, string> }
  | { ok: false; error: string };

/** Validate user-supplied env and normalize values (tilde expansion). The main
 *  process is the enforcing boundary — a bad key FAILS the spawn (never a silent
 *  drop); the renderer reuses this for immediate inline feedback. */
export function validateAgentEnv(
  env: Record<string, string> | undefined,
  home: string
): EnvValidation {
  if (!env) return { ok: true, env: {} };
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const issue = envKeyIssue(key);
    if (issue) return { ok: false, error: issue };
    if (typeof value !== 'string') return { ok: false, error: `env value for "${key}" must be a string` };
    clean[key] = expandTilde(value, home);
  }
  return { ok: true, env: clean };
}

/** Global default (Settings) → per-agent (Add Agent). Per-agent wins. Internal
 *  injections (hive identity, BYOK, broker) are merged AFTER this by the spawn
 *  path, so they always win over user env. */
export function mergeAgentEnv(
  defaults: Record<string, string>,
  perAgent: Record<string, string>
): Record<string, string> {
  return { ...defaults, ...perAgent };
}

/** The effective Claude config dir an env implies: the tilde-expanded
 *  CLAUDE_CONFIG_DIR, or null when unset (caller falls back to ~/.claude). */
export function claudeConfigDirFrom(
  env: Record<string, string> | undefined,
  home: string
): string | null {
  const raw = env?.CLAUDE_CONFIG_DIR;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return expandTilde(raw.trim(), home);
}

/** Keys whose values must never appear on derived surfaces (fleet.json, roster
 *  IPC, tools/agent-env.cjs). registry.json keeps values verbatim (same trust
 *  level as config.json); everything derived from it masks. */
const SENSITIVE_KEY_RE = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

export function maskSensitiveEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) out[k] = SENSITIVE_KEY_RE.test(k) ? '•••' : v;
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/agent-env.test.cjs`
Expected: every line `ok`, exit code 0.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` — expected green.

```bash
git add src/shared/agentEnv.ts test/agent-env.test.cjs
git commit -m "feat(env): shared per-agent env validation module (#105)"
```

---

### Task 2: Main-process boundary — config field, preload type, spawn validate+merge

**Files:**
- Modify: `src/main/config.ts` (HarnessConfig, ~line 133)
- Modify: `src/preload/index.ts` (SpawnPtyOptions, ~line 164)
- Modify: `src/main/hive.ts` (AgentMeta, ~line 125)
- Modify: `src/main/index.ts` (`spawnAgentCore`, ~line 1802)

**Interfaces:**
- Consumes: `validateAgentEnv`, `mergeAgentEnv` from `@shared/agentEnv` (Task 1). Note: main-process files import shared code via relative path (`../shared/agentEnv`) — match the file's existing import style for `agentProvider`.
- Produces: `HarnessConfig.defaultAgentEnv?: Record<string, string>`; `SpawnPtyOptions.env?: Record<string, string>`; `AgentMeta.env?: Record<string, string>`; spawn fails with `{ ok: false, error }` on invalid env.

- [ ] **Step 1: Add `defaultAgentEnv` to HarnessConfig**

In `src/main/config.ts`, inside `interface HarnessConfig` (after `defaultModel?`, ~line 154), add:

```ts
  /** Env vars merged into EVERY agent spawn (incl. Michael/GOD), set in
   *  Settings → General. Per-agent env (Add Agent) overrides these; internal
   *  injections (hive identity, BYOK, broker) override both. Headline use case:
   *  CLAUDE_CONFIG_DIR for separate Claude Code work/personal profiles (#105). */
  defaultAgentEnv?: Record<string, string>;
```

- [ ] **Step 2: Expose `env` on the preload spawn type**

In `src/preload/index.ts`, inside `interface SpawnPtyOptions` (after `args?`, ~line 170), add:

```ts
  /** Per-agent env vars (#105), validated + merged in the main process over the
   *  global defaultAgentEnv. Human-entered only — hire manifests can't carry env. */
  env?: Record<string, string>;
```

- [ ] **Step 3: Add `env` to AgentMeta**

In `src/main/hive.ts`, inside `interface AgentMeta` (after `cwd`, ~line 132), add:

```ts
  /** Per-agent env vars the agent was spawned with (#105) — persisted on the
   *  registry entry (values verbatim; derived surfaces mask sensitive ones) so
   *  respawn paths and the roster agree on the agent's environment. */
  env?: Record<string, string>;
```

`ensureAgent` spreads `...meta` into the registry entry (hive.ts ~line 452), so no other hive change is needed — the field persists automatically.

- [ ] **Step 4: Validate + merge in `spawnAgentCore`**

In `src/main/index.ts`, at the top of `spawnAgentCore` immediately after `if (opts.hive) opts.hive = { ...opts.hive, provider };` (~line 1810), insert:

```ts
  // ── Per-agent env vars (#105) — validate + merge BEFORE internal injections ──
  // Order: defaultAgentEnv (Settings) → opts.env (per-agent). Every internal
  // injection below spreads AFTER opts.env, so user env can never clobber
  // AGENT_ID / HIVE_ROOT / broker tokens / BYOK keys — and the denylist rejects
  // the dangerous rest (PATH, NODE_OPTIONS, DYLD_*, …) outright, FAILING the
  // spawn with a named key instead of silently dropping it.
  const envHome = homedir();
  const defEnv = validateAgentEnv(readConfig().defaultAgentEnv, envHome);
  if (!defEnv.ok) return { ok: false, error: `default agent env: ${defEnv.error}` };
  const perEnv = validateAgentEnv(opts.env, envHome);
  if (!perEnv.ok) return { ok: false, error: perEnv.error };
  // Registry records the PER-AGENT env only (defaults are re-read from config on
  // every spawn, so a Settings change applies to the next respawn automatically).
  if (opts.hive && Object.keys(perEnv.env).length > 0) opts.hive = { ...opts.hive, env: perEnv.env };
  opts.env = mergeAgentEnv(defEnv.env, perEnv.env);
```

Imports: add `validateAgentEnv, mergeAgentEnv` to the shared-env import (create `import { validateAgentEnv, mergeAgentEnv, claudeConfigDirFrom } from '../shared/agentEnv';` — `claudeConfigDirFrom` is used in Task 3). Ensure `homedir` is imported from `node:os` (check the file's existing imports; add `import { homedir } from 'node:os';` if absent).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: green (both projects).

- [ ] **Step 6: Commit**

```bash
git add src/main/config.ts src/preload/index.ts src/main/hive.ts src/main/index.ts
git commit -m "feat(env): validate + merge per-agent and default env at the spawn boundary (#105)"
```

---

### Task 3: `CLAUDE_CONFIG_DIR` follow-through — transcripts, resume seeding, permissions

**Files:**
- Modify: `src/main/transcript.ts`
- Modify: `src/main/config.ts` (`ensureClaudePermissionsAccepted`, ~line 490)
- Modify: `src/main/index.ts` (spawn path ~lines 1970/2008; startup wiring)

**Interfaces:**
- Consumes: `claudeConfigDirFrom` from `../shared/agentEnv` (Task 1); `AgentMeta.env` (Task 2).
- Produces:
  - `transcript.ts`: `setExtraClaudeConfigDirs(provider: () => string[]): void`; `projectDir(cwd: string, configDir?: string): string`; `seedSessionTranscript(cwd: string, sessionId: string, configDir?: string): boolean`; `resolveSessionCwd` and `readAgentUsage` keep their signatures but scan all registered roots.
  - `config.ts`: `ensureClaudePermissionsAccepted(cwd?: string, configDir?: string): void`.

- [ ] **Step 1: Multi-root support in `transcript.ts`**

Replace the top of `src/main/transcript.ts` (the `projectDir` function, lines 6–17) with:

```ts
/** Extra Claude config dirs (from per-agent / default CLAUDE_CONFIG_DIR env,
 *  #105) beyond the default ~/.claude. Registered lazily by index.ts so this
 *  module stays free of config/hive imports. */
let extraConfigDirs: () => string[] = () => [];
export function setExtraClaudeConfigDirs(provider: () => string[]): void {
  extraConfigDirs = provider;
}

function defaultConfigDir(): string {
  return path.join(os.homedir(), '.claude');
}

/** Every `projects/` root transcripts may live under: the default ~/.claude
 *  plus any CLAUDE_CONFIG_DIR overrides. Deduped; order = default first. */
function projectsRoots(): string[] {
  const dirs = [defaultConfigDir()];
  try { dirs.push(...extraConfigDirs()); } catch { /* provider never blocks a read */ }
  return [...new Set(dirs)].map((d) => path.join(d, 'projects'));
}

/** The project-dir KEY Claude Code derives from a cwd (absolute path with the
 *  leading slash dropped and every remaining slash dashed; on Windows every
 *  non-alphanumeric char is dashed — drive colon and backslashes included). */
function projectKey(cwd: string): string {
  return process.platform === 'win32'
    ? cwd.replace(/[^a-zA-Z0-9]/g, '-')
    : cwd.replace(/^\//, '').replaceAll('/', '-');
}

/** Resolve the Claude Code transcript directory for a working directory, under
 *  the given config dir (an agent's CLAUDE_CONFIG_DIR override) or ~/.claude. */
export function projectDir(cwd: string, configDir?: string): string {
  return path.join(configDir ?? defaultConfigDir(), 'projects', projectKey(cwd));
}
```

- [ ] **Step 2: Root-aware `seedSessionTranscript`**

Update its signature to `(cwd: string, sessionId: string, configDir?: string)`, and:
- target: `const target = path.join(projectDir(cwd, configDir), `${sessionId}.jsonl`);` (unchanged apart from `configDir`)
- search: replace the single `projectsRoot` block (lines 41–50) with a loop over every root:

```ts
    // Search EVERY known projects root (default + CLAUDE_CONFIG_DIR overrides,
    // #105) — the session may have run under a different profile than the one
    // this spawn uses.
    const roots = projectsRoots();
    const targetRoot = path.dirname(path.dirname(target));
    if (!roots.includes(targetRoot)) roots.push(targetRoot);
    for (const projectsRoot of roots) {
      if (!existsSync(projectsRoot)) continue;
      for (const dir of readdirSync(projectsRoot)) {
        const candidate = path.join(projectsRoot, dir, `${sessionId}.jsonl`);
        if (existsSync(candidate)) {
          mkdirSync(path.dirname(target), { recursive: true });
          cpSync(candidate, target);
          return true;
        }
      }
    }
    return false;
```

- [ ] **Step 3: Root-aware `resolveSessionCwd` and `readAgentUsage`**

In `resolveSessionCwd`, replace the single-root scan (lines 67–76) with the same outer loop:

```ts
    let best: { file: string; mtime: number } | null = null;
    for (const projectsRoot of projectsRoots()) {
      if (!existsSync(projectsRoot)) continue;
      for (const dir of readdirSync(projectsRoot)) {
        const candidate = path.join(projectsRoot, dir, `${sessionId}.jsonl`);
        try {
          const st = statSync(candidate);
          if (!best || st.mtimeMs > best.mtime) best = { file: candidate, mtime: st.mtimeMs };
        } catch { /* not present in this project dir */ }
      }
    }
```

In `readAgentUsage`, replace `const dir = projectDir(cwd); if (!existsSync(dir)) return usage; const files = readdirSync(dir)…` with a loop that accumulates across every root's project dir for this cwd (the per-file try/catch body is unchanged — wrap it):

```ts
    const key = projectKey(cwd);
    let lastModel: string | undefined;
    for (const root of projectsRoots()) {
      const dir = path.join(root, key);
      if (!existsSync(dir)) continue;
      const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
      for (const file of files) {
        // …existing per-file parsing/accumulation body, reading from
        // path.join(dir, file), unchanged…
      }
    }
    if (lastModel) usage.model = lastModel;
    return usage;
```

(Move the existing `let lastModel` declaration out of the removed block so it wraps both loops.)

- [ ] **Step 4: Config-dir-aware `ensureClaudePermissionsAccepted`**

In `src/main/config.ts`, change the signature (~line 490) and the two hardcoded paths:

```ts
export function ensureClaudePermissionsAccepted(cwd?: string, configDir?: string): void {
  const home = homedir();
  if (!home) return;
  // With CLAUDE_CONFIG_DIR set, Claude Code reads settings.json from INSIDE that
  // dir and .claude.json from <dir>/.claude.json (instead of ~/.claude.json). (#105)
  const dir = configDir ?? join(home, '.claude');
  const claudeJsonPath = configDir ? join(configDir, '.claude.json') : join(home, '.claude.json');
```

Then in part 1 use `const p = join(dir, 'settings.json');` (delete the old `const dir = join(home, '.claude');`) and in part 2 use `const p = claudeJsonPath;` (delete the old `const p = join(home, '.claude.json');`). Everything else is unchanged.

- [ ] **Step 5: Wire the spawn path and startup provider in `index.ts`**

Compute the agent's effective config dir once, after the env merge from Task 2 Step 4:

```ts
  // The Claude config dir this agent will actually use (#105) — drives resume
  // seeding + permissions-acceptance below. Null = default ~/.claude.
  const agentClaudeConfigDir = claudeConfigDirFrom(opts.env, envHome);
```

Then:
- ~line 1970: `if (seedSessionTranscript(opts.cwd, sid, agentClaudeConfigDir ?? undefined)) {`
- ~line 2008: `try { ensureClaudePermissionsAccepted(opts.cwd, agentClaudeConfigDir ?? undefined); } catch { /* never block spawn */ }`

At module scope (right after the `hive` instance is constructed — the provider is lazy, so top-level registration is safe), register the extra-roots provider:

```ts
// #105 — teach the transcript reader about every CLAUDE_CONFIG_DIR override in
// play (global default + per-agent), so telemetry/resume see profile sessions.
setExtraClaudeConfigDirs(() => {
  const home = homedir();
  const dirs: string[] = [];
  const d = claudeConfigDirFrom(readConfig().defaultAgentEnv, home);
  if (d) dirs.push(d);
  try {
    for (const a of Object.values(hive.registry().agents)) {
      const ad = claudeConfigDirFrom(a.env, home);
      if (ad) dirs.push(ad);
    }
  } catch { /* hive not ready yet — default root still works */ }
  return dirs;
});
```

Add `setExtraClaudeConfigDirs` to the existing `./transcript` import (line 25).

- [ ] **Step 6: Typecheck and re-run tests**

Run: `npm run typecheck && node test/agent-env.test.cjs`
Expected: both green.

- [ ] **Step 7: Commit**

```bash
git add src/main/transcript.ts src/main/config.ts src/main/index.ts
git commit -m "feat(env): telemetry, resume seeding and permissions follow CLAUDE_CONFIG_DIR (#105)"
```

---

### Task 4: Mask env on derived surfaces (fleet.json + agent-env.cjs)

**Files:**
- Modify: `src/main/index.ts` (`writeFleetSnapshot`, ~line 775)
- Modify: `tools/agent-env.cjs`

**Interfaces:**
- Consumes: `maskSensitiveEnv` from `../shared/agentEnv` (Task 1); `RegistryAgent.env` (Task 2).
- Produces: fleet.json agent entries gain optional `env` (masked); `agent-env.cjs` records gain optional `env` (masked).

- [ ] **Step 1: Fleet snapshot**

In `writeFleetSnapshot`'s `.map(([id, a]) => { … return { … } })` (index.ts ~line 788), add after `cwd: a.cwd,`:

```ts
          // Per-agent env (#105) — masked (never raw key material) so Michael can
          // see WHICH profile a worker runs without fleet.json leaking secrets.
          env: a.env ? maskSensitiveEnv(a.env) : undefined,
```

Add `maskSensitiveEnv` to the shared-env import from Task 2.

- [ ] **Step 2: agent-env.cjs**

`tools/agent-env.cjs` is dependency-free CommonJS (it can't import the TS module), so add a local mask near `cwdState` (~line 52):

```js
/** Mask env values whose key looks like key material — this tool's output is
 *  documented as non-sensitive (#105). Mirrors src/shared/agentEnv.ts. */
const SENSITIVE_KEY_RE = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;
function maskEnv(env) {
  if (!env || typeof env !== 'object') return undefined;
  const out = {};
  for (const [k, v] of Object.entries(env)) out[k] = SENSITIVE_KEY_RE.test(k) ? '•••' : v;
  return Object.keys(out).length ? out : undefined;
}
```

Find where the per-agent record object is assembled (it maps registry entries to `{ id, name, provider, role, status, cwd, cwdValid, sessionId, … }`) and add `env: maskEnv(a.env),` alongside the other registry-sourced fields. Update the tool's header comment ("no env, no key material") to say env is included masked.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && node test/kg-core.test.cjs && node test/agent-provider.test.cjs`
Expected: green (guards against accidental breakage in files the tests transpile).

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts tools/agent-env.cjs
git commit -m "feat(env): surface masked per-agent env in fleet.json and agent-env tool (#105)"
```

---

### Task 5: Renderer — env row editor, Add Agent integration, respawn threading

**Files:**
- Create: `src/renderer/src/components/EnvVarsEditor.tsx`
- Modify: `src/renderer/src/store/store.ts` (Agent interface, ~line 29)
- Modify: `src/renderer/src/components/AddAgentModal.tsx`
- Modify: `src/renderer/src/components/AgentStrip.tsx` (~line 78)
- Modify: `src/renderer/src/hooks/useHive.ts` (~line 816)
- Modify: `src/renderer/src/components/CommandCenterPanel.tsx` (~line 280)

**Interfaces:**
- Consumes: `envKeyIssue` from `@shared/agentEnv` (Task 1 — renderer imports shared code via the `@shared/` alias, same as `agentProvider`); `SpawnPtyOptions.env` (Task 2).
- Produces: `Agent.env?: Record<string, string>`; `<EnvVarsEditor rows={EnvRow[]} onChange={(rows: EnvRow[]) => void} />` with `type EnvRow = { key: string; value: string }`; helper `rowsToEnv(rows: EnvRow[]): Record<string, string> | undefined`.

- [ ] **Step 1: Add `env` to the renderer Agent type**

In `src/renderer/src/store/store.ts`, inside `interface Agent` (after `worktreePath?`, ~line 76), add:

```ts
  /** Per-agent env vars the agent is spawned with (#105) — e.g. CLAUDE_CONFIG_DIR
   *  for a separate Claude profile. Persisted (spawn recipe, like `command`) so
   *  restore-team / revive / restart respawn with the same environment. */
  env?: Record<string, string>;
```

It is NOT in the `PersistedAgent` omit list, so localStorage persistence is automatic.

- [ ] **Step 2: Create `EnvVarsEditor.tsx`**

```tsx
import React from 'react';
import { envKeyIssue } from '@shared/agentEnv';
import { PixelButton } from './PixelButton';

export type EnvRow = { key: string; value: string };

/** Rows → the env record a spawn wants; empty/blank-key rows are dropped.
 *  Returns undefined when nothing usable is set. */
export function rowsToEnv(rows: EnvRow[]): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  for (const r of rows) if (r.key.trim()) env[r.key.trim()] = r.value;
  return Object.keys(env).length ? env : undefined;
}

/** First problem across the rows (mirrors the main-process rules for instant
 *  feedback — main remains the enforcing boundary), or null when clean. */
export function envRowsIssue(rows: EnvRow[]): string | null {
  const seen = new Set<string>();
  for (const r of rows) {
    const key = r.key.trim();
    if (!key) continue;
    const issue = envKeyIssue(key);
    if (issue) return issue;
    if (seen.has(key)) return `duplicate env key "${key}"`;
    seen.add(key);
  }
  return null;
}

const cellStyle: React.CSSProperties = {
  padding: '5px 7px 3px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
  fontFamily: 'var(--cth-font-mono)',
  fontSize: 13,
  color: 'var(--cth-ink-900)',
  outline: 'none',
  minWidth: 0
};

/** KEY=VALUE row editor for per-agent env vars (#105). Dumb component: owns no
 *  state — parent holds the rows (Add Agent form state / Settings config). */
export function EnvVarsEditor({ rows, onChange }: {
  rows: EnvRow[];
  onChange: (rows: EnvRow[]) => void;
}) {
  const issue = envRowsIssue(rows);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            value={r.key}
            onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
            placeholder="CLAUDE_CONFIG_DIR"
            spellCheck={false}
            style={{ ...cellStyle, width: 200, flexShrink: 0 }}
          />
          <span style={{ color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-mono)', fontSize: 13 }}>=</span>
          <input
            value={r.value}
            onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
            placeholder="~/.claude-personal"
            spellCheck={false}
            style={{ ...cellStyle, flex: 1 }}
          />
          <PixelButton size="sm" variant="ghost" title="remove"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}>✕</PixelButton>
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <PixelButton size="sm" onClick={() => onChange([...rows, { key: '', value: '' }])}>
          + env var
        </PixelButton>
        {issue && (
          <span style={{ fontSize: 12, color: 'var(--cth-paprika-700, #b3502e)' }}>{issue}</span>
        )}
      </div>
    </div>
  );
}
```

(If `PixelButton` has no `ghost` variant, use `secondary` — check `Variant` in `PixelButton.tsx` and use an existing one.)

- [ ] **Step 3: Add Agent modal — state, UI, spawn, agent object**

In `AddAgentModal.tsx`:

a. State (next to the other `useState` fields, ~line 175):

```tsx
  // Per-agent env vars (#105) — e.g. CLAUDE_CONFIG_DIR for a personal profile.
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);
```

Import: `import { EnvVarsEditor, envRowsIssue, rowsToEnv, type EnvRow } from './EnvVarsEditor';`

b. Submit guard (with the other validations in `submit()`, ~line 298):

```tsx
    const envIssue = envRowsIssue(envRows);
    if (envIssue) { setError(envIssue); setSection('workspace'); return; }
```

c. Spawn call (~line 307) — add to the `spawnPty` options object:

```tsx
      // Per-agent env vars (#105); validated + merged over defaultAgentEnv in main.
      env: rowsToEnv(envRows),
```

d. Agent object (~line 343) — add alongside `worktreePath`:

```tsx
      env: rowsToEnv(envRows),
```

e. UI — in the `section === 'workspace'` block, after the existing folder/isolation/resume rows, add:

```tsx
                    <Row label="Env vars">
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <EnvVarsEditor rows={envRows} onChange={setEnvRows} />
                        <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                          set on this agent's process — e.g. CLAUDE_CONFIG_DIR=~/.claude-personal
                          for a separate Claude account. ~ expands to your home folder.
                        </span>
                      </div>
                    </Row>
```

Update the workspace section hint (~line 118) to `hint: 'folder · isolation · resume · env'`.

- [ ] **Step 4: Thread `env` through the three respawn call sites**

Each respawns an existing `Agent a` — pass its recorded env:

- `AgentStrip.tsx` `restoreTeam` spawn (~line 78): add `env: a.env,` to the `spawnPty` options.
- `useHive.ts` auto-revive spawn (~line 816): add `env: a.env,` to the `spawnPty` options.
- `CommandCenterPanel.tsx` restart/change-engine spawn (~line 280): add `env: a.env,` to the options object literal.

(The god spawn in `useHive.ts` ~line 234 needs NO change — Michael inherits `defaultAgentEnv` inside `spawnAgentCore`.)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: green.

- [ ] **Step 6: Visual check**

Run: `npm run dev`. Open Add Agent → Workspace: add an env row, confirm inline error on a bad key (`9BAD`, `PATH`), confirm the pixel aesthetic matches neighboring fields. Screenshot for the PR.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/EnvVarsEditor.tsx src/renderer/src/store/store.ts \
  src/renderer/src/components/AddAgentModal.tsx src/renderer/src/components/AgentStrip.tsx \
  src/renderer/src/hooks/useHive.ts src/renderer/src/components/CommandCenterPanel.tsx
git commit -m "feat(env): per-agent env vars in Add Agent + respawn paths (#105)"
```

---

### Task 6: Settings → General — global "Agent environment" editor

**Files:**
- Modify: `src/renderer/src/components/SettingsModal.tsx` (General section, ~line 654)

**Interfaces:**
- Consumes: `EnvVarsEditor`, `EnvRow`, `rowsToEnv`, `envRowsIssue` (Task 5); `HarnessConfig.defaultAgentEnv` (Task 2); the modal's existing config read/update plumbing (`window.cth.updateConfig`).

- [ ] **Step 1: Add state + persistence**

Seed rows from config when the modal opens (next to the other config-derived state):

```tsx
  const [defaultEnvRows, setDefaultEnvRows] = useState<EnvRow[]>(
    Object.entries(config.defaultAgentEnv ?? {}).map(([key, value]) => ({ key, value }))
  );
```

Persist on change (matching how the modal's other General fields save — if fields save on blur/apply, follow that pattern; if they save immediately via `updateConfig`, do):

```tsx
  const saveDefaultEnv = (rows: EnvRow[]) => {
    setDefaultEnvRows(rows);
    if (envRowsIssue(rows)) return; // don't persist a bad key; editor shows why
    void window.cth.updateConfig({ defaultAgentEnv: rowsToEnv(rows) ?? {} });
  };
```

Import `EnvVarsEditor, envRowsIssue, rowsToEnv, type EnvRow` from `./EnvVarsEditor`.

- [ ] **Step 2: Render in the General section**

Inside the `activeSection === 'General'` block, after the default command/model fields, add a framed group consistent with its neighbors:

```tsx
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, textTransform: 'uppercase', color: 'var(--cth-ink-700)' }}>
                          Agent environment
                        </span>
                        <EnvVarsEditor rows={defaultEnvRows} onChange={saveDefaultEnv} />
                        <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                          env vars for every agent — including Michael. Applies to newly
                          spawned agents; live terminals keep the env they started with.
                          Per-agent env vars (Add Agent) override these.
                        </span>
                      </div>
```

(Match the exact heading/label markup style used by the adjacent General-section groups — copy a sibling's wrapper markup rather than inventing a new one.)

- [ ] **Step 3: Typecheck + visual check**

Run: `npm run typecheck` — green. Then `npm run dev` → Settings → General: add `CLAUDE_CONFIG_DIR=~/.claude-personal`, close and reopen Settings, confirm it persisted.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/SettingsModal.tsx
git commit -m "feat(env): global default agent env in Settings → General (#105)"
```

---

### Task 7: Hire manifests — env is not importable (warning)

**Files:**
- Modify: `src/shared/hire.ts` (`HireValidation` ~line 83, `validateHireManifest` ~line 169)
- Modify: `src/main/hire.ts` (the `finish()` result plumbing, ~lines 208/247)
- Modify: `src/preload/index.ts` (`importHireFile` return type, ~line 756)
- Modify: `src/renderer/src/components/AddAgentModal.tsx` (import banner, ~line 432)

**Interfaces:**
- Produces: `HireValidation.warnings?: string[]`; `importHireFile(): Promise<{ ok: boolean; manifest?: HireManifest; warnings?: string[]; error?: string }>`.

- [ ] **Step 1: Note on testing**

Hire validation has no existing test file, and a dedicated hire-manifest suite is out of scope for this feature. This task's behavior is covered by typecheck plus the manual import check in Step 5.

- [ ] **Step 2: `src/shared/hire.ts`**

In `HireValidation` add:

```ts
  /** Non-fatal notices to surface in the import banner (e.g. a manifest carried
   *  an `env` field — env vars are human-entered only, never imported, #105). */
  warnings?: string[];
```

In `validateHireManifest`, next to the other field extractions, add:

```ts
  const warnings: string[] = [];
  // #105 — env vars are code-execution-adjacent (NODE_OPTIONS, DYLD_*), so a
  // manifest (untrusted input) can never carry them. Not an error — the rest of
  // the hire imports fine — but the human is told the field was ignored.
  if (o.env !== undefined) {
    warnings.push('this hire declared env vars — env is not importable; set it by hand in Workspace → Env vars');
  }
```

and include `...(warnings.length ? { warnings } : {})` in the returned validation object (both the success and the field-errors return, so the notice survives either way).

- [ ] **Step 3: Plumb warnings through main + preload**

In `src/main/hire.ts`, `finish()` builds the `{ ok, manifest, error }` result from a `HireValidation` — pass `warnings` through: add `warnings: v.warnings` to the returned object (check the actual shape of `finish` at ~line 200 and mirror its style). In `src/preload/index.ts` line 756, add `warnings?: string[];` to the `importHireFile` return type.

- [ ] **Step 4: Show it in the Add Agent banner**

In `AddAgentModal.tsx`: store warnings when importing (`importHire`, ~line 287):

```tsx
  const [hireWarnings, setHireWarnings] = useState<string[]>([]);
  // in importHire():
    if (res.ok && res.manifest) { applyManifest(res.manifest); setHireWarnings(res.warnings ?? []); }
```

Also check how deep-link imports set `pendingHire` — if warnings can't reach that path without store changes, banner warnings apply to file-imports only for v1 (deep-link manifests with env still have the field ignored; only the notice is missing). In the banner (next to the `commandFlags` warning block, ~line 432), add:

```tsx
                {hireWarnings.map((w) => (
                  <span key={w} style={{ fontSize: 12, marginTop: 2 }}>⚠️ {w}</span>
                ))}
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck` — green. Manual: write a hire-manifest JSON containing an `env` field to a scratch file, import it via Add Agent → import hire, confirm the banner shows the ignored-env notice and the form has no env rows pre-filled.

- [ ] **Step 6: Commit**

```bash
git add src/shared/hire.ts src/main/hire.ts src/preload/index.ts src/renderer/src/components/AddAgentModal.tsx
git commit -m "feat(env): hire manifests cannot import env vars; surface a notice (#105)"
```

---

### Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: All tests + typecheck + build**

```bash
npm run typecheck
node test/agent-env.test.cjs
node test/agent-provider.test.cjs
node test/kg-core.test.cjs
node test/slack.test.cjs
node test/realtime-findcard.test.cjs
node test/voice-messages.test.cjs
npm run build
```

Expected: all green.

- [ ] **Step 2: End-to-end profile check (the issue's exact scenario)**

1. `npm run dev`.
2. Add an agent with env row `CLAUDE_CONFIG_DIR` = `~/.claude-personal`.
3. In its terminal run `/status` (or check the account line) — confirm it's the personal account.
4. Confirm the Activity tab shows nonzero tokens for that agent after a turn (multi-root telemetry).
5. Restart the app → Restore team → confirm the agent comes back on the personal profile (env persisted).
6. Set the same var in Settings → General instead, spawn a fresh worker with no per-agent env, confirm it also uses the personal profile (global default reaches every spawn).

- [ ] **Step 3: Denylist check**

Add an agent with env row `NODE_OPTIONS=--require x` → spawn must FAIL with an error naming `NODE_OPTIONS` in the modal.

- [ ] **Step 4: Wrap up**

Report results. Then use superpowers:finishing-a-development-branch to decide merge/PR.

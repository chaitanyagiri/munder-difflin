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

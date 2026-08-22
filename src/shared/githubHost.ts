/**
 * Which GitHub an agent is talking to, and which credential is allowed to reach
 * it.
 *
 * "GHE" here means **GitHub Enterprise Cloud with data residency** — tenant
 * hosts on `*.ghe.com` (`microsoft.ghe.com`), not self-hosted GHES and not
 * github.com. A tenant is a completely separate identity plane: its API is
 * `api.<tenant>.ghe.com`, its repos are `https://<tenant>.ghe.com/<org>/<repo>`,
 * and a github.com token means NOTHING to it. There is no shared session.
 *
 * The failure this module exists to stop: the Copilot CLI resolves its host and
 * its token independently. The token is the first non-empty of
 * COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN with no idea which host is
 * active — so a github.com PAT sitting in GH_TOKEN (which `gh` and half the CI
 * templates on earth set) is transmitted to `api.<tenant>.ghe.com`, and the env
 * token silently outranks the correctly-scoped keyring credential. The tenant
 * answers `401 unauthorized: AuthenticateToken authentication failed`, the model
 * catalog comes back empty, and the user sees a generic "Authentication failed"
 * that names neither the host nor the token.
 *
 * We spawn `copilot` as a child, so the fix we own is the ENVIRONMENT we hand
 * it: bind the host to the agent's own repo, and let through only a credential
 * that was actually scoped to that host.
 *
 * Shared between main and renderer; keep it dependency-free (no electron, no
 * node builtins) so the resolution stays a pure function and is testable
 * off-process.
 */

/** Hosts that are github.com by another name. `api.` included because a stray
 *  COPILOT_GH_HOST=api.github.com must not be mistaken for an enterprise host. */
const DOTCOM_HOSTS = new Set(['github.com', 'www.github.com', 'api.github.com']);

/** Where the active host came from. Surfaced in the diagnostic line: "which
 *  host, and who said so" is the first question when a 401 shows up. */
export type GithubHostSource = 'COPILOT_GH_HOST' | 'GH_HOST' | 'git-remote' | 'default';

export interface GithubHost {
  /** Bare hostname, lowercased: `github.com`, `microsoft.ghe.com`. */
  host: string;
  /**
   * Scheme + host, NEVER a path. The Copilot CLI keys its keyring credential on
   * a string of this shape, and the observed key
   * (`https://microsoft.ghe.com/bic/:marclundgren`) carries the ORG PATH too —
   * so two orgs on one tenant get two entries for one identity. We cannot
   * rewrite its keychain from here, but everything we hand it is normalized to
   * the origin so we never contribute a path-bearing key.
   */
  origin: string;
  source: GithubHostSource;
  /** Tenant-scoped GitHub Enterprise Cloud (`*.ghe.com`). */
  gheCloud: boolean;
  /** Anything that is not github.com — `*.ghe.com` tenants and GHES alike. */
  enterprise: boolean;
}

/** Lowercase, drop a trailing root dot, drop a port. Empty → null. */
function normalizeHost(raw: string | null | undefined): string | null {
  const host = (raw ?? '').trim().toLowerCase().replace(/\.$/, '').replace(/:\d+$/, '');
  return host || null;
}

/**
 * The hostname a git remote points at, for every remote shape git accepts:
 *
 *   https://microsoft.ghe.com/bic/repo.git      → microsoft.ghe.com
 *   https://user:tok@microsoft.ghe.com/bic/r    → microsoft.ghe.com
 *   ssh://git@microsoft.ghe.com/bic/repo.git    → microsoft.ghe.com
 *   git@microsoft.ghe.com:bic/repo.git          → microsoft.ghe.com
 *
 * Returns null for anything that is not a network remote (a local path, a
 * `file://` URL, an unparseable string). A null here is not an error: it just
 * means the repo tells us nothing about the host and we fall through to the
 * default.
 */
export function parseGitRemoteHost(remote: string | null | undefined): string | null {
  const raw = (remote ?? '').trim();
  if (!raw) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      return normalizeHost(new URL(raw).hostname);
    } catch {
      return null;
    }
  }
  // scp-like `[user@]host:path`. The dot requirement is what keeps a Windows
  // clone path (`C:\src\repo`) from being read as a host named "c".
  const scp = /^(?:[^@/]+@)?([^:/]+\.[^:/]+):/.exec(raw);
  return scp ? normalizeHost(scp[1]) : null;
}

/** A host as written in an env var, which operators spell both ways
 *  (`microsoft.ghe.com` and `https://microsoft.ghe.com/`). */
function hostFromEnvValue(value: string | undefined): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  if (/:\/\//.test(raw)) {
    try {
      return normalizeHost(new URL(raw).hostname);
    } catch {
      return null;
    }
  }
  return normalizeHost(raw.split('/')[0]);
}

/** Tenant-scoped Enterprise Cloud. Bare `ghe.com` is not a tenant. */
export function isGheCloudHost(host: string): boolean {
  const h = normalizeHost(host);
  return !!h && h !== 'ghe.com' && h.endsWith('.ghe.com');
}

export function isDotcomHost(host: string): boolean {
  const h = normalizeHost(host);
  return !!h && DOTCOM_HOSTS.has(h);
}

/** Scheme + host, never a path — see `GithubHost.origin`. */
export function normalizeGithubOrigin(hostOrUrl: string): string {
  const host = hostFromEnvValue(hostOrUrl);
  return `https://${host ?? 'github.com'}`;
}

function describeHost(host: string, source: GithubHostSource): GithubHost {
  const h = normalizeHost(host) ?? 'github.com';
  return {
    host: h,
    origin: `https://${h}`,
    source,
    gheCloud: isGheCloudHost(h),
    enterprise: !isDotcomHost(h)
  };
}

/**
 * The active host, in precedence order:
 *
 *   1. COPILOT_GH_HOST   — the CLI's own override, so it wins here too
 *   2. GH_HOST           — the `gh` convention, same reason
 *   3. the agent's git remote
 *   4. github.com
 *
 * An explicitly exported host beats an inferred one on purpose: an operator who
 * exported GH_HOST=github.com inside a tenant checkout is doing that
 * deliberately, and silently overriding them would be its own bug. Steps 1 and 2
 * are exactly what the CLI already does; step 3 is the new signal, and it is the
 * one that makes `cd`-ing between a github.com repo and a tenant repo work with
 * no env juggling.
 */
export function resolveGithubHost(opts: {
  env: Record<string, string | undefined>;
  remoteUrl?: string | null;
}): GithubHost {
  const fromCopilot = hostFromEnvValue(opts.env.COPILOT_GH_HOST);
  if (fromCopilot) return describeHost(fromCopilot, 'COPILOT_GH_HOST');
  const fromGh = hostFromEnvValue(opts.env.GH_HOST);
  if (fromGh) return describeHost(fromGh, 'GH_HOST');
  const fromRemote = parseGitRemoteHost(opts.remoteUrl);
  if (fromRemote) return describeHost(fromRemote, 'git-remote');
  return describeHost('github.com', 'default');
}

/**
 * Token env vars the Copilot CLI reads, in ITS order. Host-agnostic every one of
 * them: nothing in the name says which GitHub the value belongs to, which is the
 * whole bug.
 */
export const COPILOT_TOKEN_ENV = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const;

/**
 * `gh`'s enterprise variable. Non-dotcom BY DEFINITION, so unlike the three
 * above it can be trusted for an enterprise host without further evidence.
 *
 * It is deliberately NOT forwarded under this name to a `*.ghe.com` tenant:
 * against tenant cloud `GH_ENTERPRISE_TOKEN` returns 401 (the variable targets
 * GHES), while GH_TOKEN authenticates. So on a tenant we carry its VALUE over
 * into GH_TOKEN and drop the name.
 */
export const GH_ENTERPRISE_TOKEN = 'GH_ENTERPRISE_TOKEN';

export interface DroppedToken {
  name: string;
  reason: string;
}

export interface GithubEnvPlan {
  host: GithubHost;
  /** Env to set on the child, over the inherited environment. */
  set: Record<string, string>;
  /** Env names to delete from the INHERITED environment before the child sees them. */
  omit: string[];
  /**
   * Where the credential the child will use comes from: an env var name, or
   * null meaning "we handed it nothing on purpose" — the CLI then falls back to
   * the keyring credential for this host, which is the correctly-scoped one and
   * which an env token would otherwise have outranked.
   */
  tokenSource: string | null;
  dropped: DroppedToken[];
}

/**
 * Decide the child's GitHub environment for `host`.
 *
 * **github.com is untouched.** When the active host is dotcom this returns an
 * empty plan — no set, no omit — so the default path behaves exactly as it did
 * before this module existed. Every branch below is enterprise-only.
 *
 * Precedence for an enterprise host, highest first:
 *
 *   1. COPILOT_GITHUB_TOKEN  — but only when the shell also names this host
 *   2. GH_ENTERPRISE_TOKEN   — non-dotcom by definition, always eligible
 *   3. GH_TOKEN              — only when the shell also names this host
 *   4. GITHUB_TOKEN          — only when the shell also names this host
 *   5. nothing → the CLI's keyring credential for this host
 *
 * "the shell also names this host" means COPILOT_GH_HOST or GH_HOST resolves to
 * the SAME host. That is the only evidence available that a host-agnostic
 * variable was meant for a tenant, and requiring it is what stops a github.com
 * PAT from being posted to `api.<tenant>.ghe.com`.
 */
export function planGithubEnvForHost(
  host: GithubHost,
  env: Record<string, string | undefined>
): GithubEnvPlan {
  const value = (name: string): string => (env[name] ?? '').trim();
  const present = (name: string): boolean => value(name).length > 0;

  if (!host.enterprise) {
    // Report the source for the diagnostic, but change nothing.
    const source = COPILOT_TOKEN_ENV.find(present) ?? null;
    return { host, set: {}, omit: [], tokenSource: source, dropped: [] };
  }

  // Did the operator aim this shell at this host?
  const declaredHost =
    hostFromEnvValue(env.COPILOT_GH_HOST) ?? hostFromEnvValue(env.GH_HOST) ?? null;
  const shellNamesThisHost = declaredHost === host.host;

  const dropped: DroppedToken[] = [];
  let tokenSource: string | null = null;
  let token = '';

  const consider = (name: string, eligible: boolean, reason: string): void => {
    if (!present(name)) return;
    if (!eligible) {
      dropped.push({ name, reason });
      return;
    }
    if (!tokenSource) {
      tokenSource = name;
      token = value(name);
      return;
    }
    dropped.push({ name, reason: `outranked by ${tokenSource}` });
  };

  const mismatch = declaredHost
    ? `scoped to ${declaredHost}, not ${host.host}`
    : `host-agnostic and no COPILOT_GH_HOST/GH_HOST names ${host.host}`;

  consider('COPILOT_GITHUB_TOKEN', shellNamesThisHost, mismatch);
  consider(GH_ENTERPRISE_TOKEN, true, '');
  consider('GH_TOKEN', shellNamesThisHost, mismatch);
  consider('GITHUB_TOKEN', shellNamesThisHost, mismatch);

  // Bind the host explicitly, so the CLI and any `gh` the agent shells out to
  // agree with the repo it is sitting in rather than with an ambient default.
  const set: Record<string, string> = {
    COPILOT_GH_HOST: host.host,
    GH_HOST: host.host
  };
  const omit: string[] = [];

  if (tokenSource) {
    if (host.gheCloud) {
      // Tenant cloud authenticates with GH_TOKEN; GH_ENTERPRISE_TOKEN 401s. Carry
      // the value over under the name that works and retire the other names so
      // nothing stale is left for the CLI to prefer.
      set.GH_TOKEN = token;
      for (const name of [...COPILOT_TOKEN_ENV, GH_ENTERPRISE_TOKEN]) {
        if (name !== 'GH_TOKEN' && present(name)) omit.push(name);
      }
    } else {
      // GHES: leave the variable that carried the token alone (GH_ENTERPRISE_TOKEN
      // is the correct name there) and retire only the ones we rejected.
      for (const d of dropped) if (!omit.includes(d.name)) omit.push(d.name);
    }
  } else {
    // Nothing in the environment is scoped to this host. Strip all of it so the
    // CLI reaches its keyring credential for this tenant instead of being
    // pre-empted by a token that cannot possibly work.
    for (const name of [...COPILOT_TOKEN_ENV, GH_ENTERPRISE_TOKEN]) {
      if (present(name)) omit.push(name);
    }
  }

  return { host, set, omit, tokenSource, dropped };
}

/** The whole resolution in one step: repo remote in, child environment out. */
export function planCopilotGithubEnv(opts: {
  env: Record<string, string | undefined>;
  remoteUrl?: string | null;
}): GithubEnvPlan {
  return planGithubEnvForHost(resolveGithubHost(opts), opts.env);
}

/**
 * One log line naming the four things you need to debug a GitHub 401 and which
 * the generic "Authentication failed" names none of: the active host, where the
 * host came from, which variable supplied the credential, and what we refused to
 * send.
 *
 * Token VALUES never appear here — only variable names. This string goes to the
 * app log, which people paste into issues.
 */
export function describeGithubEnvPlan(plan: GithubEnvPlan): string {
  const parts = [`host=${plan.host.host} (${plan.host.source})`];
  if (plan.tokenSource) {
    const via =
      plan.host.gheCloud && plan.tokenSource !== 'GH_TOKEN'
        ? `${plan.tokenSource}->GH_TOKEN`
        : plan.tokenSource;
    parts.push(`token=${via}`);
  } else {
    parts.push('token=keyring (no host-scoped token in env)');
  }
  if (plan.dropped.length) {
    parts.push(`dropped=${plan.dropped.map((d) => `${d.name} (${d.reason})`).join(', ')}`);
  }
  // Actionable, because the drop is occasionally not what the operator wanted:
  // someone who really did export a tenant token under a host-agnostic name has
  // exactly one way to say so, and this is where they find out what it is.
  if (!plan.tokenSource && plan.dropped.length) {
    parts.push(`— export COPILOT_GH_HOST=${plan.host.host} to declare an env token for this host`);
  }
  return parts.join(' ');
}

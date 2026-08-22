'use strict';

/**
 * A `*.ghe.com` tenant is a separate identity plane: a github.com token means
 * nothing to `api.<tenant>.ghe.com`, and the Copilot CLI's token lookup has no
 * idea which host is active — so a GH_TOKEN left over from a dotcom checkout was
 * being posted to the tenant, 401ing while the correctly-scoped keyring
 * credential sat unused. These tests pin the rule that fixes it: the host comes
 * from the agent's own repo unless an env var says otherwise, and a host-agnostic
 * token variable only reaches an enterprise host when the shell named that host.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  parseGitRemoteHost,
  isGheCloudHost,
  isDotcomHost,
  normalizeGithubOrigin,
  resolveGithubHost,
  planGithubEnvForHost,
  planCopilotGithubEnv,
  describeGithubEnvPlan
} = loadTs('src/shared/githubHost.ts');

const TENANT = 'microsoft.ghe.com';
const TENANT_REMOTE = `https://${TENANT}/bic/munder-difflin.git`;
const DOTCOM_PAT = 'ghp_dotcom_pat_that_must_never_reach_a_tenant';

// ── Remote parsing ───────────────────────────────────────────────────────────

test('every remote shape git accepts yields the same tenant host', () => {
  for (const remote of [
    `https://${TENANT}/bic/repo.git`,
    `https://user:tok@${TENANT}/bic/repo`,
    `ssh://git@${TENANT}/bic/repo.git`,
    `git@${TENANT}:bic/repo.git`,
    `HTTPS://${TENANT.toUpperCase()}/bic/repo`
  ]) {
    assert.equal(parseGitRemoteHost(remote), TENANT, remote);
  }
});

test('a non-network remote tells us nothing, and says so as null', () => {
  for (const remote of ['', null, undefined, '/srv/git/repo.git', '../sibling', 'C:\\src\\repo']) {
    assert.equal(parseGitRemoteHost(remote), null, String(remote));
  }
});

// ── Host classification ──────────────────────────────────────────────────────

test('tenant hosts are enterprise cloud; github.com and bare ghe.com are not', () => {
  assert.equal(isGheCloudHost(TENANT), true);
  assert.equal(isGheCloudHost('ghe.com'), false, 'bare ghe.com is not a tenant');
  assert.equal(isGheCloudHost('github.com'), false);
  assert.equal(isDotcomHost('github.com'), true);
  assert.equal(isDotcomHost('api.github.com'), true, 'api.github.com must not read as enterprise');
  assert.equal(isDotcomHost(TENANT), false);
});

test('an origin is scheme+host and never carries the org path', () => {
  // The CLI keyed a credential on `https://microsoft.ghe.com/bic/:user` — host
  // PLUS org — so two orgs on one tenant meant two entries for one identity.
  assert.equal(normalizeGithubOrigin(`https://${TENANT}/bic/repo`), `https://${TENANT}`);
  assert.equal(normalizeGithubOrigin(TENANT), `https://${TENANT}`);
  assert.equal(resolveGithubHost({ env: {}, remoteUrl: TENANT_REMOTE }).origin, `https://${TENANT}`);
});

// ── Host precedence ──────────────────────────────────────────────────────────

test('host precedence: COPILOT_GH_HOST, then GH_HOST, then the repo, then dotcom', () => {
  const remoteUrl = TENANT_REMOTE;
  assert.deepEqual(
    (({ host, source }) => ({ host, source }))(
      resolveGithubHost({ env: { COPILOT_GH_HOST: 'a.ghe.com', GH_HOST: 'b.ghe.com' }, remoteUrl })
    ),
    { host: 'a.ghe.com', source: 'COPILOT_GH_HOST' }
  );
  assert.equal(resolveGithubHost({ env: { GH_HOST: 'b.ghe.com' }, remoteUrl }).host, 'b.ghe.com');
  assert.equal(resolveGithubHost({ env: {}, remoteUrl }).source, 'git-remote');
  assert.equal(resolveGithubHost({ env: {}, remoteUrl: null }).host, 'github.com');
});

test('a host env var is understood whether written bare or as a URL', () => {
  assert.equal(resolveGithubHost({ env: { GH_HOST: `https://${TENANT}/` } }).host, TENANT);
  assert.equal(resolveGithubHost({ env: { GH_HOST: `  ${TENANT}  ` } }).host, TENANT);
});

// ── The bug, and the fix ─────────────────────────────────────────────────────

test('a dotcom PAT in GH_TOKEN never reaches a tenant, and the keyring takes over', () => {
  // The exact repro: a tenant checkout with a valid github.com PAT exported.
  const plan = planCopilotGithubEnv({
    env: { GH_TOKEN: DOTCOM_PAT },
    remoteUrl: TENANT_REMOTE
  });
  assert.equal(plan.host.host, TENANT);
  assert.ok(plan.omit.includes('GH_TOKEN'), 'the mismatched token must be removed, not overwritten');
  assert.equal(plan.tokenSource, null, 'nothing in env is scoped here → fall through to the keyring');
  assert.ok(!Object.values(plan.set).includes(DOTCOM_PAT), 'the PAT must not be forwarded under any name');
  // And the child is pointed at the tenant rather than an ambient default.
  assert.equal(plan.set.COPILOT_GH_HOST, TENANT);
  assert.equal(plan.set.GH_HOST, TENANT);
});

test('every host-agnostic token variable is stripped on a tenant, not just GH_TOKEN', () => {
  const plan = planCopilotGithubEnv({
    env: { GH_TOKEN: 'a', GITHUB_TOKEN: 'b', COPILOT_GITHUB_TOKEN: 'c', GH_ENTERPRISE_TOKEN: '' },
    remoteUrl: TENANT_REMOTE
  });
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN']) {
    assert.ok(plan.omit.includes(name), `${name} must not reach the tenant`);
  }
});

test('naming the tenant in the shell is what makes a host-agnostic token eligible', () => {
  const plan = planCopilotGithubEnv({
    env: { COPILOT_GH_HOST: TENANT, GH_TOKEN: 'tenant-token' },
    remoteUrl: TENANT_REMOTE
  });
  assert.equal(plan.tokenSource, 'GH_TOKEN');
  assert.equal(plan.set.GH_TOKEN, 'tenant-token');
  assert.ok(!plan.omit.includes('GH_TOKEN'));
});

test('an explicitly exported host wins over the repo, and its token comes with it', () => {
  // Someone who exports GH_HOST inside a tenant checkout means it. The token
  // follows the shell's declared host, not the directory they happen to be in.
  const plan = planCopilotGithubEnv({
    env: { GH_HOST: 'other.ghe.com', GH_TOKEN: 'other-tenant-token' },
    remoteUrl: TENANT_REMOTE
  });
  assert.equal(plan.host.host, 'other.ghe.com');
  assert.equal(plan.tokenSource, 'GH_TOKEN');
  assert.equal(plan.set.GH_TOKEN, 'other-tenant-token');
});

test('a token declared for a different host is refused, and the reason names both', () => {
  // Reached through the by-host entry point, which is what a caller with a host
  // from somewhere other than the environment (a future per-agent setting) uses.
  const host = resolveGithubHost({ env: {}, remoteUrl: TENANT_REMOTE });
  const plan = planGithubEnvForHost(host, { GH_HOST: 'other.ghe.com', GH_TOKEN: DOTCOM_PAT });
  assert.equal(plan.tokenSource, null);
  assert.deepEqual(plan.dropped, [
    { name: 'GH_TOKEN', reason: `scoped to other.ghe.com, not ${TENANT}` }
  ]);
});

test('GH_ENTERPRISE_TOKEN is eligible on a tenant with no host declared, and rides in as GH_TOKEN', () => {
  // Practical quirk: against tenant cloud, GH_ENTERPRISE_TOKEN 401s (it targets
  // GHES) while GH_TOKEN authenticates. Carry the value, drop the name.
  const plan = planCopilotGithubEnv({
    env: { GH_ENTERPRISE_TOKEN: 'ent-token', GH_TOKEN: DOTCOM_PAT },
    remoteUrl: TENANT_REMOTE
  });
  assert.equal(plan.tokenSource, 'GH_ENTERPRISE_TOKEN');
  assert.equal(plan.set.GH_TOKEN, 'ent-token');
  assert.ok(plan.omit.includes('GH_ENTERPRISE_TOKEN'), 'the name that 401s must not survive');
  assert.ok(!Object.values(plan.set).includes(DOTCOM_PAT));
});

test('GH_ENTERPRISE_TOKEN is ignored on github.com', () => {
  const plan = planCopilotGithubEnv({
    env: { GH_ENTERPRISE_TOKEN: 'ent-token', GH_TOKEN: DOTCOM_PAT },
    remoteUrl: 'https://github.com/chaitanyagiri/munder-difflin.git'
  });
  assert.deepEqual(plan.omit, []);
  assert.deepEqual(plan.set, {});
});

test('no dotcom host survives in a tenant spawn environment', () => {
  // The harness-side analogue of "assert no dotcom host is contacted while a
  // *.ghe.com host is active": nothing we hand the child may point at dotcom.
  const plan = planCopilotGithubEnv({
    env: { GH_HOST: 'github.com', COPILOT_GH_HOST: TENANT, GH_TOKEN: 'tenant-token' },
    remoteUrl: TENANT_REMOTE
  });
  for (const [name, value] of Object.entries(plan.set)) {
    assert.ok(!/github\.com/i.test(value), `${name}=${value} still points at dotcom`);
  }
});

// ── github.com must not regress ──────────────────────────────────────────────

test('github.com is left exactly as it was: no set, no omit', () => {
  for (const env of [
    { GH_TOKEN: DOTCOM_PAT },
    { GITHUB_TOKEN: DOTCOM_PAT },
    { COPILOT_GITHUB_TOKEN: DOTCOM_PAT },
    {}
  ]) {
    for (const remoteUrl of ['https://github.com/o/r.git', 'git@github.com:o/r.git', null]) {
      const plan = planCopilotGithubEnv({ env, remoteUrl });
      assert.deepEqual(plan.set, {}, JSON.stringify({ env, remoteUrl }));
      assert.deepEqual(plan.omit, [], JSON.stringify({ env, remoteUrl }));
    }
  }
});

test('the dotcom plan still reports its token source, in the CLI\'s own order', () => {
  const plan = planCopilotGithubEnv({
    env: { GH_TOKEN: 'a', GITHUB_TOKEN: 'b', COPILOT_GITHUB_TOKEN: 'c' },
    remoteUrl: null
  });
  assert.equal(plan.tokenSource, 'COPILOT_GITHUB_TOKEN');
});

// ── The diagnostic ───────────────────────────────────────────────────────────

test('the diagnostic names host, source, token variable and refusals — and no secrets', () => {
  const line = describeGithubEnvPlan(
    planCopilotGithubEnv({ env: { GH_TOKEN: DOTCOM_PAT }, remoteUrl: TENANT_REMOTE })
  );
  assert.match(line, /host=microsoft\.ghe\.com \(git-remote\)/);
  assert.match(line, /token=keyring/);
  assert.match(line, /dropped=GH_TOKEN/);
  assert.ok(!line.includes(DOTCOM_PAT), 'a token value must never be logged');
});

test('the diagnostic shows the carry-over when a token changes variable', () => {
  const secret = 'enterprise-token-value';
  const line = describeGithubEnvPlan(
    planCopilotGithubEnv({ env: { GH_ENTERPRISE_TOKEN: secret }, remoteUrl: TENANT_REMOTE })
  );
  assert.match(line, /token=GH_ENTERPRISE_TOKEN->GH_TOKEN/);
  assert.ok(!line.includes(secret), 'a token value must never be logged');
});

test('when every token was refused, the diagnostic says how to declare one', () => {
  const line = describeGithubEnvPlan(
    planCopilotGithubEnv({ env: { GH_TOKEN: DOTCOM_PAT }, remoteUrl: TENANT_REMOTE })
  );
  assert.match(line, /export COPILOT_GH_HOST=microsoft\.ghe\.com/);
});

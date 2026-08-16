'use strict';

/**
 * The integration template catalog (src/shared/integrations.ts).
 *
 * A template is what the user clicks to register a REST endpoint the loopback broker
 * will call on a worker's behalf. Every template therefore has to survive the SAME
 * upsert gate a hand-typed record does — a catalog entry that can't validate is a dead
 * button in the UI, and nothing else in the suite covered the catalog as a whole.
 *
 * Plus the specifics of the `sandbox-exec` entry: it is the one template whose baseUrl
 * the user must supply (their own deployed service, not a vendor's public API), and it
 * is the route agent-written code is meant to take instead of a local Bash call.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  INTEGRATION_TEMPLATES,
  INTEGRATION_SLUG_RE,
  validateIntegrationRecord,
  resolveUpstreamUrl,
  secretRefFor,
  authTypeNeedsSecret
} = loadTs('src/shared/integrations.ts');

/** The record the UI builds from a template once the user fills in the blanks. */
function recordFrom(tpl, baseUrl) {
  return {
    id: tpl.idSuggestion,
    label: tpl.label,
    kind: tpl.kind,
    baseUrl: baseUrl ?? tpl.baseUrl,
    authType: tpl.authType,
    ...(tpl.authHeader ? { authHeader: tpl.authHeader } : {}),
    ...(authTypeNeedsSecret(tpl.authType) ? { secretRef: secretRefFor(tpl.idSuggestion) } : {}),
    enabled: true
  };
}

test('every template yields a record that passes the upsert gate', () => {
  for (const tpl of INTEGRATION_TEMPLATES) {
    // Templates with no baseUrl expect the user to supply one; stand in for that here.
    const res = validateIntegrationRecord(recordFrom(tpl, tpl.baseUrl || 'https://example.test'));
    assert.equal(res.ok, true, `${tpl.label}: ${res.ok ? '' : res.error}`);
  }
});

test('template ids are unique and slug-shaped', () => {
  const seen = new Set();
  for (const tpl of INTEGRATION_TEMPLATES) {
    assert.match(tpl.idSuggestion, INTEGRATION_SLUG_RE, `${tpl.label} has a bad id`);
    assert.equal(seen.has(tpl.idSuggestion), false, `duplicate id ${tpl.idSuggestion}`);
    seen.add(tpl.idSuggestion);
  }
});

test('sandbox-exec ships with no baseUrl — it points at the user\'s own service', () => {
  const tpl = INTEGRATION_TEMPLATES.find((t) => t.idSuggestion === 'sandbox-exec');
  assert.ok(tpl, 'the sandbox-exec template should be in the catalog');
  assert.equal(tpl.baseUrl, '');
  assert.equal(tpl.authType, 'bearer');
  // A blank baseUrl must NOT validate: the user has to supply their Worker origin.
  assert.equal(validateIntegrationRecord(recordFrom(tpl)).ok, false);
});

test('a worker cannot escape the sandbox service origin through the broker path', () => {
  const base = 'https://md-sandbox-exec.example.workers.dev';
  assert.equal(resolveUpstreamUrl(base, 'exec').href, `${base}/exec`);
  // The broker forwards a worker-supplied path, so the traversal guards matter here as
  // much as for any other integration.
  assert.equal(resolveUpstreamUrl(base, '../../admin'), null);
  assert.equal(resolveUpstreamUrl(base, '%2e%2e/admin'), null);
  assert.equal(resolveUpstreamUrl(base, '//evil.test/exec'), null);
  assert.equal(resolveUpstreamUrl(base, 'https://evil.test/exec'), null);
});

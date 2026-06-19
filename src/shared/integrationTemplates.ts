/**
 * First-wave YC service templates (P2) — CONFORMED to Jim's registry schema.
 *
 * These are extra `IntegrationTemplate` presets that append to the canonical
 * `INTEGRATION_TEMPLATES` registry in `src/shared/integrations.ts` (Jim). There is
 * exactly ONE `IntegrationTemplate` type and ONE registry: this file imports the
 * type from `./integrations` and contributes entries — it deliberately declares NO
 * competing interface and NO competing catalog (collapsed per god's P2 conform).
 *
 * Wire-up (one line, in `src/shared/integrations.ts`):
 *   export const INTEGRATION_TEMPLATES = [ ...refs, ...YC_INTEGRATION_TEMPLATES ];
 * (or splice these entries directly into that array). The reference templates
 * `github` + `custom-rest` already live there.
 *
 * Keep this free of electron / UI / node imports (same rule as `mcpCatalog.ts` and
 * `integrations.ts`): pure data, importable by main + preload + renderer alike.
 *
 * SECRETS: a template never carries a secret value — only `secretLabel`/`secretHelp`
 * tell the UI what to ask for. At call time the loopback broker (Jim) injects the
 * decrypted secret per `authType` (`buildAuthHeaders` in `integrations.ts`); the
 * worker only ever holds a capability handle.
 *
 * AUTH MAPPING (to Jim's `IntegrationAuthType` = none | bearer | header | github):
 *   - bearer   → `Authorization: Bearer <secret>`        (Notion, Stripe, Sentry, HubSpot)
 *   - header   → `<authHeader>: <secret>` verbatim       (Linear: raw key in Authorization)
 *   - header   → also carries Basic auth as a pre-encoded value (Jira, Confluence):
 *                paste `Basic <base64(email:token)>`; the broker injects it verbatim.
 *
 * NOT REGISTERED HERE (flagged to god — Jim's v1 enum can't express them):
 *   - Gmail, Google Calendar, Salesforce authenticate via OAuth 2.0 through the
 *     broker. Jim's `IntegrationAuthType` has no `oauth2`, and OAuth refresh is a
 *     v1 NON-GOAL (spec §8). Their full research is kept in
 *     `hive/docs/integration-templates.md` under "Pending: OAuth broker"; they get
 *     added here verbatim once an oauth-broker auth type exists.
 *
 * Per-tool auth model + the high-value endpoint catalog (which Jim's lean template
 * shape intentionally does NOT carry — the broker forwards <baseUrl>/<path> with a
 * worker-supplied path) live in `hive/docs/integration-templates.md`.
 */

import type { IntegrationTemplate } from './integrations';

/**
 * First-wave templates that conform to Jim's `IntegrationTemplate`. Append-only:
 * adding a tool later = one more record here (or in `integrations.ts`), no code.
 */
export const YC_INTEGRATION_TEMPLATES: IntegrationTemplate[] = [
  // ─── Linear — GraphQL; personal key verbatim in Authorization (NO "Bearer") ──
  {
    kind: 'custom-rest',
    label: 'Linear',
    baseUrl: 'https://api.linear.app/graphql',
    authType: 'header',
    authHeader: 'Authorization',
    secretLabel: 'Linear API key',
    secretHelp:
      'Linear → Settings → Security & access → Personal API keys. Sent verbatim in Authorization (no "Bearer" prefix). Every call POSTs to /graphql.',
    docsUrl: 'https://developers.linear.app/docs/graphql/working-with-the-graphql-api',
    idSuggestion: 'linear'
  },

  // ─── Jira (Cloud) REST v3 — Basic auth carried as a pre-encoded header value ──
  {
    kind: 'custom-rest',
    label: 'Jira',
    // User edits the subdomain. Pinned to REST v3 (enhanced JQL is migrating to
    // /rest/api/3/search/jql — verify on wire before GA).
    baseUrl: 'https://your-domain.atlassian.net/rest/api/3',
    authType: 'header',
    authHeader: 'Authorization',
    secretLabel: 'Authorization header (Basic …)',
    secretHelp:
      'Basic auth: paste "Basic " + base64("<email>:<api-token>"). API token at id.atlassian.com → Security → API tokens. Replace your-domain in the URL with your Atlassian site.',
    docsUrl: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/',
    idSuggestion: 'jira'
  },

  // ─── Notion — Bearer; REQUIRES a per-request Notion-Version header ────────────
  {
    kind: 'custom-rest',
    label: 'Notion',
    baseUrl: 'https://api.notion.com/v1',
    authType: 'bearer',
    secretLabel: 'Notion internal integration token',
    secretHelp:
      'notion.so/my-integrations → Internal Integration Secret; share each target page/DB with it. Every request also needs header "Notion-Version: 2022-06-28" (worker sends it per-request).',
    docsUrl: 'https://developers.notion.com/reference/intro',
    idSuggestion: 'notion'
  },

  // ─── Stripe — Bearer secret key; request bodies are form-encoded ─────────────
  {
    kind: 'custom-rest',
    label: 'Stripe',
    baseUrl: 'https://api.stripe.com/v1',
    authType: 'bearer',
    secretLabel: 'Stripe secret key',
    secretHelp:
      'dashboard.stripe.com → Developers → API keys → Secret key (sk_live_/sk_test_). Restricted keys recommended. Bodies are application/x-www-form-urlencoded, not JSON.',
    docsUrl: 'https://stripe.com/docs/api',
    idSuggestion: 'stripe'
  },

  // ─── Confluence (Cloud) REST v2 — Basic auth as a pre-encoded header value ────
  {
    kind: 'custom-rest',
    label: 'Confluence',
    baseUrl: 'https://your-domain.atlassian.net/wiki/api/v2',
    authType: 'header',
    authHeader: 'Authorization',
    secretLabel: 'Authorization header (Basic …)',
    secretHelp:
      'Basic auth: paste "Basic " + base64("<email>:<api-token>") (same Atlassian token as Jira). Replace your-domain with your site.',
    docsUrl: 'https://developer.atlassian.com/cloud/confluence/rest/v2/intro/',
    idSuggestion: 'confluence'
  },

  // ─── Sentry — Bearer auth token; org slug goes in the path, not the baseUrl ──
  {
    kind: 'custom-rest',
    label: 'Sentry',
    baseUrl: 'https://sentry.io/api/0',
    authType: 'bearer',
    secretLabel: 'Sentry auth token',
    secretHelp:
      'sentry.io → Settings → Auth Tokens (or an internal integration token). Org-scoped routes carry your org slug in the path, e.g. /organizations/<org>/issues/.',
    docsUrl: 'https://docs.sentry.io/api/',
    idSuggestion: 'sentry'
  },

  // ─── HubSpot — Bearer private-app token; single global host ───────────────────
  {
    kind: 'custom-rest',
    label: 'HubSpot',
    baseUrl: 'https://api.hubapi.com',
    authType: 'bearer',
    secretLabel: 'HubSpot private app token',
    secretHelp:
      'HubSpot → Settings → Integrations → Private Apps → create app → Access token (scopes: crm.objects.*).',
    docsUrl: 'https://developers.hubspot.com/docs/api/crm/understanding-the-crm',
    idSuggestion: 'hubspot'
  }
];

/** Lookup by slug seed (`idSuggestion`). Registry convenience. */
export function getYcIntegrationTemplate(idSuggestion: string): IntegrationTemplate | undefined {
  return YC_INTEGRATION_TEMPLATES.find((t) => t.idSuggestion === idSuggestion);
}

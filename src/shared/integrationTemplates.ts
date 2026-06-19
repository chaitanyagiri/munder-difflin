/**
 * Declarative integration-template library (P2). A dependency-free,
 * importable-by-both (main + renderer) catalog of first-wave SaaS tools that the
 * integration *registry* (Jim) loads so that adding a tool = pick a template +
 * paste a secret. There is intentionally NO per-tool client code here: a template
 * is pure DATA describing how to reach an API (baseUrl, auth shape, a small catalog
 * of high-value endpoints). The registry/broker does the actual HTTP at call time.
 *
 * Keep this free of electron/UI/node imports (same rule as `mcpCatalog.ts`).
 *
 * SECRETS: templates NEVER contain a real key/token. Each template declares the
 * secrets it needs *by reference* (`secrets[].ref`), and the auth value is a
 * `${REF}` placeholder string the registry resolves from the user's vault at call
 * time. Non-secret per-install config (a Jira site domain, a Salesforce instance
 * host, a Sentry org slug) is declared in `config[]` and referenced the same way.
 *
 * BROKER-DELEGATED AUTH: Gmail, Google Calendar and Salesforce authenticate via
 * OAuth 2.0 through the broker (Jim), not a pasted static token. Those templates
 * set `auth.type:'oauth2'` + `auth.via:'broker'` with a provider id and the scopes
 * the broker must request; they declare NO `secrets[]` because the broker holds the
 * access/refresh tokens.
 *
 * SCHEMA NOTE: the `IntegrationTemplate` shape below is provisional. It mirrors the
 * `mcpCatalog.ts` house style (typed interface + exported const array + secrets by
 * reference). Once Jim publishes `hive/docs/integrations-spec.md`, this file gets a
 * mechanical conform pass (field renames only — the research/data does not change).
 * See `hive/docs/integration-templates.md` for the per-tool auth model + endpoints.
 */

export type IntegrationAuthType =
  | 'apiKey' // opaque key placed verbatim in a header (e.g. Linear personal key)
  | 'bearer' // `Authorization: Bearer <token>`
  | 'basic' // `Authorization: Basic base64(user:token)` (e.g. Atlassian email+API token)
  | 'oauth2'; // OAuth 2.0 access token; here always delegated to the broker

export type IntegrationCategory =
  | 'project' // issue / project tracking
  | 'docs' // knowledge base / docs
  | 'payments'
  | 'observability'
  | 'crm'
  | 'productivity';

/** A single high-value operation the template exposes. For REST tools `path` is
 *  appended to `baseUrl`; `{curly}` segments are runtime params. For GraphQL tools
 *  (`method:'GRAPHQL'`) every call POSTs to `baseUrl` and `path` names the operation
 *  (query/mutation) for documentation — the registry sends the GraphQL body. */
export interface IntegrationEndpoint {
  /** Stable id within the template, dotted, e.g. `issues.create`. */
  id: string;
  /** Human label for the catalog / consent UI. */
  label: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'GRAPHQL';
  /** REST path (appended to baseUrl) or GraphQL operation name. */
  path: string;
  /** One-line description of what the call does. */
  description: string;
}

/** Non-secret, per-install value the user supplies once (a site domain, an org
 *  slug, a Salesforce instance host). Referenced from `baseUrl`/paths as `${key}`. */
export interface IntegrationConfigField {
  key: string;
  label: string;
  /** Example value shown as a hint in the UI (never a real customer value). */
  example?: string;
}

/** A secret the user pastes, declared by reference only. The value lives in the
 *  vault under `ref`; auth strings interpolate it as `${ref}`. Never a real value. */
export interface IntegrationSecret {
  ref: string;
  label: string;
  /** Where to obtain it (settings page / docs hint). */
  help?: string;
}

export interface IntegrationAuth {
  type: IntegrationAuthType;
  /** Header carrying the credential (REST apiKey/bearer/basic). */
  header?: string;
  /** Value template using `${REF}` / `${config}` placeholders — NEVER a real secret.
   *  For `basic`, this is the pre-base64 `user:token` pattern; the registry base64s it. */
  valueTemplate?: string;
  /** Additional always-on headers a tool requires (e.g. Notion's API version). */
  staticHeaders?: Record<string, string>;
  /** OAuth only: the credential is brokered, not pasted. */
  via?: 'broker';
  /** OAuth only: broker provider id (e.g. `google`, `salesforce`). */
  provider?: string;
  /** OAuth only: scopes the broker must request. */
  scopes?: string[];
}

export interface IntegrationTemplate {
  /** Stable template id (also the consent key). */
  id: string;
  label: string;
  description: string;
  category: IntegrationCategory;
  /** API docs entry point. */
  docsUrl: string;
  /** API base URL. May embed `${config}` placeholders (Jira/Confluence/Salesforce). */
  baseUrl: string;
  /** Non-secret per-install config (empty for tools with a fixed global host). */
  config?: IntegrationConfigField[];
  /** Secrets required (empty for broker-delegated OAuth tools). */
  secrets?: IntegrationSecret[];
  auth: IntegrationAuth;
  /** 3-6 high-value endpoints. */
  endpoints: IntegrationEndpoint[];
}

/**
 * First-wave templates. Adding a tool later = append one record here; no code.
 * Ordered: pasted-secret tools first, broker-OAuth tools last.
 */
export const INTEGRATION_TEMPLATES: IntegrationTemplate[] = [
  // ─── Linear — GraphQL issue tracker ───────────────────────────────────────
  {
    id: 'linear',
    label: 'Linear',
    description: 'Issue & project tracking (GraphQL). Create/track issues and teams.',
    category: 'project',
    docsUrl: 'https://developers.linear.app/docs/graphql/working-with-the-graphql-api',
    baseUrl: 'https://api.linear.app/graphql',
    secrets: [
      {
        ref: 'LINEAR_API_KEY',
        label: 'Linear API key',
        help: 'Linear → Settings → Security & access → Personal API keys → New key.'
      }
    ],
    // Personal API keys go verbatim in Authorization (NO "Bearer" prefix). OAuth
    // access tokens would use `Bearer <token>` — out of scope for the paste flow.
    auth: { type: 'apiKey', header: 'Authorization', valueTemplate: '${LINEAR_API_KEY}' },
    endpoints: [
      { id: 'viewer', label: 'Current user', method: 'GRAPHQL', path: 'viewer', description: 'Authenticated user (id, name, email).' },
      { id: 'teams.list', label: 'List teams', method: 'GRAPHQL', path: 'teams', description: 'Teams the user can see (ids for issue creation).' },
      { id: 'issues.list', label: 'List issues', method: 'GRAPHQL', path: 'issues', description: 'Issues with filters (assignee, state, team).' },
      { id: 'issues.create', label: 'Create issue', method: 'GRAPHQL', path: 'issueCreate', description: 'Create an issue (title, teamId, description).' },
      { id: 'issues.update', label: 'Update issue', method: 'GRAPHQL', path: 'issueUpdate', description: 'Update an issue (state, assignee, fields).' }
    ]
  },

  // ─── Jira (Cloud) — REST v3, Basic (email + API token) ────────────────────
  {
    id: 'jira',
    label: 'Jira',
    description: 'Atlassian Jira Cloud issue tracking. Search/create/transition issues.',
    category: 'project',
    docsUrl: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/',
    baseUrl: 'https://${JIRA_SITE}.atlassian.net/rest/api/3',
    config: [
      { key: 'JIRA_SITE', label: 'Jira site subdomain', example: 'acme (for acme.atlassian.net)' }
    ],
    secrets: [
      { ref: 'JIRA_EMAIL', label: 'Atlassian account email', help: 'The email of the account that owns the API token.' },
      { ref: 'JIRA_API_TOKEN', label: 'Jira API token', help: 'id.atlassian.com → Security → Create and manage API tokens.' }
    ],
    // Basic auth: base64(email:api_token). Registry base64-encodes valueTemplate.
    auth: { type: 'basic', header: 'Authorization', valueTemplate: '${JIRA_EMAIL}:${JIRA_API_TOKEN}' },
    endpoints: [
      { id: 'myself', label: 'Current user', method: 'GET', path: '/myself', description: 'Authenticated account details.' },
      { id: 'issues.search', label: 'Search issues (JQL)', method: 'POST', path: '/search', description: 'Search via a JQL query in the request body.' },
      { id: 'issues.get', label: 'Get issue', method: 'GET', path: '/issue/{issueIdOrKey}', description: 'Fetch one issue by key (e.g. PROJ-123).' },
      { id: 'issues.create', label: 'Create issue', method: 'POST', path: '/issue', description: 'Create an issue (project, issuetype, summary).' },
      { id: 'issues.transition', label: 'Transition issue', method: 'POST', path: '/issue/{issueIdOrKey}/transitions', description: 'Move an issue to a new status.' }
    ]
  },

  // ─── Notion — REST, Bearer + required version header ──────────────────────
  {
    id: 'notion',
    label: 'Notion',
    description: 'Notion workspace: search, query databases, create & update pages.',
    category: 'docs',
    docsUrl: 'https://developers.notion.com/reference/intro',
    baseUrl: 'https://api.notion.com/v1',
    secrets: [
      {
        ref: 'NOTION_TOKEN',
        label: 'Notion internal integration token',
        help: 'notion.so/my-integrations → New integration → Internal Integration Secret. Share the target pages/DBs with it.'
      }
    ],
    // Notion-Version is REQUIRED on every request; 2022-06-28 is the stable pin.
    auth: {
      type: 'bearer',
      header: 'Authorization',
      valueTemplate: 'Bearer ${NOTION_TOKEN}',
      staticHeaders: { 'Notion-Version': '2022-06-28' }
    },
    endpoints: [
      { id: 'users.me', label: 'Bot user', method: 'GET', path: '/users/me', description: 'The integration’s bot user (token sanity check).' },
      { id: 'search', label: 'Search', method: 'POST', path: '/search', description: 'Search pages & databases shared with the integration.' },
      { id: 'db.query', label: 'Query database', method: 'POST', path: '/databases/{database_id}/query', description: 'Query rows of a database with filters/sorts.' },
      { id: 'pages.create', label: 'Create page', method: 'POST', path: '/pages', description: 'Create a page in a database or under a parent.' },
      { id: 'pages.update', label: 'Update page', method: 'PATCH', path: '/pages/{page_id}', description: 'Update page properties / archive.' }
    ]
  },

  // ─── Stripe — REST, Bearer secret key, form-encoded bodies ────────────────
  {
    id: 'stripe',
    label: 'Stripe',
    description: 'Payments: customers, payment intents, invoices, refunds, balance.',
    category: 'payments',
    docsUrl: 'https://stripe.com/docs/api',
    baseUrl: 'https://api.stripe.com/v1',
    secrets: [
      {
        ref: 'STRIPE_SECRET_KEY',
        label: 'Stripe secret key',
        help: 'dashboard.stripe.com → Developers → API keys → Secret key (sk_live_… / sk_test_…). Restricted keys recommended.'
      }
    ],
    // Bodies are application/x-www-form-urlencoded (NOT JSON) — registry must encode.
    auth: { type: 'bearer', header: 'Authorization', valueTemplate: 'Bearer ${STRIPE_SECRET_KEY}' },
    endpoints: [
      { id: 'balance', label: 'Get balance', method: 'GET', path: '/balance', description: 'Account balance (key sanity check).' },
      { id: 'customers.list', label: 'List customers', method: 'GET', path: '/customers', description: 'List customers (paginated).' },
      { id: 'customers.create', label: 'Create customer', method: 'POST', path: '/customers', description: 'Create a customer (email, name, metadata).' },
      { id: 'paymentintents.create', label: 'Create payment intent', method: 'POST', path: '/payment_intents', description: 'Create a PaymentIntent (amount, currency).' },
      { id: 'invoices.list', label: 'List invoices', method: 'GET', path: '/invoices', description: 'List invoices, filterable by customer/status.' },
      { id: 'refunds.create', label: 'Create refund', method: 'POST', path: '/refunds', description: 'Refund a charge/payment intent.' }
    ]
  },

  // ─── Confluence (Cloud) — REST v2, Basic (email + API token) ──────────────
  {
    id: 'confluence',
    label: 'Confluence',
    description: 'Atlassian Confluence Cloud: read/create/update pages and spaces.',
    category: 'docs',
    docsUrl: 'https://developer.atlassian.com/cloud/confluence/rest/v2/intro/',
    baseUrl: 'https://${CONFLUENCE_SITE}.atlassian.net/wiki/api/v2',
    config: [
      { key: 'CONFLUENCE_SITE', label: 'Confluence site subdomain', example: 'acme (for acme.atlassian.net)' }
    ],
    secrets: [
      { ref: 'CONFLUENCE_EMAIL', label: 'Atlassian account email', help: 'Email of the account that owns the API token.' },
      { ref: 'CONFLUENCE_API_TOKEN', label: 'Confluence API token', help: 'id.atlassian.com → Security → API tokens (shared with Jira).' }
    ],
    auth: { type: 'basic', header: 'Authorization', valueTemplate: '${CONFLUENCE_EMAIL}:${CONFLUENCE_API_TOKEN}' },
    endpoints: [
      { id: 'spaces.list', label: 'List spaces', method: 'GET', path: '/spaces', description: 'List spaces (ids for page creation).' },
      { id: 'pages.list', label: 'List pages', method: 'GET', path: '/pages', description: 'List pages, filterable by space.' },
      { id: 'pages.get', label: 'Get page', method: 'GET', path: '/pages/{id}', description: 'Fetch one page (optionally with body).' },
      { id: 'pages.create', label: 'Create page', method: 'POST', path: '/pages', description: 'Create a page (spaceId, title, body).' },
      { id: 'pages.update', label: 'Update page', method: 'PUT', path: '/pages/{id}', description: 'Update a page (title/body, new version).' }
    ]
  },

  // ─── Sentry — REST, Bearer auth token ─────────────────────────────────────
  {
    id: 'sentry',
    label: 'Sentry',
    description: 'Error monitoring: list projects, browse & triage issues and events.',
    category: 'observability',
    docsUrl: 'https://docs.sentry.io/api/',
    baseUrl: 'https://sentry.io/api/0',
    config: [
      { key: 'SENTRY_ORG', label: 'Sentry organization slug', example: 'acme' }
    ],
    secrets: [
      {
        ref: 'SENTRY_AUTH_TOKEN',
        label: 'Sentry auth token',
        help: 'sentry.io → Settings → Auth Tokens (or an internal integration token).'
      }
    ],
    auth: { type: 'bearer', header: 'Authorization', valueTemplate: 'Bearer ${SENTRY_AUTH_TOKEN}' },
    endpoints: [
      { id: 'projects.list', label: 'List projects', method: 'GET', path: '/projects/', description: 'Projects the token can access.' },
      { id: 'org.issues', label: 'List org issues', method: 'GET', path: '/organizations/${SENTRY_ORG}/issues/', description: 'Unresolved issues across the org (query/sort).' },
      { id: 'issues.get', label: 'Get issue', method: 'GET', path: '/issues/{issue_id}/', description: 'Fetch one issue’s detail.' },
      { id: 'issues.update', label: 'Update issue', method: 'PUT', path: '/issues/{issue_id}/', description: 'Resolve/ignore/assign an issue.' },
      { id: 'issues.events', label: 'Latest event', method: 'GET', path: '/issues/{issue_id}/events/latest/', description: 'Most recent event (stack trace) for an issue.' }
    ]
  },

  // ─── HubSpot — REST v3 CRM, Bearer (private app token) ────────────────────
  {
    id: 'hubspot',
    label: 'HubSpot',
    description: 'CRM: contacts, companies and deals — list, search and create.',
    category: 'crm',
    docsUrl: 'https://developers.hubspot.com/docs/api/crm/understanding-the-crm',
    baseUrl: 'https://api.hubapi.com',
    secrets: [
      {
        ref: 'HUBSPOT_TOKEN',
        label: 'HubSpot private app token',
        help: 'HubSpot → Settings → Integrations → Private Apps → create app → Access token (scopes: crm.objects.*).'
      }
    ],
    auth: { type: 'bearer', header: 'Authorization', valueTemplate: 'Bearer ${HUBSPOT_TOKEN}' },
    endpoints: [
      { id: 'contacts.list', label: 'List contacts', method: 'GET', path: '/crm/v3/objects/contacts', description: 'List contacts (properties, paging).' },
      { id: 'contacts.create', label: 'Create contact', method: 'POST', path: '/crm/v3/objects/contacts', description: 'Create a contact (email, firstname…).' },
      { id: 'contacts.search', label: 'Search contacts', method: 'POST', path: '/crm/v3/objects/contacts/search', description: 'Filter contacts by property values.' },
      { id: 'companies.list', label: 'List companies', method: 'GET', path: '/crm/v3/objects/companies', description: 'List companies.' },
      { id: 'deals.list', label: 'List deals', method: 'GET', path: '/crm/v3/objects/deals', description: 'List deals (pipeline, amount, stage).' },
      { id: 'deals.create', label: 'Create deal', method: 'POST', path: '/crm/v3/objects/deals', description: 'Create a deal.' }
    ]
  },

  // ─── Gmail — broker-delegated Google OAuth 2.0 ────────────────────────────
  {
    id: 'gmail',
    label: 'Gmail',
    description: 'Read, search and send mail via the Gmail API (OAuth via broker).',
    category: 'productivity',
    docsUrl: 'https://developers.google.com/gmail/api/reference/rest',
    baseUrl: 'https://gmail.googleapis.com/gmail/v1',
    // No secrets[]: the broker holds the OAuth access/refresh tokens.
    auth: {
      type: 'oauth2',
      via: 'broker',
      provider: 'google',
      header: 'Authorization',
      valueTemplate: 'Bearer ${BROKER_ACCESS_TOKEN}',
      scopes: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send'
      ]
    },
    endpoints: [
      { id: 'messages.list', label: 'List messages', method: 'GET', path: '/users/me/messages', description: 'List/search messages (q= Gmail query).' },
      { id: 'messages.get', label: 'Get message', method: 'GET', path: '/users/me/messages/{id}', description: 'Fetch one message (headers/body).' },
      { id: 'messages.send', label: 'Send message', method: 'POST', path: '/users/me/messages/send', description: 'Send a raw RFC 2822 message.' },
      { id: 'labels.list', label: 'List labels', method: 'GET', path: '/users/me/labels', description: 'List mailbox labels.' }
    ]
  },

  // ─── Google Calendar — broker-delegated Google OAuth 2.0 ──────────────────
  {
    id: 'google-calendar',
    label: 'Google Calendar',
    description: 'List calendars and read/create events (OAuth via broker).',
    category: 'productivity',
    docsUrl: 'https://developers.google.com/calendar/api/v3/reference',
    baseUrl: 'https://www.googleapis.com/calendar/v3',
    auth: {
      type: 'oauth2',
      via: 'broker',
      provider: 'google',
      header: 'Authorization',
      valueTemplate: 'Bearer ${BROKER_ACCESS_TOKEN}',
      scopes: [
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/calendar.events'
      ]
    },
    endpoints: [
      { id: 'calendars.list', label: 'List calendars', method: 'GET', path: '/users/me/calendarList', description: 'Calendars on the user’s list.' },
      { id: 'events.list', label: 'List events', method: 'GET', path: '/calendars/{calendarId}/events', description: 'Events in a calendar (timeMin/timeMax).' },
      { id: 'events.get', label: 'Get event', method: 'GET', path: '/calendars/{calendarId}/events/{eventId}', description: 'Fetch one event.' },
      { id: 'events.create', label: 'Create event', method: 'POST', path: '/calendars/{calendarId}/events', description: 'Create an event (start, end, attendees).' }
    ]
  },

  // ─── Salesforce — broker-delegated OAuth 2.0, instance host config ────────
  {
    id: 'salesforce',
    label: 'Salesforce',
    description: 'Salesforce CRM REST: SOQL queries and Account/Contact/Opportunity CRUD.',
    category: 'crm',
    docsUrl: 'https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/',
    // Instance host is per-org (My Domain). API version pinned to v60.0.
    baseUrl: 'https://${SALESFORCE_INSTANCE}/services/data/v60.0',
    config: [
      {
        key: 'SALESFORCE_INSTANCE',
        label: 'Salesforce instance host',
        example: 'acme.my.salesforce.com'
      }
    ],
    auth: {
      type: 'oauth2',
      via: 'broker',
      provider: 'salesforce',
      header: 'Authorization',
      valueTemplate: 'Bearer ${BROKER_ACCESS_TOKEN}',
      scopes: ['api', 'refresh_token']
    },
    endpoints: [
      { id: 'query', label: 'SOQL query', method: 'GET', path: '/query?q={soql}', description: 'Run a SOQL query (e.g. SELECT Id,Name FROM Account).' },
      { id: 'account.get', label: 'Get account', method: 'GET', path: '/sobjects/Account/{id}', description: 'Fetch one Account by id.' },
      { id: 'account.create', label: 'Create account', method: 'POST', path: '/sobjects/Account', description: 'Create an Account.' },
      { id: 'contact.create', label: 'Create contact', method: 'POST', path: '/sobjects/Contact', description: 'Create a Contact.' },
      { id: 'opportunity.list', label: 'List opportunities', method: 'GET', path: '/sobjects/Opportunity', description: 'Describe/list Opportunity records.' }
    ]
  }
];

/** Lookup by id (registry convenience). */
export function getIntegrationTemplate(id: string): IntegrationTemplate | undefined {
  return INTEGRATION_TEMPLATES.find((t) => t.id === id);
}

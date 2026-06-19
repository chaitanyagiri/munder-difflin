# Integration Templates — first-wave YC tools

Declarative templates so **adding a tool = pick a template + paste a secret** — no
per-tool client code. Each template is pure data (`src/shared/integrationTemplates.ts`)
that the integration **registry** (Jim) loads; the **broker** (Jim) makes the actual
HTTP calls. This doc is the research backing each template: base URL, auth model, and
the high-value endpoints.

## How a template works

- **`baseUrl`** — API root. May embed `${CONFIG}` placeholders for per-install values
  (Jira/Confluence site subdomain, Salesforce instance host).
- **`config[]`** — non-secret per-install values the user types once (a domain, an org
  slug). Interpolated into `baseUrl`/paths.
- **`secrets[]`** — declared **by reference only**. The user pastes the value; it lands
  in the vault under `ref`; auth strings interpolate it as `${REF}`. **No template ever
  contains a real key.**
- **`auth`** — `apiKey` (verbatim header), `bearer` (`Authorization: Bearer …`),
  `basic` (`base64(user:token)` — registry does the base64), or `oauth2` (broker-held
  token, no paste).
- **`endpoints[]`** — 3-6 high-value operations. `{curly}` segments are runtime params.

## Auth model at a glance

| Tool | Category | Auth | Secret to paste / config | Base URL |
|------|----------|------|--------------------------|----------|
| Linear | project | apiKey (verbatim, **no `Bearer`**) | `LINEAR_API_KEY` | `https://api.linear.app/graphql` |
| Jira | project | basic (email + API token) | `JIRA_EMAIL`, `JIRA_API_TOKEN` + site `JIRA_SITE` | `https://${JIRA_SITE}.atlassian.net/rest/api/3` |
| Notion | docs | bearer + `Notion-Version` header | `NOTION_TOKEN` | `https://api.notion.com/v1` |
| Stripe | payments | bearer (secret key), form-encoded bodies | `STRIPE_SECRET_KEY` | `https://api.stripe.com/v1` |
| Confluence | docs | basic (email + API token) | `CONFLUENCE_EMAIL`, `CONFLUENCE_API_TOKEN` + site `CONFLUENCE_SITE` | `https://${CONFLUENCE_SITE}.atlassian.net/wiki/api/v2` |
| Sentry | observability | bearer (auth token) | `SENTRY_AUTH_TOKEN` + org `SENTRY_ORG` | `https://sentry.io/api/0` |
| HubSpot | crm | bearer (private app token) | `HUBSPOT_TOKEN` | `https://api.hubapi.com` |
| Gmail | productivity | **oauth2 via broker** (google) | *(brokered — no paste)* | `https://gmail.googleapis.com/gmail/v1` |
| Google Calendar | productivity | **oauth2 via broker** (google) | *(brokered — no paste)* | `https://www.googleapis.com/calendar/v3` |
| Salesforce | crm | **oauth2 via broker** (salesforce) | instance `SALESFORCE_INSTANCE` | `https://${SALESFORCE_INSTANCE}/services/data/v60.0` |

The three broker-delegated tools declare **no `secrets[]`**: the broker holds the
OAuth access/refresh tokens and injects `Authorization: Bearer <token>` at call time.
Templates only declare the `provider` + `scopes` the broker must request.

---

## Linear — GraphQL

- **Auth:** personal API key placed **verbatim** in `Authorization` (no `Bearer`
  prefix; that prefix is only for OAuth tokens). Key: *Settings → Security & access →
  Personal API keys*.
- **Transport:** single GraphQL endpoint; every call POSTs to `baseUrl`. Endpoint ids
  below name the query/mutation.
- **Operations:** `viewer` (current user) · `teams` (list teams) · `issues` (list,
  filterable) · `issueCreate` · `issueUpdate`.

## Jira (Cloud) — REST v3

- **Auth:** Basic — `base64(email : API token)`. Token from *id.atlassian.com →
  Security → API tokens* (shared with Confluence). Site subdomain is config.
- **Endpoints:** `GET /myself` · `POST /search` (JQL in body) · `GET /issue/{key}` ·
  `POST /issue` (create) · `POST /issue/{key}/transitions` (change status).

## Notion — REST

- **Auth:** `Authorization: Bearer <internal integration token>`, **plus the required
  `Notion-Version` header** (pinned `2022-06-28`). Token from *notion.so/my-integrations*;
  the integration must be **shared** with each target page/database.
- **Endpoints:** `GET /users/me` · `POST /search` · `POST /databases/{id}/query` ·
  `POST /pages` (create) · `PATCH /pages/{id}` (update/archive).

## Stripe — REST

- **Auth:** `Authorization: Bearer sk_live_…` (secret/restricted key). **Bodies are
  `application/x-www-form-urlencoded`, not JSON** — the registry must form-encode.
- **Endpoints:** `GET /balance` (key check) · `GET/POST /customers` ·
  `POST /payment_intents` · `GET /invoices` · `POST /refunds`.

## Confluence (Cloud) — REST v2

- **Auth:** Basic, same Atlassian email + API token as Jira. Site subdomain is config.
  v2 base is `…/wiki/api/v2` (v1 `…/wiki/rest/api` still exists).
- **Endpoints:** `GET /spaces` · `GET /pages` · `GET /pages/{id}` · `POST /pages`
  (create) · `PUT /pages/{id}` (update — bumps version).

## Sentry — REST

- **Auth:** `Authorization: Bearer <auth token>` (*Settings → Auth Tokens*). Org slug
  is config; many routes are org/project-scoped.
- **Endpoints:** `GET /projects/` · `GET /organizations/{org}/issues/` ·
  `GET /issues/{id}/` · `PUT /issues/{id}/` (resolve/assign) ·
  `GET /issues/{id}/events/latest/` (stack trace).

## HubSpot — REST v3 (CRM)

- **Auth:** `Authorization: Bearer <private app token>` (*Settings → Integrations →
  Private Apps*; scopes `crm.objects.*`). Single global host `api.hubapi.com`.
- **Endpoints:** `GET/POST /crm/v3/objects/contacts` ·
  `POST /crm/v3/objects/contacts/search` · `GET /crm/v3/objects/companies` ·
  `GET/POST /crm/v3/objects/deals`.

## Gmail — REST (OAuth via broker)

- **Auth:** OAuth 2.0, **brokered**. Provider `google`; scopes `gmail.readonly`,
  `gmail.send`. No pasted secret — broker injects the bearer token.
- **Endpoints:** `GET /users/me/messages` (search via `q=`) ·
  `GET /users/me/messages/{id}` · `POST /users/me/messages/send` ·
  `GET /users/me/labels`.

## Google Calendar — REST (OAuth via broker)

- **Auth:** OAuth 2.0, **brokered**. Provider `google`; scopes `calendar.readonly`,
  `calendar.events`.
- **Endpoints:** `GET /users/me/calendarList` ·
  `GET /calendars/{calendarId}/events` (`timeMin`/`timeMax`) ·
  `GET /calendars/{calendarId}/events/{eventId}` ·
  `POST /calendars/{calendarId}/events` (create).

## Salesforce — REST (OAuth via broker)

- **Auth:** OAuth 2.0, **brokered**. Provider `salesforce`; scopes `api`,
  `refresh_token`. Instance host (My Domain) is config; API pinned to `v60.0`.
- **Endpoints:** `GET /query?q={SOQL}` · `GET/POST /sobjects/Account` ·
  `POST /sobjects/Contact` · `GET /sobjects/Opportunity`.

---

## Notes / open items

- **Schema is provisional.** The `IntegrationTemplate` interface mirrors the
  `mcpCatalog.ts` house style (typed interface + exported const array + secrets by
  reference). It conforms mechanically to Jim's `hive/docs/integrations-spec.md` once
  published — field renames only; the researched data (URLs/auth/endpoints) is stable.
- **Verify-on-wire before GA:** Jira enhanced JQL search is migrating to
  `/rest/api/3/search/jql`; Notion `Notion-Version` advances periodically; Atlassian/
  Salesforce/Google API versions pinned here (`v60.0`, `2022-06-28`, `v2`) should be
  re-checked at integration time.
- **Secrets:** never stored in templates. `secrets[].ref` names the vault key; the
  broker owns OAuth tokens for the three delegated tools.
- **Out of scope (other agents):** the registry/broker runtime (Jim) and the Add-Tool
  UI (Ryan). This deliverable is data + this doc only.

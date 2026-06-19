# Integration Templates — first-wave YC tools

Declarative templates so **adding a tool = pick a template + paste a secret** — no
per-tool client code. Each template is pure data conforming to the **canonical
`IntegrationTemplate`** in `src/shared/integrations.ts` (Jim's registry/broker spec —
`hive/docs/integrations-spec.md`). The first-wave entries are appended directly into
that file's single `INTEGRATION_TEMPLATES` array — one type, one enum, one registry,
no separate catalog. The **loopback broker** (Jim) makes the actual HTTP calls and is
the only place a secret is ever materialized. This doc is the research backing each
template: base URL, auth model, and the high-value endpoints.

## How a template works (canonical shape)

A template is a preset that seeds an `IntegrationRecord`. Its fields (per spec §5):

- **`kind`** — `'github' | 'custom-rest'`. Every first-wave tool here is `custom-rest`.
- **`baseUrl`** — API origin (+ base path). The broker forwards `<baseUrl>/<path>`,
  where `<path>` is supplied by the worker per call (the endpoint catalog below is
  reference, not part of the type). Site-specific tools ship an editable placeholder
  host (`your-domain.atlassian.net`) the user replaces.
- **`authType`** — how the broker injects the credential: `none`, `bearer`
  (`Authorization: Bearer <secret>`), `header` (`<authHeader>: <secret>` verbatim), or
  `github` (bearer + GitHub headers). **No template carries a secret** — only
  `secretLabel`/`secretHelp` tell the UI what to ask for; the user's pasted value is
  encrypted at rest and injected only at forward-time.
- **`authHeader`** — required for `authType:'header'`; the header name to inject under.
- **`secretLabel` / `secretHelp`** — UI prompt + where to get the secret.
- **`docsUrl` / `idSuggestion`** — docs link + default slug seed.

## Auth model at a glance

| Tool | `kind` | `authType` | What the user pastes | Base URL (default) |
|------|--------|------------|----------------------|--------------------|
| Linear | custom-rest | `header` (Authorization, **verbatim — no `Bearer`**) | Linear API key | `https://api.linear.app/graphql` |
| Jira | custom-rest | `header` (Authorization) | `Basic <base64(email:token)>` | `https://your-domain.atlassian.net/rest/api/3` |
| Notion | custom-rest | `bearer` (+ per-request `Notion-Version`) | Notion integration token | `https://api.notion.com/v1` |
| Stripe | custom-rest | `bearer` (form-encoded bodies) | Stripe secret key | `https://api.stripe.com/v1` |
| Confluence | custom-rest | `header` (Authorization) | `Basic <base64(email:token)>` | `https://your-domain.atlassian.net/wiki/api/v2` |
| Sentry | custom-rest | `bearer` | Sentry auth token | `https://sentry.io/api/0` |
| HubSpot | custom-rest | `bearer` | HubSpot private app token | `https://api.hubapi.com` |
| Gmail | *(pending)* | **needs `oauth2` — not in v1 enum** | *(brokered OAuth — see below)* | `https://gmail.googleapis.com/gmail/v1` |
| Google Calendar | *(pending)* | **needs `oauth2` — not in v1 enum** | *(brokered OAuth — see below)* | `https://www.googleapis.com/calendar/v3` |
| Salesforce | *(pending)* | **needs `oauth2` — not in v1 enum** | *(brokered OAuth — see below)* | `https://<instance>/services/data/v60.0` |

**Basic auth (Jira/Confluence)** is carried as a pre-encoded `header` value: the user
pastes `Basic <base64("email:api_token")>` and the broker injects it verbatim under
`Authorization`. A dedicated `basic` authType (paste email + token separately, broker
does the base64) would be cleaner — flagged to god as a proposed enum addition.

**OAuth tools (Gmail / Google Calendar / Salesforce)** are **not registered in v1**:
Jim's `IntegrationAuthType` has no `oauth2`, and OAuth refresh is a v1 non-goal (spec
§8). Their research is retained under **Pending: OAuth broker** below; they get added
verbatim once a broker-OAuth auth type exists.

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

---

## Pending: OAuth broker (Gmail · Google Calendar · Salesforce)

These three are **researched but NOT registered** in `YC_INTEGRATION_TEMPLATES`. They
authenticate via OAuth 2.0 (a brokered access/refresh token, not a pasted static
secret), which Jim's v1 schema does not model: `IntegrationAuthType` has no `oauth2`
and OAuth refresh is a v1 non-goal (spec §8). To ship them, the registry needs a
broker-OAuth auth type (e.g. `oauth2` with a `provider` + `scopes`, the token held and
refreshed by the broker, injected as `Authorization: Bearer <token>` at forward-time).
Once that exists, the records below drop straight into the registry. Salesforce also
needs a per-org instance host (`<instance>.my.salesforce.com`) the user supplies.

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

- **Conformed to Jim's canonical schema.** The 7 first-wave entries are appended
  directly into `INTEGRATION_TEMPLATES` in `src/shared/integrations.ts`, using the
  canonical `IntegrationTemplate` type + `authType` enum. The standalone
  `src/shared/integrationTemplates.ts` (and its interface) was removed — **one type,
  one enum, one registry, no competing catalog**. Verified `typecheck:node` +
  `typecheck:web` exit 0.
- **Flagged gaps (god → Jim, enum widening rather than forking the type):**
  1. **OAuth (Gmail/Calendar/Salesforce):** no `oauth2` authType; v1 non-goal. The 3
     are documented (above) but unregistered. → add a broker-OAuth auth type, or defer.
  2. **Basic auth (Jira/Confluence):** works today as `header` + a pre-encoded
     `Basic <base64>` value. A dedicated `basic` authType (paste email + token, broker
     base64-encodes) is the clean UX.
  3. **Notion `Notion-Version` header:** required on every request but the lean
     template has no static-header field. v1 workaround: the worker sends it per
     request. A `staticHeaders` field (or a `notion` kind) would carry it natively.
- **Three `IntegrationTemplate` shapes still exist** across the tree (this file →
  conformed; Jim's `integrations.ts`; Ryan's renderer `registryClient.ts` mock). Full
  collapse to one needs Ryan's Settings UI to consume the shared templates — a
  cross-agent step for god to sequence.
- **Verify-on-wire before GA:** Jira enhanced JQL is migrating to
  `/rest/api/3/search/jql`; Notion `Notion-Version` advances periodically; pinned API
  versions (`v60.0`, `2022-06-28`, `v2`) re-check at integration time.
- **Out of scope (other agents):** the registry/broker runtime (Jim) and the Settings
  UI (Ryan). This deliverable is the conformed template data + this doc only.

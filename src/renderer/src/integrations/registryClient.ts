// Integrations registry client — the renderer's single doorway to the
// integrations registry + secret broker.
//
// ⚠️ PROVISIONAL: the types and the client body below are a scaffold. They will
// be CONFORMED to Jim's hive/docs/integrations-spec.md (registry schema + IPC
// channel names) once it is published. Conforming is intentionally a ONE-FILE
// change: swap the in-memory mock bodies for `window.cth.*` IPC calls and align
// the types with the spec. The UI (IntegrationsRegistry.tsx) talks ONLY to this
// module, never to IPC directly, so nothing downstream changes when we wire up.
//
// The template set + glyphs mirror Pam's reference mockup
// (hive/docs/integrations-ui-mockup.html). The REAL catalog is Dwight's; these
// stand in until the registry serves templates.
//
// SECURITY INVARIANT (must survive conformance): a secret value flows ONE WAY —
// from the form into save()/testDraft() and onward to the broker. It is NEVER
// read back. `IntegrationEntry` carries `hasSecret: boolean` (presence only);
// there is no field that could carry the secret value back to the renderer.

/** A small brand monogram tile (stands in for a logo). */
export interface IntegrationGlyph {
  /** 1–2 char monogram, e.g. 'Li', 'Gh', '{}'. */
  mono: string;
  /** Background hex, e.g. '#5E6AD2'. */
  bg: string;
}

/** A non-secret field a template asks the user to fill in. */
export interface IntegrationFieldSpec {
  key: string;
  label: string;
  placeholder?: string;
  optional?: boolean;
}

/** A kind/template of integration (authored by Dwight; served by the registry). */
export interface IntegrationTemplate {
  /** Stable kind id, e.g. 'linear', 'github', 'custom-rest'. */
  id: string;
  label: string;
  /** Short one-liner, e.g. 'Issues & projects'. */
  description: string;
  glyph: IntegrationGlyph;
  /** Human label for the one secret this kind needs, e.g. 'API secret key'. */
  secretLabel: string;
  /** Non-secret config fields. */
  fields: IntegrationFieldSpec[];
}

export type IntegrationStatus = 'untested' | 'ok' | 'error';

/** A configured integration instance. The secret value is NEVER present here. */
export interface IntegrationEntry {
  id: string;
  /** User-given label. */
  label: string;
  /** Template/kind id this instance is built from. */
  templateId: string;
  /** Non-secret field values. */
  fields: Record<string, string>;
  /** Whether a secret has been stored in the broker for this entry (value never echoed). */
  hasSecret: boolean;
  /** Worker ids that are allowed to use this integration. */
  workers: string[];
  status: IntegrationStatus;
  /** Epoch ms of the last test-connection, if any. */
  lastTestedAt?: number;
}

/** A worker that may be granted use of an integration. */
export interface IntegrationWorker {
  id: string;
  label: string;
}

/** Result of a test-connection probe. */
export interface TestResult {
  ok: boolean;
  message: string;
}

/**
 * Payload for add (no `id`) or edit (with `id`). `secret` is WRITE-ONLY:
 * include it to (re)set the secret; omit it to leave the stored secret as-is.
 */
export interface IntegrationDraft {
  id?: string;
  label: string;
  templateId: string;
  fields: Record<string, string>;
  secret?: string;
  workers: string[];
}

export interface IntegrationsClient {
  listTemplates(): Promise<IntegrationTemplate[]>;
  listWorkers(): Promise<IntegrationWorker[]>;
  list(): Promise<IntegrationEntry[]>;
  /** Add (draft.id absent) or edit (draft.id present). Returns the saved entry (no secret). */
  save(draft: IntegrationDraft): Promise<IntegrationEntry>;
  remove(id: string): Promise<void>;
  /** Test a saved integration by id (used by the list rows). */
  test(id: string): Promise<TestResult>;
  /** Test the in-progress draft (with its typed secret) before saving — the configure step. */
  testDraft(draft: IntegrationDraft): Promise<TestResult>;
}

// ---------------------------------------------------------------------------
// PROVISIONAL template catalog — mirrors Pam's mockup gallery (11 templates).
// ---------------------------------------------------------------------------

const CUSTOM_REST_FIELDS: IntegrationFieldSpec[] = [
  { key: 'baseUrl', label: 'Base URL', placeholder: 'https://api.example.com' },
  { key: 'authHeader', label: 'Auth header', placeholder: 'Authorization: Bearer …', optional: true }
];

const MOCK_TEMPLATES: IntegrationTemplate[] = [
  { id: 'linear', label: 'Linear', description: 'Issues & projects', glyph: { mono: 'Li', bg: '#5E6AD2' }, secretLabel: 'API key', fields: [] },
  { id: 'jira', label: 'Jira', description: 'Tickets & boards', glyph: { mono: 'Ji', bg: '#2684FF' }, secretLabel: 'API token', fields: [{ key: 'site', label: 'Site URL', placeholder: 'https://acme.atlassian.net' }, { key: 'email', label: 'Account email', placeholder: 'you@acme.com' }] },
  { id: 'notion', label: 'Notion', description: 'Pages & databases', glyph: { mono: 'No', bg: '#1A1320' }, secretLabel: 'Integration token', fields: [] },
  { id: 'stripe', label: 'Stripe', description: 'Payments & billing', glyph: { mono: 'St', bg: '#635BFF' }, secretLabel: 'API secret key', fields: [] },
  { id: 'confluence', label: 'Confluence', description: 'Wiki & docs', glyph: { mono: 'Cf', bg: '#1868DB' }, secretLabel: 'API token', fields: [{ key: 'site', label: 'Site URL', placeholder: 'https://acme.atlassian.net/wiki' }] },
  { id: 'sentry', label: 'Sentry', description: 'Error monitoring', glyph: { mono: 'Sy', bg: '#C84B4B' }, secretLabel: 'Auth token', fields: [{ key: 'org', label: 'Org slug', placeholder: 'acme', optional: true }] },
  { id: 'hubspot', label: 'HubSpot', description: 'CRM & contacts', glyph: { mono: 'Hs', bg: '#FF7A59' }, secretLabel: 'Private app token', fields: [] },
  { id: 'github', label: 'GitHub', description: 'Repos & pull requests', glyph: { mono: 'Gh', bg: '#1A1320' }, secretLabel: 'Personal access token', fields: [{ key: 'org', label: 'Org / owner', placeholder: 'acme', optional: true }] },
  { id: 'google-workspace', label: 'Gmail + Calendar', description: 'Mail & events', glyph: { mono: 'GC', bg: '#EA4335' }, secretLabel: 'OAuth client secret', fields: [{ key: 'clientId', label: 'Client ID', placeholder: '…apps.googleusercontent.com' }] },
  { id: 'salesforce', label: 'Salesforce', description: 'CRM & pipeline', glyph: { mono: 'Sf', bg: '#00A1E0' }, secretLabel: 'Access token', fields: [{ key: 'instanceUrl', label: 'Instance URL', placeholder: 'https://acme.my.salesforce.com' }] },
  { id: 'custom-rest', label: 'Custom REST', description: 'Any HTTP API', glyph: { mono: '{}', bg: '#2E9E5B' }, secretLabel: 'Auth token / API key', fields: CUSTOM_REST_FIELDS }
];

const MOCK_WORKERS: IntegrationWorker[] = [
  { id: 'michael', label: 'Michael (manager)' },
  { id: 'jim', label: 'Jim' },
  { id: 'pam', label: 'Pam' },
  { id: 'dwight', label: 'Dwight' }
];

let mockEntries: IntegrationEntry[] = [];
let mockSeq = 1;
// Secrets live only in this set's membership (presence), never their values —
// mirrors the broker boundary so the UI behaves identically once wired.
const mockHasSecret = new Set<string>();

function delay<T>(value: T): Promise<T> {
  return Promise.resolve(value);
}

/** Provisional probe: a secret that looks plausible "connects". */
function mockProbe(hasSecret: boolean): TestResult {
  return hasSecret
    ? { ok: true, message: 'Connected — authenticated (mock).' }
    : { ok: false, message: '401 — no secret set.' };
}

export const integrationsClient: IntegrationsClient = {
  listTemplates: () => delay(MOCK_TEMPLATES.map((t) => ({ ...t }))),
  listWorkers: () => delay(MOCK_WORKERS.map((w) => ({ ...w }))),
  list: () => delay(mockEntries.map((e) => ({ ...e, hasSecret: mockHasSecret.has(e.id) }))),
  save: (draft) => {
    const id = draft.id ?? `int-${mockSeq++}`;
    if (draft.secret && draft.secret.length > 0) mockHasSecret.add(id);
    const entry: IntegrationEntry = {
      id,
      label: draft.label,
      templateId: draft.templateId,
      fields: { ...draft.fields },
      hasSecret: mockHasSecret.has(id),
      workers: [...draft.workers],
      // Changing config invalidates a prior pass; force a re-test.
      status: 'untested'
    };
    const idx = mockEntries.findIndex((e) => e.id === id);
    if (idx >= 0) mockEntries[idx] = entry;
    else mockEntries.push(entry);
    return delay({ ...entry });
  },
  remove: (id) => {
    mockEntries = mockEntries.filter((e) => e.id !== id);
    mockHasSecret.delete(id);
    return delay(undefined);
  },
  test: (id) => {
    const entry = mockEntries.find((e) => e.id === id);
    if (!entry) return delay({ ok: false, message: 'No such integration.' });
    const res = mockProbe(mockHasSecret.has(id));
    entry.status = res.ok ? 'ok' : 'error';
    entry.lastTestedAt = 0; // stamped by the real broker; mock leaves 0
    return delay(res);
  },
  testDraft: (draft) => {
    // A draft "connects" if it already has a stored secret (edit) or the user
    // just typed one (add). The real broker runs a live read-only call.
    const had = draft.id ? mockHasSecret.has(draft.id) : false;
    const typed = !!(draft.secret && draft.secret.length > 0);
    return delay(mockProbe(had || typed));
  }
};

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
// SECURITY INVARIANT (must survive conformance): a secret value flows ONE WAY —
// from the form into save()/test() and onward to the broker. It is NEVER read
// back. `IntegrationEntry` carries `hasSecret: boolean` (presence only); there
// is no field that could carry the secret value back to the renderer.

/** A non-secret field a template asks the user to fill in. */
export interface IntegrationFieldSpec {
  key: string;
  label: string;
  placeholder?: string;
  optional?: boolean;
}

/** A kind/template of integration (authored by Dwight; served by the registry). */
export interface IntegrationTemplate {
  /** Stable kind id, e.g. 'slack', 'github', 'generic-http'. */
  id: string;
  label: string;
  description?: string;
  /** Human label for the one secret this kind needs, e.g. 'Bot token'. */
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
  test(id: string): Promise<TestResult>;
}

// ---------------------------------------------------------------------------
// PROVISIONAL in-memory mock. Replaced wholesale when Jim's IPC lands:
//   listTemplates() -> window.cth.integrationsTemplates()
//   listWorkers()   -> derive from the agent roster / window.cth.hiveRegistry()
//   list()          -> window.cth.integrationsList()
//   save(draft)     -> window.cth.integrationsSave(draft)   (secret -> broker)
//   remove(id)      -> window.cth.integrationsRemove(id)
//   test(id)        -> window.cth.integrationsTest(id)
// ---------------------------------------------------------------------------

const MOCK_TEMPLATES: IntegrationTemplate[] = [
  {
    id: 'generic-http',
    label: 'HTTP API',
    description: 'A generic bearer-token HTTP endpoint.',
    secretLabel: 'API token',
    fields: [{ key: 'baseUrl', label: 'Base URL', placeholder: 'https://api.example.com' }]
  },
  {
    id: 'github',
    label: 'GitHub',
    description: 'Read/write GitHub via a personal access token.',
    secretLabel: 'Personal access token',
    fields: [{ key: 'org', label: 'Org / owner', placeholder: 'acme', optional: true }]
  },
  {
    id: 'slack',
    label: 'Slack',
    description: 'Post and read messages with a bot token.',
    secretLabel: 'Bot token',
    fields: [{ key: 'defaultChannel', label: 'Default channel id', placeholder: 'C0123…', optional: true }]
  }
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
    const ok = mockHasSecret.has(id);
    entry.status = ok ? 'ok' : 'error';
    entry.lastTestedAt = 0; // stamped by the real broker; mock leaves 0
    return delay({
      ok,
      message: ok ? 'Connection OK (mock).' : 'No secret set — add one to connect.'
    });
  }
};

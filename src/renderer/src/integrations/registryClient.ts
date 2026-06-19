// Integrations registry client — the renderer's single doorway to the
// integrations registry + secret broker.
//
// CONFORMED to Jim's spec v1 (hive/docs/integrations-spec.md): the types are the
// CANONICAL ones from `@shared/integrations` (Jim's src/shared/integrations.ts),
// and the client maps 1:1 to the §6 IPC surface — whose handlers already exist in
// src/main/index.ts (integrations:list / templates / upsert / setSecret / remove /
// test). The real path calls window.cth.* (Jim's preload bridge).
//
// ⚠️ The preload bridge is NOT landed yet (Jim owns it — god relays when it's in).
// Until then this falls back to an in-memory mock so the UI is fully usable in dev.
// The real path is FEATURE-DETECTED: the moment Jim's preload methods appear it
// activates with NO change here. Two coordination notes:
//   1. The bridge method NAMES below (integrationsList, …) follow the existing
//      preload camelCase→colon-channel convention (getConfig→'config:get', etc.).
//      Jim: expose exactly these (or tell me the names) so the detect matches.
//   2. The catalog served by `integrations:templates` is Jim's `INTEGRATION_TEMPLATES`
//      (the 2 v1 reference templates). Dwight's richer src/shared/integrationTemplates.ts
//      is a SEPARATE, currently-unwired file — reconciliation is a god/Jim/Dwight call.
//
// SECURITY INVARIANT (matches §2): a secret value flows ONE WAY — from the form
// into save()'s setSecret call and onward to the encrypted store. It is NEVER read
// back. list() returns records with secretRef redacted to hasSecret:boolean.

import {
  INTEGRATION_TEMPLATES,
  authTypeNeedsSecret,
  secretRefFor,
  validateIntegrationRecord,
  type IntegrationRecord,
  type IntegrationTemplate
} from '@shared/integrations';

export type { IntegrationRecord, IntegrationTemplate } from '@shared/integrations';
export type { IntegrationKind, IntegrationAuthType } from '@shared/integrations';

/** The renderer-visible record: secretRef is redacted to a presence boolean.
 *  Matches main `integrations.listRecordsRedacted()`. */
export type IntegrationRecordView = Omit<IntegrationRecord, 'secretRef'> & { hasSecret: boolean };

/** Result of a §6 `integrations:test` probe. */
export interface TestResult {
  ok: boolean;
  status?: number;
  error?: string;
}

type UpsertResult = { ok: true; record: IntegrationRecord } | { ok: false; error: string };

export interface IntegrationsClient {
  listTemplates(): Promise<IntegrationTemplate[]>;
  list(): Promise<IntegrationRecordView[]>;
  /** §6 upsert (metadata, no secret) + §6 setSecret when a new secret was typed. */
  save(record: IntegrationRecord, secret?: string): Promise<{ ok: boolean; error?: string }>;
  remove(id: string): Promise<{ ok: boolean }>;
  test(id: string): Promise<TestResult>;
}

// The preload bridge Jim exposes (Deliverable 2). Channels are fixed by §6;
// accessed via a tolerant cast so this compiles before the bridge exists.
interface IntegrationsBridge {
  integrationsList(): Promise<IntegrationRecordView[]>;
  integrationsTemplates(): Promise<IntegrationTemplate[]>;
  integrationsUpsert(record: IntegrationRecord): Promise<UpsertResult>;
  integrationsSetSecret(req: { id: string; secret: string }): Promise<{ ok: boolean; error?: string }>;
  integrationsRemove(req: { id: string }): Promise<{ ok: boolean }>;
  integrationsTest(req: { id: string; path?: string }): Promise<TestResult>;
}

function liveBridge(): IntegrationsBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const b = (window as unknown as { cth?: Partial<IntegrationsBridge> }).cth;
  return b && typeof b.integrationsList === 'function' ? (b as IntegrationsBridge) : undefined;
}

// ───────────────────────── PROVISIONAL mock (dev fallback only) ─────────────────────────
// Serves Jim's canonical INTEGRATION_TEMPLATES and validates upserts with Jim's
// real validateIntegrationRecord, so the mock behaves like the wired backend.

let mockRecords: IntegrationRecord[] = [];
const mockSecret = new Set<string>(); // secretRef membership only — never values

function redact(r: IntegrationRecord): IntegrationRecordView {
  const { secretRef, ...rest } = r;
  return { ...rest, hasSecret: !!secretRef && mockSecret.has(secretRef) };
}

const mockClient: IntegrationsClient = {
  listTemplates: () => Promise.resolve(INTEGRATION_TEMPLATES.map((t) => ({ ...t }))),
  list: () => Promise.resolve(mockRecords.map(redact)),
  save: (record, secret) => {
    const v = validateIntegrationRecord(record);
    if (!v.ok) return Promise.resolve({ ok: false, error: v.error });
    const now = Date.now();
    const prev = mockRecords.find((r) => r.id === v.value.id);
    const full: IntegrationRecord = { ...v.value, createdAt: prev?.createdAt ?? now, updatedAt: now };
    if (prev) mockRecords = mockRecords.map((r) => (r.id === full.id ? full : r));
    else mockRecords.push(full);
    if (secret && secret.length > 0 && full.secretRef) mockSecret.add(full.secretRef);
    return Promise.resolve({ ok: true });
  },
  remove: (id) => {
    const r = mockRecords.find((x) => x.id === id);
    if (r?.secretRef) mockSecret.delete(r.secretRef);
    mockRecords = mockRecords.filter((x) => x.id !== id);
    return Promise.resolve({ ok: true });
  },
  test: (id) => {
    const r = mockRecords.find((x) => x.id === id);
    if (!r) return Promise.resolve({ ok: false, error: 'unknown integration' });
    if (!r.enabled) return Promise.resolve({ ok: false, error: 'integration is disabled' });
    if (authTypeNeedsSecret(r.authType) && !(r.secretRef && mockSecret.has(r.secretRef))) {
      return Promise.resolve({ ok: false, status: 503, error: 'no secret set' });
    }
    return Promise.resolve({ ok: true, status: 200 });
  }
};

// ───────────────────────── exported client (real → mock fallback) ─────────────────────────

export const integrationsClient: IntegrationsClient = {
  listTemplates: () => {
    const b = liveBridge();
    return b ? b.integrationsTemplates() : mockClient.listTemplates();
  },
  list: () => {
    const b = liveBridge();
    return b ? b.integrationsList() : mockClient.list();
  },
  save: async (record, secret) => {
    const b = liveBridge();
    if (!b) return mockClient.save(record, secret);
    const up = await b.integrationsUpsert(record);
    if (!up.ok) return { ok: false, error: up.error };
    if (secret && secret.length > 0) {
      const ss = await b.integrationsSetSecret({ id: record.id, secret });
      if (!ss.ok) return { ok: false, error: ss.error };
    }
    return { ok: true };
  },
  remove: (id) => {
    const b = liveBridge();
    return b ? b.integrationsRemove({ id }) : mockClient.remove(id);
  },
  test: (id) => {
    const b = liveBridge();
    return b ? b.integrationsTest({ id }) : mockClient.test(id);
  }
};

// ───────────────────────── small UI helper ─────────────────────────

/** Best-effort slug from a label (server-side validateIntegrationRecord is authoritative). */
export function slugify(label: string): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
  return base.length >= 2 ? base : `${base || 'api'}-x`;
}

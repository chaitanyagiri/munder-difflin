/**
 * TRIGGERS — every way the God orchestrator gets woken up without a human typing.
 *
 * This module is the single contract shared by main, preload and renderer. Four
 * trigger types live under one roof:
 *
 *   schedules  — recurring dispatched missions (the pre-existing `ScheduledMission`;
 *                still owned by config.missions, surfaced under Triggers)
 *   context    — auto-compaction / auto-clearing of agent terminal context
 *   webhook    — inbound HTTP from arbitrary callers, one entry per endpoint
 *   org        — inbound peer messages from teammates' clone nodes (UI only for now)
 *
 * The webhook and org types both admit an outside party, so both share one
 * `TriggerMode` gate and both write to one `TriggerHistoryEntry` ledger.
 */

/* ────────────────────────────── behaviour gate ───────────────────────────── */

/**
 * How much an external sender is trusted.
 *
 *   strict              — every inbound message waits for the operator's approval.
 *   allow-all           — everything flows straight through: messages, directives
 *                         and communication alike.
 *   communication-only  — informational traffic flows; anything that asks the hive
 *                         to *act* (a directive) waits for approval.
 */
export type TriggerMode = 'strict' | 'allow-all' | 'communication-only';

export const TRIGGER_MODES: { value: TriggerMode; label: string; blurb: string }[] = [
  { value: 'strict', label: 'strict', blurb: 'Ask me before anything reaches the hive.' },
  { value: 'allow-all', label: 'allow all', blurb: 'Messages, directives and communication all flow.' },
  { value: 'communication-only', label: 'communication only', blurb: 'Chatter flows; directives need my approval.' }
];

export const DEFAULT_TRIGGER_MODE: TriggerMode = 'strict';

/**
 * What an inbound message is asking for. A *directive* wants the hive to do work;
 * *communication* is informational (a status question, an FYI, a reply).
 * Senders may declare it; `classifyInboundKind` guesses when they don't.
 */
export type InboundKind = 'directive' | 'communication';

/** Resolve a mode + kind into whether the message may be routed without a human. */
export function isAutoAllowed(mode: TriggerMode, kind: InboundKind): boolean {
  if (mode === 'allow-all') return true;
  if (mode === 'communication-only') return kind === 'communication';
  return false; // strict
}

/**
 * Best-effort guess at intent when the payload doesn't declare `kind`.
 *
 * Deliberately conservative: anything we aren't confident is chatter is treated as
 * a directive, because mis-labelling a directive as communication is what lets
 * unapproved work through in `communication-only` mode. Callers who care should
 * send an explicit `kind`.
 */
export function classifyInboundKind(text: string): InboundKind {
  const t = text.trim().toLowerCase();
  if (!t) return 'communication';
  // A leading question with no imperative reads as someone asking, not tasking.
  const asksOnly = /^(what|how|when|where|who|why|is|are|do|does|did|can|could|status|any)\b/.test(t)
    && t.endsWith('?')
    && !/\b(fix|build|ship|deploy|run|write|create|add|remove|delete|refactor|implement|update|merge|revert)\b/.test(t);
  return asksOnly ? 'communication' : 'directive';
}

/* ──────────────────────────── context trigger ────────────────────────────── */

/**
 * One half of the context trigger (compact, or clear). Both the *message* sent to
 * the agent and the *conditions* that fire it are user-editable — that is the whole
 * point of surfacing this as a trigger rather than leaving it hardcoded.
 *
 * A run fires for an agent when BOTH conditions hold:
 *   - at least `everyMs` has elapsed since the last run, and
 *   - that agent's context is at least `minContextPct` full.
 * `minContextPct` of 0 disables the pressure gate (time alone fires it).
 */
export interface ContextRule {
  enabled: boolean;
  /** Minimum wall-clock gap between runs. */
  everyMs: number;
  /** Percent (0-100) of the context window that must be used before firing. */
  minContextPct: number;
  /**
   * Separate, lower bar for very large context windows (~1M tokens), where a
   * smaller *fraction* is still an enormous absolute amount of text.
   */
  minContextPctLargeWindow: number;
  /**
   * For `compact`: extra focus text appended to the provider's compaction command,
   * on the providers that read trailing text (codex and opencode ignore it, so it
   * is dropped for them rather than typed as stray input).
   *
   * For `clear`: a literal command that OVERRIDES the provider's own clear verb.
   * That override doubles as the escape hatch for providers we deliberately map to
   * nothing — Crush (palette-only), Copilot (print mode), and custom binaries —
   * where the operator knows their CLI and we don't.
   *
   * Empty string = send the provider's bare command.
   */
  message: string;
}

export interface ContextTriggerConfig {
  compact: ContextRule;
  clear: ContextRule;
}

/**
 * The focus text that has always ridden along with `/compact`. Preserved verbatim
 * as the default so upgrading users see no behaviour change beyond the cadence.
 */
export const DEFAULT_COMPACTION_FOCUS =
  'Keep the current task, recent decisions, open questions, and file paths in play. Drop resolved tangents.';

/**
 * Defaults are deliberately TWICE the old cadence and TWICE the previously
 * documented pressure bar.
 *
 * History: `main/config.ts` documented a 30% / 20% context gate that was never
 * actually implemented — every live agent got compacted on every tick, hourly.
 * This makes the gate real and sets it at 2x, so compaction now costs an agent
 * half as many interruptions.
 *
 * Auto-clear ships DISABLED. `/clear` is destructive — it discards context rather
 * than summarising it, and the codebase already gates the manual verb behind a
 * spoken confirm word. Turning it on is an explicit operator choice.
 */
export const DEFAULT_CONTEXT_TRIGGER: ContextTriggerConfig = {
  compact: {
    enabled: true,
    everyMs: 7_200_000, // 2h — was 1h
    minContextPct: 60, // was a documented-but-unenforced 30
    minContextPctLargeWindow: 40, // was a documented-but-unenforced 20
    message: DEFAULT_COMPACTION_FOCUS
  },
  clear: {
    enabled: false,
    everyMs: 7_200_000,
    minContextPct: 90,
    minContextPctLargeWindow: 80,
    message: ''
  }
};

/* ──────────────────────────── webhook triggers ───────────────────────────── */

/**
 * One inbound endpoint. Several may exist at once; they are multiplexed over a
 * single HTTP server + tunnel and told apart by the `id` in the request path, so
 * adding a webhook costs no extra port and no extra tunnel.
 *
 * `secret` is per-endpoint: revoking one caller never disturbs the others.
 */
export interface WebhookTrigger {
  id: string;
  name: string;
  /** Shared secret the caller echoes in `x-md-webhook-secret`. Never logged. */
  secret: string;
  enabled: boolean;
  mode: TriggerMode;
  /** User-editable JSON Schema (serialised) that inbound bodies are checked against. */
  schema: string;
  createdAt: number;
}

/**
 * The default contract for an inbound POST. Users may edit this per webhook to
 * match whatever the calling system already emits; `message` is the only field the
 * router truly needs.
 */
export const DEFAULT_WEBHOOK_SCHEMA_OBJECT = {
  type: 'object',
  required: ['message'],
  properties: {
    message: { type: 'string', description: 'What you want the orchestrator to know or do.' },
    title: { type: 'string', description: 'Short label for the kanban card.' },
    kind: {
      type: 'string',
      enum: ['directive', 'communication'],
      description: 'directive = asks the hive to act; communication = informational.'
    },
    from: { type: 'string', description: 'Who is sending, for the trigger history.' }
  }
} as const;

export const DEFAULT_WEBHOOK_SCHEMA = JSON.stringify(DEFAULT_WEBHOOK_SCHEMA_OBJECT, null, 2);

/* ────────────────────────── organisation trigger ─────────────────────────── */

/**
 * Peer-to-peer messaging between teammates' installs. Each teammate runs their own
 * Munder Difflin; setting an org key lets their instance address yours.
 *
 * UI + persistence only for now — the transport service does not exist yet, so
 * nothing reads `apiKey` beyond the settings surfaces that display it.
 */
export interface OrgTriggerConfig {
  apiKey: string;
  enabled: boolean;
  mode: TriggerMode;
}

export const DEFAULT_ORG_TRIGGER: OrgTriggerConfig = {
  apiKey: '',
  enabled: false,
  mode: DEFAULT_TRIGGER_MODE
};

/** Copy shown under the org key field. Kept here so Settings and Triggers agree. */
export const CLONE_NODE_BLURB =
  'Set an organisation key and your teammates can message your clone node — the copy of '
  + 'Munder Difflin running on your machine. Each teammate runs their own, so an org key '
  + 'is how two installs find each other.';

/* ──────────────────────────── trigger history ────────────────────────────── */

/**
 * One line in the ledger. Both directions are recorded so the operator can read a
 * conversation as a conversation: what they sent us, and what we said back.
 * `correlationId` ties our outbound reply to the inbound that prompted it.
 */
export interface TriggerHistoryEntry {
  id: string;
  source: 'webhook' | 'org';
  /** Which webhook (or which peer) — `WebhookTrigger.id` for webhooks. */
  sourceId: string;
  /** Display name at the time of the event, so history survives a rename/delete. */
  sourceName: string;
  direction: 'inbound' | 'outbound';
  /** The other party: who sent it to us, or who we sent it to. */
  peer: string;
  title?: string;
  /** Full message body — never truncated at rest; the UI decides how much to show. */
  body: string;
  kind: InboundKind;
  decision?: 'auto-allowed' | 'pending' | 'approved' | 'rejected';
  correlationId?: string;
  taskId?: string;
  at: number;
}

/** Ledger cap. Oldest entries are dropped past this so the file can't grow forever. */
export const TRIGGER_HISTORY_LIMIT = 500;

/* ───────────────────────── minimal schema validation ─────────────────────── */

/**
 * A deliberately small JSON-Schema subset checker — `type`, `required`,
 * `properties`, `enum`. The project has no validation dependency and inbound
 * webhook bodies do not justify adding one; anything this doesn't understand is
 * ignored rather than treated as a failure, so an exotic user schema degrades to
 * "accept" instead of locking the caller out of their own endpoint.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: unknown
): { ok: true } | { ok: false; error: string } {
  if (!schema || typeof schema !== 'object') return { ok: true };
  const s = schema as Record<string, unknown>;

  const expected = typeof s.type === 'string' ? s.type : undefined;
  if (expected && !matchesType(value, expected)) {
    return { ok: false, error: `expected ${expected}` };
  }

  if (Array.isArray(s.enum) && !s.enum.some((e) => e === value)) {
    return { ok: false, error: `must be one of ${s.enum.map((e) => String(e)).join(', ')}` };
  }

  if (expected === 'object' || (!expected && isPlainObject(value))) {
    if (!isPlainObject(value)) return { ok: false, error: 'expected object' };
    for (const key of Array.isArray(s.required) ? s.required : []) {
      if (typeof key !== 'string') continue;
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined || v === null || v === '') return { ok: false, error: `${key} required` };
    }
    const props = isPlainObject(s.properties) ? s.properties : {};
    for (const [key, sub] of Object.entries(props)) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue; // absent optionals are fine; `required` covers the rest
      const r = validateAgainstSchema(v, sub);
      if (!r.ok) return { ok: false, error: `${key}: ${r.error}` };
    }
  }

  return { ok: true };
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return isPlainObject(value);
    case 'null': return value === null;
    default: return true; // unknown type keyword — don't fail the caller over it
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

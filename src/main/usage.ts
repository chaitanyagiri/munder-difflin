/**
 * Usage telemetry seam (Lane A #6.6 — Seam 1, the LOCKED contract with Oscar/#7).
 *
 * The circuit breaker (breaker.ts) and the durable cost ledger (hive.ts
 * appendCostLedger) consume usage ONLY through the `UsageProvider` interface —
 * they never read transcripts, never compute tokens, and never recompute `usd`.
 * That keeps a single source of truth for cost and lets the backend swap with
 * zero changes to the consumers:
 *
 *   - PRIMARY (pull): `getAgentUsage(agentId)` — both backends implement it
 *     identically, so consumer code is swap-stable.
 *   - ADDITIVE (push): `onAgentUsage(cb)` — OTel-backend only, a later
 *     zero-rewrite latency upgrade. The stub does not implement it.
 *
 * Two invariants every consumer must honor (Oscar's 7A.1 spike findings):
 *   (i)  Samples are CUMULATIVE snapshots (monotonic running totals). Velocity is
 *        the DIFF of consecutive pulls (Δusd/Δt, Δoutput/Δt) — never treat a
 *        single sample as an increment.
 *   (ii) `model` arrives normalized (base id, any `[1m]` suffix stripped).
 *
 * `StubUsageProvider` is a thin INTERIM backend so Lane A isn't blocked on Lane C:
 * it wraps the existing transcript reader (readAgentUsage) — the same interim
 * "transcript-poll" backend Oscar owns and will evolve, then replace with the
 * native-OTel collector. At integration we drop in Oscar's module; breaker.ts and
 * the ledger are untouched. The stub's `usd` is the transcript fallback estimate
 * (and inherits the known Sonnet-hardcoded pricing limitation, which Oscar fixes
 * in exactly one place — his provider); it is NOT recomputed downstream.
 */
import { readAgentUsage } from './transcript';

/** One cumulative usage snapshot for an agent. The identical row that Oscar
 *  emits, Jim (this lane) persists to cost-ledger.jsonl, and Kevin (#4) stores
 *  in the cost_ledger SQLite table — one shape across all three lanes.
 *
 *  🔒 PII-free by construction: the provider's normalize step allowlists only
 *  these fields and strips every identity attribute (user.email, account/uuid,
 *  organization.id, hashed user.id) BEFORE emitting. Persist ONLY this sample;
 *  never a raw OTel record. */
export interface AgentUsageSample {
  agentId: string;
  /** Doubles as the #6.6a --resume key AND the cost accounting/dedup key. */
  sessionId: string | null;
  ts: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** Normalized base model id (no `[1m]` suffix), or null if unknown. */
  model: string | null;
  /** Claude-precomputed cost (live path) / transcript-fallback estimate (interim).
   *  Never recomputed by a consumer. */
  usd: number;
}

/** The seam both backends implement. */
export interface UsageProvider {
  /** PRIMARY pull. Returns a cumulative snapshot, or null when unknown. */
  getAgentUsage(agentId: string): AgentUsageSample | null;
  /** ADDITIVE push (OTel backend only). Optional; the stub omits it. */
  onAgentUsage?(cb: (sample: AgentUsageSample) => void): () => void;
}

/** What the stub needs to turn an agentId into a transcript read + sample fields.
 *  Wired (in index.ts) to the hive registry: cwd for the transcript dir,
 *  sessionId for the resume/dedup key, model for the (best-effort) tier. */
export interface UsageResolver {
  (agentId: string): { cwd: string; sessionId?: string | null; model?: string | null } | null;
}

/** Strip the `[1m]` (or `[…]`) context-window suffix so the model id matches the
 *  normalized form Oscar's OTel ingest emits. */
function normalizeModel(model: string | null | undefined): string | null {
  if (!model) return null;
  return model.replace(/\[[^\]]*\]$/, '').trim() || null;
}

/**
 * Interim transcript-backed provider. Reads cumulative token totals from an
 * agent's Claude Code transcripts (readAgentUsage) and shapes them into an
 * AgentUsageSample. Stands in for Oscar's provider until Lane C lands; the
 * consumers (breaker, ledger) call it through UsageProvider and never change.
 */
export class StubUsageProvider implements UsageProvider {
  constructor(private resolve: UsageResolver) {}

  getAgentUsage(agentId: string): AgentUsageSample | null {
    const info = this.resolve(agentId);
    if (!info) return null;
    const u = readAgentUsage(info.cwd); // cumulative running totals across transcripts
    return {
      agentId,
      sessionId: info.sessionId ?? null,
      ts: Date.now(),
      input: u.inputTokens,
      output: u.outputTokens,
      cacheRead: u.cacheReadTokens,
      cacheCreation: u.cacheWriteTokens,
      model: normalizeModel(info.model),
      usd: u.estimatedCostUsd // interim fallback estimate; Oscar's provider supplies Claude-precomputed usd
    };
  }
}

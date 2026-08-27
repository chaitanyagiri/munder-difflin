/**
 * TelemetryCollector — the live, first-party observability tap for the hive.
 *
 * Every spawned `claude` is launched with `CLAUDE_CODE_ENABLE_TELEMETRY=1` and
 * `OTEL_EXPORTER_OTLP_ENDPOINT` pointed here (see hive.ts `ensureAgent`). Claude
 * Code then PUSHES OpenTelemetry over plain OTLP/HTTP JSON to this embedded
 * collector — no protobuf, no external process, loopback only. We decode it into
 * two products:
 *
 *   1. The usage PROVIDER (the locked cross-lane seam) — `getAgentUsage(agentId)`
 *      (pull, primary) + `onAgentUsage(cb)` (push). Returns `AgentUsageSample`,
 *      a PII-free cumulative cost/token snapshot. Lane A's circuit breaker (#6)
 *      consumes this; the swap between the OTel backend and the transcript
 *      fallback is hidden here so the breaker never changes.
 *   2. An EPHEMERAL ring buffer of rich tool spans (`tool_result` durations +
 *      success) per agent, for the per-agent span waterfall (#7B.2).
 *
 * 🔒 PII: raw OTel records carry `user.email`, `user.account_id/uuid`,
 * `organization.id` and a hashed `user.id`. We read ONLY an allowlist of keys
 * ({agent.id, session.id, model, token type, cost, tool fields}) and never
 * persist a raw record — so everything this module emits is PII-free BY
 * CONSTRUCTION. Downstream durable stores (Lane A's cost-ledger, Lane B's
 * SQLite) inherit that guarantee and must never persist a raw record either.
 *
 * Transport posture mirrors `slack.ts`: the local handler bound to 127.0.0.1 is
 * the security boundary. Runs in the Electron main process; deliberately free of
 * any `electron` import so it can be smoke-tested as a plain Node module.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readAgentUsage } from './transcript';
import { normalizeModel } from './pricing';

// ─── The locked cross-lane contract (do not change without re-agreeing) ───────

/** A cumulative cost/token snapshot for one agent. The shared row consumed by
 *  Lane A's breaker (#6) and persisted by Lane A's cost-ledger / Lane B's SQLite
 *  (#4). PII-free by construction (see file header). `usd` is Claude's own
 *  per-model cost on the live path, the fallback estimate on the transcript
 *  path — never recomputed downstream. */
export interface AgentUsageSample {
  agentId: string;
  /** Dedup/accounting key — present on every OTel record; fixes the cwd
   *  double-count. Empty string on the transcript fallback when unknown. */
  sessionId: string;
  ts: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** Normalized model id (`claude-opus-4-8`, no `[1m]` suffix). */
  model: string;
  usd: number;
}

/** Breaker state, emitted by Lane A's policy on `control:breakerState` and
 *  consumed by this lane's avatar adapter (#5C) + cost meter. Defined here as
 *  the shared type so both lanes import one shape. */
export interface BreakerState {
  agentId: string;
  level: 'healthy' | 'steering' | 'constrained' | 'stopped';
  reason: string;
  ts: number;
}

// ─── Internal, lane-owned shapes ──────────────────────────────────────────────

/** A single tool invocation, for the per-agent span waterfall. Ephemeral — kept
 *  only in the in-memory ring buffer, never persisted. */
export interface ToolSpan {
  agentId: string;
  sessionId: string;
  ts: number;
  tool: string;
  success: boolean;
  durationMs: number;
  decision?: 'accept' | 'reject';
  error?: string;
}

/** The normalized event pushed to the renderer over `telemetry:event`. */
export type TelemetryEvent =
  | { kind: 'usage'; sample: AgentUsageSample }
  | { kind: 'tool_result'; span: ToolSpan }
  | { kind: 'api_error'; agentId: string; sessionId: string; ts: number; error: string };

/** Cold-start backfill returned by `snapshot()`. */
export interface TelemetrySnapshot {
  usage: AgentUsageSample[];
  spans: Record<string, ToolSpan[]>;
}

/** Per-session running accumulation (token.usage / cost.usage are DELTA +
 *  monotonic, so we sum each export rather than treating it as a total). */
interface SessionAccum {
  agentId: string;
  model: string;
  ts: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  usd: number;
}

const MAX_BODY_BYTES = 8 * 1024 * 1024; // OTLP batches are small; cap unauth peers.
const SPAN_RING_CAP = 200; // rich spans retained per agent for the waterfall.

export interface TelemetryCollectorOptions {
  /** Loopback host to bind. Defaults to 127.0.0.1 (the trust boundary). */
  host?: string;
  /** TCP port. Defaults to 0 → OS-assigned ephemeral port (avoids clashing with
   *  a user's own collector on 4318); the chosen port is read back from the
   *  bound socket and exposed via `endpoint()`. */
  port?: number;
  /** Sink for renderer-facing events (set to `webContents.send`). No-op in tests. */
  emit?: (channel: string, payload: unknown) => void;
  /** Resolve an agent's cwd (from the hive registry) for the transcript fallback. */
  resolveCwd?: (agentId: string) => string | null;
  /** Resolve an agent's CURRENT Claude Code session id (from the hive registry)
   *  for the transcript fallback (D11). Without this, the fallback can only
   *  fall back further to summing every `.jsonl` ever written in the agent's
   *  cwd — correct for a lone agent in its own directory, but a shared/reused
   *  cwd (the common case for hive workers) pulls in every other agent's and
   *  every past session's history too. */
  resolveSessionId?: (agentId: string) => string | undefined;
}

export class TelemetryCollector {
  private server: Server | null = null;
  private boundPort: number | null = null;
  private readonly host: string;
  private readonly port: number;
  private readonly emit?: (channel: string, payload: unknown) => void;
  private readonly resolveCwd?: (agentId: string) => string | null;
  private readonly resolveSessionId?: (agentId: string) => string | undefined;

  /** sessionId → running accumulation. */
  private readonly sessions = new Map<string, SessionAccum>();
  /** agentId → its sessionIds (lets getAgentUsage aggregate across --resume). */
  private readonly agentSessions = new Map<string, Set<string>>();
  /** agentId → ring buffer of recent tool spans. */
  private readonly spans = new Map<string, ToolSpan[]>();
  /** Push subscribers (Lane A breaker + dashboard). */
  private readonly usageSubs = new Set<(s: AgentUsageSample) => void>();
  /** api_error subscribers — feeds Lane A's breaker error-storm trip (#6), which
   *  has no input source of its own (hook payloads don't expose api errors). */
  private readonly apiErrorSubs = new Set<(agentId: string) => void>();

  constructor(opts: TelemetryCollectorOptions = {}) {
    this.host = opts.host ?? '127.0.0.1';
    this.port = opts.port ?? 0;
    this.emit = opts.emit;
    this.resolveCwd = opts.resolveCwd;
    this.resolveSessionId = opts.resolveSessionId;
  }

  /** Bind the loopback OTLP listener. The handler is live the instant this
   *  resolves; `endpoint()` then returns the URL to inject into agent env. */
  async start(): Promise<{ ok: boolean; endpoint?: string; error?: string }> {
    if (this.server) return { ok: true, endpoint: this.endpoint() ?? undefined };
    try {
      await this.listen();
      return { ok: true, endpoint: this.endpoint() ?? undefined };
    } catch (e) {
      this.stop();
      return { ok: false, error: errMsg(e) };
    }
  }

  /** Close the listener. Idempotent and best-effort. Accumulated state is kept
   *  (it's ephemeral anyway) so a restart doesn't lose live agents' totals. */
  stop(): void {
    try { this.server?.close(); } catch { /* noop */ }
    this.server = null;
    this.boundPort = null;
  }

  /** The bound loopback URL agents export to, or null until started. */
  endpoint(): string | null {
    return this.boundPort ? `http://${this.host}:${this.boundPort}` : null;
  }

  // ─── The locked provider seam ──────────────────────────────────────────────

  /** Pull (contract primary). OTel-live aggregate preferred; transcript fallback
   *  when an agent has no live telemetry yet (e.g. spawned before the feature, or
   *  telemetry off). Returns null only when neither source has anything. */
  getAgentUsage(agentId: string): AgentUsageSample | null {
    const live = this.aggregateLive(agentId);
    if (live) return live;
    return this.transcriptFallback(agentId);
  }

  /** Push (additive, OTel-only). Fires the agent's fresh aggregate whenever new
   *  telemetry lands. Returns an unsubscribe fn. */
  onAgentUsage(cb: (s: AgentUsageSample) => void): () => void {
    this.usageSubs.add(cb);
    return () => this.usageSubs.delete(cb);
  }

  /** In-process api_error feed for Lane A's breaker (#6). At integration:
   *  `telemetry.onApiError((agentId) => breaker.recordError(agentId))`. Returns
   *  an unsubscribe fn. */
  onApiError(cb: (agentId: string) => void): () => void {
    this.apiErrorSubs.add(cb);
    return () => this.apiErrorSubs.delete(cb);
  }

  /** Drop an agent's live usage so a respawn starts with a fresh counter.
   *  Clears the in-memory accumulation only — the on-disk cost ledger and the
   *  transcript fallback are untouched, so lifetime spending still reports. The
   *  span ring goes too: it is keyed by agent id, so a replacement would
   *  otherwise inherit the dead agent's tool waterfall.
   *
   *  Known edge: metrics are delivered asynchronously, so a batch already in
   *  flight when the PTY dies can land after this call and recreate the dead
   *  session's entries. The window is milliseconds and the next teardown
   *  clears it, so it is left unguarded rather than carrying a tombstone. */
  forgetAgent(agentId: string): void {
    const sessionIds = this.agentSessions.get(agentId);
    if (sessionIds) {
      for (const sessionId of sessionIds) this.sessions.delete(sessionId);
    }
    this.agentSessions.delete(agentId);
    this.spans.delete(agentId);
  }

  /** Recent tool spans for the per-agent waterfall (#7B.2), oldest→newest. */
  getSpans(agentId: string): ToolSpan[] {
    return this.spans.get(agentId)?.slice() ?? [];
  }

  /** Everything the renderer needs on cold start (it missed the live pushes). */
  snapshot(): TelemetrySnapshot {
    const usage: AgentUsageSample[] = [];
    for (const agentId of this.agentSessions.keys()) {
      const s = this.aggregateLive(agentId);
      if (s) usage.push(s);
    }
    const spans: Record<string, ToolSpan[]> = {};
    for (const [agentId, ring] of this.spans) spans[agentId] = ring.slice();
    return { usage, spans };
  }

  // ─── HTTP plumbing (mirrors slack.ts) ──────────────────────────────────────

  private listen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => this.handleRequest(req, res));
      const onError = (e: Error): void => reject(e);
      server.once('error', onError);
      server.listen(this.port, this.host, () => {
        server.off('error', onError);
        const addr = server.address();
        this.boundPort = addr && typeof addr === 'object' ? addr.port : null;
        this.server = server;
        resolve();
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        res.writeHead(413); res.end();
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      const url = req.url ?? '';
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (url.includes('/v1/metrics')) this.ingestMetrics(body);
        else if (url.includes('/v1/logs')) this.ingestLogs(body);
      } catch { /* malformed batch — drop it, never throw into the socket */ }
      // OTLP success response is an empty JSON ExportServiceResponse.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    req.on('error', () => {
      if (aborted) return;
      try { res.writeHead(400); res.end(); } catch { /* socket gone */ }
    });
  }

  // ─── OTLP decode → normalize → accumulate ──────────────────────────────────

  private ingestMetrics(body: unknown): void {
    const root = body as { resourceMetrics?: ResourceMetrics[] };
    if (!Array.isArray(root?.resourceMetrics)) return;
    const touched = new Set<string>(); // agentIds with new data this batch
    for (const rm of root.resourceMetrics) {
      const resAttrs = flattenAttrs(rm.resource?.attributes);
      for (const sm of rm.scopeMetrics ?? []) {
        for (const metric of sm.metrics ?? []) {
          const points = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? [];
          for (const dp of points) {
            const attrs = flattenAttrs(dp.attributes);
            const agentId = str(attrs['agent.id']) || str(resAttrs['agent.id']);
            const sessionId = str(attrs['session.id']);
            if (!agentId || !sessionId) continue;
            const accum = this.session(agentId, sessionId);
            const model = normalizeModel(str(attrs['model']));
            if (model) accum.model = model;
            accum.ts = Date.now();
            const value = pointValue(dp);
            if (metric.name === 'claude_code.token.usage') {
              switch (str(attrs['type'])) {
                case 'input': accum.input += value; break;
                case 'output': accum.output += value; break;
                case 'cacheRead': accum.cacheRead += value; break;
                case 'cacheCreation': accum.cacheCreation += value; break;
              }
              touched.add(agentId);
            } else if (metric.name === 'claude_code.cost.usage') {
              accum.usd += value;
              touched.add(agentId);
            }
          }
        }
      }
    }
    for (const agentId of touched) this.publishUsage(agentId);
  }

  private ingestLogs(body: unknown): void {
    const root = body as { resourceLogs?: ResourceLogs[] };
    if (!Array.isArray(root?.resourceLogs)) return;
    for (const rl of root.resourceLogs) {
      const resAttrs = flattenAttrs(rl.resource?.attributes);
      for (const sl of rl.scopeLogs ?? []) {
        for (const lr of sl.logRecords ?? []) {
          const attrs = flattenAttrs(lr.attributes);
          const name = str(attrs['event.name']) || str(lr.body?.stringValue);
          const agentId = str(attrs['agent.id']) || str(resAttrs['agent.id']);
          const sessionId = str(attrs['session.id']);
          if (!agentId) continue;
          if (name === 'tool_result') {
            const span: ToolSpan = {
              agentId,
              sessionId,
              ts: Date.now(),
              tool: str(attrs['tool_name']) || 'tool',
              success: truthy(attrs['success']),
              durationMs: numAttr(attrs['duration_ms']),
              decision: undefined
            };
            this.pushSpan(span);
            this.emit?.('telemetry:event', { kind: 'tool_result', span } satisfies TelemetryEvent);
          } else if (name === 'tool_decision') {
            // Attach the accept/reject decision to the most recent span, and emit.
            const decision = str(attrs['decision']) === 'reject' ? 'reject' : 'accept';
            const ring = this.spans.get(agentId);
            if (ring?.length) ring[ring.length - 1].decision = decision;
          } else if (name === 'api_error' || (name && name.includes('error'))) {
            const error = str(attrs['error']) || str(attrs['message']) || name;
            for (const cb of this.apiErrorSubs) { try { cb(agentId); } catch { /* subscriber threw */ } }
            this.emit?.('telemetry:event', { kind: 'api_error', agentId, sessionId, ts: Date.now(), error } satisfies TelemetryEvent);
          }
        }
      }
    }
  }

  // ─── Accumulation helpers ──────────────────────────────────────────────────

  private session(agentId: string, sessionId: string): SessionAccum {
    let accum = this.sessions.get(sessionId);
    if (!accum) {
      accum = { agentId, model: '', ts: Date.now(), input: 0, output: 0, cacheRead: 0, cacheCreation: 0, usd: 0 };
      this.sessions.set(sessionId, accum);
    }
    let set = this.agentSessions.get(agentId);
    if (!set) { set = new Set(); this.agentSessions.set(agentId, set); }
    set.add(sessionId);
    return accum;
  }

  private pushSpan(span: ToolSpan): void {
    let ring = this.spans.get(span.agentId);
    if (!ring) { ring = []; this.spans.set(span.agentId, ring); }
    ring.push(span);
    if (ring.length > SPAN_RING_CAP) ring.splice(0, ring.length - SPAN_RING_CAP);
  }

  /** Sum an agent's live sessions into one cumulative sample (sessionId/model =
   *  the most recently active session). Null if the agent has no live data. */
  private aggregateLive(agentId: string): AgentUsageSample | null {
    const set = this.agentSessions.get(agentId);
    if (!set || set.size === 0) return null;
    const out: AgentUsageSample = {
      agentId, sessionId: '', ts: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, model: '', usd: 0
    };
    for (const sid of set) {
      const a = this.sessions.get(sid);
      if (!a) continue;
      out.input += a.input;
      out.output += a.output;
      out.cacheRead += a.cacheRead;
      out.cacheCreation += a.cacheCreation;
      out.usd += a.usd;
      if (a.ts >= out.ts) { out.ts = a.ts; out.sessionId = sid; out.model = a.model; }
    }
    return out;
  }

  /** D11: a cwd is routinely SHARED — every hive worker spawned against the same
   *  repo (isolation is best-effort and several call sites deliberately skip it)
   *  lands in the same `~/.claude/projects/<key>/` directory as every other
   *  agent that ever ran there, this app-run or a past one. Without a session
   *  filter, `readAgentUsage` sums ALL of it — confirmed live: a probe worker
   *  with zero LLM calls was reaped citing 143,369,766 tokens, which was in fact
   *  the shared project directory's entire history across other agents'
   *  sessions, not its own. So this fallback now filters to the agent's OWN
   *  current session id and, when that id isn't known yet (nothing has hooked
   *  in for this agent this run — the true zero-usage case for a just-spawned
   *  agent), reports "no data" rather than someone else's history. `sessionId`
   *  stays '' on the returned sample regardless — deliberately, so it keeps
   *  reading as "no live session" to the #56 cost-ledger dedup gate in
   *  index.ts (`if (sample?.sessionId) appendCostLedger(...)`); the resolved id
   *  is used only to filter the read, never surfaced as if it were live OTel. */
  private transcriptFallback(agentId: string): AgentUsageSample | null {
    const cwd = this.resolveCwd?.(agentId);
    if (!cwd) return null;
    const sessionId = this.resolveSessionId?.(agentId);
    if (!sessionId) return null;
    const u = readAgentUsage(cwd, { sessionId });
    if (!u.inputTokens && !u.outputTokens && !u.cacheReadTokens && !u.cacheWriteTokens) return null;
    return {
      agentId,
      sessionId: '',
      ts: Date.now(),
      input: u.inputTokens,
      output: u.outputTokens,
      cacheRead: u.cacheReadTokens,
      cacheCreation: u.cacheWriteTokens,
      model: u.model ?? '',
      usd: u.estimatedCostUsd
    };
  }

  private publishUsage(agentId: string): void {
    const sample = this.aggregateLive(agentId);
    if (!sample) return;
    for (const cb of this.usageSubs) { try { cb(sample); } catch { /* subscriber threw */ } }
    this.emit?.('telemetry:event', { kind: 'usage', sample } satisfies TelemetryEvent);
  }
}

// ─── OTLP/JSON attribute decoding ─────────────────────────────────────────────

interface OtelKV { key?: string; value?: OtelAnyValue }
interface OtelAnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
}
interface OtelDataPoint { attributes?: OtelKV[]; asInt?: string | number; asDouble?: number; timeUnixNano?: string }
interface OtelMetric { name?: string; sum?: { dataPoints?: OtelDataPoint[] }; gauge?: { dataPoints?: OtelDataPoint[] } }
interface ResourceMetrics { resource?: { attributes?: OtelKV[] }; scopeMetrics?: { metrics?: OtelMetric[] }[] }
interface OtelLogRecord { attributes?: OtelKV[]; body?: { stringValue?: string } }
interface ResourceLogs { resource?: { attributes?: OtelKV[] }; scopeLogs?: { logRecords?: OtelLogRecord[] }[] }

/** Allowlist of attribute keys we ever read — anything else (notably the PII:
 *  user.email, user.account_id/uuid, organization.id, user.id) is ignored, so
 *  nothing this module emits can carry identity. */
const ATTR_ALLOWLIST = new Set([
  'agent.id', 'agent.name', 'session.id', 'model', 'type',
  'tool_name', 'success', 'duration_ms', 'decision', 'event.name', 'error', 'message'
]);

/** Flatten an OTLP KeyValue[] to a plain object, keeping only allowlisted keys. */
function flattenAttrs(attrs: OtelKV[] | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!Array.isArray(attrs)) return out;
  for (const kv of attrs) {
    if (!kv?.key || !ATTR_ALLOWLIST.has(kv.key)) continue;
    const v = kv.value;
    if (!v) continue;
    if (typeof v.stringValue === 'string') out[kv.key] = v.stringValue;
    else if (v.intValue !== undefined) out[kv.key] = Number(v.intValue);
    else if (typeof v.doubleValue === 'number') out[kv.key] = v.doubleValue;
    else if (typeof v.boolValue === 'boolean') out[kv.key] = v.boolValue;
  }
  return out;
}

/** A metric data point's numeric value (int counters arrive as strings in JSON). */
function pointValue(dp: OtelDataPoint): number {
  if (dp.asInt !== undefined) return Number(dp.asInt) || 0;
  if (typeof dp.asDouble === 'number') return dp.asDouble;
  return 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}
function numAttr(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function truthy(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

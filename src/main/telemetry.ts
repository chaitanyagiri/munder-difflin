/**
 * TelemetryCollector —— 面向 hive 的实时、第一方可观测性数据入口。
 *
 * 每个派生的 `claude` 都以 `CLAUDE_CODE_ENABLE_TELEMETRY=1` 启动，并把
 * `OTEL_EXPORTER_OTLP_ENDPOINT` 指向这里（见 hive.ts `ensureAgent`）。Claude
 * Code 随后通过纯 OTLP/HTTP JSON 把 OpenTelemetry 数据 PUSH 到这个内嵌的
 * 收集器——无 protobuf、无外部进程、仅限回环。我们把它解码为两类产物：
 *
 *   1. 用量 PROVIDER（锁定的跨 lane 接缝）—— `getAgentUsage(agentId)`
 *      （拉取，主）+ `onAgentUsage(cb)`（推送）。返回 `AgentUsageSample`，
 *      一个无 PII 的累计成本/令牌快照。Lane A 的熔断器（#6）消费它；
 *      OTel 后端与转录回退之间的切换在此处隐藏，熔断器永远不会受影响。
 *   2. 每个 agent 的丰富工具跨度（`tool_result` 耗时 + 成功与否）的
 *      EPHEMERAL 环形缓冲区，用于按 agent 展示的跨度瀑布（#7B.2）。
 *
 * 🔒 PII：原始 OTel 记录携带 `user.email`、`user.account_id/uuid`、
 * `organization.id` 以及哈希后的 `user.id`。我们只读取一个允许列表中的键
 * （{agent.id, session.id, model, token type, cost, tool fields}），绝不
 * 持久化原始记录——因此本模块产出的任何内容在结构上就是无 PII 的。
 * 下游的持久化存储（Lane A 的成本账本、Lane B 的 SQLite）继承这一保证，
 * 也绝不能持久化任何原始记录。
 *
 * 传输姿态与 `slack.ts` 一致：绑定到 127.0.0.1 的本地处理器就是安全边界。
 * 运行于 Electron 主进程；刻意不引入任何 `electron` 导入，以便可以当作
 * 普通 Node 模块进行冒烟测试。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readAgentUsage } from './transcript';
import { normalizeModel } from './pricing';

// ─── 锁定的跨 lane 契约（未经重新协商不得修改） ─────────────────────────────

/** 某个 agent 的累计成本/令牌快照。这是 Lane A 熔断器（#6）消费、并由
 *  Lane A 成本账本 / Lane B SQLite（#4）持久化的共享行。按结构保证无 PII
 *  （见文件头）。`usd` 在实况路径上是 Claude 自己的按模型成本，在转录路径
 *  上是回退估算——下游绝不重算。 */
export interface AgentUsageSample {
  agentId: string;
  /** 去重/记账键——每条 OTel 记录都带；修复 cwd 重复计数。转录回退时
   *  若未知则为空字符串。 */
  sessionId: string;
  ts: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** 规范化后的模型 id（`claude-opus-4-8`，不带 `[1m]` 后缀）。 */
  model: string;
  usd: number;
}

/** 熔断器状态，由 Lane A 的策略在 `control:breakerState` 上发出，并由本 lane
 *  的 avatar 适配器（#5C）+ 成本计量器消费。在此定义为共享类型，使两个 lane
 *  都导入同一形状。 */
export interface BreakerState {
  agentId: string;
  level: 'healthy' | 'steering' | 'constrained' | 'stopped';
  reason: string;
  ts: number;
}

// ─── 内部、lane 自有的形状 ────────────────────────────────────────────────────

/** 单次工具调用，用于按 agent 的跨度瀑布。瞬时数据——仅保存在内存环形缓冲
 *  区中，绝不持久化。 */
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

/** 通过 `telemetry:event` 推送给渲染进程的规范化事件。 */
export type TelemetryEvent =
  | { kind: 'usage'; sample: AgentUsageSample }
  | { kind: 'tool_result'; span: ToolSpan }
  | { kind: 'api_error'; agentId: string; sessionId: string; ts: number; error: string };

/** 由 `snapshot()` 返回的冷启动回填。 */
export interface TelemetrySnapshot {
  usage: AgentUsageSample[];
  spans: Record<string, ToolSpan[]>;
}

/** 按会话的持续累计（token.usage / cost.usage 是 DELTA + 单调递增的，因此
 *  我们累加每次导出，而不是把它当作总量）。 */
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

const MAX_BODY_BYTES = 8 * 1024 * 1024; // OTLP 批次很小；限制未认证对等方。
const SPAN_RING_CAP = 200; // 每个 agent 在瀑布中保留的丰富跨度数。

export interface TelemetryCollectorOptions {
  /** 要绑定的回环主机。默认 127.0.0.1（信任边界）。 */
  host?: string;
  /** TCP 端口。默认 0 → 由 OS 分配临时端口（避免与用户自己在 4318 上的
   *  收集器冲突）；选定的端口会从已绑定的 socket 读回，并通过
   *  `endpoint()` 暴露。 */
  port?: number;
  /** 面向渲染进程的事件的接收端（设为 `webContents.send`）。测试中为 no-op。 */
  emit?: (channel: string, payload: unknown) => void;
  /** 解析某个 agent 的 cwd（来自 hive 注册表），用于转录回退。 */
  resolveCwd?: (agentId: string) => string | null;
  /** 解析某个 agent 当前的 Claude Code 会话 id（来自 hive 注册表），用于
   *  转录回退（D11）。没有它，回退只能进一步退化为对该 agent cwd 中写下的
   *  每个 `.jsonl` 求和——对独居其目录的单个 agent 是正确的，但对共享/复用
   *  的 cwd（hive worker 的常见情况）会把其他所有 agent 及所有历史会话
   *  一并纳入。 */
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

  /** sessionId → 持续累计。 */
  private readonly sessions = new Map<string, SessionAccum>();
  /** agentId → 其 sessionIds（让 getAgentUsage 能跨 `--resume` 聚合）。 */
  private readonly agentSessions = new Map<string, Set<string>>();
  /** agentId → 最近工具跨度的环形缓冲区。 */
  private readonly spans = new Map<string, ToolSpan[]>();
  /** 推送订阅者（Lane A 熔断器 + 仪表盘）。 */
  private readonly usageSubs = new Set<(s: AgentUsageSample) => void>();
  /** api_error 订阅者——为 Lane A 熔断器的错误风暴熔断（#6）供数，而它本身
   *  没有输入来源（hook 载荷不暴露 api 错误）。 */
  private readonly apiErrorSubs = new Set<(agentId: string) => void>();

  constructor(opts: TelemetryCollectorOptions = {}) {
    this.host = opts.host ?? '127.0.0.1';
    this.port = opts.port ?? 0;
    this.emit = opts.emit;
    this.resolveCwd = opts.resolveCwd;
    this.resolveSessionId = opts.resolveSessionId;
  }

  /** 绑定回环 OTLP 监听器。本方法 resolve 的瞬间处理器即已生效；
   *  `endpoint()` 随后返回要注入 agent 环境的 URL。 */
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

  /** 关闭监听器。幂等且尽力而为。累计状态会保留（反正也是瞬时的），
   *  这样重启不会丢失在线 agent 的总量。 */
  stop(): void {
    try { this.server?.close(); } catch { /* noop */ }
    this.server = null;
    this.boundPort = null;
  }

  /** agent 导出到的已绑定回环 URL，未启动时为 null。 */
  endpoint(): string | null {
    return this.boundPort ? `http://${this.host}:${this.boundPort}` : null;
  }

  // ─── 锁定的 provider 接缝 ──────────────────────────────────────────────────

  /** 拉取（契约主路径）。优先使用 OTel 实时聚合；当 agent 尚无实时遥测
   *  （例如在功能上线前派生，或遥测关闭）时使用转录回退。仅在两个来源都
   *  没有数据时才返回 null。 */
  getAgentUsage(agentId: string): AgentUsageSample | null {
    const live = this.aggregateLive(agentId);
    if (live) return live;
    return this.transcriptFallback(agentId);
  }

  /** 推送（附加式，仅 OTel）。每当新遥测落地时触发该 agent 的最新聚合。
   *  返回一个退订函数。 */
  onAgentUsage(cb: (s: AgentUsageSample) => void): () => void {
    this.usageSubs.add(cb);
    return () => this.usageSubs.delete(cb);
  }

  /** 供 Lane A 熔断器（#6）使用的进程内 api_error 馈送。集成时：
   *  `telemetry.onApiError((agentId) => breaker.recordError(agentId))`。
   *  返回一个退订函数。 */
  onApiError(cb: (agentId: string) => void): () => void {
    this.apiErrorSubs.add(cb);
    return () => this.apiErrorSubs.delete(cb);
  }

  /** 丢弃某 agent 的实时用量，以便重启后从全新计数开始。只清内存中的累计
   *  ——磁盘上的成本账本和转录回退都不受影响，因此终身支出仍会如实上报。
   *  跨度环形缓冲区也随之清空：它以 agent id 为键，否则替换者会继承已死
   *  agent 的工具瀑布。
   *
   *  已知边界：指标是异步投递的，因此 PTY 死亡时已在途中的批次可能在本
   *  调用之后落地并重建已死会话的条目。窗口只有几毫秒，且下一次拆除会将其
   *  清除，所以此处不做墓碑标记而是留之不管。 */
  forgetAgent(agentId: string): void {
    const sessionIds = this.agentSessions.get(agentId);
    if (sessionIds) {
      for (const sessionId of sessionIds) this.sessions.delete(sessionId);
    }
    this.agentSessions.delete(agentId);
    this.spans.delete(agentId);
  }

  /** 用于按 agent 瀑布（#7B.2）的最近工具跨度，按时间由旧到新排列。 */
  getSpans(agentId: string): ToolSpan[] {
    return this.spans.get(agentId)?.slice() ?? [];
  }

  /** 渲染进程冷启动时需要的一切（它错过了实时推送）。 */
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

  // ─── HTTP 管道（仿照 slack.ts） ────────────────────────────────────────────

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
      } catch { /* 畸形批次——丢弃，绝不把异常抛进 socket */ }
      // OTLP 成功响应是一个空的 JSON ExportServiceResponse。
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    req.on('error', () => {
      if (aborted) return;
      try { res.writeHead(400); res.end(); } catch { /* socket 已消失 */ }
    });
  }

  // ─── OTLP 解码 → 规范化 → 累计 ────────────────────────────────────────────

  private ingestMetrics(body: unknown): void {
    const root = body as { resourceMetrics?: ResourceMetrics[] };
    if (!Array.isArray(root?.resourceMetrics)) return;
    const touched = new Set<string>(); // 本批次中带有新数据的 agentId
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
            // 把 accept/reject 决定挂到最近的跨度上，并发出事件。
            const decision = str(attrs['decision']) === 'reject' ? 'reject' : 'accept';
            const ring = this.spans.get(agentId);
            if (ring?.length) ring[ring.length - 1].decision = decision;
          } else if (name === 'api_error' || (name && name.includes('error'))) {
            const error = str(attrs['error']) || str(attrs['message']) || name;
            for (const cb of this.apiErrorSubs) { try { cb(agentId); } catch { /* 订阅者抛错 */ } }
            this.emit?.('telemetry:event', { kind: 'api_error', agentId, sessionId, ts: Date.now(), error } satisfies TelemetryEvent);
          }
        }
      }
    }
  }

  // ─── 累计辅助函数 ─────────────────────────────────────────────────────────

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

  /** 把一个 agent 的实时会话汇总为一个累计样本（sessionId/model 取最近
   *  活跃的会话）。该 agent 没有实时数据时返回 null。 */
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

  /** D11：cwd 经常是 SHARED 的——每个针对同一 repo 派生的 hive worker
   *  （隔离是尽力而为，且多个调用点刻意跳过它）都会落入与其他所有曾在那里
   *  运行过的 agent（无论是本次运行还是过去运行）相同的
   *  `~/.claude/projects/<key>/` 目录。如果没有会话过滤，
   *  `readAgentUsage` 会把这一切全部累加——已实况确认：一个零 LLM 调用的
   *  探针 worker 被收割时引用了 143,369,766 个令牌，那其实是共享项目目录
   *  里其他 agent 各会话的整个历史，而非它自己的。因此该回退现在只过滤到
   *  agent 自己的当前会话 id，而当该 id 尚不可知时（本次运行还没有任何东西
   *  为该 agent 挂接——这正是刚派生 agent 真正的零用量情形），上报
   *  “无数据”而不是别人的历史。返回样本上的 `sessionId` 一律保持 ''——
   *  刻意如此，以便对 index.ts 中的 #56 成本账本去重闸门
   *  （`if (sample?.sessionId) appendCostLedger(...)`）始终读作“无在线会话”；
   *  解析出的 id 只用于过滤读取，绝不当作实时 OTel 外露。 */
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
    for (const cb of this.usageSubs) { try { cb(sample); } catch { /* 订阅者抛错 */ } }
    this.emit?.('telemetry:event', { kind: 'usage', sample } satisfies TelemetryEvent);
  }
}

// ─── OTLP/JSON 属性解码 ──────────────────────────────────────────────────────

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

/** 我们会读取的属性键允许列表——其余一切（尤其 PII：user.email、
 *  user.account_id/uuid、organization.id、user.id）都会被忽略，因此本模块
 *  产出的任何内容都无法携带身份信息。 */
const ATTR_ALLOWLIST = new Set([
  'agent.id', 'agent.name', 'session.id', 'model', 'type',
  'tool_name', 'success', 'duration_ms', 'decision', 'event.name', 'error', 'message'
]);

/** 把 OTLP KeyValue[] 展平为普通对象，只保留允许列表中的键。 */
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

/** 指标数据点的数值（整数计数器在 JSON 中会以字符串到达）。 */
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

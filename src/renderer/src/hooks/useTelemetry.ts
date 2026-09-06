import { useEffect, useRef, useState } from 'react';

/**
 * 实时遥测流 (#7B) 的渲染端消费方。
 *
 * 主进程采集器 (telemetry.ts) 通过 `telemetry:event` 推送规范化、去 PII 的
 * 事件，通过 `control:breakerState` 推送熔断器状态。这些 hooks 订阅并在
 * 冷启动快照上回填，再把数据整理成舰队网格 (`useFleetTelemetry`) 和单
 * agent 的 span 瀑布图 (`useAgentSpans`)。
 *
 * 类型镜像 src/main/telemetry.ts + src/preload 中 LOCKED 合约（手工同步，
 * 与代码库的本地重复声明模式保持一致）。
 */

export interface AgentUsageSample {
  agentId: string;
  sessionId: string;
  ts: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  model: string;
  usd: number;
}

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

export interface BreakerState {
  agentId: string;
  level: 'healthy' | 'steering' | 'constrained' | 'stopped';
  reason: string;
  ts: number;
}

type TelemetryEvent =
  | { kind: 'usage'; sample: AgentUsageSample }
  | { kind: 'tool_result'; span: ToolSpan }
  | { kind: 'api_error'; agentId: string; sessionId: string; ts: number; error: string };

/** 所有类型的 token 总和 —— 迷你走势图/速率的基础。 */
export function totalTokens(s: AgentUsageSample): number {
  return s.input + s.output + s.cacheRead + s.cacheCreation;
}

/** 新鲜 token 与缓存命中 token 的比例，以 0–1 的缓存占比表示。 */
export function cacheFraction(s: AgentUsageSample): number {
  const total = totalTokens(s);
  return total > 0 ? s.cacheRead / total : 0;
}

/** 每个 agent 的滚动 token 增量（供迷你走势图使用）外加简单的 tokens/min。 */
interface Rate {
  deltas: number[]; // 最近的前 N 次推送之间的 token 增量
  firstTs: number;
  firstTotal: number;
  lastTs: number;
  lastTotal: number;
}

const SPARK_LEN = 14;

export interface FleetTelemetry {
  samples: Record<string, AgentUsageSample>;
  /** 迷你走势图序列（各次推送间的 token 增量），由旧到新，按 agent 分组 */
  spark: Record<string, number[]>;
  /** tokens/min，按 agent 推导 */
  rate: Record<string, number>;
  /** 每个 agent 最近一次看到的工具名 */
  lastTool: Record<string, string>;
  /** 每个 agent 最新的熔断器状态（驱动成本表颜色与 ⚠ 标记） */
  breakers: Record<string, BreakerState>;
}

/**
 * 订阅整个舰队的实时遥测。单实例（舰队网格）。
 * 挂载时从快照回填，然后并入实时推送。
 */
export function useFleetTelemetry(): FleetTelemetry {
  const [samples, setSamples] = useState<Record<string, AgentUsageSample>>({});
  const [spark, setSpark] = useState<Record<string, number[]>>({});
  const [rate, setRate] = useState<Record<string, number>>({});
  const [lastTool, setLastTool] = useState<Record<string, string>>({});
  const [breakers, setBreakers] = useState<Record<string, BreakerState>>({});
  const rates = useRef<Record<string, Rate>>({});

  useEffect(() => {
    let alive = true;

    const foldUsage = (s: AgentUsageSample): void => {
      setSamples((prev) => ({ ...prev, [s.agentId]: s }));
      const total = totalTokens(s);
      const r = rates.current[s.agentId];
      if (!r) {
        rates.current[s.agentId] = { deltas: [], firstTs: s.ts, firstTotal: total, lastTs: s.ts, lastTotal: total };
      } else {
        const delta = Math.max(0, total - r.lastTotal);
        r.deltas = [...r.deltas, delta].slice(-SPARK_LEN);
        r.lastTs = s.ts;
        r.lastTotal = total;
        const minutes = Math.max(1 / 60, (r.lastTs - r.firstTs) / 60000);
        const perMin = (r.lastTotal - r.firstTotal) / minutes;
        setSpark((prev) => ({ ...prev, [s.agentId]: r.deltas }));
        setRate((prev) => ({ ...prev, [s.agentId]: perMin }));
      }
    };

    // 从快照回填（我们错过了挂载前的推送）。
    window.cth.telemetrySnapshot?.().then((snap) => {
      if (!alive || !snap) return;
      for (const s of snap.usage ?? []) foldUsage(s as AgentUsageSample);
      const tools: Record<string, string> = {};
      for (const [id, spans] of Object.entries(snap.spans ?? {})) {
        const arr = spans as ToolSpan[];
        if (arr.length) tools[id] = arr[arr.length - 1].tool;
      }
      setLastTool((prev) => ({ ...tools, ...prev }));
    }).catch(() => { /* 采集器未启动 —— 网格为空 */ });

    const offEvent = window.cth.onTelemetryEvent?.((e: TelemetryEvent) => {
      if (e.kind === 'usage') foldUsage(e.sample);
      else if (e.kind === 'tool_result') setLastTool((prev) => ({ ...prev, [e.span.agentId]: e.span.tool }));
    });
    const offBreaker = window.cth.onBreakerState?.((s: BreakerState) => {
      setBreakers((prev) => ({ ...prev, [s.agentId]: s }));
    });

    return () => { alive = false; offEvent?.(); offBreaker?.(); };
  }, []);

  return { samples, spark, rate, lastTool, breakers };
}

/**
 * 订阅单个 agent 的工具 span，供瀑布图使用。挂载/切换 agent 时从采集器
 * 回填，然后追加实时的 `tool_result` 推送。
 */
export function useAgentSpans(agentId: string): ToolSpan[] {
  const [spans, setSpans] = useState<ToolSpan[]>([]);

  useEffect(() => {
    let alive = true;
    setSpans([]);
    window.cth.telemetrySpans?.(agentId).then((s) => {
      if (alive && Array.isArray(s)) setSpans(s as ToolSpan[]);
    }).catch(() => { /* 尚无记录 */ });

    const off = window.cth.onTelemetryEvent?.((e: TelemetryEvent) => {
      if (e.kind === 'tool_result' && e.span.agentId === agentId) {
        setSpans((prev) => [...prev, e.span].slice(-200));
      } else if (e.kind === 'api_error' && e.agentId === agentId) {
        setSpans((prev) => [...prev, {
          agentId, sessionId: e.sessionId, ts: e.ts, tool: 'api_error',
          success: false, durationMs: 0, error: e.error
        }].slice(-200));
      }
    });
    return () => { alive = false; off?.(); };
  }, [agentId]);

  return spans;
}

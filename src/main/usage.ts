/**
 * 用量遥测接缝（Lane A #6.6 — Seam 1，与 Oscar/#7 的锁定契约）。
 *
 * 熔断器（breaker.ts）与持久成本账本（hive.ts appendCostLedger）只通过
 * `UsageProvider` 接口消费用量——它们从不读转录、从不计算 token、也从不
 * 重算 `usd`。这样成本只有唯一的事实来源，后端更换时消费者零改动：
 *
 *   - 主路径（拉取）：`getAgentUsage(agentId)` —— 两个后端实现完全一致，
 *     所以消费者代码可无缝切换。
 *   - 附加路径（推送）：`onAgentUsage(cb)` —— 仅 OTel 后端，是后续
 *     零重写的低延迟升级；桩实现不提供它。
 *
 * 每个消费者都必须遵守两条不变量（Oscar 的 7A.1 尖峰结论）：
 *   (i)  样本是累积快照（单调递增的运行总量）。速度是相邻两次拉取的差值
 *        （Δusd/Δt、Δoutput/Δt）——绝不要把单个样本当作增量。
 *   (ii) `model` 到达时已规范化（基础 id，任何 `[1m]` 后缀已去除）。
 *
 * `StubUsageProvider` 是一个轻量的临时后端，让 Lane A 不被 Lane C 阻塞：
 * 它包装现有转录读取器（readAgentUsage）——这正是 Oscar 拥有并会演进、
 * 之后替换为原生 OTel 采集器的同一个临时“转录轮询”后端。集成时我们直接
 * 换上 Oscar 的模块；breaker.ts 和账本都不动。桩的 `usd` 是转录回退估算值
 * （并继承了已知的 Sonnet 硬编码定价限制，Oscar 会在恰好一个地方——他的
 * provider 里修复）；下游绝不重算。
 */
import { readAgentUsage } from './transcript';

/** 一个代理的累积用量快照。与 Oscar 输出的行完全一致；Jim（本车道）将其
 *  持久化到 cost-ledger.jsonl，Kevin（#4）存入 cost_ledger SQLite 表——
 *  三条车道共用同一形态。
 *
 *  🔒 构造上无 PII：provider 的规范化步骤只放行这些字段，并在发出前剔除
 *  所有身份属性（user.email、account/uuid、organization.id、hashed user.id）。
 *  只持久化本样本；绝不保存原始 OTel 记录。 */
export interface AgentUsageSample {
  agentId: string;
  /** 兼作 #6.6a --resume 键 AND 成本核算/去重键。 */
  sessionId: string | null;
  ts: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** 规范化的基础模型 id（无 `[1m]` 后缀），未知时为 null。 */
  model: string | null;
  /** Claude 预先算好的成本（实时路径）/ 转录回退估算（临时路径）。
   *  消费者绝不重算。 */
  usd: number;
}

/** 两个后端都实现的接缝。 */
export interface UsageProvider {
  /** 主路径拉取。返回累积快照，未知时返回 null。 */
  getAgentUsage(agentId: string): AgentUsageSample | null;
  /** 附加路径推送（仅 OTel 后端）。可选；桩实现省略它。 */
  onAgentUsage?(cb: (sample: AgentUsageSample) => void): () => void;
}

/** 桩把 agentId 变成一次转录读取 + 样本字段所需的一切。
 *  在 index.ts 中接到 hive 注册表：cwd 用于转录目录、
 *  sessionId 用于恢复/去重键、model 用于（尽力而为的）档位。 */
export interface UsageResolver {
  (agentId: string): { cwd: string; sessionId?: string | null; model?: string | null } | null;
}

/** 去除 `[1m]`（或 `[…]`）上下文窗口后缀，让模型 id 与
 *  Oscar 的 OTel 摄取所输出的规范化形式一致。 */
function normalizeModel(model: string | null | undefined): string | null {
  if (!model) return null;
  return model.replace(/\[[^\]]*\]$/, '').trim() || null;
}

/**
 * 临时转录后端。从代理的 Claude Code 转录（readAgentUsage）读取累积 token
 * 总量，整理成 AgentUsageSample。在 Lane C 落地前暂代 Oscar 的 provider；
 * 消费者（breaker、ledger）通过 UsageProvider 调用它，从不改变。
 */
export class StubUsageProvider implements UsageProvider {
  constructor(private resolve: UsageResolver) {}

  getAgentUsage(agentId: string): AgentUsageSample | null {
    const info = this.resolve(agentId);
    if (!info) return null;
    const u = readAgentUsage(info.cwd); // 各转录之间的累积运行总量
    return {
      agentId,
      sessionId: info.sessionId ?? null,
      ts: Date.now(),
      input: u.inputTokens,
      output: u.outputTokens,
      cacheRead: u.cacheReadTokens,
      cacheCreation: u.cacheWriteTokens,
      model: normalizeModel(info.model),
      usd: u.estimatedCostUsd // 临时回退估算；Oscar 的 provider 提供 Claude 预先算好的 usd
    };
  }
}

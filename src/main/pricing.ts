/**
 * 仅回退用的模型 → 价格表（每百万 token 的美元价格）。
 *
 * 实时遥测路径并不使用此表。Claude Code 会在每条 `api_request` 日志上输出
 * 预先算好的、按模型的 `cost_usd`，并输出 `claude_code.cost.usage` 指标
 * （已由 7A.1 尖峰验证），因此采集器（`telemetry.ts`）信任 Claude 自己给出的
 * 数字。本表仅服务于离线转录核对器（`transcript.ts`）——它只在遥测关闭时运行，
 * 必须根据原始 token 计数估算成本。
 *
 * 它取代了原先硬编码在 `transcript.ts` 里的“所有人都是 Sonnet”常量
 * （成本 bug #1——Opus 被低估约 5 倍，Haiku 被高估）。现在价格按模型家族匹配。
 * 这是按模型定价唯一存在的地方；转录后端与采集器的回退逻辑都从这里导入。
 */

/** 一个模型家族每百万 token 的美元价格。 */
export interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheWritePerM: number;
}

// Anthropic 公开价格，每百万 token 的美元价格。为近似值，仅用于回退——
// 实时路径使用 Claude 自带的按模型成本，因此这里的偏差无害。
const OPUS: ModelPrice = { inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5, cacheWritePerM: 18.75 };
const SONNET: ModelPrice = { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 };
const HAIKU: ModelPrice = { inputPerM: 0.8, outputPerM: 4, cacheReadPerM: 0.08, cacheWritePerM: 1.0 };

/** 模型 id 未知时，假定为 Sonnet（历史默认值）。 */
const DEFAULT_PRICE: ModelPrice = SONNET;

/**
 * 去除 Claude Code 的变体后缀，让 `claude-opus-4-8[1m]`（`token.usage`
 * 指标携带的形式）和 `claude-opus-4-8`（`api_request` 日志携带的基础 id）
 * 解析到同一家族。保留大小写；匹配在 `priceFor` 中按不区分大小写进行。
 */
export function normalizeModel(model: string | undefined | null): string {
  return (model ?? '').trim().replace(/\[[^\]]*\]\s*$/, '');
}

/** 按家族将模型 id 解析到其价格行，回退到 Sonnet。 */
export function priceFor(model: string | undefined | null): ModelPrice {
  const m = normalizeModel(model).toLowerCase();
  if (m.includes('opus')) return OPUS;
  if (m.includes('haiku')) return HAIKU;
  if (m.includes('sonnet')) return SONNET;
  return DEFAULT_PRICE;
}

/** 成本估算器使用的 token 拆分（与 `AgentUsage` 的 token 字段一致）。 */
export interface TokenSplit {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * 使用模型的回退价格行，估算一个 token 拆分的美元成本。
 * 仅供转录核对器使用；实时路径信任 Claude 给出的成本。
 */
export function estimateCostUsd(model: string | undefined | null, tokens: TokenSplit): number {
  const p = priceFor(model);
  return (
    (tokens.inputTokens / 1_000_000) * p.inputPerM +
    (tokens.outputTokens / 1_000_000) * p.outputPerM +
    (tokens.cacheReadTokens / 1_000_000) * p.cacheReadPerM +
    (tokens.cacheWriteTokens / 1_000_000) * p.cacheWritePerM
  );
}

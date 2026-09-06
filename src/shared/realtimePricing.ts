/**
 * Realtime Michael — OpenAI gpt-realtime-2 语音循环的音频 token 定价
 * （卡 rt-9，cost-guard）。共享一份，这样主进程成本模块（src/main/
 * realtimeCost.ts）和渲染器成本 store（src/renderer/src/realtime/
 * costStore.ts）都从同一个来源定价。纯净且无依赖（无 electron、无
 * 仅主进程可用的导入），因此从任一进程导入都安全。
 *
 * 定价（锁定套餐/董事会）：gpt-realtime-2 的 AUDIO token 按每 1M
 * 输入 $32、每 1M 输出 $64 计费。语音轮次以音频为主；文本 token
 * （指令、工具参数）和缓存 token 更便宜。我们刻意把所有输入/输出
 * token 都按音频费率定价：对成本 GUARD 而言，保守的
 * 上界（UPPER bound）是安全之选（宁可提前告警也不低估），而且
 * 它只使用权威的音频数字，而不是猜测文本/缓存费率。原始 token 计数
 * 会与美元金额一并呈现，以便保持可审计。
 */

/**
 * Talk 连接的实时语音模型。它放在这里、放在 shared 中，是因为它既出现在
 * 面向用户的设置文案里，又被主进程的 mint 使用——跨进程边界重复的模型字符串，
 * 最终总有一份会与自己不一致，而用户读到的那一半
 * 正是没人会注意已经过期的那一半。`src/main/realtime.ts`
 * 把它作为自己的 REALTIME_MODEL 重新导出。
 */
export const REALTIME_MODEL = 'gpt-realtime-2.1';

/** 每 1,000,000 音频 token 的美元价格（gpt-realtime-2）。 */
export const REALTIME_AUDIO_INPUT_PER_MTOK = 32;
export const REALTIME_AUDIO_OUTPUT_PER_MTOK = 64;

/**
 * 实时会话报告的使用量增量。同时接受 SDK 的 camelCase（`inputTokens`）
 * 和实时 API 原生的 snake_case（`input_tokens`），
 * 这样调用方可以直接转发自己拥有的任何形态。
 */
export interface RealtimeUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

/** 从两种大小写中取出输入/输出 token 计数；缺失 ⇒ 0。 */
export function normalizeRealtimeUsage(u: RealtimeUsage | null | undefined): {
  inputTokens: number;
  outputTokens: number;
} {
  const n = (v: number | undefined): number => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0);
  return {
    inputTokens: n(u?.inputTokens) || n(u?.input_tokens),
    outputTokens: n(u?.outputTokens) || n(u?.output_tokens)
  };
}

/**
 * 一次实时使用增量的 USD 成本。保守上界：每个输入
 * token 按音频输入费率定价，每个输出 token 按
 * 音频输出费率定价（见文件头）。
 */
export function computeRealtimeUsd(u: RealtimeUsage | null | undefined): number {
  const { inputTokens, outputTokens } = normalizeRealtimeUsage(u);
  return (
    (inputTokens / 1_000_000) * REALTIME_AUDIO_INPUT_PER_MTOK +
    (outputTokens / 1_000_000) * REALTIME_AUDIO_OUTPUT_PER_MTOK
  );
}

/** 紧凑的美元格式化：< $1 显示分（例如 $0.42），否则两位小数（例如 $12.30）。 */
export function formatUsd(n: number): string {
  if (!isFinite(n) || n <= 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

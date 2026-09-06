/**
 * Realtime Michael —— 渲染端成本 store（卡片 rt-9，成本守卫）。
 *
 * 一个微型外部 store（与 session.ts 相同的 useSyncExternalStore 形态），
 * 跟踪当前语音会话的实时成本：累加用量增量、用共享音频费率计价，并暴露
 * 一个运行中的美元数字 + token 计数、一个可选的支出上限、以及一个供
 * 麦克风空闲时关闭的空闲信号。
 *
 * 全新且刻意不重叠：我拥有这个文件 + 读取它的 HUD。Kevin 的会话
 * （session.ts）通过两处单行调用喂给它（god 指派给他的集成点）：
 *   • connect() 时:            resetRealtimeCost()
 *   • 每个用量增量时:     recordRealtimeUsage(usage)
 * 并可读取 getRealtimeCostSnapshot()/isRealtimeIdle()/overCap 标志，以便
 * 在触顶或空闲后自动断开（麦克风关闭动作在会话里，这个 store 不拥有它）。
 */
import { useSyncExternalStore } from 'react';
import { computeRealtimeUsd, normalizeRealtimeUsage, type RealtimeUsage } from '@shared/realtimePricing';

export interface RealtimeCostState {
  /** 会话运行中的美元成本（保守上界——见 realtimePricing）。 */
  usd: number;
  inputTokens: number;
  outputTokens: number;
  /** 可选的美元支出上限；null = 无上限。 */
  capUsd: number | null;
  /** 一旦 usd >= capUsd（已设上限）即为 true。会话应警告 / 自动停止。 */
  overCap: boolean;
  /** 最后一次用量增量的 epoch 毫秒（作为最后一次语音活动的代理），或 null。 */
  lastActivityTs: number | null;
  /** 当前会话计量开始的 epoch 毫秒，关闭时为 null。 */
  startedTs: number | null;
}

const initial: RealtimeCostState = {
  usd: 0,
  inputTokens: 0,
  outputTokens: 0,
  capUsd: null,
  overCap: false,
  lastActivityTs: null,
  startedTs: null
};

let state: RealtimeCostState = { ...initial };
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}
function setState(patch: Partial<RealtimeCostState>): void {
  state = { ...state, ...patch };
  emit();
}
function recomputeOverCap(usd: number, capUsd: number | null): boolean {
  return capUsd != null && capUsd > 0 && usd >= capUsd;
}

/** 开始计量一个新会话（Kevin：从 session connect() 调用）。跨会话保留
 *  用户选择的上限；清零运行中的总计。 */
export function resetRealtimeCost(startedAtMs: number): void {
  setState({
    usd: 0,
    inputTokens: 0,
    outputTokens: 0,
    overCap: false,
    lastActivityTs: null,
    startedTs: startedAtMs
  });
}

/** 停止计量（会话关闭）。保持最终数值可见直到下次 reset。 */
export function endRealtimeCost(): void {
  setState({ startedTs: null });
}

/** 累加一次用量增量（Kevin：在每个 realtime 用量事件上调用）。 */
export function recordRealtimeUsage(usage: RealtimeUsage, nowMs: number): void {
  const { inputTokens, outputTokens } = normalizeRealtimeUsage(usage);
  if (inputTokens === 0 && outputTokens === 0) return;
  const usd = state.usd + computeRealtimeUsd(usage);
  setState({
    usd,
    inputTokens: state.inputTokens + inputTokens,
    outputTokens: state.outputTokens + outputTokens,
    overCap: recomputeOverCap(usd, state.capUsd),
    lastActivityTs: nowMs
  });
}

/** 设置（或用 null 清除）会话支出上限。 */
export function setRealtimeCap(capUsd: number | null): void {
  const cap = capUsd != null && capUsd > 0 ? capUsd : null;
  setState({ capUsd: cap, overCap: recomputeOverCap(state.usd, cap) });
}

/** 当会话活跃时，若超过 `thresholdMs` 没有新的用量增量到达则为 true——
 *  这是麦克风空闲关闭的提示（是否断开由会话决定）。 */
export function isRealtimeIdle(thresholdMs: number, nowMs: number): boolean {
  if (state.startedTs == null) return false;
  const since = state.lastActivityTs ?? state.startedTs;
  return nowMs - since >= thresholdMs;
}

export function getRealtimeCostSnapshot(): RealtimeCostState {
  return state;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 成本 HUD + 上限控件的 React 绑定。 */
export function useRealtimeCost(): RealtimeCostState & { setCap: (capUsd: number | null) => void } {
  const snap = useSyncExternalStore(subscribe, getRealtimeCostSnapshot);
  return { ...snap, setCap: setRealtimeCap };
}

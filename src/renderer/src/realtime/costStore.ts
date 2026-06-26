/**
 * Realtime Michael — renderer cost store (card rt-9, cost-guard).
 *
 * A tiny external store (same useSyncExternalStore shape as session.ts) that
 * tracks the LIVE cost of the current voice session: it accumulates usage deltas,
 * prices them via the shared audio rates, and exposes a running dollar figure +
 * token counts, an optional spend cap, and an idle signal for mic-off-when-idle.
 *
 * Net-new + disjoint by design: I own this file + the HUD that reads it. Kevin's
 * session (session.ts) feeds it through TWO one-line calls (the integration points
 * god assigned to him):
 *   • on connect():            resetRealtimeCost()
 *   • on each usage delta:     recordRealtimeUsage(usage)
 * and may read getRealtimeCostSnapshot()/isRealtimeIdle()/the overCap flag to
 * auto-disconnect on cap or after idle (the mic-off action lives in the session,
 * which this store does not own).
 */
import { useSyncExternalStore } from 'react';
import { computeRealtimeUsd, normalizeRealtimeUsage, type RealtimeUsage } from '@shared/realtimePricing';

export interface RealtimeCostState {
  /** Running session cost in USD (conservative upper bound — see realtimePricing). */
  usd: number;
  inputTokens: number;
  outputTokens: number;
  /** Optional spend cap in USD; null = no cap. */
  capUsd: number | null;
  /** True once usd >= capUsd (cap set). The session should warn / auto-stop. */
  overCap: boolean;
  /** Epoch ms of the last usage delta (proxy for last voice activity), or null. */
  lastActivityTs: number | null;
  /** Epoch ms the current session's metering began, or null when off. */
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

/** Begin metering a fresh session (Kevin: call from session connect()). Preserves
 *  the user's chosen cap across sessions; zeroes the running totals. */
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

/** Stop metering (session off). Keeps the final figure visible until next reset. */
export function endRealtimeCost(): void {
  setState({ startedTs: null });
}

/** Accumulate one usage delta (Kevin: call on each realtime usage event). */
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

/** Set (or clear, with null) the session spend cap. */
export function setRealtimeCap(capUsd: number | null): void {
  const cap = capUsd != null && capUsd > 0 ? capUsd : null;
  setState({ capUsd: cap, overCap: recomputeOverCap(state.usd, cap) });
}

/** True when no usage delta has arrived for `thresholdMs` while a session is live —
 *  the cue for mic-off-when-idle (the session decides whether to disconnect). */
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

/** React binding for the cost HUD + the cap control. */
export function useRealtimeCost(): RealtimeCostState & { setCap: (capUsd: number | null) => void } {
  const snap = useSyncExternalStore(subscribe, getRealtimeCostSnapshot);
  return { ...snap, setCap: setRealtimeCap };
}

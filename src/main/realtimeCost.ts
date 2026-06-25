/**
 * Realtime Michael — main-process cost module (card rt-9, cost-guard).
 *
 * Two jobs, both consumed by Kevin's core files via a clean import (no edits from
 * me to those files — rt-9 ships net-new only):
 *
 *  1. spawnCostSpoken() — the REAL $/hour estimate that replaces rt-5's stub in
 *     src/main/realtimeActions.ts. The spawn-confirm flow speaks it back before
 *     hiring an agent. Reuses the existing per-model price table (./pricing) so
 *     the figure tracks the same rates the cost-ledger uses.
 *  2. re-exports the shared realtime audio cost helpers so a main-side caller can
 *     price a realtime usage delta without reaching into ../shared directly.
 *
 * The LIVE session meter + spend cap live in the renderer (where the voice
 * session and its usage events are) — see src/renderer/src/realtime/costStore.ts.
 */
import { priceFor } from './pricing';
import { computeRealtimeUsd, formatUsd, type RealtimeUsage } from '../shared/realtimePricing';

export { computeRealtimeUsd, formatUsd, type RealtimeUsage };

/**
 * Rough token throughput of an actively-working coding agent, per wall-clock hour.
 * A heuristic — real usage swings hugely with the task — used only to turn the
 * per-model price into a spoken ballpark for the spawn/hire confirm. Tuned to a
 * busy agent (lots of file reads → big cached-input share).
 */
const AGENT_TOKENS_PER_HOUR = {
  inputTokens: 200_000,
  outputTokens: 40_000,
  cacheReadTokens: 400_000,
  cacheWriteTokens: 60_000
};

/** Provider → a representative model id when the caller didn't name one, so
 *  priceFor() lands on a sensible family. Non-Claude providers fall through to the
 *  table's Sonnet default (a rough proxy — the estimate is explicitly a ballpark). */
const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  claude: 'claude-opus-4-8',
  codex: 'gpt',
  antigravity: 'gemini',
  gemini: 'gemini'
};

/** Estimated USD/hour to RUN a freshly-spawned agent on the given provider/model. */
export function estimateSpawnCostUsdPerHour(provider: string, model?: string): number {
  const m = (model && model.trim()) || PROVIDER_DEFAULT_MODEL[provider.toLowerCase()] || '';
  const p = priceFor(m);
  const t = AGENT_TOKENS_PER_HOUR;
  return (
    (t.inputTokens / 1_000_000) * p.inputPerM +
    (t.outputTokens / 1_000_000) * p.outputPerM +
    (t.cacheReadTokens / 1_000_000) * p.cacheReadPerM +
    (t.cacheWriteTokens / 1_000_000) * p.cacheWritePerM
  );
}

/**
 * A spoken phrase for the spawn/hire echo-back confirm, e.g.
 * "about $6.50 an hour while it runs". Drop-in replacement for rt-5's stub string
 * in realtimeActions.ts (the spawn branch): just interpolate this where the stub
 * said "roughly a few dollars an hour".
 */
export function spawnCostSpoken(provider: string, model?: string): string {
  const perHour = estimateSpawnCostUsdPerHour(provider, model);
  return `about ${formatUsd(perHour)} an hour while it runs (a rough estimate)`;
}

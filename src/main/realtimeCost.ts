/**
 * Realtime Michael — main-process cost helpers (card rt-9, cost-guard).
 *
 * Re-exports the shared realtime audio cost helpers so a main-side caller can price
 * a realtime usage delta without reaching into ../shared directly. These feed the
 * cost cap (the runaway guard), which still fires silently — money is no longer
 * surfaced to the user or spoken by the orchestrator, so the spawn/hire $-estimate
 * that used to live here has been removed (de-monetize). The LIVE session meter +
 * spend cap live in the renderer — see src/renderer/src/realtime/costStore.ts.
 */
export { computeRealtimeUsd, formatUsd, type RealtimeUsage } from '../shared/realtimePricing';

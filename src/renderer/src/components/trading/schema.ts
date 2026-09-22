/**
 * Defensive parsers for the Kalshi pipeline's state files.
 *
 * Every file on the desk is written by a separate Python process that the
 * renderer does not control, so nothing here trusts a shape. Each parser takes
 * `unknown`, checks what it uses, and either returns a typed record or throws
 * an Error naming what was wrong — the hook turns that into the panel's error
 * text. Numeric fields come as numbers OR numeric strings (`"0.920000"`) in the
 * broker-mirrored files, so `num()` accepts both and rejects everything else.
 *
 * No `as` casts on parsed input: a field is what the guard proves it is.
 */

export const KALSHI_ROOT = 'C:/Users/chrom/AppData/Local/hermes/skills/trading/kalshi';

export type Json = Record<string, unknown>;

export function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** number | numeric string → number; anything else → null. */
export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

export function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/** ISO timestamp → epoch ms, or null when absent/unparseable. */
export function ts(v: unknown): number | null {
  if (typeof v !== 'string' || v === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function requireRecord(v: unknown, what: string): Json {
  if (!isRecord(v)) throw new Error(`${what}: expected a JSON object`);
  return v;
}

// ─── portfolio.json ─────────────────────────────────────────────────────────

export interface Position {
  ticker: string;
  title: string;
  /** Signed contracts as written by the broker mirror: >0 YES, <0 NO. */
  positionFp: number;
  exposure: number;
  cost: number;
  fees: number;
  realized: number;
  lastUpdated: number | null;
}

export interface Portfolio {
  updated: number | null;
  balance: number | null;
  exposure: number | null;
  realized: number | null;
  savedProfits: number | null;
  restingReserved: number | null;
  fillsToday: number | null;
  positions: Position[];
}

export function parsePortfolio(v: unknown): Portfolio {
  const r = requireRecord(v, 'portfolio.json');
  const rawPositions = Array.isArray(r.positions) ? r.positions : [];
  const positions: Position[] = [];
  for (const p of rawPositions) {
    if (!isRecord(p)) continue;
    const ticker = str(p.ticker);
    if (!ticker) continue;
    positions.push({
      ticker,
      title: str(p.title) ?? '',
      positionFp: num(p.position_fp) ?? 0,
      exposure: num(p.market_exposure_dollars) ?? 0,
      cost: num(p.total_traded_dollars) ?? 0,
      fees: num(p.fees_paid_dollars) ?? 0,
      realized: num(p.realized_pnl_dollars) ?? 0,
      lastUpdated: ts(p.last_updated_ts),
    });
  }
  return {
    updated: ts(r.updated),
    balance: num(r.balance_dollars),
    exposure: num(r.total_exposure_dollars),
    realized: num(r.realized_pnl_dollars),
    savedProfits: num(r.saved_profits_dollars),
    restingReserved: num(r.resting_reserved_dollars),
    fillsToday: num(r.fills_today_count),
    positions,
  };
}

// ─── bankroll.json / trading_mode.json / pipeline_control.json ──────────────

export interface Bankroll { bankroll: number | null; savedProfits: number | null; updated: number | null }

export function parseBankroll(v: unknown): Bankroll {
  const r = requireRecord(v, 'bankroll.json');
  return { bankroll: num(r.bankroll), savedProfits: num(r.saved_profits_dollars), updated: ts(r.updated) };
}

export interface TradingMode { mode: string; updated: number | null }

export function parseTradingMode(v: unknown): TradingMode {
  const r = requireRecord(v, 'trading_mode.json');
  const mode = str(r.mode);
  if (!mode) throw new Error('trading_mode.json: missing "mode"');
  return { mode, updated: ts(r.updated) };
}

export interface PipelineControl { state: string; at: number | null; by: string | null; note: string | null }

export function parsePipelineControl(v: unknown): PipelineControl {
  const r = requireRecord(v, 'pipeline_control.json');
  const state = str(r.state);
  if (!state) throw new Error('pipeline_control.json: missing "state"');
  return { state, at: ts(r.at), by: str(r.by), note: str(r.note) };
}

// ─── runtime/pipeline_status.json ───────────────────────────────────────────

export interface Worker { name: string; alive: boolean | null; pid: number | null; role: string; resting: boolean | null }

export interface PipelineStatus {
  state: string | null;
  since: number | null;
  by: string | null;
  at: number | null;
  appAlive: boolean | null;
  workers: Worker[];
}

export function parsePipelineStatus(v: unknown): PipelineStatus {
  const r = requireRecord(v, 'pipeline_status.json');
  const workers: Worker[] = [];
  if (isRecord(r.workers)) {
    for (const [name, w] of Object.entries(r.workers)) {
      if (!isRecord(w)) continue;
      workers.push({ name, alive: bool(w.alive), pid: num(w.pid), role: str(w.role) ?? '', resting: bool(w.resting) });
    }
  }
  workers.sort((a, b) => a.name.localeCompare(b.name));
  return {
    state: str(r.state),
    since: ts(r.since),
    by: str(r.by),
    at: ts(r.at),
    appAlive: isRecord(r.app) ? bool(r.app.alive) : null,
    workers,
  };
}

// ─── runtime/realized_pnl.json ──────────────────────────────────────────────

export interface RealizedPnl {
  realized: number | null;
  fees: number | null;
  settled: number | null;
  wins: number | null;
  losses: number | null;
  byCategory: Array<{ category: string; pnl: number }>;
  at: number | null;
  stale: boolean | null;
}

export function parseRealizedPnl(v: unknown): RealizedPnl {
  const r = requireRecord(v, 'realized_pnl.json');
  const byCategory: Array<{ category: string; pnl: number }> = [];
  if (isRecord(r.by_category)) {
    for (const [category, pnl] of Object.entries(r.by_category)) {
      const n = num(pnl);
      if (n !== null) byCategory.push({ category, pnl: n });
    }
  }
  byCategory.sort((a, b) => b.pnl - a.pnl);
  return {
    realized: num(r.realized_pnl_dollars),
    fees: num(r.fees_paid_dollars),
    settled: num(r.settled),
    wins: num(r.wins),
    losses: num(r.losses),
    byCategory,
    at: ts(r.at),
    stale: bool(r.stale),
  };
}

// ─── profit_reserve.json ────────────────────────────────────────────────────

export interface ProfitReserve {
  saveFraction: number | null;
  settlements: number | null;
  settledNet: number | null;
  saved: number | null;
  updated: number | null;
}

export function parseProfitReserve(v: unknown): ProfitReserve {
  const r = requireRecord(v, 'profit_reserve.json');
  return {
    saveFraction: num(r.save_fraction),
    settlements: num(r.settlements),
    settledNet: num(r.settled_net_profit_dollars),
    saved: num(r.saved_profits_dollars),
    updated: ts(r.updated),
  };
}

// ─── observer/current_candidates.json ───────────────────────────────────────

export interface Candidate { ticker: string; category: string; title: string; closeTime: number | null; cluster: string | null }

export interface Candidates { generatedAt: number | null; markets: Candidate[] }

export function parseCandidates(v: unknown): Candidates {
  const r = requireRecord(v, 'current_candidates.json');
  const markets: Candidate[] = [];
  if (Array.isArray(r.markets)) {
    for (const m of r.markets) {
      if (!isRecord(m)) continue;
      const ticker = str(m.ticker);
      if (!ticker) continue;
      markets.push({
        ticker,
        category: str(m.category) ?? '',
        title: str(m.title) ?? '',
        closeTime: ts(m.close_time),
        cluster: str(m.cluster),
      });
    }
  }
  return { generatedAt: ts(r.generated_at), markets };
}

// ─── observer/forecast_fallback_current.json ────────────────────────────────

export interface Forecast {
  ticker: string;
  agent: string;
  probability: number;
  confidence: number | null;
  evidenceQuality: number | null;
  rationale: string;
  asOf: number | null;
}

export interface Forecasts { generatedAt: number | null; rows: Forecast[] }

export function parseForecasts(v: unknown): Forecasts {
  const r = requireRecord(v, 'forecast_fallback_current.json');
  const rows: Forecast[] = [];
  if (Array.isArray(r.rows)) {
    for (const f of r.rows) {
      if (!isRecord(f)) continue;
      const ticker = str(f.ticker);
      const probability = num(f.probability);
      if (!ticker || probability === null) continue;
      rows.push({
        ticker,
        agent: str(f.agent) ?? '?',
        probability,
        confidence: num(f.confidence),
        evidenceQuality: num(f.evidence_quality),
        rationale: str(f.rationale) ?? '',
        asOf: ts(f.as_of),
      });
    }
  }
  return { generatedAt: ts(r.generated_at), rows };
}

// ─── executions.jsonl (tail) ────────────────────────────────────────────────

export interface Execution {
  id: string;
  at: number | null;
  status: string;
  mode: string | null;
  ticker: string;
  side: string;
  contracts: number | null;
  price: number | null;
  sizeDollars: number | null;
  /** Fraction of a dollar (0.0186 = 1.86¢), as the verdict writes it. */
  usableEdge: number | null;
  watchdogAction: string | null;
  reasons: string[];
  success: boolean | null;
  /** The broker/MCP text — the rejection reason on a rejected row. */
  resultText: string;
  /** Pipeline-side `reason` on rows the runner refused before the broker. */
  reason: string | null;
}

export interface ExecutionsTail {
  rows: Execution[];
  /** Lines in the window that were not valid JSON — shown, never hidden. */
  badLines: number;
  /** Timestamp of the newest row, which is this file's "last updated". */
  newestAt: number | null;
  oldestAt: number | null;
  truncated: boolean;
}

export function parseExecution(v: unknown): Execution | null {
  if (!isRecord(v)) return null;
  const verdict = isRecord(v.verdict) ? v.verdict : {};
  const mcp = isRecord(v.mcp_result) ? v.mcp_result : {};
  const id = str(v.id);
  const status = str(v.status);
  if (!id || !status) return null;
  const reasons: string[] = Array.isArray(verdict.reasons)
    ? verdict.reasons.filter((x): x is string => typeof x === 'string')
    : [];
  return {
    id,
    at: ts(v.at),
    status,
    mode: str(v.mode),
    ticker: str(verdict.ticker) ?? '',
    side: str(verdict.side) ?? '',
    contracts: num(verdict.contracts),
    price: num(verdict.executable_price),
    sizeDollars: num(verdict.size_dollars),
    usableEdge: num(verdict.usable_edge),
    watchdogAction: str(verdict.watchdog_action),
    reasons,
    success: bool(mcp.success),
    resultText: str(mcp.text) ?? '',
    reason: str(v.reason),
  };
}

export function parseExecutionsTail(content: string, truncated: boolean): ExecutionsTail {
  const rows: Execution[] = [];
  let badLines = 0;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { badLines++; continue; }
    const row = parseExecution(parsed);
    if (row) rows.push(row); else badLines++;
  }
  // Newest first for the feed; the file is append-ordered.
  rows.reverse();
  const stamps = rows.map(r => r.at).filter((t): t is number => t !== null);
  return {
    rows,
    badLines,
    newestAt: stamps.length ? Math.max(...stamps) : null,
    oldestAt: stamps.length ? Math.min(...stamps) : null,
    truncated,
  };
}

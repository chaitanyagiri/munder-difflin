import { useEffect, useRef, useState } from 'react';
import {
  KALSHI_ROOT,
  parseBankroll, parseCandidates, parseExecutionsTail, parseForecasts, parsePipelineControl,
  parsePipelineStatus, parsePortfolio, parseProfitReserve, parseRealizedPnl, parseTradingMode,
  type Bankroll, type Candidates, type ExecutionsTail, type Forecasts, type PipelineControl,
  type PipelineStatus, type Portfolio, type ProfitReserve, type RealizedPnl, type TradingMode,
} from './schema';

/**
 * One state file as the desk sees it.
 *
 *  - `data`      the last successfully parsed content, or null if never read.
 *                Kept across a later failure so a transient read error does
 *                not blank a panel — `error` says the current read failed.
 *  - `error`     the current read/parse failure, or null.
 *  - `updatedAt` the file's OWN timestamp (its `updated` / `at` /
 *                `generated_at`, or the newest row of a log) — what "stale"
 *                is measured against. null when the file carries none.
 *  - `fetchedAt` when the renderer last read it.
 */
export interface FileState<T> {
  data: T | null;
  error: string | null;
  updatedAt: number | null;
  fetchedAt: number | null;
}

const EMPTY: FileState<never> = { data: null, error: null, updatedAt: null, fetchedAt: null };

export interface TradingData {
  portfolio: FileState<Portfolio>;
  bankroll: FileState<Bankroll>;
  mode: FileState<TradingMode>;
  control: FileState<PipelineControl>;
  status: FileState<PipelineStatus>;
  pnl: FileState<RealizedPnl>;
  reserve: FileState<ProfitReserve>;
  candidates: FileState<Candidates>;
  forecasts: FileState<Forecasts>;
  executions: FileState<ExecutionsTail>;
  /** Wall clock, ticked every 15 s so ages and stale markers move between polls. */
  now: number;
  /** Set once the first poll of every file has settled. */
  loaded: boolean;
  refresh: () => void;
}

export const POLL_MS = 30_000;
const TICK_MS = 15_000;
/** Executions rows run ~1.2 KB each; 384 KB is ~300 rows, comfortably more
 *  than a day of the pipeline's output and well under the main-side 512 KB cap. */
const EXECUTIONS_TAIL_BYTES = 384 * 1024;

type Reader<T> = () => Promise<{ data: T; updatedAt: number | null }>;

async function readJson<T>(rel: string, parse: (v: unknown) => T, stamp: (d: T) => number | null): Promise<{ data: T; updatedAt: number | null }> {
  const r = await window.cth.readFile(KALSHI_ROOT, rel);
  if (!r.ok) throw new Error(r.error);
  let raw: unknown;
  try { raw = JSON.parse(r.content); } catch (e) {
    throw new Error(`${rel}: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  const data = parse(raw);
  return { data, updatedAt: stamp(data) };
}

async function readExecutions(): Promise<{ data: ExecutionsTail; updatedAt: number | null }> {
  const r = await window.cth.readTail(KALSHI_ROOT, 'executions.jsonl', EXECUTIONS_TAIL_BYTES);
  if (!r.ok) throw new Error(r.error);
  const data = parseExecutionsTail(r.content, r.truncated);
  return { data, updatedAt: data.newestAt };
}

const READERS: { [K in keyof Omit<TradingData, 'now' | 'loaded' | 'refresh'>]: Reader<NonNullable<TradingData[K]['data']>> } = {
  portfolio: () => readJson('portfolio.json', parsePortfolio, d => d.updated),
  bankroll: () => readJson('bankroll.json', parseBankroll, d => d.updated),
  mode: () => readJson('trading_mode.json', parseTradingMode, d => d.updated),
  control: () => readJson('pipeline_control.json', parsePipelineControl, d => d.at),
  status: () => readJson('runtime/pipeline_status.json', parsePipelineStatus, d => d.at),
  pnl: () => readJson('runtime/realized_pnl.json', parseRealizedPnl, d => d.at),
  reserve: () => readJson('profit_reserve.json', parseProfitReserve, d => d.updated),
  candidates: () => readJson('observer/current_candidates.json', parseCandidates, d => d.generatedAt),
  forecasts: () => readJson('observer/forecast_fallback_current.json', parseForecasts, d => d.generatedAt),
  executions: readExecutions,
};

type FileKey = keyof typeof READERS;
const KEYS = Object.keys(READERS) as FileKey[];

type Files = { [K in FileKey]: FileState<NonNullable<TradingData[K]['data']>> };

function initialFiles(): Files {
  return {
    portfolio: EMPTY, bankroll: EMPTY, mode: EMPTY, control: EMPTY, status: EMPTY,
    pnl: EMPTY, reserve: EMPTY, candidates: EMPTY, forecasts: EMPTY, executions: EMPTY,
  };
}

/**
 * Polls every desk file on a 30 s cadence and exposes each independently.
 * One missing or malformed file never blanks the others: every read is its
 * own promise, settled on its own, and merged into state by key.
 */
export function useTradingData(): TradingData {
  const [files, setFiles] = useState<Files>(initialFiles);
  const [now, setNow] = useState(() => Date.now());
  const [loaded, setLoaded] = useState(false);
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const poll = async () => {
      await Promise.all(KEYS.map(async (key) => {
        const fetchedAt = Date.now();
        try {
          const { data, updatedAt } = await READERS[key]();
          if (!alive.current) return;
          setFiles(prev => ({ ...prev, [key]: { data, error: null, updatedAt, fetchedAt } }));
        } catch (e) {
          if (!alive.current) return;
          const error = e instanceof Error ? e.message : String(e);
          setFiles(prev => ({ ...prev, [key]: { ...prev[key], error, fetchedAt } }));
        }
      }));
      if (alive.current) { setLoaded(true); setNow(Date.now()); }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, POLL_MS);
    return () => { alive.current = false; clearInterval(timer); };
  }, [nonce]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);

  return { ...files, now, loaded, refresh: () => setNonce(n => n + 1) };
}

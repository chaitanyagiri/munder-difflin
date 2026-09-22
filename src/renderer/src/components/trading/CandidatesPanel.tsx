import { useMemo } from 'react';
import { DASH, dateTime, pct, truncate } from './format';
import { CopyTicker, DeskCard, Empty } from './shared';
import type { Forecast } from './schema';
import type { TradingData } from './useTradingData';

const WIDE_SPREAD = 0.10;

interface Row {
  ticker: string;
  category: string;
  title: string;
  closeTime: number | null;
  forecasts: Forecast[];
  min: number | null;
  mean: number | null;
  max: number | null;
  spread: number | null;
}

/**
 * The observer's current market shortlist joined to the per-agent forecasts
 * for it. Spread (max − min across agents) over 10 points is the number a
 * trader wants to see first: it is where the ensemble disagrees.
 */
export function CandidatesPanel({ d }: { d: TradingData }) {
  const candidates = d.candidates.data;
  const forecasts = d.forecasts.data;

  const rows = useMemo<Row[]>(() => {
    const byTicker = new Map<string, Forecast[]>();
    for (const f of forecasts?.rows ?? []) {
      const list = byTicker.get(f.ticker);
      if (list) list.push(f); else byTicker.set(f.ticker, [f]);
    }
    const out: Row[] = (candidates?.markets ?? []).map(m => {
      const fs = byTicker.get(m.ticker) ?? [];
      const ps = fs.map(f => f.probability);
      const min = ps.length ? Math.min(...ps) : null;
      const max = ps.length ? Math.max(...ps) : null;
      const mean = ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : null;
      return {
        ticker: m.ticker, category: m.category, title: m.title, closeTime: m.closeTime,
        forecasts: fs, min, mean, max,
        spread: min !== null && max !== null ? max - min : null,
      };
    });
    // Forecast rows for tickers the candidate list no longer carries are still
    // real research; list them after the shortlist rather than dropping them.
    const listed = new Set(out.map(r => r.ticker));
    for (const [ticker, fs] of byTicker) {
      if (listed.has(ticker)) continue;
      const ps = fs.map(f => f.probability);
      const min = Math.min(...ps), max = Math.max(...ps);
      out.push({
        ticker, category: '(not in shortlist)', title: '', closeTime: null,
        forecasts: fs, min, max, mean: ps.reduce((a, b) => a + b, 0) / ps.length, spread: max - min,
      });
    }
    out.sort((a, b) => (b.spread ?? -1) - (a.spread ?? -1));
    return out;
  }, [candidates, forecasts]);

  const wide = rows.filter(r => r.spread !== null && r.spread > WIDE_SPREAD).length;

  return (
    <DeskCard
      title="Candidates & forecasts"
      file={[d.candidates, d.forecasts]}
      now={d.now}
      aside={<span className="md-desk-count">{candidates ? `${candidates.markets.length} markets` : DASH} · {forecasts ? `${forecasts.rows.length} forecasts` : DASH}{wide > 0 && <> · <span className="md-desk-warn">{wide} wide</span></>}</span>}
    >
      {!candidates && !forecasts ? <Empty>No observer output yet.</Empty> : rows.length === 0 ? <Empty>Shortlist is empty.</Empty> : (
        <div className="md-desk-scroll">
          <table className="md-desk-table">
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Category</th>
                <th>Title</th>
                <th className="num">Closes</th>
                <th className="num">Agents</th>
                <th className="num">Min</th>
                <th className="num">Mean</th>
                <th className="num">Max</th>
                <th className="num">Spread</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const isWide = r.spread !== null && r.spread > WIDE_SPREAD;
                const agentsTip = r.forecasts.map(f => `${f.agent}: ${pct(f.probability)}${f.confidence !== null ? ` (conf ${pct(f.confidence)})` : ''}`).join('\n');
                return (
                  <tr key={r.ticker} className={isWide ? 'md-desk-row-wide' : undefined}>
                    <td><CopyTicker ticker={r.ticker} /></td>
                    <td className="md-desk-muted">{truncate(r.category, 22) || DASH}</td>
                    <td className="md-desk-title" title={r.title}>{truncate(r.title, 52) || DASH}</td>
                    <td className="num md-desk-muted">{dateTime(r.closeTime)}</td>
                    <td className="num" title={agentsTip}>{r.forecasts.length || DASH}</td>
                    <td className="num">{pct(r.min)}</td>
                    <td className="num">{pct(r.mean)}</td>
                    <td className="num">{pct(r.max)}</td>
                    <td className={`num${isWide ? ' md-desk-warn' : ''}`}>{r.spread === null ? DASH : `${(r.spread * 100).toFixed(0)} pts`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </DeskCard>
  );
}

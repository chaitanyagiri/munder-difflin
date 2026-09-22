import { CandidatesPanel } from './CandidatesPanel';
import { HeaderStrip } from './HeaderStrip';
import { HealthPanel } from './HealthPanel';
import { OrdersFeed } from './OrdersFeed';
import { PnlCard } from './PnlCard';
import { PositionsTable } from './PositionsTable';
import { KALSHI_ROOT } from './schema';
import { clock } from './format';
import { POLL_MS, useTradingData } from './useTradingData';

/**
 * The trading desk: every number on it is read from the pipeline's own state
 * files under KALSHI_ROOT through the root-confined fs IPC, and nothing on it
 * writes anywhere. Panels are independent — a missing file blanks only its
 * own card, with the read error printed in place of the data.
 */
export function TradingDesk() {
  const d = useTradingData();
  const lastFetch = Math.max(
    0,
    ...[d.portfolio, d.bankroll, d.mode, d.control, d.status, d.pnl, d.reserve, d.candidates, d.forecasts, d.executions]
      .map(f => f.fetchedAt ?? 0),
  );

  return (
    <main className="md-desk" aria-label="Trading desk">
      <HeaderStrip d={d} />
      <div className="md-desk-grid">
        <div className="md-desk-col md-desk-col-main">
          <PositionsTable d={d} />
          <OrdersFeed d={d} />
          <CandidatesPanel d={d} />
        </div>
        <div className="md-desk-col md-desk-col-side">
          <PnlCard d={d} />
          <HealthPanel d={d} />
        </div>
      </div>
      <footer className="md-desk-footer">
        <span title={KALSHI_ROOT}>source: {KALSHI_ROOT}</span>
        <span>
          {d.loaded ? `read ${lastFetch ? clock(lastFetch) : '—'} · every ${POLL_MS / 1000}s` : 'reading…'}
          {' · '}
          <button type="button" className="md-desk-link" onClick={d.refresh}>refresh</button>
        </span>
      </footer>
    </main>
  );
}

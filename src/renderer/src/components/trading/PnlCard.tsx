import { DASH, int, pct, usd, usdSigned } from './format';
import { DeskCard, Empty, Stat, toneFor } from './shared';
import type { TradingData } from './useTradingData';

/** Realized results from `runtime/realized_pnl.json` — settlement-backed
 *  numbers only. Nothing here is marked to market. */
export function PnlCard({ d }: { d: TradingData }) {
  const p = d.pnl.data;
  const wins = p?.wins ?? null;
  const losses = p?.losses ?? null;
  const decided = wins !== null && losses !== null ? wins + losses : null;
  const winRate = decided !== null && decided > 0 && wins !== null ? wins / decided : null;
  const reserve = d.reserve.data;

  return (
    <DeskCard title="Realized P&L" file={d.pnl} now={d.now} aside={p?.stale ? <span className="md-desk-badge md-desk-badge-warn" title="the writer flagged this as stale">writer: stale</span> : null}>
      {!p ? <Empty>No realized_pnl.json yet.</Empty> : (
        <>
          <div className="md-desk-stat-row">
            <Stat label="Net" value={usdSigned(p.realized)} tone={toneFor(p.realized)} />
            <Stat label="Fees" value={usd(p.fees)} />
            <Stat label="Settled" value={int(p.settled)} />
            <Stat label="W / L" value={`${int(wins)} / ${int(losses)}`} />
            <Stat label="Win rate" value={pct(winRate)} tone={winRate === null ? undefined : winRate >= 0.5 ? 'pos' : 'neg'} />
          </div>
          <table className="md-desk-table md-desk-table-compact">
            <thead><tr><th>Category</th><th className="num">Net</th></tr></thead>
            <tbody>
              {p.byCategory.length === 0 && <tr><td colSpan={2} className="md-desk-muted">{DASH}</td></tr>}
              {p.byCategory.map(c => (
                <tr key={c.category}>
                  <td>{c.category}</td>
                  <td className={`num ${toneFor(c.pnl) ? `md-desk-${toneFor(c.pnl)}` : ''}`}>{usdSigned(c.pnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {reserve && (
            <div className="md-desk-foot" title={d.reserve.error ?? 'profit_reserve.json'}>
              reserve: {pct(reserve.saveFraction)} of settled net {usdSigned(reserve.settledNet)} → {usd(reserve.saved)} saved over {int(reserve.settlements)} settlements
            </div>
          )}
          {d.reserve.error && !reserve && <div className="md-desk-foot md-desk-neg">profit_reserve.json: {d.reserve.error}</div>}
        </>
      )}
    </DeskCard>
  );
}

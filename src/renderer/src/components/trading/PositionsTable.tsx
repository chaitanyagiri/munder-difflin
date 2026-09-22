import { useMemo } from 'react';
import { DASH, cents, clock, truncate, usd } from './format';
import { CopyTicker, DeskCard, Empty } from './shared';
import type { TradingData } from './useTradingData';

/** Open positions from `portfolio.json`, exposure > 0 only, biggest first.
 *  Side is the sign of `position_fp` (broker convention: + YES, − NO). */
export function PositionsTable({ d }: { d: TradingData }) {
  const portfolio = d.portfolio.data;
  const rows = useMemo(() => {
    const open = (portfolio?.positions ?? []).filter(p => p.exposure > 0);
    open.sort((a, b) => b.exposure - a.exposure);
    return open;
  }, [portfolio]);
  const totalExposure = rows.reduce((s, p) => s + p.exposure, 0);
  const totalFees = rows.reduce((s, p) => s + p.fees, 0);

  return (
    <DeskCard
      title="Open positions"
      file={d.portfolio}
      now={d.now}
      aside={<span className="md-desk-count">{portfolio ? `${rows.length} open · ${usd(totalExposure)}` : DASH}</span>}
    >
      {!portfolio ? <Empty>No portfolio.json yet.</Empty> : rows.length === 0 ? <Empty>No open exposure.</Empty> : (
        <div className="md-desk-scroll">
          <table className="md-desk-table">
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Title</th>
                <th>Side</th>
                <th className="num">Qty</th>
                <th className="num">Cost</th>
                <th className="num">Avg</th>
                <th className="num">Exposure</th>
                <th className="num">Fees</th>
                <th className="num">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(p => {
                const qty = Math.abs(p.positionFp);
                const side = p.positionFp > 0 ? 'YES' : p.positionFp < 0 ? 'NO' : DASH;
                const avg = qty > 0 ? p.cost / qty : null;
                return (
                  <tr key={p.ticker}>
                    <td><CopyTicker ticker={p.ticker} /></td>
                    <td className="md-desk-title" title={p.title}>{truncate(p.title, 48) || DASH}</td>
                    <td><span className={`md-desk-side md-desk-side-${side.toLowerCase()}`}>{side}</span></td>
                    <td className="num">{qty}</td>
                    <td className="num">{usd(p.cost)}</td>
                    <td className="num">{cents(avg, 1)}</td>
                    <td className="num">{usd(p.exposure)}</td>
                    <td className="num">{usd(p.fees, 4)}</td>
                    <td className="num md-desk-muted" title={p.lastUpdated ? new Date(p.lastUpdated).toISOString() : ''}>{clock(p.lastUpdated)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={6} className="md-desk-muted">total</td>
                <td className="num">{usd(totalExposure)}</td>
                <td className="num">{usd(totalFees, 4)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </DeskCard>
  );
}

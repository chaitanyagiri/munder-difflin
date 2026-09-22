import { useMemo } from 'react';
import { DASH, age, cents, clock, dateTime, truncate, usd } from './format';
import { CopyTicker, DeskCard, Empty } from './shared';
import type { TradingData } from './useTradingData';

const FEED_ROWS = 40;
const DAY_MS = 24 * 60 * 60 * 1000;

function statusClass(status: string, success: boolean | null): string {
  if (status === 'filled') return 'md-desk-status-filled';
  if (status === 'rejected') return 'md-desk-status-rejected';
  if (status === 'accepted_unverified') return 'md-desk-status-pending';
  if (success === false) return 'md-desk-status-error';
  return 'md-desk-status-other';
}

/**
 * The tail of `executions.jsonl`: every order the runner tried to place, newest
 * first. A rejected row's reason is the broker/gate text in `mcp_result.text`
 * (or the runner's own `reason` when it never reached the broker).
 */
export function OrdersFeed({ d }: { d: TradingData }) {
  const tail = d.executions.data;
  const feed = useMemo(() => (tail?.rows ?? []).slice(0, FEED_ROWS), [tail]);
  const last24 = useMemo(() => {
    const since = d.now - DAY_MS;
    let filled = 0, rejected = 0, other = 0;
    for (const r of tail?.rows ?? []) {
      if (r.at === null || r.at < since) continue;
      if (r.status === 'filled') filled++;
      else if (r.status === 'rejected') rejected++;
      else other++;
    }
    return { filled, rejected, other };
  }, [tail, d.now]);
  // The window is honest only if it reaches back a full day.
  const windowShort = tail?.oldestAt !== null && tail?.oldestAt !== undefined && tail.oldestAt > d.now - DAY_MS && tail.truncated;

  return (
    <DeskCard
      title="Recent orders"
      file={d.executions}
      now={d.now}
      aside={tail ? (
        <span className="md-desk-count" title={windowShort ? `tail window only reaches back ${age(tail.oldestAt, d.now)}` : 'last 24 h'}>
          24h: <span className="md-desk-pos">{last24.filled} filled</span> · <span className="md-desk-warn">{last24.rejected} rejected</span>
          {last24.other > 0 && <> · {last24.other} other</>}
          {windowShort && <span className="md-desk-neg"> (window {age(tail.oldestAt, d.now)})</span>}
          {tail.badLines > 0 && <span className="md-desk-neg" title="lines in the tail that were not valid JSON"> · {tail.badLines} unparseable</span>}
        </span>
      ) : null}
    >
      {!tail ? <Empty>No executions.jsonl yet.</Empty> : feed.length === 0 ? <Empty>No orders in the tail window.</Empty> : (
        <div className="md-desk-scroll">
          <table className="md-desk-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Status</th>
                <th>Ticker</th>
                <th>Side</th>
                <th className="num">Qty</th>
                <th className="num">Price</th>
                <th className="num">Size</th>
                <th className="num">Edge</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {feed.map(r => {
                const reason = r.status === 'filled' ? '' : (r.resultText || r.reason || r.reasons.join('; '));
                return (
                  <tr key={r.id}>
                    <td className="num md-desk-muted" title={r.at ? `${dateTime(r.at)} · ${age(r.at, d.now)} ago` : ''}>{clock(r.at)}</td>
                    <td><span className={`md-desk-status ${statusClass(r.status, r.success)}`} title={`${r.status}${r.mode ? ` · ${r.mode}` : ''}${r.watchdogAction ? ` · watchdog ${r.watchdogAction}` : ''}`}>{r.status.replace('_', ' ')}</span></td>
                    <td><CopyTicker ticker={r.ticker} /></td>
                    <td><span className={`md-desk-side md-desk-side-${r.side.toLowerCase()}`}>{r.side || DASH}</span></td>
                    <td className="num">{r.contracts ?? DASH}</td>
                    <td className="num">{cents(r.price)}</td>
                    <td className="num">{usd(r.sizeDollars)}</td>
                    <td className="num">{cents(r.usableEdge, 1)}</td>
                    <td className="md-desk-reason" title={reason}>{truncate(reason, 72) || DASH}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {tail.rows.length > FEED_ROWS && (
            <div className="md-desk-foot">showing {FEED_ROWS} of {tail.rows.length} rows in the tail window{tail.truncated ? ' (file is longer)' : ''}</div>
          )}
        </div>
      )}
    </DeskCard>
  );
}

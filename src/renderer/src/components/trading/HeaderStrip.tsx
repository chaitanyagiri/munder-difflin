import { DASH, age, clock, isStale, usd } from './format';
import { Stat } from './shared';
import type { TradingData } from './useTradingData';

/**
 * The one-line answer to "is the desk alive and what is at risk right now".
 *
 * Mode and the pipeline switch are settings, not heartbeats: their timestamps
 * are when they were last flipped, so they carry no stale test. The heartbeat
 * is `runtime/pipeline_status.json.at` — the supervisor's last tick — and it
 * goes red past five minutes.
 */
export function HeaderStrip({ d }: { d: TradingData }) {
  const mode = d.mode.data?.mode ?? null;
  const live = mode === 'LIVE';
  const control = d.control.data;
  const status = d.status.data;
  const portfolio = d.portfolio.data;
  const heartbeat = status?.at ?? null;
  const heartbeatStale = isStale(heartbeat, d.now);
  const dead = (status?.workers ?? []).filter(w => w.alive === false);
  const bankroll = d.bankroll.data?.bankroll ?? null;
  const saved = d.portfolio.data?.savedProfits ?? d.bankroll.data?.savedProfits ?? d.reserve.data?.saved ?? null;
  const running = control?.state === 'running';

  return (
    <div className="md-desk-strip" aria-label="Desk status">
      <div className="md-desk-strip-group">
        <div className="md-desk-stat" title={d.mode.error ?? (d.mode.data?.updated ? `set ${clock(d.mode.data.updated)}` : 'trading_mode.json')}>
          <span className="md-desk-stat-label">Mode</span>
          <span className={`md-desk-badge ${live ? 'md-desk-badge-live' : mode ? 'md-desk-badge-paper' : 'md-desk-badge-unknown'}`}>
            {mode ?? (d.mode.error ? 'ERR' : DASH)}
          </span>
        </div>
        <div className="md-desk-stat" title={d.control.error ?? (control ? `set ${clock(control.at)} by ${control.by ?? '?'}${control.note ? ` — ${control.note}` : ''}` : 'pipeline_control.json')}>
          <span className="md-desk-stat-label">Switch</span>
          <span className={`md-desk-badge ${running ? 'md-desk-badge-ok' : control ? 'md-desk-badge-warn' : 'md-desk-badge-unknown'}`}>
            {control?.state ?? (d.control.error ? 'ERR' : DASH)}
          </span>
        </div>
        <Stat
          label="Heartbeat"
          value={heartbeat ? `${age(heartbeat, d.now)} ago` : (d.status.error ? 'ERR' : DASH)}
          tone={heartbeat && !heartbeatStale ? 'pos' : 'neg'}
          title={d.status.error ?? (heartbeat ? `supervisor tick ${clock(heartbeat)} · state ${status?.state ?? '?'}` : 'runtime/pipeline_status.json')}
        />
        <Stat
          label="Dead workers"
          value={status ? String(dead.length) : DASH}
          tone={dead.length > 0 ? 'neg' : status ? 'pos' : undefined}
          title={dead.length ? dead.map(w => w.name).join(', ') : status ? 'all workers alive' : 'no status'}
        />
        {dead.length > 0 && (
          <span className="md-desk-deadlist" title="workers with alive=false">
            {dead.map(w => w.name).join(' · ')}
          </span>
        )}
      </div>

      <div className="md-desk-strip-group md-desk-strip-money">
        <Stat label="Balance" value={usd(portfolio?.balance)} title={d.portfolio.error ?? `broker balance · ${clock(portfolio?.updated)}`} />
        <Stat label="Exposure" value={usd(portfolio?.exposure)} title="open market exposure (portfolio.total_exposure_dollars)" />
        <Stat label="Bankroll" value={usd(bankroll)} title={d.bankroll.error ?? `bankroll.json · ${clock(d.bankroll.data?.updated)}`} />
        <Stat label="Saved" value={usd(saved)} title="profits set aside, excluded from trading capital" />
        <Stat label="Fills today" value={portfolio?.fillsToday !== null && portfolio?.fillsToday !== undefined ? String(portfolio.fillsToday) : DASH} />
      </div>
    </div>
  );
}

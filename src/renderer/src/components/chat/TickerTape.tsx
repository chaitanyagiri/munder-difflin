import { useMemo } from 'react';
import { cents, int, usd, usdSigned } from '../trading/format';
import type { TradingData } from '../trading/useTradingData';

interface Tick { label: string; value: string; tone?: 'up' | 'down' | 'flat' }

function ticks(d: TradingData): Tick[] {
  const out: Tick[] = [];
  const p = d.portfolio.data;
  const mode = d.mode.data?.mode;
  const control = d.control.data?.state;
  if (mode) out.push({ label: 'Mode', value: mode.toUpperCase(), tone: mode.toLowerCase() === 'live' ? 'up' : 'flat' });
  if (control) out.push({ label: 'Pipeline', value: control, tone: control === 'running' ? 'up' : 'down' });
  if (p) {
    out.push({ label: 'Balance', value: usd(p.balance) });
    out.push({ label: 'Exposure', value: usd(p.exposure) });
    if (p.realized !== null) {
      out.push({ label: 'Realized', value: usdSigned(p.realized), tone: p.realized > 0 ? 'up' : p.realized < 0 ? 'down' : 'flat' });
    }
    if (p.fillsToday !== null) out.push({ label: 'Fills today', value: int(p.fillsToday) });
    for (const pos of p.positions.filter(x => x.exposure > 0).slice(0, 8)) {
      out.push({ label: pos.ticker, value: `${pos.positionFp > 0 ? 'YES' : 'NO'} ${usd(pos.exposure)}` });
    }
  }
  const fills = (d.executions.data?.rows ?? []).filter(r => r.success === true).slice(0, 5);
  for (const f of fills) {
    out.push({ label: 'Filled', value: `${f.ticker} ${f.side.toUpperCase()} ${f.contracts ?? '?'} @ ${cents(f.price)}`, tone: 'up' });
  }
  const cands = d.candidates.data?.markets.length ?? 0;
  if (cands) out.push({ label: 'Watching', value: `${cands} markets` });
  return out;
}

export function TickerTape({ d }: { d: TradingData }) {
  const items = useMemo(() => ticks(d), [d]);
  if (items.length === 0) {
    return <div className="md-tape is-empty" aria-hidden="true"><span>Trading desk offline</span></div>;
  }
  const row = (k: string) => items.map((t, i) => (
    <span key={`${k}-${i}`} className={`md-tape-item${t.tone ? ` is-${t.tone}` : ''}`}>
      <span className="md-tape-label">{t.label}</span>
      <span className="md-tape-value">{t.value}</span>
    </span>
  ));
  return (
    <div className="md-tape" aria-hidden="true">
      <div className="md-tape-track" style={{ animationDuration: `${Math.max(24, items.length * 4)}s` }}>
        {row('a')}{row('b')}
      </div>
    </div>
  );
}

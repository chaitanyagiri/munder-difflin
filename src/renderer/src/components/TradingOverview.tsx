import { useEffect, useState } from 'react';

// The Kalshi desk's own files. Read through the sandboxed fs:readFile IPC —
// root-confined and size-capped main-side, so the renderer never writes here.
const KALSHI_ROOT = 'C:/Users/chrom/AppData/Local/hermes/skills/trading/kalshi';

type PositionRow = {
  ticker?: string;
  title?: string;
  market_exposure_dollars?: string;
  realized_pnl_dollars?: string;
  fees_paid_dollars?: string;
  total_traded_dollars?: string;
};

type Portfolio = {
  updated?: string;
  balance_dollars?: string | number;
  total_exposure_dollars?: string | number;
  realized_pnl_dollars?: string | number;
  positions?: PositionRow[];
  saved_profits_dollars?: number;
  fills_today_count?: number | null;
};

async function readJson(name: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await window.cth.readFile(KALSHI_ROOT, name);
    if (!r.ok) return null;
    return JSON.parse(r.content);
  } catch { return null; }
}

async function readJsonl(name: string): Promise<Record<string, unknown>[]> {
  try {
    const r = await window.cth.readFile(KALSHI_ROOT, name);
    if (!r.ok) return [];
    return jsonl(r.content);
  } catch { return []; }
}

/** Parse a JSONL stream, recovering literal-\n separators and torn appends the
 *  same way the trader does: one bad line must not sink the whole file. */
function jsonl(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (start < 0) {
      if (c === '{') { start = i; depth = 1; }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    if (depth === 0) {
      try { out.push(JSON.parse(text.slice(start, i + 1))); } catch {}
      start = -1;
    }
  }
  return out;
}

const usd = (n: unknown): string => {
  const v = typeof n === 'string' ? parseFloat(n) : typeof n === 'number' ? n : NaN;
  return Number.isFinite(v) ? `$${v.toFixed(2)}` : '—';
};

const ACCENTS = ['mint', 'sky', 'lilac', 'peach', 'coral', 'lemon'] as const;

/** A deterministic visual identity per market: the series' initials on a stable
 *  accent colour (hashed from the series ticker, so the same market always
 *  wears the same tile). Kalshi ships no image assets for these markets. */
function MarketBadge({ ticker }: { ticker: string }) {
  const series = ticker.split('-')[0] ?? ticker;
  let hash = 0;
  for (let i = 0; i < series.length; i++) hash = (hash * 31 + series.charCodeAt(i)) >>> 0;
  const accent = ACCENTS[hash % ACCENTS.length];
  const initials = series.replace(/^KX/, '').slice(0, 2).toUpperCase() || series.slice(0, 2).toUpperCase();
  return (
    <span
      title={series}
      style={{
        width: 34, height: 26, flexShrink: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: `var(--cth-${accent}-light)`,
        boxShadow: `inset 0 0 0 1px var(--cth-${accent})`,
        borderRadius: 6,
        fontFamily: 'var(--cth-font-display)', fontSize: 9, fontWeight: 700,
        color: 'var(--cth-ink-900)', letterSpacing: '.04em',
      }}
    >
      {initials}
    </span>
  );
}

const time = (iso: string | undefined): string =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

/** Trading desk signals: live bankroll, trading mode, the review funnel, and the
 *  ACTUAL open positions mirrored from the authenticated portfolio snapshot. */
export function TradingOverview() {
  const [bankroll, setBankroll] = useState<{ live?: number; updated?: string } | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [funnel, setFunnel] = useState<{ packets?: number; reviewed?: number; submitted?: number } | null>(null);
  const [positionsExpanded, setPositionsExpanded] = useState(() => innerHeight >= 740);

  useEffect(() => {
    const query = matchMedia('(min-height: 740px)');
    const change = () => setPositionsExpanded(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [bp, tm, pf, events] = await Promise.all([
        readJson('bankroll.json'),
        readJson('trading_mode.json'),
        readJson('portfolio.json'),
        readJsonl('autonomous_trader_events.jsonl'),
      ]);
      if (!alive) return;
      setBankroll({
        live: typeof bp?.bankroll === 'number' ? bp.bankroll : undefined,
        updated: typeof bp?.updated === 'string' ? bp.updated : undefined,
      });
      setMode(typeof tm?.mode === 'string' ? tm.mode : null);
      if (pf) setPortfolio(pf as unknown as Portfolio);
      const complete = (events as unknown as { stage?: string }[]).filter((e) => e.stage === 'cycle_complete');
      setFunnel(complete[complete.length - 1] as typeof funnel);
    };
    load();
    const timer = setInterval(load, 30000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const positions = portfolio?.positions ?? [];

  return (
    <>
      <section aria-label="Trading metrics" className="md-metrics" style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10,
      }}>
        <Metric label="Trading capital" value={bankroll?.live !== undefined ? `$${bankroll.live.toFixed(2)}` : '—'}
          detail={portfolio?.updated ? `synced ${time(portfolio.updated)}` : 'awaiting broker sync'} />
        <Metric label="Mode" value={mode ?? '—'}
          detail={mode === 'LIVE' ? 'real funds engaged' : 'paper'} />
        <Metric label="Saved profits" value={usd(portfolio?.saved_profits_dollars)}
          detail="protected cash allocation" />
        <Metric label="Positions" value={portfolio ? String(positions.length) : '—'}
          detail={usd(portfolio?.total_exposure_dollars) + ' exposure'} />
        <Metric label="Fills today" value={portfolio?.fills_today_count != null ? String(portfolio.fills_today_count) : '—'}
          detail={portfolio?.fills_today_count != null ? 'broker confirmed' : 'awaiting broker history'} />
        <Metric label="Review funnel" value={funnel?.reviewed !== undefined ? `${funnel.reviewed}/${funnel.packets ?? '?'}` : '—'}
          detail={funnel?.submitted !== undefined ? `${funnel.submitted} submitted` : 'idle'} />
      </section>

      <details aria-label="Positions" className="md-positions" open={positionsExpanded}
        onToggle={(e) => setPositionsExpanded(e.currentTarget.open)} style={{
        background: 'var(--cth-paper-100)', border: '1px solid var(--cth-ink-300)',
        borderRadius: 10, padding: '10px 12px',
      }}>
        <summary>
          <strong>Open positions · {portfolio ? positions.length : '—'}</strong>
          <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
            {portfolio?.updated ? `live ${time(portfolio.updated)}` : 'waiting for the trader'}
          </span>
        </summary>
        <div className="md-positions-content">
        {positions.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12, color: 'var(--cth-ink-500)' }}>No open positions.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{
              display: 'grid', gridTemplateColumns: '40px minmax(0,1fr) 76px 76px 76px',
              gap: 8, padding: '3px 7px', fontSize: 10, fontWeight: 600,
              letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--cth-ink-500)',
            }}>
              <span />
              <span>Market</span><span style={{ textAlign: 'right' }}>Exposure</span>
              <span style={{ textAlign: 'right' }}>Realized</span><span style={{ textAlign: 'right' }}>Fees</span>
            </div>
            {positions.map((p, i) => {
              const pnl = typeof p.realized_pnl_dollars === 'string' ? parseFloat(p.realized_pnl_dollars) : 0;
              return (
                <div key={p.ticker ?? i} style={{
                  display: 'grid', gridTemplateColumns: '40px minmax(0,1fr) 76px 76px 76px',
                  gap: 8, alignItems: 'center', padding: '6px 7px', borderRadius: 6,
                  background: 'var(--cth-cream-200)',
                }}>
                  <MarketBadge ticker={p.ticker ?? ''} />
                  <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                    <span title={p.title || p.ticker} style={{ fontSize: 12, fontWeight: 600, color: 'var(--cth-ink-900)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {p.title || p.ticker}
                    </span>
                    <span style={{ fontSize: 10, color: 'var(--cth-ink-500)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {p.ticker}
                    </span>
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--cth-ink-700)', fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{usd(p.market_exposure_dollars)}</span>
                  <span style={{ fontSize: 12, fontWeight: 600, fontVariantNumeric: 'tabular-nums', textAlign: 'right', color: pnl > 0 ? 'var(--cth-mint)' : pnl < 0 ? 'var(--cth-coral)' : 'var(--cth-ink-500)' }}>
                    {usd(p.realized_pnl_dollars)}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--cth-ink-500)', fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{usd(p.fees_paid_dollars)}</span>
                </div>
              );
            })}
          </div>
        )}
        </div>
      </details>
    </>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article title={detail} style={{
      background: 'var(--cth-paper-100)', border: '1px solid var(--cth-ink-300)',
      borderRadius: 10, padding: '9px 11px',
    }}>
      <p style={{ margin: 0, fontSize: 11, fontWeight: 600, color: 'var(--cth-ink-500)' }}>{label}</p>
      <strong style={{ display: 'block', marginTop: 4, fontSize: 19, lineHeight: 1, letterSpacing: '-.02em', color: 'var(--cth-ink-900)', fontVariantNumeric: 'tabular-nums' }}>{value}</strong>
      <span style={{ display: 'block', marginTop: 3, fontSize: 11, color: 'var(--cth-ink-500)' }}>{detail}</span>
    </article>
  );
}

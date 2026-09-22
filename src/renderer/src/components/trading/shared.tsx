import { useEffect, useState, type ReactNode } from 'react';
import { DASH, age, clock, isStale } from './format';
import type { FileState } from './useTradingData';

/**
 * A panel on the desk. The header carries the file's own "last updated"
 * (the timestamp the pipeline wrote, not when we read it) and a STALE badge
 * when that is more than five minutes old — or the file could not be read at
 * all. `error` is shown verbatim under the header; the body still renders
 * whatever the last good read produced, so a transient failure does not blank
 * the panel.
 */
export function DeskCard({
  title, file, now, aside, children, className, stale,
}: {
  title: string;
  file: FileState<unknown> | Array<FileState<unknown>>;
  now: number;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Override the stale test — e.g. a switch file whose timestamp is a "set at". */
  stale?: 'auto' | 'never';
}) {
  const files = Array.isArray(file) ? file : [file];
  const updatedAt = files.reduce<number | null>((acc, f) => {
    if (f.updatedAt === null) return acc;
    return acc === null ? f.updatedAt : Math.min(acc, f.updatedAt);
  }, null);
  const errors = files.map(f => f.error).filter((e): e is string => e !== null);
  const missing = files.some(f => f.data === null);
  const staleNow = stale === 'never' ? false : missing || isStale(updatedAt, now);
  return (
    <section className={`md-desk-card${className ? ` ${className}` : ''}`} aria-label={title}>
      <header className="md-desk-card-head">
        <h3>{title}</h3>
        {aside}
        <span className="md-desk-updated" title={updatedAt ? new Date(updatedAt).toISOString() : 'no timestamp'}>
          {updatedAt ? `${clock(updatedAt)} · ${age(updatedAt, now)} ago` : missing ? 'no data' : 'no timestamp'}
        </span>
        {staleNow && <span className="md-desk-badge md-desk-badge-stale">STALE</span>}
      </header>
      {errors.length > 0 && (
        <div className="md-desk-error" role="alert">
          {errors.map((e, i) => <div key={i}>{e}</div>)}
        </div>
      )}
      <div className="md-desk-card-body">{children}</div>
    </section>
  );
}

/** A key/value pair in the header strip or a card. */
export function Stat({ label, value, tone, title }: { label: string; value: ReactNode; tone?: 'pos' | 'neg' | 'warn' | 'live'; title?: string }) {
  return (
    <div className="md-desk-stat" title={title}>
      <span className="md-desk-stat-label">{label}</span>
      <span className={`md-desk-num${tone ? ` md-desk-${tone}` : ''}`}>{value}</span>
    </div>
  );
}

/** Ticker text that copies itself on click; no Kalshi deep link is reliable
 *  from a ticker alone, so the trader pastes it into the exchange's search. */
export function CopyTicker({ ticker }: { ticker: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  if (!ticker) return <span className="md-desk-muted">{DASH}</span>;
  return (
    <button
      type="button"
      className={`md-desk-ticker${copied ? ' md-desk-ticker-copied' : ''}`}
      title={copied ? 'Copied' : `Copy ${ticker}`}
      onClick={() => {
        navigator.clipboard?.writeText(ticker).then(() => setCopied(true)).catch(() => { /* clipboard unavailable */ });
      }}
    >
      {ticker}
    </button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="md-desk-empty">{children}</div>;
}

export function toneFor(n: number | null | undefined): 'pos' | 'neg' | undefined {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return undefined;
  return n > 0 ? 'pos' : 'neg';
}

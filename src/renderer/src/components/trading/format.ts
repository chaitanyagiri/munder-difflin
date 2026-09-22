/** Number and time formatting for the desk. Every formatter returns "—" for
 *  a missing value rather than a fake zero — a blank is information, a 0 is a
 *  claim. */

export const DASH = '—';

export function usd(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(digits)}`;
}

/** Signed dollars with an explicit + so P&L reads at a glance. */
export function usdSigned(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  const sign = n < 0 ? '-' : n > 0 ? '+' : '';
  return `${sign}$${Math.abs(n).toFixed(digits)}`;
}

/** A price fraction (0.18) as cents (18¢). */
export function cents(frac: number | null | undefined, digits = 0): string {
  if (frac === null || frac === undefined || !Number.isFinite(frac)) return DASH;
  return `${(frac * 100).toFixed(digits)}¢`;
}

export function pct(frac: number | null | undefined, digits = 0): string {
  if (frac === null || frac === undefined || !Number.isFinite(frac)) return DASH;
  return `${(frac * 100).toFixed(digits)}%`;
}

export function int(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  return String(Math.round(n));
}

/** Compact age: 12s, 4m, 2h, 3d. Never negative — a clock skew reads as "0s". */
export function age(from: number | null | undefined, now: number): string {
  if (from === null || from === undefined || !Number.isFinite(from)) return DASH;
  const s = Math.max(0, Math.floor((now - from) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `${Math.floor(h / 24)}d`;
}

const timeFmt = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dateTimeFmt = new Intl.DateTimeFormat([], {
  month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});

export function clock(t: number | null | undefined): string {
  if (t === null || t === undefined || !Number.isFinite(t)) return DASH;
  return timeFmt.format(t);
}

export function dateTime(t: number | null | undefined): string {
  if (t === null || t === undefined || !Number.isFinite(t)) return DASH;
  return dateTimeFmt.format(t);
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

export const STALE_AFTER_MS = 5 * 60 * 1000;

export function isStale(updatedAt: number | null | undefined, now: number): boolean {
  return updatedAt === null || updatedAt === undefined || now - updatedAt > STALE_AFTER_MS;
}

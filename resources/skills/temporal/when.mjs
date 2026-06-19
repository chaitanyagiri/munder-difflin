#!/usr/bin/env node
// when.mjs — temporal range resolver for spawned hive workers.
//
// Single source of truth for every /today, /yesterday, /thisWeek, /last30Days …
// skill. Resolves named windows to CONCRETE ISO date ranges relative to the
// worker's run time (`new Date()` at invocation), so a worker never re-derives
// dates by hand.
//
// READ-ONLY: computes and prints to stdout. Never writes a file, never touches
// the network. Pure Node stdlib (no deps), runs anywhere Node is on PATH.
//
// Usage:
//   node when.mjs                  # print ALL windows (human lines + JSON array)
//   node when.mjs today            # one window
//   node when.mjs last30Days q2... # several windows
//   node when.mjs --json last7Days # JSON only (machine-readable)
//   node when.mjs --list           # list supported window keywords
//
// Generic windows: lastNdays / lastNweeks / lastNmonths (e.g. last45days,
// last2weeks, last6months) and the aliases ytd/qtd/mtd/wtd, 7d/30d/90d, 12m.
//
// Day boundaries are the worker's LOCAL civil days. Each result carries both the
// inclusive civil dates (start/end, YYYY-MM-DD) and the precise UTC instants of
// the half-open window [startUtc, endExclusiveUtc) for timestamp-based queries.

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
// A local civil day at midnight. JS Date normalizes out-of-range fields
// (e.g. day 0 → last day of prior month, month 12 → January next year), which
// is exactly what we want for month/quarter/year arithmetic.
const civ = (y, m, d) => new Date(y, m, d);
const fmt = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;

const TODAY = civ(now.getFullYear(), now.getMonth(), now.getDate());
const Y = TODAY.getFullYear();
const M = TODAY.getMonth();
const D = TODAY.getDate();
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'; } catch { return 'local'; } })();
const TZ_OFFSET_MIN = -now.getTimezoneOffset(); // conventional sign: UTC-7 → -420

// Days back from TODAY to the most recent Monday (ISO weeks start Monday).
const mondayOffset = (dt) => (dt.getDay() + 6) % 7;

// Each builder returns { label, start: Date, end: Date } where start/end are
// LOCAL midnights and `end` is the INCLUSIVE last day of the window.
const WINDOWS = {
  today:        () => ({ label: 'Today',          start: civ(Y, M, D),     end: civ(Y, M, D) }),
  yesterday:    () => ({ label: 'Yesterday',      start: civ(Y, M, D - 1), end: civ(Y, M, D - 1) }),
  thisWeek:     () => ({ label: 'This week (to date)', start: civ(Y, M, D - mondayOffset(TODAY)), end: civ(Y, M, D) }),
  lastWeek:     () => { const mon = civ(Y, M, D - mondayOffset(TODAY) - 7); return { label: 'Last week', start: mon, end: civ(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6) }; },
  last7Days:    () => ({ label: 'Last 7 days',    start: civ(Y, M, D - 6),  end: civ(Y, M, D) }),
  last30Days:   () => ({ label: 'Last 30 days',   start: civ(Y, M, D - 29), end: civ(Y, M, D) }),
  last90Days:   () => ({ label: 'Last 90 days',   start: civ(Y, M, D - 89), end: civ(Y, M, D) }),
  thisMonth:    () => ({ label: 'This month (to date)', start: civ(Y, M, 1), end: civ(Y, M, D) }),
  lastMonth:    () => ({ label: 'Last month',     start: civ(Y, M - 1, 1),  end: civ(Y, M, 0) }),
  thisQuarter:  () => ({ label: 'This quarter (to date)', start: civ(Y, Math.floor(M / 3) * 3, 1), end: civ(Y, M, D) }),
  lastQuarter:  () => { const qs = Math.floor(M / 3) * 3 - 3; return { label: 'Last quarter', start: civ(Y, qs, 1), end: civ(Y, qs + 3, 0) }; },
  thisYear:     () => ({ label: 'This year (to date)', start: civ(Y, 0, 1), end: civ(Y, M, D) }),
  lastYear:     () => ({ label: 'Last year',      start: civ(Y - 1, 0, 1),  end: civ(Y - 1, 11, 31) }),
  last12Months: () => ({ label: 'Last 12 months', start: civ(Y - 1, M, D + 1), end: civ(Y, M, D) })
};

// Aliases → canonical keys.
const ALIASES = {
  ytd: 'thisYear', qtd: 'thisQuarter', mtd: 'thisMonth', wtd: 'thisWeek',
  '7d': 'last7Days', '30d': 'last30Days', '90d': 'last90Days', '12m': 'last12Months',
  thisweek: 'thisWeek', lastweek: 'lastWeek', thismonth: 'thisMonth', lastmonth: 'lastMonth',
  thisquarter: 'thisQuarter', lastquarter: 'lastQuarter', thisyear: 'thisYear', lastyear: 'lastYear',
  last7days: 'last7Days', last30days: 'last30Days', last90days: 'last90Days', last12months: 'last12Months'
};

// Resolve one keyword → a { label, start, end } window, including generic
// lastN{days,weeks,months} forms. Returns null for an unknown keyword.
function build(key) {
  const raw = String(key).trim();
  const k = raw.toLowerCase();
  if (WINDOWS[raw]) return WINDOWS[raw]();
  if (ALIASES[k]) return WINDOWS[ALIASES[k]]();
  // canonical-key, case-insensitive
  const ci = Object.keys(WINDOWS).find((w) => w.toLowerCase() === k);
  if (ci) return WINDOWS[ci]();
  let m;
  if ((m = k.match(/^last(\d+)days?$/)))  { const n = +m[1]; return { label: `Last ${n} days`,  start: civ(Y, M, D - (n - 1)), end: civ(Y, M, D) }; }
  if ((m = k.match(/^last(\d+)weeks?$/))) { const n = +m[1]; return { label: `Last ${n} weeks`, start: civ(Y, M, D - (n * 7 - 1)), end: civ(Y, M, D) }; }
  if ((m = k.match(/^last(\d+)months?$/))){ const n = +m[1]; return { label: `Last ${n} months`, start: civ(Y, M - n, D + 1), end: civ(Y, M, D) }; }
  return null;
}

// Shape one window into the concrete, query-ready record.
function resolve(key) {
  const w = build(key);
  if (!w) return null;
  const endExclusive = civ(w.end.getFullYear(), w.end.getMonth(), w.end.getDate() + 1);
  const days = Math.round((endExclusive - w.start) / 86400000);
  return {
    window: key,
    label: w.label,
    start: fmt(w.start),
    end: fmt(w.end),
    inclusive: true,
    startUtc: w.start.toISOString(),
    endExclusiveUtc: endExclusive.toISOString(),
    days,
    asOf: now.toISOString(),
    timezone: TZ,
    tzOffsetMinutes: TZ_OFFSET_MIN
  };
}

const ORDER = Object.keys(WINDOWS);

function main() {
  const argv = process.argv.slice(2);
  const jsonOnly = argv.includes('--json');
  if (argv.includes('--list')) {
    process.stdout.write(`Supported windows:\n  ${ORDER.join(', ')}\n` +
      `Generic: lastNdays, lastNweeks, lastNmonths (e.g. last45days, last2weeks, last6months)\n` +
      `Aliases: ytd, qtd, mtd, wtd, 7d, 30d, 90d, 12m\n`);
    return;
  }
  const keys = argv.filter((a) => !a.startsWith('--'));
  const requested = keys.length ? keys : ORDER;
  const results = [];
  const unknown = [];
  for (const k of requested) {
    const r = resolve(k);
    if (r) results.push(r); else unknown.push(k);
  }
  if (jsonOnly) {
    process.stdout.write(JSON.stringify(results.length === 1 ? results[0] : results, null, 2) + '\n');
  } else {
    for (const r of results) {
      process.stdout.write(`${r.label}: ${r.start} → ${r.end}  (inclusive, ${r.days} day${r.days === 1 ? '' : 's'}, ${r.timezone})\n`);
    }
    process.stdout.write('\n' + JSON.stringify(results.length === 1 ? results[0] : results, null, 2) + '\n');
  }
  if (unknown.length) {
    process.stderr.write(`\n[when] unknown window(s): ${unknown.join(', ')} — run \`node when.mjs --list\` for options.\n`);
    process.exitCode = 2;
  }
}

main();

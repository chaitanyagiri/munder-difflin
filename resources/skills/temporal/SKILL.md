---
name: temporal
description: |
  Resolve ANY named time window — today, yesterday, thisWeek, lastWeek,
  last7Days, last30Days, last90Days, thisMonth, lastMonth, thisQuarter,
  lastQuarter, thisYear, lastYear, last12Months — or an arbitrary range
  (lastNdays / lastNweeks / lastNmonths) to a concrete ISO date range relative
  to your run time. Read-only: no writes, no network. Use whenever a task is
  time-scoped and you need exact start/end dates without computing them by hand.
allowed-tools:
  - Bash
---

## /temporal — concrete date ranges, relative to now

This is the single source of truth for "what dates does *<window>* mean right
now?". It resolves named windows to **concrete ISO date ranges relative to your
run time** (`new Date()` at the moment you invoke it), so you never re-derive
dates manually. It only reads the clock and prints — no files written, no network.

### Run it

```bash
# all windows at once (a quick temporal-context dump)
node "$AGENT_DIR/.claude/skills/temporal/when.mjs"

# one or several specific windows
node "$AGENT_DIR/.claude/skills/temporal/when.mjs" last30Days thisQuarter

# JSON only (machine-readable), or list the supported keywords
node "$AGENT_DIR/.claude/skills/temporal/when.mjs" --json last7Days
node "$AGENT_DIR/.claude/skills/temporal/when.mjs" --list
```

If `$AGENT_DIR` is somehow unset, the script also lives under
`~/.claude/skills/temporal/when.mjs`.

### Windows

| Keyword | Meaning |
| --- | --- |
| `today` / `yesterday` | the single civil day |
| `thisWeek` / `lastWeek` | ISO week (Mon-start); *this* = Mon→today, *last* = the full prior Mon→Sun |
| `last7Days` / `last30Days` / `last90Days` | rolling N-day window ending today (inclusive) |
| `thisMonth` / `lastMonth` | *this* = 1st→today; *last* = the full prior calendar month |
| `thisQuarter` / `lastQuarter` | *this* = quarter-start→today; *last* = the full prior quarter |
| `thisYear` / `lastYear` | *this* = Jan 1→today (YTD); *last* = the full prior year |
| `last12Months` | rolling 12 months ending today |
| `lastNdays` / `lastNweeks` / `lastNmonths` | arbitrary rolling window, e.g. `last45days`, `last2weeks`, `last6months` |

Aliases: `ytd`, `qtd`, `mtd`, `wtd`, `7d`, `30d`, `90d`, `12m`.

Convention: `this*` windows are **period-start → today** (to-date); `last*`
named periods are the **full prior complete period**.

### Output

Each window prints a human line plus a JSON record:

- `start` / `end` — inclusive civil dates (`YYYY-MM-DD`) in your local timezone
- `startUtc` / `endExclusiveUtc` — the same span as a half-open `[start, end)`
  range of exact UTC instants, ideal for timestamp / `createdAt`-style queries
- `days`, `inclusive`, `timezone`, `tzOffsetMinutes`, `asOf` — span, tz, and the
  instant the range was resolved

Use the returned dates as the time bounds for the task. The named shortcuts
`/today`, `/yesterday`, `/last30Days`, `/lastQuarter`, … each call this same
resolver for their one window.

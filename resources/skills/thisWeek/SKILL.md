---
name: thisWeek
description: |
  Resolve "thisWeek" to a concrete ISO date range relative to your run time —
  this week so far (Monday → today). Returns inclusive civil dates plus exact UTC instants so you have
  temporal context without computing dates by hand. Read-only: no writes, no
  network. Use before a week-to-date task (this week's activity, weekly standups).
allowed-tools:
  - Bash
---

## /thisWeek

Get the concrete date range for **this week so far (Monday → today)** by running the bundled resolver:

```bash
node "$AGENT_DIR/.claude/skills/temporal/when.mjs" thisWeek
```

It prints a human-readable line plus a JSON record:

- `start` / `end` — inclusive civil dates (`YYYY-MM-DD`) in your local timezone
- `startUtc` / `endExclusiveUtc` — the same window as a half-open `[start, end)`
  range of exact UTC instants, for timestamp-based queries
- `days`, `timezone`, `asOf` — the span, your timezone, and when this resolved

Use the returned dates as the time bounds for the task at hand. **Do not derive
dates by hand** — this resolver is the source of truth. For the full window list
or an arbitrary range (e.g. `last45days`, `last6months`), see the `/temporal` skill.

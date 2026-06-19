---
name: thisQuarter
description: |
  Resolve "thisQuarter" to a concrete ISO date range relative to your run time —
  this quarter so far (quarter start → today). Returns inclusive civil dates plus exact UTC instants so you have
  temporal context without computing dates by hand. Read-only: no writes, no
  network. Use before a quarter-to-date task (QTD metrics, "this quarter").
allowed-tools:
  - Bash
---

## /thisQuarter

Get the concrete date range for **this quarter so far (quarter start → today)** by running the bundled resolver:

```bash
node "$AGENT_DIR/.claude/skills/temporal/when.mjs" thisQuarter
```

It prints a human-readable line plus a JSON record:

- `start` / `end` — inclusive civil dates (`YYYY-MM-DD`) in your local timezone
- `startUtc` / `endExclusiveUtc` — the same window as a half-open `[start, end)`
  range of exact UTC instants, for timestamp-based queries
- `days`, `timezone`, `asOf` — the span, your timezone, and when this resolved

Use the returned dates as the time bounds for the task at hand. **Do not derive
dates by hand** — this resolver is the source of truth. For the full window list
or an arbitrary range (e.g. `last45days`, `last6months`), see the `/temporal` skill.

---
name: capabilities
description: |
  Your capability catalog — read this at boot. Lists the temporal date-range
  skills and the external integrations (reached via the loopback broker)
  available to you as a spawned worker, and exactly how to call each. Read-only.
  Consult it whenever you're unsure what tools/integrations you have or how to
  invoke them.
allowed-tools:
  - Bash
---

# Worker Capability Catalog

You are an autonomous worker spawned by the hive to do one objective and report
back. This catalog tells you **what you can do and how to call it** — your
temporal skills and your external integrations — so you don't have to guess.
Everything here is read-only to invoke (the integrations themselves may act, but
they are mediated and credential-free from your side).

## 1. Your environment

The harness injects these env vars (use them; don't hard-code paths):

- `AGENT_ID`, `AGENT_NAME` — your identity in the hive.
- `AGENT_DIR` — your private workspace (`identity.md`, `memory.md`, `inbox/`,
  `outbox/`, and `.claude/skills/`). Your bundled skills live under
  `$AGENT_DIR/.claude/skills/`.
- `HIVE_ROOT` — the shared hive (`PROTOCOL.md`, the kanban, other agents).

At boot you also have `identity.md` (who you are) and `HIVE_ROOT/PROTOCOL.md`
(the full coordination protocol). To message god or another agent, write ONE
message JSON into `$AGENT_DIR/outbox/` (schema in PROTOCOL.md). When finished,
send god an `"act":"done"` outbox message with a substantive result summary.

## 2. Temporal skills — concrete date ranges, relative to now

When your task is time-scoped, resolve the dates instead of computing them by
hand. Each skill prints inclusive civil dates (`YYYY-MM-DD`, your local
timezone) **and** the half-open `[startUtc, endExclusiveUtc)` instants for
timestamp queries. All are read-only (clock + stdout only; no writes, no network).

Named shortcuts (invoke directly):

| Skill | Range it resolves |
| --- | --- |
| `/today`, `/yesterday` | the single civil day |
| `/thisWeek`, `/lastWeek` | ISO week (Mon-start); this = Mon→today, last = prior full week |
| `/last7Days`, `/last30Days` | rolling N-day window ending today |
| `/thisMonth`, `/lastMonth` | this = 1st→today; last = prior full month |
| `/thisQuarter`, `/lastQuarter` | this = quarter-start→today; last = prior full quarter |
| `/thisYear`, `/lastYear` | this = Jan 1→today (YTD); last = prior full year |

For **any** window — including `last90Days`, `last12Months`, or arbitrary
`lastNdays` / `lastNweeks` / `lastNmonths` — use `/temporal`, or call the
resolver directly:

```bash
node "$AGENT_DIR/.claude/skills/temporal/when.mjs" last30Days   # one window
node "$AGENT_DIR/.claude/skills/temporal/when.mjs"             # all windows
node "$AGENT_DIR/.claude/skills/temporal/when.mjs" --json 90d  # JSON only
node "$AGENT_DIR/.claude/skills/temporal/when.mjs" --list      # keywords
```

Convention: `this*` windows are **period-start → today** (to-date); `last*`
named periods are the **full prior complete period**.

## 3. Integrations — via the loopback broker

External services are reached through the hive's **loopback broker**: a local,
authenticated endpoint the harness runs on `127.0.0.1`. You call the broker; it
holds the credentials and performs the outbound call on your behalf. You never
see or store a secret, and only loopback callers are accepted — so integration
access is brokered, auditable, and credential-free from your side.

How integrations are surfaced to you is **environment-dependent** — the exact
set enabled depends on how you were spawned and the hive's configuration — so
discover what's live at run time rather than assuming. The broker pattern is
stable even as specific integrations are added; treat the list below as the
current surface, not a fixed contract.

Concrete capabilities you may have right now (check availability before relying
on one):

- **Reply to the originating Slack thread.** If your objective arrived from
  Slack, your dispatch includes the exact loopback reply command —
  `node "<helper>" --channel <C> --thread <T> --text "<mrkdwn>"`. Use *that*
  command verbatim to post your result back to the thread. Send a substantive
  reply (a short `*bold*` headline + the actual outcome/links), never a bare
  "done".
- **Hive messaging.** Coordinate or hand off by writing an outbox message JSON
  to god or another agent (`$AGENT_DIR/outbox/`). This is your always-available
  channel.
- **Semantic memory (MemPalace).** If enabled for you: `mempalace search
  "<query>"` to recall shared knowledge, `mempalace wake-up` for a digest.
- **Enterprise Knowledge Graph.** If enabled: `node "$KG_CLI" search "<query>"`
  for ranked passages, `node "$KG_CLI" list`, `node "$KG_CLI" get <id>` — use it
  for company-specific facts instead of guessing.
- **MCP integrations** (filesystem, git, and others) come pre-wired into your
  session settings when enabled; invoke them as normal tools. The set is gated
  by the hive's consent configuration.

As additional brokered integrations land (calendar, mail, docs, web fetch, …),
they follow the same shape: a brokered, credential-free call discoverable at run
time. Pair them with the temporal skills above — resolve the date window first,
then pass those concrete ISO bounds to the integration query.

## 4. Boundaries

- Temporal skills are **read-only** helpers — they never write or reach the
  network. The broker mediates all external calls; you hold no credentials.
- Do **not** push or tag to any remote. Commit locally; **god** is the sole
  integrator. Pause only for high-severity actions (remote push, paid/infra
  changes, deleting something you didn't create) — otherwise work autonomously.
- Finish by reporting to god (`"act":"done"`) with a real, substantive summary.

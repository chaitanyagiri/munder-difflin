# Munder Difflin — working notes

An Electron + React desktop app. Workforce status is rendered as accessible DOM cards;
agent terminals are xterm.js.

## Change log

- 2026-09-13: Expanded the price-blind discovery set with live financial series
  (S&P 500, USD/JPY, and EUR/USD) and diversified each external research cohort by
  correlation cluster and category. Researchers now use contract-specific primary
  source guidance instead of weather-only instructions.
- 2026-09-13: Tightened external research ingestion: only active-cohort artifacts
  are read while a current contract exists, strict producer prompts require literal
  numeric fields and an exact UTC timestamp, and fresh discovery refreshes every ten
  minutes after a completed cohort. Invalid research remains bridge-blocked.
- 2026-09-13: Repaired the external autonomous trading runner's dead-worker recovery:
  its PID lock is now reclaimed only after the recorded owner is proven absent, so a
  stopped hidden worker cannot suppress later research-to-review cycles. The runner
  is supervised every five minutes, consumes only bridge-provenanced fresh research,
  preserves one-order-per-cycle limits, and keeps rejected candidates out of execution.
- 2026-09-13: Hardened the live queue so legacy/manual rows cannot consume fresh
  research capacity. Each bridged research packet has a 20-minute decision window;
  stale packets are rejected before market context or order execution is requested.
- 2026-09-13: Hardened the external Munder worker launcher: each operational watcher
  now has a single recorded PID, starts with Windows `CREATE_NO_WINDOW`, and writes to
  a worker log instead of opening a console. Retired the stale visual watchdog because
  its snapshot restore path could overwrite the SaaS dashboard.
- 2026-09-13: Reworked the main workspace into a SaaS-style operating dashboard with
  workforce metrics, direct agent routing, and the existing queue-backed chat composer
  in the central window. The chat keeps its normal delivery and attachment behavior.
- 2026-09-13: Removed the canvas office renderer, tile maps, portrait art, theme controls,
  pixel-specific components, bundled display font, and `pixi.js` dependency. The main view
  is now a lightweight DOM workforce overview; live worker and terminal controls are unchanged.

## Current work: Kalshi live trading and strategy upgrade

The company discovers, evaluates, and executes real prediction market orders through `munder-kalshi`.
Follow `C:/Users/chrom/AppData/Local/hermes/skills/trading/kalshi/ALL_MARKET_WORKFLOW.md`.
Use GET_SERIES_LIST/GET_EVENTS/SCAN_MARKETS/GET_MARKETS for discovery, GET_RESEARCH_PACKET
for blind evidence, GET_PORTFOLIO_SUMMARY for live positions and balances, and EVALUATE_MARKET for fee/depth-aware proposals.

### Live real-funds trading
Live order execution is active in `LIVE` mode with real authenticated funds on Kalshi v2 API.
Query `GET_PORTFOLIO_SUMMARY` immediately before describing the available balance or a fill.
Dwight enforces strict portfolio gates:
- Maximum 5.0% bankroll risk per contract.
- Minimum 40.0% hard cash reserve.
- Minimum net edge >= 5.0¢ after fees.
- Daily drawdown circuit breaker (15%).
- Complete order audit trail written to `C:/Users/chrom/.kalshi/orders.log`.
- All live submissions and fills broadcast directly to the office group chat via `md_say.py`.
- **Fresh market-integrity clearance is mandatory.** `execute.py` rejects a LIVE order
  unless its attached watchdog action is `ALLOW`; `HOLD_FOR_REVIEW` and `BLOCK_TRADE`
  are non-executable. Public order-book signals can flag suspicious patterns, but never
  identify a whale, an insider, or intent.
- **Status:** Live credentials and submission path are enabled, but no fill is confirmed.
  Verify `orders_submitted` and `live_order_submission` in the verifier output before claiming a trade.

### Strategy upgrade: Multi-agent quantitative intelligence
The company's roles have been upgraded into a specialized prediction market fund:
- **Toby (Market-Integrity Watchdog)**: Assesses contract ambiguity, supplied-baseline volume surges, concentrated displayed-book skew, and price shocks; emits `ALLOW`, `HOLD_FOR_REVIEW`, or `BLOCK_TRADE` rather than an accusation or trade direction.
- **Phyllis & Meredith (Deep Public Research)**: Mines authoritative public data (FRED, BLS CPI/NFP, NOAA NBM, SEC EDGAR) for empirical base rates.
- **Jim & Kevin (Pattern Recognition & Microstructure)**: Tracks momentum price shocks (>= 10¢ within 15 min), dead-band oscillations, and spread arbitrage.
- **Pam & Ryan (Social Media & Reddit Radar)**: Scrapes `r/Kalshi`, `r/wallstreetbets`, `r/economics` for narrative velocity and contrarian herd alerts.
- **Oscar & Angela (Advanced Math, Bayesian Engine & Coherence)**: Bayesian prior updates, probability coherence enforcer ($\sum P_i \le 1.0$), and out-of-sample Brier skill scoring.
- **Creed (Adversarial Red-Teaming)**: Generates structured bear cases and applies uncertainty haircuts to positive-edge proposals.
- **Dwight & Michael (Risk Governance & Executive Coordination)**: Sizing enforcement, bottom bar synchronization, and continuous office chat utilization.
- **Focused safety suite**: 33 watchdog/review/execution tests pass; the Kalshi MCP suite has 20 passing tests and its deployed verification records the actual live/read-write mode without submitting orders.

### Recursive self-improvement (perpetual background loop)
The ensemble calibrates itself forever after every resolved market:
- `model/recursive_learner.py` — computes per-agent Brier Skill Scores post-settlement, applies EMA weight updates (α=0.15), extracts category biases.
- `model/bayesian_engine.py` — `combine_evidence_signals()` loads live weights from `agent_weights.json`; no agent weight is hardcoded.
- `scripts/md_self_improve.py` — perpetual daemon (every 15 minutes): runs learning cycle, broadcasts weight changes to office chat via Oscar.
- `scripts/md_launch.cmd` — starts `md_self_improve.py --watch 900` automatically alongside all other daemons.
- Agent weights persist to `model/agent_weights.json`; category biases persist to `model/learned_rules.json`.

## Local project locations

| Surface | Location |
|---|---|
| Source checkout (this project) | `C:/Users/chrom/src/munder-difflin` |
| Desktop folder link to this checkout | `C:/Users/chrom/Desktop/Munder Difflin` |
| Active research, integrations and scripts | `C:/Users/chrom/AppData/Local/hermes` |
| Agent roster and coordination | `C:/Users/chrom/HarnessAgents/hive` |
| Installed app | `C:/Users/chrom/AppData/Local/Programs/munder-difflin` |

The Desktop folder is a Windows junction to this checkout. Edits there change these same
source files; it is not a separate copy. Installed renderer patches and running agent
paths remain separate. For installed-app changes follow the workshop's `apply.py` cycle
at `C:/Users/chrom/AppData/Local/hermes/skills/software-development/munder-difflin/`.

## Commands

```bash
npm run dev              # electron-vite dev
npm run build            # build + copy main assets
npm run typecheck        # node + web tsconfigs, both must pass
npm run test:focused     # node --test test/*.test.cjs
```

Run `typecheck` and `test:focused` before committing renderer changes. Verify the installed
desktop build separately from the source build when a user-facing change is involved.

## Debugging a running instance

The app is an Electron window, so ordinary browser tooling cannot reach it. Launch with
`--remote-debugging-port=9333` and drive it over CDP — screenshot it, evaluate in it, and
read `window.__mdApp` plus the worker and terminal state.

Verifying a visual change by reading the diff does not work here. Inspect the running UI.

## Scope note

This checkout is the app's source. The *installed* build is patched separately and those
patches are not part of this repo; do not try to reconcile the two by editing here.

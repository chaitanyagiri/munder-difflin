# Munder Difflin — working notes

An Electron + React + Pixi.js v8 desktop app. The office floor is a Tiled map rendered
with Pixi; agent terminals are xterm.js.

## Current work: Kalshi live trading and strategy upgrade

The company discovers, evaluates, and executes real prediction market orders through `munder-kalshi`.
Follow `C:/Users/chrom/AppData/Local/hermes/skills/trading/kalshi/ALL_MARKET_WORKFLOW.md`.
Use GET_SERIES_LIST/GET_EVENTS/SCAN_MARKETS/GET_MARKETS for discovery, GET_RESEARCH_PACKET
for blind evidence, GET_PORTFOLIO_SUMMARY for live positions and balances, and EVALUATE_MARKET for fee/depth-aware proposals.

### Live real-funds trading ($49.00 bankroll)
Live order execution is active in `LIVE` mode with real authenticated funds ($49.00) on Kalshi v2 API.
Dwight enforces strict portfolio gates:
- Maximum 5.0% bankroll risk per contract ($2.45 maximum on $49.00 bankroll).
- Minimum 40.0% hard cash reserve ($19.60).
- Minimum net edge >= 5.0¢ after fees.
- Daily drawdown circuit breaker (15%).
- Complete order audit trail written to `C:/Users/chrom/.kalshi/orders.log`.
- All live submissions and fills broadcast directly to the office group chat via `md_say.py`.

### Strategy upgrade: Multi-agent quantitative intelligence
The company's roles have been upgraded into a specialized prediction market fund:
- **Toby (Insider Trading & Regulatory Watchdog)**: Scans volume surges ($Z > 3.0$), orderbook depth skew, and contract ambiguity.
- **Phyllis & Meredith (Deep Public Research)**: Mines authoritative public data (FRED, BLS CPI/NFP, NOAA NBM, SEC EDGAR) for empirical base rates.
- **Jim & Kevin (Pattern Recognition & Microstructure)**: Tracks momentum price shocks (>= 10¢ within 15 min), dead-band oscillations, and spread arbitrage.
- **Pam & Ryan (Social Media & Reddit Radar)**: Scrapes `r/Kalshi`, `r/wallstreetbets`, `r/economics` for narrative velocity and contrarian herd alerts.
- **Oscar & Angela (Advanced Math, Bayesian Engine & Coherence)**: Bayesian prior updates, probability coherence enforcer ($\sum P_i \le 1.0$), and out-of-sample Brier skill scoring.
- **Creed (Adversarial Red-Teaming)**: Generates structured bear cases and applies uncertainty haircuts to positive-edge proposals.
- **Dwight & Michael (Risk Governance & Executive Coordination)**: Sizing enforcement, bottom bar synchronization, and continuous office chat utilization.
- **Test suite**: 57/57 tests passing across watchdog, research, sentiment, pattern, and strategy model test suites.

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

Run `typecheck` and `test:focused` before committing anything under
`src/renderer/src/scene/`. The scene code has no runtime type safety net — a bad cast
surfaces as a frozen or blank canvas, not as an exception.

## The office scene

`src/renderer/src/scene/office/` holds the floor. The pieces that matter:

- **`pathfinding.ts`** — BFS over the walkability grid, then `smoothPath` collapses the
  staircase BFS produces into straight runs using `lineOfSight`.
- **`Character.ts` / `CharacterSprite.ts`** — an agent's movement and its drawn form.

### Diagonals must check both flanks

`lineOfSight` samples at sub-tile resolution and, on any diagonal step, requires *both*
flanking tiles to be walkable. Without that second test a smoothed path slips through the
corner where two walls meet — geometrically valid for a line, visibly wrong for a person,
and something plain BFS can never do because it only moves on the four cardinals. Any
change to smoothing has to keep that check.

`test/office-pathfinding.test.cjs` pins this, including that an exhaustive search of a
large map still terminates and reports no route rather than hanging.

## Two Pixi gotchas that cost real time

1. **The ticker stops.** It stalls roughly 20s after load while still reporting
   `started: true`. Anything that must keep running uses `setInterval`, not the ticker,
   and `window.__mdTicks` is the honest liveness signal — a health check that reads
   `started` will call a dead floor healthy.
2. **Terminals must not take WebGL contexts.** Chromium caps how many exist and evicts
   the *oldest*, which is the office floor created at startup. Raising the cap makes it
   worse: with a full cast the renderer stops answering CDP entirely. xterm renders
   through its DOM renderer instead, so the floor keeps the only context it needs.

## Debugging a running instance

The app is an Electron window, so ordinary browser tooling cannot reach it. Launch with
`--remote-debugging-port=9333` and drive it over CDP — screenshot it, evaluate in it, and
read `window.__mdApp`, `__mdMap`, `__mdChars`, `__mdProps`, `__mdDoors`, `__mdTicks`.

Verifying a visual change by reading the diff does not work here. Look at the pixels.

## Scope note

This checkout is the app's source. The *installed* build is patched separately and those
patches are not part of this repo; do not try to reconcile the two by editing here.

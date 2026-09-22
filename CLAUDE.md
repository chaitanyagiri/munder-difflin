# Munder Difflin — working notes

An Electron + React desktop app. Workforce status is rendered as accessible DOM cards;
agent terminals are xterm.js.

## Change log

- 2026-09-22 (evening): nflverse is NFL's second publisher. Every NFL game carried ESPN
  alone and the bridge requires two independent sources, so 37 of the 42 single-source
  blocks each cycle were NFL. nflverse publishes schedules built from the official
  play-by-play feed on GitHub -- genuinely a different publisher, unlike ESPN's other
  hostnames (`site.web.api.espn.com`), which are the same publisher wearing a different
  name and are deliberately NOT used; that trick is what the two-domain rule exists to
  stop. Records come from the games CSV through `NFLVERSE_ALIASES`, because nflverse uses
  play-by-play abbreviations (LA, OAK, SD) and Kalshi's tickers use broadcast ones (LAR,
  LV, LAC); ESPN is still consulted, but only to learn who is playing.
  Live effect, end of day: single-source blocks 42 -> 5, **the bridge went from accepting
  0 packets all day to 145**, 39 NFL games entered the queue for the first time, and the
  trader is reviewing across NHL, MLB and NFL. Two orders filled:
  KXNHLGAME-26SEP22VGKSJ-VGK YES 6 @ 40c (8.5c edge, the first sports position ever) and
  KXSCTRANSEMP-27FEB28-T53600 YES 1 @ 90c (6.0c edge). The dominant block is now "usable
  edge below the bar" rather than spread or evidence, which is the correct end state: the
  plumbing is fixed and what remains is a research problem, not an engineering one. The
  season-record model has little edge against sportsbook-priced lines, exactly as
  FINDINGS predicts. 362 tests pass.

- 2026-09-22 (IT TRADES): Eli: "I'm still having the same exact issue" -- still zero
  orders after a day of fixes. He was right, and every fix before this one was upstream
  of the actual cause. **Review capacity was being starved.** The trader reviews five
  packets a cycle, newest first; sports floods the queue (65 of 122 packets) and every
  sports book is 6-10c wide against the 5c executable-spread gate, so 115 of the last 117
  reviews were spent on markets that could not possibly pass while 99 tight-spread weather
  markets were never looked at once. That is why the pipeline kept reporting healthy and
  submitting nothing. Packet selection now orders by (likely executable, newest) from the
  last scanned book spread, cached on the scan file's version -- a PRIORITY, not a filter:
  a market whose book has since tightened is still reviewed, just later, and an unscanned
  market is never pre-judged. Live result three minutes after the restart: the first order
  in days FILLED -- KXNHLGAME-26SEP22VGKSJ-VGK YES 6 @ 40c, 8.5c usable edge, $2.40
  exposure -- and it is **the company's first sports position ever**, the thing Eli had
  been asking about. Lesson worth keeping: "the pipeline is healthy" and "the pipeline is
  producing" are different claims, and doctor.py now reports per-ticker agent overlap and
  the top review-gate reasons precisely because the healthy-looking version was the trap.

- 2026-09-22 (self-diagnosis and self-healing): `doctor.py` answers "why is nothing
  trading" in one command. Checks run in PIPELINE ORDER, so the FIRST failure is the cause
  and everything after it is a symptom: daemons (pid AND image name), the start/pause
  switch, universe scan, wide contract, LLM assignment, cohort health **including
  per-ticker agent overlap** (a cohort spread too thin to reach the bridge's three agents
  produces nothing, and that is invisible from per-agent row counts), the fallback
  artifact and whether it is stamped for the live contract, the bridge's top block
  reasons, queue size, trader cycle recency, the loss halt, swallowed errors, the broker.
  Every unhappy check carries the exact next command. `--json` for the panel, `--quiet`
  for cron, `--heal` restarts dead daemons and touches nothing else, exit 1 on any
  failure. This replaces roughly twenty manual greps per diagnosis.
  `breadcrumbs.py` records what a swallowed exception knew before giving up. The pipeline
  is full of `except Exception: pass` for good reason -- one estimator must not stop the
  other three hundred markets -- but it made "covered 165 markets" and "covered 165 and
  silently lost 120" identical from outside. Wired into the sports estimators and the ESPN
  second opinion, whose quiet failure costs a game its second source domain and therefore
  discards every row for it. Bounded at 2 MB; `note()` never raises.
  Two Scheduled Tasks close the gaps that left the company dead for hours today:
  **MunderDifflin-BootUp** runs `md_launch.cmd` at logon (the machine hard-rebooted twice
  and nothing brought the stack back), **MunderDifflin-SelfHeal** runs `doctor.py --heal`
  every 15 minutes as the backstop for `pipeline-ctl` itself dying -- which it did,
  taking ten other daemons with it. Verified live by killing pipeline-ctl AND the trader
  together: detected, named and repaired. Deleted `status.py` (33 lines, hardcoded fake
  API credentials). Suite: 358 pass, 0 fail.

- 2026-09-22 (why nothing trades): Eli asked whether sports or perps had bought anything.
  **Neither, and for different reasons.** Sports has never traded once in the whole
  execution history. It does now reach review (115 reviews today, after ESPN became a
  second publisher for MLB/NHL), but Kalshi's sports books run 6-10c wide (median 8c)
  against `review.MAX_EXECUTABLE_SPREAD` of 5c, so 70 of 70 were refused on spread; the
  season-record model's median usable edge is -3.8% anyway, so widening the gate would
  buy nothing and is not done. Perps cannot trade by design: all five perps write tools
  are on the `.claude/settings.local.json` deny list and the read-only MCP variant never
  registers them. Also found: the fabricated AI estimators deleted earlier today had
  already FILLED four real orders (53 contracts on 09-16/19/20, $5.24 of open exposure
  across KXMODELHIGH-CLAU, KXMODELHIGH-CHAT and KXAISPEND10) on invented numbers. Those
  positions are left alone; closing them costs money and is Eli's call.
  Three more fixes, each of which was silently destroying real research: (1) a worker that
  printed diagnostics above its JSON array made the whole file unparseable and its entire
  cohort was discarded -- `research_packet_bridge._salvage_json` now recovers the payload,
  and the prompt demands the file contain the array and nothing else; (2) every re-dispatch
  re-stamped `current_candidates.json`, and since the bridge rejects any forecast whose
  as_of predates `generated_at`, a re-dispatch voided all finished work -- Meredith
  completed 14 markets at 14:17 and lost every one to a 14:36 re-stamp; an unchanged market
  set now keeps its timestamp (`test_contract_stability.py`); (3) the cohort was spread too
  thin to ever clear the bridge's three-agents-per-ticker rule -- five workers over fourteen
  markets gave 1.4 agents per ticker (eleven tickers with one agent, exactly one with
  three), so `ASSIGNMENT_SIZE` is 5 and the prompt orders everyone to work the list
  STRICTLY IN ORDER so partial runs overlap by construction. The wide contract still gives
  the trader ~300 markets through the deterministic forecaster. Suite: 348 pass, 0 fail.

- 2026-09-22 (audit): "audit the code quality and logic and optimize improve and enhance".
  Worst finding first: **four fallback estimator families were fabricating evidence.**
  `jobs_rows`, `youtube_rows`, `ai_leaderboard_rows` and `ai_spend_rows` returned hardcoded
  constants (p=0.25 "equal prior across 4 major AI labs", p=0.5 "neutral prior", "assume
  halfway to threshold currently") while citing lmarena.ai, crunchbase.com, pitchbook.com,
  charts.youtube.com and news.google.com -- none of which they ever opened. Three such rows
  satisfy the bridge's "three agents, two independent domains" rule on nothing at all, and
  **257 packets built purely on invented numbers had reached the live trader's queue.** The
  families are deleted (those markets now go to the LLM cohort, which must show evidence),
  the 257 packets and 48 rows are quarantined, and the rule is mechanical now rather than
  remembered: `fallback_forecast.FETCHED_HOSTS` is recorded by the fetch helpers and `_row`
  raises `FabricatedSourceError` for any citation the run never fetched, which drops the
  whole ticker (`test_fallback_sources.py`). Same class of bug as the synthetic "Open-Meteo"
  weather agents fixed on 09-21 -- worth assuming there are more.
  Trader hygiene: `packet_cohort_reason` re-read and json-parsed the candidate contract
  ONCE PER QUEUED PACKET -- 1197 reads a minute of a file that grew from 14 to ~300 markets;
  it is cached on (mtime_ns, size) now. The queue is compacted of packets whose contract has
  moved on (they can never be reviewed again): 1197 rows / 2.9 MB -> 98 rows / 273 KB,
  `legacy_ignored` 1099 -> 0. `autonomous_trader_events.jsonl` had reached 11 MB with
  nothing pruning it and now rolls at 8 MB. Tests in `test_queue_hygiene.py`.
  Chat cache: the recursive `fs.watch` added earlier today **never fired in the packaged
  app** (Windows, `{recursive:true, persistent:false}`, 600-folder tree) -- a live probe
  found the chat would not show a new message at all, which is worse than the slow version
  it replaced. It is keyed on the hive's own append-only `log.jsonl` (one stat per poll)
  with a 60s backstop for anything that writes a mailbox without touching the log. Then the
  cold scan itself: reading all 11k mailbox files to return the newest 120 blocked the main
  process ~3s on every new message, so it now lists filenames (which are send-time stamped),
  sorts once and reads only the head. Measured: cold scan 3048ms -> 2ms, a new message is
  visible in 1s, app idles at 4.4% of a core with the chat open (28% this morning).
  Also: the two `md_telegram_alerts` tests that had been failing for days were not a
  regression -- `tick` had deliberately dropped fill/rejection/BOOK alerts at Eli's request
  ("only WON/LOST") and the tests still pinned the old contract; they now assert the
  intended one, including that fills are NOT announced. Full pipeline suite: **345 pass, 0
  fail** (first clean run in days). Eight stale `.bak`/`.backup` copies moved to quarantine.

- 2026-09-22 (later): Eli: "make sure it's working end to end and they're able to trade
  every single thing on the Kalshi market". Found the pipeline producing nothing: the
  Hermes cohort on NIM was degenerating into token soup mid-session and exiting without
  a file (the worker profile's `hermes/config.yaml` fallback chain began with
  `nemotron-3.5-lightning-30b`, which every rate-limited rung landed on; removed, and
  local Ollama `qwen3.5:9b` is now the chain's last rung; `deepseek-v4-flash` left the
  NIM ladder because NIM rejects its request format and Hermes silently substituted the
  same model), and the deterministic fallback only ran when the provider was declared
  exhausted. The contract is now two files: `observer/current_candidates.json` is the
  WIDE contract, every eligible market on the exchange (every band; 299 of 928 scanned,
  the other 688 fail the book gates: one-sided/empty book, depth < $5, mid outside
  5-95c, spread > 10c), which the bridge and the trader gate on; `observer/
  research_assignment.json` is the fourteen the LLM cohort is handed, drawn first from
  markets the fallback cannot price (`research_cycle.refresh_contracts`,
  `refresh_live_candidates.candidate_rows(one_per_cluster=False)`). The fallback now runs
  on every contract refresh, detached (`research_cycle.wide_fallback`,
  `fallback_forecast.py --contract --stamp`; inline it stalled the tick ~10 min), with a
  per-URL fetch cache, ESPN retried without a User-Agent (ESPN 403s a browser UA and
  answers a bare one; every sports band had been burning 4.5s of backoff for nothing),
  failed URLs remembered for the run, FRED via curl first (the browser UA stalls 20s per
  WTI band), and ESPN as a second publisher for MLB and NHL games so they clear the
  bridge's two-domain rule (NFL/NCAAF stay ESPN-only and go to the LLM assignment for
  their second domain). Live result: 510 fallback rows over 170 markets, 58 packets
  ingested by the trader in the first pass. The trader then HALTED on
  `aggregate_realized_loss_halt` (cumulative realized -$7.36 vs the 5% line at -$6.91;
  weather -$13.49, everything else +$6.14, 18 wins / 22 losses). That gate was cumulative
  with no reset, so one losing week had stopped the company for good; Eli ("you decide"):
  it is now scoped to the exchange trading day (`settled_realized` reports
  `realized_today_dollars` from `settled_time`; the 5%-of-bankroll line is unchanged,
  only the window moved, and a record without the day's figure still halts on lifetime). Also: tests spawned
  real detached forecasters (guarded on PYTEST_CURRENT_TEST), `md_pipeline_ctl.py` lost
  the three retired services, and the reconcile test names `whale-watch` now.

- 2026-09-22: Eli: remove the TTS and the office simulator ("unnecessary overhead") and
  make the chat immersive and entertaining to watch. Removed from source: Kokoro TTS
  (`src/main/kokoroTts*.ts`, `src/shared/kokoroVoices.ts`, `src/renderer/src/tts/`, the
  `md-tts:*` IPC, `kokoro-js` and its ~380 MB of ONNX/transformers deps, the
  electron-builder asarUnpack entries) and the 3D office sim (`src/renderer/src/scene/`,
  `assets/office-sim/`, the "Office Sim" tab, `three`). Realtime Michael (OpenAI voice)
  was left alone. The Company Chat is rewritten (`components/CompanyChat.tsx`,
  `components/chat/cast.ts`, `components/chat/TickerTape.tsx`, `design/chat.css`): a
  scrolling trading tape fed by `useTradingData`, a "who's talking" presence strip, the
  Office cast with role tags and accent colours (`worker-toby-<n>` -> Toby, god -> Michael),
  event-aware cards (whale prints and orders show their biggest dollar figure, settlements
  colour win/loss, scheduler standups collapse to a PA line), Slack-style grouping, day
  breaks, arrival animation, markdown bodies with read-more, and every clock pinned to
  `America/Denver`. `hive.voiceMessages` now caches its scan behind a recursive
  `fs.watch` on the agents tree filtered to mailbox JSON (10k message files were
  re-parsed every poll: 28% of a core with the chat open vs 5% without; stat-ing the
  602 agent folders for an mtime signature still cost 300ms a poll; the watch makes an
  unchanged poll 3ms and the app idles at 5% with the chat open) and its limit cap rose
  from 40 to 120.
  Installed app: the injected `md-office.js` chat/markets layer is gone (its `comms`,
  `dashboard`, `kalshi-panel` daemons left `md_launch.cmd`; nothing consumed
  `comms.json`/`dashboard.json`/`kalshi.json` any more, and the weather board lived in that
  layer), `deploy_current_build.ps1` now replaces `out/renderer` wholesale (six stale
  bundles had accumulated) and runs under `apply.py` via `deploy_build.py`
  (`apply.py --restart "why" python deploy_build.py`; optionals must precede the reason
  or argparse rejects the command). Workshop: `verify.py` checks the desk/chat tabs and
  that no office canvas exists instead of `mounted/ticking/data`; `invariants.py` keeps
  Colorado time (now carried by the chat's timestamps) and the two business rules, the
  day/night and `__mdTicks` rules are retired; `mdpaths.py` finds the bundle by `md-desk`.
  `md_office_loop.py`, `md_floor_probe.py`, `md_reload_floor.py` deleted (orphaned; the
  floor-probe capability entry removed from `autonomy/capability_registry.json`).
  Also: the machine hard-rebooted again at 01:27Z (Kernel-Power 41), nothing relaunched
  the stack for three hours; research workers now spawn through an exiting stub
  (`external_research_workers.detached_popen`) so `md_worker_start.py --replace` on the
  cycle no longer kills the live cohort (it did at 01:01Z), `hermes.exe` joined the
  worker image allowlist, and `md_worker_start.process_is_alive` checks the image name
  (a dead worker's PID had been recycled by chrome.exe and read as alive).

- 2026-09-21: Pipeline audit after the OpenClaw sports/perps work. Findings and fixes,
  all in `hermes/skills/trading/kalshi` unless noted: (1) the risk gates this file
  describes had been cut in uncommitted edits (min edge 5c->0.3c, anomaly 12c->50c,
  forecast spread 10%->35%, bridge 3 agents/2 publishers -> 1/1, book spread 3c->10c);
  restored to 5c / 20c / 3 agents / 2 publishers / 5c, and `reduce_forecast_spread`
  tightened to 0.20. (2) `fallback_forecast.py` had been rewritten to read NWS once and
  emit two synthetic "Open-Meteo" agents at +/-0.01 so weather cleared the spread gate;
  it now reads all three publishers for real, handles KXLOW contracts (it forecast highs
  for lows), prices BTC/WTI MIN/MAX contracts on the contract's own horizon with a touch
  (reflection) bound instead of a fixed 30-day terminal value, uses CoinGecko as a second
  BTC publisher and FRED (with a 5-day freshness rule) for WTI, and drops the Stooq S&P
  estimator (JS challenge; S&P hourlies now skip the fallback). (3) Sports: the game
  regex only matched MLB (the 4-digit start time is optional now), season records are
  Beta-shrunk so a 2-0 vs 0-2 week-3 line no longer prices at the 0.97 clip, the dead
  ESPN table (NCAABB -> college-baseball) is gone, and `wide_series.txt` had the sports
  series glued to the last line (`KXHILLARYCONTEMPTKXNFLGAME`). Sports fallback rows
  carry one publisher, so the bridge keeps them out of live execution until a second
  source exists. (4) `execute.py` had an ungated pre-order sell that sold the side the
  new order WANTED; removed. (5) `whale_exit.py` has never closed a position (299
  attempts, all HTTP 400 or tool errors); its client_order_id is now a UUID, the only
  field that differed from filled buys. (6) The trader skips tickers already held before
  spending a review (149 of the last 200 execution rows were duplicate-buy rejections),
  continues past portfolio-gate rejections instead of ending the batch, and reads every
  settlement page for the loss halt. (7) `~/.kalshi/orders.log` had been silent since
  09-16; `server.mjs` logs every write attempt again. (8) Perps: `CREATE_PERPS_ORDER`
  now enforces PERPS.md rules 3 and 6 in code (numbered subaccount, $50 per-order
  notional ceiling via `MUNDER_PERPS_MAX_NOTIONAL_DOLLARS`, 2x margin cash) and the five
  perps write tools joined the `.claude/settings.local.json` deny list. Tests: 334 pass,
  2 pre-existing Telegram-alert failures; MCP suite 21/21. Dashboard: replaced the
  four-tile bar with a Trading Desk view (positions, orders feed with rejection
  reasons, candidates with per-agent spread, realized P&L, worker health) fed by a new
  bounded `fs:readTail` IPC; typecheck and build pass, not yet inspected in the running
  app. The machine rebooted 12:32Z and nothing relaunched the stack; it is down.
  Later the same day: relaunched the stack via a one-shot Scheduled Task (processes
  started from an agent's tool shell die with it). Research provider is now pinned to
  Hermes (Eli: never Claude for this), headless by default (office-spawned `hermes chat
  --tui` workers sat idle with empty outboxes), the NIM model ladder no longer wraps and
  ends on local Ollama `qwen3.5:9b` (verified: answers, ~5 min wall per call with model
  load). Worker liveness now checks the image name (a dead cohort's PID had been reused
  by conhost.exe and parked the cycle at research_in_progress for hours), and a quota
  refusal in the worker logs ("hit your session limit") no longer triggers the 30-minute
  saturation backoff; within two hours of one, `exhaustion()` sends the deterministic
  fallback instead.

- 2026-09-19: Restored live Kalshi order submission end-to-end. Root causes were two:
  the MCP launcher (`integrations/kalshi-mcp/launch.mjs`) had been pointing at the
  read-only server variant, and Kalshi sunset the legacy `POST /portfolio/orders`
  endpoint (HTTP 410), so every submission failed even after the server was fixed.
  `launch.mjs` now boots the full `server.mjs` (commented "do not swap back"), and all
  five write tools (create/cancel/amend/decrease/batch-cancel) were migrated to the V2
  endpoints under `/portfolio/events/orders` with legacy→V2 argument mapping (bid/ask on
  the YES side, fixed-point dollar strings, IOC market orders, GTC limits); tool schemas
  unchanged so `execute.py` and the trader needed no edits. Verified live: endpoint probe
  returns Kalshi's own 404 (no more 410), and nine real orders filled within 27 minutes
  of the fix; the duplicate-position gate then correctly rejected re-buys. Also shipped
  the `aiaigents` repo CLI (`src/cli/`, build via `npm run build:cli`) with
  `pipeline status`, `mcp status|list-tools|call`, `kalshi balance|positions|fills`, and
  a `doctor`; a SKILL.md is installed for every agent harness.

- 2026-09-13: Research output validation now checks the exact active contract ticker,
  cohort timestamp, cluster, resolution summary, and clarity. Event-only ticker output
  cannot report success. All 82 focused tests pass. The live worker command already
  includes validation, so this script update is available without interrupting workers.
  Preserved the other agent's expanded discovery settings and unrelated changes.

- 2026-09-13: Live cohort inspection found invented future timestamps and source
  objects using `https` instead of `url`. Added a read-only researcher output validator
  and mandatory prompt validation/retry instructions, with explicit system-clock use
  and historical-versus-future observation handling. All 81 focused tests pass.
  Current researchers remain uninterrupted; updated prompts apply on next deployment.

- 2026-09-13: External researcher status now distinguishes existing files from
  actual current-cohort output by timestamp, ticker, and agent identity. Old files
  no longer produce a false-ready status. All 79 focused tests pass. Live researchers
  are gathering station-specific evidence; the runner correctly rejects all 135
  historical/current-file-old rows until fresh independent research is available.

- 2026-09-13: Removed a weather-only discovery assumption that silently excluded
  financial contracts already present in scans. Financial discovery now carries
  exchange-published settlement-source metadata; supported currency/index rules must
  name the underlying, year, observation time, threshold, and a named HTTPS source.
  Forecasts remain blind to exchange quotes. All 78 focused trading tests pass.
  Live verification: the 22:20:58 UTC contract includes USD/JPY alongside Miami and
  Chicago; all three detached research processes were confirmed running.

- 2026-09-13: Corrected research timestamp instructions that incorrectly required
  all source retrievals to predate worker launch. Sources now use their actual UTC
  fetch times; forecasts use actual completion times after retrieval and pass start.
  Cohort gates remain enforced. All 77 focused tests pass, the hidden research
  supervisor is refreshed, and the broker confirms zero resting orders.

- 2026-09-13: Identified station mismatches and mixed research cohorts as execution
  blockers. Research prompts now require the exact settlement station, local date,
  numerical inputs, and probability assumptions. All workers share one issuance time.
  The bridge and runner reject forecasts older than the active contract; old queued
  tickers cannot consume current review capacity. All 77 focused tests pass. The live
  runner is refreshed; after all three researchers were confirmed finished, the
  hidden supervisor was refreshed so the next cohort uses the updated prompts.

- 2026-09-13: Fixed an exact three-cent spread being rejected by binary floating-point
  rounding without widening the limit. Review capacity now selects the latest packet
  per distinct market, preventing repeated updates from starving other candidates.
  All 75 focused trading tests pass. The hidden live runner was refreshed; current
  research still fails disagreement or net-edge gates, so no new fill is claimed.

- 2026-09-13: Reviewed the concurrent dashboard work; TypeScript checks pass.
  Corrected fill reporting to use authenticated broker fill history and recovered
  historical literal-separator JSONL records. The dashboard shows protected savings.
- 2026-09-13: Expanded the autonomous runner to three qualifying orders per cycle
  and 24 per day on a 60-second cadence. Each submission gets a fresh portfolio and
  review, local batch commitments cover broker update delays, and pending buys count
  toward exposure. Failed submissions stop the batch.
- 2026-09-13: Added a settlement-backed savings allocation: 25% of cumulative net
  settlement gains is excluded from trading capital and protected within broker cash.
  Cash and open exposure synchronize the remaining capital for reinvestment; deposits
  do not count as profit. Repaired Windows PID probing and retained live locks regardless
  of age. All 70 focused trading tests pass.
- 2026-09-13: Operational Python and Markdown code is now versioned in a local
  Git repository under the Kalshi runtime directory. Credentials, JSON state, logs,
  and observer artifacts are ignored. The dashboard corrections remain source changes;
  broader app tests have Windows symlink and agent-cap failures, so deployment is pending.

- 2026-09-13: Expanded the price-blind discovery set with live financial series
  (S&P 500, USD/JPY, and EUR/USD) and diversified each external research cohort by
  correlation cluster and category. Researchers now use contract-specific primary
  source guidance instead of weather-only instructions.
- 2026-09-13: Tightened external research ingestion: only active-cohort artifacts
  are read while a current contract exists, strict producer prompts require literal
  numeric fields and an exact UTC timestamp, and fresh discovery refreshes every ten
  minutes after a completed cohort. Invalid research remains bridge-blocked.
- 2026-09-13: Made research scheduling responsive to live state: active cohorts are
  polled every minute and the next scan wakes at its exact freshness boundary. The
  executor reviews only the newest three bridge packets, preserving old cohorts for
  audit without spending current review capacity on them.
- 2026-09-13: Repaired the external autonomous trading runner's dead-worker recovery:
  its PID lock is now reclaimed only after the recorded owner is proven absent, so a
  stopped hidden worker cannot suppress later research-to-review cycles. The runner
  is supervised every minute, consumes only bridge-provenanced fresh research,
  preserves portfolio limits, and keeps rejected candidates out of execution.
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
- **Status:** Order submission is live end-to-end (2026-09-19). EVALUATE_MARKET verdicts
  flow through `execute.py` into the MCP `CREATE_ORDER` tool, which posts to the V2
  endpoint `POST /portfolio/events/orders`. Verify `orders_submitted` and
  `live_order_submission` in the verifier output before claiming a trade.

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
| `aiaigents` CLI source / build | `src/cli/` → `out/cli/aiaigents.js` (`npm run build:cli`) |
| `aiaigents` SKILL installs | `~/.claude/skills/aiaigents/`, hermes `skills/software-development/aiaigents-cli/`, `~/.codex/skills/`, `~/.config/opencode/skills/`, `~/.openclaw/plugin-skills/`, `~/.openclaw/agents/main/agent/workshop-skills/` |

The Desktop-folder note below describes checkout mirroring; [`INDEX.md`](INDEX.md) maps every
folder in this repo and every external surface the project depends on.

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

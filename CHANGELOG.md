# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.8] — 2026-06-15

A feature release: **shareable hires** — package a role-configured agent as a portable
manifest, share it as a file or host it in a gallery, and import it into any office with one
click. Plus **The Hiring Fair**, a community gallery of ready-made roles, and a hardened,
untrusted-input import pipeline.

### Added
- **Shareable hires (#70, #71).** A portable `munder-difflin/hire@1` JSON manifest describing a role-configured agent — name, sprite, provider, model, command flags, goal, capability tags, token budget. Two import paths, one pipeline: a `munderdifflin://hire?src=<https-manifest-url>` deep link (fetched and validated in the main process, queued, then pulled by the renderer on mount) and an *import hire…* button in the Add-Agent modal that reads a local manifest file. Either way the manifest only **pre-fills** the Add-Agent modal behind an "imported" banner; spawning stays an explicit human click — import never auto-spawns. Protocol registration ships for all three platforms (macOS `open-url`, Windows/Linux single-instance lock + cold-start argv forwarding), and packaged builds register the scheme via `electron-builder.yml`.
- **The Hiring Fair — community gallery** at [munderdiffl.in/hires](https://munderdiffl.in/hires/) (`docs/hires/`, static, no build step, served by the existing GitHub Pages setup). Seed roles drawn from the cast (Pam writes docs, Dwight enforces QA, Jim reviews PRs, Creed audits security, Angela audits the office's own token spend, Stanley does the migrations nobody wants), each with a Claude Code / Antigravity / Codex provider toggle (per-provider variants generated from one base manifest), function filters matching the landing page, and a client-side validator identical to the app's alongside a JSON schema (`docs/hires/spec/`). Model suggestions are data-driven (`docs/hires/models.json`), so new models are a one-line update.

### Security
- **A hire manifest is untrusted input — defense in depth.** No auto-spawn and no executable field: `provider: "custom"` is rejected and the binary always comes from the user's local provider preset. Embedded CLI flags are gated by a **default-deny allowlist** (`SAFE_FLAG_NAMES`) — only known-harmless flags pass, nothing system-prompt/settings-related — replacing an earlier denylist that drifted as each CLI added flags. `model` is constrained to a safe charset (`MODEL_RE`), and a command-line quoter neutralizes `cmd.exe` metacharacters (`& | ^ < > ( ) % !`) on **every** spawn path — closing a Windows command-injection class (PoC `"model":"x&calc"`). The manifest fetch is https-only, manual-redirect with per-hop re-validation (kills redirect SSRF into `127.0.0.1` / `169.254.169.254`, including an IPv6-bracket bypass), streamed with a 64 KB byte cap (no trusting `content-length`), a 10s timeout, and ≤5 hops. The dependency-free validator (`src/shared/hire.ts`) is shared by the main process, the renderer, the gallery (`docs/hires/validator.js`), and the JSON schema, so all four stay in sync.

## [0.2.7] — 2026-06-13

A feature release: talk to your agents with your voice, an opt-in enterprise Knowledge
Graph, multi-window "floors", a richer message composer with file/image attachments, the
groundwork for TV-show office themes, and a redesigned landing page — plus composer and
fullscreen polish.

### Added
- **Free Flow voice dictation → message queue (now on by default).** Hold Option to talk; your speech is transcribed by Groq Whisper (`whisper-large-v3-turbo`) straight into the message composer. Gated on a Groq API key, which is encrypted at rest.
- **Enterprise Knowledge Graph v1 (now on by default).** A multimodal store of your own documents / policies / business context, with a CLI agents can query for ranked passages and full documents — so company-specific facts come from your data instead of guesses.
- **Multi-window "floors" (now on by default).** Open isolated office windows, each with its own set of agents and per-PTY routing.
- **Rich message composer — file & image attachments.** Attach files/images (via a "files" button or paste-to-attach), shown as removable chips above a taller, resizable input; you can send with attachments alone.
- **Restore agent sessions across restart, with Restart & Continue (#78).** Agents reattach their prior Claude conversation after an app restart: Michael resumes his session (the orientation prompt is skipped on a genuine resume), and a restored worker re-enters its *existing* worktree instead of re-isolating, so uncommitted work isn't lost. The recorded session transcript is seeded into the target cwd before `--resume` attaches (and `--resume` is only used when the transcript is actually present, so there are no broken resumes against a missing id), and the pooled terminal soft-resets in place — staying live and typeable across a model change or respawn, redrawn at its real fit-derived grid. A per-agent **Restart & Continue** button respawns the session on the same model with resume to redraw a garbled terminal, and Add Agent gains a "resume session" field that reattaches by session id (auto-filling the folder, falling back to a fresh session if the id isn't found).
- **Drag a file onto a terminal to inject its path (#79).** Dropping a file (an image, etc.) onto an agent's terminal now writes its absolute, shell-escaped path into the session — so Claude Code detects the image path in the prompt and attaches it — instead of Electron navigating to the dropped `file://` URL. Backed by `webUtils.getPathForFile` exposed from preload (Electron 32 removed `File.path`); only file drags are intercepted, so text/selection drags still fall through to xterm.
- **TV-show office themes — infrastructure (behind a flag, off by default).** A theme abstraction (`ThemeConfig` + registry/loader), a Settings theme picker with a destructive switch-flow, and the first themed map (Brooklyn-99 precinct). Ships dark via the `tvShowOffices` flag while the remaining maps land.
- **Live GitHub star count** next to the Star buttons on the landing page.

### Changed
- **Composer redesign.** A full-width input above a single tidy control bar (Delegate · Attach · voice · Send) — no dead space from a stacked side column.
- **Landing page redesign.** Bento layout for the #features and #why sections with new SVG illustrations; the #claude section refreshed for v0.2.7.

### Fixed
- **Fullscreen tab bar no longer clipped.** The fullscreen terminal's tab bar is un-clipped.
- **Slack double-ack (#).** A single Slack message delivered as both `app_mention` and `message.*` is now de-duplicated by `channel:ts`, so it's handled exactly once.

## [0.2.6] — 2026-06-10

A polish + reliability patch: the agent terminal renders correctly the moment it opens,
`npm run dev` no longer crashes on a missing sidecar, a Windows ConPTY crash is guarded,
the wall clock becomes a clickable closing-time control, the ASK ME board reads in the
memory font, and the Slack file download is host-pinned.

### Added
- **The office clock is interactive (#64).** The clock on the wall reads the real time, and clicking it opens the closing-time (graceful shutdown) flow.

### Fixed
- **Terminal no longer renders oversized/clipped when an agent boots.** xterm used to fit before its container had a real size and cached the character-cell metrics from before the web font (VT323) loaded, so the welcome banner overflowed and was clipped until you manually resized. The view now waits for a real size, re-measures and re-rasters the WebGL glyph atlas after the font loads, and lets the `ResizeObserver` drive the first fit — so it fits immediately on boot.
- **`npm run dev` no longer crashes on the missing Slack-trigger sidecar (#67).** The `.cjs` sidecar copy now runs as a vite `writeBundle` plugin, so both `dev` and `build` emit `out/main/slack-trigger.cjs` from one place. (v0.2.5 fixed only the packaged-build path, so a fresh clone's `npm run dev` still died at boot.)
- **Windows: node-pty ConPTY `AttachConsole` crash guarded (#65).** Companion to the Antigravity provider work — the main process no longer crashes when ConPTY fails to attach a console.
- **ASK ME reads in the memory font (#63).** The ASK ME board now uses VT323 instead of the chunky Pixelify Sans, matching the rest of the memory surfaces.

### Security
- **`downloadSlackFile()` host-pinned to Slack.** The Slack bot token is now only ever sent to `slack.com` / `*.slack.com` hosts — a defense-in-depth guard before the `Authorization: Bearer` header is attached (the URL is already Slack-issued + HMAC-verified, so this hardens against a future redirect/parsing change).

## [0.2.5] — 2026-06-10

A reliability + reach patch: a Windows-terminal regression fix, an agent-lifecycle
cleanup that ends the breaker inbox-flood, Slack requests that actually reply with
substance, a delegate toggle, six new tutorials/blogs, and an enriched landing diagram.

### Added
- **Delegate-to-agents toggle.** A toggle switch above the Send button in the god orchestrator's composer prepends a delegation instruction so a request fans out to available agents (and is handled one-by-one if none are free). God-only, default off.
- **AUTONOMOUS REQUEST PROTOCOL for Slack-origin requests.** Inbound Slack requests now run fully autonomously: god routes the request to the most-relevant agent, that agent does the work and **posts its substantive result back into the Slack thread itself**, then reports to god. It pauses only for high-severity actions (pushing to main, spawning infrastructure/paid services, deleting files it didn't create), and any decision it needs is asked as a numbered-options reply in the thread and correlated back by `thread_ts`.
- **Six new tutorials & blog posts** — webhook setup, the full Slack setup, deploying an automated PR-reviewer agent, deploying a blog-writer agent, why CLI agents are so powerful (and how the hive cuts token use), and why a mixed-capability swarm beats a clone army.
- **Enriched "how it works" landing diagram** — Slack / Webhook / Schedule triggers feeding the orchestrator, plus a band showing each agent in its own isolated local git worktree.

### Fixed
- **Windows agent terminals no longer die on Program-Files installs (#55).** `cmd.exe` is now invoked with a properly double-quoted command line (`/d /s /c`), so a Claude/node path containing a space (e.g. `C:\Program Files\…`) launches instead of splitting on the space.
- **Orphaned-agent lifecycle cluster (#56/#57/#58).** A stale agent entry with no live terminal no longer (a) re-writes a frozen cost-ledger row every ~30s, (b) trips the circuit breaker into an unclearable inbox-flood to the orchestrator, or (c) lingers un-archived — a startup migration archives no-PTY entries and the breaker now skips assistant/orphaned shells.
- **Slack replies are real answers, not empty confirmations.** Worker agents post the actual outcome into the thread; the orchestrator's auto-summary is now a fallback that never posts a bare "✅" with no content and skips threads already answered directly.

### Removed
- **Reverted the unfinished compact-protocol feature** — it was only half-wired (main-side committed, renderer-side unfinished) and broke the web typecheck. It will return fully wired in a later release.

## [0.2.4] — 2026-06-09

A multi-provider patch: Codex graduates to **full hive parity** via a native
lifecycle-hook bridge, the god orchestrator opens to its terminal by default, and a
handful of resilience fixes land.

### Added
- **Codex lifecycle-hook bridge — full hive parity.** Codex now joins the hive as a first-class, hive-aware provider: a native lifecycle-hook bridge maps Codex's events into the existing hook pipeline (live status + inbox-drain + outbox routing), and agy/codex dispatch is unified behind one path. Verified running hive-aware in bypass-permissions mode. (#47, #54)
- **Codex hook discovery via `config.toml [hooks]`.** The bridge registers through Codex's `config.toml [hooks]` surface rather than a bare `hooks.json`, matching how Codex actually discovers lifecycle hooks.

### Changed
- **God orchestrator opens to the Terminal sidebar by default.** Selecting the god agent no longer reopens a stale "ASK ME" tab — a leftover command-center tab request is cleared on select, so the panel mounts to its terminal default. The ASK ME tab is still one click away.
- **Landing + blog refreshed for multi-provider.** The landing page now presents Claude Code, Antigravity (Gemini), and OpenAI Codex as equal first-class providers (with a one-line mobile-friendly badge), and a grand v0.2.4 launch post + technical walkthrough replace the v0.2.3 posts.

### Fixed
- **Slack/webhook tunnel no longer crashes at load.** `tunnelmole` is ESM-only; a static `import` in the CommonJS-bundled Electron main process threw `ERR_REQUIRE_ESM`. It's now loaded via a dynamic `import()` inside `openTunnel()`, so the public ingress actually starts.
- **Heartbeat re-engages the god on an unread actionable inbox** — not only when the floor is quiet — so worker/human mail is drained promptly.
- **Slack done-summary stops retrying on terminal errors.** A permanently-failing post (e.g. the bot token missing `chat:write` → `missing_scope`) is now recorded and logged once instead of retrying every 5s and flooding the console; transient errors still retry.

## [0.2.3] — 2026-06-09

A multi-provider release: the floor is no longer Claude-only. Antigravity (Gemini)
and Codex agents become first-class hive participants, schedules get their own tab,
and the Slack / webhook ingress is moved off the flaky public tunnel.

### Added
- **First-class Antigravity (Gemini / `agy`) provider.** A worker can now run the Antigravity CLI as a full hive participant. Because `agy` has no Claude-style `--append-system-prompt`/`--settings` hooks, the hive identity + protocol ride in as the session's initial prompt, and a native `agy-hook` bridge normalizes Antigravity's lifecycle events into the existing hook pipeline so a Gemini worker gets the same live status + inbox-drain as Claude — on the subscription, no API key. (#54)
- **Schedules tab.** Recurring auto-dispatched missions (and the adaptive heartbeat) get their own Command-Center tab instead of an inline section. (#50)
- **Terminal work-order handoff for hookless providers.** A provider with no inbox-drain path now receives hive mail as a `WORK ORDER FROM HIVE` typed into its terminal, falling back to a god-bounce only if the renderer is unavailable. (#53)

### Fixed
- **Codex agents now follow the hive protocol and message back.** Codex spawned without the hive protocol or any hook, so it never read its inbox or wrote its outbox. Codex is now a non-hive-aware-but-inbox-capable provider: the protocol is injected as its initial (positional) prompt, its outbox is drained provider-agnostically by the router, and inbox mail reaches it via the renderer's idle inbox-wake nudge. Codex and Antigravity coexist in the provider union. (#47, #54)
- **Slack + webhook public URL no longer silently breaks.** The ingress used `localtunnel`/loca.lt, which now serves a browser interstitial that fails Slack's `url_verification` POST and breaks saved webhook URLs. Both `slack.ts` and `webhook.ts` now use **tunnelmole** (MIT, POSTs pass straight through), and a failed tunnel surfaces a real error instead of a silent "started" with no URL.

## [0.2.2] — 2026-06-07

A community polish release — almost entirely the work of @Gulum: a live context-window
gauge on every agent card, sharper terminals, correct Windows metering, and dispatch that
always routes through the god.

### Added
- **Live context-window gauge on each agent card.** A Claude Code statusLine pushes the session's exact token count and real context-window size after every response, so each agent card shows a precise live fuel gauge drawn from Claude Code itself instead of a transcript estimate. The gauge also zeroes the instant you send `/clear`, rather than briefly showing the previous session's full bar until the next response. (Thanks @Gulum — #12, closes #11.)
- **Per-session terminal theme toggle + Unicode 11 emoji widths.** Each terminal session can now switch its Claude theme independently, and emoji column widths follow Unicode 11 so wide glyphs stop nudging the cursor out of alignment. (The WebGL renderer, copy/paste, and `minimumContrastRatio` from v0.2.0 are kept as-is.) (Thanks @Gulum — #26.)
- **All human dispatch flows through the god.** Every Command Center dispatch now mails the god (`Task from the human`) instead of writing straight into a worker's inbox; the worker dropdown becomes a **suggested owner** (Michael still decides), so nothing skips the orchestrator. (Thanks @Gulum — #45, fixes #44.)
- **Dedicated context-window row on the monitor tab.** The Floor monitor's cumulative budget bar was being misread as a per-agent context gauge; a separate `ctx` context-window row now sits alongside it, so the live context window and the cumulative budget aren't confused. (Thanks @Gulum — #46.)

### Fixed
- **Windows usage meter no longer reads 0/0.** The transcript reconciler built the per-project directory name with the POSIX rule, but Claude Code on Windows encodes *every* non-alphanumeric character (including the drive colon), so the meter never found the transcript and always read 0 tokens / $0.00. (Thanks @Gulum — #34, fixes #10.)
- **Send-only assistant mail no longer black-holes.** Direct mail to the send-only prep assistant landed in an inbox nothing reads; the router now bounces it to the god (subject prefixed `[bounced …]`) instead of dropping it. (Thanks @Gulum — #33, fixes #32.)
- **Boot banner no longer stacks in scrollback.** `tryFit()` fired `resizePty` on every fit even when the dimensions were unchanged; redundant resizes are now skipped, so the boot banner stops re-stacking in the terminal history. (Thanks @Gulum — #8.)
- **Visible text-select cursor on the cream theme.** The hovering I-beam (an OS cursor that CSS color hints can't touch, drawn white by several Windows schemes) is now an inked I-beam with a halo, so it stays visible over the light terminal. (Thanks @Gulum — #39.)

### Acknowledgements
This release is almost entirely the work of @Gulum — thank you. Maintained by @chaitanyagiri.

## [0.2.1] — 2026-06-07

A small follow-up to v0.2.0 that makes the scheduler considerate of agents that are mid-task.

### Changed
- **Scheduled auto-compaction is queued, not forced.** The hourly ops-standup's terminal compaction is now enqueued per agent and delivered only when that agent is idle (deduped — at most one `/compact` pending at a time), so it compacts *between* steps instead of jamming a working terminal mid-step. The standup prompt now asks each agent to summarise its current task and next step, then resume from the same point after compacting.
- **Heartbeat is inbox-driven.** The floor heartbeat (`reengageGod`) no longer types directly into Michael's terminal; it drops its digest in his inbox, which the busy-aware inbox-wake delivers once he's idle.

### Docs
- Expanded the README roadmap (chat integrations, pluggable agent CLIs, realtime Michael).

## [0.2.0] — 2026-06-07

The observability and control release. v0.2.0 makes the fleet visible and keeps it in check — and it's a community release in the most literal sense: most of the work below came from external contributors. Huge thanks to everyone credited.

### Added
- **Command Center overhaul.** Michael's control surface was reworked into the place you actually run the floor from — the roster, dispatch, schedules, memory, and activity views now carry the new live signals (token budgets, telemetry, breaker state) without becoming a wall of numbers.
- **Per-agent token budgets + live fleet monitoring.** Every agent carries a token budget, and the floor monitors consumption live so a single agent can't quietly run the bill up.
- **Live OTel telemetry collector + per-model cost.** A built-in OpenTelemetry collector and a `UsageProvider` seam feed real usage in, with per-model cost attribution (interim transcript-backed stub behind the seam to start).
- **Fleet grid + per-agent tool-span waterfall.** A live grid of the whole fleet, plus a per-agent tool-span waterfall that shows what an agent spent its turn doing — which tool calls ran, in what order, for how long.
- **Agent-card context-window gauge.** The agent card's progress bar is repurposed into a context-window gauge so you can see at a glance how close each agent is to filling its context. (Thanks @Gulum — #12.)
- **Circuit breaker.** A steer → constrain → stop ladder plus a cost/runaway guard, fed by hook signals (repeated identical tool calls), an `onApiError` seam for error-storm trips, and budget config.
- **Scheduler heartbeat.** A heartbeat beat tracks each agent's last output (quiet/idle signals), enforces circuit-breaker policy, and adds spawn guardrails; the SCHEDULES view shows the heartbeat row plus last-fired / next-fired times. (Thanks @albozes — #2.)
- **Human-in-the-loop, mid-run.** A HITL gate, mid-run steer, and graceful stop all delivered through hook returns — approve, redirect, or cleanly halt an agent mid-turn instead of yanking it.
- **Durable SQLite persistence (Phase A).** A SQLite durable store persists window bounds and history, alongside a persisted `session_id` and a durable cost ledger (`cost-ledger.jsonl`) so cost and provenance survive restarts.
- **MemoryReflector — memory condensation.** The janitor's missing condense half: a reflector that condenses memory instead of only mining it, keeping the semantic store lean.
- **Configurable hive/memory home folder.** Point the hive and memory home at a folder of your choosing, with a safe move that relocates existing data.
- **One-click "Restore team."** After a harness restart, a single click brings back the last session's workers — no more re-adding agents one by one. (Thanks @Gulum — #16.)
- **Delete scheduled missions.** Scheduled missions now have a delete button. (Thanks @Gulum — #9.)
- **New avatar states.** A compacting state (on `PreCompact`) and a looping state (when the breaker engages) so the floor reflects what the control layer is doing.

### Fixed
- **Terminal contrast + HiDPI legibility.** A `minimumContrastRatio` floor and a tuned light palette (including dual fg/bg-legible green/yellow) keep text legible on coloured backgrounds across both the new and legacy terminal views.
- **Crisp, readable floor text.** A HiDPI canvas, bold bubbles, and a walk-flicker fix sharpen office-floor text; thought-cloud text now stays 1:1 when the window shrinks. (Thanks @Gulum — #20.)
- **Terminal no longer jumps to the top of history on first scroll**, and the viewport dead zone is gone (re-sync routed through xterm, not the DOM). (Thanks @Gulum — #8.)
- **Windows: keep the hive running behind the lock screen.** The hive no longer freezes when Windows locks — keep-awake plus no throttling. (Thanks @Gulum — #18.)
- **Live agent statuses** and **composer-draft fixes** for the message-queue composer. (Thanks @Gulum — #7, #27, #28.)
- **Palace writer-lock serialization** and **Windows named-pipe + mempalace detection** so the hook server and semantic memory work on Windows. (Thanks @Xileck.)
- **Per-PTY input serialization** so the boot sequence can't jam mid-spawn; restored `+x` on the `node-pty` spawn-helper so agents can spawn.
- **GOD orchestration tabs** are now scrollable; the title-bar settings button is a clear gear chip.
- **Global `defaultModel` wins over role tier** (an explicit per-agent pick still wins); cost-ledger row is fully snake_case for a 1:1 SQLite migration (#4).

### Acknowledgements
Reported / requested by the community: @JLAD75 (Windows hive router / `hooks.sock` — #1), @billrehm (Windows GOD-spawn error 193 — #22), @darrensheffield (uv-not-installed assumption — #30; macOS Gatekeeper — #29), @pdurlej (first-class Codex CLI provider request — #21), @wild-gobatz (agents showing idle until clicked — #3). Maintained by @chaitanyagiri.

## [0.1.9] — 2026-06-06

### Added
- **Hourly ops standup.** A built-in scheduled mission (enabled by default) where the GOD orchestrator reviews every agent — who's doing what, whether tasks are on track, and whether agents are still running — and **compacts each terminal's context** on the same hourly cadence to keep agents lean. Toggle it in the Command Center; a one-time migration seeds it into existing installs (and won't re-add it once deleted).

### Fixed
- **Agents exited on their own at a "Bypass Permissions mode" prompt.** Agents spawn with `--permission-mode bypassPermissions`, which on a fresh machine shows a one-time interactive "WARNING: Bypass Permissions mode … 1. No, exit / 2. Yes, I accept" prompt the terminal couldn't answer, so the agent exited code 1 within seconds. The harness now idempotently pre-accepts Claude Code's dangerous-mode warning (`skipDangerousModePermissionPrompt` / `skipAutoPermissionPrompt`) and per-folder trust before each spawn.
- **Blog cards.** The colored thumbnail tile sat flush against each card's bold border; it's now inset with padding for breathing room (desktop + mobile).
- **Windows: hook server + semantic memory.** The hook server now binds a named pipe on Windows (where Node IPC isn't a filesystem socket), and `mempalace` is detected via `where` + the standard `.exe` install locations so semantic memory works on Windows. POSIX behavior unchanged. (Thanks @Xileck — #4.)
- **Palace mining writer-lock collisions.** Mining is now serialized — a single writer at a time with a re-entrancy guard — fixing "palace is held by PID …" failures when multiple agents mined concurrently. (Thanks @Xileck — #5.)
- **MemPalace index noise.** Each agent's `.gitignore` is ensured before mining so `settings.json`, the cursor file, and raw inbox/outbox message JSON stay out of the semantic index — keeping recall and wake-up focused on real memory.

## [0.1.8] — 2026-06-05

### Fixed
- **Windows agent spawn.** Launching an agent on Windows failed with `cannot create process, error code: 2` (ENOENT) because binary and PATH resolution were Unix-only (`SHELL`/`/bin/zsh`, `-ilc`, `which`, and Unix-only fallback paths). Windows now resolves `claude` via `where`, checks the standard Windows install locations (`%APPDATA%\npm\claude.cmd`, `%LOCALAPPDATA%\Programs\claude`, `%USERPROFILE%\.claude\local`), uses the process `PATH` directly (no login-shell probe), and recognizes Windows-style (`\`) absolute paths. macOS and Linux resolution is unchanged; the Unix fallbacks now also include `~/.volta/bin`.

## [0.1.7] — 2026-06-04

### Added
- **Slack → Michael's queue.** A new Slack integration (Settings → Slack) pipes a channel's messages straight into Michael's message queue — paste a message in Slack and it lands in his queue exactly as if you'd typed it. Off by default; every request is verified with your Slack signing secret (HMAC + 5-minute replay guard) before it's accepted, and a localtunnel exposes the local webhook for Slack's Event Subscriptions.

### Changed
- **Approvals are now native.** The in-app approvals queue/panel is removed in favor of native Claude Code human-in-the-loop prompts. A `to:"human"` decision now reaches you through Michael's session and native permission prompts — approvable from your phone via `/remote-control` — and Michael boots straight into running the floor.

### Fixed
- The floating approvals panel could re-queue an item when you approved it (`resolveApproval` re-routed the message back into the queue). Moving to native HITL removes the panel and the bug.

## [0.1.6] — 2026-06-04

### Added
- **Per-agent git worktrees.** A 'Git isolation' toggle in Add Agent auto-provisions a dedicated worktree (`<harnessHome>/worktrees/<agentId>/`) on spawn and tears it down on kill. Agents on the same repo never collide on branches.
- **Task kanban with dependencies.** A Tasks tab in the Command Center renders a full kanban board (todo / doing / blocked / done). Each task carries an assignee, a `dependsOn[]` list, priority, and description — and persists in `hive/tasks.json` via a new `hive:writeTasks` IPC channel.
- **Scheduled missions.** A Schedules section in the Floor tab lets you define recurring auto-dispatch missions (label, interval, target agent, body). The main process fires each on a `setInterval`, stamps `lastFiredAt`, and persists the list in config.
- **Real token & cost telemetry.** The Activity tab reads `~/.claude/projects/` JSONL transcripts — the same files Claude Code writes — and displays actual input/output/cache token counts and estimated USD cost per agent per model. No more proxy tool-call counts.
- **Global hive text search.** Full-text search across `board.md`, `tasks.json`, and all agent `memory.md` files, available in the Memory tab alongside MemPalace semantic search.
- **Threaded chat.** A Messages tab in each agent's sidebar renders every hive message grouped by conversation with full reply chains and an inline reply form.
- **Memory graph.** A visual graph in the Command Center Memory tab maps agents and their knowledge relationships.
- **GitHub issue ingestion.** An Issues section in the Floor tab pulls open issues from any registered repo via `gh issue list` and lets you assign them to any agent with one click.
- **CI status watcher.** A CI Status section in the Activity tab polls `gh run list` for every registered repo and shows live pass/fail/in-progress status for GitHub Actions runs.
- **Desktop notifications.** Native OS notifications fire when an agent finishes a task or is waiting for your input. Toggle in Settings.
- **Agent archival.** Closing an agent's tab archives it (memory + history intact) rather than deleting it permanently.

### Fixed
- Scheduler now honors `lastFiredAt` on config reload — missions don't double-fire after a save.
- PTY lifecycle teardown runs on natural process exit as well as explicit kill, so worktrees are cleaned up reliably.
- Task IDs fall back to a stable UUID when the title is empty; `writeTasks` IPC validates its input.

## [0.1.5] — 2026-06-04

### Added
- **Dwight, Michael's prep assistant.** A persistent, visible assistant agent
  (Sonnet, 1M context) spawns on startup. A global **enrich** toggle routes
  Michael's queued prompts through Dwight first — he gathers repo context and
  rewrites the prompt, then forwards it to Michael through the hive; toggle it off
  and prompts go straight to Michael.
- **Michael's Command Center.** His sidebar becomes a control surface with
  Terminal, Floor (agent roster + **per-agent model selector** with safe restart,
  a dispatch box, and working dirs), Memory (MemPalace search + per-agent memory),
  and Activity (live log feed + board + usage proxy), plus a copyable Claude
  command handbook.
- **Per-agent model selection** — a model picker in **Add Agent**, a shared model
  list, and a message-queue composer with the enrich toggle.
- **Getting-started tutorial** on the blog (canonical install + first-run walkthrough),
  with Blog/tutorial CTAs and a redesigned "How it works" section on the landing page.

### Fixed
- Agents no longer read **"idle" while still working** — a Stop blocked mid-turn now
  reports `blocked` so the UI keeps the agent in its working state.
- Long agent thought/tool labels now **word-wrap inside their cards** instead of
  overflowing the bubble horizontally (Pixi word-wrap with a raw-length cap so a
  pathological string can't grow a runaway-tall card).
- Switching agent terminals now lands at the **latest output**, while resizes
  preserve scroll position; the idle action label no longer echoes the "idle" badge.

## [0.1.4] — 2026-06-04

### Added
- **Signed macOS builds.** The app now ships with a hardened-runtime Developer ID
  signature (notarization is attempted in CI and stapled when it succeeds; the build is
  best-effort, so a notarization hiccup never blocks a release). Because macOS binds a
  folder-access (TCC) grant to a stable code signature, you're now prompted for
  Documents/Desktop/Downloads access **once** instead of on every agent action.
  Usage-description strings explain each prompt. Signing/notarization run in CI only
  when Apple credentials are present, so contributor builds stay unsigned and green.
- **Blog at [/blog](https://munderdiffl.in/blog/)** — an Eleventy-generated static blog
  sharing the landing page's neo-brutalist design system, seeded with the first posts
  on long-term memory, multi-agent harnesses, and MemPalace, plus tag/topic indexes and
  an RSS feed.
- **On-site SEO/AEO metadata** — JSON-LD, `robots.txt`, a root `sitemap.xml`, and richer
  link-unfurl/meta tags across the site.

## [0.1.3] — 2026-06-01

### Added
- **Settings panel** (title-bar gear) with a **Reset & start over** action that wipes
  Michael's memories, the entire hive (every agent, message, task, and the board), and
  the semantic-memory palace, then relaunches the app into onboarding.
- Boot loader ("clocking in") shown while the GOD agent initializes, so returning users
  no longer see the empty "add agent" screen during startup.

### Fixed
- Crash dialog on quit caused by sending IPC to an already-destroyed window during
  teardown; all renderer sends are now destroyed-safe and shutdown steps are best-effort.
- Michael no longer marches to the door flagged "needs you" right after finishing a turn —
  idle "waiting for input" notifications now let him linger at his desk instead of
  escalating as a blocked/needs-action state.

## [Brand & rename]

### Added
- Brand identity: **Munder Difflin** — logo (`docs/logo.svg`), square mark
  (`docs/logo-mark.svg`), and hero banner (`docs/banner.svg`).
- Landing page at `docs/index.html` (GitHub Pages–ready).
- In-app branding: window title, boot screen, title-bar `MD` badge, and fullscreen
  header captions.
- Open-source community files: `SECURITY.md`, `CHANGELOG.md`, issue/PR templates, and a
  CI workflow.

### Changed
- Renamed the project from *Claude Terminal Harness* to **Munder Difflin** across the
  README, docs (`SPEC.md`, `DESIGN.md`, `HIVE.md`), `package.json`, and the app UI.

## [0.1.0] — 2026

Initial working prototype.

### Added
- Electron + React + TypeScript shell (electron-vite).
- Real terminals via `node-pty`, rendered with xterm.js; multi-agent spawn/write/
  resize/kill over typed IPC (`window.cth`).
- Pixi.js office floor: Tiled map, camera, recolored cast, pathfinding, seat assignment,
  tool bubbles, and message envelopes.
- The hive: on-disk multi-agent layer (`hive.ts`), hook server + `cth-hook` shim and
  `Stop`-loop (`hooks.ts`), and a semantic memory layer (`memory.ts`).
- GOD orchestrator agent, approvals queue, and memory search panel.
- Sandboxed file browser + CodeMirror editor and a git tab (status, log, branches,
  commit graph).
- Onboarding wizard, safe-quit guard, and a tokenized SNES/Animal-Crossing design
  system.

[0.1.0]: https://github.com/chaitanyagiri/munder-difflin/releases/tag/v0.1.0

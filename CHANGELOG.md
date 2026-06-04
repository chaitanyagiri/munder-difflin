# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/chaitanyagiri/munder-difflin/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/chaitanyagiri/munder-difflin/releases/tag/v0.1.0

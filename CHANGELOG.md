# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

<div align="center">

<img src="./docs/logo.png" alt="Munder Difflin Inc — Multi-Agent Harness" width="340">

# Munder Difflin

**Local multi-agent harness for [Claude Code](https://claude.com/claude-code).**
Autonomous agents that message, route, and remember — coordinated by a **GOD** orchestrator
you talk to, and visualized as avatars at work on a shared office floor.

<p>
  <em>Electron · React · TypeScript · Pixi.js · xterm.js · node-pty</em>
</p>

<p>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-F4D35E.svg?style=flat-square&labelColor=6E1423"></a>
  <img alt="Status: prototype" src="https://img.shields.io/badge/status-working%20prototype-F4F1EA.svg?style=flat-square&labelColor=6E1423">
  <img alt="Platform: macOS | Windows | Linux" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-F4F1EA.svg?style=flat-square&labelColor=6E1423">
  <a href="./CONTRIBUTING.md"><img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-F4D35E.svg?style=flat-square&labelColor=6E1423"></a>
</p>

<br>

<img src="./docs/media/og.png" alt="Munder Difflin — A hive of agents that message, route, and remember" width="1240">

<br>

<!-- Inline player renders on github.com (raw URL required; relative paths only link). -->
<video src="https://github.com/chaitanyagiri/munder-difflin/raw/main/docs/media/hero.mp4" poster="https://github.com/chaitanyagiri/munder-difflin/raw/main/docs/media/og.png" controls muted loop playsinline width="820">
  <a href="https://github.com/chaitanyagiri/munder-difflin/raw/main/docs/media/hero.mp4">▶ Watch the floor — Munder Difflin running a hive of Claude Code agents</a>
</video>

</div>

---

> [!NOTE]
> **The world's best agents. The world's worst paper company.**
> Munder Difflin takes the `claude` CLI sessions you already run in your terminal and turns them
> into a self-coordinating team: each agent gets long-term memory, a mailbox, and a desk on a 2D
> office floor — and a **GOD orchestrator agent** routes work between them while you watch.

## What it is

Munder Difflin is a desktop app that wraps **real Claude Code terminals** as fully-capable agents,
wires them into a **hive mind**, and puts a **GOD orchestration agent** in charge — the one agent
*you* talk to in order to get things done. Under the hood it runs the **fastest memory layer in the
world** so every agent remembers what it learns and recalls it instantly.

- **Every terminal is an agent.** Each `claude` session runs as a real process in a pseudo-terminal
  (`node-pty`), byte-for-byte authentic, rendered with xterm.js.
- **Every agent is an avatar.** Sessions appear as characters on a Pixi.js office floor — they walk
  to stations as they work, and envelopes fly desk-to-desk when they message each other.
- **The hive coordinates them.** Agents read their memory and drain a mailbox; the router moves
  messages between inboxes; the GOD agent adjudicates, assigns, and escalates only when it needs you.
- **Memory that's instant.** A markdown-first memory layer with a semantic recall index means agents
  remember across sessions and recall in milliseconds.

## How it works

```
            you ── talk to ──►  ┌─────────────┐
                                │  GOD agent  │  orchestrator / supervisor
                                │ (Michael's  │  roster · routing · adjudication
                                │   office)   │  blackboard · task ledger
                                └──────┬──────┘
                                       │ assigns · routes · escalates
              ┌────────────────────────┼────────────────────────┐
              ▼                         ▼                         ▼
        ┌───────────┐            ┌───────────┐            ┌───────────┐
        │  agent A  │  message   │  agent B  │  message   │  agent C  │
        │  claude   │ ─────────► │  claude   │ ─────────► │  claude   │
        │  + memory │            │  + memory │            │  + memory │
        └───────────┘            └───────────┘            └───────────┘
              └──────── shared hive: memory · mailbox · blackboard · log ───────┘
```

1. **You spawn agents** — each is a normal `claude` process with its own working directory,
   identity, and hook lifecycle.
2. **Agents collaborate through the hive** — a local git repo of plain files. They write to their own
   `outbox/`; the harness's router delivers into recipients' `inbox/`. No agent ever touches git
   (single-committer design avoids `index.lock` corruption).
3. **The GOD agent runs the floor** — it reads every request, resolves routine ones itself (keeping
   the system fully autonomous), and only escalates *critical* items (spend, destructive ops, scope
   changes) into an approvals queue you act on.
4. **Everything is visible** — you watch avatars move, envelopes fly, and the live terminal stream;
   you can type back into any session, browse its files, and read its git history.

See [`HIVE.md`](./HIVE.md) for the full multi-agent design, [`SPEC.md`](./SPEC.md) for the
terminal/event plane, and [`DESIGN.md`](./DESIGN.md) for the visual system.

## Features

| Area | What works today |
|---|---|
| **Real terminals** | Spawn Claude Code, Codex, or a custom command in a `node-pty` PTY. Full read/write/resize/kill, live streaming over IPC, multi-agent. |
| **The hive** | On-disk multi-agent layer: per-agent identity + long-term memory, atomic-file mailboxes, a shared blackboard, append-only event log, single-committer git. |
| **GOD orchestrator** | An always-on supervisor agent that adjudicates traffic, routes tasks, scribes the blackboard, and escalates only critical items to you. |
| **Memory layer** | Markdown-first long-term memory per agent, mined into a shared semantic palace for instant recall; searchable from the UI. Degrades gracefully when the index isn't installed. |
| **Office floor** | Pixi.js scene with a Tiled office map, camera, recolored cast, pathfinding, seat assignment, and tool-bubble overlays. |
| **Message handoffs** | When the hive routes a message, an envelope flies from sender to recipient (tinted by speech-act; escalations fly to the door) and pops an arrival sparkle. |
| **Per-agent panel** | Live terminal, command bar to type back, fullscreen terminal, sandboxed file browser + CodeMirror editor, and a git tab (status, log, commit graph, branches). |
| **Approvals & memory panels** | Human-in-the-loop approval queue for escalations; a memory search panel over the shared palace. |
| **Onboarding wizard** | First-run setup: harness home, registered repos, default command, auto-mode. |
| **Design system** | Fully tokenized SNES / Animal-Crossing aesthetic — pixel panels, buttons, badges, hand-drawn icons. See [`DESIGN.md`](./DESIGN.md). |
| **Command Center** | Michael's control surface, overhauled in v0.2.0: Terminal, Floor (roster + dispatch + per-agent model selector + live fleet monitoring), Memory (MemPalace + text search + memory graph), Activity (log + board + real token telemetry + observability + CI watcher), Tasks (kanban board with dependencies + status tracking), Schedules (recurring missions + heartbeat). |
| **Per-agent git worktrees** | 'Git isolation' toggle in Add Agent auto-provisions a dedicated worktree per agent on spawn and tears it down on kill — agents never collide on branches. |
| **Token & cost telemetry** | Activity tab reads `~/.claude/projects/` JSONL transcripts and surfaces real token counts + estimated USD cost per agent per session, backed by a durable cost ledger that survives restarts. |
| **Per-agent token budgets** | Set a token budget per agent and watch live fleet monitoring track consumption across the whole roster — paired with the cost/runaway circuit breaker to keep spend in check. |
| **Observability** | Live OpenTelemetry collector with per-model cost attribution, a fleet grid, and a per-agent tool-span waterfall — see exactly what every agent is doing and what it costs, in real time. |
| **Context-window gauge** | Each agent card's progress bar is a context-window gauge — see how much of the model's context each agent has consumed at a glance. |
| **Circuit breaker** | A cost/runaway guard with a steer → constrain → stop ladder: the breaker nudges, then constrains, then stops agents that loop, storm errors, or blow their budget. |
| **HITL gate & mid-run control** | Human-in-the-loop gate, mid-run steer, and graceful stop — all driven through Claude Code hook returns, so you can intervene without killing the session. |
| **Durable persistence** | SQLite-backed durable store keeps window bounds + history across restarts, alongside the durable cost ledger and persisted session IDs. |
| **MemoryReflector** | Memory condensation that summarizes and bounds per-agent memory over time, so long-term memory doesn't grow without limit. |
| **Configurable home folder** | Point the hive/memory home at any folder, with a safe move that relocates existing state without losing it. |
| **Restore team** | One-click "Restore team" rebuilds last session's workers after a harness restart — no more re-adding agents by hand. |
| **Task kanban** | Dependency-aware kanban board in the Command Center Tasks tab — assign tasks to agents, track status across todo/doing/blocked/done, wire dependencies so work starts in order. |
| **Scheduled missions & heartbeat** | Recurring auto-dispatch missions with label, interval, target agent, and body — plus a scheduler heartbeat that re-engages the floor when it goes quiet. Delete scheduled missions inline, and see last/next-fired times in the Schedules tab. |
| **GitHub ingestion** | Pull open issues from any registered repo via the `gh` CLI and assign them to agents with one click from the Command Center. |
| **CI status watcher** | Live pass/fail/in-progress status for GitHub Actions runs, visible in the Activity tab for every registered repo. |
| **Threaded chat** | Every hive message is grouped by conversation and rendered as a reply chain in each agent's Messages tab — readable, replyable, auditable. |
| **Desktop notifications** | Native OS notifications when an agent finishes a task or is waiting for your input. |
| **Agent archival** | Closing an agent tab archives it (memory + history preserved) rather than destroying it. |
| **Avatar states** | Avatars reflect real work — including new v0.2.0 states for *compacting* (context compaction) and *looping* (circuit-breaker intervention), on top of crisper HiDPI floor text and high-contrast speech bubbles. |

> [!NOTE]
> **Status: v0.2.0 — observability, control, and durability.** This release brings a Command Center overhaul, per-agent token budgets with live fleet monitoring, full observability (live OpenTelemetry collector, per-model cost, fleet grid + per-agent tool-span waterfall), an agent-card context-window gauge, a cost/runaway circuit breaker (steer → constrain → stop) with a scheduler heartbeat, a human-in-the-loop gate plus mid-run steer and graceful stop via hook returns, SQLite-backed durable persistence (window bounds + history) and a durable cost ledger, the MemoryReflector for memory condensation, a configurable hive/memory home folder with safe move, one-click "Restore team" after restart, a delete button for scheduled missions, new *compacting* and *looping* avatar states, terminal legibility/contrast + HiDPI fixes, and a Windows fix to keep the hive alive behind the lock screen. All of v0.1.x — the hook plane, office floor, hive coordination, git isolation, token telemetry, task kanban, scheduled missions, GitHub/CI integration, threaded conversations, desktop notifications, agent archival, a Slack→queue bridge, and native human-in-the-loop approvals — remains functional and shipping. macOS (signed), Windows, and Linux builds are available on the releases page.

## Getting started

### Prerequisites

- **macOS** (macOS-first; Windows/Linux untested).
- **Node.js 18+** and npm.
- A **C/C++ toolchain** for `node-pty`'s native addon — on macOS, install Xcode Command Line Tools:
  ```bash
  xcode-select --install
  ```
- **[Claude Code](https://claude.com/claude-code)** on your `PATH` so agents can run `claude`
  (the default command). Add Agent also includes a Codex preset that runs `codex`
  without Claude-only flags; initial Codex support is terminal spawning with shared
  workspace/env, not Claude telemetry, hook parity, or hive inbox delivery (direct
  hive mail to Codex/custom agents bounces to the god agent).
- *Optional:* the semantic memory index for instant cross-session recall (the app works without it —
  markdown memory still functions).

### Install & run

```bash
git clone https://github.com/chaitanyagiri/munder-difflin.git
cd munder-difflin
npm install        # postinstall rebuilds node-pty against Electron's ABI
npm run dev        # launches the Electron app with hot reload
```

On first launch you'll go through the onboarding wizard, then land on the floor. Use **Add agent** to
spawn your first session — the GOD agent seats itself in Michael's office automatically.

### Other scripts

```bash
npm run build      # production build via electron-vite
npm run preview    # preview the production build
npm run typecheck  # type-check the node (main/preload) and web (renderer) projects
```

> If `node-pty` fails to load after an Electron upgrade, re-run `npm install` (the `postinstall` hook
> runs `electron-rebuild` against the current Electron ABI).

## Architecture

Two data planes feed one renderer:

```
┌───────────────────────────────────────────────────────────────┐
│                     Electron Renderer (React)                  │
│   ┌──────────────────┐    ┌──────────────────────────────┐    │
│   │ Office Floor      │    │ Terminal + Command Bar       │    │
│   │ (Pixi.js)        │    │ Files + Git tabs (xterm.js)  │    │
│   └─────────▲────────┘    └────────────▲─────────────────┘    │
│             │ avatar state             │ pty bytes / fs / git  │
└─────────────┼──────────────────────────┼───────────────────────┘
              │ IPC (contextBridge: window.cth)
       ┌──────┴──────────┐        ┌──────┴─────────────┐
       │  Event Plane    │        │  Terminal Plane    │
       │  hooks / hive   │        │  node-pty PTYs     │
       │  router + GOD   │        │  + fs + git        │
       └────────▲────────┘        └──────▲─────────────┘
                │ hook payloads          │ stdin / stdout
                └─────────┬──────────────┘
                   ┌──────┴──────────────┐
                   │  claude (or any cmd)│
                   └─────────────────────┘
```

- **Terminal plane.** The main process owns a `PtyManager` that spawns each agent as a `node-pty`
  process and streams output over per-id IPC (`pty:data:<id>`). The renderer talks only through a
  typed `window.cth` bridge ([`src/preload/index.ts`](./src/preload/index.ts)), which also exposes
  sandboxed filesystem and git helpers.
- **Hive / event plane.** `hive.ts` is the on-disk multi-agent layer; `hooks.ts` runs a Unix-socket
  server that the per-agent `cth-hook` shim POSTs Claude Code hook payloads to (`PreToolUse`,
  `PostToolUse`, `Stop`, …); `memory.ts` wraps the semantic memory CLI. The router delivers messages,
  the GOD agent adjudicates, and a `Stop`-loop keeps idle agents draining their inboxes.

## Project structure

```
src/
  main/                      Electron main process (Node)
    index.ts                 window, IPC handlers, quit guard
    pty.ts                   node-pty manager (spawn/write/resize/kill/stream)
    hive.ts                  on-disk multi-agent layer (memory, mailboxes, router)
    hooks.ts                 UDS hook server + cth-hook shim + Stop-loop
    memory.ts                semantic memory layer (CLI wrapper, degrade-to-noop)
    config.ts                harness config persistence + home setup
    transcript.ts            reads ~/.claude/projects/ JSONL transcripts for real token/cost telemetry
    telemetry.ts             live OTel collector + usage/cost feed for observability
    usage.ts / pricing.ts    UsageProvider seam + per-model cost attribution
    breaker.ts / control.ts  cost/runaway circuit breaker (steer/constrain/stop) + HITL gate / steer / stop
    reflect.ts               MemoryReflector — memory condensation
    db.ts                    SQLite durable store (window bounds + history) + durable cost ledger
    github.ts                GitHub issue + CI run ingestion via the gh CLI
    assistant.ts             headless Sonnet enrichment pipeline (Dwight)
    shellEnv.ts              resolve PATH and shell env for child processes
    fs.ts / git.ts           sandboxed filesystem + git bridges
  preload/                   contextBridge → typed window.cth API
  renderer/src/
    App.tsx                  top-level layout + wiring
    design/                  tokens.css / tokens.ts / global.css (design source of truth)
    components/              PixelPanel, AgentDetailPanel, CommandBar, ApprovalsPanel, MemoryPanel, …
    CommandCenterPanel,      Michael's control surface (Terminal/Floor/Memory/Activity/Tasks/Schedules/Handbook tabs)
    ToolWaterfall,           per-agent tool-span waterfall for the observability view
    TasksKanban,             dependency-aware kanban board (Tasks tab)
    ThreadsPanel,            hive message conversation viewer (Messages tab)
    MessageQueueComposer,    park messages for a busy agent + enrich toggle
    scene/office/            Pixi office floor: OfficeFloor, Character, Camera, cast, pathfinding, …
    store/ · hooks/          zustand store, event loop, PTY parser, typewriter
    assets/                  tilesets, maps, character sheets (see ATTRIBUTION.md)
docs/                        `logo.png`, `banner.png`, landing page (GitHub Pages → munderdiffl.in)
docs/media/                  `og.png` (social previews) + rendered Remotion clips
landing-remotion/            Remotion project that renders the landing page's "how it works" clips
HIVE.md · SPEC.md · DESIGN.md   multi-agent · terminal/event · visual design
```

## Design system

The aesthetic is **Animal Crossing × Earthbound × SNES menu UI** — pixel-snapped, chunky, friendly.
[`DESIGN.md`](./DESIGN.md) is canonical; every component derives from its tokens. The Munder Difflin
brand layers a **Dunder-Mifflin maroon** (`#6E1423`) and **gold** (`#F4D35E`) on top for logo and
chrome. The 15 avatars are the cast of *The Office*, differentiated by hair/skin/shirt recipes.

## Roadmap

Shipped in **v0.2.0**:

- [x] **Heartbeat** — scheduler heartbeat that re-engages the floor when it goes quiet, with last/next-fired times surfaced in the Schedules tab.
- [x] **Memory reflection** — the MemoryReflector summarizes and bounds per-agent memory over time to prevent unbounded growth.
- [x] **Persistence** — SQLite-backed durable store for window bounds + history across restarts, plus a durable cost ledger and persisted session IDs.
- [x] **Hook-driven avatars** — broadened hook→station coverage and caged the synthetic demo loop, with new *compacting* and *looping* avatar states.

Next up:

- [ ] **Chat integrations** — Slack and Telegram bridges that pipe a channel straight into Michael's queue (and route his replies back out), so you can run the floor from your phone.
- [ ] **Pluggable agent CLIs** — run the harness over coding-agent CLIs beyond Claude Code: Claw Code, opencode, and Codex CLI.
- [ ] **Realtime Michael** — a low-latency realtime LLM channel for quick, snappy back-and-forth with the orchestrator, alongside the async terminal.
- [ ] **Fuller avatar coverage** — push the remaining station visits and tool-bubbles to be driven 100% by real Claude Code hook events.
- [ ] **Durable layout & command history** — extend persistence to agent layout and per-session command history.

## Contributing

Contributions are welcome — this is an early prototype with a lot of surface area. Start with
[`CONTRIBUTING.md`](./CONTRIBUTING.md). The short version: fork, `npm install && npm run dev`, keep
`npm run typecheck` green, and **derive any new UI from [`DESIGN.md`](./DESIGN.md) tokens**. Good
first areas: wiring real hook events, the add-agent flow, the config drawer, and cross-platform work.

## License

> [!IMPORTANT]
> **Asset licensing.** The bundled pixel art (tilesets, maps, and the base character sheets the
> Office cast is recolored from) comes from [LimeZu](https://limezu.itch.io/) via
> [`shahar061/the-office`](https://github.com/shahar061/the-office) under the **LimeZu FREE VERSION
> license — non-commercial use only**. The recolored sprites inherit that restriction. See
> [`src/renderer/src/assets/ATTRIBUTION.md`](./src/renderer/src/assets/ATTRIBUTION.md). **To
> commercialize, replace these assets or obtain a paid LimeZu license.**

The **source code** is licensed under the **MIT License** — see [`LICENSE`](./LICENSE). The MIT grant
covers the code only; the non-commercial asset restriction above is carved out in the `LICENSE` scope
note. *Munder Difflin* is an affectionate parody and is not affiliated with NBC's *The Office* or
Dunder Mifflin.

## Acknowledgements

- [LimeZu](https://limezu.itch.io/) — pixel-art tilesets and character base sheets.
- [`shahar061/the-office`](https://github.com/shahar061/the-office) — office tileset/map vendoring.
- [Pixi.js](https://pixijs.com/) · [xterm.js](https://xtermjs.org/) · [node-pty](https://github.com/microsoft/node-pty) · [electron-vite](https://electron-vite.org/) · [CodeMirror](https://codemirror.net/) — the libraries this is built on.
- [Remotion](https://www.remotion.dev/) — the landing page's animated "how it works" clips (`landing-remotion/`).
- *The Office* (US) — for Munder Difflin, Inc.

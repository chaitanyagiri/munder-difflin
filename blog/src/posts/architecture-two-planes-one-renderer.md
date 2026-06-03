---
title: "Munder Difflin's Architecture: Two Data Planes, One Renderer"
description: "A walkthrough of the multi-agent harness architecture: a node-pty terminal plane and a hooks/hive event plane feeding one React + Pixi.js renderer."
date: 2026-06-04
category: internals
categoryLabel: Internals
type: Technical
primaryKeyword: "multi-agent harness architecture"
secondaryKeywords: ["electron architecture", "ipc", "agent harness design"]
tags: ["Internals", "Architecture", "Electron", "Multi-Agent"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What are the two data planes in Munder Difflin?"
    a: "The terminal plane carries raw pseudo-terminal bytes from each agent's shell (node-pty) to an xterm.js view. The event plane carries structured agent state — Claude Code hook events and routed hive messages — to the office-floor visualization. One is byte-for-byte authentic; the other is event-driven."
  - q: "Why separate the terminal stream from the event stream?"
    a: "Each answers a different question. The raw terminal stream shows exactly what the agent output; the event stream tells you which tool is running without parsing that output. Hooks alone miss the stream the user expects to see; the stream alone can't reliably say what's happening. Together they cover both."
  - q: "How do the planes reach the UI?"
    a: "Through Electron IPC. The main process owns the PTYs, a hook socket, and the hive; it forwards terminal bytes and structured events to the renderer, where React and Pixi.js draw the terminals and the office floor."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>The
<strong>multi-agent harness architecture</strong> rests on one decision: <strong>two data
planes</strong>. A <strong>terminal plane</strong> streams raw node-pty bytes to xterm.js (authentic
shells), and an <strong>event plane</strong> carries structured Claude Code hook events plus routed
hive messages to a Pixi.js office floor (what's happening, at a glance). Both flow over Electron IPC
into <strong>one React + Pixi renderer</strong>. The terminal plane is the truth; the event plane is
the story.</p></div>

Most of what Munder Difflin does follows from a single architectural choice, so it's worth walking
through. The harness runs many real Claude Code agents and shows you two things about each: the exact
terminal output, and a live picture of what it's doing. Those are different kinds of data, so they
travel on **two separate planes** that meet in one renderer. Here's the whole shape.

## The load-bearing decision: two planes

```
┌──────────────────── Electron Renderer (React + Pixi) ───────────────────┐
│   Office floor (Pixi.js)            Terminal view (xterm.js)             │
│        ▲ avatar state                     ▲ pty bytes                    │
└────────┼──────────────────────────────────┼────────────────────────────┘
         │ IPC                               │ IPC
   ┌─────┴───────────────┐            ┌──────┴──────────────┐
   │   Event Plane       │            │  Terminal Plane     │
   │ hooks + hive router │            │     node-pty        │
   └─────▲───────────────┘            └──────▲──────────────┘
         │ JSON events                       │ raw bytes
   ┌─────┴───────────────────────────────────┴──────────────┐
   │            Claude Code processes (one per agent)        │
   └────────────────────────────────────────────────────────┘
```

Each agent is one real `claude` process. From it we read two streams:

- a **byte stream** — exactly what the shell printed, and
- an **event stream** — structured "I'm about to use this tool," "a message routed," "I stopped."

Keeping them separate is the whole trick. Let's take each plane, then how they converge.

## The terminal plane (node-pty)

The terminal plane is about *fidelity*. Each agent runs in a real pseudo-terminal via
[node-pty](/blog/node-pty-electron-real-terminals/), so its shell behaves byte-for-byte like a normal
terminal — colors, prompts, full-screen TUIs, all authentic. The main process owns the PTY and
forwards its output to the renderer over IPC on a per-session channel; keystrokes from the UI travel
back the same way. The renderer paints it with a pooled xterm.js terminal per agent (the technique
behind [rendering many live terminals](/blog/rendering-many-live-terminals-performance/)).

What the terminal plane gives you: the unfiltered truth of what each agent did. What it *can't* easily
give you: a reliable "which tool is running right now?" without scraping and guessing at output. That's
the other plane's job.

## The event plane (hooks + hive)

The event plane is about *structure*. It has two sources, both feeding the main process:

**Claude Code hooks.** Each agent is launched with lifecycle hooks wired through a tiny shim that
forwards every event — `PreToolUse`, `PostToolUse`, `Stop`, `Notification` — to a Unix domain socket
the main process listens on. These are clean, typed signals: "about to run Bash," "finished editing,"
"idle and waiting." No output parsing required. (See
[Claude Code hooks, explained](/blog/claude-code-hooks-explained/).)

**The hive.** The coordination layer — per-agent mailboxes, a message router, single-committer git, and
shared memory — emits its own events as it works: a message routed from A to B, an item escalated to
the human. The [GOD orchestrator](/blog/how-the-god-orchestrator-works/) lives here as the
intelligence; the main process is the mechanism that moves messages and commits state.

Both sources land in the main process, which forwards structured events to the renderer. There they
drive the office floor: avatars walk to stations on tool events, envelopes fly on message events.

## Why both planes (the rationale)

The temptation is to pick one. Each alone is insufficient:

- **Hooks alone** don't give you the raw stream the user expects to *see* — you'd know an agent ran a
  command but not what it printed.
- **The terminal stream alone** can't tell you which tool is running without fragile output parsing —
  you'd see bytes but have to guess at meaning.

Together they're complementary: the office floor is **event-driven** (precise, structured, cheap to
render), and the terminal view is **byte-for-byte authentic** (the full detail when you want it). Two
planes, two questions, both answered well.

## One renderer convergence

Both planes terminate in a single Electron renderer running React and Pixi.js:

- **React** owns the app shell, panels, and the xterm.js terminal views (the terminal plane).
- **Pixi.js** owns the office floor — avatars, the Tiled map, flying envelopes (the event plane), in
  one camera-controlled world updated by a single ticker (the design in
  [visualizing AI agents with Pixi.js](/blog/visualizing-ai-agents-pixijs/)).

The bridge between the main process and the renderer is a typed **preload API** exposed over Electron's
context bridge — the renderer calls into it to spawn/write/resize PTYs and read hive state, and
subscribes to it for incoming terminal bytes and hive events. Crucially, the renderer never touches the
filesystem, git, or the agents directly; it only talks to the main process. That keeps a hard line
between *mechanism* (main process: PTYs, sockets, git, routing) and *presentation* (renderer: React +
Pixi).

## Why this architecture holds up

A few properties fall out of the two-plane design:

- **Separation of concerns.** Fidelity and structure are independent problems solved independently. You
  can improve terminal rendering without touching the event pipeline, and vice versa.
- **The main process is the single source of authority.** PTYs, the hook socket, the hive's git repo,
  and the memory layer all live in one place; the renderer is a consumer. That's what makes the
  [single-committer git pattern](/blog/single-committer-git-pattern/) and safe IPC possible.
- **Real, not simulated.** Because the event plane carries actual hook and router events, the
  visualization can't drift from reality — it *is* reality, rendered.

It's the architecture that lets "a hive of Claude Code agents" be both something you can *read* (the
terminals) and something you can *watch* (the floor) — which is the heart of what a
[multi-agent harness](https://munderdiffl.in/#what) is.

## FAQ

**Where does memory fit in the two planes?** Alongside the event plane's hive layer. The shared
semantic memory is driven by the main process (a CLI it points each agent at), and recall happens in
the agents themselves — it's part of the coordination mechanism, not a third UI plane.

**Could you add a third plane?** You could, but the discipline is to keep planes orthogonal. New
signals usually fit the event plane (more structured events) or the terminal plane (more byte
streams) rather than needing a new one.

---

Munder Difflin's two-plane architecture — authentic node-pty terminals plus an event-driven Pixi.js
floor, converging in one renderer — is what makes a hive both legible and real.
[Download Munder Difflin](https://munderdiffl.in/#install) to see the architecture in action; it's
free and open source.

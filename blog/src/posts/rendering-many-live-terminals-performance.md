---
title: "Rendering Many Live Terminals Without Melting the CPU"
description: "xterm.js performance for many live PTYs: a terminal pool, render-only-visible, smart scrollback, and accelerated rendering to stream dozens at once."
date: 2026-06-03
category: internals
categoryLabel: Internals
type: Technical
primaryKeyword: "xterm.js performance"
secondaryKeywords: ["terminal rendering", "xterm.js performance", "electron performance"]
tags: ["Internals", "Performance", "xterm.js", "Terminals"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "How do you render many xterm.js terminals without high CPU?"
    a: "Keep one persistent terminal per session and only render the visible one(s); re-parent the terminal's element instead of recreating it, tune scrollback, and use an accelerated renderer when throughput is high. The buffers keep filling in the background while you paint just what's on screen."
  - q: "Why is recreating an xterm terminal on tab switch slow and buggy?"
    a: "node-pty keeps no scrollback, so a freshly created terminal is blank until the program repaints — and recreating instances thrashes the CPU. A persistent pool avoids both: the terminal lives for the session and its DOM element is moved in and out of views."
  - q: "Does scrollback size affect performance?"
    a: "Yes. xterm holds scrollback in memory per terminal, so a large scrollback multiplied by many terminals adds up. Pick a generous-but-bounded value and tune it to your workload."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>Streaming dozens of live PTYs to xterm.js
stays cheap if you do four things: keep <strong>one persistent terminal per session</strong> (don't
recreate on tab switch), <strong>render only what's visible</strong> while buffers fill in the
background, <strong>bound your scrollback</strong>, and reach for an <strong>accelerated renderer</strong>
only when throughput demands it. The big win is the persistent pool — it fixes both the blank-terminal
bug and the CPU thrash at once.</p></div>

A single xterm.js terminal is cheap. Thirty of them, all streaming output from live agents while the
user switches between them, is where naive implementations melt the CPU — or show blank panes. This
post is the performance playbook for rendering many live terminals at once, built on the same techniques
that keep an agent harness's floor of terminals smooth.

## The naive approach and why it hurts

The obvious design: when a terminal view mounts, create an xterm `Terminal`; when it unmounts, dispose
it. For one terminal it's fine. For many, it fails twice:

1. **CPU thrash.** Creating and destroying terminal instances as the user switches tabs is expensive —
   you're rebuilding the emulator, re-opening it, re-measuring the grid, over and over.
2. **Blank terminals.** node-pty keeps **no scrollback** — the buffer lives in xterm, not the PTY. So a
   freshly created terminal starts empty and stays blank until the running program happens to repaint.
   For an idle shell, that might be never.

Both problems have the same root: tying the terminal's *lifetime* to a *view's* lifetime. The fix is to
decouple them.

## Technique 1 — A persistent terminal pool

Create **one** xterm terminal per PTY session and keep it alive for the whole app lifetime, independent
of any view:

- The terminal is opened into a **detached host element** and subscribes to its PTY's output stream
  **once**. Its buffer keeps filling whether or not it's currently on screen.
- A view doesn't create a terminal — it **borrows** one. On mount it re-parents the existing host
  element into itself; on unmount it lets go. The rendered content moves with the element, so the
  terminal is populated and visible *immediately*, with no repaint.

```ts
// borrow, don't build: move the live terminal's element into the view
function attachTerminal(entry, container) {
  container.appendChild(entry.host);
  if (!entry.opened) { entry.term.open(entry.host); entry.opened = true; } // open once, lazily
}
```

This single change fixes both naive problems: no per-switch teardown (no thrash) and no empty buffer
(no blank pane). It's the structural decision everything else builds on — the same pool pattern at the
center of [building a terminal UI with xterm.js and node-pty](/blog/building-a-terminal-ui-xterm-node-pty/).

## Technique 2 — Render only what's visible

A pool keeps every session's *buffer* current, but you don't need to *paint* every terminal every
frame. Only the terminal(s) actually on screen need to be laid out and rendered; the rest keep
accumulating output in memory at near-zero cost. When the user switches to one, it's already
up to date — you just attach its element.

The principle: **decouple "receiving output" from "drawing pixels."** Receiving is cheap and always-on;
drawing is the expensive part, so do it only for what's visible. A floor of thirty agents costs you the
rendering of the one or few panes you're looking at, not all thirty.

## Technique 3 — Bound your scrollback

xterm holds scrollback in memory, per terminal. A 10,000-line scrollback is comfortable for one
terminal and adds up fast across many. So:

- Pick a **generous but bounded** scrollback (enough to scroll back usefully, not infinite).
- Remember it's **per terminal** — multiply by your terminal count for the real memory cost.
- Tune to your workload: high-volume log streams want less retained history than an interactive shell.

It's a small knob with a real effect when you have dozens of buffers alive at once.

## Technique 4 — Stream efficiently from the PTY

The bytes have to cross from the main process (where node-pty lives) to the renderer (where xterm
lives) over IPC. A few habits keep that path cheap:

- **Per-session channels.** Each PTY forwards its output on its own channel so the renderer routes
  chunks to the right terminal without inspecting them.
- **Guard sends during teardown.** Killing a PTY fires its exit asynchronously; if the window is gone
  by then, sending throws. Check the target is alive before each send so quit stays clean (and you
  don't pay for sends into the void).
- **Let xterm batch.** xterm coalesces writes internally; feed it raw chunks and let it manage its own
  render scheduling rather than forcing a refresh per byte.

These come straight from how the [node-pty terminal plane](/blog/node-pty-electron-real-terminals/)
streams to the UI.

## Technique 5 — Reach for an accelerated renderer when needed

xterm's default DOM renderer is fine for a handful of terminals. When you're rendering many
high-throughput streams, an accelerated rendering addon (canvas/WebGL) moves the drawing off the DOM
and reduces CPU. The discipline: **measure first.** Add it when your real workload shows the DOM
renderer is the bottleneck — not preemptively, since for modest terminal counts it's unnecessary
complexity.

## The shape of a fast many-terminal UI

Put it together and the system looks like this:

1. **One persistent terminal per PTY**, in a pool, subscribed once.
2. **Only the visible terminals render**; the rest keep filling buffers cheaply.
3. **Bounded scrollback**, tuned per workload.
4. **Per-session IPC streaming** with teardown-safe sends.
5. **An accelerated renderer** added only when measurement says so.

That's how a single window can show a whole floor of live agents — each in its own real terminal,
switchable instantly — without the fans spinning up. The visual companion to all those terminals, the
office floor, follows the same keep-the-hot-loop-tight philosophy in
[visualizing AI agents with Pixi.js](/blog/visualizing-ai-agents-pixijs/).

## FAQ

**How many terminals can this handle?** Enough that your bottleneck becomes the agents and your RAM,
not the rendering. Because only visible terminals paint and buffers are cheap, the count you can keep
*alive* is far higher than the count you'd ever look at simultaneously.

**Do I lose output for terminals I'm not looking at?** No — that's the point of the pool. Off-screen
terminals still receive and buffer their PTY's output; you just aren't paying to draw them until you
switch over.

---

Munder Difflin streams [a whole floor of live Claude Code terminals](https://munderdiffl.in/#what) with this exact approach — a
persistent pool, visible-only rendering, and teardown-safe IPC. [Download Munder Difflin](https://munderdiffl.in/#install)
to run many real terminals without melting your CPU; it's free and open source.

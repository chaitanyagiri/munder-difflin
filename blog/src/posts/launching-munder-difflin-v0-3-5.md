---
title: "Launching Munder Difflin v0.3.5: A Michael Who Knows the Floor, a Git Time-Machine, and an App That Updates Itself"
description: "The v0.3.4 + v0.3.5 wave: voice orchestration with live floor context and full app control, markdown previews everywhere, commit history and branch compare in the built-in IDE, a six-tab Settings redesign, xAI Grok and Kimi Code engines, auto-update, and a queue that always has an escape hatch."
date: 2026-08-06
category: story
categoryLabel: Story
type: Non-technical
primaryKeyword: "munder difflin v0.3.5"
secondaryKeywords: ["voice ai agent orchestration", "git commit history ide electron", "markdown preview ai agent output", "electron app auto update github releases", "grok cli agent", "claude code multi-agent release"]
tags: ["Story", "Release", "Multi-Agent", "Voice", "IDE", "Open Source"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What's new in Munder Difflin v0.3.5?"
    a: "v0.3.5 is the polish pass on top of the big v0.3.4 wave, so the headline is really both: Michael's talk mode now opens with a live snapshot of every agent and can run nearly the whole app by voice; markdown files preview live in the IDE and open rendered from a ⌘-click in any terminal; the IDE gains a clickable commit history, branch compare, and guarded checkout; Settings was redesigned into six clear tabs; xAI Grok and Kimi Code joined the engine roster; the app now auto-updates from GitHub releases; and v0.3.5 itself fixes the paused-queue dead end with a per-message 'send now' override."
  - q: "Do I need to reinstall to get v0.3.5?"
    a: "If you're on v0.3.4 — no. This is the first release the app delivers to itself: it downloads in the background and shows a 'Restart to update' toast; installation only ever happens on your click. If you're on v0.3.3 or older there's no updater in your build, so grab v0.3.5 once from munderdiffl.in and you're on the train from then on."
  - q: "What can Michael actually do by voice now?"
    a: "Nearly everything: spawn and archive agents, assign and steer work, resume paused agents, pause or resume floor-wide message delivery, gate specific tools, manage tasks, create schedules, clear an agent's context, and change settings from a strict allowlist. Destructive actions still require you to say a distinct confirm word out loud, secrets can never be touched by voice, and he now answers 'what's everyone doing?' from a live floor snapshot instead of guessing."
  - q: "What does the git time-machine in the IDE do?"
    a: "The IDE rail gains HISTORY and COMPARE next to CHANGES. History is a clickable commit graph: pick any commit, see the files it touched, and open side-by-side diffs of exactly what changed. Compare takes any two branches and shows ahead/behind counts and per-file diffs. Checkout is guarded — it refuses to move a dirty tree or pull code out from under an agent that's actively working."
  - q: "Is the markdown preview safe for agent-generated files?"
    a: "Yes, by construction. There is no raw-HTML pipeline at all, links never navigate the app (external ones open in your browser, relative .md links open in a new preview), and remote images are blocked by the app's content security policy. Agents write a lot of markdown; you can now read it rendered without trusting it."
  - q: "How does Munder Difflin compare to YC's qm?"
    a: "They're complementary answers to the same problem. qm is a multiplayer agent harness for teams — headless, living in Slack and a web UI. Munder Difflin covers the same jobs (security postures, background scheduled work, Slack triggers, shareable skills) as a simpler local-first desktop app, and adds real watchable terminals, voice orchestration, a built-in IDE with git visualization, and auto-update. See our full qm vs Munder Difflin comparison post."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p><strong>Munder Difflin v0.3.5</strong> caps the biggest release wave we've shipped. <strong>Talk mode grew up</strong>: Michael opens the call already knowing every agent's status and can run nearly the whole app by voice. The IDE became a <strong>git time-machine</strong> — clickable commit history, branch compare, guarded checkout — and <strong>markdown previews</strong> render everywhere agents write them. <strong>Settings got six clear tabs</strong>, <strong>xAI Grok and Kimi Code</strong> joined the engine roster, the whole app got a <strong>professional type-and-color pass with full dark mode</strong> — and from v0.3.4 onward, <strong>the app updates itself</strong>. Free, MIT-licensed, local-first.</p></div>

This is a double-feature post: v0.3.4 shipped the features, v0.3.5 shipped the polish a day
later, and if you're installing fresh you get both at once. A huge part of this wave is
community work — the terminal/queue/roster reliability overhaul is by
[**Vyapak Goyal (@gts-47)**](https://github.com/gts-47), with major fixes by
[**@qschmick**](https://github.com/qschmick).

## Michael finally knows the floor

Talk mode has been able to *do* things since v0.3.2. What it couldn't do was *know* things
without looking them up — every "what's everyone working on?" turned into tool calls and
dead air.

Now the voice session opens with a compact live snapshot of the whole floor — every agent's
status, engine, context fill, circuit-breaker state, inbox depth, and in-flight tasks — and
keeps receiving silent floor updates as things change mid-call. Ask what's happening and he
just answers.

He also graduated from narrator to operator. New voice verbs: **resume** a paused agent,
pause/resume floor-wide message delivery, **gate specific tools**, delete tasks,
archive/unarchive agents, **clear an agent's context**, **create schedules**, and **change
settings** — from a strict allowlist where secrets and dangerous keys are refused outright,
behavior-changing keys echo old→new values, and anything destructive still waits for you to
say a distinct confirm word. He even knows what version he's running: ask "what's new in
this update?" and he reads you the release notes.

## The IDE becomes a git time-machine

v0.3.3's IDE could show you a diff against HEAD. This wave makes it a place you can *move
through history*:

- **HISTORY** — a clickable commit graph of the whole repo. Pick a commit, see every file
  it touched, open a side-by-side diff of exactly what changed. "Jump here" checks out any
  commit — with guards.
- **COMPARE** — pick any two branches, see ahead/behind counts and per-file diffs, and
  switch between them safely.
- **Guarded checkout** — the harness refuses to move a dirty tree, and refuses to yank code
  out from under an agent whose terminal was active in the last ten seconds. Your agents'
  work can't be stranded by a curious click.

And because agents write markdown constantly — plans, reports, READMEs — **markdown now
renders everywhere**: a live **code | split | preview** switch in the IDE, and **⌘-click on
any `.md` path an agent prints in its terminal** to open a rendered preview instantly.
Safe by construction: no raw-HTML pipeline exists, links never navigate the app, and remote
images are blocked by CSP.

{% img "note-1" %}

## A queue you can trust — and escape

The reliability heart of this wave is Vyapak's work: **one delivery gate for every
automatic writer**. A single drain loop now owns the "is this terminal free?" decision, and
automation never wipes your draft or closes your menus — a half-typed prompt or an open
picker visibly holds delivery instead of being typed over.

v0.3.5 closes the last dead end: pausing floor-wide auto-delivery used to strand queued
messages with no explanation and no override. Now the composer tells you the queue is held,
and every queued row gets a **send now** link that bypasses *only* the pause — all the
draft/picker/idle safety still applies.

Also fixed in the wave: the blank-terminal pane (WebGL context leases), killed processes
that didn't actually die, breaker false-positives on idle agents, and ~350× faster warm
usage reads.

## More engines, a calmer face, and an app that updates itself

- **xAI Grok** joins as a full hive citizen and **Kimi Code** as a worker engine — the
  roster is now nine. The Claude picker adds **Fable 5** (the new default) and **Sonnet 5**.
- **Settings, redesigned** into six tabs — General, Agents & Models, Autonomy & Budgets,
  Connections, Voice, Memory & Knowledge — and the default model, autonomy mode, and the
  full circuit breaker finally have real controls.
- **A professional design pass**: recalibrated type and muted colors, hairline borders,
  compact agent cards, and a **full-app dark mode** (not just the terminals).
- **Auto-update**: the app checks GitHub releases, downloads in the background, and offers
  "Restart to update" — installation is always your click. v0.3.5 is the first release
  delivered this way; if you're on 0.3.4, it's probably already waiting for you.

{% img "note-2" %}

## Where this fits

If you've seen [YC's qm](https://github.com/yc-software/qm) — a multiplayer agent harness
for teams in Slack and the browser — Munder Difflin is the same idea grown from the other
end: **local-first, on your desktop, with everything watchable**. Same jobs (postures,
scheduled background work, Slack, skills), simpler shape, plus the things a desktop app can
do that a headless harness can't: real terminals, voice, an IDE, auto-update. We wrote up
[an honest comparison](/blog/qm-vs-munder-difflin/).

## Get it

**[Download v0.3.5](https://github.com/chaitanyagiri/munder-difflin/releases/latest)** for
macOS, Windows, or Linux — or clone and `npm run dev`. On v0.3.4? Do nothing — the update
toast will find you. Free, MIT-licensed, local-first.

If Munder Difflin is useful to you, a
[star on GitHub](https://github.com/chaitanyagiri/munder-difflin) is the single biggest way
to help it reach more people.

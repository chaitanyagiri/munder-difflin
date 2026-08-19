---
title: "What's Up With Munder Difflin: Six Weeks, Four Releases, and the Part of the Stack You Actually Own"
description: "Everything that shipped between v0.3.3 and v0.3.7 — a Michael who knows the floor and runs the app by voice, a git time-machine in the IDE, nine agent engines, a queue that respects your draft, Node that installs itself, and the auto-update bug that had been silently broken since the day we shipped it."
date: 2026-08-08
category: story
categoryLabel: Story
type: Non-technical
primaryKeyword: "munder difflin v0.3.7"
secondaryKeywords: ["personal agi harness", "local multi agent harness update", "claude code multi-agent release notes", "voice ai agent orchestration", "electron auto update fix", "open source agent harness"]
tags: ["Story", "Release", "Multi-Agent", "Voice", "IDE", "Open Source"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What's new in Munder Difflin v0.3.7?"
    a: "v0.3.7 fixes auto-update, which had silently never worked in any packaged build since it shipped in v0.3.4. A CommonJS export vanished across the ESM import boundary, the resulting error was swallowed by a catch block, and the app quietly fell back to just linking you to the releases page. The version number in the toolbar is now the update button — it shows download progress and turns into 'restart to update' — and update failures now reach both the UI and a log file instead of disappearing."
  - q: "What shipped between v0.3.3 and v0.3.7?"
    a: "Four releases in about six weeks. v0.3.4 was the big wave: voice orchestration that opens with a live snapshot of every agent and can run nearly the whole app, markdown previews everywhere, a git time-machine in the built-in IDE (commit history, branch compare, guarded checkout), a six-tab Settings redesign, xAI Grok and Kimi Code engines, and one single delivery gate for every automatic writer. v0.3.5 added a 'send now' escape hatch for a paused queue. v0.3.6 made a machine with nothing installed on it able to run agents — Node and npm install themselves, verified against Apple's published checksums. v0.3.7 fixed auto-update."
  - q: "Do I need to reinstall to get v0.3.7?"
    a: "Yes, once. Every build from v0.3.4 through v0.3.6 carries the broken updater and cannot fetch the fix that repairs it — the one bootstrap problem a self-updating app can't solve for itself. Download v0.3.7 from munderdiffl.in or the GitHub releases page. From v0.3.7 onward, updates download in the background and wait for your restart."
  - q: "How many agent CLIs does Munder Difflin support?"
    a: "Nine: Claude Code, OpenAI Codex, Antigravity (Gemini), GitHub Copilot CLI, xAI Grok, Kimi Code, OpenCode, Crush, and pi.dev. Each gets a desk, a mailbox, and shared memory, and most can play the GOD orchestrator role themselves. You can mix engines on the same floor, and bring your own API keys or point them at local models through Ollama, LM Studio, or vLLM."
  - q: "Is Munder Difflin free?"
    a: "Yes. MIT-licensed, free forever, and local-first. It drives the agent CLI subscriptions you already pay for rather than adding a bill of its own, and your code never leaves your machine."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>Six weeks, four releases. <strong>Michael learned the floor</strong> and can now run nearly the whole app by voice. The IDE became a <strong>git time-machine</strong>. Two more engines brought the roster to <strong>nine</strong>. The message queue got <strong>one gate</strong> instead of four competing loops. A machine with <strong>nothing installed on it</strong> can now run agents. And <strong>auto-update — which had never once worked</strong> — actually works. If you're on v0.3.5 or v0.3.6, you'll need to grab v0.3.7 by hand, once.</p></div>

AGI is not going to arrive as an event. No announcement, no threshold, no day the sky
changes colour. It's arriving diffused — your agents, running on your context, doing your
work, on hardware you own.

Garry Tan puts the next decade in one line: **a rented frontier model, plus your own
context, plus a harness that wires them together.** Only one of those three is for sale, and
it's the cheapest one. The model is a commodity you rent by the token. Your context — your
repos, your decisions and the reasons behind them, what you owe people and what they said
last time — isn't for sale at any price, because it only exists in your head.

The harness is the part in the middle. It decides which context reaches which model at which
step, and then lets the result act on the world. It's the part of the stack you can actually
own, and it's the part Munder Difflin exists to give away.

So: what have we done to that middle term in the last six weeks?

## Michael learned the floor

Talk mode could *do* things since v0.3.2. What it couldn't do was *know* things. Every "what's
everyone working on?" turned into a round of tool calls and dead air.

Now the voice session opens with a live snapshot of the whole floor — every agent's status,
engine, context fill, circuit-breaker state, inbox depth, and in-flight tasks — and keeps
receiving silent updates as things change mid-call. Ask what's happening and he just answers.

He also graduated from narrator to operator. He can resume a paused agent, pause and resume
floor-wide delivery, gate specific tools, manage tasks and schedules, clear an agent's
context, archive workers, and change settings from a strict allowlist. Anything destructive
still waits for you to say a distinct confirm word out loud, and secrets can't be touched by
voice at all.

## The IDE became a git time-machine

v0.3.3 gave the built-in Monaco IDE a diff against HEAD. This wave made it somewhere you can
move through history:

- **History** — a clickable commit graph. Pick a commit, see the files it touched, open
  side-by-side diffs of exactly what changed.
- **Compare** — any two branches, with ahead/behind counts and per-file diffs.
- **Guarded checkout** — it refuses to move a dirty tree, or pull code out from under an
  agent that's actively working in it.

Agents write a *lot* of markdown, so that got fixed too: ⌘-click any `.md` path an agent
prints in its terminal and it opens rendered. In the IDE, markdown files get a
code | split | preview switch that re-renders live. There's no raw-HTML pipeline anywhere in
it, which is the only way reading agent-generated files is safe by construction.

{% img "note-1" %}

## Nine engines

**xAI Grok** and **Kimi Code** joined, bringing the roster to nine: Claude Code, OpenAI
Codex, Antigravity, GitHub Copilot CLI, Grok, Kimi, OpenCode, Crush, and pi.dev. Grok came in
as a full hive citizen — lifecycle-hook adapter, guarded inbox delivery, `--resume` — not
just a worker you can spawn.

Settings was rebuilt into six clear tabs at the same time. The default agent model, autonomy
mode, and the full circuit breaker finally have real controls instead of being buried or
missing.

## One gate for the queue

This is the least glamorous thing here and probably the one you'll feel most.

The message queue kept breaking because *four* different loops each decided, independently,
when it was safe to type into a terminal. Now a single drain loop owns that decision — and
automation never wipes your draft or closes your menus. A user draft or an open picker holds
delivery (visible as a **"your draft"** badge), and expired blocks type *after* your text
instead of over it. The whole contract is written down in
[`docs/message-queue.md`](https://github.com/chaitanyagiri/munder-difflin/blob/main/docs/message-queue.md).

v0.3.5 closed the last hole in it: pausing floor-wide delivery used to strand every queued
message with no override and no explanation. Each row now gets a **send now** link that
bypasses only the pause gate, and the composer says exactly why the queue is being held.

A big share of this — the terminal, queue, and roster reliability work — is community code
from [**Vyapak Goyal (@gts-47)**](https://github.com/gts-47), with major fixes from
[**@qschmick**](https://github.com/qschmick): killed processes now actually die (every kill
path escalates to a process-group kill), the circuit breaker stopped false-positive storming
on idle agents, and warm usage reads got about **350× faster**.

## A machine with nothing on it can run agents

v0.3.6 was one failure wearing five different costumes: the app assumed your machine already
had things on it. A shell to expand `~`. A `node` on PATH. An npm to install with. When it
didn't, agents died with a bare exit code and no explanation.

- **Node and npm install themselves.** Pick an engine on a machine with no Node and the app
  fetches the current LTS from nodejs.org, **verifies it against the official
  `SHASUMS256.txt` before anything runs**, installs it visibly in that agent's own terminal,
  then installs the CLI. Already have Node 20+? Left completely alone. And when no installer
  could possibly succeed, the banner names the missing piece and runs *nothing* — instead of
  firing `npm install -g` on a machine with no npm and letting you watch `command not found`
  scroll past.
- **Hooks stopped dying with exit 127.** Agent CLIs run hooks through `sh -c` with a bare
  `PATH=/usr/bin:/bin:/usr/sbin:/sbin` — nvm's node isn't on it — so hook payloads were being
  lost entirely: no live status, no Stop→inbox drain, no session IDs. This is also why the
  orchestrator kept going stale across restarts.
- **`~/dev/foo` works.** Only a shell expands `~`; Node treats it as a literal folder name,
  so every typed `~/…` path failed its existence check and the agent never spawned.
- **The office floor survives losing its GPU context.** Chromium evicts the oldest WebGL
  context past about sixteen. The floor is created at startup, so it was always first to go —
  and Pixi reported nothing at all, so it just went blank until you restarted. It notices and
  rebuilds itself now.

{% img "note-2" %}

## And then: auto-update had never once worked

Here's the confession.

We shipped auto-update in v0.3.4 and announced it. It has never run. Not once, in any
packaged build, through three releases.

`electron-updater` is a CommonJS module that exposes `autoUpdater` through a lazy getter.
Node's module lexer detects CommonJS named exports by static analysis, and it cannot see
through a getter defined at runtime — so `await import('electron-updater')` handed back a
namespace with no `autoUpdater` on it at all. We destructured it, got `undefined`, and the
very next line threw:

```
TypeError: Cannot set properties of undefined (setting 'autoDownload')
```

That exception landed in a `catch` that flipped the app to notify-only mode and moved on.
Which is why the only thing it could ever offer was a link to the releases page. It never
showed up in testing because the entire path sits behind `app.isPackaged` — it simply does
not execute in development.

The interop fix is one line. The real bug was the `catch` that threw the error away, and
that's what v0.3.7 actually changes:

- **Errors are never swallowed.** Every updater failure now reaches the UI *and* an
  `updater.log` on disk.
- **The fallback is per-check, not a latch.** One network blip used to cost the whole session
  its ability to self-update.
- **The version number in the toolbar is now the update button.** It shows `checking…`, then
  `ready to install`, then live download progress, then **restart to update**. Click it with
  nothing pending and it checks on demand — before, the app only ever checked 30 seconds
  after launch and then every six hours, with no way to ask.

There's a full write-up of the debugging, including the trick that finally made a packaged
Electron app talk, in [Why our auto-update never
ran](/blog/why-our-auto-update-never-ran/).

## If you're on v0.3.5 or v0.3.6

You'll need to install v0.3.7 by hand, once. Your current build carries the broken updater,
so it can't fetch the fix that repairs it — the one bootstrap problem a self-updating app
cannot solve for itself.

[**Download v0.3.7**](https://github.com/chaitanyagiri/munder-difflin/releases/latest) —
macOS (signed and notarized), Windows, Linux. Free, MIT-licensed, local-first, and after this
one manual step, it keeps itself current.

## What's next

More chat bridges, so a Telegram or Slack channel pipes straight into Michael's queue and his
replies route back out. More engines, and a wider per-hire capability catalog. More
integration templates. And pushing the remaining avatar station-visits to be driven entirely
by real hook events rather than inferred.

The model you rent gets better every few weeks without you doing anything. Your context is
already yours. The harness in between is the part worth owning — so it's free, it's MIT, and
it runs on your machine.

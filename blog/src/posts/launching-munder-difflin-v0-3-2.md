---
title: "Launching Munder Difflin v0.3.2: Talk to Michael, a Realtime Voice Orchestrator"
description: "Munder Difflin v0.3.2 adds Realtime Michael — a low-latency voice channel to the GOD orchestrator. Talk to Michael and he listens, answers, and acts: reading the hive and, behind spoken echo-back confirmation, dispatching, spawning, and steering the floor in real time."
date: 2026-06-27
category: story
categoryLabel: Story
type: Non-technical
primaryKeyword: "munder difflin v0.3.2"
secondaryKeywords: ["realtime voice ai orchestrator", "talk to ai agents by voice", "openai realtime api electron", "voice controlled multi-agent", "byok openai key voice agent", "voice action confirmation"]
tags: ["Story", "Release", "Multi-Agent", "Voice", "Realtime", "Open Source"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What's new in Munder Difflin v0.3.2?"
    a: "The headline is Realtime Michael — a low-latency voice channel to the GOD orchestrator that runs alongside the async terminal floor. Press Talk and Michael listens, answers, and acts in real time over the OpenAI Realtime API (WebRTC): he reads the hive (tasks, board, memory, agents, activity) and — behind spoken echo-back confirmation for anything destructive — creates and assigns work, dispatches agents, spawns and kills workers, and steers the floor, attributed to a distinct michael-voice actor. He greets you on connect, speaks task completions the moment they land ('respond when done'), and runs under a live cost meter with a hard spend cap and idle auto-disconnect. It's bring-your-own OpenAI key, decrypted main-only and minted into short-lived ephemeral session tokens. Plus Slack hardening, a dedicated auto-compact schedule, and per-agent environment metadata."
  - q: "How does talking to Michael actually work?"
    a: "Press the Talk button (on Michael's card, or in any fullscreen terminal). Main mints a short-lived ephemeral token from your OpenAI key and the renderer opens a WebRTC voice session against the OpenAI Realtime API, with echo/noise/gain processing, semantic-VAD turn-taking and barge-in, and a device picker for your mic and speaker. Michael's card shows a live Off → Connecting → Listening → Responding → Working state. He greets you on connect, and from there it's a normal back-and-forth — except he can also act on what you ask."
  - q: "Michael can spawn and kill agents by voice — is that safe?"
    a: "Yes — safety is built into the action path. Read tools (tasks, board, memory, agents, activity, cost) run freely. Every destructive verb — create/assign, dispatch, pause/steer/halt, spawn/hire, kill, edit schedules — is gated behind spoken echo-back confirmation: Michael repeats back what he's about to do and waits for a distinct confirm token, never a bare 'yes'. Killing the GOD agent or targeting all agents at once is refused outright. And every voice action is attributed to a distinct michael-voice actor that pings the GOD terminal, so nothing happens invisibly."
  - q: "Does Michael tell me when a task finishes?"
    a: "Yes — that's the 'respond when done' loop. When you dispatch work by voice, a completion watcher detects when the task finishes (the card flips to done, or a done reply lands in the inbox) and pushes the event straight into the live session so Michael speaks it unprompted, with an on-screen toast alongside. If you've closed the session, completions queue to a desktop notification and a 'completions since last session' warm-start the next time you connect. There's also a wait_for tool for the block-until-done case."
  - q: "What do I need to use Realtime Michael?"
    a: "Your own OpenAI API key with Realtime API access. It's the same OpenAI provider key you set under Settings → AI Engines (separate from your Anthropic key). The key is encrypted at rest, decrypted only in the main process, and minted into a short-lived ephemeral token per session — it never reaches the renderer and is never logged. Without an OpenAI key the Talk button stays visibly disabled with a 'needs OpenAI key' cue. The realtime loop is human-verified end-to-end, including the full spawn/kill/dispatch action path."
  - q: "Do I still get everything from v0.3.1 and earlier?"
    a: "Yes. v0.3.2 is additive. The three v0.3.1 engines (OpenCode, Crush, pi.dev) with BYOK keys + local LLMs, selectable agent engines, the integrations registry + secret broker, Slack-spawned ephemeral workers, the Agent Gallery, Free Flow voice dictation, the enterprise Knowledge Graph, multi-window floors, observability, the circuit breaker, durable persistence, the Command Center, task kanban, GitHub/CI integration, and the Schedules tab all remain functional and shipping."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p><strong>Munder Difflin v0.3.2</strong> lets you <strong>talk to Michael</strong>. <strong>Realtime Michael</strong> is a low-latency <strong>voice channel to the GOD orchestrator</strong> (OpenAI Realtime API over WebRTC) that runs next to the async terminal floor. Press <strong>Talk</strong> and Michael listens, answers, and <em>acts</em> — reading the hive and, behind spoken <strong>echo-back confirmation</strong> for anything destructive, creating and assigning work, dispatching, spawning and killing workers, and steering the floor as a distinct <strong>michael-voice</strong> actor. He <strong>greets you on connect</strong>, <strong>speaks completions</strong> the moment they land, and runs under a <strong>live cost meter + spend cap + idle auto-disconnect</strong>. <strong>Bring your own OpenAI key</strong> — decrypted main-only, minted into short-lived ephemeral tokens, never read back to the renderer. Free, open source, local-first.</p></div>

for a while now you could *watch* the floor. you could read the board, watch envelopes fly desk-to-desk, type into a terminal, and tell Michael — the GOD orchestrator who runs the office like a regional manager who's read one management book — what to do by typing it. but you couldn't *talk* to him. the office was a thing you operated; not a thing you had a conversation with.

**v0.3.2 changes that.** press **Talk**, and Michael is on the line.

## talk to Michael: the orchestrator, out loud

the headline is **Realtime Michael** — a **low-latency voice channel to the GOD orchestrator**, running alongside the async terminal you already have. under the hood it's the **OpenAI Realtime API over WebRTC**: a real-time audio session, not a record-then-transcribe round-trip.

there's a **Talk** toggle on Michael's card (and, new this release, in *any* fullscreen terminal — more on that below). hit it and a mic session opens with the boring-but-essential audio plumbing handled for you: echo cancellation, noise suppression, gain control, **semantic-VAD turn-taking with barge-in** (you can cut him off mid-sentence, like a real conversation), and a device picker for both your microphone and your speaker. Michael's card shows a live state the whole time — `Off → Connecting → Listening → Responding → Working` — so you always know whether he's hearing you, thinking, or doing.

and he doesn't make you go first. **he greets you on connect** — a warm, rotating opener ("hi, what's up?", "hey, how's it going?") instead of an awkward silent line. small thing; makes the whole feature feel alive.

### he doesn't just answer — he acts

this is the part that feels like the future the first time. Michael isn't a read-only voice assistant bolted onto the side. he's the **orchestrator** — so when you talk to him, he can *run the floor*.

he has the full toolbox:

- 👀 **read tools** — tasks, board, memory, agents, activity, cost. "what's Pam working on?" "what's blocked?" "read me the board." these run freely.
- 🛠️ **action tools** — create and assign tasks, dispatch agents, pause / steer / halt, spawn or hire a new worker, kill one, edit schedules. the things that actually *change* the office.

obviously, "spawn a worker" and "kill that agent" are not commands you want fired off a misheard word. so every **destructive** verb is gated behind **spoken echo-back confirmation**:

> Michael repeats back exactly what he's about to do, and waits for a **distinct confirm token** — never a bare "yes". and some things he just won't do: **killing the GOD agent**, or **targeting every agent at once**, are refused outright.

and crucially, nothing happens in the shadows. every voice-driven action is attributed to a distinct **michael-voice** actor — it shows up in messages, on the board, and in the activity log, and it pings the GOD terminal. a dispatch you made by voice is as auditable as one you typed. (if you care about *why* a trust boundary like this matters for agents that can act, we wrote about [the lethal trifecta for coding agents](/blog/the-lethal-trifecta-for-coding-agents/) separately.)

## "respond when done"

here's the bit that makes voice feel like delegation instead of micromanagement. you ask Michael to dispatch some work — and then you go do something else. you don't have to sit there asking "is it done yet?"

a main-process **completion watcher** notices when the dispatched task actually finishes — the card flips to *done*, or a done reply lands in the inbox — and **pushes that straight into the live session so Michael speaks it, unprompted**. "Pam finished the changelog." an on-screen **toast** shows it too, so it's there whether or not you caught the audio.

and if you've already closed the session? the completion isn't lost. it **queues to a desktop notification**, and the next time you connect, Michael **warm-starts with the completions since you last talked**. there's also a `wait_for` tool for when you explicitly want him to block until a specific task lands.

fire-and-forget by default; tell-me-the-second-it's-done without you asking. that's the loop.

## it stays on a budget

a live voice session is a meter running. so v0.3.2 keeps it honest:

- 💸 **a live cost HUD** sits right by the Talk toggle, so the session's spend is never a mystery.
- 🧱 **a hard spend cap** auto-disconnects the session when it's hit.
- ⏳ **a configurable idle auto-disconnect** (default 3 minutes; 30s–10min, or Off) means a mic you forgot to close doesn't quietly burn money in the background.

talk freely; it won't surprise you on the bill.

## bring your own OpenAI key — and it never leaves

Realtime Michael runs on **your own OpenAI key** (with Realtime API access). it's the same OpenAI provider key you set under **Settings → AI Engines** — separate from your Anthropic key — and v0.3.2 documents it there as its own clearly-labeled requirement, with a live **enabled/disabled** status. no key set? the **Talk** button stays visibly disabled with a **"needs OpenAI key"** cue, so you never click a silently-dead button and wonder why nothing happened.

and the key handling is the careful part:

> your OpenAI key is **encrypted at rest**, decrypted **only in the main process**, and minted into a **short-lived ephemeral session token** for each connection. the real key **never crosses into the renderer** and is **never logged**. the renderer only ever holds a throwaway token good for one session.

the renderer's content-security policy is opened *just* enough to let the WebRTC handshake reach `api.openai.com`, and nothing more. it's the same write-only-secrets posture the [integrations broker](/blog/launching-munder-difflin-v0-3-0/) uses, applied to voice. (local-first people: the audio goes to OpenAI's Realtime API because that's what's doing the speech — everything else stays on your machine. that's [why local-first still matters](/blog/why-local-first-matters-for-ai-agents/) for the rest of the floor.)

the whole loop is **human-verified end-to-end** — connect, mic, answer, *and* the full spawn / kill / dispatch action path, exercised live on a real key.

## the smaller things that add up

a release with a headline this big still has a tail of quality-of-life wins:

- 🔤 **"Voice" is now "Talk".** the feature is renamed throughout, with a redesigned nav — the GOD card pops with a dedicated **Talk** line, and the worker nav cards are compacted to make room.
- 🔎 **robust voice task-matching.** ask Michael to act on a task by name and he's now tolerant of hyphens, punctuation, phrasing, and truncation — candidates are scored, and close matches trigger a spoken **"which one?"** instead of silently mutating the wrong card.
- 🖥️ **Talk from any fullscreen.** the Talk toggle is no longer Michael-only chrome; it's reachable in any fullscreen terminal view.
- 🧠 **a conversational read-layer.** the voice read tools were reworked so `get_memory` actually answers instead of dead-ending, with new agent/board tools and an expanded persona so Michael talks through roster and floor state naturally.
- 🪟 **fullscreen agent-modal stacking fix.** the Add-Agent modal opened from the in-fullscreen "+ agent" button used to render *behind* the fullscreen view and sit there un-clickable. it now opens on top and interactive, and Esc closes the modal instead of dumping you out of fullscreen.
- 🔕 **Slack hardening.** app/voice proactive Slack posting is **off by default** now (behind a config flag + Settings toggle), and a send with no explicit channel+thread is **refused** rather than guessed.
- 🗜️ **a dedicated auto-compact schedule.** context auto-compaction is its own **persistent, configurable maintenance mission** now — decoupled from the standup mission it used to ride on, so editing standups can't silently drop it.
- 🏷️ **per-agent environment metadata** — each agent carries queryable env metadata with a working-directory validity guard.

## everything from 0.3.1 is still in the box

v0.3.2 is purely **additive**. the three engines from [v0.3.1](/blog/run-munder-difflin-on-open-models/) — **OpenCode, Crush, and pi.dev**, each usable as a worker *and* as Michael, with **BYOK keys + local LLMs** — are all still here, as is everything from [v0.3.0](/blog/launching-munder-difflin-v0-3-0/) and earlier:

- 🧩 **selectable agent engines** — Claude Code, Antigravity, Codex, OpenCode, Crush, pi.dev, or a local provider, per hire and for Michael himself
- 🔐 **the integrations registry + write-only secret broker**, and **Slack-spawned ephemeral workers**
- 🎙️ **Free Flow voice dictation** (hold Option to dictate into the composer — distinct from talking *to* Michael)
- 🕸️ **the enterprise Knowledge Graph**, 🪟 **multi-window floors**, ⏯️ **session resume**, plus observability, the circuit breaker, durable persistence, the Command Center, task kanban, GitHub/CI integration, and the Schedules tab

the floor you already run — now with a regional manager you can actually call.

## get v0.3.2

Munder Difflin is **free, open source, and local-first** on macOS, Windows, and Linux. no account, no cloud for the floor itself — your machine, your subscriptions, your office.

[**Download v0.3.2**](https://github.com/chaitanyagiri/munder-difflin/releases/latest), set your OpenAI key under **Settings → AI Engines**, hit **Talk**, and ask Michael what everyone's working on. then — if you're feeling brave — tell him to spawn someone, listen to him read the plan back, and say the magic word.

curious how the orchestrator decides any of this under the hood? read [how the GOD orchestrator works](/blog/how-the-god-orchestrator-works/). want the last launch? [v0.3.0's platform release is right here](/blog/launching-munder-difflin-v0-3-0/).

full release notes live in the [CHANGELOG](https://github.com/chaitanyagiri/munder-difflin/blob/main/CHANGELOG.md).

that's it. go pick up the phone. (Michael's been waiting for someone to call.)

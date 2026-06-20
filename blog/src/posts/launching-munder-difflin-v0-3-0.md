---
title: "Launching Munder Difflin v0.3.0: Selectable Engines, Integrations & Slack-Spawned Workers"
description: "Munder Difflin v0.3.0 makes every hire — and Michael himself — a pluggable engine, adds an integrations registry with a write-only secret broker, and lets the god orchestrator spawn an ephemeral worker straight from Slack."
date: 2026-06-21
category: story
categoryLabel: Story
type: Non-technical
primaryKeyword: "munder difflin v0.3.0"
secondaryKeywords: ["selectable agent engines", "per-hire mcp catalog", "integrations registry secret broker", "slack spawned ai worker", "agent gallery", "local-first ai agents"]
tags: ["Story", "Release", "Multi-Agent", "Claude Code", "MCP", "Open Source"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What's new in Munder Difflin v0.3.0?"
    a: "The floor stops being Claude-shaped. Three big things: selectable agent engines (every hire — and Michael, the god orchestrator — runs on a pluggable engine: Claude Code, Antigravity, Codex, or a local provider), each carrying its own consented skills + MCP catalog; an integrations registry with a loopback secret broker that keeps secrets write-only; and a god-triggered ephemeral Slack worker loop where Michael spawns an isolated worker straight from a Slack message, replies in-thread, and tears it down safely. Plus temporal date-range skills, a worker capability catalog, a visual Provider/Hive picker, the Agent Gallery (the rebranded Hiring Fair) with six off-the-shelf hires, feature-aware onboarding, and wake-reliability hardening."
  - q: "What does 'selectable agent engines' mean?"
    a: "Until now the runtime behind an agent was effectively fixed. In v0.3.0 the engine is pluggable per hire: you choose Claude Code, Antigravity, OpenAI Codex, or a local provider (a claw/qwen backend proxy) from a visual picker. Even Michael — the god orchestrator you talk to — is swappable, with an engine picker in onboarding and a change-engine flow. Each hire also carries a manifest of allowed skills + MCP servers, surfaced through a consent UI before anything can use them."
  - q: "How does the integrations registry keep my secrets safe?"
    a: "Secrets are write-only. You set a credential once through a registry-driven Settings form, and it's reached only through a loopback secret broker — it's never read back into the renderer. The connectivity-test path is confined so it can't be turned into a secret-exfiltration or SSRF primitive. v0.3.0 ships a first wave of declarative integration templates."
  - q: "Michael can spawn a worker from Slack — is that safe?"
    a: "Yes, and safety is the point. Michael spawns an isolated, ephemeral worker in response to a Slack request; the worker does the job, posts its reply back into the thread, and is then torn down. Teardown is gated so it never auto-discards a worker's unintegrated work, every worker runs under a token cap, and abandoned worktrees are garbage-collected. Live workers show up in a new Workers tab."
  - q: "Does v0.3.0 still include shareable hires and the gallery?"
    a: "Yes. Everything from v0.2.8 — shareable hires and the community gallery — is included. The Hiring Fair is rebranded the Agent Gallery and now ships six off-the-shelf hires, with a visual Provider/Hive picker in onboarding and add-agent. Import still only pre-fills the Add-Agent modal; the human always clicks spawn."
  - q: "Do I still get everything from v0.2.7 and earlier?"
    a: "Yes. v0.3.0 is additive. Free Flow voice dictation, the enterprise Knowledge Graph, multi-window floors, the rich composer, agent session resume, observability, the circuit breaker, durable persistence, the Command Center, task kanban, GitHub/CI integration, and the Schedules tab all remain functional and shipping."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p><strong>Munder Difflin v0.3.0</strong> makes the floor <strong>engine-agnostic</strong>. Every hire — and Michael himself — runs on a <strong>pluggable engine</strong> (Claude Code, Antigravity, Codex, or a local provider), each with its own consented <strong>skills + MCP catalog</strong>. A new <strong>integrations registry</strong> connects your tools behind a <strong>write-only secret broker</strong>. And Michael can now <strong>spawn an ephemeral worker straight from Slack</strong> — reply, then tear it down safely (worktree GC + token caps), all visible in a new <strong>Workers tab</strong>. Plus <strong>temporal date-range skills</strong>, a <strong>worker capability catalog</strong>, a visual <strong>Provider/Hive picker</strong>, and the <strong>Agent Gallery</strong> with six off-the-shelf hires. Free, open source, local-first.</p></div>

for a while now the floor has had a not-so-secret default. Michael — the GOD orchestrator who routes work like a slightly unhinged regional manager — and most of his coworkers were, deep down, *Claude-shaped*. you could bring Antigravity and Codex to the party (and they were first-class), but the orchestrator at the center of it all was wired to one CLI. the team was multi-provider; the brain wasn't.

**v0.3.0 fixes that.** this is the biggest platform release we've shipped — the version where the floor stops assuming what runs it.

## selectable engines: pick the brain behind every coworker

the headline is **selectable agent engines**. the runtime behind each agent is now *pluggable*:

- 🟣 **Claude Code**
- 🔵 **Antigravity** (Gemini, via `agy`)
- 🟢 **OpenAI Codex**
- 🖥️ a **local provider** — a claw/qwen backend proxy, for when you want a model running on your own machine

and crucially: **Michael is swappable too.** the god orchestrator is no longer hard-wired. there's an engine picker right in onboarding, and a change-engine flow so you can re-home the orchestrator onto a different engine without tearing down the whole office. don't love the brain running your floor? change it. it's a setting now, not a rebuild.

### every hire brings its own skills + MCP — with a consent step

an engine is *what* runs a hire. but a hire also needs to know *what it's allowed to touch*. so each hire now carries its own **manifest** of allowed **skills** and **MCP servers** — a default-deny allowlist over a shared catalog. some skills are **bundled** right into the app; others come from the catalog.

the part we care about most: a **consent UI**. before a hire can use a skill or an MCP server, you see exactly what it's asking for and approve it. a hire you imported from someone else doesn't get to quietly wire itself into a tool — its requests are *reviewed*, never auto-granted. (if you want the why-this-matters version, we wrote about [MCP and skills in a hive](/blog/mcp-and-skills-in-a-hive/) and the [tool-poisoning surface](/blog/mcp-security-tool-poisoning/) separately.)

## integrations: connect a service without leaking the key

the second big thing is an **integrations registry** plus a **loopback secret broker**.

before, "connect a service" meant hand-wiring something and hoping the credential stayed put. now there's a proper registry: a declarative spec drives a **Settings UI** that renders each integration's config form, and v0.3.0 ships a **first wave of templates** so common services are a few clicks instead of a research project.

the bit that matters is how secrets are handled:

> **secrets are write-only.** you set a credential once. it's reached only through a loopback broker. it is *never read back* into the renderer.

so the UI can let you configure an integration without the secret ever round-tripping through the part of the app that draws windows. and the connectivity-**test** path — the "is this hooked up right?" button — is **confined**, so it can't be bent into a secret-exfiltration or [SSRF](/blog/agent-security-and-sandboxing/) trick. write-only in, brokered access out.

## Slack → spawn → reply → safe teardown

the third headline is the one that feels like magic the first time: **Michael can spawn a worker straight from Slack.**

here's the loop. a request lands in Slack. Michael spins up an **isolated, ephemeral worker** to handle it. the worker does the job and **posts its reply back into the thread itself**. then — and this is the whole trick — it gets **torn down safely**.

"safely" is doing real work in that sentence:

- 🧷 **the teardown gate.** a worker is never auto-discarded if it has *unintegrated* work. nothing of value evaporates because a worker finished its turn.
- 🧮 **token caps.** every spawned worker runs under a cap, so an ephemeral worker can't quietly torch your bill.
- 🧹 **worktree GC.** each worker runs in its own isolated git worktree (the same [worktree isolation](/blog/claude-code-git-worktrees-vs-hive/) the floor already uses); abandoned ones are garbage-collected instead of piling up.
- 🪟 **the Workers tab.** a new tab in the UI shows the ephemeral workers that are live right now, so the loop is watchable instead of invisible.

if you want to wire this up, the [Slack setup guide](/blog/run-ai-agent-hive-from-slack-setup/) and [triggering agents from Slack](/blog/trigger-ai-agents-from-slack/) still apply — v0.3.0 just makes the worker on the other end *ephemeral and self-cleaning*.

## the smaller things that add up

a release this big has a long tail of quality-of-life wins:

- ⏱️ **temporal date-range skills** — `today`, `yesterday`, `thisWeek`, `lastWeek`, `thisMonth`, `thisQuarter`, `thisYear`, `lastMonth`, `last7Days`, `last30Days`, and an arbitrary-range resolver. ask for "last 30 days" and an agent gets concrete ISO dates instead of doing date math by hand.
- 📇 **a worker capability catalog** — each spawned worker can read *exactly* which skills and brokered integrations it has, and how to call them. no guessing about its own toolbox.
- 🎛️ **a Provider / Hive picker** — choosing the engine for a hire is now a visual step (with real provider logos) in onboarding and add-agent, not a free-text command.
- 🎪 **the Agent Gallery** — *The Hiring Fair* is rebranded the **Agent Gallery**, now with **six off-the-shelf hires** ready to browse, review, and spawn. (import still only pre-fills the Add-Agent modal — [the human always clicks spawn](/blog/hire-manifest-untrusted-input/).)
- 🧭 **feature-aware onboarding** — first-run setup adapts to what you actually have available, with an explicit permissions & reliability step.
- 🔧 **a visible engine-CLI installer** — if the engine binary for your chosen provider is missing, the installer runs *visibly* and self-heals instead of failing in silence.

## reliability: the floor survives a closed lid

if you run agents overnight, two fixes are for you:

- 💤 **auto-revive wedged terminals on wake.** a terminal that wedged while your machine slept is now detected and revived when the machine wakes — instead of sitting dead until you notice and restart it.
- ⏰ **catch up missed schedules on wake.** a scheduled mission whose fire time elapsed while the laptop was asleep is now *caught up* on wake, not silently skipped. (we wrote a verifier for this so it stays fixed.)

close the lid with confidence. the floor picks itself back up.

## everything from 0.2.8 is still in the box

v0.3.0 is purely **additive**. nothing got removed. you still get **[shareable hires](/blog/launching-munder-difflin-v0-2-8/)** (now spawning from the Agent Gallery), and everything from v0.2.7 and earlier:

- 🎙️ **voice dictation** — hold Option to talk to your floor
- 🕸️ **the enterprise Knowledge Graph** — answers from your own documents and policies
- 🪟 **multi-window floors** — spread the office across monitors
- ✍️ **the rich composer**, ⏯️ **session resume**, plus observability, the circuit breaker, durable persistence, the Command Center, task kanban, GitHub/CI integration, and the Schedules tab

the floor you already love — now engine-agnostic, with a front door for your tools and a self-cleaning worker on the other end of Slack.

## get v0.3.0

Munder Difflin is **free, open source, and local-first** on macOS, Windows, and Linux. no account, no cloud — your machine, your subscriptions, your floor.

[**Download v0.3.0**](https://github.com/chaitanyagiri/munder-difflin/releases/latest), then pick an engine for your first hire, browse the [**Agent Gallery**](https://munderdiffl.in/hires), and — if you're feeling brave — point a Slack channel at Michael and watch him spawn a worker, answer, and tidy up after himself.

curious how the orchestrator decides any of this? read [how the god orchestrator works](/blog/how-the-god-orchestrator-works/). want the local-first philosophy? that's [why local-first matters](/blog/why-local-first-matters-for-ai-agents/). missed the last launch? [v0.2.8 shareable hires is right here](/blog/launching-munder-difflin-v0-2-8/).

full release notes live in the [CHANGELOG](https://github.com/chaitanyagiri/munder-difflin/blob/main/CHANGELOG.md).

that's it. go pick a brain, plug in a tool, and let Michael run the floor. (he'd like you to know the engine is now *his* choice too.)

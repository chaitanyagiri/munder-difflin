---
title: "How to Hire From the Agent Gallery"
description: "A practical guide to Munder Difflin's Agent Gallery: browse six off-the-shelf hires, import one from a link or file, review the pre-filled manifest, customize identity, workspace, engine, and briefing — then spawn it yourself."
date: 2026-07-03
category: guides
categoryLabel: Guides
type: Non-technical
primaryKeyword: "agent gallery"
secondaryKeywords: ["hire an ai agent", "off-the-shelf agent roles", "import agent manifest", "munder difflin hires", "ready-made ai coworkers"]
tags: ["Guides", "Multi-Agent", "Agent Design", "Getting Started", "Security"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What is the Agent Gallery?"
    a: "It's a free gallery of ready-made agent roles for Munder Difflin at munderdiffl.in/hires — no login, no trackers. Each role, called a hire, is a small JSON manifest that packages a configured agent: name, avatar, provider, model, flags, a goal, capability tags, and a token budget. It ships with six off-the-shelf hires you can import in one click and adapt to your project."
  - q: "Does importing a hire from the gallery start an agent automatically?"
    a: "No. Import only pre-fills the Add-Agent modal behind an explicit imported banner. You review every field, change anything you like, and the agent spawns only when you click spawn. There is no code path that runs an agent on import — the human is always the spawn gate."
  - q: "Is it safe to import a hire manifest someone sent me?"
    a: "The import pipeline is built on the assumption that it isn't — every manifest is validated as untrusted input. There is no executable field, so a manifest can never name a program to run; command flags pass a default-deny allowlist; and deep-link fetches are https-only and bounded. Even after all that, you still review the pre-filled form before anything spawns. Treat the goal text with the same skepticism you'd give any file from the internet."
  - q: "Can I change the engine or model a gallery hire uses?"
    a: "Yes. The manifest is a starting point, not a lock. In the Add-Agent modal you can switch the hire onto any engine you have — Claude Code, Antigravity, Codex, OpenCode, Crush, pi.dev, or GitHub Copilot CLI — pick a different model, and on local-capable engines use the OSS-model quick-picks to run it on open models via Ollama or a BYOK provider."
  - q: "What should I customize before spawning a hire?"
    a: "Four things. Identity: the name and avatar you'll recognize on the floor. Workspace: the working directory it operates in, ideally with the git-isolation toggle on so it gets its own worktree. Engine: the CLI and model that match the job's difficulty and your budget. Briefing: rewrite the goal so it names your repo, your conventions, and what done means — a generic goal produces generic work."
  - q: "How much does hiring from the gallery cost?"
    a: "The gallery and the app are free and open source (MIT-licensed code). You pay only for the model usage of whatever CLI or key the agent runs on. Every hire carries a token budget field, and the harness pairs per-agent budgets with live fleet monitoring and a circuit breaker, so an imported role can't quietly outspend the ceiling you gave it."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>The <strong>Agent Gallery</strong> (<a href="https://munderdiffl.in/hires/">munderdiffl.in/hires</a>) is where you hire ready-made AI coworkers for Munder Difflin — it ships with <strong>six off-the-shelf hires</strong>. A hire is a small JSON manifest: provider, model, flags, goal, capabilities, token budget. Importing one — by <code>munderdifflin://hire</code> link or a local file — <strong>never runs anything</strong>: it only pre-fills the Add-Agent modal behind an "imported" banner, and the manifest is <strong>validated as untrusted input</strong> along the way. You review, customize the <strong>identity, workspace, engine, and briefing</strong>, and <em>you</em> click spawn. Five minutes from browsing to a working agent on your floor.</p></div>

The slowest part of running a multi-agent office isn't running the agents. It's the blank Add-Agent form: which engine, which model, which flags, and — the one that actually stalls people — what is this thing's *job*? The Agent Gallery exists so you never start from that blank box. You start from a role somebody already got right, and you edit.

This is the practical walkthrough: browse, import, review, customize, spawn. (If you haven't installed the app yet, do [that first](/blog/how-to-install-and-use-munder-difflin/) — the gallery assumes you have a floor to hire onto.)

## Step 1: Browse the gallery

The gallery lives at [munderdiffl.in/hires](https://munderdiffl.in/hires/) — a static page, no login, no trackers. It's stocked with **six off-the-shelf hires**, each a complete role: a PR reviewer, a docs writer, a QA enforcer, a security auditor, a token-spend auditor, and a migrations grinder, each fronted by a pixel avatar from the app's affectionate Office parody cast.

Every card tells you what you're getting before you click anything: the role's goal, its capability tags, and which provider it's written for. Don't overthink the choice — you're picking a starting point, not signing a contract. Everything on the card is editable after import.

{% img "note-1" %}

## Step 2: Import the hire

Two ways in, both landing in the same place:

- **Deep link.** Click the hire button on a card and the `munderdifflin://hire` link opens the app directly.
- **Local file.** Save the manifest JSON (or receive one from a teammate) and import it from disk.

Either way, one thing is worth being precise about: **import never spawns anything.** What opens is the app's ordinary Add-Agent modal, pre-filled with the manifest's values and marked with an explicit **"imported" banner** so you know these fields came from outside. The agent starts only when you click spawn. A hire you got from the internet is inert data until a human acts on it.

That's not an accident of UI — it's a security posture. A manifest arrives by clicked link or downloaded file, which makes it attacker-controlled bytes, and the import pipeline treats it that way: there's **no executable field** (the binary always comes from your own locally configured provider presets), command flags pass a **default-deny allowlist**, and the deep-link fetch is **https-only and bounded**. The full threat model is its own post: [treating a hire manifest as untrusted input](/blog/hire-manifest-untrusted-input/).

## Step 3: Actually read the manifest

The imported banner is your cue to slow down for thirty seconds. A hire manifest encodes the whole role — name, avatar, provider, model, command flags, goal, capability tags, and a token budget — and every one of those is now sitting in front of you as a form field. Read them like you'd read a job description before forwarding it to HR:

- **Goal text** is the prompt this agent will work from. It's free text from someone else, which makes it the one field validation can't vouch for. If anything in it looks off, rewrite it.
- **Model and flags** tell you what it costs to run and how it behaves. The allowlist keeps flags safe; it doesn't make them right for you.
- **Token budget** is the spend ceiling the author suggested. Set it to what *you* are comfortable with — the harness enforces per-agent budgets with live fleet monitoring and a circuit breaker behind it.

{% img "note-2" %}

## Step 4: Customize the four things that matter

A gallery hire is deliberately generic. Four edits turn it into *your* hire:

**Identity.** Rename it and pick the avatar you want to see walking the floor. This sounds cosmetic; it isn't. When six agents are working at once, you triage by face and name.

**Workspace.** Point the hire at the repo it should work in, and flip on the **git isolation** toggle so it auto-provisions its own worktree on spawn — agents that share a checkout collide on branches; agents with worktrees don't ([why worktrees, in depth](/blog/claude-code-git-worktrees-vs-hive/)).

**Engine.** The manifest names a provider, but the modal's picker is yours: run the role on Claude Code, Antigravity, Codex, OpenCode, Crush, pi.dev, or GitHub Copilot CLI. Match the engine to the job — and if the role is routine enough, the local-capable engines surface **OSS-model quick-picks** so it can run on open models for pennies.

**Briefing.** Rewrite the goal until it names your project, your conventions, and what "done" looks like. This is the highest-leverage sixty seconds of the whole flow: a hire that arrives with "review pull requests" leaves with "review PRs on repo X, enforce the lint config, never approve without a green typecheck."

One more gate you'll meet after spawning: hires carry a manifest of allowed **skills and MCP servers**, default-deny over a shared catalog. Anything the hire wants to use surfaces in a consent UI for you to grant — imported input is reviewed, never auto-granted.

## Step 5: Spawn, and put it to work

Click spawn. The agent appears at a desk, joins the hive with its own mailbox and long-term memory, and is immediately routable: assign it kanban tasks, or just tell the GOD orchestrator what you need and let [Michael route the work](/blog/how-the-god-orchestrator-works/).

From browsing a card to a working coworker is genuinely a five-minute path — and every minute of it kept you in the loop: you read the manifest, you set the budget, you clicked spawn.

Grab the latest build from the [releases page](https://github.com/chaitanyagiri/munder-difflin/releases/latest), and if the gallery saves you a blank-form afternoon, a [GitHub star](https://github.com/chaitanyagiri/munder-difflin) is appreciated.

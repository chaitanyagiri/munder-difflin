---
title: "What Is an Agent Development Environment (ADE)?"
description: "ADE means two things in 2026: a platform for building agents (Letta's sense) and a workspace for shipping code with fleets of coding agents (Orca's sense). Here's the full tooling map — chat IDEs, agent CLIs, agent IDEs, and agent harnesses — and how to pick."
date: 2026-07-03
category: concepts
categoryLabel: Concepts
type: Non-technical
primaryKeyword: "agent development environment"
secondaryKeywords: ["what is an ADE", "agentic development environment", "agent IDE vs agent CLI", "multi-agent coding tools 2026", "agent harness vs ADE", "parallel coding agents"]
tags: ["Concepts", "ADE", "Multi-Agent", "Tooling Landscape", "CLI Agents"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What is an Agent Development Environment (ADE)?"
    a: "The term has two meanings in 2026. In Letta's original sense, an ADE is a platform for building and debugging AI agents themselves — inspecting context windows, memory, and reasoning. In the coding-tools sense that Orca popularized, an ADE is a desktop workspace for running multiple coding agents in parallel, each in its own isolated git worktree, with the tooling to review and ship what they produce. Most people saying ADE today mean the second sense."
  - q: "How is an ADE different from an AI IDE like Cursor?"
    a: "An AI IDE is editor-first: you write and steer, and agents assist inside your editing session — Cursor's Agent mode, Composer, and background agents all orbit the file you have open. An ADE is agent-first: the primary objects on screen are agents and their tasks, not files, and you delegate whole goals rather than steering each step. The rough inflection point is when work spans many files or needs several agents running in parallel."
  - q: "Is Munder Difflin an ADE?"
    a: "It's adjacent but a different category: a multi-agent harness, or an agent office. Like an ADE it runs many real CLI agents in parallel worktrees. Unlike most ADEs it adds an orchestrator agent (Michael) that routes work between agents, shared long-term memory, mailboxes so agents message each other, triggers (Slack, webhooks, schedules, voice), and guardrails like budgets, approval gates, and a circuit breaker. An ADE optimizes for you driving N agents; a harness optimizes for the agents coordinating each other while you supervise."
  - q: "Why did Munder Difflin add an IDE if it's not an ADE?"
    a: "Because whatever runs your agents, you still need to read what they wrote. v0.3.3 added a built-in Monaco editor (the VS Code editor engine, self-hosted) over the office floor: a file tree, editor tabs with save, and a side-by-side git diff of every agent change against HEAD. It's a review surface inside the harness, not a pivot to being an editor — the floor, orchestrator, and hive remain the product."
  - q: "Do agent CLIs like Claude Code and Codex compete with ADEs?"
    a: "No — they're the layer underneath. Claude Code and OpenAI Codex CLI are single-agent terminal programs, and they're what ADEs and harnesses actually run. Orca runs your existing CLI agents in parallel worktrees; Munder Difflin spawns them as real node-pty processes and coordinates them. Your CLI subscription is the engine; the ADE or harness is the chassis around it."
  - q: "How do I choose between a chat IDE, an agent CLI, an ADE, and a harness?"
    a: "Match the tool to how much you delegate. Staying in the loop on one change: an AI IDE. Delegating one task end-to-end: an agent CLI. Personally driving several agents in parallel on one repo: an ADE. Running an always-on team that routes work among itself, shares memory, and answers triggers while you supervise: a multi-agent harness like Munder Difflin."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p><strong>"ADE" means two different things in 2026.</strong> Letta coined <em>Agent Development Environment</em> for a platform to <strong>build and debug agents themselves</strong>. The coding world then adopted it for something else: a workspace for <strong>shipping software with fleets of coding agents</strong> — Orca is the flagship example. The map now has four layers: <strong>AI IDEs</strong> (Cursor — editor-first, you steer), <strong>agent CLIs</strong> (Claude Code, Codex — one agent, one terminal, full delegation), <strong>agent IDEs / ADEs</strong> (Orca, JetBrains Air — you drive N parallel agents), and <strong>agent harnesses</strong> (Munder Difflin — the agents coordinate <em>each other</em> under an orchestrator, with shared memory, triggers, and guardrails). The categories are blurring from every direction — v0.3.3 even put a Monaco IDE <em>inside</em> the harness — but the question that picks your tool hasn't changed: <strong>how much are you delegating?</strong></p></div>

Every few months the agent-tooling world mints a new acronym, and 2026's is **ADE**. It's a genuinely useful term — once you notice it's being used for two different things.

## Two meanings, one acronym

The original coinage belongs to [Letta](https://www.letta.com/blog/introducing-the-agent-development-environment), which uses *Agent Development Environment* for a visual platform to **build and debug agents themselves**: inspect an agent's context window, edit its memory blocks, watch its reasoning, wire its tools. In that sense, an ADE is to agents what an IDE is to code — the artifact under development *is the agent*.

Then the coding-tools world borrowed the acronym for something adjacent but distinct. [Orca](https://github.com/stablyai/orca) calls itself "the ADE for working with a fleet of parallel agents," and [Augment Code's guides](https://www.augmentcode.com/guides/what-is-an-agentic-development-environment) describe an *agentic development environment* as an agent-first workspace where developers delegate whole goals instead of steering an editor. In this sense the artifact under development is still **your software** — the ADE is where a fleet of coding agents builds it.

Most people saying "ADE" in a dev-tools context mean the second sense. That's the sense this post maps.

{% img "note-1" %}

## The 2026 landscape: four layers of delegation

The clean way to sort the tools is not by feature list but by **how much you hand over**.

**1. AI IDEs — you steer every step.** [Cursor](https://cursor.com/) is the archetype: an editor-first workspace where agents live inside your editing session. Its Agent mode reads the codebase, edits files, runs commands, and iterates; Composer produces reviewable multi-file diffs; background and cloud agents run tasks off to the side. It's excellent at what it optimizes for — a developer who stays in the loop, file by file, with agents as force multipliers. The center of gravity is still *you, in an editor*.

**2. Agent CLIs — you delegate one task.** [Claude Code](https://claude.com/claude-code) and [OpenAI Codex CLI](https://github.com/openai/codex) are single-agent terminal programs: give one a goal and it reads files, runs builds and tests, uses git, and verifies its own work by executing it. This is the layer with real terminal-level power — we wrote about [why CLI agents are so capable](/blog/why-cli-agents-are-powerful/) — but each session is one agent, one terminal, one task.

**3. Agent IDEs / ADEs — you drive N agents in parallel.** Once you're running four CLI sessions at once, tab-juggling breaks down, and this is the gap ADEs fill. Orca runs your existing CLI agents — Claude Code, Codex, and others, on your own subscriptions — in parallel, each task in an **isolated git worktree** with its own terminal and context, plus review tooling to merge the results. JetBrains is in the same lane with Air, a standalone multi-agent workspace. The defining trait: *you* are still the dispatcher. You assign every task, watch every lane, and merge every result.

**4. Agent harnesses / offices — the agents coordinate each other.** This is where **Munder Difflin** sits, and it's a different bet. Like an ADE, it runs real CLI agents (seven engines as of v0.3.3, including GitHub Copilot CLI) in isolated worktrees and real pseudo-terminals. Unlike an ADE, you don't dispatch to each agent yourself: a GOD orchestrator — Michael — routes work, agents message each other through mailboxes, share [long-term semantic memory](/blog/semantic-memory-for-ai-agents/), and get woken by triggers — typing, Slack, webhooks, schedules, even voice. Guardrails (approval gates, per-agent budgets, a circuit breaker, OTel observability) make it safe to leave running. The mental model isn't "my editor got agents" or "my agents got lanes" — it's *an office you supervise*. We've written a fuller definition in [what is a multi-agent harness](/blog/what-is-a-multi-agent-harness/).

{% img "note-2" %}

## Where the categories blur

Nobody stays in their lane, and the direction of travel is telling.

Cursor grew a CLI and cloud agents — the editor reaching toward delegation. ADEs like Orca embed browsers and diff tooling — the dispatcher growing verification surfaces. And Munder Difflin's v0.3.3 added a **built-in Monaco IDE** — the VS Code editor engine, self-hosted, one click over the office floor, with a file tree, tabs, and side-by-side git diffs of every agent change against HEAD. A harness growing an editor, precisely because the bottleneck in agent-heavy work shifts from *writing* code to *reviewing* it.

Everyone is converging on the same shape: **many agents, isolated workspaces, and a first-class place to review what they did.** The categories differ in what they treat as the primary object — the file (IDE), the task (CLI), the lane (ADE), or the *team* (harness).

## How to choose

Match the tool to your delegation level, not the hype cycle:

- Reviewing every edit as it happens → an **AI IDE**.
- Handing off one well-scoped task → an **agent CLI**.
- Personally running several parallel agents on one repo → an **ADE**.
- Running an always-on team that routes its own work while you supervise → a **harness**.

These stack rather than compete — Orca and Munder Difflin both *run* Claude Code and Codex; your CLI subscription is the engine either way. For a decision framework with sharper questions (team size, autonomy appetite, budget controls), see [how to choose a multi-agent tool](/blog/how-to-choose-a-multi-agent-tool/).

And if the office model sounds like your level of delegation: Munder Difflin is free, MIT-licensed, and local-first — [grab the latest release](https://github.com/chaitanyagiri/munder-difflin/releases/latest), and if it earns it, a [GitHub star](https://github.com/chaitanyagiri/munder-difflin) helps more people find it.

Sources: [Letta — Introducing the Agent Development Environment](https://www.letta.com/blog/introducing-the-agent-development-environment);
[Orca (stablyai/orca)](https://github.com/stablyai/orca); [Orca — onorca.dev](https://www.onorca.dev/);
[Augment Code — What is an agentic development environment?](https://www.augmentcode.com/guides/what-is-an-agentic-development-environment);
[Cursor](https://cursor.com/); [OpenAI Codex CLI](https://github.com/openai/codex).

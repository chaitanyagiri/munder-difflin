---
title: "Munder Difflin FAQ: Everything People Ask"
description: "Answers to the top Munder Difflin questions — what it is, is it free, does it run locally, which platforms, and how it differs from many terminals."
date: 2026-06-02
category: concepts
categoryLabel: Concepts
type: Non-technical
primaryKeyword: "munder difflin app"
secondaryKeywords: ["munder difflin download", "munder difflin claude code", "is munder difflin free"]
tags: ["Concepts", "FAQ", "Claude Code", "Multi-Agent"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What is Munder Difflin?"
    a: "Munder Difflin is a local, open-source desktop app that turns the Claude Code terminals you already run into a self-coordinating hive of agents — with shared long-term memory, inter-agent messaging, and a GOD orchestrator you talk to."
  - q: "Is Munder Difflin free?"
    a: "Yes. Munder Difflin is free and open source under the MIT license. You can download a build or run it from source — there's no paid tier to unlock the core."
  - q: "Does it run my data or code in the cloud?"
    a: "No. Munder Difflin is local-first — the harness, agents, and memory all live on your own machine. Your Claude Code sessions talk to Anthropic the same way they already do; Munder Difflin itself doesn't ship your code anywhere."
  - q: "What platforms does Munder Difflin support?"
    a: "macOS, Windows, and Linux. You can download a build or build it from source in a couple of commands."
  - q: "How is this different from running several Claude Code terminals myself?"
    a: "Munder Difflin adds the coordination that loose terminals lack: shared long-term memory (MemPalace), inter-agent messaging, a GOD orchestrator that routes work, and a visual office floor — so the sessions act as one team instead of isolated windows that collide and forget, plus a task kanban board, scheduled recurring missions, real spend telemetry, GitHub issue ingestion, CI status watching, and desktop notifications — a full coordination layer rather than just a pretty face."
  - q: "Do I need to know how to code to use it?"
    a: "You should be comfortable with Claude Code and a terminal, since Munder Difflin coordinates Claude Code agents. But you steer the team in plain language by talking to the GOD orchestrator — you don't script the coordination yourself."
  - q: "What is MemPalace?"
    a: "MemPalace is Munder Difflin's shared memory layer — a semantic store the whole hive reads and writes, mined automatically from each agent's plain-markdown notes, so agents recall relevant knowledge across sessions."
  - q: "What is the GOD orchestrator?"
    a: "The GOD orchestrator is a coordinating agent you talk to in plain language. It decomposes your intent, routes work to the right agents, adjudicates routine decisions, and escalates only the genuinely critical ones to you."
  - q: "Can the agents talk to each other?"
    a: "Yes. Each agent has a mailbox and a router delivers messages between them, so one agent can hand work or findings to another directly — without you relaying it."
  - q: "Does Munder Difflin work with my existing Claude Code setup, MCP servers, and skills?"
    a: "Yes. It coordinates the Claude Code you already run, including your tools, MCP servers, and skills — it adds a coordination layer rather than replacing your setup."
  - q: "Is Munder Difflin affiliated with Dunder Mifflin or The Office?"
    a: "No. The name is an affectionate parody — 'the world's best agents, the world's worst paper company.' It's an independent open-source project, not affiliated with NBC or The Office."
  - q: "Where do I download Munder Difflin?"
    a: "From the install section on munderdiffl.in, which links to the latest release. It's free, open source, and available for macOS, Windows, and Linux."
  - q: "Does Munder Difflin show how much each agent is costing me?"
    a: "Yes, as of v0.1.6. The Activity tab in Michael's Command Center reads your local Claude Code transcript files and surfaces real token counts (input, output, cache) and estimated USD cost per agent. No external service — it reads the same files Claude Code already writes to your machine."
  - q: "Can agents work in parallel on the same repo without colliding?"
    a: "Yes. The Git isolation toggle in Add Agent auto-provisions a dedicated git worktree for each agent on spawn and tears it down on kill. Agents on the same repo work on separate branches, so there are no branch-switch collisions."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p><strong>Munder Difflin</strong> is a free,
open-source (MIT), local-first desktop app that turns the Claude Code terminals you already run into a
coordinated hive — shared memory, messaging, and a <a href="/#how">GOD orchestrator</a> you talk to — on macOS,
Windows, and Linux. The full answers to the questions people ask most are below.</p></div>

This page answers the questions we hear most about Munder Difflin, kept short and direct. If your
question isn't here, the [GitHub repo](https://github.com/chaitanyagiri/munder-difflin) and the rest
of [the blog](/blog/) go deeper.

## The one-sentence version

Munder Difflin is a [multi-agent harness](/blog/what-is-a-multi-agent-harness/) for Claude Code: it
takes the agents you already run and makes them act like one team — they message each other, share
long-term memory, and are routed by a coordinator you talk to in plain language, all visualized as a
live office floor on your own machine.

{% img "note-1" %}

## Still deciding?

If you're comparing options, these go deeper than an FAQ can:

- [The best tools to run multiple Claude Code agents](/blog/best-claude-code-multi-agent-tools/) — the
  honest field roundup.
- [Why we built Munder Difflin](/blog/why-we-built-munder-difflin/) — the origin story and the problem
  it solves.
- [What are Claude Code agents?](/blog/what-are-claude-code-agents/) — the basics, if you're new.

---

The fastest way to answer "is this for me?" is to run it. [Download Munder Difflin](/#install) — it's
free, open source, and local-first.

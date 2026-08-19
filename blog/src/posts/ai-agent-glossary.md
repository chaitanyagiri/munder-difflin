---
title: "The AI Coding Agent Glossary: Harness, Orchestrator, Hive, Subagent"
description: "Plain-English definitions of the AI coding agent terms everyone trips over — harness, orchestrator, hive, subagent, agent memory — each in one line."
date: 2026-06-02
category: concepts
categoryLabel: Concepts
type: Non-technical
primaryKeyword: "multi-agent ai framework"
secondaryKeywords: ["ai agent glossary", "orchestrator vs harness", "agentic terms"]
tags: ["Concepts", "Multi-Agent", "Glossary", "Getting Started"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What's the difference between an agent harness and an agent framework?"
    a: "A framework (LangGraph, CrewAI) is a library you build an agent application with from scratch. A harness wraps agents you already run — like Claude Code sessions — and adds coordination on top, without rebuilding the agent."
  - q: "What's the difference between an orchestrator and a harness?"
    a: "A harness is the whole coordination layer — memory, messaging, visibility, and routing. An orchestrator is one part of it: the coordinator that decomposes intent and routes work to the right agents."
  - q: "What is a hive of agents?"
    a: "A hive is a coordinated group of agents that share memory and message each other, behaving as one team rather than isolated sessions. It's the running 'team' a harness manages."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>The agent world is thick with jargon —
<strong>harness</strong>, <strong>orchestrator</strong>, <strong>hive</strong>,
<strong>subagent</strong>, <strong>agent memory</strong>. Here's each term in one quotable line, so
you can read (and write) about <a href="/blog/what-is-a-multi-agent-harness/">multi-agent AI</a> without
tripping. Bookmark it.</p></div>

Every fast-moving field grows its own vocabulary, and AI coding agents have grown a lot of it fast.
This is a snackable reference: each term defined in a sentence you could quote, with a link out when
there's more to say.

## Core building blocks

### Agent
**An agent is a running AI session with a goal and tools — it reads, acts, and repeats in a loop until
the task is done.** In practice, each [Claude Code session](/blog/what-are-claude-code-agents/) is an
agent.

### Subagent
**A subagent is a short-lived helper an agent spawns inside its own run to fan out a piece of work.**
Great for parallelism within one task; it doesn't persist or share memory across your whole workflow.

### Tool
**A tool is a capability an agent can call — read a file, run a command, search the web.** Tools are
what let an agent *do* things instead of just talk.

{% img "note-1" %}

## The coordination layer

### Harness
**A harness is the software that wraps the agents you already run and coordinates them — roles,
messaging, memory, orchestration, and visibility.** It's the layer that turns several sessions into a
team. More: [what is a multi-agent harness](/blog/what-is-a-multi-agent-harness/).

### Framework
**A framework is a library you build an agent application *with*, from scratch (LangGraph, CrewAI,
AutoGen).** A harness wraps agents you have; a framework is how you'd build one.

### Orchestrator
**An orchestrator is the coordinator that decomposes your intent and routes work to the right
agents,** escalating only the critical decisions. In Munder Difflin it's the [GOD agent](/#how) you
talk to in plain language.

### Hive
**A hive is a coordinated group of agents that share memory and message each other, acting as one
team.** It's the running "office" a harness manages.

## Memory & messaging

### Agent (long-term) memory
**Long-term memory is durable storage an agent reads on startup and writes to as it learns, so
knowledge survives between sessions.** Without it, agents start cold every run — see [how to give
Claude Code long-term memory](/blog/give-claude-code-long-term-memory/).

### Semantic memory
**Semantic memory lets an agent recall notes by *meaning* rather than filename — embed the notes,
fetch the few most relevant.** It's what keeps recall instant as the knowledge base grows.

### Mailbox / inter-agent messaging
**A mailbox lets one agent hand a message or result to another directly, instead of routing through
you.** It's how a hive coordinates without a human courier.

{% img "note-2" %}

## Workflow patterns

### Git worktree
**A git worktree is a separate working copy of one repo, so parallel agents edit isolated checkouts
and don't clobber each other.** A common foundation for [running agents in
parallel](/blog/how-to-run-multiple-claude-code-agents/).

### Human-in-the-loop
**Human-in-the-loop means the system pauses for your approval on the decisions that matter — spend,
destructive actions, scope — and runs autonomously otherwise.**

### Local-first
**Local-first means the harness, agents, and memory run on your own machine,** for privacy,
predictable cost, and offline capability — [why that matters](/blog/why-local-first-matters-for-ai-agents/).

## Putting it together

In one sentence using all of it: *a **harness** runs a **hive** of **agents** (each its own loop with
**tools**), gives them shared **semantic memory** and **mailboxes**, and lets an **orchestrator** route
work — **local-first**, with a **human in the loop** for the critical calls.*

If any term sparked a "wait, which tool does that?", the [roundup of multi-agent Claude Code
tools](/blog/best-claude-code-multi-agent-tools/) maps the vocabulary onto real software.

---

Munder Difflin is a harness, a hive, an orchestrator, and shared memory in one local app. [Download
Munder Difflin](/#install) to see the glossary come to life — free and open source.

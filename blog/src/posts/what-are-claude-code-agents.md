---
title: "What Are Claude Code Agents? And How to Use Many at Once"
description: "Claude Code agents explained in plain English — what an agent actually is, how subagents differ, and the leap from one agent to a coordinated team."
date: 2026-06-02
category: concepts
categoryLabel: Concepts
type: Non-technical
primaryKeyword: "claude code agents"
secondaryKeywords: ["claude code agents", "claude code subagents", "ai coding agents"]
tags: ["Concepts", "Multi-Agent", "Claude Code", "Getting Started"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What are Claude Code agents?"
    a: "A Claude Code agent is a running Claude session with a goal and a set of tools — it can read and edit files, run commands, and work toward a task in a loop. Each terminal you start a Claude session in is an agent."
  - q: "What's the difference between an agent and a subagent in Claude Code?"
    a: "An agent is a top-level session you drive. A subagent is a helper the main agent spawns inside its own run to fan out a piece of work — short-lived and scoped to that parent. Subagents are great for parallel sub-tasks but don't persist or share memory across your whole workflow."
  - q: "How do I use multiple Claude Code agents at once?"
    a: "Open several sessions, give each a clear role, and coordinate them — ideally with shared memory and messaging so they don't collide or forget. A multi-agent harness like Munder Difflin automates that coordination so the sessions act as one team."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>A <strong>Claude Code agent</strong> is a
running Claude session with a goal and tools — it reads files, edits code, and runs commands in a
loop. <strong>Subagents</strong> are short-lived helpers an agent spawns for fan-out. The real leap
isn't more agents; it's getting several to act as a <strong>coordinated team</strong> with roles,
shared memory, and messaging.</p></div>

If you're new to Claude Code, "agent" gets thrown around a lot. Here's the plain-English version —
what an agent actually is, how subagents fit, and what changes when you run several at once.

## What an agent actually is

An agent is just a loop with a goal. A Claude Code agent is a running Claude session that can:

- **read** your files and project context,
- **act** — edit code, run shell commands, call tools — toward a task, and
- **repeat**, observing the results and deciding the next step.

That's it. Every terminal where you start a `claude` session is an agent: one goal, one context
window, one loop. The magic isn't the word "agent" — it's that the loop can use tools and keep going
until the job's done.

{% img "note-1" %}

## Agents vs. subagents

These two get conflated constantly, so let's separate them:

### Agent
A top-level session *you* drive. It owns a task from start to finish and you interact with it
directly.

### Subagent
A helper the main agent **spawns inside its own run** to fan out a chunk of work — "go research these
five files in parallel," for example. Subagents are powerful for parallelism, but they're
**short-lived and scoped to that one parent**: they don't persist after the run, and they don't share
memory across your whole workflow. For the deeper trade-offs, the difference between [subagents and a
full harness](/#what) is worth understanding before you lean on either.

The short version: subagents help *one* agent do more at once; they don't make *many* agents into a
team.

## From one agent to many

One agent handles most tasks fine. You start wanting *several* when work naturally splits — someone
writes tests while someone refactors while someone updates docs. The naive way is to open more
terminals, and that works… until it doesn't:

- agents **collide** on the same files,
- each session **forgets** what the others learned, and
- you lose track of **who's doing what** across a wall of tabs.

That's the wall every multi-agent setup hits. The fix isn't more agents — it's coordination. We wrote
the practical playbook in [how to run multiple Claude Code
agents](/blog/how-to-run-multiple-claude-code-agents/).

{% img "note-2" %}

## What turns agents into a team

Three additions turn parallel sessions into something that behaves like a team:

- **Roles** — each agent gets a job, so "who should do this?" is obvious.
- **Shared memory** — a durable, [long-term memory](/blog/give-claude-code-long-term-memory/) every
  agent reads, so knowledge compounds instead of resetting.
- **Coordination** — agents message each other and an orchestrator routes work, so you're not the bus.

When you wrap your agents in that layer, you've got a [multi-agent harness](/blog/what-is-a-multi-agent-harness/)
— the concept that turns "five chat windows" into "one office."

## Where to go next

- Ready to run several? Start with [how to run multiple Claude Code
  agents](/blog/how-to-run-multiple-claude-code-agents/).
- Want the field of tools? See [the best tools to run multiple Claude Code
  agents](/blog/best-claude-code-multi-agent-tools/).
- Curious about the concept? [What is a multi-agent harness?](/blog/what-is-a-multi-agent-harness/)

---

Munder Difflin is the team layer for the Claude Code agents you already run — roles, shared memory,
messaging, and an orchestrator, all local. [Download Munder Difflin](/#install) to turn your agents
into an office; it's free and open source.

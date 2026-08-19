---
title: "Claude Code Subagents vs a Multi-Agent Harness"
description: "Claude Code subagents vs a multi-agent harness: where subagents stop and a harness with shared memory, messaging, and an orchestrator takes over."
date: 2026-05-23
category: guides
categoryLabel: Guides
type: Technical
primaryKeyword: "claude code subagents"
secondaryKeywords: ["multi-agent harness", "subagent limits", "claude code agents"]
tags: ["Guides", "Subagents", "Multi-Agent", "Claude Code"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What are Claude Code subagents?"
    a: "Subagents are helpers a Claude Code session spawns inside its own run to handle a scoped piece of work — often parallel, read-heavy tasks. Each runs in its own context window and returns a result to the parent, then goes away. They're a fan-out tool, not a persistent team."
  - q: "When do subagents stop being enough?"
    a: "When you need work to persist across sessions, agents to remember what they learned, agents to message each other directly rather than only through a parent, or a coordinator that routes a whole goal. Those are harness features, not subagent features."
  - q: "Can I use subagents and a harness together?"
    a: "Yes, and you often should. Use subagents for fan-out inside a single agent's task; use a harness to coordinate multiple long-lived agents with shared memory and messaging across the whole workflow."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p><strong>Claude Code subagents</strong> are
short-lived helpers one session spawns to fan out scoped work — great for parallel reads, scoped to a
single parent, gone when done. A <strong>multi-agent harness</strong> wraps several long-lived agents
and adds what subagents don't have: <strong>persistent identities, shared memory, direct messaging
between agents, an orchestrator, and visibility</strong>. They're complementary — subagents work
<em>inside</em> an agent; a harness coordinates <em>across</em> agents.</p></div>

"Claude Code already has subagents — why would I need a harness?" It's a fair question, and the answer
isn't "subagents are bad." Subagents are excellent at what they do. They just do a different job than a
harness. This post draws the line precisely so you know which one a given problem calls for.

## What subagents are

A subagent is a helper a Claude Code session spawns *inside its own run*. The main agent delegates a
scoped task — "search these directories," "draft this section" — to a subagent that runs in its **own
context window**, does the work, and **returns a result** to the parent. Then it's gone.

Their sweet spot is **fan-out**, especially read-heavy work:

- searching a large codebase several ways at once,
- gathering context from many files in parallel,
- exploring independent options and reporting back.

Because each subagent has a fresh context window, the parent stays uncluttered — it gets conclusions,
not the raw dump. For a single agent tackling one big task, that's a real superpower.

## What subagents are not

The limits all stem from one fact: a subagent is **scoped to its parent's run**.

- **They're ephemeral.** A subagent exists for one task and disappears. Nothing it learned persists to
  the next session — there's no durable memory of its own.
- **Coordination is hub-and-spoke.** Subagents talk to the *parent*, not to each other. Two subagents
  can't message directly, share state, or negotiate. The parent is the only hub, and it's a bottleneck
  by design.
- **No shared long-term memory.** A subagent's findings live in the parent's context until that
  context is gone. There's no store the *whole workflow* reads from across sessions.
- **No standing roster.** You don't have a `reviewer` and a `migration` agent that persist as
  teammates across tasks; you have helpers conjured for one job.

None of this is a flaw — it's the scope. Subagents are an *intra-agent* concurrency primitive. They
were never meant to be a standing team.

{% img "note-1" %}

## What a harness adds

A [multi-agent harness](https://munderdiffl.in/#what) wraps agents you already run — full Claude Code
sessions — and adds the layer subagents structurally can't provide:

- **Persistent identities.** Each agent has a role, a name, and its own workspace that lives across
  tasks. Your `test-writer` is the same teammate next session.
- **Durable, shared memory.** Agents write notes that persist and become recall-able by the *whole*
  team — so agent B uses what agent A learned, even sessions later. That's
  [semantic memory for agents](/blog/semantic-memory-for-ai-agents/), not a context window that
  vanishes.
- **Direct messaging.** Agents send messages to *each other*, not only up to a parent. A router
  delivers them safely, so coordination is a mesh, not a single hub.
- **An orchestrator.** A coordinator reads your goal, decomposes it, and routes work across the team —
  and escalates only the critical calls to you. The parent-as-bottleneck problem goes away.
- **Visibility.** You can watch the whole team work, rather than peering into one agent's run.

Put simply: subagents give one agent *helpers*; a harness gives you a *team*.

## A side-by-side

| | Claude Code subagents | Multi-agent harness |
|---|---|---|
| **Lifespan** | One task, then gone | Persistent across sessions |
| **Memory** | Parent's context only | Durable + shared across the team |
| **Communication** | To the parent (hub-and-spoke) | Agent-to-agent (mesh) via a router |
| **Coordination** | The parent decides | An orchestrator routes + escalates |
| **Identity / roles** | Ephemeral helpers | Standing roster with roles |
| **Best for** | Fan-out within one task | Coordinating long-lived work |

The table isn't a scoreboard — it's a map. Each column wins its own territory.

{% img "note-2" %}

## They're better together

The framing that trips people up is "subagents *or* a harness." In practice it's both:

- **Inside** a single agent's task, subagents fan out the read-heavy parts and keep that agent's
  context clean.
- **Across** agents, the harness coordinates the standing team — shared memory, messaging, orchestration.

A harness-managed agent can absolutely use subagents for its own work. The harness operates one level
up, at the team scale; subagents operate one level down, at the task scale. Nothing about running a
coordinated team stops an individual agent from spawning helpers — and nothing about spawning helpers
gives you a coordinated team.

## Which do you need?

Use **subagents** (and nothing more) when:

- you're working with **one** primary agent on a task,
- the parallelism you want is *within* that task (search, gather, explore), and
- you don't need anything to persist past the run.

Reach for a **harness** when:

- you're running **several** agents and losing track of who's doing what,
- you keep **re-explaining** context because each session forgets,
- agents need to **hand work to each other** without you relaying it, or
- you want to state a goal once and have a **team** divide and conquer.

That threshold — one agent's task vs. a coordinated team — is the whole decision. If you're hitting it,
the next read is [how to run multiple Claude Code agents](/blog/how-to-run-multiple-claude-code-agents/),
and for a concrete head-to-head of two ways to get a team, see
[Claude Squad vs Munder Difflin](/blog/claude-squad-vs-munder-difflin/).

## FAQ

**Is a harness just "subagents that don't expire"?** Not quite. Persistence is part of it, but the
bigger additions are *shared memory* and *direct inter-agent messaging* — a subagent that merely lived
longer still couldn't message a sibling or recall another agent's notes.

**Do I lose subagents if I adopt a harness?** No. Your agents are still full Claude Code sessions, so
they keep every native capability, subagents included. The harness adds coordination around them; it
doesn't take anything away.

---

Munder Difflin is the harness layer: persistent agents, shared memory, direct messaging, and a GOD
orchestrator — wrapped around the Claude Code sessions (and subagents) you already use.
[Download Munder Difflin](https://munderdiffl.in/#install) to turn helpers into a team; it's free and
open source.

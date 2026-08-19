---
title: "The Command Center: Kanban, Fleet, and Budgets in One Place"
description: "A guide to Munder Difflin's Command Center — the task kanban, live fleet monitoring, per-agent budgets and cost telemetry — and when to watch the board instead of the floor."
date: 2026-07-03
category: guides
categoryLabel: Guides
type: Non-technical
primaryKeyword: "ai agent command center"
secondaryKeywords: ["agent task kanban", "monitor ai agent fleet", "per-agent token budgets", "ai agent cost tracking", "multi-agent dashboard"]
tags: ["Guides", "Command Center", "Kanban", "Cost", "Observability"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What is the Command Center in Munder Difflin?"
    a: "It's Michael's control surface — the management view of the whole hive. It has tabs for the orchestrator Terminal, the Floor (roster, dispatch, per-agent model selector, live fleet monitoring), Memory (semantic search plus a memory graph), Activity (event log, board, real token telemetry, observability, and a CI watcher), Tasks (a dependency-aware kanban board), and Triggers (everything that starts work without you — schedules with last/next-fired times, context, webhooks, and organization)."
  - q: "How does the task kanban work?"
    a: "The Tasks tab is a dependency-aware kanban board. You assign tasks to agents and track them across todo, doing, blocked, and done. Because tasks can declare dependencies, downstream work waits until its prerequisites finish, so a chain of related tasks starts in the right order without you babysitting the handoffs."
  - q: "How do per-agent budgets and cost tracking work?"
    a: "You set a token budget per agent, and live fleet monitoring tracks consumption across the roster. Cost numbers are real, not estimates from vibes: the Activity tab reads the JSONL transcripts Claude Code writes and surfaces actual token counts plus estimated USD cost per agent per session, backed by a durable cost ledger that survives restarts. The budget pairs with a circuit breaker that steers, then constrains, then stops an agent that loops or blows its cap."
  - q: "When should I watch the office floor versus the Command Center?"
    a: "The floor is for ambient awareness and single-agent moments — seeing who's working, watching envelopes fly, dropping into one terminal. The Command Center is for management questions: what's queued and blocked, what each agent has spent, whether CI is green, and what fires next on the schedule. Roughly: floor for one agent right now, board for the whole fleet over time."
  - q: "Does the Command Center include observability?"
    a: "Yes. The Activity tab includes a live OpenTelemetry collector with per-model cost attribution, a fleet grid, and a per-agent tool-span waterfall, so you can see exactly what every agent is doing and what it costs in real time. Each agent card also carries a context-window gauge showing how much of the model's context that agent has consumed."
  - q: "Can the Command Center pull in work from GitHub?"
    a: "Yes. You can ingest open issues from any registered repo via the gh CLI and assign them to agents with one click, and a CI status watcher shows live pass/fail/in-progress state for GitHub Actions runs in the Activity tab. Work flows in from GitHub, gets tracked on the kanban, and its CI result lands back in the same view."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>The office floor is fun to watch, but you don't manage a team by staring at desks. Munder Difflin's <strong>Command Center</strong> is the management view: a <strong>dependency-aware task kanban</strong>, <strong>live fleet monitoring with per-agent token budgets</strong>, <strong>real cost telemetry</strong> backed by a durable ledger, <strong>OpenTelemetry observability</strong> with a per-agent tool-span waterfall, plus GitHub issue ingestion, a CI watcher, and a Triggers tab. Rule of thumb: <strong>watch the floor for one agent right now, watch the board for the whole fleet over time</strong>.</p></div>

<video controls preload="none" playsinline poster="/media/demo/features-poster.jpg" style="width:100%; border-radius:12px; margin:12px 0 24px;">
  <source src="/media/demo/features.mp4" type="video/mp4" />
</video>

Munder Difflin has two ways of looking at the same hive. The **office floor** is the ambient view: avatars at desks, envelopes flying between them, speech bubbles when a tool fires. The **Command Center** is the management view — Michael's control surface, the place you go when the question stops being "what is Dwight doing?" and becomes "what is *everyone* doing, what has it cost, and what's next?"

This guide walks through what's in it and how the pieces fit together.

## What's in the Command Center

Six tabs, one control surface:

- **Terminal** — Michael's own terminal, the [GOD orchestrator](/blog/how-the-god-orchestrator-works/) you talk to directly.
- **Floor** — the roster and dispatch controls: hire, dispatch work, pick a model per agent, and watch live fleet monitoring across everyone at once.
- **Memory** — semantic search over the shared memory palace, plain text search, and a memory graph.
- **Activity** — the append-only event log, the blackboard, real token telemetry, the observability view, and a CI watcher.
- **Tasks** — the kanban board.
- **Triggers** — everything that starts work without you, grouped by kind: schedules (recurring missions and the adaptive heartbeat, with last/next-fired times), context, webhooks, and organization.

You could run the hive from the floor alone. But once you have more than two or three agents, the Command Center is where the actual decisions happen.

## The task kanban: work as a board, not a chat log

The Tasks tab is a **dependency-aware kanban board**. Tasks move across four columns — todo, doing, blocked, done — and each task is assigned to a specific agent.

The load-bearing word is *dependency-aware*. Real work has ordering: the refactor has to land before the tests get updated; the schema migration comes before the endpoint. On the board you wire those dependencies explicitly, and downstream tasks wait until their prerequisites finish. You're not the sequencer anymore — the board is.

Work gets onto the board a few ways: you create tasks yourself, Michael creates and assigns them as he routes requests, and you can **pull open GitHub issues from any registered repo** (via the `gh` CLI) and assign them to agents with one click. Issue in, task tracked, agent dispatched — and when the work ships, the **CI status watcher** in the Activity tab shows live pass/fail/in-progress for the repo's GitHub Actions runs. The loop closes in the same window it opened in.

{% img "note-1" %}

## Fleet status: the roster at a glance

The Floor tab is where the fleet stops being a set of individual terminals and becomes a roster. Each agent card shows what that agent is up to, and the card's progress bar doubles as a **context-window gauge** — a glanceable read on how much of the model's context each agent has burned. An agent near the top of its gauge is an agent about to compact or slow down; you can see it coming instead of discovering it.

Dispatch also lives here: pick an agent, pick a model (the **per-agent model selector** means your cheap-tier worker and your frontier-tier reviewer are one dropdown apart), and send work. Routine tasks go to the cheap tier; the frontier tier is reserved for the reasoning that needs it.

## Budgets and cost: real numbers, not vibes

This is the part that makes a 24/7 fleet safe to leave running.

**Per-agent token budgets.** You set a budget per agent, and live fleet monitoring tracks consumption across the whole roster against it. Budgets pair with the **circuit breaker**, which handles the runaway case on a ladder: *steer* (nudge the agent), then *constrain*, then *stop*. An agent that loops, storms errors, or blows through its cap gets caught by machinery, not by you noticing the bill.

**Real telemetry.** The Activity tab doesn't estimate from message counts — it reads the JSONL transcripts Claude Code writes to `~/.claude/projects/` and surfaces **actual token counts and estimated USD cost per agent, per session**, backed by a **durable cost ledger** that survives app restarts. Yesterday's spend is still there this morning, attributed to the agent that spent it.

**Observability.** Also in Activity: a live **OpenTelemetry collector** with per-model cost attribution, a fleet grid, and a **per-agent tool-span waterfall** — the "what exactly is this agent doing, step by step, and what does each step cost" view. It's the same discipline we covered in [observability for agent fleets](/blog/observability-for-agent-fleets/), built into the harness instead of bolted on.

{% img "note-2" %}

## Triggers: the board's fourth dimension

The kanban answers "what's in flight." The **Triggers tab** answers "what happens next without me" — every way the hive wakes up when you aren't typing. **Schedules** are the first and oldest of them: recurring missions carry a label, an interval, a target agent, and a body, and the tab shows last-fired and next-fired times, so drift is visible. A scheduler **heartbeat** re-engages the floor when it goes quiet. Together with the board, it turns the hive from something you drive into something you supervise — the full pattern is in [scheduling autonomous agent missions](/blog/scheduling-autonomous-agent-missions/).

## Floor or board? A simple rule

Both views are the same hive, so this is about attention, not data:

- **Watch the floor** when you care about *one agent right now* — you just dispatched something, you want to type into a session, or you want ambient awareness while doing other work. (Also: it's charming.)
- **Watch the board** when you care about *the fleet over time* — what's queued, what's blocked on what, who's near budget, whether CI is green, what fires tonight.

In practice: floor open while you work, Command Center when you check in. Morning check-in is the board — done column, spend per agent, blocked tasks, next scheduled missions. That's a two-minute read that would take twenty minutes of terminal-scrolling without it. And when something needs a human decision, escalations land in the [approvals queue](/blog/human-in-the-loop-approving-ai-agents/) rather than hiding in a scrollback buffer.

## Try it

The Command Center ships in the current release, free and open source. [Download Munder Difflin](https://github.com/chaitanyagiri/munder-difflin/releases/latest) — and if the board earns its place in your morning routine, a [star on GitHub](https://github.com/chaitanyagiri/munder-difflin) helps more people find it.

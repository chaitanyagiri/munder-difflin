---
title: "Observability for Agent Fleets: Seeing What Your Agents Do"
description: "Agent fleet observability: the four questions your dashboard must answer about who's working, what they're doing, what it costs, and what they know."
date: 2026-06-04
category: internals
categoryLabel: Internals
type: Technical
primaryKeyword: "ai agent observability"
secondaryKeywords: ["agent fleet monitoring", "agent token cost tracking", "multi-agent dashboard"]
tags: ["Internals", "Observability", "Multi-Agent", "Claude Code"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "How is observability for AI agents different from normal app observability?"
    a: "App observability watches deterministic services — latency, error rates, throughput. Agent observability watches non-deterministic actors that make their own choices: which tools they call, what they decide, what they spend, what they remember. You're not just asking 'is it up?' but 'what is it doing and why, and is that what I wanted?' That needs a feed of intent and actions, not just health metrics."
  - q: "Why track token cost per agent?"
    a: "Because autonomous agents spend money without asking, and a runaway loop or an over-eager agent shows up first as a cost spike. Per-agent token and dollar telemetry turns 'the bill is high' into 'this agent is the reason' — fast enough to intervene. It's the cheapest early-warning signal an agent fleet has."
  - q: "Where does the telemetry come from?"
    a: "Two sources: lifecycle hooks stream what each agent is doing in real time, and the agents' own transcript files record exact token counts. Combine the live event stream with the on-disk usage and you can reconstruct both 'what happened' and 'what it cost' without instrumenting the model itself."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>A fleet of autonomous agents you can't see is a
fleet you can't manage. Good agent observability answers four questions at a glance: <strong>who's
working</strong> (roster + status), <strong>what are they doing</strong> (a live activity feed from the
event log), <strong>what is it costing</strong> (per-agent token + dollar telemetry from their
transcripts), and <strong>what do they know</strong> (task board + memory). Build that dashboard and
"my agents are off doing something" becomes "I can see exactly what, and step in early."</p></div>

When you run one agent, you watch its terminal. When you run twenty, you can't — and the failure modes
change. An agent quietly loops and burns tokens. Two pick up overlapping work. One stalls waiting on a
message that never came. None of that shows up in a terminal you're not staring at. A fleet needs a
dashboard, and "agent observability" is a different problem from watching a normal service. Here's the
shape of one that works.

## The four questions a fleet dashboard must answer

App monitoring asks "is it healthy?" Agent monitoring asks four sharper questions:

1. **Who's working?** Which agents are active vs idle vs archived.
2. **What are they doing?** A live, human-readable stream of their actions and messages.
3. **What is it costing?** Token and dollar spend, per agent, in near-real-time.
4. **What do they know?** The shared task state and memory driving their decisions.

Miss any one and you're flying partly blind. Below is how each maps to something concrete.

## A live activity feed from the event log

The backbone is a single [append-only event log](/blog/append-only-event-log-agents/): every spawn,
message, inbox drain, and escalation gets one line. A dashboard renders that log as a human-readable feed —
not raw JSON, but sentences:

- `spawned Pam`
- `Jim → Stanley: Task from you`
- `Stanley drained 2 msg(s)`
- `escalated to human: merge approval`

Now "what's the fleet doing right now" is a glance, not an investigation. The feed is fed by
[lifecycle hooks](/blog/the-hook-shim-pattern/): every agent's tool-use, stops, and notifications stream
into the main process in real time, so the picture is live rather than a periodic poll. The same
[orchestrator](/blog/how-the-god-orchestrator-works/) that routes work reads this feed to keep its
situational awareness current.

{% img "note-1" %}

## Token and cost telemetry, per agent

This is the part teams skip and regret. Autonomous agents spend money on their own, so **cost is a
first-class signal**, not an end-of-month surprise.

The trick is that you don't have to instrument the model — the usage is already on disk. Each agent's
Claude Code transcripts record exact input and output token counts. A usage meter reads those transcripts
per agent (polling every few seconds), shows input/output tokens and an estimated dollar cost, and
normalizes a bar against the most-expensive agent so the outlier is obvious at a glance. A runaway loop or
an over-eager agent stops being "the bill looks high" and becomes "that row is three times everyone else"
— early enough to intervene. Cost telemetry is the cheapest smoke detector a fleet has.

## State at a glance: task board, memory, roster

Actions and cost tell you *what's happening*; state tells you *why*.

- **A task board.** A kanban of todo / doing / blocked / done makes coordination visible — what's queued,
  what's stuck, who owns what. "Blocked" columns are where fleets silently stall.
- **A memory view and graph.** What the hive [knows](/blog/semantic-memory-for-ai-agents/) — and being able
  to jump into any agent's memory — explains decisions. An agent acting oddly usually has an odd memory.
- **A roster with per-agent model.** Who exists, who's active, and which model each runs. Useful for both
  "is everyone alive?" and "why is the Opus agent the cost outlier?"

Add a full-text search across the board, tasks, and memory and you can answer ad-hoc questions ("who
mentioned the release?") without grepping files by hand.

{% img "note-2" %}

## Observability vs debugging

These are different jobs. [Debugging a multi-agent system](/blog/debugging-multi-agent-systems/) is
*reactive* — something broke, you reconstruct why. Observability is *proactive* — a standing picture that
lets you catch the loop, the collision, or the cost spike **before** it becomes an incident. The activity
feed and usage meter are how you notice; the event log and transcripts are how you then dig in. You want
both, and the observability layer is what tells you when to switch from watching to debugging.

The quiet payoff: once you can *see* a fleet cheaply, you trust it to run unattended. Visibility is what
makes "leave the agents working" a calm decision instead of a leap of faith.

## FAQ

**Do I need a metrics stack like Prometheus/Grafana?** Not to start. A fleet of dozens of local agents is
well served by reading the event log and transcripts directly and rendering them. Reach for a heavy
metrics stack when you're distributed across machines and need retention and alerting at scale.

**What's the single highest-value signal?** Per-agent cost. It catches runaway loops, surfaces the
expensive outlier, and is trivial to read from transcripts. If you add one thing, add that.

**How live is "live"?** The activity feed is event-driven (pushed by hooks as things happen); the usage
meter polls transcripts every several seconds. Plenty fast for agent turns measured in seconds to minutes.

---

Munder Difflin ships this as the orchestrator's control surface — a live activity feed, per-agent token
and cost meters, a task board, and a memory graph for a whole
[hive of Claude Code agents](https://munderdiffl.in/#how), all local.
[Download Munder Difflin](https://munderdiffl.in/#install) to watch your fleet at a glance; it's free and
open source.

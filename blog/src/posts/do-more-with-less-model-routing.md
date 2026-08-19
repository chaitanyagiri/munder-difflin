---
title: "Do More With Less: Smart Model Routing Across Agents"
description: "Why a hive of agents shouldn't all run the biggest model — and how routing the right task to the right model cuts cost and latency without losing quality."
date: 2026-06-04
category: concepts
categoryLabel: Concepts
type: Non-technical
primaryKeyword: "ai model routing"
secondaryKeywords: ["model routing", "llm cost optimization", "sonnet vs opus", "ai agent cost"]
tags: ["Model Routing", "Cost", "Orchestration", "Multi-Agent"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What is AI model routing?"
    a: "Model routing is the practice of sending each task to the model that fits it, rather than running everything on one model. A cheap, fast model handles routine work — formatting, classification, simple edits — and a heavier, more capable model is reserved for the hard reasoning. In a multi-agent system the router is usually the orchestrator, deciding per task which model an agent should use."
  - q: "Does using a smaller model hurt quality?"
    a: "Only if you use it for the wrong tasks. Most of what an agent does on any given hour is routine — and a smaller model does routine work just as well for a fraction of the cost and latency. Quality drops when you under-power genuinely hard reasoning, not when you right-size the easy stuff. The skill is matching task difficulty to model capability."
  - q: "How much can model routing actually save?"
    a: "It depends on your task mix, but the economics are stark: the gap between a small and a large model is often 10–20x per token. If most of your agents' work is routine and you route only the hard fraction to the big model, you can cut spend by more than half while keeping — sometimes improving — quality, because cheaper calls also run faster."
  - q: "Who decides which model to use in a multi-agent hive?"
    a: "The orchestrator. It sees the task before it's assigned, so it's the natural place to pick the model: default everyone to a lean model, and escalate to a heavier one only for tasks flagged as hard, ambiguous, or high-stakes. Individual agents can also request an escalation when they detect they're out of their depth."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>Running every agent on the biggest model is
the most common way to waste money on a hive. Most agent work is <strong>routine</strong> — and a
small, fast model does routine work just as well for a fraction of the cost. <strong>Model routing</strong>
means defaulting to the lean model and <strong>escalating to a heavyweight only when the task is
genuinely hard</strong>. The orchestrator is the natural router because it sees the task before it's
assigned. Done right, you cut spend by more than half <em>and</em> get faster answers — doing more with
less.</p></div>

There's a reflex when you wire up a team of AI agents: give all of them the best model you can afford,
because more capability is always better, right? It feels safe. It's also the fastest way to turn a
useful hive into an expensive one. The truth that experienced operators learn quickly is that **most of
what agents do all day doesn't need a frontier model at all** — and paying frontier prices for routine
work is pure waste. The fix is **model routing**: matching the task to the model instead of flattening
everything onto one.

## The work isn't uniform — so why is the model?

Watch a hive for an hour and you'll see a huge range of task difficulty. An agent reformatting a file,
classifying a message, renaming variables, or summarizing a short log is doing **routine** work — the
kind a small model handles perfectly. Another agent untangling a subtle race condition, designing an
architecture, or reasoning through an ambiguous spec is doing **hard** work that genuinely rewards a
bigger model.

If you run both on the same heavyweight model, you're overpaying for the first kind every single time.
The distribution matters: in most real workloads the routine tasks vastly outnumber the hard ones. So
the single biggest cost lever isn't a discount — it's **not using the expensive model for the 80% of
work that doesn't need it**.

## The economics, plainly

The price gap between model tiers is not small. A lean model and a frontier model can differ by
**10–20x per token**, and the cheaper one usually answers **faster** too. Put those together and the
arithmetic is hard to ignore:

- Run **everything** on the big model → you pay the premium on every task, routine or not.
- Run **everything** on the small model → you save money but botch the genuinely hard tasks, and a wrong
  answer on a hard task is far more expensive than the tokens you saved.
- **Route** → default to the lean model, escalate the hard fraction → you pay the premium only where it
  buys you something.

The third option typically cuts total spend by more than half while *keeping* quality, because you only
spend big where capability actually changes the outcome. "Do more with less" isn't a slogan here; it's
just what falls out of matching price to need.

{% img "note-1" %}

## The orchestrator is the natural router

In a single-agent setup, routing is a manual choice you make per session. In a hive, you can do better,
because there's already a component that sees every task before it's handed out: the
[orchestrator](/blog/how-the-god-orchestrator-works/). It's the natural place to decide which model each
task deserves.

A simple, durable policy:

1. **Default lean.** Every agent starts on the small, fast model. Most tasks never need more.
2. **Escalate on signal.** When the orchestrator (or the agent itself) detects that a task is hard,
   ambiguous, high-stakes, or has already failed once on the lean model, it bumps that task to the
   heavyweight.
3. **De-escalate after.** A hard task often has easy sub-steps. Once the reasoning is done, routine
   follow-up work drops back to the lean model.

Notice this mirrors how a good human team works: you don't put your most senior engineer on every ticket;
you route the gnarly ones to them and let the rest flow to whoever's available. A lean orchestrator
[coordinating specialists](/blog/coordinating-ai-coding-agents/) and escalating only when needed is the
same idea applied to models.

## Reading the signals

Routing well means knowing *when* a task deserves the expensive model. You don't need a perfect predictor —
a few cheap heuristics catch most of it:

- **Stakes.** Anything touching spend, destructive operations, or shipped output earns a heavier model
  and usually [a human check too](/blog/human-in-the-loop-ai-agents/).
- **Ambiguity.** A vague or open-ended request (design, root-cause, "figure out why") rewards reasoning
  power; a precise mechanical request doesn't.
- **Failure.** If the lean model tried and got it wrong, escalate instead of retrying at the same tier —
  retrying a too-small model is just paying twice for the same miss.
- **Length and dependency.** Tasks that chain many steps or hold a lot of state benefit from the stronger
  model's coherence over long runs.

Everything that trips none of these — the bulk of the day — stays lean.

{% img "note-2" %}

## You can't route what you can't see

The honest caveat: routing decisions are only as good as your visibility into cost. If you don't know
which agents and tasks are burning the most tokens, you're guessing. The teams that get the most out of
routing are the ones that **measure first** — per-agent and per-task token spend, attributed and trended
over time — and then tune the escalation policy against real data instead of vibes. Measurement turns
routing from a hunch into a control you can actually steer. (It's the same instinct as
[keeping the work local and observable](/blog/why-local-first-matters-for-ai-agents/): you can't manage
what you can't watch.)

## The bottom line

A hive that runs everything on the biggest model isn't being careful — it's being wasteful, and slowly.
The better posture is **lean by default, heavy on purpose**: route the routine majority to a small fast
model, reserve the frontier model for the hard minority, and measure enough to know which is which. You
end up spending less, answering faster, and — because you're no longer drowning genuinely hard tasks in
the same undifferentiated pool — often getting *better* results where it counts.

Munder Difflin is built for exactly this posture: a lean [orchestrator](/#how) that routes work across a hive and
escalates only when a task earns it. [Download Munder Difflin](https://munderdiffl.in/#install) to run an
agent team that does more with less — it's free and open source.

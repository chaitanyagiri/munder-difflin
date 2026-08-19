---
title: "Orchestrating Claude Code Agents: A Practical Guide"
description: "How to orchestrate Claude Code agents in practice: what orchestration means, how a GOD orchestrator routes and escalates work, and how to wire it up."
date: 2026-05-28
category: orchestration
categoryLabel: Orchestration
type: Technical
primaryKeyword: "how to orchestrate claude code agents"
secondaryKeywords: ["claude code orchestration", "claude code orchestrator", "ai agent orchestration"]
tags: ["Orchestration", "Multi-Agent", "Claude Code", "GOD"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What does it mean to orchestrate Claude Code agents?"
    a: "Orchestration is the layer that decides which agent does what: it reads your intent, decomposes it into tasks, routes each to the right agent, resolves routine questions between agents, and escalates only the decisions that genuinely need a human."
  - q: "Do I write the orchestration logic myself?"
    a: "You can, but you don't have to. In Munder Difflin the orchestrator is itself a Claude agent — the GOD agent — so the routing intelligence is a prompt you tune, not code you maintain. The harness provides the mechanism (messaging, git, escalation queue); the agent provides the judgment."
  - q: "How is an orchestrator different from a task queue?"
    a: "A queue hands out work in order; it doesn't reason about it. An orchestrator reads each request, decides who's best suited, writes a self-contained task spec, and adapts when an agent gets blocked or two agents conflict."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p><strong>Orchestration</strong> is the layer
that turns "a few Claude Code agents" into "a team that finishes a goal." It reads your intent,
<strong>decomposes</strong> it, <strong>routes</strong> each piece to the right agent, <strong>adjudicates</strong>
the routine back-and-forth between agents, and <strong>escalates</strong> only the critical calls to
you. In Munder Difflin that role is played by a GOD orchestrator — a Claude agent whose only job is to
run the floor.</p></div>

Most "multi-agent" setups are really just multiple agents — several sessions running side by side
with you in the middle, deciding who does what. The thing that makes them a *team* is orchestration.
This guide explains what orchestration actually does for coding agents, and how to wire it so it runs
without you in the loop for every decision.

## What "orchestration" means for coding agents

Strip away the buzzword and orchestration is five concrete jobs:

1. **Read intent.** Take a plain-language goal ("ship input validation with tests and docs") instead
   of pre-chopped tasks.
2. **Decompose.** Break the goal into units small enough for one agent to own.
3. **Route.** Assign each unit to the agent best suited for it, with a self-contained task spec so the
   agent doesn't have to ask what you meant.
4. **Adjudicate.** Handle the questions agents raise *for each other* — clarifications, data asks,
   small plan changes — so the team keeps moving without bouncing everything back to you.
5. **Escalate.** Recognize the few decisions that genuinely need a human (spending money, destructive
   operations, scope changes, conflicts nobody can resolve) and stop there.

A task queue does #3 and nothing else. Orchestration is the other four — the *judgment* — which is
why, in a well-designed harness, the orchestrator is itself an intelligent agent rather than a switch
statement.

## The mechanism vs. the intelligence

The cleanest way to build this is to split it in two:

- **The mechanism** is plumbing: deliver messages, commit state, hold a queue of items waiting on a
  human. It has no opinions. It must be reliable, not smart.
- **The intelligence** is an agent — the orchestrator — that reads requests and decides. It must be
  smart, and it's allowed to be imperfect, because the mechanism keeps the system safe.

In Munder Difflin the mechanism is the harness's main process (it runs git, the message router, and
the approvals queue) and the intelligence is the **GOD agent** — an ordinary `claude` process flagged
as the orchestrator, seated in the corner office. Because the orchestrator is a prompt, not a
codebase, you tune *how* it routes and *what* it considers critical by editing its instructions, not
by redeploying. That's the practical heart of
[how the GOD orchestrator works](/blog/how-the-god-orchestrator-works/).

{% img "note-1" %}

## How a request flows through the orchestrator

Here's the path a single instruction takes, end to end:

### 1. You describe a goal to the orchestrator

You talk to one agent — the orchestrator — in plain language. You don't address the workers directly
and you don't pre-assign tasks. This is the whole ergonomic win: one conversation instead of N.

### 2. It decomposes and routes

The orchestrator reads its roster (who exists, their roles and capabilities) and assigns each piece of
work, writing a task spec that's self-contained enough for the receiving agent to act without a
follow-up. Routing to the *right* agent is where roles earn their keep — a `test-writer` gets the
tests, not the migration.

### 3. Agents work, and message each other

Each worker is its own session with isolated context. When one needs something from another, it sends
a message rather than going through you. Crucially, agents never write into each other's files — they
drop a message in their own outbox and the harness delivers it. That single-writer discipline is what
keeps the whole thing from corrupting itself; the mechanics are in
[atomic file mailboxes](/blog/atomic-file-mailboxes-for-agents/).

### 4. The orchestrator adjudicates the routine stuff

Most inter-agent traffic is mundane: "which schema do I validate against?" "is the staging URL still
X?" The orchestrator answers these itself and keeps the floor autonomous. Anti-loop rules matter
here — only requests, queries, and proposals obligate a reply, and a hop counter caps how long any
exchange can ping-pong before the orchestrator steps in. Without those rules, two polite agents will
thank each other forever.

### 5. It escalates only the critical few

When something crosses a line — real spend, a destructive operation, a scope change, a conflict it
can't resolve — the orchestrator escalates to *you* instead of deciding. That item lands in a
human-approval queue; your answer (with an optional note like "yes, but cap it at $5") is relayed back
to the agent that asked. Everything else stays autonomous. This selective escalation is the difference
between an agent team that needs constant supervision and one that only taps you on the shoulder when
it should.

## Designing good orchestration

If you're building or tuning an orchestrator, a few principles separate the ones that work from the
ones that thrash:

- **Make the escalation policy explicit.** "Critical" should be a written list (spend, destructive
  ops, scope, unresolvable conflict), not a vibe. It's the single most important control surface —
  too loose and the team does scary things; too tight and you become the bottleneck again.
- **Give the orchestrator a real roster.** It can only route well if it knows who exists and what
  they're good at. Roles and capabilities aren't decoration; they're the routing table.
- **Keep the orchestrator out of the work.** Its job is to route and adjudicate, not to write the
  code itself. An orchestrator that starts doing the tasks is a bottleneck wearing a manager's hat.
- **Make coordination auditable.** Every routed message and every escalation should be logged, so
  when the team goes sideways you can replay what happened. For the broader patterns here, see
  [the best way to coordinate AI coding agents](/blog/coordinating-ai-coding-agents/).

{% img "note-2" %}

## When you actually need an orchestrator

You don't need orchestration for one agent, or even for two or three independent tasks you're happy to
assign by hand. You need it when:

- you're describing the *same* context to multiple agents over and over,
- you find yourself relaying messages between agents, or
- you want to state a goal once and have the team figure out the division of labor.

That's the threshold where [running multiple Claude Code agents](/blog/how-to-run-multiple-claude-code-agents/)
turns from a chore into something that genuinely compounds.

## FAQ

**Can the orchestrator route to the wrong agent?** Yes — it's a model, so it can misjudge. The
mechanism contains the damage: misrouted work still goes through messaging and the single-committer
git layer, so a bad routing decision is recoverable, not corrupting. And because the policy is a
prompt, you correct the pattern by editing instructions.

**Does orchestration add latency?** A little — there's a routing hop before work starts. In exchange
you stop being the router yourself, which is almost always the bigger time sink.

---

Munder Difflin ships this [orchestration model](https://munderdiffl.in/#how) out of the box: a GOD agent you talk to, a reliable
message router, and a human-approval queue for the critical few — all running locally.
[Download Munder Difflin](https://munderdiffl.in/#install) to orchestrate your own team of Claude Code
agents; it's free and open source.

---
title: "Inside the GOD Orchestrator: Routing, Adjudication, Escalation"
description: "A deep dive into the Claude Code orchestrator: how a GOD agent reads requests, routes work, adjudicates routine traffic, and escalates the critical few."
date: 2026-05-30
category: orchestration
categoryLabel: Orchestration
type: Technical
primaryKeyword: "claude code orchestrator"
secondaryKeywords: ["ai orchestrator", "agent routing", "supervisor agent"]
tags: ["Orchestration", "GOD", "Multi-Agent", "Internals"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "Is the GOD orchestrator a special kind of model?"
    a: "No. It's an ordinary Claude Code process with a flag marking it as the orchestrator and a system prompt that defines its job. The intelligence is a normal agent; the harness around it provides the mechanism — routing, git, and the human-approval queue."
  - q: "What does the orchestrator escalate to a human?"
    a: "Only genuinely critical items: destructive operations, spending real money, scope changes, and conflicts it can't resolve. Everything else — clarifications, data asks, small plan tweaks — it resolves itself so the team stays autonomous."
  - q: "How does the orchestrator avoid infinite loops between agents?"
    a: "Messages carry a hop count that increments on each reply; past a cap the item is escalated instead of bouncing forever. Only requests, queries, and proposals obligate a reply — pure informational messages are terminal."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>The <strong>GOD orchestrator</strong> is the
supervisor agent that runs a hive of Claude Code agents. It's a normal Claude process — the
<em>intelligence</em> — wrapped by a harness that provides the <em>mechanism</em> (a message router,
single-committer git, and a human-approval queue). Its four jobs: keep the <strong>roster</strong>,
<strong>route</strong> work, <strong>adjudicate</strong> routine inter-agent traffic, and
<strong>escalate</strong> only the critical few to you.</p></div>

Every multi-agent system eventually needs one agent in charge — not to do the work, but to decide who
does. In Munder Difflin that's the **GOD orchestrator**. This is a deep dive into how it actually
works: the split between intelligence and mechanism, the four jobs it owns, and the rules that keep it
from looping or going rogue.

## Intelligence vs. mechanism

The single most important design decision is what the orchestrator *is*. It would be tempting to write
the routing logic as code — a big dispatcher that inspects each request and assigns it. That's
brittle: every new kind of task needs new code.

Instead, the orchestrator is split in two:

- **The mechanism** lives in the harness's main process. It runs git (single committer), the message
  router that moves messages between agents, the append-only event log, and the approvals queue that
  holds items waiting on a human. The mechanism has no judgment. It's reliable plumbing.
- **The intelligence** is the GOD agent itself — an ordinary `claude` process, flagged as the
  orchestrator, that reads requests and decides what to do with them. Its routing and escalation
  *policy* live in its system prompt.

The payoff: you change how the orchestrator behaves by editing a prompt, not by shipping code. Want it
to escalate more aggressively, or to favor a particular specialist? Tune the instructions. The
mechanism underneath stays the same and stays safe. (For the broader principle, see
[orchestrating Claude Code agents](/blog/claude-code-orchestration-guide/).)

## Job 1 — Keep the roster

The orchestrator can only route well if it knows who's on the floor. The harness maintains a
**registry** — every agent's id, name, role, capabilities, and current status (idle, working, blocked,
gone). When an agent is spawned, it's registered; the orchestrator reads the registry to know its
options.

This is the routing table. A request to "write tests for the new endpoint" goes to the agent whose
role and capabilities say *tests*, not to whoever happens to be free. Roles aren't cosmetic — they're
how the orchestrator makes a sensible assignment instead of a random one.

## Job 2 — Route work

When you describe a goal, the orchestrator decomposes it and routes each piece. The key detail is
*how* it routes: it doesn't reach into a worker's files and tell it what to do. It sends a message — a
self-contained task spec — into the worker's inbox, via the same router every agent uses.

That message is a structured object. Borrowing the one useful idea from agent-communication research —
the **speech act** — each message declares its intent:

```jsonc
{
  "to": "agent.coder",
  "act": "request",          // request | inform | propose | query | agree | refuse | done
  "subject": "Add validation to signup",
  "body": "…self-contained task spec…",
  "conversation": "conv-7f3" // groups a thread
}
```

The harness fills in the id, sender, hop count, and timestamps. A good task spec means the worker can
start without a follow-up question — which is the difference between routing that accelerates the team
and routing that just adds a hop.

{% img "note-1" %}

## Job 3 — Adjudicate the routine traffic

This is the job that makes autonomy real. As agents work, they raise questions *for each other*: which
schema to validate against, whether a staging URL is current, a small change to the plan. If every one
of those bounced back to you, the "team" would just be a slower version of you doing everything.

So the orchestrator adjudicates. It drains its own inbox continually, answers the routine asks itself,
and routes work to the right specialist with a clear spec. Most inter-agent traffic never reaches you
because it shouldn't have to.

Two rules keep adjudication from turning into chaos:

- **Not every message obligates a reply.** Only `request`, `query`, and `propose` expect an answer.
  `inform` and `done` are terminal — replying to them is how two agents loop forever, so the protocol
  forbids it.
- **Hops are capped.** Every reply increments a hop counter. Past the cap, the item is escalated to a
  human instead of being allowed to ping-pong. It's a livelock fuse.

The shared plan is adjudicated too: the orchestrator is the **single scribe** of the board. Other
agents propose changes; only the orchestrator writes them. That keeps the one genuinely co-owned
document from conflicting. The messaging fabric beneath all of this is covered in
[atomic file mailboxes for agents](/blog/atomic-file-mailboxes-for-agents/).

## Job 4 — Escalate the critical few

The orchestrator's most important boundary is knowing what *not* to decide. Its escalation policy is a
short, explicit list of what counts as critical:

- **Destructive operations** — anything that deletes or overwrites in a way that's hard to undo.
- **Spending real money** — actions with a dollar cost.
- **Scope changes** — work that drifts from what you actually asked for.
- **Unresolvable conflicts** — two agents at an impasse the orchestrator can't break.

When an item matches, the orchestrator escalates instead of acting. Mechanically, it sends a message
addressed to the human (or flags it as needing human attention), and the harness diverts it into an
**approvals queue** surfaced in the UI. You approve or reject — optionally with a note, like "yes, but
cap it at $5" — and that note is relayed back to the agent that asked, as a message from the human.
The agent picks up where it left off with your guidance in hand.

Everything not on the critical list stays autonomous. This selective escalation —
[human-in-the-loop done right](/blog/human-in-the-loop-ai-agents/) — is the entire reason a hive can
run for a long stretch without babysitting: it interrupts you precisely when it should, and never
otherwise. It's also the model's primary safety rail — the policy is the control surface, so you
tighten or loosen it by editing the prompt.

## How a single request travels

Putting the four jobs together, here's the life of one instruction:

1. You tell the orchestrator a goal in plain language.
2. It reads the **roster**, decomposes the goal, and **routes** task specs to the right agents'
   inboxes.
3. Agents work in isolated sessions. When one needs something, it messages another through its outbox;
   the router delivers it.
4. The orchestrator **adjudicates** the routine questions, answering or re-routing, keeping the floor
   moving.
5. If something critical comes up, it **escalates** to the approvals queue and waits for your call.
6. Every step is committed to the hive's git repo and written to an append-only log, so the whole
   episode is auditable and replayable.

{% img "note-2" %}

## What makes it robust

A few properties keep the orchestrator from being a single point of failure:

- **The mechanism is dumb and reliable.** Routing, commits, and the queue work even if the
  orchestrator makes a poor call — a bad route is recoverable because it still flows through
  single-writer files and serialized commits.
- **Idempotent message handling.** Each agent tracks a cursor of what it has already processed, so a
  message is acted on exactly once. Re-seeing a handled message is a no-op.
- **Escalation is fail-safe.** When in doubt — a hop cap hit, an addressing edge case — the system
  routes to the human rather than guessing. The default is "ask," not "act."

If you want the design rationale behind these choices,
[the best way to coordinate AI coding agents](/blog/coordinating-ai-coding-agents/) lays out the
single-writer and single-committer principles the orchestrator depends on.

## The orchestrator's interface

In v0.1.6, Michael's interface expands significantly. His sidebar becomes a full Command Center: a
Tasks tab gives him a kanban board to track work across agents with dependency links; a Triggers tab
collects everything that wakes the hive without you — schedules first among them — so you can
pre-program recurring directives and the floor stays active between your check-ins; an Activity tab
shows real token and dollar cost per agent drawn from transcript files; and a GitHub Issues section
in the Floor tab lets him receive and route repo issues directly. The orchestrator is the same agent —
the harness simply gives him better tools.

## FAQ

**Can I run without an orchestrator?** You can run agents without one, but then you're the
orchestrator — assigning work and relaying messages by hand. The GOD agent exists to take that role
off your plate.

**Where does the orchestrator "live"?** It's a fixed, always-on agent in the corner office (Michael's
room, naturally), with a reserved desk. It boots with the hive and runs alongside the workers as just
another `claude` process — a special one.

---

Munder Difflin's [GOD orchestrator](https://munderdiffl.in/#how) routes, adjudicates, and escalates for a whole hive of Claude Code
agents — on your own machine, with a full audit trail. [Download Munder Difflin](https://munderdiffl.in/#install)
to put one in charge of your floor; it's free and open source.

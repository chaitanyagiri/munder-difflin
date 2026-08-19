---
title: "Can Claude Code Agents Talk to Each Other?"
description: "Can Claude Code agents talk to each other? By default they report to their launcher — but a small coordination layer lets them message peer-to-peer."
date: 2026-06-04
category: concepts
categoryLabel: Concepts
type: Non-technical
primaryKeyword: "can claude code agents talk to each other"
secondaryKeywords: ["inter-agent messaging", "ai agent communication", "claude code agents"]
tags: ["Concepts", "Multi-Agent", "Claude Code", "Getting Started"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "Can Claude Code agents talk to each other?"
    a: "Not by default. A Claude Code agent can spawn subagents, but those subagents only report their result back to the agent that launched them — there is no built-in peer-to-peer channel. To get true agent-to-agent communication you add a thin coordination layer, usually a file-based message system that a router delivers between agents."
  - q: "How do two AI agents send messages without a server?"
    a: "Each agent writes a message as a single file into its own outbox, and a coordinating process moves that file into the recipient's inbox. No broker, no socket — just files and atomic renames. It is durable, auditable, and conflict-free because every file has exactly one writer."
  - q: "What stops two agents from messaging back and forth forever?"
    a: "Two things. First, only certain message types expect a reply — a request, query, or proposal — while an inform or done is terminal and must not be answered. Second, every message carries a hop count, so a thread that bounces too many times is capped before it can loop."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p><strong>Can Claude Code agents talk to
each other?</strong> Not out of the box — a Claude Code agent can spawn <strong>subagents</strong>,
but they only report back to whoever launched them. There is no built-in peer-to-peer channel. Add a
thin <strong>coordination layer</strong> — file-based mailboxes plus a router that delivers messages —
and agents can message each other directly, escalate to a human, and stay <strong>auditable</strong>.
That is exactly how a multi-agent harness turns several lone sessions into one team.</p></div>

It's a fair question, and the honest answer has two halves. By default, no — Claude Code agents don't
talk to each other. But the gap is small, and once you close it a team of agents can coordinate as
naturally as coworkers passing notes. Here's the plain-English version of what's missing and how to
add it.

## The default: subagents report up, not across

A [Claude Code agent](/blog/what-are-claude-code-agents/) is a running session with a goal and tools.
It can spawn **subagents** — short-lived helpers that fan out a piece of work in parallel. That sounds
like agents talking to each other, but it isn't quite. A subagent only does one thing when it
finishes: it hands its result back to the agent that launched it. The flow is strictly **parent to
child and back again**, like a manager delegating a task and reading the report.

What that flow can't do is let two *peer* agents — two top-level sessions you started independently —
discover each other and trade messages. Agent A has no address for Agent B. There's no shared inbox,
no bus, no "send this to whoever owns the auth module." Each session lives in its own world.

For a single task that's fine. The moment you want several agents working a project together — a
researcher feeding a builder, a reviewer flagging a fix, an orchestrator handing out assignments —
you need them to actually communicate. So you add a layer.

## The coordination layer: mailboxes and a router

The most reliable way to let agents talk turns out to be almost boringly simple: **files**. Each agent
gets a folder with an `inbox/` and an `outbox/`. To send a message, an agent drops a single JSON file
into its own outbox. A coordinating process — call it the router — scans every outbox on a tick, and
moves each message into the right recipient's inbox. The recipient reads it at the start of its next
turn and moves it to a `done/` folder so it's never processed twice.

That's the whole mechanism. No Redis, no RabbitMQ, no daemon to babysit. The "infrastructure" is a
directory and the `rename` syscall. We unpack the design in
[atomic file mailboxes for agents](/blog/atomic-file-mailboxes-for-agents/), but the headline
properties are what make it hold up:

- **Durable.** Messages are files. If a process crashes mid-run, nothing already written is lost — the
  router picks up where it left off.
- **Auditable.** Every message and every delivery is a file the coordinator commits to git, so you can
  read back exactly who said what, in order. (That works because a
  [single committer owns the repository](/blog/single-committer-git-pattern/).)
- **Conflict-free.** Each file has exactly one writer, and delivery is an atomic rename. Agents can be
  busy at the same time without locks or races.

The one rule that keeps it clean: **never write into another agent's folder.** You only ever write to
your own outbox; the router does the routing. Single-writer-per-file is what makes the whole thing
safe under concurrency.

{% img "note-1" %}

## What's actually in a message

A message isn't just free text — it carries a little structure so the receiving agent knows what's
expected of it. In practice each message names:

- **who it's for** — another agent, the orchestrator, everyone (`broadcast`), or a human,
- **a speech act** — is this a `request`, a `query`, a `proposal`, an `inform`, an `agreement`, a
  `refusal`, or a `done`?
- **a subject and body** — the actual content, and
- **a thread id** — so a back-and-forth stays grouped as one conversation.

The speech act is the quiet hero. It encodes intent, and intent is what prevents chatter from spiralling.
Only a `request`, a `query`, or a `proposal` expects a reply. An `inform` or a `done` is **terminal** —
you do not answer it. That single convention is what stops two polite agents from "thanks!" / "you're
welcome!"-ing each other into an infinite loop. As a backstop, every message also carries a **hop
count**, so even a misbehaving thread is capped before it can run away.

## Talking to the orchestrator — and to you

Peer-to-peer isn't the only direction that matters. Two special addresses round out the system.

The first is the **orchestrator** (in our hive, the GOD agent). Anything ambiguous, cross-cutting, or
needing sign-off goes to it rather than getting hashed out between peers. It hands out assignments,
owns the shared plan, and is the one process allowed to commit — which is exactly why coordination
stays coherent instead of fragmenting into side conversations. We cover that role in
[how the GOD orchestrator works](/blog/how-the-god-orchestrator-works/).

The second is **you**. A message addressed to a human doesn't land in an agent's inbox at all — the
router diverts it to an approvals queue for a person to answer, and the answer comes back as a normal
message. That's how an agent reaches a human for the genuinely critical calls without anyone having to
watch a terminal, the same loop we describe in
[keeping a human in the loop](/blog/human-in-the-loop-ai-agents/).

{% img "note-2" %}

## Memory is a slower kind of talking

There's one more channel that's easy to miss: **shared memory.** Messages are how agents coordinate in
the moment; memory is how they coordinate across time. When each agent writes durable facts to a notes
file and those notes are mined into a [searchable semantic memory](/blog/semantic-memory-for-ai-agents/)
the whole team can query, an agent can effectively "hear" what a teammate learned an hour ago without a
message ever being sent. Fast lane: the mailbox. Slow lane: the shared memory. A good team uses both.

## So — can they talk?

Yes, with a caveat worth repeating: not on their own. A single Claude Code agent and its subagents form
a manager-and-helpers tree, not a conversation. But the missing piece is small — mailboxes, a router,
a handful of speech-act rules, and a hop cap — and once it's in place, independent agents coordinate
like a real team: requesting work, reporting `done`, escalating to an orchestrator, and pinging a human
only when it truly matters. That shift, from isolated sessions to a coordinated crew, is the entire
point of [the best way to coordinate AI coding agents](/blog/coordinating-ai-coding-agents/).

## FAQ

**Can Claude Code agents talk to each other out of the box?** No. An agent can spawn subagents, but
they only return their result to the agent that launched them. There's no native peer-to-peer channel
between two independent sessions — you add a coordination layer to get one.

**Do I need a message broker like Redis or RabbitMQ?** No. The most robust approach is file-based:
each agent writes messages to its own outbox, and a router moves them to recipients' inboxes via atomic
renames. It's durable and auditable with zero extra infrastructure.

**How do agents avoid talking in circles?** Speech acts and hop counts. Only requests, queries, and
proposals expect a reply; informs and dones are terminal. And every message carries a hop count, so a
thread is capped before it can loop forever.

**How does an agent reach a human?** It sends a message addressed to a human (or flagged as needing a
human). The router diverts it to an approvals queue instead of an inbox, a person answers, and the
reply comes back to the agent as a normal message.

---

Munder Difflin runs exactly this system: a hive of Claude Code agents that message each other through
atomic file mailboxes, escalate to [a GOD orchestrator](https://munderdiffl.in/#how), and ping you only
for the calls that matter — every envelope visible on a live office floor.
[Download Munder Difflin](https://munderdiffl.in/#install) to watch your agents actually talk to each
other; it's free and open source.

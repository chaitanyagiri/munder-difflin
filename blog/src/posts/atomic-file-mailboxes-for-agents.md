---
title: "Atomic File Mailboxes: How Agents Message Each Other"
description: "Can Claude Code agents talk to each other? Yes — the outbox-router-inbox design that lets agents message safely using plain files and atomic renames."
date: 2026-05-31
category: internals
categoryLabel: Internals
type: Technical
primaryKeyword: "can claude code agents talk to each other"
secondaryKeywords: ["ai agent messaging", "agent mailbox", "inter-agent communication"]
tags: ["Internals", "Messaging", "Multi-Agent", "Claude Code"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "Can Claude Code agents talk to each other?"
    a: "Yes. Each agent has an outbox it writes to and an inbox it reads from; a router process moves messages between them. The agents never write into each other's folders, so messaging is safe even with many agents running at once."
  - q: "Why use files for agent messaging instead of a message queue?"
    a: "Files plus atomic renames give you durability, auditability, and crash-safety for free, with no broker to run. One JSON file per message, delivered by rename, is simpler and more robust than a shared log every agent appends to."
  - q: "What stops two agents from messaging each other forever?"
    a: "Only requests, queries, and proposals obligate a reply; informational messages are terminal. Every reply increments a hop count, and past a cap the exchange is escalated to a human instead of looping."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>Yes,
<strong>Claude Code agents can talk to each other</strong> — and the safest way is plain files. Each
agent writes to its own <code>outbox/</code>; a <strong>router</strong> drains it and delivers each
message into the recipient's <code>inbox/</code> by <strong>atomic rename</strong>. One JSON file per
message, never a shared log. The result is durable, auditable, crash-safe messaging with no broker and
no write conflicts.</p></div>

"Can Claude Code agents talk to each other?" is one of the first questions people ask when they move
past a single session. The answer is yes — but *how* they talk is where most designs go wrong. Let a
shared chat file be appended by every agent and you've built a multi-writer conflict. The robust
approach is a mailbox: outbox, router, inbox, with atomic file operations underneath. Here's the whole
design.

## The shape: outbox → router → inbox

Every agent gets a private workspace, and two of the folders in it are for messaging:

```
agents/<agent-id>/
  inbox/         # messages delivered TO me — one JSON file each
  inbox/.done/   # messages I've handled (kept for audit, not deleted)
  outbox/        # messages I want to SEND — the router drains these
  outbox/.sent/  # archived after delivery, so they're never reprocessed
```

The flow is one direction at a time:

1. To send, an agent writes a single JSON file into its **own** `outbox/`.
2. A **router** — one coordinating process — scans every outbox, reads each message, and delivers it
   into the recipient's `inbox/`.
3. After delivery, the router moves the original from `outbox/` into `outbox/.sent/` so it's never
   sent twice.
4. The recipient reads its `inbox/` at the start of its next turn, acts on each message, and moves the
   handled ones to `inbox/.done/`.

The critical rule sits underneath all of it: **an agent only ever writes into its own directory.** It
never reaches into another agent's inbox. Delivery is the router's job. That single-writer discipline
is what makes the whole thing safe under concurrency — no two processes touch the same file. (It's the
same principle behind [the single-committer git pattern](/blog/single-committer-git-pattern/).)

## Why atomic renames matter

Here's the subtle part. If the router wrote a message into an inbox with a normal "open, write bytes,
close," a reader scanning the inbox at the wrong moment could pick up a half-written file and choke on
invalid JSON.

The fix is an **atomic rename**: write the message to a temporary filename first, then `rename` it
into its final place. On every mainstream filesystem, rename within a directory is atomic — the file
either isn't there or is there *complete*. A reader never sees a partial message. There's no lock, no
coordination, no window of inconsistency.

```
write  inbox/<id>.json.tmp-9f3a   ← may be partial mid-write
rename inbox/<id>.json.tmp-9f3a → inbox/<id>.json   ← appears atomically, whole
```

This one trick is why files beat a naive shared log. A log every agent appends to is a multi-writer
race; a directory of atomically-renamed files is conflict-free by construction.

{% img "note-1" %}

## The message itself: speech acts, not free text

A message isn't just a blob of text — it carries intent. The design borrows the one genuinely useful
idea from decades of agent-communication research, the **speech act**, and drops the rest:

```jsonc
{
  "id":            "2026-05-30T14-03-11-123Z-a1b2",  // unique, time-sortable
  "conversation":  "conv-7f3",                        // groups a thread
  "in_reply_to":   "<prev message id> | null",
  "from":          "agent.researcher",
  "to":            "agent.coder | god | broadcast",
  "act":           "request | inform | propose | query | agree | refuse | done",
  "subject":       "short human-readable summary",
  "body":          "the details",
  "hops":          3,             // increments per reply; capped to kill loops
  "requires_reply": true,
  "needs_human":   false,
  "created_at":    "ISO-8601"
}
```

An agent writing a message only has to supply the meaningful fields — `to`, `act`, `subject`, `body`,
and optionally a `conversation` to thread it. The harness fills in the `id`, the authoritative `from`
(taken from the owning outbox directory, so an agent can't spoof another's identity), the `hops`, and
the timestamps.

The `act` field is what makes coordination tractable. It tells the recipient — and the router —
whether a reply is even expected.

## Anti-livelock: how the conversation ends

Two agents told to "coordinate" will, without guardrails, message each other forever. Three rules stop
that:

- **Only some acts obligate a reply.** `request`, `query`, and `propose` expect an answer. `inform`
  and `done` are *terminal* — replying to them is exactly how a loop starts, so the protocol forbids
  it.
- **Hops are capped.** Every reply increments the `hops` counter. Past a fixed cap, the message is
  flagged for a human instead of being delivered again — a livelock fuse.
- **Delivery is idempotent.** Each agent keeps a cursor of the last message id it processed, so
  re-seeing a message is a no-op. Combined with moving handled messages to `inbox/.done/`, an agent
  can't accidentally act on the same request twice.

These are small rules with a big payoff: the messaging layer can be busy and still provably converge.

{% img "note-2" %}

## Broadcast and escalation

Two special addresses round out the system:

- **`broadcast`** delivers a copy to every agent except the sender — useful for "I'm taking ownership
  of the auth module, don't touch it."
- **`human`** (or any message flagged `needs_human`) doesn't go to an inbox at all. The router diverts
  it to an approvals queue for a person to answer. This is how an agent reaches *you* for the genuinely
  critical calls, and it's the same mechanism the orchestrator uses to escalate — covered in
  [the best way to coordinate AI coding agents](/blog/coordinating-ai-coding-agents/).

## Why this design holds up

Step back and the properties fall out for free:

- **Durable.** Messages are files. A crash mid-run loses nothing already written; the router picks up
  where it left off.
- **Auditable.** Every message and every delivery is a file, and the coordinating process commits the
  changes to git — so you can read back exactly who said what, in order.
- **Brokerless.** There's no Redis, no RabbitMQ, no daemon to keep alive. The "infrastructure" is a
  directory and the `rename` syscall.
- **Conflict-free.** Single-writer-per-file plus atomic renames means concurrency is safe without
  locks.

It's almost boring, which is the point. The most reliable inter-agent messaging is the kind with the
fewest moving parts.

## FAQ

**Does the router poll or watch the filesystem?** A simple poll on a short interval is both cheaper and
more robust than filesystem-watch APIs, which have well-known quirks across platforms. The router
scans every outbox on a tick, delivers what it finds, and goes back to sleep.

**Can an agent message itself?** It can, but there's rarely a reason to. The interesting traffic is
agent-to-agent and agent-to-orchestrator.

---

Munder Difflin runs exactly this mailbox system inside [a hive the GOD orchestrator runs](https://munderdiffl.in/#how) — atomic
delivery, speech-act messages, hop caps, and a full git audit trail, all local.
[Download Munder Difflin](https://munderdiffl.in/#install) to watch envelopes fly between agents on
the office floor; it's free and open source.

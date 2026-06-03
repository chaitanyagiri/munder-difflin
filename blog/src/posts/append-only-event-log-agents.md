---
title: "An Append-Only Event Log for a Hive of Agents"
description: "How an append-only event log makes a multi-agent system debuggable and replayable: what to record, and why one JSON line per event beats a database."
date: 2026-06-01
category: internals
categoryLabel: Internals
type: Technical
primaryKeyword: "ai agent event log"
secondaryKeywords: ["event sourcing", "append-only log", "agent observability"]
tags: ["Internals", "Observability", "Multi-Agent", "Event Log"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What is an append-only event log in a multi-agent system?"
    a: "It's a file that only ever grows: every meaningful thing that happens — an agent spawns, a message routes, an item escalates — is recorded as one timestamped line, never edited or deleted. It becomes the system's ground-truth history for debugging and replay."
  - q: "Why one JSON object per line instead of a database?"
    a: "Line-delimited JSON (JSONL) is append-cheap, crash-safe, human-readable, and trivially tailable. Appending a line is a single, atomic-enough write; readers parse line by line and track their own position. You get observability with no schema migrations and no server."
  - q: "What should each event record?"
    a: "A timestamp plus a small, typed payload: the kind of event and the few fields that matter for it — who spawned, who messaged whom, what was escalated. Keep events small and factual; the value is in the sequence, not in any one fat record."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>An <strong>append-only event log</strong>
records every meaningful thing a hive does as one timestamped JSON line that's never edited or
deleted. It turns a multi-agent system from a black box into something
<strong>debuggable and replayable</strong>: you read the sequence back to see exactly what happened.
One JSONL file, written by the single committer, beats a database for this job — cheap to append,
crash-safe, and human-readable.</p></div>

When a hive of agents does something surprising, the first question is always "what actually
happened?" Without a record, you're guessing from terminal scrollback and vibes. The fix is the
oldest trick in distributed systems: write down everything, in order, and never change it. This post
covers what an append-only event log is, what to put in it, and why it's the backbone of multi-agent
observability.

## Append-only, in one sentence

An append-only log is a file you only ever add to. Each line is one event — a small, timestamped,
typed record of something that happened. You never go back and edit or delete a line. The log grows
forever (or until you rotate it), and its *order* is the truth: event N happened before event N+1,
always.

That immutability is the whole value. A mutable status table tells you the *current* state; an
append-only log tells you the *story* — how you got to the current state, step by step. For debugging
a system where many agents act concurrently, the story is what you need.

## One JSON object per line

The format that makes this practical is **JSONL** — one JSON object per line:

```jsonl
{"ts":1717286400123,"kind":"spawn","agentId":"researcher","name":"Researcher","isGod":false}
{"ts":1717286400456,"kind":"message","from":"researcher","to":"coder","act":"request","subject":"Need the schema","id":"…-a1b2"}
{"ts":1717286401789,"kind":"drain","agentId":"coder","count":1}
{"ts":1717286402111,"kind":"escalate","from":"coder","to":"human","subject":"Drop the users table?","id":"…-c3d4"}
{"ts":1717286402999,"kind":"approval","id":"…-c3d4","approve":false}
```

Why JSONL specifically:

- **Appending is cheap and safe.** Adding a line is a single write to the end of the file. There's no
  index to update, no row to lock, no migration to run.
- **It's tailable.** `tail -f` the file and you have a live activity feed. The same stream drives a UI
  activity panel in real time.
- **It's human-readable.** When something breaks, you `cat` the log and read it. No query language, no
  admin tool.
- **Readers track their own position.** Each consumer remembers how far it has read (a cursor) and
  picks up new lines from there. Multiple consumers, no coordination.

A database would give you indexes and queries you mostly don't need here, at the cost of a schema and a
server. For an audit/observability log, plain JSONL is the right amount of technology.

## What to record per event

The art is choosing events that are **small, typed, and factual.** Each line carries a `ts`
(timestamp) and a `kind`, plus only the fields that matter for that kind. In a hive, the events worth
logging are the coordination milestones:

- **`spawn`** — an agent was created (id, name, whether it's the orchestrator).
- **`message`** — a message routed between agents (from, to, act, subject, id).
- **`drain`** — an agent's inbox was drained at a lifecycle point (who, how many).
- **`escalate`** — an item was routed to the human-approval queue (from, subject, id).
- **`approval`** — a human resolved an escalation (id, approved or rejected).

Notice what's *not* there: no giant payloads, no full message bodies, no model outputs. The log is an
index of *what happened and when*, with ids that point at the fuller artifacts (the message files,
the memory). Keep each event a few fields wide and the log stays fast to write, cheap to store, and
easy to read. The value is in the sequence, not in any single fat record.

## Who writes it (and why that matters)

In a multi-agent system, the log is shared state — so the same discipline that protects every other
shared file applies: **one writer.** The agents don't append to the log directly. The coordinating
process (the harness's main process) records each event as it routes messages, spawns agents, and
resolves approvals, and it's the only thing that writes the file. That keeps the log free of
interleaved, half-written lines, and it pairs with the
[single-committer git pattern](/blog/single-committer-git-pattern/): each batch of coordination is
both appended to the log *and* committed, so the log's history and git's history line up.

## Replay and debugging

Here's where the log earns its keep. Because it's an ordered, immutable record, you can **replay** the
system's history:

- **Reconstruct any moment.** Walk the log up to event N and you know exactly what the hive knew at
  that point — who existed, what had been said, what was pending.
- **Find the divergence.** When the team did something wrong, you scan the log for the event where it
  went sideways — the misrouted message, the escalation that should have fired and didn't.
- **Audit decisions.** Every escalation and every human approval is in the log, so "who approved
  deleting that?" has a precise, timestamped answer.

This is the foundation of [debugging a multi-agent system](/blog/debugging-multi-agent-systems/): the
event log is the timeline you read first, before you dig into individual agents' terminals or message
trails. It's also what lets the office-floor visualization stay honest — the activity stream the UI
shows is the same event stream, not a separate, drift-prone narrative.

## Practical notes

A few things that keep an event log healthy:

- **Make events idempotent to read.** A consumer that re-reads a line it already processed should do
  nothing. Cursors plus immutable lines make this automatic.
- **Don't log secrets or huge blobs.** The log is plain text you'll read often and commit. Reference
  big artifacts by id; don't inline them.
- **Rotate if it grows unbounded.** For a long-running hive, cap the file (or roll it) so it stays
  readable — but never *edit* old entries; archive them.
- **Tail the end for "now."** Reading the last N lines is the cheap way to answer "what's happening
  right now?" without parsing the whole history.

## FAQ

**Is this event sourcing?** It's the same family of idea — derive state from an ordered log of events
— applied pragmatically. A full event-sourcing system rebuilds all state from the log; here the log is
primarily for observability and audit, with live state also held in files like the registry. You get
the debuggability benefit without committing to rebuild-everything-from-events.

**How is this different from logging to stdout?** Stdout is unstructured and ephemeral. A structured,
append-only JSONL file is queryable, replayable, and durable — you can read it weeks later and
reconstruct exactly what the hive did.

---

Munder Difflin records every coordination step to an append-only event log that drives
[the live activity feed](https://munderdiffl.in/#how) and makes a hive replayable — committed
alongside the rest of its state.
[Download Munder Difflin](https://munderdiffl.in/#install) to watch a hive you can actually audit;
it's free and open source.

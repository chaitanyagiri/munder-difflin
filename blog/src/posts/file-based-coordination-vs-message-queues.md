---
title: "File-Based Coordination vs Message Queues for AI Agents"
description: "Why a local agent hive coordinates through plain files, not Redis or RabbitMQ: the zero-ops wins, the real tradeoffs, and where files hit a ceiling."
date: 2026-06-04
category: internals
categoryLabel: Internals
type: Technical
primaryKeyword: "file-based agent coordination"
secondaryKeywords: ["agent message queue", "multi-agent communication", "redis vs files agents"]
tags: ["Internals", "Multi-Agent", "Architecture", "Claude Code"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "Why not just use Redis or RabbitMQ for agent messaging?"
    a: "Because a message broker is infrastructure you have to run, secure, and monitor — and for a local hive of a few dozen agents it buys you throughput and distribution you don't need, at the cost of debuggability you very much do. Plain files give you durable, human-readable, git-versioned coordination with zero ops. You reach for a broker when you outgrow a single machine, not before."
  - q: "Isn't file-based messaging slow?"
    a: "It's higher-latency than a push-based broker — you're bounded by how often you scan a directory or how fast a filesystem watcher fires, typically sub-second to a few seconds. For agent turns that take seconds to minutes, that latency is irrelevant. It would matter at thousands of messages per second; a supervised hive isn't operating there."
  - q: "How do you avoid two writers clobbering each other?"
    a: "Write each message as its own file (one writer per file, atomic create-then-rename), and funnel commits to shared state through a single committer. No two processes ever edit the same file, so there's no lock to contend and no torn write to recover from."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>A message broker like Redis or RabbitMQ is the
reflex for "how do agents talk?" — but for a <strong>local hive of a few dozen agents</strong>, plain
files win. One JSON file per message, append-only logs, a shared markdown board, and a
<strong>single committer</strong> give you coordination that's durable, human-readable, git-versioned, and
zero-ops. You give up push-latency and built-in fan-out — neither of which a supervised hive needs until
it leaves one machine. Files are the right default; a broker is what you graduate to.</p></div>

When you wire up your first multi-agent system, the instinct is to grab a message queue. It's what
backend services use to talk, so surely agents need one too. For a local, human-supervised hive, that
instinct is usually wrong. Here's the case for coordinating agents through plain files instead — and an
honest look at where that choice runs out.

## What "file-based coordination" actually means

It's not one trick; it's a few small, boring mechanisms that compose:

```text
hive/
  agents/
    pam/
      inbox/        one JSON file per incoming message
      outbox/       one JSON file per outgoing message
      memory.md     durable notes the agent appends to
      cursor.json   last-processed marker (exactly-once surfacing)
  board.md          shared plan, one scribe
  log.jsonl         append-only event log
```

Agents communicate by writing a message file into a peer's [inbox](/blog/atomic-file-mailboxes-for-agents/);
a router moves each outbox file to its recipient. Shared plans live in one markdown
[board](/blog/how-the-god-orchestrator-works/). History is an [append-only log](/blog/append-only-event-log-agents/).
Nothing here is a database or a daemon — it's files on disk, and that's the point.

## Why files beat a broker for a hive

**You can read it.** A message is a file you can `cat`. The whole system state is a directory you can
list. When something goes wrong, you debug by *looking* — no broker admin UI, no "drain the queue to see
what's stuck." For agents, whose behavior is already hard to inspect, legible coordination is worth a lot.

**It's durable by default.** Files survive a crash, a restart, a laptop sleep. There's no in-memory queue
to lose, no "did the broker persist that?" A message sits in the inbox until it's handled, full stop.

**It's version-controlled.** Put the hive in git and you get an audit trail for free: who said what, when,
diffable, replayable. You can time-travel the entire coordination history. No broker gives you that
without bolting on extra logging.

**It degrades gracefully.** If the UI crashes or the semantic index breaks, the files still work — agents
keep reading and writing. The coordination layer has no single runtime dependency that takes the whole
system down with it.

**It's zero-ops and local.** No broker to install, secure, monitor, or pay for. Everything stays
[on your machine](/blog/why-local-first-matters-for-ai-agents/), which is also a smaller attack surface.

## The honest tradeoffs

Files are not magic. Choosing them means accepting real limits:

- **Latency is pull, not push.** You learn about a new message by scanning a directory or waiting on a
  filesystem watcher — sub-second to a few seconds, versus a broker's instant push. Fine for turns measured
  in seconds; wrong for high-frequency streaming.
- **You build the semantics yourself.** Ordering, exactly-once delivery, and fan-out aren't free. A
  per-agent `cursor.json` gives exactly-once surfacing; a router gives delivery — but you wrote those. A
  broker ships them.
- **Concurrency needs a discipline.** Many writers to one file is a recipe for corruption. The fix is
  structural: one file per message (single writer), and a [single committer](/blog/single-committer-git-pattern/)
  for shared state like the board and the git history. Agents never contend; they just drop files.
- **It doesn't cross machines.** Files coordinate processes on one host. The moment your agents live on
  different boxes, you need something networked.

## When to actually reach for a queue

Use the decision, not the dogma. Files are right when your hive is **local, supervised, and dozens of
agents** — where debuggability, durability, and zero-ops dominate. Switch to a broker (Redis, RabbitMQ,
NATS, Kafka) when you genuinely need one of: **distribution** across machines or services, **high
throughput** (thousands of messages/second), **pub-sub fan-out** to many consumers, or **backpressure** at
scale. Those are real needs — they're just not the needs of a coding-agent hive on your laptop.

A useful hybrid, worth noting: files for *coordination* (mailboxes, board, log — the durable, inspectable
substrate) and a lightweight local socket for *live telemetry* where you do want push. That's exactly the
split a [hook shim](/blog/the-hook-shim-pattern/) makes — events stream over a Unix socket in real time
while the durable record stays in files.

## FAQ

**Doesn't a broker scale better?** Yes — that's its whole job. The question is whether you need that scale.
A supervised hive of dozens of agents trading messages every few seconds is nowhere near a broker's
problem domain, and pays for the scale it isn't using in ops and opacity.

**What about losing messages?** A file in an inbox is the message. It can't be lost to a process restart
because it was never in a process — it's on disk until something handles it and moves it. That's stronger
durability than a default in-memory queue.

**Can I migrate later?** Easily. Files give you a clean seam: the router that moves messages is the one
place that'd swap to a broker. Coordinate through files now; if you outgrow a single machine, change the
transport without rewriting the agents.

---

Munder Difflin coordinates a whole [hive of Claude Code agents](https://munderdiffl.in/#how) through plain
files — inboxes, a shared board, an append-only log, and a single committer — so the whole system is
durable, git-versioned, and debuggable by just looking.
[Download Munder Difflin](https://munderdiffl.in/#install) to run it locally; it's free and open source.

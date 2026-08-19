---
title: "Recovering From Agent Failures: Resilience Patterns for a Hive"
description: "How multi-agent systems survive partial failure: retry with stale-lock recovery, poison-message quarantine, hop-cap circuit breaking, idempotent handling."
date: 2026-06-04
category: internals
categoryLabel: Internals
type: Technical
primaryKeyword: "recovering from agent failures"
secondaryKeywords: ["multi-agent resilience", "ai agent failure recovery", "idempotent agent messaging", "fault tolerance ai agents"]
tags: ["Internals", "Concurrency", "Multi-Agent", "Messaging"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What happens when an AI agent in a multi-agent system fails?"
    a: "In a well-built hive, a single failure stays local. A crashed step doesn't take down the router; a malformed message is quarantined instead of retried forever; a runaway loop is dropped by a hop cap; and shared state is protected by retries so one stalled write doesn't block the rest. The system keeps running and the failure is recoverable, not fatal."
  - q: "How do you make agent message handling idempotent?"
    a: "Make 'already handled' a cheap, observable fact. In a file-based hive, an agent moves a message to inbox/.done/ once handled, and re-reading a done message is a no-op. Delivery is at-least-once; handling is idempotent — so a duplicate or replayed message does nothing the second time. The same idea drives an append-only event log: re-reading a line you've already processed changes nothing."
  - q: "How do you stop AI agents from looping forever?"
    a: "Put a circuit breaker on the message path. Every message carries a hop count; once it exceeds a cap, the router drops it and logs the drop rather than letting two agents ping-pong indefinitely. It's a blunt instrument on purpose — it guarantees termination, and the dropped, logged message tells you where to look."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>In a multi-agent system, <strong>partial
failure is the default</strong>, not the exception — a crashed committer, a contended lock, a malformed
message, a routing loop. Resilience isn't avoiding those; it's making each one <strong>local,
recoverable, and idempotent</strong>. A handful of small patterns do most of the work: <strong>retry with
backoff + stale-lock recovery</strong> for shared writes, <strong>quarantine</strong> for poison messages,
a <strong>hop-cap circuit breaker</strong> for runaway loops, <strong>idempotent handling</strong> so
replays are no-ops, and <strong>error isolation</strong> so one bad step never takes down the loop.</p></div>

Run one agent and failures are simple: it works or it doesn't. Run a *hive* of them sharing files and a
message bus, and you inherit the unglamorous reality of distributed systems — things fail halfway, two
writers collide, a message arrives twice or malformed, a conversation loops. The goal isn't a system that
never fails; it's one where any single failure is contained and the team keeps moving. Here are the
patterns that get you there, grounded in how a real [multi-agent harness](/#what) handles each.

## Partial failure is the default

The mental shift is to stop treating failure as exceptional. With many agents writing files concurrently
and a router draining their outboxes, on any given tick *something* can be mid-write, locked, or garbage.
A resilient design assumes that and answers four questions up front: when a shared write collides, then
what? When a message won't parse, then what? When a conversation loops, then what? When one step throws,
does the whole loop die? Good answers to those four are most of fault tolerance.

## Make shared writes survivable

The hive commits all coordination to one git repo with a [single committer](/blog/single-committer-git-pattern/).
That removes interleaved writes, but the committer can still race itself or inherit a lock from a crashed
run. So the commit isn't a single shot — it's a small retry loop with backoff and **stale-lock recovery**:

```ts
// src/main/hive.ts — commit under contention
for (let attempt = 0; attempt < 5; attempt++) {
  this.clearStaleLock(root);                 // a crashed run? clear a >10s-old index.lock
  const commit = this.git(['commit', '-q', '-m', message], root);
  if (commit.ok) return;
  if (/nothing to commit/i.test(out)) return;        // benign — done
  if (/index\.lock/i.test(commit.err)) {             // contended — back off and retry
    sleepSync(50 * (attempt + 1));
    continue;
  }
  return;  // a non-lock failure: bail quietly; the next mutation retries
}
```

Three resilience ideas are packed into those lines. **Backoff:** each retry waits longer (`50 * (attempt+1)`
ms), so a transient collision clears instead of hammering. **Stale-lock recovery:** a `.git/index.lock`
older than ten seconds is from a committer that died, so it's safe to remove — otherwise one crash would
wedge the repo forever. And **graceful give-up:** a non-lock error doesn't throw or block; it returns,
because the *next* mutation will stage and commit the same pending changes anyway. Nothing is lost by
bailing early.

{% img "note-1" %}

## Don't choke on a poison message

A file-based mailbox will eventually contain a half-written or malformed JSON file. The naive router
reads it, throws, and — if it retries the same file — spins on it forever. The fix is to **quarantine**:

```ts
try {
  const msg = this.normalize(JSON.parse(read(full)), id);
  this.routeMessage(msg);
  renameSync(full, join(outbox, '.sent', f));        // archive, don't reprocess
} catch {
  renameSync(full, join(outbox, '.sent', `bad-${f}`)); // quarantine so we don't spin on it
}
```

A message that won't parse is moved aside with a `bad-` prefix and the router moves on. One corrupt file
can't stall the bus, and the quarantined file is still on disk for you to inspect. (Successful messages
get archived too — moved out of the outbox so they're never routed twice.)

## Circuit-break the runaways

Two agents can get into a polite infinite loop — A asks B, B asks A, forever. Protocol etiquette helps
(only `request`/`query`/`propose` expect a reply; `inform`/`done` are terminal), but you still want a hard
backstop. Every message carries a **hop count**, and the router drops anything past the cap:

```ts
if (msg.hops > HOP_CAP) {
  this.appendLog({ kind: 'drop', reason: 'hop-cap', from: msg.from, to: msg.to, id: msg.id });
  return;
}
```

It's deliberately blunt: it guarantees the conversation terminates. And because the drop is *logged*, a
runaway leaves a breadcrumb instead of a silent hang — you can read the log and see exactly which thread
ran away.

{% img "note-2" %}

## Idempotent by construction

The cheapest way to survive duplicates and replays is to make re-handling a no-op. In the hive, an agent
moves a message to `inbox/.done/` once it's handled, and the protocol is explicit: *re-reading a message
you already moved to `.done/` is a no-op — don't reprocess.* Delivery is **at-least-once**; handling is
**idempotent**. So a redelivered message, a crash-and-resume, or a curious re-read all do nothing the
second time. The same property underwrites the [append-only event log](/blog/append-only-event-log-agents/):
each consumer tracks how far it has read, and re-reading a line it already processed changes no state.
Idempotency turns "did this run twice?" from a bug into a shrug.

## Keep the loop alive, keep a record

The last pattern is error isolation: a failure in one step must not kill the whole system. The hive's
router wraps each pass so a single bad tick can't bring it down —

```ts
try { this.routeOnce(); } catch { /* keep the loop alive */ }
```

— and lifecycle handlers are written to "never crash" on a best-effort path. Pair that with two recovery
affordances and you can always get back to a known state: the **append-only `log.jsonl`** lets you replay
the system's history to find exactly where it diverged, and **agent archival** means closing an agent
keeps its memory and history intact rather than deleting them — a stopped agent is recoverable, not gone.
This is the same timeline you'd reach for when [debugging a multi-agent system](/blog/debugging-multi-agent-systems/);
resilience and debuggability come from the same record.

## A resilience checklist

For any multi-agent system you build:

1. **Retry shared writes** with backoff, and recover stale locks — never let one crash wedge shared state.
2. **Quarantine** unparseable messages instead of retrying them forever.
3. **Cap the hops** on your message path so conversations can't loop infinitely.
4. **Make handling idempotent** — "already done" should be a cheap, observable fact (a moved file, a cursor).
5. **Isolate failures** so one thrown step doesn't take down the loop.
6. **Keep an append-only record** so any state is reconstructable and any agent is recoverable.

None of these are exotic — they're the boring distributed-systems hygiene that turns a flaky pile of
agents into a system you can trust to run unattended. Build them in once, at the
[orchestration layer](/#how), and every agent inherits them for free.

Want to see these patterns in a hive you can actually watch recover? You can
[download Munder Difflin](/#install) free — it's open source, and the whole coordination layer is right
there to read.

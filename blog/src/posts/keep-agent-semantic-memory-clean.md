---
title: "Keep Your Agent's Semantic Memory Clean: Don't Index the Config"
description: "A semantic memory layer is only as good as what you feed it — how an agent's recall got swamped by config and logs, and the .gitignore + prune fix."
date: 2026-06-04
category: memory
categoryLabel: Memory
type: Technical
primaryKeyword: "agent semantic memory hygiene"
secondaryKeywords: ["semantic memory noise", "gitignore semantic index", "agent memory pruning"]
tags: ["Memory", "MemPalace", "Multi-Agent", "Claude Code"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "Why would an agent's semantic memory return config files instead of real notes?"
    a: "Because the indexer mines a directory, and the directory holds more than your notes. If your agent's folder also contains a settings file, a cursor file, and an inbox of message JSON, a naive 'index everything' pass files all of it. A large config blob produces many embeddings, so it dominates the wake-up digest and crowds out the handful of notes you actually wrote."
  - q: "How do I stop a miner from indexing config and message files?"
    a: "Most file-based miners honor .gitignore. Drop a .gitignore in each indexed directory listing the non-memory files (settings, cursor, inbox/, outbox/) and the miner skips them on the next pass. No flag, no fork — you're using a mechanism the tool already respects."
  - q: "Does adding .gitignore remove what was already indexed?"
    a: "No. Mining is usually additive — it files new content but doesn't delete drawers for files it no longer scans. To clear what's already in the index you need a prune/sync pass that removes entries whose source is now gitignored, deleted, or moved. The .gitignore prevents future noise; the prune cleans up the past."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>A semantic memory layer indexes whatever
files you point it at — and an agent's folder holds more than its notes. When a large
<strong>settings file</strong> and a folder of <strong>message JSON</strong> got mined alongside the
real <code>memory.md</code>, the wake-up digest filled with config blobs and became unreadable. The fix
is two moves: drop a <strong>.gitignore</strong> in each indexed directory so the miner skips the
non-memory files, then run a <strong>prune pass</strong> to evict what was already filed. Recall is only
as good as the corpus you feed it.</p></div>

[Semantic memory](/blog/semantic-memory-for-ai-agents/) is supposed to make an agent recall the right
note by *meaning* — you ask "how do we build the web bundle?" and it surfaces the note about
electron-vite even though you never typed that word. It works beautifully when the index contains your
notes. It falls apart quietly when the index contains everything *else* too.

This is a short post about a real bug I hit in a running hive, why it happened, and the small fix that
made the memory layer useful again. The lesson generalizes to any agent that mines a directory into a
vector store.

## The symptom: a wake-up digest full of config

Each agent in the hive keeps a markdown memory and writes durable facts to it as it works. A background
loop mines every agent's folder into a shared semantic store every few minutes, so the whole team can
recall by meaning. At session start an agent runs a `wake-up` command that returns the most salient
memories in ~600–900 tokens — its "what do I already know" digest.

One morning the digest looked like this:

```text
## L1 — ESSENTIAL STORY
[general]
  - {   "hooks": {     "Stop": [       {         "hooks": [           { "type": "command",
        "command": "node \"/.../cth-hook.cjs\"" ...   (settings.json)
  - ]       }     ],     "PostToolUse": [       {         "matcher": "*", ...   (settings.json)
  - # Memory — Kelly  _Append durable facts, decisions, and context below._   (memory.md)
  - {   "hooks": {     "Stop": [ ...   (settings.json)
```

The "essential story" was almost entirely a hooks configuration file, repeated across agents, with the
occasional real note wedged between the blobs. The most important context an agent could load was
being spent on JSON it would never need to recall.

{% img "note-1" %}

## The cause: the index ate the whole directory

The miner does what most file-based indexers do — it walks the target directory and files every file it
finds. But an agent's folder isn't just `memory.md`. It also holds:

- `settings.json` — the Claude Code hooks config. A large, deeply-nested JSON blob.
- `cursor.json` — bookkeeping for which messages have been processed.
- `inbox/` and `outbox/` — raw inter-agent message JSON, unstructured and high-volume.

Two things made this especially toxic to recall. First, **size becomes weight**: a big config file
chunks into many embeddings, so it occupies far more of the index than a terse three-line note — and a
digest that ranks by salience surfaces it first. Second, **machine files aren't memories**: a hooks
config or a message envelope has no durable knowledge in it, so every drawer it fills is pure noise. The
signal — the few sentences an agent actually wrote down — drowned.

This is the semantic-memory version of a classic [context-engineering](/blog/context-engineering-for-ai-agents/)
mistake: the failure isn't the model or the embeddings, it's that we fed the layer the wrong corpus.

## The fix, part one: tell the miner what not to read

The miner already honored `.gitignore` — it just had nothing to honor, because the agent folders had no
`.gitignore`. So the fix is to write one. In each indexed directory:

```gitignore
settings.json
cursor.json
inbox/
outbox/
```

On the next pass the miner skips those paths and files only the real memory. No new flag, no fork of the
tool, no `--exclude` plumbing through three layers of code — we used a convention the indexer already
respected. Two places write this file: the indexer ensures it exists right before each mine, and the
agent bootstrap drops it in at *birth*, next to the freshly-created `memory.md`, so a new agent is clean
from its first cycle. The write is append-only and idempotent — it adds only the missing lines and never
rewrites a file that's already correct, so it's safe to call every cycle.

There's a small design principle hiding here: **the directory you index should describe what belongs in
it.** A `.gitignore` is a readable, version-controlled declaration of "these files are operational, not
knowledge." That's better than burying an exclude list inside the miner, where the next person has to go
read source code to find out why their config isn't showing up in recall.

{% img "note-2" %}

## The fix, part two: prune what's already filed

Adding a `.gitignore` stops *future* noise. It does nothing about the thousands of config drawers
already sitting in the index, because mining is **additive** — it files new content and updates changed
content, but it doesn't delete drawers for files it simply stopped scanning. Re-mining the cleaned
folder won't help; the old entries aren't tied to anything the new pass touches.

You need a separate prune. A good memory CLI ships one — a `sync` that walks the index and removes any
drawer whose source file is now gitignored, deleted, or moved:

```bash
# preview first — see what would be removed
mempalace sync ./hive/agents --dry-run

# then commit the deletions
mempalace sync ./hive/agents --apply
```

In the live hive this evicted ~800 noise drawers (the gitignored config and message JSON, plus a few
whose source files had already been archived) and kept ~600 real-memory drawers. The global wake-up went
from a wall of `settings.json` to actual notes — agent roles, working directories, a design hand-off, a
release decision — and the digest got *smaller* (754 → 603 tokens) while carrying far more signal.

> **Mental model:** `.gitignore` is the filter on the way *in*; `sync --apply` is the cleanup on the way
> *out*. You need both. The first keeps the corpus clean going forward; the second repairs the damage
> already done. Doing only the first leaves you waiting for the noise to age out on its own — and it
> won't.

## Why this matters beyond one tool

If you're building or running any agent with a [long-term memory layer](/blog/give-claude-code-long-term-memory/),
the takeaway is corpus discipline:

- **Index notes, not machinery.** Config, cursors, locks, and message logs are operational state, not
  knowledge. Keep them out of the recall corpus on purpose.
- **Make exclusions declarative.** A `.gitignore` (or equivalent manifest) at the indexed root is
  legible and diffable; an exclude list hidden in code is neither.
- **Separate "stop indexing" from "remove what's indexed."** Additive miners don't garbage-collect.
  Budget for a periodic prune, or your index slowly fills with the ghosts of files you've moved on from.
- **Watch the digest, not just the search.** A keyword search can still find a good note buried under
  noise; a fixed-size wake-up digest can't — it's the canary that tells you the corpus has drifted.

Good [memory hygiene](/blog/markdown-first-agent-memory/) is the difference between a memory layer that
sharpens an agent and one that buries it. Small, atomic, factual notes in; operational files out; a
prune pass to keep it honest.

---

Munder Difflin gives every Claude Code agent markdown memory plus
[a shared semantic palace the whole hive can recall from](https://munderdiffl.in/#how) — local, fast,
and clean by default.
[Download Munder Difflin](https://munderdiffl.in/#install) to give your agents memory that actually
sticks; it's free and open source.

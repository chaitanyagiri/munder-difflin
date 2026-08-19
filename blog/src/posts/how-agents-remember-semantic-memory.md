---
title: "How AI Agents Remember: Semantic Memory in a Hive"
description: "A code-grounded guide to how AI agents remember — the MemPalace mine loop, per-agent wings, and wake-up digest that give a Claude Code hive shared recall."
date: 2026-06-04
category: memory
categoryLabel: Memory
type: Technical
primaryKeyword: "how ai agents remember"
secondaryKeywords: ["semantic memory mempalace", "ai agent memory", "claude code memory"]
tags: ["Memory", "MemPalace", "Multi-Agent", "Claude Code"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "How do AI agents remember between sessions?"
    a: "They write durable facts to a plain-markdown memory file, and the harness mines that file into a shared semantic index — so any agent can recall it by meaning in a later session, even after its context window is wiped."
  - q: "What is MemPalace?"
    a: "MemPalace is the CLI-driven semantic memory layer Munder Difflin uses: one shared palace on disk, a wing per agent, mined from each agent's memory.md and queried with `mempalace search` and `mempalace wake-up`."
  - q: "Do agents manage the search index themselves?"
    a: "No. The harness re-mines each changed memory.md every few minutes; agents just write notes and later run `mempalace search` or `wake-up` to recall — there's no database to administer and no MCP server to stand up."
  - q: "What happens if MemPalace isn't installed?"
    a: "Nothing breaks. The semantic layer degrades to a no-op and agents fall back to reading their markdown memory directly — the fast path is an upgrade, not a dependency."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>An agent's working memory — its context
window — is wiped at the end of every session. So agents "remember" in two moves: they write durable
facts to a plain-markdown file, and the harness <strong>mines</strong> that file into a shared
semantic index. Later, any agent recalls by <strong>meaning</strong> with <code>mempalace search</code>
or boots with a <code>wake-up</code> digest. This is the hands-on version, grounded in the real code in
<code>src/main/memory.ts</code> — the mine loop, the per-agent wings, and the gotchas we hit
making it not hang.</p></div>

If you've read [what semantic memory is and why markdown-first beats a heavy database](/blog/semantic-memory-for-ai-agents/),
this is the companion that shows the machinery actually working. No new theory — just the moving parts,
the exact commands, and the small decisions that make shared recall reliable in
[a coordinated hive of Claude Code agents](/blog/coordinating-ai-coding-agents/).

## The shape: one palace, many wings

The whole thing lives in one file — `src/main/memory.ts`, a `MemoryManager` running in the Electron
main process. It's deliberately **CLI-only** (no MCP server): the harness keeps a single shared
*palace* on disk under the harness home, and points every agent's `MEMPALACE_PALACE_PATH` at it. When
an agent is spawned, that env var (plus `MEMPALACE_EMBEDDING_MODEL`) is merged into its environment, so
the agent's own `mempalace` CLI hits the shared store automatically.

Inside the palace, each agent gets its own **wing** — addressed by its agent id (`--wing <id>`). This
buys two properties at once:

- **Private authorship.** Each agent only ever writes its own `memory.md`, which keeps the
  [single-writer rule](/blog/single-committer-git-pattern/) intact — no two agents clobber the same file.
- **Shared recall.** A query can scope to one wing *or* sweep the whole palace. So the researcher's
  notes are recallable by the coder later, with nobody copy-pasting context.

That second property is the entire reason a hive beats a lone agent on memory: knowledge accumulates in
one place and everyone draws from it.

## Mining: how a note becomes searchable

Agents don't touch the index by hand. A background **mine loop** does it for them. From the real code,
`MINE_INTERVAL_MS` is `180_000` — so every **three minutes** the manager walks
`hive/agents/*`, looks at each `memory.md`, and mines the ones that changed:

```bash
mempalace mine <agentDir> --wing <id> --agent <id>
```

The "ones that changed" part matters. The loop keeps a `lastMined` map of each agent's `memory.md`
modification time and **skips files whose mtime is unchanged** — so it doesn't reload the embedding
model to re-index notes that haven't moved. Write a durable fact to your markdown, and a few minutes
later it's searchable by the whole team, with zero extra steps on your part. (This is also why
`PROTOCOL.md` tells agents *"your memory.md is mined automatically — you don't run mine yourself."*)

Two robustness details worth copying if you build something similar:

- **Re-mining is safe.** MemPalace dedups, so mining the same notes again is idempotent. If a mine
  exits non-zero, the loop simply drops that agent from `lastMined` so the next tick retries it.
- **stdin is closed.** The child is spawned with stdin ignored, because the CLI can prompt — and a
  spawned process waiting on a prompt nobody answers hangs forever.

### Why we don't run `mempalace init`

This is the kind of detail you only learn by hitting it. The obvious bootstrap is `mempalace init`,
but it ends in an interactive `Mine now? [Y/n]` prompt that `--yes` doesn't cover — so a spawned child
would hang on it indefinitely. The fix in `memory.ts` is to **skip init entirely** and let the first
`mempalace mine` lazily create the palace (downloading the local embedding model once, on first run).
One less moving part, and no hang.

{% img "note-1" %}

## Recall: `search` and `wake-up`

With notes mined, an agent recalls in two ways — both plain CLI calls it runs itself:

```bash
mempalace search "how do we build the web bundle?" --results 5
mempalace search "build quirks" --wing dwight-abc123   # scope to one agent's wing
mempalace wake-up                                       # session-start digest
```

- **`search`** returns the most relevant notes *by meaning* — so "how do we build the web bundle?"
  finds a note about electron-vite even with no shared keywords. You can widen with `--results N` or
  narrow with `--wing <id>`.
- **`wake-up`** returns a short digest (a few hundred tokens) structured into an identity layer and an
  "essential story" of what matters across the team. It's meant to be read at the *start* of a task, so
  an agent boots with the hive's relevant knowledge already in hand instead of cold. `PROTOCOL.md`
  bakes this into the routine: run `wake-up` at the start of a task, `search` when you need to recall
  something specific.

Both calls run with a generous timeout and an empty stdin (again: never wait on a prompt). The reason
recall feels instant is that the expensive work — turning notes into vectors — already happened during
mining; at recall time you embed one short query and compare against pre-computed vectors.

## Graceful degradation is the safety net

The manager exposes a `status()` with four honest booleans — `available` (is the `mempalace` CLI on
PATH?), `enabled` (user setting), `active`, and `initialized`. It resolves the binary across the
shell PATH plus the usual `~/.local/bin`, Homebrew, and `/usr/local/bin` spots. And critically: **if
the CLI isn't installed, the whole layer is a silent no-op.** Agents fall back to reading their
markdown `memory.md` directly. The semantic index is a recall *accelerator* sitting on top of the
markdown — never a single point of failure that takes the memory down with it.

The embedding model is configurable (`minilm` by default for snappy local recall, `embeddinggemma`
when you want a heavier multilingual model). Everything runs locally — the palace, the model, the
mining — so memory stays [local-first](/blog/why-local-first-matters-for-ai-agents/) and private.

{% img "note-2" %}

## Why this matters for a hive (not just one agent)

A single agent with memory is useful. A *hive* with shared memory compounds:

- Your briefs get shorter every week, because the team stops needing context re-explained.
- Agents stop contradicting each other, because they recall the same shared decisions.
- A brand-new agent is useful immediately — it wakes up into the team's accumulated knowledge instead
  of a blank slate.

That shared, durable recall is also what lets the [GOD orchestrator](/blog/how-the-god-orchestrator-works/)
route well: it can recall what's been tried and who knows what, instead of asking you every time.

## FAQ

**Where does the palace actually live?** Under the harness home, in a `palace/` directory. Every
agent's `MEMPALACE_PALACE_PATH` points there, so it's genuinely one shared store, not a copy per agent.

**How often is memory refreshed?** Every three minutes the harness re-mines any `memory.md` that
changed since last time. Unchanged files are skipped, so it's cheap.

**Do I have to write notes a certain way?** Small, atomic, factual notes recall sharply; rambling ones
recall fuzzily. Good memory hygiene is the one thing that's on you — see
[why we built agent memory markdown-first](/blog/markdown-first-agent-memory/).

---

Munder Difflin gives every Claude Code agent plain-markdown memory plus a shared semantic palace the
whole [hive can recall from](/#how) — local, fast, and graceful when the index isn't there.
[Download Munder Difflin](/#install) to give your agents memory that actually sticks; it's free and
open source.

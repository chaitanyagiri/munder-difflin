---
title: "Launching Munder Difflin v0.3.3: A Built-in Monaco IDE and GitHub Copilot CLI Support"
description: "Munder Difflin v0.3.3 adds a full Monaco IDE — file tree, editor tabs, save, and side-by-side git diffs of your agents' changes — plus GitHub Copilot CLI as a first-class agent engine, our first community-contributed provider."
date: 2026-07-03
category: story
categoryLabel: Story
type: Non-technical
primaryKeyword: "munder difflin v0.3.3"
secondaryKeywords: ["monaco editor electron app", "built-in ide for ai agents", "github copilot cli agent", "review ai agent code changes", "copilot cli multi-agent", "git diff ai agent work"]
tags: ["Story", "Release", "Multi-Agent", "IDE", "Copilot", "Open Source"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What's new in Munder Difflin v0.3.3?"
    a: "Two headliners. First, a built-in IDE: a full-window Monaco editor (the same editor engine that powers VS Code) opens right over the office floor, with a file tree, editor tabs with dirty-state tracking, Cmd/Ctrl+S save, and a side-by-side git diff of every change your agents made against HEAD. Second, GitHub Copilot CLI joins the engine roster: hire a Copilot-powered agent onto the floor the same way you'd hire Claude Code, Codex, or Antigravity — our first community-contributed provider."
  - q: "What can the built-in IDE do?"
    a: "It's a real Monaco-based IDE in a toggleable overlay: browse the workspace file tree, open files in tabs, edit with full syntax highlighting, and save with Cmd/Ctrl+S. The left rail lists git CHANGES — click any changed file to see a read-only side-by-side diff against HEAD, which is exactly what you want for reviewing what an agent just did. Monaco is fully self-hosted inside the app (no CDN), and all file and git access goes through the main process — the renderer holds no direct filesystem access."
  - q: "How does GitHub Copilot CLI work as an agent engine?"
    a: "Copilot runs in its documented non-interactive print mode: the harness spawns `copilot -p \"<prompt>\" -s --allow-all-tools --no-ask-user`, optionally with `--model` (Claude Sonnet 4.5 by default, GPT-5.4, or auto) and `--resume` for session continuity. Auto-approval flags are gated behind the same floor-wide auto-mode toggle as every other engine. It authenticates through your existing GitHub Copilot login — no new API key."
  - q: "Can a Copilot agent receive hive mail like Claude Code agents do?"
    a: "Not yet, and we'd rather be honest about it: Copilot's print mode exits after each turn and has no hook bridge, so a Copilot worker can't be woken to drain an inbox. Mail routed to it bounces back to the GOD orchestrator, which re-routes or handles it. Copilot workers are great for dispatched, self-contained tasks; hive-aware engines like Claude Code remain the best orchestrators."
  - q: "Do I need a new API key for Copilot?"
    a: "No. Munder Difflin drives the `copilot` CLI you already log into with your GitHub account — same as it drives your existing Claude Code, Codex, or Antigravity subscriptions. If the CLI isn't installed, the harness offers the official installer (npm install -g @github/copilot)."
  - q: "Do I still get everything from v0.3.2 and earlier?"
    a: "Yes — v0.3.3 is additive. Realtime Michael (Talk mode), the three v0.3.1 engines (OpenCode, Crush, pi.dev) with BYOK keys and local LLMs, selectable engines, the integrations registry and secret broker, Slack-spawned workers, the Agent Gallery, MemPalace shared memory, the Command Center, schedules, observability, and the circuit breaker all remain functional and shipping."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p><strong>Munder Difflin v0.3.3</strong> ships two things people kept asking for. A <strong>built-in IDE</strong>: a full-window <strong>Monaco editor</strong> (the engine inside VS&nbsp;Code) that opens right over the office floor — file tree, editor tabs, <strong>Cmd/Ctrl+S</strong> save, and a <strong>side-by-side git diff</strong> of every change your agents made. And <strong>GitHub Copilot CLI</strong> as a first-class agent engine — hire a Copilot-powered agent onto the floor next to Claude&nbsp;Code, Codex, Antigravity, OpenCode, Crush, and pi.dev, riding your existing GitHub login. It's also our <strong>first community-contributed provider</strong>. Free, open source, local-first.</p></div>

Your agents write a lot of code. Until today, *reading* what they wrote meant alt-tabbing to your
own editor — a context switch away from the floor where the work actually happened.

## A real IDE, one click over the floor

v0.3.3 adds an **IDE button to the title bar**. Click it and a full-window IDE slides over the
office — the same overlay pattern as the fullscreen terminal, so nothing about the floor, terminals,
or voice changes underneath.

It's built on **Monaco**, the editor engine that powers VS Code, and it's the real thing:

- **A git CHANGES rail.** The left side lists every file your agents have touched. Click one and you
  get a **read-only, side-by-side diff against HEAD** — the fastest way to answer "what did Jim
  actually change?" before you bless it.
- **A file tree + editor tabs.** Browse the workspace, open files in tabs with dirty-state dots,
  edit with full syntax highlighting, and save with **Cmd/Ctrl+S**. A late fix in this release also
  guards against a subtle race: keystrokes typed *while* a save was in flight can no longer be
  silently lost.
- **Local-first, properly.** Monaco is fully self-hosted inside the app — no CDN, workers bundled by
  the build. And the renderer never touches your disk directly: every file read, write, and git
  call goes through the main process over the same audited IPC bridge the rest of the harness uses.

The workspace root snapshots from your selected agent (or the orchestrator), so the IDE opens
exactly where the work is happening.

{% img "note-1" %}

## GitHub Copilot CLI joins the hive

The engine roster grows to **seven**: Claude Code, OpenAI Codex, Antigravity (Gemini), OpenCode,
Crush, pi.dev — and now **GitHub Copilot CLI**.

Hire a Copilot agent the way you'd hire any other: pick **Copilot** in the Add Agent picker (or say
it to Michael in Talk mode). Under the hood the harness drives Copilot's documented non-interactive
print mode:

```
copilot -p "<your brief>" -s --allow-all-tools --no-ask-user [--model claude-sonnet-4.5]
```

- **Your subscription, no new keys.** It authenticates through the GitHub login you already use for
  Copilot. If the CLI is missing, the harness offers the official `npm install -g @github/copilot`.
- **Model picker included** — Claude Sonnet 4.5 (Copilot's default), GPT-5.4, or `auto`, with the
  command line always editable.
- **The same safety posture.** Copilot's auto-approval flags are gated behind the floor-wide
  auto-mode toggle, exactly like Claude's `bypassPermissions` or Codex's sandbox bypass.
- **Session resume** rides on Copilot's `--resume` when a prior session id is known.

One honest caveat, by design: Copilot's print mode **exits after each turn** and exposes no hook
bridge, so a Copilot worker can't be woken up to drain hive mail — anything routed to it bounces
back to the GOD orchestrator for re-routing. Copilot agents shine on dispatched, self-contained
tasks; hive-aware engines remain the best orchestrators. We'd rather ship the integration that's
true than claim a drain path that isn't there yet.

### Our first community-contributed engine

The Copilot adapter arrived as [PR #101](https://github.com/chaitanyagiri/munder-difflin/pull/101)
from **[Anas Khan (@anxkhn)](https://github.com/anxkhn)** — the first provider added by someone
outside the project, complete with a registry test and live verification against the real CLI.
That's exactly the kind of contribution the preset registry was designed for. Thank you, Anas. If
there's a CLI agent you want on the floor, [the door is open](https://github.com/chaitanyagiri/munder-difflin/blob/main/CONTRIBUTING.md).

{% img "note-2" %}

## Get it

**[Download v0.3.3](https://github.com/chaitanyagiri/munder-difflin/releases/latest)** for macOS,
Windows, or Linux — or clone and `npm run dev`. Free, MIT-licensed, local-first, and everything
from v0.3.2 and earlier — Talk mode, the Agent Gallery, MemPalace memory, the Command Center —
still ships.

If Munder Difflin is useful to you, a
[star on GitHub](https://github.com/chaitanyagiri/munder-difflin) is the single biggest way to
help it reach more people.

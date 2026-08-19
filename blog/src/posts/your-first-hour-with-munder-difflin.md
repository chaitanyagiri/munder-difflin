---
title: "Your First Hour With Munder Difflin"
description: "A minute-by-minute walkthrough of your first hour with Munder Difflin: install, the onboarding wizard, your first brief to Michael, watching the floor, approving your first escalation, and leaving a schedule running."
date: 2026-07-03
category: guides
categoryLabel: Guides
type: Non-technical
primaryKeyword: "munder difflin onboarding"
secondaryKeywords: ["getting started with munder difflin", "multi-agent harness tutorial", "first hour with a multi-agent harness", "god orchestrator first brief", "ai agent approval queue", "scheduled agent missions"]
tags: ["Guides", "Onboarding", "Getting Started", "Multi-Agent", "Local-First"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "How long does it take to get Munder Difflin running?"
    a: "About five minutes if you already have Node.js 18+ and one supported agent CLI installed. You clone the repo, run npm install and npm run dev, and the onboarding wizard walks you through the rest: harness home, registered repos, default command, and auto-mode. Signed macOS, Windows, and Linux builds are also available on the releases page."
  - q: "What do I need before installing Munder Difflin?"
    a: "Node.js 18+ with npm, a C/C++ toolchain for node-pty's native addon (Xcode Command Line Tools on macOS), and at least one supported terminal-agent CLI on your PATH — Claude Code, Antigravity, OpenAI Codex, OpenCode, Crush, pi.dev, or GitHub Copilot CLI. If a chosen engine's binary is missing, the harness runs its installer in the terminal and restarts into it automatically."
  - q: "Who is Michael and how do I give him work?"
    a: "Michael is the GOD orchestrator — the one agent you talk to. You type a brief into his terminal (or use the Talk voice channel with your own OpenAI Realtime key) and he adjudicates it: creating tasks, assigning them to workers, routing messages between inboxes, and escalating only critical items back to you. He seats himself in Michael's office automatically on first launch."
  - q: "Do I have to approve everything the agents do?"
    a: "No. The GOD orchestrator resolves routine requests itself so the system stays autonomous. Only critical items — spend, destructive operations, scope changes — land in the human-in-the-loop approvals queue for you to act on. A circuit breaker and per-agent token budgets guard the rest."
  - q: "How do I review what an agent actually changed?"
    a: "Open the built-in Monaco IDE from the title-bar IDE button. Its git CHANGES rail lists every modified file, and clicking one opens a read-only side-by-side diff against HEAD — the VS Code editor engine, fully self-hosted, with all filesystem and git access brokered through the main process. There's also a per-agent git tab with status, log, and commit graph."
  - q: "Can Munder Difflin keep working after I walk away?"
    a: "Yes — that's the point. The Triggers tab in the Command Center holds recurring missions with a label, interval, target agent, and body, plus a heartbeat that re-engages the floor when it goes quiet. It's local-first, so the office runs 24/7 on hardware you already own."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p><strong>You can go from zero to a running AI office in one hour.</strong> Minute 0: install. Minute 5: the <strong>onboarding wizard</strong> (harness home, repos, auto-mode, orchestrator engine). Minute 10: your <strong>first brief to Michael</strong>, the GOD orchestrator. Minute 20: watch avatars work the floor and open a real desk terminal. Minute 40: your <strong>first approval</strong> and a side-by-side diff in the built-in <strong>Monaco IDE</strong>. Minute 60: set a <strong>schedule</strong> and walk away — the office keeps working.</p></div>

<video controls preload="none" playsinline poster="/media/demo/intro-poster.jpg" style="width:100%; border-radius:12px; margin:12px 0 24px;">
  <source src="/media/demo/intro.mp4" type="video/mp4" />
</video>

Most tools ask you to learn them before they do anything. Munder Difflin is the other kind: within an hour you've briefed an orchestrator, watched agents work, approved a real change, and left the office running without you. Here's that hour, minute by minute.

{% youtube "", "Your first hour with Munder Difflin — full walkthrough" %}

## Minute 0 — Install

Two paths: grab a signed build (macOS, Windows, Linux) from the [releases page](https://github.com/chaitanyagiri/munder-difflin/releases/latest), or clone and run from source with `npm install && npm run dev`. You need Node.js 18+, a C/C++ toolchain for `node-pty`, and at least one supported agent CLI on your `PATH` — Claude Code, Antigravity, Codex, OpenCode, Crush, pi.dev, or GitHub Copilot CLI.

I won't repeat the details here; the [install and usage guide](/blog/how-to-install-and-use-munder-difflin/) covers prerequisites, troubleshooting, and the `node-pty` rebuild gotcha. Budget five minutes.

## Minute 5 — The onboarding wizard

First launch drops you into a short wizard, and the four choices it asks for are the actual shape of the product:

- **Harness home** — the folder where the hive lives: per-agent memory, mailboxes, the blackboard, the event log. Plain files in a local git repo, relocatable later.
- **Registered repos** — the codebases your agents will work on. This is what feeds GitHub issue ingestion and the CI watcher later.
- **Default command / auto-mode** — which agent CLI new hires run by default, and whether the floor runs in auto-mode (agents proceed without per-tool prompts; the approval gate still catches critical items).
- **Orchestrator engine** — Michael himself runs on a pluggable engine. Claude Code is the natural default, but the wizard lets you pick, and you can change it later.

Finish the wizard and you land on the floor: a pixel-art office, empty except for Michael, who seats himself in his office automatically.

{% img "note-1" %}

## Minute 10 — Your first brief to Michael

You don't manage the workers. You talk to one agent — the GOD orchestrator — and he runs the floor. Click into Michael's terminal and type a brief the way you'd brief a colleague: what you want, which repo, what "done" looks like.

Michael adjudicates. He creates tasks on the kanban, assigns them, and routes messages between agent inboxes. Workers you hire via **Add agent** each get a real CLI process in its own pseudo-terminal and, with the git-isolation toggle, their own worktree — so nobody collides on branches. How he decides what to route, resolve, or escalate is its own post: [how the GOD orchestrator works](/blog/how-the-god-orchestrator-works/).

A good first brief is small and self-contained: "read this repo and write a REPORT.md summarizing the architecture" beats "refactor everything" for hour one.

## Minute 20 — Watch the floor, then open a desk

Now the part that makes the product legible: the floor is not a decoration, it's the state of the system. Avatars walk to stations as they work. When the hive routes a message, an envelope flies from sender to recipient; escalations fly to the door. The cast is an affectionate parody of The Office, and every movement maps to a real event.

{% img "floor-view", "The floor mid-task: every movement maps to a real event." %}

Click any agent and you get their desk: the live terminal (you can type back into it), a sandboxed file browser, and a git tab with status, log, and commit graph. This is the moment the abstraction clicks — that avatar is a real `claude` process, and you're reading its actual stdout.

{% img "note-2" %}

## Minute 40 — Your first approval, and the diff

Sometime in the first hour, something lands in the approvals queue — a spend threshold, a destructive operation, a scope change. This is by design: Michael resolves routine requests himself and escalates only critical items, so the queue stays short and every item in it deserves your attention. (The philosophy behind that gate: [approving AI agents without babysitting them](/blog/human-in-the-loop-approving-ai-agents/).)

Before you click approve, look at the work. Hit the title-bar **IDE** button and the built-in Monaco editor — the VS Code editor engine, fully self-hosted — opens over the floor. The git CHANGES rail lists what changed; click a file for a read-only side-by-side diff against HEAD. Read the diff, approve the item, watch the envelope fly.

## Minute 60 — Leave it running

The last move of the hour is the one that changes your relationship with the tool: schedule something. The Command Center's **Triggers** tab takes a label, an interval, a target agent, and a mission body — "every morning, triage new GitHub issues," say — and a heartbeat re-engages the floor if it goes quiet. Last-fired and next-fired times are right there in the tab.

Close the laptop. It's local-first, so tomorrow the office is exactly where you left it — probably with mail in your queue. For patterns on what's worth automating, see [scheduling autonomous agent missions](/blog/scheduling-autonomous-agent-missions/).

## The hour, in one line

Install, answer four wizard questions, brief one agent, watch the floor, read one diff, set one schedule — and you've gone from "a CLI in a terminal" to "an office that works while you don't."

[Download Munder Difflin](https://github.com/chaitanyagiri/munder-difflin/releases/latest) — free, MIT-licensed, local-first — and if the first hour earns it, [a GitHub star](https://github.com/chaitanyagiri/munder-difflin) helps more people find it.

---
title: "How to Install and Use Munder Difflin"
description: "Install Munder Difflin on macOS, Windows, or Linux and put a hive of Claude Code agents to work on ambitious, long-horizon tasks — start to finish."
date: 2026-06-05
category: guides
categoryLabel: Guides
type: Technical
primaryKeyword: "how to install munder difflin"
secondaryKeywords: ["munder difflin download", "munder difflin app", "munder difflin tutorial"]
tags: ["Guides", "Getting Started", "Tutorial", "Claude Code", "Automation", "Video"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "Is Munder Difflin free?"
    a: "Yes. Munder Difflin is free and open source under the MIT license. Download a build for macOS, Windows, or Linux, or run it from source — there's no paid tier."
  - q: "Do I need Claude Code to use Munder Difflin?"
    a: "Yes. Munder Difflin coordinates real Claude Code sessions, so you bring your own Claude Code (the `claude` CLI on your PATH). Each agent runs a real `claude` process; the harness adds memory, messaging, and the GOD orchestrator on top."
  - q: "Can I leave it running for hours or days?"
    a: "Yes — that's the point. With auto mode on, agents run unattended and a GOD orchestrator routes work and escalates only the critical calls to you. Give an agent a persistent Goal and it keeps working a long-horizon task across many prompts while you're away."
  - q: "What platforms does it support?"
    a: "macOS, Windows, and Linux. Grab the matching installer (.dmg, .exe, or .AppImage) from the latest release, or build from source with Node 18+ in two commands."
  - q: "Is auto mode safe?"
    a: "Auto mode spawns agents with `--permission-mode bypassPermissions`, so they don't pause for file edits or shell commands. It's the right default for the unattended control-room experience, but it's a foot-gun on production repos. Keep it on for sandboxed or disposable working copies; turn it off (or drop the flag per agent) when you want to babysit."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>Install <strong>Munder Difflin</strong> by
downloading a build (macOS, Windows, or Linux) or running it from source with Node 18+. On first
launch you'll pick a harness home, add your repos, and confirm auto mode. Then you talk to
<strong>Michael</strong> — the <a href="/#how">GOD orchestrator</a> — spin up agents with a
<strong>Goal</strong>, and let the hive work <strong>ambitious, long-horizon tasks for hours or
days</strong> while you watch the floor.</p></div>

*Watch the 51-second setup walkthrough:*
<video controls preload="none" playsinline poster="/media/demo/setup-poster.jpg" style="width:100%; border-radius:12px; margin:12px 0 24px;"><source src="/media/demo/setup.mp4" type="video/mp4" /></video>

Most tools help you run a Claude Code agent. Munder Difflin helps you run a *team* of them —
unattended, coordinated, and aimed at the big jobs: a multi-day refactor, a migration, an
investigation that needs to grind overnight. This is the start-to-finish guide: install it, meet the
orchestrator, and put the hive to work on something ambitious.

## What Munder Difflin does best

Before the steps, the mental model — because it shapes how you'll use it. Munder Difflin wraps the
[Claude Code](https://claude.com/claude-code) terminals you already run as full agents, gives each
**long-term memory** and a **mailbox**, and puts a **GOD orchestrator** (named Michael) in charge —
the one agent *you* talk to. You describe intent; it routes work, lets agents message each other, and
escalates only the critical calls to you.

That design pays off most on **long-horizon work**. A single session loses steam (and context) on a
multi-hour task. A coordinated [hive that remembers](/blog/give-claude-code-long-term-memory/) can
keep going for hours or days — the [overnight, while-you-sleep](/blog/run-an-office-of-ai-agents/)
use case is exactly what it's built for. Keep that in mind as you set it up.

## Step 1: What you'll need

- **Node.js 18+** and npm.
- A **C/C++ toolchain** for `node-pty`'s native addon: Xcode Command Line Tools on macOS
  (`xcode-select --install`), `build-essential` on Linux, or the Visual Studio Build Tools on Windows.
  (If you download a prebuilt app instead of building from source, you don't need the toolchain.)
- **Claude Code** on your `PATH` — agents run the `claude` command by default. You bring your own
  Claude Code; Munder Difflin coordinates it.
- *Optional:* the semantic memory index for instant cross-session recall. The app works without it —
  plain-markdown memory still functions and the index degrades gracefully.

## Step 2: Install it

There are two paths. Pick whichever fits you.

### Option A — Download a build (easiest)

Grab the installer for your OS from the [download section](/#install) (it points at the latest
release):

| Platform | File |
|---|---|
| macOS | `Munder-Difflin-<version>-mac-universal.dmg` (Apple Silicon + Intel) |
| Windows | `Munder-Difflin-<version>-win-x64-setup.exe` (64-bit installer) |
| Linux | `Munder-Difflin-<version>-linux-x86_64.AppImage` |

Open the installer, launch the app, and skip to [first launch](#step-3-first-launch-the-onboarding-wizard).

### Option B — Build from source (two commands)

If you'd rather run the code directly (or you're on a platform you want to build yourself):

```bash
git clone https://github.com/chaitanyagiri/munder-difflin.git
cd munder-difflin
npm install        # postinstall rebuilds node-pty against Electron's ABI
npm run dev        # launches the app with hot reload
```

The `npm install` step rebuilds the native terminal addon for your machine. If `node-pty` ever fails
to load after an Electron upgrade, re-run `npm install` to rebuild it.

## Step 3: First launch — the onboarding wizard

The first time you open Munder Difflin, a three-step wizard sets up your control room:

1. **Harness home.** Pick a folder where the harness keeps its own files — agent metadata, logs, and
   any repos you create from inside the app. Something like `~/HarnessAgents` is a fine default; it's
   created if it doesn't exist. Think of it as the town hall: agent state is pinned here so sessions
   survive a restart.
2. **Your repos.** Add the existing project folders you want agents to work in. Each becomes a room on
   the floor, and multiple agents can share a repo. This is optional and you can add more later — but
   adding your main project now saves a step.
3. **Auto mode.** Confirm whether agents should run unattended (covered next). The default is on.

Finish the wizard and you land on the office floor. Michael — your orchestrator — boots into his
office automatically; give him a few seconds to clock in.

{% img "note-1" %}

## Step 4: Meet Michael, your GOD orchestrator

Michael is the **GOD agent**: he runs the floor, triages requests, assigns work, and escalates only
the critical calls to you. He's the agent you talk to.

To talk to any agent (Michael included), select them on the floor to open their panel, then use the
**command bar** at the bottom — type a message and hit Enter (or *send*). The bar has three modes:

- **free** — plain natural-language instructions (the default).
- **/skill** — invoke a Claude Code skill or slash command.
- **quick** — fast canned actions.

Talking to Michael in plain language is how you steer the whole team: describe a goal, and he
decomposes and routes it. That's the [orchestration model](/#how) in practice — you manage, he
delegates. (New to the idea? [How to run multiple Claude Code
agents](/blog/how-to-run-multiple-claude-code-agents/) covers why an orchestrator beats juggling tabs.)

## Step 5: Understand auto mode

Auto mode is what makes unattended runs possible. With it on, every agent is spawned with:

```text
claude --permission-mode bypassPermissions
```

That means Claude won't stop to ask before editing files or running shell commands — essential for a
"set it going and walk away" workflow. It's also a loaded foot-gun on a production repo, so:

- **Keep auto mode on** for sandboxed, disposable, or branch-isolated working copies — anywhere a
  mistake is cheap to undo. This is the right default for the control-room experience.
- **Turn it off** (or drop the flag for a single agent in the Add Agent dialog) when you want to
  babysit a sensitive repo and approve each tool call.

Either way, Munder Difflin keeps a **human-in-the-loop approvals queue**: even in auto mode, the GOD
agent escalates genuinely critical actions (spending real money, destructive operations, big scope
changes) for your sign-off, so unattended doesn't mean unsupervised.

## Step 6: Spin up your first agent

Click **Add agent** to open the spawn dialog. The fields:

- **Name** — the agent's handle (picking a character fills this in for you).
- **Folder** — the working directory. Pick one of your registered repos with a click, or browse to
  another.
- **Command** — defaults to `claude` (plus `--permission-mode bypassPermissions` in auto mode). Pick a
  **model** above (Sonnet, Opus, Haiku, or CLI default) — the harness restarts the agent on the new
  model if you change it later.
- **Description** — a short note on what this agent is for.
- **Goal (optional)** — *a long-running directive injected on every prompt.* This is the most
  important field for long tasks (more below).
- **Character & Color** — pick from the office cast and an accent.
- **Git isolation (optional)** — checking 'Git isolation (own worktree)' auto-creates a dedicated git
  checkout for this agent and tears it down when you kill it. Use this whenever two agents share the
  same repo so they work on separate branches without colliding.

Hit **spawn**. The agent appears as an avatar at a desk, provisioned in the hive with its own memory,
mailbox, and identity. You'll see it walk to a station and start working; envelopes fly desk-to-desk
when agents message each other.

## Step 7: Run an ambitious, long-horizon task

Here's where Munder Difflin earns its keep. To set a team working for hours or days:

1. **Give agents a persistent Goal.** The *Goal* field is injected into every prompt, so the agent
   keeps orienting toward the same long-running directive even as the conversation turns over. This is
   how a task survives across many cycles instead of drifting. Write it like a brief: *"Migrate the
   test suite from Mocha to Vitest, one directory at a time, keeping CI green after each."*
2. **Let Michael route the rest.** Tell the GOD orchestrator the high-level objective and let him
   assign sub-tasks across agents. You describe the *what*; the hive figures out the *who* and *when*.
3. **Scope each agent and let them coordinate.** Give each a clear role so they stay in their lane and
   hand off through mailboxes instead of colliding. Shared
   [long-term memory](/blog/give-claude-code-long-term-memory/) means what one agent learns, the next
   one inherits — knowledge compounds over a long run.
4. **Walk away.** With auto mode on, the team keeps going unattended. Check the approvals queue when
   you're back; the GOD agent only interrupts you for the critical calls.

This is the [run-an-office-of-agents-while-you-sleep](/blog/run-an-office-of-ai-agents/) workflow, and
the practical guardrails behind it are in [Claude Code automation while you
sleep](/blog/claude-code-automation-while-you-sleep/). Be honest with yourself about scope — bounded,
well-specified jobs go best.

{% img "note-2" %}

## Step 8: Use Michael's Command Center

Select Michael on the floor and open his panel — it's not a plain terminal. It's a control surface
with six tabs:

- **Terminal** — Michael's live session, plus a message queue so you can park tasks while he's working.
- **Floor** — the full agent roster with per-agent model selectors, a dispatch box (send a task to one
  agent or broadcast to all), and your registered repos. The **Enrich** toggle routes your queued
  messages through Dwight — a background prep assistant who gathers context and rewrites the prompt
  before Michael sees it.
- **Memory** — MemPalace semantic search plus full-text search across all hive files (board, tasks,
  agent memories) and a memory graph.
- **Activity** — live event log, the shared board, and real token + cost telemetry per agent (read
  directly from your Claude Code transcript files).
- **Tasks** — a dependency-aware kanban board. Add tasks with assignees, priorities, and `dependsOn`
  links; Michael and his team track status here.
- **Triggers** — every way the office wakes itself, starting with recurring missions. Set a label, interval (1h / 6h / 24h / weekly), and a directive
  body; the harness dispatches it to the target agent automatically, no human needed.

For long-running floors, the Triggers tab is the most powerful: set a '30-minute floor check' mission
pointing at Michael with a directive like 'Are all agents making progress? Re-engage anyone idle.' —
and the harness keeps the team moving even when you're away.

## Tips for best results

- **Scope beats ambition.** A precise Goal ("do X, in this order, with this definition of done") runs
  longer and cleaner than a vague one.
- **Use branch-isolated working copies.** Auto mode plus a throwaway branch is cheap to discard — and
  the 'Git isolation' checkbox in Add Agent automates this: each agent gets its own worktree
  provisioned and torn down for you.
- **Register your repos.** Pre-adding projects in onboarding (or later) makes spawning agents one
  click instead of a folder hunt.
- **Lean on memory.** Tell agents to write durable facts to their notes; the shared semantic palace
  turns those into instant recall for the whole hive.
- **Watch the floor early.** The visual office isn't a gimmick — seeing who's busy, idle, or blocked
  catches problems before they compound.

## Troubleshooting

- **`node-pty` fails to load after an update** → re-run `npm install` (the postinstall rebuilds the
  native addon against the current Electron ABI).
- **Agents won't start / "claude: command not found"** → make sure Claude Code is installed and on the
  `PATH` of the shell that launched the app.
- **Native build errors on `npm install`** → install your platform's C/C++ toolchain (Xcode Command
  Line Tools, `build-essential`, or VS Build Tools), then reinstall.
- **No instant recall** → the semantic memory index is optional; without it, markdown memory still
  works, just without the fast semantic search.

## Where to go next

- [How to run multiple Claude Code agents](/blog/how-to-run-multiple-claude-code-agents/) — the habits
  that keep a team from colliding.
- [Run an office of AI agents while you sleep](/blog/run-an-office-of-ai-agents/) — the long-horizon
  vision, with guardrails.
- [What is a multi-agent harness?](/blog/what-is-a-multi-agent-harness/) — the concept underneath it
  all.

---

That's the whole path from zero to a working hive. [Download Munder Difflin](/#install) — it's free,
open source, and local-first on macOS, Windows, and Linux — and put a team of agents on your next big
task.

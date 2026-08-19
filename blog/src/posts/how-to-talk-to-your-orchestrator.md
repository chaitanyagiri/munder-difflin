---
title: "How to Brief Your Orchestrator (So the Floor Actually Ships)"
description: "A practical guide to briefing Munder Difflin's GOD orchestrator: state the goal not the steps, set constraints and budgets, name the deliverable, and let Michael staff the floor. With bad-vs-good brief examples, mid-run steering, and Talk mode."
date: 2026-07-03
category: guides
categoryLabel: Guides
type: Non-technical
primaryKeyword: "how to brief an ai orchestrator"
secondaryKeywords: ["ai orchestrator prompts", "multi-agent task delegation", "god orchestrator briefing", "steering ai agents mid-run", "voice control ai agents", "ai agent approvals"]
tags: ["Guides", "Orchestration", "Multi-Agent", "Talk Mode", "Human-in-the-Loop"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What should a brief to an AI orchestrator contain?"
    a: "Four things: the goal (the outcome you want, not the steps), the constraints (what the agents must not touch, which repo, what conventions to follow), the budget (token caps and rough time expectations), and the deliverable (what artifact proves the work is done — a PR, a passing test suite, a document). Everything else — task breakdown, staffing, sequencing — is the orchestrator's job."
  - q: "Why shouldn't I tell the orchestrator the exact steps?"
    a: "Because step-by-step briefs turn a supervisor into a typist. Munder Difflin's GOD orchestrator exists to decompose work, assign it to the right agents, wire dependencies on the task board, and adjudicate results. If you pre-chew every step, you lose the parallelism and the routing — and you own every mistake in your own plan. State the goal and the definition of done; let it plan."
  - q: "How do I steer the orchestrator mid-run without killing agents?"
    a: "Munder Difflin has a mid-run steer and a graceful stop built on Claude Code hook returns, so you can redirect or halt an agent without killing its session. You can also type directly into any agent's terminal, message the orchestrator to re-plan, or use the circuit breaker's steer-constrain-stop ladder if something is looping or overspending."
  - q: "How do I ask the orchestrator for status?"
    a: "Ask it directly — 'what's the state of the floor?' — in its terminal or over Talk mode, where Michael reads the hive (tasks, board, memory, agents, activity) and answers out loud. Or read the surfaces yourself: the Command Center has a kanban Tasks tab, live fleet monitoring, token and cost telemetry, and an activity log."
  - q: "What is Talk mode in Munder Difflin?"
    a: "Talk mode (Realtime Michael, shipped in v0.3.2) is a low-latency voice channel to the GOD orchestrator over the OpenAI Realtime API. Press Talk and Michael listens, answers, and acts: he creates and assigns tasks, dispatches agents, spawns and kills workers, and speaks task completions the moment they land. Destructive verbs require a spoken echo-back confirmation, and the session runs under a live cost meter with a hard spend cap. It's bring-your-own OpenAI key."
  - q: "Does the orchestrator ask for my approval before risky actions?"
    a: "Yes. The GOD agent resolves routine requests itself and escalates only critical items — spend, destructive operations, scope changes — into a human-in-the-loop approvals queue you act on. In Talk mode, destructive actions additionally require a spoken echo-back confirmation with a distinct confirm token, never a bare yes."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>Your orchestrator is a manager, not a macro. A good brief has four parts: <strong>the goal</strong> (outcome, not steps), <strong>the constraints</strong> (repo, boundaries, conventions), <strong>the budget</strong> (token caps, rough time), and <strong>the deliverable</strong> (the artifact that proves "done"). Then <strong>let Michael staff it</strong> — he decomposes, assigns, wires dependencies, and escalates only spend, destructive ops, and scope changes to your approvals queue. Steer mid-run without killing sessions, ask for status in plain language, and do all of it <strong>by voice with Talk mode</strong> if typing feels slow.</p></div>

<video controls preload="none" playsinline poster="/media/demo/orchestrator-poster.jpg" style="width:100%; border-radius:12px; margin:12px 0 24px;">
  <source src="/media/demo/orchestrator.mp4" type="video/mp4" />
</video>

Munder Difflin puts one agent between you and the floor: the GOD orchestrator — Michael — who reads every request, decomposes it, routes work to the right agents, and escalates only critical items back to you. (The full mechanics are in [how the GOD orchestrator works](/blog/how-the-god-orchestrator-works/).) That design has one implication people keep missing: **the quality of what the floor ships is mostly the quality of your brief.**

Here's how to brief well.

## Rule one: state the goal, not the steps

The most common failure mode is treating the orchestrator like a very slow keyboard: "open file X, change function Y, then run Z." That works, but you've just done the planning yourself and hired a manager to be your typist.

Michael's job is decomposition. He turns a goal into tasks on a dependency-aware kanban board, assigns them to agents (each in its own git worktree, so nobody collides), and adjudicates the results. When you pre-chew the steps, you get no parallelism, no routing, and full ownership of every mistake in your own plan.

State the outcome and the definition of done. Let the plan be his problem.

## The four parts of a good brief

**1. The goal.** One or two sentences describing the end state. "Users can reset their password over email" beats "add a route, then a token table, then a mailer."

**2. The constraints.** What must not change, where the work lives, what conventions apply. Which repo (the floor works over your registered repos), which directories are off-limits, "follow the existing design tokens," "don't touch the migration history." Constraints are cheap to write and expensive to omit — this is [context engineering](/blog/context-engineering-for-ai-agents/) at the human layer.

**3. The budget.** Munder Difflin supports per-agent token budgets with live fleet monitoring, backed by a circuit breaker that nudges, constrains, then stops runaways. Say what the work is worth: "keep this under N tokens total" or "this is an overnight job, not a sprint." A budget in the brief becomes a budget on the floor.

**4. The deliverable.** Name the artifact that proves completion: a PR against main, a green test suite, a markdown report, a rendered page. "Done" without an artifact is a vibe; agents ship vibes enthusiastically.

{% img "note-1" %}

## Bad brief, good brief

**Bad:** "Fix the login bug."
No goal state, no repro, no deliverable. Michael will staff *something*, and you'll spend the review round discovering what he guessed.

**Good:** "Login fails with a 500 when the email has a `+` in it — repro is in issue #214. Goal: that case passes. Constraints: fix in the auth service only, don't touch the session store. Budget: one worker, small. Deliverable: a PR with a regression test."

**Bad:** "Refactor the settings page, and also while you're there improve performance and maybe update the docs."
Three goals in a trench coat. Split them — the task board handles dependencies; your sentence shouldn't have to.

**Good:** "Goal: the settings page uses the shared form components everywhere. Constraint: no visual changes — screenshots before/after should match. Deliverable: one PR. If you find perf problems, file them as tasks, don't fix them."

That last sentence is the pro move: telling the orchestrator what to do with *adjacent* discoveries, so scope stays fixed without discoveries getting lost.

## Let it staff

Don't specify which agent does what unless you have a real reason. Michael assigns work across the roster, and each hire can run a different engine — Claude Code, Codex, Antigravity, OpenCode, Crush, pi.dev, or GitHub Copilot CLI — so routing is part of the value. If you *do* care ("use the cheap local-model worker for the boilerplate"), say it as a constraint, not by micromanaging assignments.

{% img "note-2" %}

## Mid-run: steering, status, approvals

A brief is not a launch-and-pray. Three controls matter while the floor runs:

**Steering.** Munder Difflin has a mid-run steer and a graceful stop driven through Claude Code hook returns — you redirect an agent without killing its session. You can also type into any agent's terminal directly, or message Michael to re-plan: "drop the docs task, the API changed."

**Status.** Ask Michael in plain language — "what's the state of the floor?" — or read it yourself: the Command Center's Tasks kanban, live fleet monitoring, real token and cost telemetry, and the activity log.

**Approvals.** Michael resolves routine requests himself and escalates only critical items — spend, destructive ops, scope changes — into an approvals queue you act on. Answer those promptly; a stalled approval is a stalled floor. More on this pattern in [approving AI agents](/blog/human-in-the-loop-approving-ai-agents/).

## Briefing by voice: Talk mode

Everything above works typed into Michael's terminal. Since v0.3.2 it also works spoken. Press **Talk** and Realtime Michael (OpenAI Realtime API over WebRTC, bring-your-own key) listens and *acts*: he reads the hive, creates and assigns tasks, dispatches agents, spawns and kills workers — with every destructive verb gated behind a spoken echo-back confirmation, never a bare "yes." He speaks task completions the moment they land, and the session runs under a live cost meter with a hard spend cap and idle auto-disconnect.

The same brief discipline applies out loud. "Michael, goal: the changelog is updated for the release. Constraint: docs only. Deliverable: a commit on the release branch" is a complete voice brief. (Full details in the [v0.3.2 launch post](/blog/launching-munder-difflin-v0-3-2/).)

## The habit

Goal, constraints, budget, deliverable. Say it once, let Michael staff it, steer when reality changes, and answer your approvals. That's the whole skill — and it's the difference between a floor that looks busy and a floor that ships.

[Download Munder Difflin](https://github.com/chaitanyagiri/munder-difflin/releases/latest) and brief your first floor — and if it ships something, [a GitHub star](https://github.com/chaitanyagiri/munder-difflin) is appreciated.

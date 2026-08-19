---
title: "Review Agent Work Where It Happens"
description: "AI agents produce diffs faster than humans can review them, and alt-tabbing to an external editor breaks supervision flow. The case for review-in-place: Munder Difflin's built-in Monaco IDE puts a CHANGES rail and side-by-side diffs vs HEAD right on the office floor."
date: 2026-07-03
category: concepts
categoryLabel: Concepts
type: Technical
primaryKeyword: "review ai agent code changes"
secondaryKeywords: ["ai agent code review bottleneck", "review agent diffs in place", "built-in monaco ide", "supervising ai coding agents", "human in the loop code review", "multi-agent git workflow"]
tags: ["Concepts", "Code Review", "Monaco IDE", "Human-in-the-Loop", "Git"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "Why is code review the bottleneck in multi-agent coding?"
    a: "Because generation scaled and review didn't. A floor of CLI agents can produce diffs across several worktrees in parallel, but every change still has to pass through one human's judgment before it ships. The constraint on a supervised agent fleet is no longer how fast the agents write code — it's how fast you can read, verify, and accept what they wrote."
  - q: "What is review-in-place?"
    a: "Reviewing agent output inside the same tool where you supervise the agents, instead of alt-tabbing to an external editor. In Munder Difflin, a title-bar IDE button opens a built-in Monaco editor over the office floor: a git CHANGES rail lists what the agents touched, clicking a file shows a side-by-side diff against HEAD, and the file tree lets you open and edit anything with Cmd/Ctrl+S save. You never leave the app where the agents, terminals, and approvals live."
  - q: "Is the built-in IDE a full VS Code replacement?"
    a: "No, and it isn't trying to be. It's Monaco — the same editor engine VS Code uses, fully self-hosted with no CDN — scoped to the supervision loop: see what changed via the CHANGES rail, read the side-by-side diff vs HEAD, and make small corrections with editor tabs and Cmd/Ctrl+S. For deep multi-hour editing sessions your usual editor is still the right tool; for reviewing and touching up agent work, in-place is faster."
  - q: "How does the single-committer git pattern make review safer?"
    a: "In Munder Difflin, no agent ever runs git against the shared hive repo — agents write plain files to their outbox and one harness-owned committer does all the git operations. That prevents index.lock corruption from concurrent commits and gives you a serialized, auditable history. Combined with per-agent worktrees for code changes, it means the diff you review is exactly what one agent did, not an interleaving of several."
  - q: "Where do human approval gates fit into reviewing agent work?"
    a: "The GOD orchestrator resolves routine requests itself and escalates only critical items — spend, destructive operations, scope changes — into an approvals queue you act on. That's decision-level review. The IDE's diff view is code-level review. Together they cover both halves: you approve what the fleet is allowed to do, and you verify what it actually did, without leaving the app."
  - q: "Does the IDE give the renderer direct filesystem access?"
    a: "No. All filesystem and git access is brokered through the Electron main process over IPC — the renderer holds no fs or git access of its own. The diff comes from a main-process git bridge, saves go through the same brokered path, and a v0.3.3 fix ensures keystrokes typed during an in-flight save are never silently lost."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p><strong>Agents write diffs faster than you can review them</strong> — and every alt-tab to an external editor breaks the supervision loop you're supposed to be running. The fix is <strong>review-in-place</strong>: Munder Difflin v0.3.3 ships a <strong>built-in Monaco IDE</strong> (the VS Code editor engine, self-hosted) over the office floor — a <strong>git CHANGES rail</strong>, <strong>side-by-side diffs vs HEAD</strong>, a file tree, and <strong>Cmd/Ctrl+S</strong> edits — so you verify agent work where the agents actually are. Pair it with the <strong>single-committer git pattern</strong> (clean, serialized, reviewable history) and <strong>human approval gates</strong> (decision-level review), and the review bottleneck stops being the reason your fleet idles.</p></div>

Here's the uncomfortable math of running a floor of coding agents: generation scaled, review didn't. One [GOD orchestrator](/blog/how-the-god-orchestrator-works/) dispatching work to a handful of CLI agents in isolated worktrees can produce more diffs in an hour than most engineers review in a day. The agents aren't the bottleneck anymore. **You are.**

That's not an insult — it's the design constraint. A supervised fleet is only as fast as its slowest verification step, and for code, verification means a human actually reading the change. So the question worth engineering is: how do you make the reading step cheap?

## Alt-tabbing is where supervision goes to die

The default answer is "open the repo in your editor." It works, and it's also quietly terrible for this job.

When you supervise agents, you're running a loop: watch the floor, read an escalation, check what an agent changed, answer, move on. Every hop out to an external editor breaks that loop. You alt-tab, find the right window, find the right worktree (each agent has its own), pull up a diff, and by the time you've read it, the context that prompted the check — which agent, which task, what it claimed — has evaporated. Then you tab back and reconstruct it.

Multiply that by every agent, every task, all day. The cost isn't the seconds per switch; it's that switching makes review feel expensive, so you do less of it, so agent work merges less verified than it should. The bottleneck doesn't just slow you down — it degrades the quality of the supervision itself.

{% img "note-1" %}

## Review-in-place: the IDE comes to the floor

This is the problem the v0.3.3 built-in IDE exists to solve. A title-bar **IDE** button opens a full-window **Monaco** editor — the same editor engine VS Code runs on, fully self-hosted with no CDN — as an overlay on the office floor. The floor, the terminals, and everything else stay untouched underneath; you toggle in, review, toggle out.

The layout is built around the review loop, not general-purpose editing:

- **A git CHANGES rail** on the left lists exactly what changed in the workspace. This is the "what did my agents just do" view, one click from the floor.
- **Click a changed file** and you get a read-only **side-by-side diff vs HEAD** — the honest before/after, not a summary the agent wrote about itself.
- **A workspace file tree** below it opens any file for real editing, with **editor tabs**, dirty-state dots, and **Cmd/Ctrl+S** save. Spot a wrong variable name in review? Fix it there. No round-trip through another app, no "hey agent, please rename x to y" for a two-character change.

The workspace root snapshots from the selected agent's cwd (falling back to the GOD agent's, then the first agent's), so the IDE opens onto the code you were just looking at, not a generic project picker.

One architectural note that matters more than it sounds: **the renderer holds no filesystem or git access.** Every read, diff, and save is brokered through the Electron main process over IPC. The pretty editor window is just a view; the privileged operations happen in one audited place. And a v0.3.3 fix hardened the save path so keystrokes typed while a save is still writing are never silently dropped — a small thing, exactly the kind of small thing that erodes trust in an in-app editor if it's wrong.

{% img "note-2" %}

## The diff is only trustworthy because of how it was made

A side-by-side diff vs HEAD is only useful if HEAD means something. In a naive multi-agent setup — several agents committing to one repo — it doesn't: histories interleave, `index.lock` collisions corrupt state, and "what did agent B change" has no clean answer.

Munder Difflin avoids this with two structural choices. For the shared hive, **no agent ever touches git**: agents write plain files to their `outbox/`, the router delivers mail, and a single harness-owned committer performs every git operation — the [single-committer git pattern](/blog/single-committer-git-pattern/), which trades a theoretical bottleneck for a serialized, corruption-free, auditable history. For code, **each agent gets its own isolated worktree** (see [worktrees vs the hive](/blog/claude-code-git-worktrees-vs-hive/)), so the diff you review is one agent's coherent work, not a merge puzzle.

Review-in-place sits on top of that foundation. The CHANGES rail is legible *because* the git story underneath is disciplined.

## The other half: gates for decisions, diffs for code

Reading diffs is code-level review. But half of supervising agents is **decision-level** review: should this agent spend that much, delete that thing, expand that scope? The GOD orchestrator handles the routine traffic itself and escalates only critical items — spend, destructive ops, scope changes — into an approvals queue you act on. That's the [human-in-the-loop gate](/blog/human-in-the-loop-approving-ai-agents/), and it's deliberately the same shape as the IDE: the decision comes to you, in the app, with context attached.

Put together, the review story has two lanes and zero alt-tabs. Approvals catch the *should we* questions before damage happens; the IDE's diff rail catches the *what actually happened* questions before code merges. Both live where the agents live. The supervision loop stays unbroken, review stays cheap, and cheap review is review that actually happens.

Agents got fast. The winning move isn't reviewing less — it's moving review to where the work is. [Grab the latest release](https://github.com/chaitanyagiri/munder-difflin/releases/latest) and try the IDE button, and if the floor earns it, [a GitHub star](https://github.com/chaitanyagiri/munder-difflin) helps more people find it.

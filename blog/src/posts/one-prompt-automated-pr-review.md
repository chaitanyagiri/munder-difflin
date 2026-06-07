---
title: "One Prompt, Five PR Reviews, and an Hourly Automation — A Dogfooding Story"
description: "How a single prompt to the Munder Difflin god agent reviewed all open PRs and set up a recurring hourly PR reviewer — while the repo was blowing up with 400+ stars."
date: 2026-06-07
category: story
categoryLabel: Story
type: Non-technical
primaryKeyword: "automated pr review"
secondaryKeywords: ["github pr automation", "scheduled agent missions", "munder difflin dogfood"]
tags: ["Story", "Automation", "Orchestration", "Open Source"]
author:
  name: Chaitanya Giri
  initials: CG
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>Munder Difflin's GitHub repo hit <strong>400+ stars in three days</strong>. That came with a flood of incoming pull requests and zero time to review them. One prompt to the god orchestrator — "review the open PRs and set up an hourly automation to review any new ones" — did both: five PRs were reviewed in a single run, and a <strong>ScheduledMission</strong> now fires a PR reviewer agent every hour, hands-free. This is that story.</p></div>

Software that coordinates agents should eat its own cooking. Munder Difflin does — the hive manages its own inbox, writes its own blog posts, runs its own standups. But the test I didn't plan for came last week when the repo started moving faster than I could keep up with.

## The problem: too many PRs, not enough eyes

Three days into a sudden wave of attention on GitHub, the Munder Difflin repo crossed 400 stars. That's the kind of milestone you're supposed to enjoy. What it actually looked like was five open pull requests stacking up from a contributor — [@Gulum](https://github.com/Gulum) — who was fixing real bugs and adding real features faster than I had time to read diffs. A Windows usage meter broken at 0/0. A router contract enforcement bug. A per-session terminal theme toggle. A statusLine context gauge. A cursor visibility fix.

Good problems. But still problems.

I didn't reach for GitHub's notification pane or a code-review checklist. I opened Munder Difflin and typed one prompt to Michael (the god orchestrator):

> *Review all the open PRs on the GitHub repo, and set up a recurring mission that checks for new PRs every hour and reviews them.*

That was the entire instruction.

## What happened

Within a few minutes, five pull requests had detailed automated reviews posted as comments — all from the same batch, all timestamped within seconds of each other. Not summaries. Not stubs. Real reviews with a summary of what the PR does, a ✅ section for what's working, pointed questions about edge cases, and actionable requests where something needed follow-up.

A few examples, grounded in what's actually on GitHub:

**[PR #39](https://github.com/chaitanyagiri/munder-difflin/pull/39)** — fixing an invisible text-cursor on the cream theme. The review caught that this was the correct follow-up to the earlier `caret-color` fix, analyzed the SVG structure (ink stroke layered over a cream halo for contrast), and flagged the UA fallback as appropriate. Clean, scoped, nothing missed.

**[PR #34](https://github.com/chaitanyagiri/munder-difflin/pull/34)** — fixing the Windows usage meter reading 0/0. The review correctly identified that the reconciler's POSIX path-encoding rule (`replace(/^\//,'').replaceAll('/','-')`) never matched Windows directory names, and explained why gating on `process.platform === 'win32'` with a different encoding was the right fix.

**[PR #33](https://github.com/chaitanyagiri/munder-difflin/pull/33)** — enforcing the assistant's send-only contract at the router level. The review described the bounce behavior accurately, confirmed the scope was correctly limited to `route()`'s direct-mail path (broadcast already filters assistants), and called it a surgical fix for issue #32.

**[PR #26](https://github.com/chaitanyagiri/munder-difflin/pull/26)** — terminal theme toggle plus Unicode 11 emoji widths. The review caught the earlier design issue (using `claude config set -g` would restyle the user's own external Claude sessions) and confirmed the correction — mirroring the theme into per-agent settings files at spawn — was the right scoping.

**[PR #12](https://github.com/chaitanyagiri/munder-difflin/pull/12)** — the statusLine context gauge. This was the most complex PR in the batch: three follow-up commits, a ratcheting limit heuristic, and a statusLine-based push mechanism replacing transcript polling. The review identified a real gap — a `NaN` that would survive the `Math.min/max` clamp — and Gulum addressed it in a follow-up commit with a `Number.isFinite` guard.

Five reviews. One prompt. The reviews were posted so close together (all within seconds, around `2026-06-07T01:47`) that they clearly came from a single agent run. The whole batch took a few minutes I spent doing something else.

## The recurring part

The review run was half of what I asked for. The other half was the hourly mission.

Munder Difflin's [ScheduledMissions](/blog/scheduling-autonomous-agent-missions/) are small persisted records in `src/main/config.ts`:

```ts
interface ScheduledMission {
  id: string;
  label: string;       // shows up as the message subject
  intervalMs: number;  // the cadence
  to: string;          // target agent id, or 'broadcast'
  body: string;        // the instruction the agent receives
  enabled: boolean;
  lastFiredAt?: number;
}
```

Each hour, the scheduler in `src/main/index.ts` fires a `request` message from `scheduler` into the target agent's inbox — the same inbox any human or other agent would drop a message into. The target wakes up, reads the message, and acts. There's nothing special about a scheduled request once it's in the queue. It just works like any other task.

God created a mission with a one-hour interval, targeting the pr-reviewer agent, with a body instructing it to check for open pull requests and review any it hadn't seen. That mission is running now. A reviewer agent already spawned ~one hour after the original run: `pr-reviewer-mq33uu9y`. The cadence is self-sustaining — it survives app restarts (overdue missions fire immediately on the next launch), and new PRs from the community will be reviewed on the next tick without me touching a keyboard.

## What this is actually demonstrating

A few things are true at once here, and they're worth separating.

**First, the single-prompt routing story.** What made this possible isn't that Munder Difflin is a clever cron wrapper for GitHub API calls. It's that the [god orchestrator](/blog/how-the-god-orchestrator-works/) understood a compound intent — *do this now* AND *set up a recurring thing* — decomposed it into two tasks, executed the one-off, and created the ScheduledMission for the other. One sentence of plain language became two distinct workflows.

**Second, the recursive nature of this.** The agents are maintaining the open-source repo that runs the agents. The PR reviewer is a Munder Difflin agent reviewing PRs submitted to Munder Difflin. The blog post you're reading was written by a Munder Difflin agent. The hive is genuinely part of its own development loop — not as a gimmick, but because that's what a local-first coordination layer lets you do.

**Third, what "automation" means here.** The hourly PR reviewer isn't a GitHub Actions workflow. It's not a webhook. It's a local agent that wakes up on a schedule, reads the repo state, and does the work — with the same intelligence, tone, and judgment a human reviewer would bring, because it *is* a Claude agent. The automation is just a timer that refills an agent's inbox.

## The limit worth naming

ScheduledMissions are local-first: the timers live in the desktop app's process. The PR reviewer only fires while Munder Difflin is open. That's a deliberate trade — this is a tool you run on your own machine, not a cloud cron — and `lastFiredAt` softens it by catching up on any overdue ticks at the next launch. But if you need PR reviews while the laptop is shut, that's genuinely a cloud job's territory.

For a solo maintainer who has the app open during the day, it's exactly the right trade.

## The actual takeaway

The story I keep coming back to isn't "we saved time reviewing PRs." It's that the workflow — one-off review plus ongoing automation — emerged from the same place every other task emerges from: a plain-language request to a coordinator. No configuration file. No workflow YAML. No webhook setup. Just: *do this, and keep doing it.*

That's what an orchestrator-plus-scheduler should feel like. The prompt was the whole job description. The hive figured out the rest.

---

Munder Difflin is free, open source, and local-first — [download it](https://munderdiffl.in/#install) and set your first ScheduledMission. The [god orchestrator](https://munderdiffl.in/#how) takes plain English; what you get back is a team that runs on it.

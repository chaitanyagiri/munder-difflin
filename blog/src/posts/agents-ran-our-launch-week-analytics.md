---
title: "Our Agents Ran Our Launch-Week Analytics"
description: "Ten Reddit threads, a Product Hunt page, GitHub traffic and PostHog funnels — every comment read, cross-referenced, and reported by a hive of agents. The workflow, and how to point it at your own launch."
date: 2026-08-19
category: use-cases
categoryLabel: Use Cases
type: Non-technical
primaryKeyword: "ai agents launch analytics"
secondaryKeywords: ["analyze reddit comments with ai", "multi-agent research workflow", "launch retrospective automation", "product hunt analysis ai", "munder difflin use case"]
tags: ["Use Cases", "Research", "Launch", "Workflow", "Multi-Agent"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What did the agents actually analyze?"
    a: "Four channels in parallel: ten Reddit launch threads (every comment, including every nested reply), the full Product Hunt page (every comment plus the page's own data), GitHub traffic, and PostHog funnels. Each agent produced a structured report — a readable markdown brief plus a JSON file — and the orchestrator synthesized them into one picture."
  - q: "Why use multiple agents instead of one long session?"
    a: "Each channel is a full context window of raw material on its own. One agent per channel means each report is written by something that actually read every comment, not a skim. The orchestrator then works from the four distilled reports — which is exactly the fan-out-then-synthesize pattern hives are good at."
  - q: "Can I run this on my own launch?"
    a: "Yes — the recipe is at the end of the post. You need the raw threads saved locally (Reddit's JSON endpoints work), one agent per channel with a clear brief, a shared folder for reports, and one synthesis pass at the end. A weekend launch produces an evening of agent work."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>After launch week we had ten Reddit
threads deep in comments, a Product Hunt page, and analytics dashboards — far more than any human
was going to read honestly. So we didn't. <strong>A hive of agents read all of it</strong>: one
agent per channel, structured briefs in, markdown + JSON reports out, one synthesis at the end.
Every launch decision we've made since traces to those reports. Here's the workflow.</p></div>

There's a specific kind of lying founders do after a launch: they remember the five most
emotional comments and call it "what the community said." We had ten subreddits' worth of
comment threads, most of them still growing. Nobody's memory survives that honestly.

But we make a tool whose whole job is
[coordinating agents on real work](/blog/run-an-office-of-ai-agents/). Launch analytics turned
out to be the best dogfood we've ever had.

## The floor plan

Four agents, one channel each, spawned with a written brief:

- **Reddit agent** — the big one. Ten launch threads saved as raw JSON, every comment including
  every nested reply. Brief: account for *every* comment — bucket objections, praise,
  feature asks, and pricing signals, with quotes and usernames preserved.
- **Product Hunt agent** — the launch page: every comment, the review, and the page's own
  embedded data, read straight from the source rather than eyeballing rendered numbers.
- **GitHub agent** — stars, traffic, referrers, clones: which channel actually moved the repo.
- **Analytics agent** — PostHog funnels: installs, first runs, and where new users stalled.

{% img "note-1", "One channel per agent: Reddit, Product Hunt, GitHub, PostHog. Each reads everything, each files a report." %}

Each agent wrote two artifacts into a shared research folder: a **markdown brief** a human
actually wants to read, and a **JSON file** with the counted, bucketed data so later questions
don't require re-reading anything. Then the orchestrator synthesized the four into one picture.

## Why the fan-out matters

The naive version of this is pasting comments into one chat session until it fills up. The
problem isn't just context size — it's that a model skimming its 400th comment gets exactly as
lazy as a human does. One agent per channel keeps each report grounded in a full, careful read,
and the [orchestrator](/blog/how-the-god-orchestrator-works/) works from four distilled reports
instead of raw sludge. Fan out, then synthesize. It's the same
[pattern](/blog/multi-agent-orchestration-patterns/) that works for code.

The other thing a hive gets you is **iteration without re-reading**. Days later we came back
with sharper questions — "split willingness-to-pay by supporter motive versus buyer motive,"
"which commenters were blocked from even running it?" — and dispatched them to the same agent,
which still had [its memory](/blog/how-agents-remember-semantic-memory/) of the corpus. Each
pass appended to the same reports. The research got *thicker* instead of starting over.

{% img "note-2", "Sharper question, same agent, same corpus — the reports grow instead of restarting." %}

## What fell out of it

Findings we would have missed by skimming, all of which changed real decisions:

- **Nearly half of all engagement came from one subreddit.** r/ClaudeCode carried the launch
  almost single-handedly, and two other communities flatlined. That's next launch's channel
  budget, decided.
- **Product Hunt sent applause, not visitors.** Loud page, quiet referrer logs — a credibility
  channel, not a traffic channel. We'd have guessed wrong.
- **The two most serious evaluators asked for the same missing feature** — a visible
  "this decision needs your eyes" flag — in different words on different platforms. Only
  cross-channel synthesis caught that they were the same request.
- **Every blocked-user story on two channels traced to the same bug class** (the non-Claude-Code
  path on Windows), which moved it to the top of
  [0.4.4](/blog/launching-munder-difflin-v0-4-4/).

The Reddit and Product Hunt halves of this analysis became
[their](/blog/what-reddit-told-us-about-munder-difflin/)
[own](/blog/number-five-on-product-hunt/) posts — both written *from the agents' reports*, which
is why they have real numbers in them instead of vibes.

## Run it on your launch

The recipe, portable to any hive setup:

1. **Capture raw sources locally first.** Reddit threads have JSON endpoints; save them to
   disk so agents parse structure instead of scraping rendered pages.
2. **One agent per channel, written briefs.** The brief that worked: *account for every
   comment; bucket, count, and quote; write both a human brief and a JSON dataset; flag what
   you couldn't verify.* That last clause matters — our Reddit agent correctly flagged that
   view counts are null in public JSON rather than inventing them.
3. **A shared research folder** all agents write into, so reports reference each other.
4. **One synthesis pass** at the end — and keep the agents around, because your best questions
   arrive three days later.

An evening of agent work, and launch week stops being a feeling and becomes a dataset. The
[overnight version](/blog/claude-code-automation-while-you-sleep/) works too — we know, because
half of this ran while we slept off the launch.

---
title: "Run a Release Train with Agents"
description: "Version bumps, changelog entries, release notes in plain language, site updates, and link checks — the release chores that always slip are exactly the work a hive does well. The workflow behind our seven-releases-in-eight-days week."
date: 2026-08-19
category: use-cases
categoryLabel: Use Cases
type: Non-technical
primaryKeyword: "automate releases with ai agents"
secondaryKeywords: ["release automation workflow", "ai changelog generation", "release notes automation", "ship faster open source", "munder difflin workflow"]
tags: ["Use Cases", "Release", "Workflow", "Automation", "Multi-Agent"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What release chores can agents take over?"
    a: "The synchronization work: bumping versions everywhere they appear, writing the changelog entry from the actual merged diffs, drafting human-readable release notes, updating the website's version strings and download links, and checking that every link and version reference agrees. Humans stay on the judgment calls — what ships, and whether the notes tell the truth."
  - q: "How do you stop version references drifting apart?"
    a: "Two layers: an agent whose checklist includes every known surface (changelog, README badge, site, llms.txt, release page), and a guard script in CI that fails the build when a reference drifts. The script exists because an agent-run audit found our llms.txt advertising a version two releases stale — automation found it, a test now prevents it."
  - q: "Does this replace release engineering?"
    a: "No — it replaces release chores. The decisions (what's in, what's blocked, when to cut) stay human. What the agents remove is the hour of mechanical synchronization per release that otherwise gets skipped, which is exactly how version drift and stale notes happen."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>A release is one decision and forty
chores. During our <a href="/blog/seven-releases-in-eight-days/">seven-releases-in-eight-days
week</a>, the chores — version bumps, changelog prose, release notes, site updates, link
checks — ran as a repeatable agent workflow. The decision stayed human. That's the whole
trick, and here's the train schedule.</p></div>

Everyone's release process degrades the same way. Release one: meticulous. Release five: the
changelog says "misc fixes." Release nine: the README badge is two versions behind and the
website's FAQ names a plan that doesn't exist. Not because anyone stopped caring — because
synchronization chores scale linearly with surfaces, and humans under deadline cut exactly
those corners.

We shipped seven releases in eight days without (we think) shipping that decay, and the reason
is that the chores are a train the [hive](/blog/what-is-a-multi-agent-harness/) runs on rails.

## The train, car by car

**Car 1: the changelog entry, from evidence.** An agent reads the actual merged commits and
PRs since the last tag — not a memory of them — and drafts the changelog entry with a hard
rule we stole from our own postmortems: *every entry says what was broken from the user's point
of view, not which function changed.* "Agents booted, looked healthy, and had no idea they
could message anyone" survives to [the published
changelog](/blog/launching-munder-difflin-v0-4-4/) because the draft started from the diff and
the issue thread, where that sentence was earned.

{% img "note-1", "The changelog agent works from merged diffs and issue threads — not from anyone's memory of the week." %}

**Car 2: version references, everywhere.** The version string lives in more places than you
think: package manifest, changelog header, README badge, the website, the release page,
`llms.txt`. One agent's checklist is simply: find every reference, update every reference,
*then list where it looked* so omissions are visible. This car exists because an audit found
our `llms.txt` advertising a version two releases stale — nobody had ever put it on a mental
checklist.

**Car 3: release notes for humans.** The changelog is the record; the release notes are the
story. A second pass rewrites the entry in plain language — what you'll notice, what you need
to do (usually nothing, [the app updates itself](/blog/why-our-auto-update-never-ran/)) — and
since 0.4.4 can even ship as a designed page rendered inside the app. **This is also where
contributors get credited by name, every release, without fail** — @gts-47's eight PRs and
@baziyer's rendering fix headline the 0.4.4 thanks because an agent's checklist said *find
every community PR in this release and name its author*, and checklists don't get shy.

**Car 4: the guard rail.** The best part of agent-run chores: when an agent finds a drift
class once, you make it impossible instead of remembered. A small link-and-version checker now
runs in CI and fails the build if any known surface disagrees about the current version. The
train doesn't rely on the conductor's attention anymore.

{% img "note-2", "Find the drift once, then make it a failing test. The train stops relying on anyone's attention." %}

## Why agents fit this shape of work

Release chores are the ideal agent workload for three reasons. They're **evidence-based** — the
truth is in the diff, the tag, and the file, so [verification is
mechanical](/blog/how-ai-agents-verify-their-own-work/). They're **checklist-shaped** — the same
surfaces every time, which agents execute with the enthusiasm humans reserve for release one.
And they're **interruptible** — each car produces reviewable artifacts (a draft entry, a list
of touched files), so the human can inspect the train at any station.

Note what's *not* on the train: deciding what ships, judging whether a fix is real, choosing
what the headline is. During our eight-day week those calls happened in minutes precisely
because the chores weren't competing for the same attention.

## Set up your own

The portable version, whatever your stack:

1. **Write the checklist down once** — every file that mentions a version, every step between
   tag and announcement. This document *is* the agent brief.
2. **Point agents at evidence** — diffs, merged PRs, closed issues. Ban writing from memory.
3. **Route it through one dispatcher** so the cars run in order —
   [that's what an orchestrator is for](/blog/how-to-talk-to-your-orchestrator/).
4. **Convert discoveries into CI guards.** An agent finding drift is good; a test that makes
   the drift impossible is the actual win.

Our cadence didn't come from typing faster. It came from making releases cost one decision
instead of one afternoon — and from a train that [runs on
schedule](/blog/scheduling-autonomous-agent-missions/) even when the humans are asleep.

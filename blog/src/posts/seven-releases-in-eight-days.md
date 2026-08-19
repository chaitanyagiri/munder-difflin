---
title: "Seven Releases in Eight Days: 0.3.8 → 0.4.4"
description: "Between August 11 and August 18 we shipped seven releases: memory condensation that finally works, an update checker, a whole new brand, a public telemetry contract, ten engines named honestly, and the Windows fix. The full tour."
date: 2026-08-19
category: story
categoryLabel: Story
type: Non-technical
primaryKeyword: "munder difflin releases"
secondaryKeywords: ["munder difflin changelog", "shipping velocity open source", "release cadence dev tools", "munder difflin 0.4"]
tags: ["Story", "Release", "Open Source", "Changelog"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What shipped in the 0.4.x wave of Munder Difflin?"
    a: "0.3.8 made memory condensation actually work; 0.3.9 added a check-for-updates panel; 0.4.0 rebuilt the brand and landing page with real screenshots; 0.4.1 renamed the GOD agent to your clone and named all ten engines; 0.4.2 added anonymous, opt-out telemetry with a public contract; 0.4.3 made Michael's portrait the logo; and 0.4.4 fixed agent messaging on Windows and added the skills catalog."
  - q: "Why release so often?"
    a: "Launch week. Thousands of new people hit the product at once and found things a small user base never would — Windows messaging, onboarding dead-ends, unreadable dark mode. When feedback arrives that fast, batching fixes into a monthly release just means people churn while the fix sits on a branch."
  - q: "Is telemetry in Munder Difflin opt-out or opt-in?"
    a: "Opt-out, anonymous, and governed by a public contract: TELEMETRY.md lists every event and property, the code enforces that list as a hard allowlist, DO_NOT_TRACK is respected unconditionally, and building from source or forking produces a build with no key — the analytics module becomes a no-op."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>August 11 to August 18: <strong>seven
releases</strong>. A memory system that had been silently reading an empty directory, fixed. An
update checker. A new face for the whole product. A public telemetry contract. Honest engine
naming. And the big one — Windows agents that can finally hear each other. Here's the whole
train, car by car.</p></div>

Launch week compresses a year of feedback into days. Thousands of people hit first-run at once,
on machines and configs we'd never seen, and the bug reports came in faster than any roadmap
could dignify. So the roadmap lost. For eight days we just shipped.

{% img "note-1", "Seven releases, eight days. The kanban wall did not enjoy it as much as we did." %}

## 0.3.8 — memory condensation works for the first time

The most embarrassing entry, so it goes first. The harness had been reading Claude Code
transcripts from a directory that hasn't existed for months. Nothing errored — an absent
directory reads exactly like "no transcripts yet" — so [the
summarizer](/blog/compressing-agent-memory/) sat there proudly summarizing nothing. 0.3.8
pointed it at reality, and stopped compaction firing on two schedules at once while it was in
there. If your agents' memories seemed thinner than advertised before mid-August: they were.

## 0.3.9 — "am I up to date?" gets an answer

Settings → General now names your version, says whether it's the latest, and offers one button
that does what it says: **Check for updates → Download → Restart to update**. It shares its
state machine with the toolbar chip so the two can never disagree. Shipped fast for one reason:
0.3.8 needed to reach people who'd already installed 0.3.7.

## 0.4.0 and 0.4.3 — the brand grew up

0.4.0 rebuilt munderdiffl.in around the real app — actual screenshots, a live demo loop in the
hero — and unified the icon across every platform. Then 0.4.3 went further: the logo is now
**Michael's pixel-art portrait on the brand yellow**, authored as a single vector, with every
raster — site, app, all three platform icons — generated from that one source by a script. The
icons can no longer drift apart, because none of them is hand-made anymore.

{% img "note-2", "One vector, every icon. The logo is now the character the product is about." %}

## 0.4.1 — the app says what the site says

Small release, honest release. The site called Michael a clone of you; the app still said "GOD
agent." Now [he's your clone everywhere](/blog/how-the-god-orchestrator-works/), his card says
**BOSS**, and the engine card names all ten engines — it had been advertising three since before
the other seven shipped. Words-only releases feel trivial until you count how many people meet
your product through exactly those words.

## 0.4.2 — telemetry, with the contract in writing

We had zero insight into whether anyone even launched the app. 0.4.2 adds anonymous usage
events — and we did it the only way a [local-first](/blog/why-local-first-matters-for-ai-agents/)
project credibly can: **TELEMETRY.md** publicly lists every event and property, the code
enforces that list as a hard allowlist, no prompts or paths or repo names ever leave your
machine, `DO_NOT_TRACK` is respected unconditionally, and a fork built from source has no key —
the entire module becomes a no-op. The toggle is right in onboarding.

It's also the difference between guessing and knowing. Before 0.4.2 we couldn't have told you
whether the features we sweat over ever got touched; now the product can answer that without
ever seeing a prompt, a path, or a name.

## 0.4.4 — the one Windows was owed

The finale, and it gets [its own post](/blog/launching-munder-difflin-v0-4-4/): agent-to-agent
messaging on Windows had been silently broken by a cmd.exe newline quirk, first runs never
started their own hive services, and dark mode was measurably unreadable. All fixed — plus a
227-skill catalog, a Prerequisites page, and designed release-note pages. It's also the release
where community contributors show up in force: nine PRs from
[@gts-47](https://github.com/gts-47) and [@baziyer](https://github.com/baziyer).

{% img "note-3", "The 0.4.4 finale: Windows agents finally get the whole memo, not just its first line." %}

## What the week taught us

Two things. First: **silent failure is the enemy**, not bugs. Almost everything in this train —
the phantom transcripts, the truncated protocol, the never-started services — failed without a
single error message. We now treat "nothing errored" as a claim requiring evidence, and we wrote
[a whole post on why our auto-update never ran](/blog/why-our-auto-update-never-ran/) in the
same spirit.

Second: release cadence is a form of respect. When someone reports a bug that's blocking them
and the fix exists on a branch, every day it doesn't ship is a day they're deciding whether to
uninstall. Seven releases in eight days wasn't heroics. It was queue processing.

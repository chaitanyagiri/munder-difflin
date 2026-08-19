---
title: "Why We Built Munder Difflin"
description: "The origin story of Munder Difflin — how the pain of juggling Claude Code terminals led to a coordinated, memory-backed hive of agents you can watch."
date: 2026-06-02
category: story
categoryLabel: Story
type: Non-technical
primaryKeyword: "munder difflin"
secondaryKeywords: ["munder difflin github", "multi-agent harness", "why munder difflin"]
tags: ["Story", "Multi-Agent", "Claude Code", "Open Source"]
author:
  name: Chaitanya Giri
  initials: CG
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>We built <strong>Munder Difflin</strong>
because running several Claude Code agents at once was powerful and miserable in equal measure — they
collided, forgot, and turned us into a human message bus. The fix wasn't a better terminal; it was a
<strong>coordination layer</strong>: roles, shared memory, messaging, and an orchestrator you talk to,
visualized as an office floor. This is the story of that itch.</p></div>

Every tool starts with an annoyance specific enough to act on. Munder Difflin started with a wall of
terminal tabs and the dawning realization that *I* had become the slowest part of my own setup.

## The itch

Claude Code is great. So great that one session was never enough for long. I'd open a second terminal
to parallelize, then a third, then a fourth. Throughput went up — and so did the chaos.

Three frustrations kept recurring, the same ones [everyone hits](/blog/from-one-terminal-to-a-team/):

- **They collided.** Two agents would edit the same file and race each other; git would throw
  `index.lock` errors and leave half-applied changes.
- **They forgot.** Each session started cold. What one agent figured out, the next couldn't use — so I
  copy-pasted findings between windows like a courier.
- **I lost track.** Six tabs in, "what is everyone doing right now?" had no answer. And lost track is
  where mistakes hide.

The agents weren't the bottleneck anymore. *I* was — the message bus, the conflict resolver, and the
project's only long-term memory.

{% img "note-1" %}

## The realization

The instinct is to reach for a better terminal multiplexer. But the problem wasn't *running* agents in
parallel — plenty of tools do that well. The problem was that the agents had no way to **coordinate**:
no shared memory, no way to message each other, no one routing the work but me.

What I actually wanted was an *office*. A team where everyone has a role, shares what they learn, hands
work off directly, and answers to a manager I could talk to in plain language. The missing thing wasn't
more parallelism — it was the [coordination layer](/blog/what-is-a-multi-agent-harness/) on top of it.

## What we built

So that's what Munder Difflin is: a layer that wraps the Claude Code agents you already run and makes
them a team.

- **Roles** so each agent stays in its lane.
- **Shared memory** — a semantic store (MemPalace) the whole hive reads and writes, so knowledge
  compounds instead of resetting.
- **Messaging** — every agent has a mailbox; a router delivers between them, so they hand off work
  without me in the middle.
- **A [GOD orchestrator](/#how)** — a coordinator you talk to like a manager; it decomposes your intent and
  routes the work.
- **A floor you can watch** — agents as avatars at their desks, so the black box becomes something you
  can supervise at a glance.

And the joke that became the name: *the world's best agents, the world's worst paper company.* The
office metaphor isn't decoration — it turned out to be the clearest way to think about (and watch) a
team of coordinating agents.

{% img "note-2" %}

## Why local, why open source

Two decisions were never really in question. **Local-first**, because agents that touch your whole
codebase shouldn't ship your code and memory to someone else's cloud — you keep the control, the
privacy, and the predictable cost ([the full case](/blog/why-local-first-matters-for-ai-agents/)).
And **open source (MIT)**, because a tool you run against your own code is one you should be able to
read, trust, and extend. The code lives on
[GitHub](https://github.com/chaitanyagiri/munder-difflin).

## What it's for

Munder Difflin is for the moment you've felt the wall — three or more agents, context evaporating, you
alt-tabbing as the message bus. It's the [office of agents](/blog/run-an-office-of-ai-agents/) I wanted
when I had eight tabs open and no idea what half of them were doing.

If you've been there, you already understand the itch. The rest of the common questions are answered in
the [Munder Difflin FAQ](/blog/munder-difflin-faq/).

---

We built it to scratch our own itch, then made it free for everyone with the same one. [Download
Munder Difflin](/#install) — it's open source and local-first, on macOS, Windows, and Linux.

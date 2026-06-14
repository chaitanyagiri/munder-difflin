---
title: "Shareable Agent Roles: A Portable Format for Hiring AI Coworkers"
description: "Why agent roles should be portable: what a hire manifest encodes, how one-click hiring stays safe, and how The Hiring Fair turns tacit setup into a shareable artifact."
date: 2026-06-15
category: concepts
categoryLabel: Concepts
type: Non-technical
primaryKeyword: "shareable agent roles"
secondaryKeywords: ["portable agent config", "ai agent role manifest", "the hiring fair", "one-click ai agent", "reusable agent personas"]
tags: ["Concepts", "Multi-Agent", "Open Source", "Agent Design"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What is a 'shareable agent role'?"
    a: "It's an agent role packaged as a portable file — a small JSON manifest (format id munder-difflin/hire@1) that captures everything needed to spin up a role-configured agent: name, avatar, provider, model, command flags, a goal/role description, capability tags, and a token budget. We call one a 'hire.' Instead of explaining your setup in a tutorial, you hand someone the file and they get the same coworker."
  - q: "Why should agent roles be portable at all?"
    a: "Because a good role is real, hard-won configuration work — the right provider and model, the right flags, a sharp goal prompt, sane capabilities and a token budget — and today that knowledge is trapped in one person's setup or buried in prose. Portability turns that tacit knowledge into an artifact you can share, fork, and improve, the same move package registries made for code libraries."
  - q: "If I import a role from a link, does it start running on its own?"
    a: "No. Import never spawns anything. It only pre-fills the Add-Agent modal behind an explicit 'imported' banner. You review every field and you click spawn. A role you got from the internet is inert data until a human acts on it — the human is always the spawn gate."
  - q: "How is a role manifest different from just sharing a prompt?"
    a: "A prompt is one ingredient. A hire manifest is the whole recipe: which provider runs it, the model, the command flags, the goal, the capability tags, and the budget — mapped 1:1 onto the fields the app's Add-Agent flow already uses. It's the difference between a sentence in a README and a job description you can hand to anyone's office."
  - q: "What is The Hiring Fair?"
    a: "A static community gallery at munderdiffl.in/hires — no login, no trackers, MIT-licensed. It's stocked with ready-made roles from the cast: Pam writes docs, Dwight enforces QA, Jim reviews PRs, Creed audits security, Angela audits the office's own token spend, Stanley does the migrations nobody wants. Each card has a Claude Code / Antigravity / Codex toggle and function filters. Browse, hire, review, spawn."
  - q: "Can I submit my own roles to The Hiring Fair today?"
    a: "Not yet. Today, curation is a maintainer commit — there is deliberately no public write or submission pipeline. A community submission queue needs its own review-and-trust design, so we scoped it out of this first release rather than ship it half-built."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>A well-configured agent <strong>role</strong> is real work — the right provider, model, flags, goal prompt, capabilities, and budget — and today that knowledge is trapped in one person's setup. Munder Difflin v0.2.8 makes a role a <strong>portable artifact</strong>: a small JSON manifest we call a <strong>hire</strong> (a job description as a file). You hire from a <strong>link</strong> or a <strong>file</strong>, and the Add-Agent modal opens <em>pre-filled</em> — but <strong>import never spawns anything</strong>; you review every field and you press spawn. Browse ready-made roles at <strong>The Hiring Fair</strong> (<a href="https://munderdiffl.in/hires/">munderdiffl.in/hires</a>). The thesis: portable roles create a community growth loop, the way package registries did for libraries.</p></div>

There's a moment, the first time you open a fresh agent floor, where the hard part isn't running an agent — it's *configuring* one. Which provider? Which model? What flags? And the question that actually stalls people: what is this thing's *job*? Writing a role from a blank box is a steep first step, and it's the step that stands between a curious newcomer and watching a single agent do a single useful thing.

This post is about a small idea with an outsized payoff: **make an agent role a portable artifact** — something you can hand to someone, the way you'd hand them a file. In v0.2.8 we shipped that idea as **Shareable Hires**, and a gallery to share them in, called **The Hiring Fair**. Here's why portable roles matter, what the format encodes, and the trust design that makes "hire from a link" both easy and safe.

## The problem: a good role is tacit knowledge

Spin up an agent that's genuinely good at one job — say, reviewing pull requests — and notice how much of the value is *configuration*, not code. You picked a provider. You picked a model that's strong enough for the task but not wastefully expensive ([the clone army trap](/blog/the-clone-army-trap-mixed-swarm-vs-identical-agents/) is what happens when you skip this). You set command flags. You wrote a goal prompt sharp enough that the agent doesn't need a follow-up question. You gave it the right capabilities and a token budget so it can't quietly torch your bill.

That's a real, hard-won bundle of decisions. And right now, it lives in exactly one place: your setup. If a teammate wants the same PR reviewer, your options are bad. You can write a tutorial — paragraphs of "set the model to X, add these flags, here's the prompt I use" — and hope they transcribe it correctly. Or you can screen-share and walk them through the dialog field by field.

Either way, **you can't just hand someone a role.** The knowledge is tacit: trapped in one person's head, or buried in prose that goes stale the moment a default changes. For a newcomer, "write an orchestrator prompt from scratch" is the worst possible first task — it asks for expertise before they've earned any. The thing that should be a starting point is instead a wall.

## The idea: a role as a file you can pass around

The fix is to stop describing roles and start *packaging* them. A **hire** is a small JSON manifest — format id `munder-difflin/hire@1` — that captures a role-configured agent in full:

- a **name** and an **avatar/sprite** (the pixel face on the floor),
- a **provider** — Claude Code, Antigravity (Gemini, `agy`), or Codex,
- a **model** and the **command flags** it runs with,
- a **goal / role description** — what this coworker is here to do,
- **capability tags** — what it's good at, so it's filterable,
- and a **token budget** — a spend ceiling baked in.

Think of it as a **job description as a file.** The manifest isn't a new runtime or a clever new way to start agents — it maps **1:1 onto what the app's Add-Agent flow already does**. Every field above is a field the dialog already has. So a hire is, very precisely, a *pre-filled version of the form you've always used*. Nothing new spawns it; it's just a portable starting point for the same flow.

### What one looks like

Here's an *illustrative* manifest (realistic fields, but don't copy-paste it as gospel — it's a teaching example, not a spec):

```json
{
  "format": "munder-difflin/hire@1",
  "name": "Jim",
  "sprite": "jim",
  "provider": "claude-code",
  "model": "claude-sonnet",
  "flags": ["--permission-mode", "plan"],
  "goal": "Review open pull requests. Read the diff against the base branch, flag correctness bugs, risky side effects, and missing tests. Comment with specifics; do not merge.",
  "capabilities": ["code-review", "testing", "git"],
  "tokenBudget": 200000
}
```

Read it top to bottom and it tells you everything: *who* (Jim, the PR reviewer), *what runs it* (Claude Code on a mid-tier model), *how it behaves* (plan mode, so it proposes before acting), *what it's for* (the goal), *what it's good at* (the tags), and *how much it's allowed to spend* (the budget). That's the entire role, and it fits in a screenshot. The point of the format is exactly that legibility: a role you can read, diff, and reason about — not a black box.

## Two ways to hire, one pipeline

There are two front doors, and they both lead to the same place.

- **Deep link.** A `munderdifflin://hire?src=<https-url>` link — the kind behind a ⚡hire button in the gallery — opens the app and fetches the manifest, then opens the **Add-Agent modal pre-filled**. One click from a web page to a populated form.
- **File import.** An *import hire…* button in the Add-Agent modal reads a local `.hire.json` file. Same destination: the form, pre-filled.

The two doors exist because the two situations are different — clicking a button in a browser versus opening a file someone sent you — but they converge immediately. Both end at one modal, one review, one spawn button. There's deliberately not a second mechanism to maintain.

## The trust design: import never spawns

This is the heart of the UX, and it's a single, load-bearing rule: **importing a hire never spawns anything.** Whether it arrives by deep link or file, an imported manifest only ever *pre-fills the Add-Agent modal*, behind an explicit "imported" banner so you always know this config came from outside. You review every field — the goal, the flags, the budget — and **you** click spawn. A role you got from the internet is inert data until a human acts on it. The human is the spawn gate, every time.

A few properties make that guarantee real rather than aspirational: there's **no executable in the format** — a manifest names a provider preset, and the actual binary always comes from your own local install, never the file (`provider: "custom"` is rejected outright). The import is **validated and bounded**, so a malformed or oversized manifest is refused, not trusted. The mechanics of treating a downloaded manifest as untrusted input — the validation, the bounds, the threat model — get their own [security deep-dive](/blog/hire-manifest-untrusted-input/); here the takeaway is the principle. **Portability and safety aren't in tension** as long as import is data-only and a human owns the spawn. You can share a role freely *because* sharing it can't, by construction, run anything.

## The Hiring Fair: a gallery of ready-made roles

Portable roles are more fun when there's somewhere to get them. **The Hiring Fair** is a static community gallery at [munderdiffl.in/hires](https://munderdiffl.in/hires/) — no login, no trackers, MIT-licensed — stocked with roles from the cast:

- **Pam** writes docs.
- **Dwight** enforces QA (relentlessly).
- **Jim** reviews PRs.
- **Creed** audits security.
- **Angela** audits the office's *own* token spend — the accountant for your agents.
- **Stanley** does the migrations nobody wants to touch.

Each card carries one **base manifest per role**, with **per-provider variants generated** so you can flip a Claude Code / Antigravity / Codex toggle and get the same role configured for whichever CLI you run. **Function filters** let you find roles by what they do — review, docs, security, ops — instead of scrolling. Browse, hit ⚡hire, land in the pre-filled modal, review, spawn.

One honest scope note: **today, curation is a maintainer commit.** There is deliberately *no public write or submission pipeline yet*. You can browse and hire, but you can't push your own role into the gallery — that has to come through a maintainer. That's a real cut, and an intentional one: a community submission queue is its own design problem (who reviews, what's trusted, how you keep a public gallery from becoming an attack surface), and it deserves its own treatment rather than being bolted on half-built. The format is portable today; the *open submission loop* is the next conversation, not this one.

## Why it matters: a registry for roles

Here's the thesis. Once a role is a portable artifact, something compounding happens — a **community growth loop**. The best-tuned roles can be shared, then forked, then improved, then shared again. The person who finally nails the "security auditor" prompt doesn't keep that win to themselves and doesn't bury it in a blog post; they export a hire, and everyone downstream starts from their best version instead of from a blank box. Good configuration stops being a thing each person rediscovers and becomes a thing the community *accumulates*.

This is the same move package registries made for code. Before npm or PyPI, reusing a library meant copying files and re-reading install instructions; the registry turned "here's how you set it up" into "here's the artifact, take it." Shareable Hires does that for agent *roles*. "Hire Pam" becomes the easy on-ramp that "write a system prompt" never was — and the floor that the [GOD orchestrator](/blog/how-the-god-orchestrator-works/) coordinates can fill up with proven coworkers instead of guesses.

It also fits the broader bet behind Munder Difflin: **local-first, open-source, you own your floor.** The roles are MIT, the gallery has no login or trackers, the binary that runs an agent is always your own, and the human is always the one who hits spawn. Portability here doesn't mean handing control to a cloud — it means handing a *file* to a person, who stays in charge of what they do with it. (For why we [built it this way](/blog/why-we-built-munder-difflin/) in the first place, the origin story has the rest.)

## Go browse The Hiring Fair

The fastest way to feel the idea is to use it. Open [The Hiring Fair](https://munderdiffl.in/hires/), pick a role that matches something on your plate, flip it to your provider, and hire it — then read every field in the modal before you spawn, because that review step is the whole point.

- [Launching Munder Difflin v0.2.8: Shareable Hires](/blog/launching-munder-difflin-v0-2-8/) — the release.
- [The hire manifest as untrusted input](/blog/hire-manifest-untrusted-input/) — the security deep-dive on the trust model.
- [Inside the GOD orchestrator](/blog/how-the-god-orchestrator-works/) — who coordinates the roles you hire.
- [The clone army trap](/blog/the-clone-army-trap-mixed-swarm-vs-identical-agents/) — why a *mix* of well-chosen roles beats ten identical agents.
- [Why we built Munder Difflin](/blog/why-we-built-munder-difflin/) — the origin story.
- [CHANGELOG](https://github.com/chaitanyagiri/munder-difflin/blob/main/CHANGELOG.md) — everything that shipped.

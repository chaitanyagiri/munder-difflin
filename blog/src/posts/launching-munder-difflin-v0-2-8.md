---
title: "Launching Munder Difflin v0.2.8: Shareable Hires"
description: "Munder Difflin v0.2.8 ships Shareable Hires: a one-click, portable agent role manifest + The Hiring Fair gallery. Click a hire link, review every field, then spawn it yourself."
date: 2026-06-15
category: story
categoryLabel: Story
type: Non-technical
primaryKeyword: "munder difflin v0.2.8"
secondaryKeywords: ["shareable agent roles", "the hiring fair", "one-click ai agent hire", "munderdifflin deep link", "ai agent role manifest"]
tags: ["Story", "Release", "Multi-Agent", "Claude Code", "Open Source"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What's new in Munder Difflin v0.2.8?"
    a: "The headline is Shareable Hires. A hire is a portable JSON manifest (format id munder-difflin/hire@1) that captures a fully role-configured agent — name, avatar, provider, model, command flags, a goal, capability tags, and a token budget. You can share it as a link or a file, and the recipient gets the Add-Agent modal pre-filled, ready to review and spawn. It ships alongside a community gallery called The Hiring Fair at munderdiffl.in/hires."
  - q: "What exactly is a 'hire'?"
    a: "Think of it as a job description for an AI coworker. It's a single JSON manifest that describes a role-configured agent: which provider runs it (Claude Code, Antigravity, or Codex), the model, the command flags, a goal/role description, capability tags, and a token budget. Hand it to anyone's office and they can spin up that exact role."
  - q: "Does importing a hire automatically run an agent?"
    a: "No — and this is the whole point. Importing a hire (by link or by file) only pre-fills the Add-Agent modal, with an explicit 'imported' banner. Nothing spawns until you review every field and click spawn yourself. A hire you got from the internet can't run itself. The human is always the trigger."
  - q: "What is The Hiring Fair?"
    a: "It's a community gallery at munderdiffl.in/hires — static, no login. It's full of ready-made roles from the cast: Pam writes docs, Dwight enforces QA, Jim reviews PRs, Creed audits security, Angela audits the office's own token spend, and Stanley does the migrations nobody wants. Each card has a Claude Code / Antigravity / Codex toggle and function filters. Browse, click the ⚡hire button, review, spawn."
  - q: "How are the two ways to hire different?"
    a: "There are two front doors, one pipeline. A deep link (munderdifflin://hire?src=<https-url>) makes the app fetch and validate a manifest, then open the Add-Agent modal pre-filled — that's what the gallery's ⚡hire button uses. A file import is the 'import hire…' button in the Add-Agent modal, which reads a local .hire.json file. Both end at the same review-and-spawn step."
  - q: "Is it safe to import a hire from someone else?"
    a: "A manifest is treated as untrusted input: there's no executable field, no auto-spawn, and the fetch is validated and bounded. It can only pre-fill a form you review by hand. We go deep on the trust model in a separate post — see the hire manifest security deep-dive."
  - q: "Do I still get everything from v0.2.7?"
    a: "Yes. v0.2.8 includes everything from v0.2.7 (voice dictation, the Knowledge Graph, multi-window floors, the rich composer, session resume) and earlier. Shareable Hires is purely additive."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p><strong>Munder Difflin v0.2.8</strong> ships <strong>Shareable Hires</strong>. A <strong>hire</strong> is a portable JSON manifest — a job description for an AI coworker (provider, model, flags, goal, capability tags, token budget) — that you can share as a <strong>link</strong> or a <strong>file</strong>. Click a hire, and the Add-Agent modal opens <em>pre-filled</em>. It never spawns anything on its own: <strong>you</strong> review every field and hit spawn. Plus <strong>The Hiring Fair</strong> at <a href="https://munderdiffl.in/hires">munderdiffl.in/hires</a> — a no-login gallery of ready-made roles (Pam writes docs, Dwight does QA, Creed audits security…). Browse → ⚡hire → review → spawn. Free, open source, local-first.</p></div>

ok so picture this. you've got a whole floor of pixel coworkers — Claude Code agents, Antigravity (Gemini) workers, Codex CLIs — all run by Michael, the GOD orchestrator who routes work like a slightly unhinged regional manager. it's great. but here's the part nobody tells you about a fresh, empty office:

**the first hire is the hard one.**

a blank floor is intimidating. what model? what provider? what flags? what should this thing's *job* even be? for a newcomer, that's a lot of staring at an empty Add-Agent dialog before anything fun happens. you basically have to know how to write an orchestrator brief before you can watch a single agent do a single thing.

**v0.2.8 fixes the cold start.** meet **Shareable Hires**.

## what's a "hire"?

a hire is a tiny, portable **JSON manifest** — format id `munder-difflin/hire@1` — that captures a *fully role-configured agent*. not just "an agent," but a coworker with a job already figured out:

- 🏷️ a **name** and an **avatar/sprite** (yes, the little pixel face)
- 🤖 a **provider** — Claude Code, Antigravity, or Codex
- 🧠 a **model** and the **command flags** it should run with
- 🎯 a **goal / role description** — what this coworker is actually here to do
- 🏆 **capability tags** — what it's good at, so it's filterable
- 📊 a **token budget** — so it can't quietly torch your bill

think of it as a **job description you can hand to anyone's office**. someone figured out a great "PR reviewer" setup once? they export it as a hire, you drop it into your floor, and now you've got that exact coworker — without reverse-engineering anyone's prompt.

the neat trick: a manifest maps **1:1** onto what the Add-Agent modal already sends. it's not a new system bolted on the side — it's just a portable snapshot of the per-agent config you've always had. "hire Pam" is a *way* easier first step than writing an orchestrator prompt from a cold start.

## two ways to hire, one pipeline

there are two front doors, but they both end at the same place: a modal you review and a spawn button **you** press.

### 🔗 the deep link

click a `munderdifflin://hire?src=<https-url>` link — say, from the gallery — and the app does the legwork: it **fetches** the manifest, **validates** it, and pops open the Add-Agent modal **pre-filled** with everything that hire describes. one click from "ooh, that's a nice role" to "let me look this over."

### 📁 the file import

prefer files? there's an **import hire…** button right inside the Add-Agent modal. point it at a local `.hire.json` file and it reads it in. same destination: the modal, pre-filled.

both paths converge. link or file, you land in the same review screen.

## the part that matters: import never spawns anything

read this twice, because it's the whole trust promise:

> **importing a hire does not start an agent. ever.**

all it does is **pre-fill the modal** — and it slaps an explicit *"imported"* banner on it so you're never confused about where these values came from. then **you** read every field. you check the goal. you eyeball the provider and the budget. and then **you** click spawn. yourself. on purpose.

**a hire you got off the internet can't run itself.** the human is always the trigger. that's not a setting you can flip off; it's how the feature is built. it's the difference between "here's a job description, want to hire this person?" and "this résumé is now a manager." we are firmly the former.

🔒 on the security of it: a manifest is treated as **untrusted input** — there's no executable field, no auto-spawn, and the fetch is validated and bounded. that's the short version. we wrote a whole post on the trust model so this one can stay fun — go read the [hire manifest security deep-dive](/blog/hire-manifest-untrusted-input/) if you want the bolts and the threat model.

## The Hiring Fair 🎪

ok, the fun part. all of this would be a neat plumbing feature with nothing to plug into — so we built the thing to plug into.

**The Hiring Fair** is a community gallery at **[munderdiffl.in/hires](https://munderdiffl.in/hires)**. static, no login, no account. just a wall of ready-made coworkers you can hire in one click. and because the floor looks like *The Office*, of course the cast showed up to apply:

- 📝 **Pam** writes the docs (the README nobody wants to write? Pam wants to write it.)
- 🥋 **Dwight** enforces QA. Dwight does not negotiate with bugs. *FACT.*
- 🔍 **Jim** reviews your PRs (calm, reasonable, occasionally pranks the diff)
- 🕵️ **Creed** audits security (look, who *better* to think like an attacker)
- 💰 **Angela** audits the office's **own** token spend — she runs the numbers on your other agents and judges them for it. perfect casting.
- 🗄️ **Stanley** does the migrations nobody else will touch. he's not thrilled. he does them anyway.

each card has a **Claude Code / Antigravity / Codex** toggle and **function filters** — the same ones from the main landing page, so it all feels like one place. pick the provider you actually have installed, filter by what you need, then hit the **⚡hire** button.

the loop is dead simple:

> **browse → click ⚡hire → review → spawn.**

that's it. that's the whole onboarding. instead of "here's an empty floor, good luck," it's "here's Pam, want her to write your docs? yes? she's at her desk now."

## why this is secretly a growth thing

here's the bit we're genuinely excited about. the hardest moment in any tool like this is the **first five minutes**. an empty office asks too much of a newcomer.

a hire collapses that. somebody who already runs a great floor can package up their best role and **share the link**. the recipient clicks it, reviews it, spawns it — and now they've got a working agent on their *first* try, before they've learned a single thing about orchestrator prompts. then *they* tweak it, build their own great role, and share *that*.

that's a **community growth loop**: roles people actually use, shared as one-click links, each one a doorway into the floor that doesn't start with a blank page. The Hiring Fair is the marketplace; the hire manifest is the currency. and none of it costs you an API key — hires drive the CLIs and subscriptions you already pay for.

## everything from 0.2.7 is still in the box

Shareable Hires is purely **additive**. nothing got taken away. v0.2.8 includes everything from v0.2.7 and earlier:

- 🎙️ **voice dictation** — talk to your floor
- 🕸️ **the Knowledge Graph** — the office remembers how things connect
- 🪟 **multi-window floors** — spread the office across monitors
- ✍️ **the rich composer** — attachments + a taller, friendlier input
- ⏯️ **session resume** — pick a long-running session back up where it left off

plus the multi-provider parity (Claude Code + Antigravity + Codex, no second-class citizens), shared memory, the inbox/outbox mailbox, schedules, token budgets, close-the-lid overnight runs, and Slack/webhook triggers. the floor you already love, now with a front door for new coworkers.

## get v0.2.8

Munder Difflin is **free, open source, and local-first** on macOS, Windows, and Linux. no account, no cloud — your machine, your subscriptions, your floor.

[**Download v0.2.8**](https://github.com/chaitanyagiri/munder-difflin/releases/latest), then head over to [**The Hiring Fair**](https://munderdiffl.in/hires), find a coworker, and hit ⚡hire. review the modal. spawn it. watch Pam get to work.

want the why-it's-built-this-way story? read the concept companion on [shareable agent roles](/blog/shareable-agent-roles/). want the trust model and threat surface in detail? that's the [hire manifest security deep-dive](/blog/hire-manifest-untrusted-input/). curious how we even ended up with a Dwight in the first place? the [Office parody behind Munder Difflin](/blog/the-office-parody-behind-munder-difflin/) explains the casting. and if you missed the multi-provider launch, [v0.2.4 is right here](/blog/launching-munder-difflin-v0-2-4/).

full release notes live in the [CHANGELOG](https://github.com/chaitanyagiri/munder-difflin/blob/main/CHANGELOG.md).

that's it. go hire someone. (Dwight is already volunteering.)

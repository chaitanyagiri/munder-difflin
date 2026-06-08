---
title: "Launching Munder Difflin v0.2.4"
description: "Munder Difflin v0.2.4 is here: Claude Code, OpenAI Codex, and Antigravity (Gemini) agents now run as one hive with full parity — no API keys, no setup. Brief a GOD orchestrator, automate basically anything in one prompt, and close the lid while it keeps working."
date: 2026-06-09
category: story
categoryLabel: Story
type: Non-technical
primaryKeyword: "munder difflin v0.2.4"
secondaryKeywords: ["codex hive parity", "munder difflin release", "multi-provider agents", "codex lifecycle hook bridge", "antigravity gemini agents"]
tags: ["Story", "Release", "Multi-Agent", "Claude Code", "Codex", "Open Source"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What's new in Munder Difflin v0.2.4?"
    a: "v0.2.4's headline is full Codex hive parity: Codex now has a lifecycle-hook bridge — the same integration Antigravity has had since v0.2.3. So Claude Code, Antigravity (Gemini), and OpenAI Codex are now equally first-class. It also ships a heartbeat re-engage fix so the GOD orchestrator wakes the moment actionable mail lands, and god now opens to its Terminal sidebar by default."
  - q: "What does Codex full hive parity mean?"
    a: "In v0.2.3, Codex was inbox-capable but not fully hive-aware — it used an idle inbox-wake nudge for delivery. In v0.2.4, Codex has a real lifecycle-hook bridge that unifies agy and Codex dispatch. Both CLIs go through the same hook pipeline: live status, inbox drain, and outbox routing work identically for all three providers."
  - q: "Do I need an API key for Antigravity or Codex?"
    a: "No. Antigravity runs on your Antigravity subscription (Gemini via the agy CLI). Codex runs on your OpenAI subscription (via the codex CLI). Munder Difflin drives the CLIs you already have — it doesn't replace them or require separate API credentials."
  - q: "Can I mix Claude Code, Antigravity, and Codex in the same hive?"
    a: "Yes. All three are first-class hive participants. You can run Claude Code as the GOD orchestrator while Antigravity and Codex workers handle tasks — all sharing one inbox system, one shared memory, and one coordination layer."
  - q: "Can I trigger Munder Difflin from Slack or my phone?"
    a: "Yes. Send a message in Slack — or POST to a secure, opt-in webhook — and the GOD orchestrator picks it up as a task, routes it, runs it, and replies back in the thread when it's done. It's off by default until you switch it on, so you can kick off a job from your phone mid-commute or wire the hive into CI."
  - q: "What can I automate in one prompt with Munder Difflin?"
    a: "Basically anything you'd otherwise babysit. One prompt to the GOD orchestrator built our own CodeRabbit-style PR reviewer for any repo — review the open PRs and set up an hourly mission to review new ones — and it just kept running. Schedules, monitoring, and a token budget keep it grinding hands-free without burning your bill."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p><strong>Munder Difflin v0.2.4</strong> closes the loop on multi-provider. <strong>Claude Code, Antigravity (Gemini · <code>agy</code>), and OpenAI Codex</strong> are now equally first-class — three CLIs, one hive, no second-class citizens. No API keys, no setup. Brief a GOD orchestrator like you'd brief a coworker, automate basically anything in one prompt, trigger it from Slack on your phone, and close the lid while a whole floor of agents keeps working. Free, open source, local-first.</p></div>

ok so here's the thing. you already have a coding agent in your terminal. it's great. it's also *one* of it, and it stops the second you close the laptop.

now picture a whole **floor** of them — a researcher, a writer, a builder, a reviewer — all talking to each other, sharing memory, and run by one orchestrator you just… talk to. that's Munder Difflin. and as of **v0.2.4**, the floor doesn't care which AI you brought.

## three CLIs, one hive, zero second-class citizens

This is the headline, so let's not bury it: **Codex just got full hive parity.**

Last month we made the floor multi-provider. Claude Code agents got joined by **Antigravity** workers (Gemini, via the `agy` CLI) with a real hook bridge. **Codex** tagged along too — it could send and receive hive mail, but it wasn't *fully* in the club. It got its mail through a polite little "hey, check your inbox" nudge instead of a native hook path. Accurate. Honest. Also kind of a vibe of "you can sit with us, just not at the cool table."

That's over. v0.2.4 gives **Codex a full lifecycle-hook bridge** — the exact same integration Antigravity has had since day one. `agy` and `codex` now run down one unified dispatch path. Live status on the floor, inbox drain, outbox routing — all three providers, all identical.

The best part? **you don't pay for any of it twice.** No API keys. Munder Difflin just drives the CLIs you already have:

- **Claude Code** — your Claude subscription. The OG. Still the recommended pick for the GOD orchestrator (extended context + reasoning depth = good boss energy).
- **Antigravity** — your Antigravity subscription. Gemini's strengths, full hive participant.
- **Codex** — your OpenAI subscription. Codex's coding focus, same hook bridge as everyone else.

Drop the CLIs you want on your `PATH`, add them as workers, done. Mix and match however you like. The hive layer underneath is the same no matter who's running.

## the real flex: automate basically anything in *one prompt*

Here's where it stops being a tech demo and starts being a thing you actually use.

> **wanna get your PRs reviewed but the SaaS bots want $$$ a seat?** spin up your own CodeRabbit-style reviewer for any repo — in ONE prompt.

This isn't hypothetical. We did exactly this on our own repo when it blew up to 400+ stars and the PRs started stacking faster than anyone could read diffs. One message to **Michael** (yeah, the god orchestrator is named Michael — the floor looks like *The Office*, more on that in a sec):

> *Review all the open PRs on the GitHub repo, and set up a recurring mission that checks for new PRs every hour and reviews them.*

That was the whole instruction. Five PRs got detailed reviews in a single run, and an hourly mission now reviews new ones hands-free. [Here's the full story →](/blog/one-prompt-automated-pr-review/)

That's the pattern for everything. You describe the outcome, the hive figures out the how.

## the whole menu (every feature, no fluff)

skim this. find your pain. there's a one-prompt fix for it:

- **🤝 multi-provider** — Claude Code + Codex + Antigravity, full parity. bring whoever.
- **🔌 zero setup** — no API keys, no config marathon. it runs the CLIs + subscriptions you already pay for.
- **🧠 it actually remembers** — a shared memory layer (MemPalace) the whole floor reads from. it remembers what you told it last week, and recalls it in milliseconds.
- **📬 the agents talk to each other** — a file-based inbox/outbox mailbox protocol. agents hand work off, ask each other questions, and coordinate without you micromanaging.
- **🧑‍💼 one boss you just talk to** — the GOD orchestrator routes work to specialists, stays autonomous, and only taps you on the shoulder for the stuff that matters (spending money, destructive ops, scope changes).
- **💬 trigger it from Slack (or any webhook)** — kick off agents from your phone mid-commute. it replies in the thread when it's done.
- **⏰ schedules** — set it and forget it. "every hour, do X." you write it once, it runs forever.
- **📊 monitoring + token budget** — live token meters and a per-agent budget so one over-eager agent can't quietly torch your bill.
- **🌙 runs for days** — close the lid. lock the screen. it keeps grinding.
- **🏢 it looks like *The Office*** — every agent is a little pixel coworker on a watchable floor. yes, that's Michael. yes, Creed is here too.

Now the ones worth a few extra words:

### 💬 your office, reachable from your phone

Your hive shouldn't only exist in one window on one laptop. Send a message in **Slack** — or POST to a secure, opt-in **webhook** — and the GOD orchestrator grabs it as a task, routes it, runs it, and **replies right back in the thread** when it's done.

> standing in line for coffee, remember a bug? text your office. by the time you've got your oat milk latte, there's a reply in the thread.

It's **off by default** until you switch it on, the public ingress just works (POSTs pass straight through, and a broken tunnel surfaces a real error instead of pretending it started). Wire it into CI, hand work to it from another system, or just run it from your couch.

### ⏰ set it and forget it

Recurring missions are the thing you didn't know you needed. "Check for new PRs every hour and review them." "Summarize the new issues every morning." You describe the cadence once and the hive just *does it* — no cron file to babysit, no script to maintain. Pair that with the token budget and you've got autonomy that won't surprise you on the bill.

### 🌙 close the lid, it keeps working

This is the one people don't believe until they see it. When agents are mid-turn and your machine tries to sleep or lock, Munder Difflin holds the line (it blocks app suspension while work is live) so a long mission doesn't get guillotined the moment your screen dims. Start something big, walk away, come back to it done. **Overnight runs are a feature, not a gamble.**

### 🏢 yes, it really looks like *The Office*

The whole point of a floor is that you can *watch* it. Every agent is a real terminal under the hood — `claude`, `agy`, or `codex` — rendered as a little pixel coworker doing its thing. The cast is an affectionate *Office* parody (Michael runs the floor; the rest of the gang fills the desks), they take coffee breaks when idle, and you can see at a glance who's working, who's thinking, and who's stuck. It's genuinely fun to leave running on a second monitor. Identity theft is not a joke, Jim.

## also new in 0.2.4 (the quiet reliability glow-up)

The stuff that doesn't get a headline but makes the floor feel solid:

- **Heartbeat re-engage fix** — the GOD orchestrator now wakes up the *instant* actionable mail lands, not just on a quiet floor. Worker and human messages get drained promptly instead of waiting for the next beat.
- **God opens to its Terminal by default** — selecting the orchestrator mounts straight to its terminal instead of reopening a stale "ASK ME" tab. (ASK ME is still one click away.)
- **Tougher public ingress** — the Slack/webhook tunnel no longer crashes at load, and a permanently-failing Slack reply (like a bot token missing a scope) gets logged once instead of retrying forever and spamming your console.

## get v0.2.4

Munder Difflin is **free, open source, and local-first** on macOS, Windows, and Linux. No account. No cloud. Your machine, your subscriptions, your floor.

[**Download v0.2.4**](https://github.com/chaitanyagiri/munder-difflin/releases/latest) — install the CLIs you want (`claude`, `agy`, and/or `codex`), add them to the floor, and brief your first GOD orchestrator.

Want the deep dive on *how* every piece works? That's the [technical walkthrough](/blog/munder-difflin-v0-2-4-feature-walkthrough/). Full release notes live in the [CHANGELOG](https://github.com/chaitanyagiri/munder-difflin/blob/main/CHANGELOG.md).

That's it. Go build a floor.

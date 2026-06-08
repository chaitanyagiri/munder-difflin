---
title: "Launching Munder Difflin v0.2.4"
description: "Munder Difflin v0.2.4 gives Codex a full lifecycle-hook bridge — the same hive parity Antigravity has had since day one. Claude Code, Antigravity, and Codex are now equally first-class."
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
    a: "v0.2.4's headline is full Codex hive parity: Codex now has a lifecycle-hook bridge — the same integration Antigravity has had since v0.2.3. It also ships a heartbeat re-engage fix so the GOD orchestrator re-engages on unread actionable inbox items, and god now opens the Terminal sidebar by default."
  - q: "What does Codex full hive parity mean?"
    a: "In v0.2.3, Codex was inbox-capable but not fully hive-aware — it used an idle inbox-wake nudge for delivery. In v0.2.4, Codex has a real lifecycle-hook bridge that unifies agy and Codex dispatch. Both CLIs go through the same hook pipeline: live status, inbox drain, and outbox routing work identically for all three providers."
  - q: "Do I need an API key for Antigravity or Codex?"
    a: "No. Antigravity runs on your Antigravity subscription (Gemini via the agy CLI). Codex runs on your OpenAI subscription (via the codex CLI). Munder Difflin drives the CLIs you already have — it doesn't replace them or require separate API credentials."
  - q: "Can I mix Claude Code, Antigravity, and Codex in the same hive?"
    a: "Yes. All three are first-class hive participants. You can run Claude Code as the GOD orchestrator while Antigravity and Codex workers handle tasks — all sharing one inbox system, one shared memory, and one coordination layer."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p><strong>Munder Difflin v0.2.4</strong> closes the loop on multi-provider. Codex now has a <strong>full lifecycle-hook bridge</strong> — the same hive parity Antigravity has had since day one. Claude Code, Antigravity (Gemini · <code>agy</code>), and OpenAI Codex are now equally first-class. Three CLIs. One hive. No second-class citizens.</p></div>

Last month, we made the floor multi-provider. Claude Code agents were joined by Antigravity workers — Gemini running through the `agy` CLI — with a full hook bridge, shared mailboxes, and live status on the floor. Codex came along too, inbox-capable, able to receive and send hive mail.

That was v0.2.3. It was big. It wasn't done.

**Today is v0.2.4. Today, it's done.**

## The headline: Codex gets a real bridge

In v0.2.3, Codex was "non-hive-aware-but-inbox-capable." That phrase was accurate and honest. It was also a polite way of saying Codex was the third provider but not quite the third *equal* provider. It used an idle inbox-wake nudge for delivery — a clever workaround, not a native hook path.

That changes today.

**v0.2.4 gives Codex a full lifecycle-hook bridge** — the same integration Antigravity has had since day one. Codex and Antigravity now go through one unified dispatch path. Live status, inbox drain, outbox routing — all three providers, all working identically.

Not "inbox-capable." Not "mostly there." **Full hive parity.**

This is the v0.2.4 headline. Everything else is polish on top of a now-complete foundation.

## What full hive parity means

When you add a Codex worker to the floor in v0.2.4:

- Its lifecycle events flow through the same hook bridge as Antigravity and Claude Code.
- Its status on the office floor updates live — running, thinking, idle — the same way.
- Mail from other agents lands in its inbox and drains when it's idle — not via a nudge, but through the native hook path.
- Its outbox is drained by the provider-agnostic router, same as everyone else.

The dispatch path is unified. `agy` and `codex` go through the same bridge code. The provider union is complete.

You don't have to think about which agent is which CLI. You brief the GOD orchestrator, it routes the work, the agents run. Whether the floor has a Claude Code researcher, an Antigravity writer, and a Codex builder — or any other combination — the hive layer underneath them is identical.

## The floor is multi-provider, for real

Here's what the complete picture looks like.

**Claude Code** has always been the foundation. Full hook lifecycle, `--append-system-prompt`, settings integration. The hive was built for it. It remains the recommended choice for GOD — orchestrators benefit from Claude's extended context and reasoning depth.

**Antigravity** (Gemini via `agy`) joined in v0.2.3 with a native hook bridge. Your Antigravity subscription. Gemini's strengths. Full hive participant. No separate API key.

**Codex** (OpenAI via `codex`) was inbox-capable in v0.2.3. In v0.2.4, it is a full hive participant. Your OpenAI subscription. Codex's coding focus. The same hook bridge as Antigravity.

Three CLIs. Three subscriptions you already have. One floor. One memory. One GOD you talk to.

Install the CLIs you want on your `PATH`. Add them as workers. The hive handles the rest.

## Reach your hive from Slack — or any webhook

Your office shouldn't only live in one window. Send a message in **Slack** — or POST to a secure, opt-in **webhook** — and the GOD orchestrator picks it up as a task, routes it, runs it, and replies right back in the thread when it's done.

Kick off a job from your phone, wire it into CI, or let another system hand work to the hive. The public ingress just works — POSTs pass straight through, a failed tunnel surfaces a real error instead of pretending it started, and the whole thing stays off by default until you switch it on. Your hive, reachable from the tools you already use.

## Also in v0.2.4

Two smaller things that make the floor more reliable.

**Heartbeat re-engage fix.** The GOD orchestrator's adaptive heartbeat now re-engages when there are unread actionable inbox items. Previously, the heartbeat would fire on schedule but could miss the case where god had mail waiting and nothing had triggered re-engagement. This is fixed: the heartbeat checks for and acts on unread items before cycling.

**Terminal sidebar open by default.** The GOD orchestrator now opens with the Terminal sidebar visible from the start. You've always been able to open it — now you don't have to remember to.

## The full picture

Munder Difflin started as a harness for Claude Code agents. The idea was: give terminal agents a shared memory, mailboxes, a router, and one orchestrator you can talk to while the team keeps working.

That idea has never been Claude-specific. The orchestrator works because it coordinates. The memory works because it's shared. The routing works because it's provider-agnostic.

v0.2.4 is the release where the implementation catches up to the idea. Three CLIs, three subscriptions, one hive — and all three providers are genuinely, completely equal inside it.

## Get v0.2.4

Munder Difflin is free, open source, and local-first on macOS, Windows, and Linux.

[Download v0.2.4](https://github.com/chaitanyagiri/munder-difflin/releases/latest) — install the CLIs you want (`claude`, `agy`, and/or `codex`), add them to the floor, and run the multi-provider office you've been building toward.

Full release notes are in the [CHANGELOG](https://github.com/chaitanyagiri/munder-difflin/blob/main/CHANGELOG.md). The technical walkthrough of every v0.2.4 change is in the [feature guide](/blog/munder-difflin-v0-2-4-feature-walkthrough/).

---
title: "Munder Difflin v0.2.4 Feature Walkthrough"
description: "A comprehensive guide to every change in Munder Difflin v0.2.4 — how the Codex lifecycle-hook bridge achieves full hive parity, what the Schedules tab adds, why tunnelmole replaced localtunnel, and what else shipped."
date: 2026-06-09
category: guides
categoryLabel: Guides
type: Technical
primaryKeyword: "munder difflin v0.2.4 features"
secondaryKeywords: ["codex lifecycle hook bridge", "antigravity gemini hive", "agy hook bridge", "claude code multi-provider", "schedules tab command center", "codex full hive parity"]
tags: ["Release", "Multi-Agent", "Claude Code", "Codex", "Guides", "Internals"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "How does Antigravity join the hive without Claude-style hooks?"
    a: "Antigravity (agy) has no --append-system-prompt or settings hooks, so the hive injects the identity and protocol as the session's initial prompt and uses a native agy-hook bridge to normalize Antigravity's lifecycle events into the existing hook pipeline."
  - q: "How does Codex achieve full hive parity in v0.2.4?"
    a: "v0.2.4 gives Codex a full lifecycle-hook bridge — the same integration Antigravity has had since v0.2.3. Both CLIs now go through one unified dispatch path: live status, inbox drain, and outbox routing work identically for Codex, Antigravity, and Claude Code."
  - q: "What is the WORK ORDER FROM HIVE terminal handoff?"
    a: "When an agent's CLI has no inbox-drain path (no hook bridge, no idle-wake nudge), the hive types a structured WORK ORDER FROM HIVE message directly into the terminal. If the renderer is unavailable, the message bounces to the GOD agent instead of being dropped."
  - q: "Why did localtunnel stop working for Slack and webhooks?"
    a: "loca.lt began serving a browser interstitial on all requests. That interstitial causes Slack's url_verification POST to fail and breaks saved webhook URLs silently. tunnelmole (MIT) passes POSTs straight through and is now used in both slack.ts and webhook.ts."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p><strong>v0.2.4</strong> completes the multi-provider story. This walkthrough covers every change in detail: the <strong>Codex lifecycle-hook bridge</strong> that brings Codex to full hive parity, the <strong>Antigravity agy-hook bridge</strong>, the <strong>terminal WORK ORDER handoff</strong> pattern, the new <strong>Schedules tab</strong>, the <strong>tunnelmole</strong> ingress switch, plus smaller fixes including the heartbeat re-engage fix, god's Terminal sidebar default, Windows spawn, and the task-board dismiss button.</p></div>

The [launch post for v0.2.4](/blog/launching-munder-difflin-v0-2-4/) covers what changed and why it matters. This post covers *how* it works — the mechanics behind each feature, what the code actually does, and what it means to use each one in practice.

## The multi-provider challenge

The goal: Claude Code, Antigravity (Gemini via `agy`), and Codex all working as first-class hive participants in the same office. The challenge: every CLI exposes a different control surface, so each provider needs a different integration approach — and that approach should converge toward parity, not just "good enough."

**Claude Code** is the baseline. It has `--append-system-prompt`, `--settings`, and a full hook lifecycle: `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `PreCompact`, and more. The hive was built around this surface from the start. Hook signals drive live status, the circuit breaker, inbox drain, and compaction — all of it.

**Antigravity** (`agy`) has none of that. No `--append-system-prompt`. No settings-file hooks. So the Antigravity integration takes a provider-specific route: protocol injection + a native hook bridge that normalizes Antigravity's lifecycle events into the existing pipeline.

**Codex** also has no Claude-style hooks. In v0.2.3, it used protocol injection and an idle inbox-wake nudge — useful, but not a real hook bridge. **v0.2.4 changes that.** Codex now has the same lifecycle-hook bridge as Antigravity, and both go through one unified dispatch path.

## Antigravity: initial prompt injection + agy-hook bridge

The Antigravity integration has two parts.

**Protocol injection.** Because `agy` exposes no `--append-system-prompt` equivalent, the hive identity and protocol ride in as the session's *initial prompt* — the first text submitted to the agent terminal after boot. This is the same content Claude Code agents receive through `--append-system-prompt`, just delivered differently: typed into the terminal by the harness once the session is ready.

**The agy-hook bridge.** Antigravity does emit its own lifecycle events, but in a different shape from Claude Code hooks. The `agy-hook` bridge normalizes those events into the existing hook pipeline — translating Antigravity's signals into the `PreToolUse`, `PostToolUse`, `Stop` events the rest of the system already understands.

The practical result: an Antigravity worker gets the same live status updates on the floor, the same inbox-drain behavior, and the same circuit-breaker signals as a Claude Code worker. The provider is different; the participation is the same.

## Codex: full lifecycle-hook bridge (v0.2.4)

In v0.2.3, Codex was "non-hive-aware-but-inbox-capable." It used protocol injection at spawn and an idle inbox-wake nudge for mail delivery — a working fallback, but not a native hook path.

**v0.2.4 gives Codex a real lifecycle-hook bridge.** This is the headline change.

The bridge unifies `agy` and `codex` dispatch. Both CLIs now go through the same hook-bridge code path — the same one that normalizes Antigravity's events. When Codex emits a lifecycle event, the bridge translates it into the hook pipeline the rest of the system understands. Live status, inbox drain, outbox routing — all working through the native path, not a workaround.

The practical result:

- Codex's status on the floor updates live — running, thinking, idle — through hook signals, not polling.
- Mail lands in a Codex agent's inbox and is drained when it's idle, through the same inbox-drain path as Claude Code and Antigravity.
- Outbox messages are picked up by the provider-agnostic router, same as before.

Codex is no longer the third provider with an asterisk. It's a full hive participant.

{% img "note-1" %}

## Terminal work orders: the WORK ORDER FROM HIVE pattern

Both Antigravity and Codex now have full hook bridges. But the multi-provider work raised a broader question: what should happen when a future provider has *no* inbox-drain path at all — no hook bridge, no idle-wake nudge — and you still need to get hive mail to it?

The answer is a structured fallback: the hive types a `WORK ORDER FROM HIVE` message directly into the agent's terminal. The message is clearly labeled, delivered as terminal input, and actionable by any CLI that can read what's in its terminal. If the renderer is unavailable at the time mail arrives, the router bounces the message to the GOD agent rather than dropping it silently.

This pattern is honest about what the provider can and cannot do. If a CLI doesn't expose a mailbox path, typing into the terminal is exactly what a human operator would do. The work-order pattern makes that systematic and auditable instead of ad-hoc. It remains the fallback for any provider that doesn't have a hook bridge yet.

## Schedules tab

Scheduled missions have been in Munder Difflin since v0.1.6. The scheduler fires recurring missions on a configurable interval — hourly standups, PR reviews, compaction cycles, re-engagement checks for quiet workers. Until v0.2.3, these lived inside an inline section of the Floor tab.

The move to a **dedicated Schedules tab** in the Command Center is a small surface change with a real day-to-day effect. When you're running a persistent office with multiple recurring missions — and most meaningful setups do — those missions need a place to live that isn't nested inside the agent roster view. The Schedules tab now owns:

- **Recurring auto-dispatched missions:** every mission you've defined, with its interval, target, and last-fired time.
- **The adaptive heartbeat:** the floor's re-engagement signal for quiet or idle agents, previously embedded in the same inline section.
- **A boss-room calendar shortcut:** quick access to the schedule overview from the Command Center header.

The underlying `ScheduledMission` data structure and scheduler logic are unchanged — the interval fires, the message drops into the target's inbox, the agent picks it up like any other mail. The tab change is about making schedules a first-class control surface rather than a secondary one.

## Heartbeat re-engage fix

The GOD orchestrator's adaptive heartbeat now re-engages when it has unread actionable inbox items. Previously, the heartbeat fired on schedule but could miss the case where god had mail waiting and nothing had triggered re-engagement — leaving actionable items sitting unread until the next scheduled tick.

The fix is straightforward: the heartbeat checks for unread actionable inbox items before cycling, and re-engages if it finds any. GOD no longer needs an external trigger to notice mail that arrived between heartbeat cycles.

## Terminal sidebar open by default

The GOD orchestrator now opens with the Terminal sidebar visible from the start. You've always been able to open it — now you don't have to remember to. For most workflows, seeing god's terminal output immediately is the right default.

{% img "note-2" %}

## Slack + webhook: tunnelmole replaces localtunnel

The Slack and webhook ingress paths used `localtunnel` / `loca.lt` to expose the local server to the public internet. This allowed Slack's URL verification handshake to succeed and kept incoming webhook deliveries working.

The problem: `loca.lt` began serving a browser interstitial on all outbound requests. For a human browsing a URL, an interstitial is annoying but navigable. For Slack's `url_verification` POST — a machine-to-machine request with a specific payload and a strict response format — it is fatal. The handshake fails silently. Saved webhook URLs break. And critically, the app reported "tunnel started" with no indication that the URL it gave you would reject all incoming requests.

Both `slack.ts` and `webhook.ts` now use **tunnelmole** (MIT-licensed). tunnelmole passes POST requests straight through without an interstitial. Two other behaviors changed:

1. **Startup failure surfaces as a real error.** If tunnelmole fails to bind or returns no URL, the app now logs an actionable error instead of silently reporting a successful (but broken) start.
2. **The URL is stable per session.** tunnelmole's URL is the actual address Slack or an external system should call — no browser challenge before the POST lands.

If you had a saved Slack webhook URL pointing at a loca.lt address, update it to the new tunnelmole URL after the upgrade. The app will surface the correct address on startup.

## Windows spawn fix

Windows agent spawn has been iteratively improved across the v0.1.x and v0.2.x releases — from the original ENOENT binary-resolution fix in v0.1.8 to the lock-screen freeze fix in v0.2.0. A further Windows spawn fix (#22) addresses a specific spawn failure path for GOD orchestrator startup on Windows. If you were seeing GOD fail to initialize on Windows in previous builds, this release resolves it.

## Dismiss (✕) on task-board cards

The task kanban board (Command Center → Tasks) now has a dismiss button on each card. Previously, cards in the `done` column accumulated indefinitely — useful for audit purposes, but increasingly noisy in a busy office. The ✕ button removes a card from view without deleting the underlying task record. A clean board is easier to work from; this makes keeping it clean a one-click operation.

## What ships with v0.2.4

Everything from v0.2.0 (observability, circuit breaker, fleet monitoring, persistence), v0.2.1 (queue-aware compaction, inbox-driven heartbeat), v0.2.2 (context gauges, all-human-dispatch-through-god, community fixes), and v0.2.3 (multi-provider foundation, Schedules tab, tunnelmole) is included. The full log is in the [CHANGELOG](https://github.com/chaitanyagiri/munder-difflin/blob/main/CHANGELOG.md).

To use the new providers: install the relevant CLIs (`agy` for Antigravity, `codex` for OpenAI Codex) and put them on your `PATH`. When you add a worker in the Add Agent dialog, select the provider. The hive handles the rest.

Download v0.2.4 from the [releases page](https://github.com/chaitanyagiri/munder-difflin/releases/latest). Munder Difflin is free, open source, and local-first on macOS, Windows, and Linux.

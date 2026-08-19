---
title: "Make a Hive Work While You Sleep: Scheduling Autonomous Agent Missions"
description: "How scheduled missions make a Claude Code hive work on a cadence — recurring requests that fire on an interval and land in an agent's queue, hands-free."
date: 2026-06-04
category: orchestration
categoryLabel: Orchestration
type: Technical
primaryKeyword: "scheduled agent missions"
secondaryKeywords: ["recurring autonomous tasks", "schedule ai agents", "cron for ai agents"]
tags: ["Orchestration", "Automation", "Autonomous", "Hive"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What is a scheduled mission in a multi-agent harness?"
    a: "A scheduled mission is a recurring instruction the harness fires on a fixed interval. Each tick it sends a request message to a target agent — a specific one or the whole hive — so work happens on a cadence without anyone typing a prompt. Think cron, but the job is an agent task."
  - q: "How is a scheduled mission different from an autonomous loop?"
    a: "An autonomous loop keeps one agent going until its queue is empty. A scheduled mission refills that queue on a timer. The loop is the engine; the schedule is the alarm clock. Together they let a hive pick up fresh, recurring work on its own and then run each piece to completion."
  - q: "Do scheduled missions run when the app is closed?"
    a: "No. The timers live in the desktop app's process, so missions only fire while it's open — this is local-first, not a cloud cron. But each mission remembers when it last fired, so on the next launch an overdue mission fires right away and the cadence resumes instead of resetting."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>A <strong>scheduled mission</strong> is a
recurring instruction the harness fires on an interval: each tick it drops a <code>request</code> into
a target agent's queue, so a hive does standups, audits, or nightly reports <strong>without you typing
a prompt</strong>. It pairs with the <a href="/blog/claude-code-automation-while-you-sleep/">autonomous
loop</a> — the loop keeps an agent working until its queue is empty, the schedule refills the queue on
a cadence. Missions remember when they last fired, so restarts resume the rhythm instead of resetting
it.</p></div>

There's a difference between an agent that works *when you ask* and a hive that works *on a schedule*.
The first still needs you at the keyboard. The second wakes itself up — runs a standup every hour,
audits the build every night, summarizes new issues every morning — and only pulls you in when
something actually needs a human. Munder Difflin ships this as **scheduled missions**, and this guide
walks through how they work, grounded in the real code, plus the patterns that keep them useful instead
of noisy.

## What a mission actually is

A mission is a small, persisted record. In `src/main/config.ts` it's a `ScheduledMission`:

```ts
interface ScheduledMission {
  id: string;
  label: string;       // shows up as the message subject
  intervalMs: number;  // the cadence
  to: string;          // target: an agent id, or 'broadcast'
  body: string;        // the instruction the agent receives
  enabled: boolean;
  lastFiredAt?: number; // scheduler-owned; when it last ran
}
```

Missions live in the harness config under a `missions[]` array, so they survive restarts. That's the
whole data model — no DAG, no external job store. A mission is "send *this* instruction to *this*
target, every *this often*."

## How the scheduler fires

The engine is `syncMissions()` in `src/main/index.ts`. It runs on boot (right after the message router
starts) and again after any change to your missions. Each run it does two things: clear every existing
timer, then arm a fresh timer for each enabled mission. Clearing first is what makes editing one
mission safe — nothing gets double-armed.

When a mission's timer fires, the `fire()` callback does exactly two things:

```ts
if (hive.enabled()) {
  hive.send({ to: m.to, act: 'request', subject: m.label, body: m.body }, 'scheduler');
}
// then stamp lastFiredAt = Date.now() back into config
```

That's the heart of it. A mission tick is just a `request` message, sent **from `scheduler`**, that
lands in the target agent's inbox like any other message. The agent reads it at the start of its next
turn and acts. There's nothing special about a scheduled task once it's in the queue — which is exactly
why it composes so cleanly with the rest of the hive.

This very post is proof. It exists because an **"Hourly Standup" mission** fired: a request, from
`scheduler`, broadcast to every agent, asking each to report status and pick up work. No one typed that
prompt this hour. The schedule did.

{% img "note-1" %}

## Why `lastFiredAt` matters

The one piece of cleverness worth understanding is `lastFiredAt`. A naive scheduler would restart every
interval from zero whenever the app reboots or you edit an unrelated mission — so an hourly job could
drift, double-fire, or never fire if you kept tweaking things. Instead, the harness computes how much
time is actually left:

```ts
const remaining = Math.max(0, m.intervalMs - (Date.now() - (m.lastFiredAt ?? 0)));
setTimeout(() => { fire(); setInterval(fire, m.intervalMs); }, remaining);
```

It waits only the time *remaining* until the next due fire, then settles into a steady interval. If a
mission is overdue (you closed the app over lunch), `remaining` is `0` and it fires right away on the
next launch. The cadence resumes; it doesn't reset. And because the renderer can never overwrite the
scheduler's `lastFiredAt` — `missions:save` merges by id and keeps the newer value — editing a
mission's text in the UI won't accidentally rewind its clock.

On shutdown, `clearMissionTimers()` tears down every pending `setTimeout` and `setInterval`, so a tick
can never fire into half-torn-down services during quit. The result is a scheduler that's boring in the
best way: it survives restarts, edits, and quits without surprising you.

## Good patterns

A scheduler that fires the same instruction forever rewards a particular style of mission.

- **Write idempotent bodies.** Because a mission runs again and again, its instruction should be safe to
  repeat. "Post a standup," "audit the latest build," "summarize new issues since the last run" are
  great. "Create the project" is not — it'd duplicate every tick. Phrase the body as a recurring verb,
  not a one-time setup.
- **Match cadence to how fast reality changes.** `intervalMs` is your rhythm. An hourly standup, a
  nightly report, a weekly retro — pick the interval from the underlying state, not from a vague sense
  that "more often is better."
- **Target a coordinator for fan-out work.** Sending a "gather status and assign tasks" mission to
  [the orchestrator](https://munderdiffl.in/#how) lets one coordinator decide and delegate, instead of
  blasting an identical instruction at every agent. The orchestrator is built for exactly this routing.
- **Pause with `enabled`, don't delete.** Flip `enabled: false` to stop a mission while keeping its
  history and `lastFiredAt`. You can switch it back on later and the cadence picks up cleanly.

{% img "note-2" %}

## Pitfalls to avoid

- **Flooding the hive.** The scheduler will fire as often as you tell it to — restraint is on you. A
  one-minute mission to `broadcast` will bury every agent's inbox and burn tokens fast. If agents can't
  finish before the next tick, the interval is too short.
- **Non-idempotent instructions.** A body that assumes it's running for the first time will create
  duplicates on every fire. Always read a mission body as "what should happen *each time*."
- **Expecting an interrupt.** A mission is a queued `request`, not a signal that stops what an agent is
  doing. If the target is mid-task, the mission waits its turn — usually fine, but know it isn't
  instant.
- **Forgetting it's local-first.** Timers live in the app's process, so missions only fire while the
  desktop app is open. That's a deliberate trade for a tool you run on your own machine — and
  `lastFiredAt` softens it by firing overdue missions on the next launch. If you need firing while the
  laptop is shut, that's a cloud cron's job, not this one.

## Where it fits

Scheduled missions are the alarm clock; the [autonomous
loop](/blog/claude-code-automation-while-you-sleep/) is the engine that keeps an agent running until
its queue is empty; the [message router](/blog/coordinating-ai-coding-agents/) is the nervous system
that delivers each tick. Put them together and a hive becomes genuinely self-driving on the recurring
work: it wakes up on schedule, routes the task through [the orchestrator](/blog/how-the-god-orchestrator-works/),
runs it to completion, and escalates to you only when a decision is genuinely yours to make.

## FAQ

**What is a scheduled mission?** A recurring instruction the harness fires on a fixed interval. Each
tick it sends a `request` message to a target agent (or the whole hive via `broadcast`), so work
happens on a cadence with no prompt from you.

**How is it different from an autonomous loop?** The loop keeps a single agent working until its queue
is empty; the schedule refills that queue on a timer. The loop is the engine, the mission is the alarm
clock — they're complementary, not competing.

**Do missions fire when the app is closed?** No — the timers run inside the desktop app's process, so
it's local-first, not a cloud cron. But each mission records `lastFiredAt`, so an overdue mission fires
immediately on the next launch and the cadence resumes instead of resetting.

**How do I stop a mission without losing it?** Set `enabled: false`. It stays in your config with its
history intact, and you can re-enable it later without rewinding the clock.

---

Munder Difflin runs exactly this: a local hive of Claude Code agents that picks up recurring work on a
schedule, routes it through [a GOD orchestrator](https://munderdiffl.in/#how), and pings you only for
the calls that matter. [Download Munder Difflin](https://munderdiffl.in/#install) to set your first
mission and watch the floor wake itself up; it's free and open source.

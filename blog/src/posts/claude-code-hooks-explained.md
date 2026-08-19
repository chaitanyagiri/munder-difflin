---
title: "Claude Code Hooks, Explained (PreToolUse, PostToolUse, Stop)"
description: "A practical tour of Claude Code hooks — the PreToolUse, PostToolUse, and Stop lifecycle — and how a Unix-socket hook shim drives a live office floor."
date: 2026-06-03
category: internals
categoryLabel: Internals
type: Technical
primaryKeyword: "claude code hooks"
secondaryKeywords: ["pretooluse posttooluse", "stop hook", "claude code lifecycle"]
tags: ["Internals", "Hooks", "Claude Code", "Automation"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What are Claude Code hooks?"
    a: "Hooks are commands Claude Code runs at points in its lifecycle — before and after a tool call, when it's about to stop, on a notification, and more. Each hook receives a JSON payload on stdin and can return JSON to influence what Claude does next."
  - q: "What does the Stop hook do?"
    a: "The Stop hook fires when Claude is about to finish a turn. If it returns {\"decision\":\"block\",\"reason\":...}, Claude keeps working with that reason as new instructions — which is how you build an autonomous loop. A stop_hook_active flag prevents it from looping forever."
  - q: "Do hooks modify my repository?"
    a: "They don't have to. Claude Code accepts a --settings file, so you can attach hooks from a settings file outside your project instead of editing files in the repo itself."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p><strong>Claude Code hooks</strong> are
commands that run at lifecycle points — <code>PreToolUse</code>, <code>PostToolUse</code>,
<code>Stop</code>, <code>Notification</code>, and more. Each gets a JSON payload on stdin and can
return JSON to steer Claude. Munder Difflin attaches a tiny <strong>hook shim</strong> via
<code>--settings</code> that forwards every event to the harness over a Unix socket — driving live
avatars from <code>PreToolUse</code>/<code>PostToolUse</code>, and building an <strong>autonomous
loop</strong> out of the <code>Stop</code> hook.</p></div>

Hooks are the most underrated part of Claude Code. They're the official extension point for "do
something when Claude does something" — and once you understand them, a lot of agent tooling that
looks like magic turns out to be a well-placed hook. This post walks the lifecycle, then shows exactly
how Munder Difflin uses hooks to animate a multi-agent office floor and keep agents working
autonomously.

## What a hook is

A hook is a command Claude Code runs at a defined moment in its lifecycle. When the moment arrives,
Claude executes your command and pipes it a **JSON payload on stdin** describing what's happening. Your
command can do whatever it likes, and — for some events — return **JSON on stdout** that influences
Claude's next move.

You configure hooks in settings, mapping each event to one or more commands:

```jsonc
{
  "hooks": {
    "PreToolUse":  [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node my-hook.js" }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node my-hook.js" }] }],
    "Stop":        [{ "hooks": [{ "type": "command", "command": "node my-hook.js" }] }]
  }
}
```

The `matcher` (for tool events) lets you scope a hook to specific tools — `*` means "every tool." Tool
events carry that matcher; lifecycle events like `Stop` don't need one.

{% img "note-1" %}

## The lifecycle events that matter

There are several hook events; these are the ones you'll reach for most.

### PreToolUse

Fires **before** Claude runs a tool. The payload includes the `tool_name` (e.g. `Edit`, `Bash`) and
the `tool_input`. This is your "Claude is about to do X" signal. You can use it for observability, or —
because PreToolUse can return a decision — to gate or block a tool call before it runs.

### PostToolUse

Fires **after** a tool completes. Same shape, now with the result available. PostToolUse is the natural
place to react to what just happened: log it, update a UI, trigger a follow-up.

Together, PreToolUse and PostToolUse bracket every action Claude takes. If you want a faithful,
real-time picture of what an agent is doing, these two events are it — you're not scraping terminal
output or guessing, you're getting structured "about to / just did" events straight from Claude.

### Stop (and SubagentStop)

Fires when Claude is about to **finish a turn** — it's done and ready to hand control back. This is the
most powerful hook, because of what it can return:

```json
{ "decision": "block", "reason": "Here's what to do next…" }
```

Returning `block` tells Claude *not* to stop — to keep going, treating `reason` as fresh instructions.
That's the entire basis of an **autonomous loop**: every time the agent tries to finish, a Stop hook
can hand it more work. `SubagentStop` is the same event for a spawned subagent.

The obvious danger is an infinite loop, so the payload carries a `stop_hook_active` flag: it's true
when a previous Stop hook already blocked this turn. Check it, and you can guarantee you never block
twice in a row — the loop always has an exit.

### Notification, UserPromptSubmit, SessionStart

- **Notification** fires when Claude surfaces a message — including when it's idle and waiting for
  input, or asking permission. The payload's text lets you tell "needs you" apart from "just done."
- **UserPromptSubmit** fires when a prompt is submitted — a clean "the agent started working" signal.
- **SessionStart** fires when a session begins — handy for setup or registration.

## How Munder Difflin uses hooks

Munder Difflin runs many `claude` agents at once and needs two things from each: a live view of what
it's doing, and a way to keep it working through a queue. Both come from hooks.

### A hook shim over a Unix socket

The harness can't run heavy logic inside each hook invocation — hooks fire constantly and must be fast.
So each agent is launched with a **hook shim**: a tiny script wired to every relevant event. The shim
does almost nothing. It reads the hook payload on stdin, tags it with the agent's id (from an
environment variable), forwards it to the harness over a **Unix domain socket**, and relays the
response back to Claude. All the real logic lives in the harness's main process, which listens on that
socket.

```text
claude ──hook fires──▶ shim ──UDS──▶ harness (main process)
                         ▲                     │
                         └──── response ◀───────┘
```

The shim is deliberately dumb and crash-proof: if the socket isn't there or anything errors, it exits
cleanly and never blocks the agent. Newline-delimited JSON over the socket keeps the protocol trivial.

### Attached without touching your repo

A key detail: the hooks are attached with Claude Code's `--settings` flag, pointing at a settings file
the harness writes **outside** your project. Your repository is never modified to add hooks — no stray
`.claude/settings.json` diff, nothing to gitignore. The agent is hive-aware purely through launch
flags and environment variables.

### PreToolUse/PostToolUse → live avatars

Every tool event the harness receives is forwarded to the UI. That's what drives the office floor: when
an agent calls a file tool, its avatar walks to the right station; when it runs a command, it moves to
a terminal. Because the events are structured and come straight from Claude, the visualization reflects
*real* activity rather than a scripted animation or fragile log-scraping — and it pairs with each
agent's actual live terminal, [streamed without melting the CPU](/blog/rendering-many-live-terminals-performance/).

### Stop → the autonomous loop

This is where hooks earn their keep. When an agent's `Stop` hook fires, the harness checks that agent's
inbox for unread messages. If there are any, it returns `{"decision":"block","reason": <the
messages>}` — so instead of stopping, the agent reads its new messages and keeps working. If the inbox
is empty, it returns nothing and the agent is allowed to finish.

Two guards keep this safe:

- **`stop_hook_active`** — if a previous Stop already blocked this turn, the harness lets it stop, so
  it can never block twice back-to-back.
- **A per-agent cursor** — the harness tracks the last message id it surfaced, so each message is fed
  to the agent exactly once. No message is re-delivered, and the loop can't spin on stale mail.

The result is an agent that drains its work queue on its own and only goes quiet when there's genuinely
nothing left — the foundation of [letting agents build while you sleep](/blog/claude-code-automation-while-you-sleep/).
It's also how the [GOD orchestrator](/blog/how-the-god-orchestrator-works/) keeps the whole floor
moving: route a task into an agent's inbox, and its next Stop hook picks it up automatically.

{% img "note-2" %}

## Writing your own hooks: practical tips

If you're building with hooks directly, a few lessons that save pain:

- **Keep them fast.** Hooks run synchronously in Claude's path. Do the minimum and offload anything
  heavy (a socket forward, a queued job) rather than blocking.
- **Fail open.** A hook that errors shouldn't wedge the agent. Catch everything and exit cleanly.
- **Respect `stop_hook_active`.** Any Stop hook that can block must check this flag, or you'll build an
  infinite loop.
- **Use `--settings` for portability.** Attaching hooks via a settings file outside the repo keeps your
  project clean and lets you apply the same hooks to many sessions.

## FAQ

**Can a hook block a dangerous tool call?** Yes — PreToolUse can return a decision that prevents a tool
from running, which is useful for guardrails. Munder Difflin leans on its orchestrator and approval
queue for that judgment, but the hook-level gate is available.

**Do hooks slow Claude down?** Only as much as your hook command does. A shim that just forwards a
payload over a local socket adds negligible overhead, which is exactly why the heavy logic lives
elsewhere.

---

Munder Difflin turns Claude Code's hook lifecycle into [a live, autonomous office](https://munderdiffl.in/#how): real-time avatars
from tool events and a self-draining work loop from the Stop hook — all without editing your repo.
[Download Munder Difflin](https://munderdiffl.in/#install) to see hooks driving a hive of agents; it's
free and open source.

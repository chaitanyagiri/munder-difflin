---
title: "The Hook Shim Pattern: Wiring Agent Hooks to a Live Process"
description: "How a tiny shim bridges Claude Code's lifecycle hooks to one live process over a Unix socket, turning per-event hooks into a telemetry and control channel."
date: 2026-06-04
category: internals
categoryLabel: Internals
type: Technical
primaryKeyword: "claude code hook shim"
secondaryKeywords: ["claude code hooks architecture", "agent lifecycle hooks", "unix socket ipc agents"]
tags: ["Internals", "Claude Code", "Hooks", "Multi-Agent"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "Why not put the logic directly in the hook command?"
    a: "Because a hook is a per-event shell command, and burying real logic there means editing the user's repo settings, re-installing on every code change, and duplicating state across short-lived processes. A shim forwards the event to one long-running process that holds all the logic — so you change behavior in one place, and the hook config never has to move."
  - q: "What does the shim actually do?"
    a: "Almost nothing, on purpose. It reads the hook payload from stdin, tags it with the agent's id, opens a Unix-domain socket to the main process, writes the payload, relays the response back to stdout, and exits. Every failure path exits 0 so it can never crash the agent's turn."
  - q: "Can a hook do more than observe — can it steer the agent?"
    a: "Yes. Claude Code reads the hook's JSON response, so the main process can reply with a decision — for example {\"decision\":\"block\",\"reason\":\"...\"} on a Stop event to keep the agent working. That's how an autonomous inbox-drain loop is built, guarded so it can never loop forever."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>Claude Code fires <strong>lifecycle hooks</strong>
(Stop, PreToolUse, Notification…) as shell commands. Putting real logic in those commands is a trap —
it's per-event, lives in the user's repo, and can't share state. The <strong>hook shim pattern</strong>
fixes it: each hook runs a tiny shim that forwards its payload over a <strong>Unix-domain socket</strong>
to one long-running process holding all the logic. The shim is a dumb pipe that never crashes a turn; the
main process gets a live telemetry feed <em>and</em> a control channel back.</p></div>

[Claude Code hooks](/blog/claude-code-hooks-explained/) are a great extension point: at defined moments —
a tool is about to run, the agent stopped, a notification fired — Claude Code runs a shell command you
configure, hands it a JSON payload on stdin, and reads a JSON response from stdout. Simple and powerful.

The trap is doing the work *in* that command. If you're building something live — a UI that shows what
each agent is doing, an autonomous loop that re-engages an idle agent — a per-event shell script is the
wrong home for that logic. Here's the pattern we use instead, and why it holds up.

## Why logic-in-the-hook doesn't scale

A hook command has three problems as a place for real behavior:

- **It's short-lived.** Each event spawns a fresh process that dies immediately. There's nowhere to keep
  state — avatar status, a per-agent cursor, an event log — without re-reading it from disk every time.
- **It lives in the user's settings.** Hook config is attached to a session via `--settings`. Bake logic
  in and every code change means rewriting that config; it also can't easily reach your app's in-memory
  state.
- **It's risky.** A hook that throws or hangs can stall the agent. Logic and the agent's turn shouldn't
  share a failure mode.

You want the *trigger* to stay at the edge and the *logic* to live in one place. That's exactly what a
shim buys you.

## The shim: a dumb pipe

The harness writes a tiny script — `cth-hook.cjs` — into the hive directory and points every hook at it.
Its entire job is to forward:

```javascript
// read the hook payload on stdin, tag it, forward to the socket, relay the reply
const net = require('net');
let data = '';
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  const payload = JSON.parse(data || '{}');
  payload.agent_id ||= process.env.AGENT_ID;
  const sock = process.env.HIVE_SOCK;
  if (!sock) process.exit(0);
  const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\n'));
  let resp = '';
  c.on('data', (d) => { resp += d; });
  c.on('end', () => { if (resp) process.stdout.write(resp); process.exit(0); });
  c.on('error', () => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
```

Notice what it does *not* do: no decisions, no disk, no state. It tags the payload with the agent's id
(from an env var the agent was spawned with), opens a Unix-domain socket to the main process, writes one
line of JSON, and relays whatever comes back. And notice the guards — missing socket, connection error,
and a 5-second timeout all `exit(0)`. **The shim can never crash the agent's turn.** That's the contract.

{% img "note-1" %}

## All the logic lives in one process

On the other end, the app's main process listens on that socket and holds everything:

```javascript
const server = createServer((conn) => {
  let buf = '';
  conn.on('data', (d) => {
    buf += d.toString();
    const nl = buf.indexOf('\n');
    if (nl === -1) return;                 // wait for the full line
    const payload = JSON.parse(buf.slice(0, nl));
    conn.end(JSON.stringify(handle(payload)));
  });
});
server.listen(sockPath);
```

`handle()` is where the real work happens — and because it's one resident process, it can keep live state
the per-event hooks never could. PreToolUse / PostToolUse / Notification events drive each agent's avatar
on the [office floor](/blog/visualizing-ai-agents-pixijs/); the same feed can append to an
[event log](/blog/append-only-event-log-agents/). The hooks settings route all the relevant events
(`Stop`, `SubagentStop`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Notification`, `SessionStart`)
through the one shim, so the main process sees the whole lifecycle of every agent in real time.

## The real payoff: a control channel, not just telemetry

Because Claude Code reads the hook's JSON *response*, the shim isn't a one-way feed — it's a round trip.
The main process can answer. That's what turns observation into control.

The clearest example is the autonomous loop. When an agent hits `Stop`, the main process checks that
agent's [inbox](/blog/atomic-file-mailboxes-for-agents/). If a message is waiting, it replies with
`{"decision":"block","reason":"<the message>"}` — and Claude Code keeps the agent working to handle it
instead of going idle. An agent that another agent (or the [orchestrator](/blog/how-the-god-orchestrator-works/))
just messaged picks the work up on its own.

The danger with any "keep going" mechanism is an infinite loop, so the payload carries a `stop_hook_active`
flag: if a previous Stop already blocked this turn, the process lets the agent stop. Re-engage once, never
forever. A genuine stop with an empty inbox falls through to a desktop "idle" notification.

{% img "note-2" %}

## Why this pattern is worth copying

If you're wiring agent lifecycle hooks into anything stateful, the shim pattern gives you four things at
once: **decoupling** (refresh the shim from code on startup; the session's hook config never moves),
**a single source of truth** (one process, real in-memory state), **safety** (the edge can fail without
stalling the agent), and **a control channel** (reply with a decision, don't just log). The trigger stays
tiny and dumb; the brains stay in one testable place.

## FAQ

**Why a Unix socket and not HTTP?** It's local-only, fast, and needs no port or auth — the shim and the
app are on the same machine. The payload is one line of newline-delimited JSON, so framing is trivial.

**What happens if the main app isn't running?** The shim finds no socket (or fails to connect) and exits
0\. The agent's turn proceeds normally; you lose telemetry for that event, not the agent.

**Does this only work for Claude Code?** The pattern is general: any tool that runs a command per event
and reads a response can be bridged this way. Claude Code's hook payloads and decision response just make
it a clean fit.

---

Munder Difflin uses exactly this shim to drive a live office floor and an autonomous inbox-drain loop for a
whole [hive of Claude Code agents](https://munderdiffl.in/#how) — all local, with the agent's turn never
at the mercy of the bridge.
[Download Munder Difflin](https://munderdiffl.in/#install) to see it run; it's free and open source.

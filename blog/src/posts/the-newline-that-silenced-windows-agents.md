---
title: "The Newline That Silenced Every Windows Agent"
description: "A cmd.exe parsing rule from the 1980s meant Windows agents received exactly one line of their multi-line startup protocol — and nothing errored. The anatomy of our worst silent failure, and the fix."
date: 2026-08-19
category: internals
categoryLabel: Internals
type: Technical
primaryKeyword: "cmd.exe newline argument truncation"
secondaryKeywords: ["windows spawn npm cmd shim", "createprocess cmd.exe", "node spawn windows newline", "electron child_process windows", "npm shim decode"]
tags: ["Internals", "Windows", "Debugging", "node-pty", "Postmortem"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "Why did agent messaging fail only on Windows?"
    a: "On macOS and Linux, the multi-line hive protocol passes to the engine binary as one argv entry, newlines intact. On Windows, npm installs CLIs as .cmd shims, which can't go directly to CreateProcess — so the spawn ran through cmd.exe, and cmd.exe cuts an argument at its first newline. The agent got line one of its job description and nothing else."
  - q: "Why didn't anything error?"
    a: "Because nothing failed by any definition the code knew. The process spawned, the engine started, the agent answered prompts. The only casualty was the text after the first newline — which happened to contain everything about inboxes, outboxes, and memory. Truncation isn't an error; it's just less."
  - q: "How was it fixed?"
    a: "The spawner now reads the .cmd shim, extracts the real interpreter and script it points at, and launches that directly with an argv array — no cmd.exe in the path. A follow-up handled npm's interpreter-less shims for compiled binaries like OpenCode's. Anything undecodable falls back to the old path, but now logs what it couldn't decode."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>Windows agents booted, rendered, and
answered prompts — while never sending or receiving a single message. The cause: npm installs
CLIs as <code>.cmd</code> shims, <code>.cmd</code> files must run through <code>cmd.exe</code>,
and <strong>cmd.exe truncates an argument at its first newline</strong>. Our startup protocol is
multi-line. Every Windows agent got line one and lost the rest. Here's the full anatomy, because
this bug class is hiding in more codebases than ours.</p></div>

A huge share of the people who install Munder Difflin do it on Windows. For an uncomfortably
long time, the core of the product —
[agents talking to each other](/blog/can-claude-code-agents-talk-to-each-other/) — did not work
for those users, and neither they nor we could tell. This is the autopsy.

## The setup

When Munder Difflin spawns an agent, it passes the **hive protocol** as a command-line argument
to the engine CLI: a multi-line block that names the agent, points at its `inbox/` and
`outbox/` folders, explains the [file-mailbox rules](/blog/atomic-file-mailboxes-for-agents/),
and tells it where its memory lives. One argument, many lines. On POSIX systems this is
completely unremarkable — argv entries can contain any byte except NUL, and newlines ride along
happily.

## The three-layer trap

**Layer one: npm shims.** On Windows, `npm install -g` doesn't put a real executable on your
PATH. It writes a `.cmd` batch shim that locates node and runs the actual JS entry point.

**Layer two: CreateProcess.** A `.cmd` is not a PE executable, so it can't be the target of
`CreateProcess` directly. Node's `child_process` (and everything built on it) handles this by
silently rewriting your spawn into `cmd.exe /d /s /c "your command here"`.

**Layer three: cmd.exe.** And cmd.exe, parsing that command string with rules essentially
unchanged since DOS, **stops at the first newline**. Everything after it isn't escaped or
mangled — it's simply gone.

{% img "note-1", "Three layers deep: npm's .cmd shim forces cmd.exe into the spawn path, and cmd.exe stops reading at the first newline." %}

Stack the layers and you get: a multi-line protocol enters the spawn, and a one-line protocol
arrives at the agent. Deterministically. On every Windows machine. With zero errors.

## Why it was invisible

Here's what made this bug expensive: **every observable signal said healthy.**

The process spawned — exit code irrelevant, it's a long-running CLI. The agent's terminal
rendered in the app and responded to typing. The engine received *a* prompt (line one:
something like "You are an autonomous agent in a collaborating hive"), which is coherent enough
that the agent behaved plausibly. It just never mentioned inboxes, because it had never heard
of them.

From the floor's perspective, Windows agents were simply... quiet. And "the agent didn't happen
to send mail" is indistinguishable from "the agent cannot send mail" unless you go looking. No
log line existed to catch, because truncation isn't a failure — cmd.exe was working as
documented. The documentation is just from 1987.

{% img "note-2", "Every signal read healthy: process up, terminal live, prompts answered. The agent just never knew it had a mailbox." %}

## The fix: refuse the middleman

The fix is conceptually simple: **never let a prompt-carrying spawn touch cmd.exe.** The spawner
now opens the `.cmd` shim, decodes what it actually points at — npm shims are formulaic — and
launches the real interpreter directly: `node.exe C:\...\cli.js --args`, passed as an argv
array, which goes through `CreateProcess` with the multi-line argument intact.

Then reality added a second chapter, as it does. OpenCode's npm package ships a *compiled
binary*, so npm writes an interpreter-less shim the decoder didn't model — it returned null for
every Windows OpenCode install and fell back to the truncating path. That's the
[0.4.4](/blog/launching-munder-difflin-v0-4-4/) follow-up: direct-executable shims are handled,
and — the real lesson — **the fallback is no longer silent.** If the decoder meets a shim it
can't parse, it logs exactly what it couldn't decode. The next variant of this bug will
announce itself.

## The takeaways we actually wrote down

- **A fallback that doesn't log is a bug with a delay timer.** The first fix's silent fallback
  is why the OpenCode variant survived a release.
- **"Nothing errored" is a claim, not evidence.** The failure mode of dropping *part* of an
  input is nastier than crashing, because every health check you own passes. Our
  [auto-update postmortem](/blog/why-our-auto-update-never-ran/) is the same lesson wearing a
  different coat.
- **Test the platform's spawn path, not your code's intent.** Our protocol handling was
  correct on every platform. The three layers underneath it were not ours — and the user
  doesn't care whose layer it was.

If you're building anything that passes structured prompts to CLIs on Windows —
[hooks](/blog/the-hook-shim-pattern/), harnesses, wrappers — go check what your spawns do when
the target is a `.cmd`. We'll wait. It's probably ten minutes and one very bad surprise.

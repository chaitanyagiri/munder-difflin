---
title: "The Single-Committer Pattern: Multi-Agent Git Without Corruption"
description: "Parallel agents corrupt a repo with index.lock races. The single-committer pattern — agents write, one process commits — fixes concurrent git writes."
date: 2026-06-02
category: internals
categoryLabel: Internals
type: Technical
primaryKeyword: "single committer git multi agent"
secondaryKeywords: ["git index.lock", "multi-agent git", "concurrent git writes"]
tags: ["Internals", "Git", "Multi-Agent", "Concurrency"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What causes git index.lock errors with multiple agents?"
    a: "Git takes an exclusive lock on .git/index while staging or committing. If two processes run git at the same time, the second finds the lock held and fails — or worse, a crashed process leaves a stale lock behind that blocks every future commit."
  - q: "How do you let many agents share one git repo safely?"
    a: "Don't let the agents call git at all. Agents write plain files; a single coordinating process owns every commit, serializing them. Concurrency on the repo drops to one writer, so the lock is never contended."
  - q: "Do agents lose anything by not running git themselves?"
    a: "No. They still create, edit, and delete files freely. They just don't stage or commit — that's delegated to one committer, which turns git into a clean, serialized audit log of the team's work."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>Run several agents against one git repo and
they'll race on <code>.git/index.lock</code>, producing failed and half-staged commits. The
<strong>single-committer pattern</strong> fixes it: <strong>agents only write plain files; one process
owns every commit</strong>, serialized, with retry-and-backoff and stale-lock recovery. Concurrency on
the repo drops to exactly one writer, so corruption becomes impossible — and git turns into a tidy
audit log of everything the team did.</p></div>

If you've ever pointed two automated agents at the same repository, you've probably met this error:

```
fatal: Unable to create '/path/.git/index.lock': File exists.
```

It looks transient. It isn't a fluke — it's git telling you that two processes tried to write its index
at once. As you add agents, it goes from occasional to constant, and a crashed agent can leave a stale
lock that blocks *every* future commit. This post explains why it happens and the pattern that ends it.

## Why concurrent git writes corrupt

Git is not designed for concurrent writers. When you stage or commit, git takes an **exclusive lock**
by creating `.git/index.lock`; it does its work against that file, then atomically renames it over
`.git/index` and releases the lock. The lock guarantees that only one operation mutates the index at a
time.

That's fine for a human typing one command. It falls apart with parallel agents:

- **Contention.** Two agents commit at the same instant. One gets the lock; the other finds
  `index.lock` already present and fails outright.
- **Half-applied state.** Interleaved `git add`/`git commit` from different processes can stage a
  partial set of changes — a commit that doesn't reflect any single agent's intent.
- **Stale locks.** An agent crashes (or is killed) mid-commit and never removes its `index.lock`. Now
  the lock file is orphaned, and every subsequent commit — by anyone — fails until someone deletes it
  by hand.

You can't "be careful" your way out of this. Two well-behaved agents that simply finish at the same
second will collide. The guarantee has to come from the design, not the agents' manners.

## The pattern: one writer for git

The single-committer pattern is exactly what it sounds like: **only one process is ever allowed to run
git.** Everything else is downstream of that rule.

- **Agents write plain files.** They create, edit, and delete files in their workspaces freely. They
  do *not* run `git add`, `git commit`, or anything else that touches the index. As far as the agents
  are concerned, git doesn't exist.
- **One coordinating process commits.** A single committer watches the shared state, stages changes,
  and commits them — one at a time, in order. Because it's the only thing calling git, `index.lock` is
  never contended. There is no second writer to race with.

This collapses a hard concurrency problem into a trivial one. The repo has many *readers* and exactly
one *writer*, which is the configuration git is perfectly happy with.

{% img "note-1" %}

## Making the single committer bulletproof

"One committer" removes contention between agents, but the committer still has to handle the messy
real world: a previous run that died, an occasional transient failure. A production-grade committer
does three things.

### 1. Retry with backoff

Even a lone committer can hit a lock left by something else (a stray `git` you ran in another terminal,
a hook). So each commit attempt is wrapped in a small retry loop: try to commit; if it fails on a lock,
wait a short, growing interval and try again. A handful of attempts with increasing backoff absorbs any
brief contention without surfacing an error to the user.

```text
for attempt in 0..5:
    clear stale lock if present
    git add -A
    git commit -m <message>
    → success?            return
    → "nothing to commit"? return        # not an error
    → lock error?         sleep 50ms * (attempt + 1); retry
    → other failure?      give up quietly; the next change retries
```

### 2. Stale-lock recovery

A lock file that's been sitting untouched for a while almost certainly belongs to a dead process. The
committer checks the lock's age before each attempt and, if it's older than a threshold (say, ten
seconds with no modification), removes it. That single check is what turns "a crashed agent bricked our
commits" into a non-event — the next commit cleans up and proceeds.

### 3. A deterministic git identity

Because the committer commits on behalf of the whole team, it uses a fixed identity and disables
signing, so commits never block on a GPG prompt or a missing `user.name`:

```bash
git -c commit.gpgsign=false -c user.name=Hive -c user.email=hive@local commit -m "…"
```

Now every coordination step is a clean, attributable commit, and nothing can hang waiting for
interactive input.

## The bonus: git becomes an audit log

Here's the part that turns a workaround into an asset. Once one process owns every commit, the repo
stops being a liability and becomes a **serialized history of everything the team did**. Each routed
message, each task assignment, each memory update lands as its own commit, in order — a natural
companion to the [append-only event log](/blog/append-only-event-log-agents/) the hive also keeps. When
a multi-agent run goes sideways, you don't guess — you read the history.

That pairs naturally with the messaging layer: agents coordinate through files (see
[atomic file mailboxes](/blog/atomic-file-mailboxes-for-agents/)), and the single committer commits
those file changes as they happen. The same single-writer discipline runs through both — it's the
backbone of [coordinating AI coding agents](/blog/coordinating-ai-coding-agents/) without collisions.

{% img "note-2" %}

## What about the user's own repo?

A fair question: if agents are editing your *actual* code repository, who commits *that*? The
single-committer pattern is about the **coordination** repo — the shared state the agents use to talk,
remember, and track tasks. Your source repo is separate, and you stay in control of its commits the way
you always have (or you delegate them deliberately to one agent with that role). The point is that the
machinery the agents rely on to cooperate never corrupts itself, no matter how many of them are running.

## When you need this

You need the single-committer pattern the moment **more than one automated process** shares a git repo:

- multiple coding agents in the same project,
- an agent plus a background job that both commit,
- any "swarm" or "hive" where coordination state lives in git.

If it's just you and one agent taking turns, you'll rarely see a lock. Add a second concurrent writer
and the races begin — which is precisely when this pattern stops being optional.

## FAQ

**Why not use git worktrees to isolate each agent?** Worktrees give each agent its own working
directory, which helps with *file* isolation — but each worktree still has its own index, and shared
refs can still contend. Worktrees and single-committer solve different halves of the problem; see
[git worktrees vs a hive](/blog/claude-code-git-worktrees-vs-hive/) for when each applies.

**Isn't a lock just a retry-until-it-works situation?** Retrying helps with transient contention, but
it does nothing for a *stale* lock from a dead process — that one never clears on its own. You need the
age-based cleanup, not just retries.

---

Munder Difflin uses the single-committer pattern across the [multi-agent harness](https://munderdiffl.in/#what): agents write
files, one process commits with retry and stale-lock recovery, and the repo stays a clean audit log.
[Download Munder Difflin](https://munderdiffl.in/#install) to run a hive of Claude Code agents that
never corrupt their own state; it's free and open source.

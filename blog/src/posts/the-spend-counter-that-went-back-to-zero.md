---
title: "The Spend Counter That Went Back to Zero"
description: "Our own floor was under reporting what it cost by 59 percent. The counter was cumulative since process start, the app restarts, and the session id stayed the same. Here is how a monotonic invariant let us recover the real number from an append-only log."
date: 2026-08-22
category: internals
categoryLabel: Internals
type: Technical
primaryKeyword: "ai agent cost tracking bug"
secondaryKeywords: ["cumulative counter reset", "append-only ledger recovery", "electron main thread blocking read", "monotonic counter invariant", "agent spend tracking"]
tags: ["Internals", "Cost", "Telemetry", "Debugging", "Postmortem"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What was wrong with cost reporting in Munder Difflin?"
    a: "The per-agent spend figure counted from the moment the app process started, not from the moment the agent started. Restarting the app rebuilt the in-memory accumulator empty, so the counter began again at zero under the same session id. Anything reading the latest value read one app session's worth of spend and called it the total. On our own floor that hid 59 percent of it."
  - q: "Why did nobody notice a number that was wrong by more than half?"
    a: "Because it never looked wrong. Inside any single run the counter only climbed, so it behaved exactly like a lifetime total. Nothing threw, nothing went negative, nothing came back NaN. The reset is only visible if you look at the whole history at once, and the number is the kind you glance at rather than reconcile."
  - q: "How do you recover a total from a counter that resets?"
    a: "You use the invariant the counter already gives you. Within one agent and one session the value can only go up, so any decrease is a restart and nothing else. Lifetime is the sum of the high-water mark of each segment that a reset closed, plus the high-water mark of the segment still open. Every sample was already on disk in an append-only ledger, so the past was recoverable without a migration."
  - q: "Why not ignore small drops as noise?"
    a: "We looked at that and rejected it. Real restarts in our own ledger fall from peaks under a dollar straight to zero, so a one dollar threshold would have silently missed them. A cumulative counter has no legitimate reason to fall at all, so the threshold bought tidiness and cost coverage. Any decrease counts, with a float epsilon and nothing more."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>Munder Difflin tells you what your
floor of agents costs. That number was wrong by <strong>59 percent</strong>, and it had been
wrong quietly, because it was a counter that measured from process start while its label said
lifetime. Restart the app and it began again at zero under the same session id. The fix is not a
new counter. It is reading the reset back out of the log we already had, using the one property a
cumulative counter cannot break: it only goes up.</p></div>

You can build an agent harness that does everything right and still hand people a number that
lies. Ours did. Every agent card on the floor carried a dollar figure, `fleet.json` carried it
for Michael, and the LIVE ROSTER line every agent reads carried it too. It was the number you
would look at to decide whether to hire another worker or send everyone home.

It was under reporting by more than half.

This is the postmortem, because the bug is not really about money. It is about what happens when
a value's name describes something more permanent than the thing that computes it.

## What the number was supposed to mean

Each agent reports usage as it works. The collector folds those samples into a per-agent record
with tokens in, tokens out, cache reads, cache creation, and a dollar figure. That record is
written into `fleet.json` on a timer, which is what the orchestrator and every agent read when
they want to know the shape of the floor.

The contract everyone assumed was simple: `usd` is what this agent has cost you.

## What it actually meant

`AgentUsageSample.usd` is cumulative since **process start**. Not since the agent started. Since
the app started.

The collector accumulates into in-memory maps. An app restart builds those maps fresh, so every
running total goes back to zero. The agent itself does not go back to zero, because the agent
resumes: same worker, same work, same `session_id`. Only our accumulator forgot.

So the sequence on disk looks like this. The counter climbs through a session. The app restarts.
The counter appears again at almost nothing, under the same session id, and starts climbing
again. Anything that reads the latest value is reading spend since the most recent restart and
reporting it as spend, full stop.

The longer an agent lives, the more restarts it survives, and the more wrong its number gets. The
agents you have invested the most in are the ones whose cost you understate the worst.

## Why this survived in plain sight

Here is the uncomfortable part. Every check you would write against this number passes.

The value is never negative. It is never NaN. Nothing throws, nothing warns, no read fails.
Within any single run of the app the counter is perfectly monotonic, which is exactly how a
lifetime total behaves, so a person watching it for an hour sees nothing suspicious. It is
plausible in magnitude: too small to be absurd, too large to be obviously stubbed.

And the reset itself is invisible from where the number is consumed. Restarting an app is the
single most normal thing a user does. Nobody restarts and then reconciles a dollar figure against
what it read before, because the app was closed in between and closing an app is allowed to
change what is on screen.

The signature only exists in the history. You cannot see it in a value. You can only see it in a
sequence, and only if you look at the whole sequence at once.

{% img "note-1", "The counter climbs, the app restarts, the counter starts over. Every single value is fine. Only the sequence is wrong." %}

## The data was never lost

The thing that made this fixable rather than merely diagnosable: the ledger is append-only.

Every usage sample ever emitted is a line in `cost-ledger.jsonl`, and lines are never rewritten.
The pre-reset peaks were all still sitting on disk. The bug was in what we read out of that file,
not in what we put into it, which means the past could be corrected rather than written off.

That distinction is worth more than the fix. A bug in a derived read is recoverable. The same
bug in the write path would have meant a number that starts being right today and is wrong
forever behind you.

## Reading a reset out of a monotonic counter

Within one agent and one session, the counter can only climb. That is not a convention, it is
what cumulative means. So a decrease is not ambiguous. It is not a rounding artifact, or a
correction, or a refund. **A decrease is a restart, and it is the only thing a decrease can be.**

That gives the whole algorithm. Walk the ledger. For each agent and session, hold two numbers:
the high-water mark of the segment currently open, and the sum of the high-water marks of every
segment a reset has already closed. When the value drops, the open segment just ended at its
peak, so commit the peak and open a new segment at the new value.

```ts
if (usd < s.peak - EPS) {
  // Counter went backwards: the previous segment ended at its peak.
  s.committed += s.peak;
  s.peak = usd;
} else if (usd > s.peak) {
  s.peak = usd;
}
```

Lifetime is then `committed + peak`, summed across every session an agent has had. That is the
entire recovery. It is a handful of arithmetic, because the invariant did the hard part.

The general shape is worth keeping: **if a value is only allowed to move one way, every move the
other way is a free detector you already have on disk.** You do not need to have instrumented the
event. You need to have recorded enough that the event leaves a shadow.

## The threshold we deliberately did not add

The tempting version of this code ignores small drops. Float noise, out-of-order samples, a
rounding difference somewhere upstream: surely you want a floor before you call something a
restart. A dollar sounds sensible. Ten cents sounds cautious.

We looked at our own ledger and found real restarts falling from peaks **under a dollar** straight
to zero. A one dollar threshold misses those completely, and it misses them silently, which is
the same failure we were already fixing wearing a different hat.

So the threshold is a float epsilon and nothing else. A cumulative counter has no legitimate
reason to go down by any amount, so there is no band of "probably fine" to carve out. The magic
number bought tidiness and cost coverage, and coverage was the entire point.

If you find yourself picking a threshold to suppress a signal, check whether the signal has any
legitimate instances at all. If it does not, the right threshold is zero and the number you were
about to type is just a hole.

## Doing it without freezing the app

Munder Difflin is an Electron app, and the ledger is append-only, which is a polite way of saying
it grows forever. A full pass over it is not something you want on the main thread. Block that
thread and the whole UI stops: the floor, the terminals, the window itself.

So the fold is async and incremental. It keeps a byte offset and reads only what has been
appended since the last pass, which in steady state is a few hundred bytes. Three details in
there are load bearing.

**The trailing partial line is held as bytes, not text.** A read boundary can land in the middle
of a multi-byte character, and decoding half of one produces a replacement character that no
longer parses as JSON. Buffering the tail as a `Buffer` and only decoding up to the last newline
means the split is invisible.

**Each pass is capped.** A cold start on a large ledger would otherwise be one enormous read. It
reads a bounded chunk, keeps its segment state, and resumes on the next tick.

**Truncation is detected, not assumed away.** If the file is smaller than the offset we hold, the
file was rotated or replaced under us, and every segment we are carrying is suspect. That case
resets the reader instead of reading garbage from a stale position.

The reader never writes to the ledger, and a ledger it cannot read leaves the last good totals in
place rather than throwing into a timer.

## A cold zero is worse than an admitted unknown

Until the first full pass completes, the fold genuinely does not know what an agent has cost.
There are two things you can publish at that moment: zero, or nothing.

Zero is a lie with a confident face. Somebody reads it, believes an agent is free, and the
mistake propagates. So `usdFor` returns `null` until a pass has actually reached the end of the
file, and there is an explicit `warm` flag behind it so a caller can tell "no spend" apart from
"not read yet".

`fleet.json` uses that to fall back to the old session figure while the fold is cold, and swaps
to lifetime the moment it is warm. The old number is still there permanently as `sessionUsd`,
because "what has this agent cost me since I opened the app" is a real question, it just is not
the one the field named `usd` was being asked.

Nullable is not a nuisance here. It is the type telling the truth about what is known.

## Checking a number you recovered by inference

This is a computed answer with no ground truth to compare it against. There is no invoice that
says what an agent cost. The number is only as good as the reasoning that produced it, which
means a passing test proves the code matches the assumptions, not that the assumptions are right.

So the ledger was folded a second time by a separately written implementation and the two were
compared. They agree to the cent, with no per-agent disagreement anywhere in the set. That is not
proof, but two independent implementations agreeing on every agent is a very different level of
confidence than one implementation agreeing with itself.

For any number you recover by inference rather than measurement, write it twice. It is cheap and
it is the only check that tests the reasoning instead of the typing.

## What we did not fix, and why we said so

The circuit breaker has a floor-wide cost cap, and it reads the same resetting counter.

That means the cap re-arms to zero on every restart and is, in effect, measuring one app session
rather than lifetime. That is not a bug in the same sense. It is an unanswered question about what
a spending cap should mean. Is it "stop the floor when it has spent this much today", or "ever"?
Those are different products, and one of them is a policy the founder gets to choose, not a
default an agent should quietly change while fixing something else.

So it is written up rather than patched. **A fix that silently rewrites a policy is not a fix, it
is a decision taken by whoever happened to be in the file.**

{% img "note-2", "Same counter, second consumer. Fixing the display without fixing the cap would have been half a fix that looked whole." %}

## What we wrote down

- **A counter named for a lifetime should not be scoped to a process.** If the value resets when
  something restarts, the name has to say so. Ours now ships as `usd` and `sessionUsd` side by
  side, and the ambiguity is gone because both answers exist.
- **A monotonic invariant is a detector you already own.** If a value can only move one way, every
  move the other way is an event you can recover after the fact, with no new instrumentation.
- **Append-only logs let you fix the past.** The write path being correct is what made this a
  read-side fix instead of a line in the changelog apologising for old data.
- **Check whether your threshold has any legitimate instances.** If nothing real lives below the
  cutoff, the cutoff is only hiding things you wanted to see.
- **Never publish a confident zero for a value you have not read yet.** Return null, keep a warm
  flag, and let callers decide.
- **Write the second implementation.** For inferred numbers it is the only verification that
  tests the reasoning rather than the code.

The failure class here is the same one behind
[the newline that silenced every Windows agent](/blog/the-newline-that-silenced-windows-agents/)
and [the auto-update that never ran](/blog/why-our-auto-update-never-ran/): nothing errored,
every health check passed, and the product was quietly not doing the thing it said it did.
Loud failures get fixed in an afternoon. These are the ones that need somebody to go and
[verify the claim](/blog/how-ai-agents-verify-their-own-work/) rather than the absence of an
exception.

## The rest of v0.4.5

This shipped in **v0.4.5**, alongside two other things that were quietly wrong: semantic memory
never worked on Apple Silicon, where CoreML overflowed the quantized embedding graph and returned
NaN for every vector, and agents did not reliably reach each other, which now has an inbox wake
watchdog behind it and bounces mail to a missing inbox instead of dropping it. Plus weekday
scheduling for triggers, clickable paths everywhere in terminal output, one editor instead of
two, one click updates, and 23 community pull requests.

The full notes are on the
[releases page](https://github.com/chaitanyagiri/munder-difflin/releases/latest), and if you want
the wider version of this argument, the
[multi-agent cost playbook](/blog/the-multi-agent-cost-playbook/) is about spending less rather
than counting it correctly. Both matter. Counting it correctly comes first, because you cannot
manage a number you are not actually reading.

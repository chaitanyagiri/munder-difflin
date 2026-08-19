---
title: "Prompt Caching for AI Agents: Stop Paying for the Same Tokens Twice"
description: "An agent re-sends the same prompt, tools, and context every turn. Prompt caching makes you pay for that prefix once — here's how to design for it."
date: 2026-06-04
category: guides
categoryLabel: Guides
type: Technical
primaryKeyword: "prompt caching for ai agents"
secondaryKeywords: ["prompt caching", "llm prompt caching", "agent cost optimization", "kv cache"]
tags: ["Prompt Caching", "Cost", "Performance", "Multi-Agent"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What is prompt caching?"
    a: "Prompt caching lets an LLM provider store the processed form of a stable prefix of your prompt — typically the system instructions, tool definitions, and any large fixed context — so that subsequent requests reusing that exact prefix skip the work of reprocessing it. You pay full price to write the cache once, then a small fraction of the input price on every later request that hits it, and the response starts faster."
  - q: "Why does prompt caching matter so much for agents?"
    a: "An agent is a loop: it sends the same system prompt, the same tool list, and often the same large context on every single turn, with only the newest messages changing. Without caching you re-pay for that entire stable prefix dozens of times in one session. With caching you pay for it once and read it cheaply thereafter, which for a long agent run is usually the single biggest cost reduction available — and it cuts latency too."
  - q: "How do I structure a prompt so it caches well?"
    a: "Put the stable content first and the volatile content last. Caches match on an exact prefix, so the system prompt, tool definitions, and fixed context go at the front, and the changing turn-by-turn messages go at the end. Any change near the front invalidates everything after it, so never edit or reorder the prefix mid-session — append, don't rewrite."
  - q: "What are the limits of prompt caching?"
    a: "Caches expire after a short time-to-live (often around five minutes by default), so an agent that goes idle loses its cache and re-pays the write. Caching only helps input tokens, not output, and it doesn't change answer quality — it's purely a cost and latency optimization. And because matching is exact-prefix, a single changed token near the front busts the cache."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>An agent is a loop that re-sends the same
system prompt, tools, and context on <em>every</em> turn — and naively you pay full price for that
prefix every time. <strong>Prompt caching</strong> makes you pay for the stable prefix once (a small
write premium) and a fraction of the price on every later turn that reuses it. The design rules:
<strong>stable content first, volatile content last</strong>; never rewrite the prefix mid-session
(append, don't edit); and keep turns flowing so the cache doesn't expire. For a long-running agent it's
usually the single biggest lever on both <strong>cost and latency</strong>.</p></div>

Last time we looked at [routing the right task to the right model](/blog/do-more-with-less-model-routing/)
as the first big cost lever for a hive of agents. Here's the second, and it's one people leave on the
table constantly: **prompt caching**. The model-routing argument is about *which* model you call;
prompt caching is about *not re-paying for the same tokens* every time you call it. Both matter; this
one is almost free once you understand the shape of an agent's prompt.

## An agent re-sends almost the same prompt every turn

Step back and look at what an agent actually sends to the model on each turn of its loop:

- a **system prompt** — its role, rules, and instructions (stable for the whole session),
- a set of **tool definitions** — often long, and identical every turn,
- some **fixed context** — a codebase summary, project docs, a style guide (stable),
- and then the **conversation so far** plus the **newest message or tool result** (this is the only
  part that actually changes).

The first three are the same on turn 1 and turn 40. Yet without caching, every turn re-sends and the
model re-processes that entire prefix from scratch — and you pay input-token price for all of it, every
single time. On a long agent run with a big system prompt and a fat tool list, the *stable* prefix can
dwarf the changing part. You're paying for the same tokens dozens of times.

That's the waste prompt caching removes.

## What caching actually does

Every major provider now offers some form of it (Anthropic, OpenAI, and Google all do). The mechanics
vary, but the shape is the same:

1. The provider stores the **processed form** of a prefix of your prompt.
2. The **first** request that establishes the cache pays a small **write premium** over normal input
   price (Anthropic, for example, charges around 1.25× to write).
3. **Every later** request whose prompt begins with that exact prefix pays only a **fraction** of the
   input price for the cached part — on the order of **a tenth** — and the response also starts faster,
   because the expensive prefix didn't have to be reprocessed.

So the trade is: pay a little extra once, then pay almost nothing for that prefix on every subsequent
turn. For a one-shot call that never repeats, caching isn't worth the write premium. For an *agent* —
which repeats the same prefix constantly — it's close to a no-brainer. The break-even is usually just
two or three reuses, and agents reuse far more than that.

{% img "note-1" %}

## The one rule: stable first, volatile last

Caches match on an **exact prefix**. The provider walks your prompt from the start and reuses the cache
up to the first byte that differs. Everything after that point is reprocessed and re-priced. That single
fact dictates the whole design:

> Put everything stable at the **front** of the prompt, and everything that changes turn-to-turn at the
> **back**.

Concretely, order your prompt as: **system prompt → tool definitions → fixed context → conversation
history → newest message**. That way the longest possible run of bytes at the front is identical every
turn, so the cache covers the maximum amount, and only the short, genuinely-new tail gets reprocessed.

The corollary is a discipline that trips people up: **never edit or reorder the prefix mid-session.** If
you insert a note into the system prompt on turn 20, or shuffle your tool list, or rewrite the fixed
context, you change a byte near the front and **invalidate the cache for everything after it** — you're
back to paying full price. The cache-friendly move is always to **append** new information at the end,
never to rewrite the beginning.

This is exactly where caching and [context engineering](/blog/semantic-memory-for-ai-agents/) have to
agree with each other. Curating the window is good — but if your curation *rewrites the front* of the
context on every turn, you've quietly destroyed your cache. Cache-aware context engineering means: keep
the stable prefix truly stable, and do your adding at the tail.

## Watch the clock: caches expire

The second gotcha is **time-to-live**. Cached prefixes don't live forever; a common default is around
**five minutes** of inactivity before the cache is dropped (some providers offer a longer, pricier TTL).
For an agent in a tight loop, this is invisible — turns come fast enough that the cache stays warm. But
an agent that **goes idle** — waiting on a human approval, blocked on a slow tool, parked between tasks —
can let its cache lapse and pay the write premium all over again when it resumes.

The practical implications:

- Keep active agents **looping** rather than sleeping mid-task when you can.
- For work with unavoidable long pauses, consider a provider's **extended-TTL** option, or accept the
  re-write cost as the price of the pause.
- Be aware that the cost math shifts the moment an agent stalls — which is one more reason
  [human-in-the-loop checkpoints](/blog/human-in-the-loop-ai-agents/) should be rare and high-signal,
  not sprinkled everywhere.

{% img "note-2" %}

## The multi-agent angle

In a single agent, caching is a per-session win. In a [hive](/blog/coordinating-ai-coding-agents/) it
compounds, because many agents share structure. If your agents are built from the **same system-prompt
template and the same tool definitions**, each one's prefix is independently cacheable — and if you keep
that shared scaffold **byte-identical** across agents (same ordering, same formatting), you make every
agent's prompt as cache-friendly as it can be.

Two concrete habits pay off:

- **Standardize the scaffold.** A shared, fixed prefix format across roles means every agent benefits
  from the same caching behavior, and you reason about cost once instead of per-agent.
- **Give sub-agents a stable brief.** When an orchestrator spins up a short-lived sub-agent, a
  consistent, front-loaded brief lets even brief agents cache their setup — useful when you fan out many
  similar sub-agents at once.

The general principle, same as everywhere else in agent design: **shared, stable structure is cheaper
than bespoke, churning structure** — here it's literally cheaper, in tokens.

## A quick checklist

When an agent's bill looks too high for what it's doing, before anything else:

1. **Is caching even on?** Some APIs cache automatically above a token threshold; others require you to
   mark the cacheable prefix explicitly. Know which yours is.
2. **Is the prompt ordered stable-first?** If volatile content is near the front, the cache covers
   almost nothing. Reorder.
3. **Are you rewriting the prefix mid-session?** Find the edit and turn it into an append.
4. **Are agents stalling long enough to lose the cache?** If so, either tighten the loop or accept the
   re-write.
5. **Is the prefix long enough to be worth it?** Tiny prompts that barely repeat don't recover the write
   premium — caching is for the big, oft-repeated scaffolds, which is most agents.

## The bottom line

Prompt caching is the rare optimization that costs almost nothing to adopt and pays back immediately:
you don't change *what* your agent does or *how well* it does it — you just stop paying repeatedly for
the tokens it was always going to send. Pair it with [smart model
routing](/blog/do-more-with-less-model-routing/) and you've pulled the two biggest cost levers an agent
team has: the right model for the task, and full price for the stable prefix exactly once.

Munder Difflin is built to run [a hive](/#how) efficiently — lean models by default, stable shared scaffolds, and
work that keeps flowing. [Download Munder Difflin](https://munderdiffl.in/#install) to run an agent team
that doesn't waste your tokens; it's free and open source.

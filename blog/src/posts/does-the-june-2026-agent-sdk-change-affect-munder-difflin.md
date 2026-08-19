---
title: "Does the June 2026 Agent SDK Change Affect Munder Difflin?"
description: "From June 15, 2026 the Claude Agent SDK gets a separate credit. Munder Difflin drives the native Claude Code CLI, so your hive runs on your plan as before."
date: 2026-06-06
category: guides
categoryLabel: Guides
type: Technical
primaryKeyword: "claude agent sdk credit"
secondaryKeywords: ["munder difflin claude plan", "claude code subscription limits", "agent sdk vs claude code", "claude code june 15 2026"]
tags: ["Claude Code", "Local-First", "FAQ", "Use Cases"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "Does the June 15, 2026 Claude Agent SDK change affect Munder Difflin?"
    a: "The agents that do your work are unaffected. Munder Difflin runs its hive as interactive Claude Code terminal sessions, and Anthropic's update states that Claude Code in the terminal or IDE 'continues to use your subscription usage limits exactly as before.' The one exception is Munder Difflin's optional enrich assistant, which uses claude -p (print mode) and therefore draws on the new Agent SDK credit — but it's off by default and covered by that credit."
  - q: "What changes for the Claude Agent SDK on June 15, 2026?"
    a: "Per Anthropic's support article, from June 15, 2026 Agent SDK usage stops counting toward your subscription limits; Pro, Max, Team, and Enterprise plans instead get a separate monthly Agent SDK credit ($20-$200 depending on tier). Your underlying plan usage limits are unchanged, and interactive Claude Code in the terminal/IDE is explicitly unaffected."
  - q: "Do I need to pay extra to keep running my Munder Difflin hive?"
    a: "No — the agents run on your existing Claude Pro/Max subscription, exactly as before, because they're interactive Claude Code sessions, not Agent SDK calls. You'd only touch the new Agent SDK credit if you enable the optional enrich assistant (which uses claude -p), and that usage fits within the included monthly credit."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>On <strong>June 15, 2026</strong>, Anthropic
changes how the <strong>Claude Agent SDK</strong> is billed: SDK usage stops counting against your
subscription and instead draws on a separate monthly credit. Crucially, this <strong>doesn't change Claude
Code in your terminal or IDE</strong> — that "continues to use your subscription usage limits exactly as
before." Munder Difflin runs its hive as <strong>interactive Claude Code terminal sessions</strong> (via
node-pty), <em>not</em> the Agent SDK — so the agents doing your work are unaffected and ride your existing
plan. The one exception: the <strong>optional, off-by-default</strong> enrich assistant uses
<code>claude -p</code>, which draws on the new credit (and is comfortably within it).</p></div>

If you run a Munder Difflin hive on a Claude Pro or Max plan, you may have seen Anthropic's June 15 Agent
SDK billing change and wondered whether your agents are about to start costing extra. Short answer: **the
agents are unaffected.** Here's exactly why, with the honest caveat included.

## What changes on June 15, 2026

Per Anthropic's support article,
[Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan),
from **June 15, 2026**:

- **Agent SDK usage stops counting toward your subscription limits.** Instead, Pro, Max, Team, and
  Enterprise plans get a **separate monthly Agent SDK credit** (ranging roughly **$20-$200** by tier).
- Your underlying plan limits are unchanged: *"Your plan usage limits haven't changed as part of this
  update."*
- And the line that matters most here: *"Using Claude Code in the terminal or your IDE continues to use
  your subscription usage limits exactly as before."*

So the change targets the **Agent SDK** — the programmatic library you build agents *on top of*. It does
**not** change interactive **Claude Code**, the CLI you run in a terminal. That distinction is the whole
story for a tool like ours.

One nuance to be precise about: the `claude -p` command — Claude Code's **non-interactive "print" mode** —
*does* draw from the new Agent SDK credit. Interactive terminal/IDE sessions do not. Keep that line in
mind; it's exactly where Munder Difflin sits on the safe side.

## Claude Code vs the Agent SDK: the distinction that matters

The names are similar, so it's worth being clear on the two things the policy treats differently:

- **Claude Code** is the interactive agent you run in your terminal or IDE — you (or a tool acting as you)
  type, it reads files, runs commands, and edits code in a live session. Its usage counts against your
  subscription, and that is unchanged.
- **The Claude Agent SDK** is the programmatic library developers use to *build their own* agents on top
  of Claude. It's what the June 15 update re-bills onto the separate credit.

A useful test: if a tool **embeds the SDK** to run agents headlessly, it's affected; if it **drives the
Claude Code CLI** the way you would by hand, it isn't. Munder Difflin is firmly the latter — it's a
[harness around Claude Code, not a wrapper around the SDK](/blog/claude-code-subagents-vs-multi-agent-harness/).

{% img "note-1" %}

## Why this doesn't change how Munder Difflin runs

Munder Difflin is a [multi-agent harness](/#what) that orchestrates the **native Claude Code CLI**. Each
agent in the hive is spawned as a real **interactive terminal session** through `node-pty` — a genuine
pseudo-terminal running `claude --permission-mode bypassPermissions`, the same command you'd type
yourself. There's no Agent SDK in that path, and no `claude -p`.

Because those are interactive Claude Code sessions, they fall squarely under "continues to use your
subscription usage limits exactly as before." **The agents that read your code, run your commands, and
write your changes ride your existing Claude plan after June 15, exactly as they do today.** Nothing to
reconfigure, no new credit to buy, no surprise bill.

This is the practical upside of being [local-first](/blog/why-local-first-matters-for-ai-agents/) and
driving the CLI directly rather than wrapping the SDK: when the SDK's billing model shifts, the tools
built on the SDK have to adapt — and the tools driving Claude Code don't.

## The one honest exception: the optional enrich assistant

We'd rather be precise than reassuring, so here's the caveat in full. Munder Difflin has **one** feature
that uses `claude -p`: the optional **enrich assistant** (internally, Michael's prep helper). It's a
one-shot, headless, **read-only** `claude -p` session that gathers repo context to sharpen a prompt before
the real agents run. It is **toggle-gated and off by default.**

Because it uses print mode, that feature *does* draw from the new Agent SDK credit after June 15. But two
things keep it a non-issue: it's **optional** (the core product — the agents doing the work — never touches
it), and its usage is light enough to sit comfortably **within the included $20-$200 monthly credit**. So
even with enrich turned on, you're covered; with it off, the change is invisible to you.

That's the honest shape of it: **the agents are unaffected; the optional enrich assistant uses
`claude -p`, which the new credit covers.** No "100% unaffected" hand-waving.

{% img "note-2" %}

## How to check for yourself

You don't have to take our word for it. In Munder Difflin, every agent is a tab you can watch — a live
terminal running Claude Code, exactly the interactive usage the policy keeps on your subscription. The
only `claude -p` call in the whole app is the enrich assistant, a single toggle in Settings; leave it off
and nothing in your hive draws on the Agent SDK credit at all.

## What it means for you

- **On a Pro/Max subscription:** your hive keeps running on your plan exactly as before. The agents are
  interactive Claude Code sessions, not Agent SDK usage.
- **Using an API key instead:** Anthropic notes that *"if you use the Agent SDK with an API key from the
  Claude Platform, nothing changes"* — pay-as-you-go continues as it did.
- **If you enable enrich:** that optional helper uses the new Agent SDK credit, which comfortably covers
  it. Leave it off and you won't touch the credit at all.

The takeaway is simple: tools built **on** the Agent SDK now need the separate credit (or API billing);
Munder Difflin drives the **Claude Code CLI** directly, so your [hive of agents](/blog/what-are-claude-code-agents/)
rides your existing Claude subscription. Local-first, on your own plan, no surprise.

Want to put a hive of Claude Code agents to work on your own plan? You can
[download Munder Difflin](/#install) free — it's open source.

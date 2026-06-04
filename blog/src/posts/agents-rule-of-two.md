---
title: "The Agents Rule of Two: A Simple Safety Rule for Coding Agents"
description: "Meta's Agents Rule of Two for coding agents: don't let one session combine untrusted input, private data, and external reach at once — or supervise."
date: 2026-06-04
category: concepts
categoryLabel: Concepts
type: Technical
primaryKeyword: "agents rule of two"
secondaryKeywords: ["ai agent security", "prompt injection", "lethal trifecta"]
tags: ["Concepts", "Security", "Multi-Agent", "Claude Code"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What is the Agents Rule of Two?"
    a: "It's a safety framework Meta published in October 2025: an AI agent session should satisfy no more than two of three properties — processing untrusted input, accessing sensitive data, and being able to change state or communicate externally. Hold any one of those back and a prompt injection has nothing to steal or nowhere to send it. If a task genuinely needs all three, the agent should run under supervision rather than autonomously."
  - q: "How does the Rule of Two relate to the lethal trifecta?"
    a: "They're the same insight from two directions. Simon Willison's 'lethal trifecta' names the dangerous combination — private data, untrusted content, and a way to exfiltrate — that makes prompt injection catastrophic. Meta's Rule of Two turns that into a design rule: keep any session to two of the three. Meta cites both Willison's framing and Chromium's older 'Rule of 2' as inspiration."
  - q: "Why are coding agents especially exposed?"
    a: "Because a coding agent naturally wants all three legs at once: it reads untrusted content (issues, dependencies, web pages), it has your private codebase and secrets, and it can run commands, hit the network, and push to git. That's the full trifecta by default — which is exactly why scoping one leg away, or supervising when you can't, matters most for coding work."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>Meta's <strong>Agents Rule of Two</strong>
(October 2025) is a refreshingly simple safety rule: an agent session should satisfy <strong>no more
than two</strong> of three properties — <strong>untrusted input</strong>, <strong>access to private
data</strong>, and the ability to <strong>change state or communicate externally</strong>. Drop any one
leg and a prompt injection can't complete the attack. Coding agents want all three by default, so the
job is to scope one away — keep data local, gate external/irreversible actions — or, when you truly
need all three, run under <strong>human supervision</strong> instead of autonomously.</p></div>

Prompt injection is still the unsolved problem of agentic AI: if an agent reads attacker-controlled
text, that text can hijack what it does next. You can't fully prevent it, so the useful question
becomes *how do you limit the blast radius when it happens?* In October 2025, Meta's security team
published an unusually clean answer — the [Agents Rule of
Two](https://ai.meta.com/blog/practical-ai-agent-security/) — and it maps almost perfectly onto coding
agents. Here's the rule, why it works, and how to apply it.

## The rule, in one sentence

Meta's framework names three properties an agent session might have:

- **[A]** it can process **untrustworthy inputs**,
- **[B]** it can access **sensitive systems or private data**,
- **[C]** it can **change state or communicate externally**.

The rule: an agent should *"satisfy no more than two"* of those three within a single session "to avoid
the highest impact consequences of prompt injection." And if a workflow genuinely needs all three, Meta
is explicit that the agent "should not be permitted to operate autonomously" — at minimum it needs
supervision, "via human-in-the-loop approval or another reliable means of validation."

That's the whole thing. No model retraining, no clever classifier — a structural constraint on what any
one session is allowed to combine.

## Why two is the magic number

The Rule of Two is the design-time twin of a threat model Simon Willison calls the [lethal
trifecta](https://simonwillison.net/2025/Nov/2/new-prompt-injection-papers/): the genuinely dangerous
situation is when an agent has private data **and** sees untrusted content **and** can exfiltrate.
Injected instructions in the untrusted content tell the agent to take the private data and send it
somewhere — and all three legs are needed for that to succeed.

Pull any single leg and the attack stalls. No untrusted input, nothing to carry the injection. No
private data, nothing worth stealing. No way to communicate out, nowhere to send it. The Rule of Two is
just that observation made actionable: stay at two legs and the worst case is off the table. (Meta
credits both Willison's framing and the older Chromium "Rule of 2" as
inspiration.)

## A coding agent wants all three by default

Here's the uncomfortable part for our domain: a capable coding agent is *born* at the full trifecta.

- It **reads untrusted content** all day — issue text, dependency READMEs, web pages, a teammate's PR
  description. (Leg A.)
- It **holds your private data** — the whole codebase, `.env` files, tokens in your shell. (Leg B.)
- It **can act on the outside world** — run shell commands, make network calls, `git push`. (Leg C.)

So "just don't have all three" isn't free advice for coding agents; it's the central design challenge.
The good news is that each leg is something you can deliberately scope down.

## How to drop a leg

You don't have to neuter the agent — you have to make sure no single session quietly holds all three.

- **Trim leg B (private data).** Keep the sensitive stuff [local and
  least-privileged](/blog/security-for-ai-coding-agents/): a [local-first
  setup](/blog/why-local-first-matters-for-ai-agents/) where the codebase and memory never leave your
  machine shrinks what an injection could ever reach, and scoping a task to one directory shrinks it
  further.
- **Trim leg C (external reach).** Put the irreversible and the outbound behind a gate. [Permission
  modes and sandboxing](/blog/agent-security-and-sandboxing/) decide what runs automatically versus what
  pauses, so the inject-then-exfiltrate step can't fire unattended.
- **Trim leg A (untrusted input).** Be deliberate about what the agent ingests, and treat everything it
  reads as potentially hostile rather than as instructions to obey.

In practice you rarely remove a leg entirely — you weaken it enough that a single compromised session
can't complete the chain.

## When you genuinely need all three: supervise

Sometimes the task really does want the full [trifecta](/blog/the-lethal-trifecta-for-coding-agents/) — read an untrusted issue, touch private code,
and open a PR. Meta's escape hatch is the right one: don't run that autonomously. Route the risky step
through a person. This is exactly what [human-in-the-loop
approvals](/blog/human-in-the-loop-approving-ai-agents/) are for — the agent does the work, but the
state-changing or outbound action waits for a human's yes. Supervision turns "all three legs, unattended"
(the dangerous case) into "all three legs, but a human validates the irreversible part."

## What it is and isn't

The Rule of Two is a heuristic, not a proof. It targets "the highest impact consequences" of prompt
injection, not every possible harm, and "no more than two" reduces risk rather than eliminating it. But
that's also its strength: it's a rule you can actually hold in your head and apply while you're wiring
up an agent, instead of a research result you admire and forget. For coding agents — perpetually at the
full trifecta — having one clear question ("does this session combine all three? then scope a leg or
supervise") is worth more than a dozen vaguer ones.

## FAQ

**What is the Agents Rule of Two?** A Meta framework (October 2025): keep an agent session to no more
than two of — untrusted input, private-data access, and the ability to change state or communicate
externally. Hold one back and prompt injection can't complete an attack.

**How does it relate to the lethal trifecta?** Same insight, framed as a design rule. Willison's lethal
trifecta names the dangerous combination; the Rule of Two says don't assemble it in one session.

**What if my agent needs all three?** Don't run it autonomously — put the risky, irreversible step
behind human-in-the-loop approval or another reliable validation, as Meta recommends.

---

Munder Difflin is built for the safe side of this rule: a [local-first hive](https://munderdiffl.in/#how)
where your data stays on your machine and the irreversible waits for a human — so a single session is
hard-pressed to hold all three legs at once. [Download Munder
Difflin](https://munderdiffl.in/#install) to run agents that are powerful and scoped; it's free and
open source.

*Sources: [Meta AI — Agents Rule of Two](https://ai.meta.com/blog/practical-ai-agent-security/) (Oct 31,
2025); [Simon Willison — new prompt injection papers](https://simonwillison.net/2025/Nov/2/new-prompt-injection-papers/).*

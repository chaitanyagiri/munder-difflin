---
title: "Loop Engineering: Designing Agent Loops That Converge"
description: "Everyone engineers the prompt; almost nobody engineers the loop around it. Stop conditions, drain loops, retry with backoff, compaction cycles, breaker escalation, budgets, and human gates — the outer-loop mechanics that make an agent converge instead of run away."
date: 2026-07-03
category: concepts
categoryLabel: Concepts
type: Technical
primaryKeyword: "agent loop engineering"
secondaryKeywords: ["agentic loop", "runaway ai agent", "stop conditions for ai agents", "agent circuit breaker", "long-running ai agents", "no-progress detection"]
tags: ["Concepts", "Reliability", "Multi-Agent", "Autonomy", "Guardrails"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What is an agentic loop?"
    a: "It's the cycle an autonomous agent runs: gather context, take action, verify the result, repeat. Anthropic uses this framing for Claude Code and the Claude Agent SDK — an LLM autonomously using tools in a loop. The inner loop is what the model does each turn; the outer loop is everything the harness wraps around it: when to continue, when to retry, when to escalate, and when to stop."
  - q: "What makes an agent loop converge instead of running away?"
    a: "Three properties borrowed from ordinary loop design: a progress measure that actually moves toward done (verified state, not the model's own claim), hard bounds (iteration caps, token budgets, wall-clock limits), and real exits (task verified done, budget exhausted, or a human gate). A loop with any of the three missing is a runaway waiting for a quiet weekend."
  - q: "What is a drain loop?"
    a: "A pattern for keeping an agent working through a queue without a human re-prompting it. In Claude Code it's built on the Stop hook: when the agent tries to end its turn, the hook checks the inbox, and if mail is waiting it blocks the stop and continues the session with the next item as the prompt. The stop_hook_active flag exists precisely so this pattern can't recurse into an infinite forced continuation."
  - q: "How do you detect a runaway agent loop?"
    a: "By measuring progress from the outside, not by asking the agent. Signals include repeated near-identical tool calls, error storms (the same failure N times in a row), token spend rising while verified state doesn't change, and turns that end without any file, test, or board delta. A breaker watching those signals can intervene long before the budget does."
  - q: "Why are budgets part of loop design rather than just cost control?"
    a: "Because a budget is a loop bound — the guaranteed-termination clause. Even if every other signal fails and the agent loops plausibly forever, a per-agent token budget means the loop halts at a ceiling you chose in advance. Cost control is the side effect; bounded iteration is the point."
  - q: "Should a stopped agent loop end at a human?"
    a: "For the failure cases, yes. A converging loop has graduated responses — steer first, constrain next, stop last — and the terminal state of a stopped loop should be an approvals queue a human acts on, not a silent dead process. Escalation to a person is the exit condition of last resort, and it should be explicit in the design, not an accident."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p><strong>Prompt engineering shapes one turn. Loop engineering shapes whether ten thousand turns converge.</strong> The inner agentic loop — gather context, act, verify — comes with the model. The outer loop is yours to build: <strong>stop conditions</strong> that check verified state, <strong>drain loops</strong> that feed queued work back in, <strong>retry with backoff</strong>, <strong>compaction cycles</strong> that keep context bounded, a <strong>breaker ladder</strong> (steer → constrain → stop), <strong>no-progress detection</strong>, <strong>budgets as loop bounds</strong>, and <strong>human gates as exits</strong>. That's the difference between an agent floor that runs for days and one that melts by morning.</p></div>

There are two loops in every autonomous agent, and we only ever talk about one of them.

The inner loop is the famous one. Anthropic describes it as the agentic loop: **gather context → take action → verify work → repeat**. The model reads files, edits, runs the tests, reads the output, goes again. That loop ships with Claude Code, Codex, Copilot CLI — you don't build it, you rent it.

The outer loop is the one you build. It answers the questions the inner loop can't: should this agent keep going? On what? For how much? And who gets told when it shouldn't? Get the outer loop wrong and the inner loop's competence doesn't matter — you either stop too early and leave work stranded, or you don't stop and produce the classic runaway: an agent burning tokens at 3 a.m., confidently retrying the same failing command for the 40th time.

I think of this as **loop engineering**, and it deserves the same rigor we give prompts and context. (It's the sibling of [context engineering](/blog/context-engineering-for-ai-agents/) — that discipline shapes what's *in* the window; this one shapes what happens *between* windows.)

## Converging loops vs runaway loops

Borrow the checklist from ordinary programming. A `while` loop terminates when three things are true, and an agent loop is no different:

1. **A progress measure that moves.** Something external must get closer to done each iteration — tests passing, board cards moving, diffs landing. Crucially it must be *verified* state, not the model's self-report. Anthropic's guidance on long-running harnesses makes the same point: don't let the agent declare victory; keep an explicit feature list and only mark items done after real verification.
2. **Bounds.** Max iterations, max tokens, max wall-clock. A loop without a bound isn't autonomous, it's unattended.
3. **Exits.** Defined terminal states: done-and-verified, budget-exhausted, escalated-to-human. Every path out of the loop should be one you chose.

A runaway loop is just a loop missing one of these — usually the first. The agent is *doing things*, tokens are flowing, avatars are walking around, and nothing external is changing. Motion without progress.

{% img "note-1" %}

## The outer-loop toolbox

Here's the toolbox as it actually exists in [Munder Difflin](/), where the design constraint is blunt: a floor of CLI agents has to run for days without a human babysitting it, and without melting.

**Stop conditions.** The naive stop condition is "the model stopped talking." The engineered one checks state: is the task's definition of done verified? In Munder Difflin, workers don't self-certify — the GOD orchestrator reads results, adjudicates, and moves the board (see [how the GOD orchestrator works](/blog/how-the-god-orchestrator-works/)).

**Drain loops.** The most useful outer-loop pattern in Claude Code is built on the Stop hook: when an agent tries to end its turn, the hook checks its mailbox — and if mail is waiting, it blocks the stop and continues the session with the next message as the prompt. The agent drains its queue instead of dying with a full inbox. Claude Code's own hooks reference builds in the guardrail this pattern needs: a `stop_hook_active` flag, so a blocked stop can't recurse into an infinite forced continuation. That's loop engineering *inside* the primitive — one continuation per real stop, not a hall of mirrors.

**Retry with backoff.** Transient failures (rate limits, flaky network, a wedged terminal) deserve a retry; identical immediate retries deserve suspicion. Munder Difflin's wake-reliability layer takes the same stance at floor scale: revive wedged terminals, catch up missed schedules, re-arm the message router — recover the *loop*, don't just replay the failure. More in [recovering from agent failures](/blog/recovering-from-agent-failures/).

**Compaction cycles.** Long loops fill context windows, and a full window degrades every subsequent iteration. So compaction has to be part of the cycle, not an emergency. Munder Difflin runs a dedicated auto-compact maintenance schedule, decoupled from missions, and the floor even shows a *compacting* avatar state — because a maintenance pause that looks like a hang gets killed by nervous humans.

**Breaker escalation: steer → constrain → stop.** Binary kill switches are a bad fit for agents, because most divergence is recoverable. Munder Difflin's circuit breaker is a ladder: first *steer* (a corrective nudge into the session), then *constrain* (tighten what the agent may do), then *stop* — triggered by looping, error storms, or a blown budget. Graduated response preserves the work that a hard kill would throw away.

**No-progress detection.** The breaker needs a tripwire, and "is it looping?" can't be answered by asking the looper. External signals work: repeated near-identical actions, the same error N times, spend rising while verified state stays flat. There's also a quieter failure — the *silent* stall — which Munder Difflin catches with a PTY-quiescence backstop: an agent pinned `working` but producing no output gets flipped back to idle, where the inbox-wake nudge can restart its drain loop.

**Budgets as loop bounds.** Per-agent token budgets, tracked live against real telemetry, are the guaranteed-termination clause. If every other signal misses, the loop still halts at a ceiling you set while calm.

**Human gates as loop exits.** The final exit isn't a dead process; it's a person. Spend, scope changes, and destructive operations escalate into an approvals queue rather than resolving inside the loop — the human is a designed exit condition, not an interrupt handler. That's the heart of [human-in-the-loop agent design](/blog/human-in-the-loop-approving-ai-agents/).

{% img "note-2" %}

## The bottom line

The model gives you the inner loop; the outer loop is the product. Verified stop conditions, drain loops with anti-recursion guards, backoff, scheduled compaction, a breaker ladder, progress tripwires, budget bounds, and human exits — stacked together, they're why a floor of agents can run for days and converge on finished work instead of a bill.

Munder Difflin ships this outer loop as a free, MIT-licensed, local-first desktop app for the agent CLIs you already run. [Download it](https://github.com/chaitanyagiri/munder-difflin/releases/latest), and if the loop-nerdery resonates, a [GitHub star](https://github.com/chaitanyagiri/munder-difflin) helps more people find it.

## FAQ

**What is an agentic loop?** The cycle an agent runs each turn: gather context, act, verify, repeat. The outer loop is everything the harness wraps around it — continue, retry, escalate, stop.

**What makes a loop converge?** A verified progress measure, hard bounds, and designed exits. Missing any one of the three, you've built a runaway.

**What is a drain loop?** A Stop-hook pattern: when the agent tries to end its turn with mail waiting, the hook blocks the stop and continues the session with the next item — bounded by `stop_hook_active` so it can't recurse forever.

**How do you catch a runaway?** External signals only: repeated actions, error storms, spend without state change, silent stalls. Then respond on a ladder — steer, constrain, stop — with a human approvals queue as the terminal exit.

Sources: [Anthropic — Building agents with the Claude Agent SDK](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk);
[Anthropic — Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents);
[Claude Code — Hooks reference](https://code.claude.com/docs/en/hooks).

# The Hive — autonomous multi-agent layer

> How Munder Difflin turns a room full of independent `claude`
> processes into a collaborating, self-coordinating team with persistent memory,
> a shared blackboard, and a "god" orchestrator that runs the floor.

This document is the design source of truth for the agent-collaboration layer. It
sits alongside [`SPEC.md`](./SPEC.md) (terminal/event plane) and
[`DESIGN.md`](./DESIGN.md) (visual system). Code is the source of truth for what's
*built*; this is the source of truth for what we're *building toward*.

---

## 1. What we're building (and what it's called)

Each spawned agent is a real `claude` CLI process with a filesystem, a system
prompt, and a hook lifecycle. We layer four classic patterns on top:

| Behaviour the user asked for | Pattern (the name) |
| --- | --- |
| Per-agent memory file made at spawn, that the agent reads and updates | **Agent long-term memory** (MemGPT/Letta-style self-managed memory) |
| Writing a requirement into another agent's file | **Stigmergy** — coordinating by modifying a shared environment |
| A shared plan multiple agents edit | **Blackboard architecture** (Hearsay-II) |
| "Check after finishing every task" | **Mailbox / actor model** — drain an inbox at a lifecycle point |
| A "god" agent that runs the floor and clarifies for others | **Orchestrator / supervisor** (LangGraph-supervisor-style) |

The umbrella term is a **multi-agent system (MAS)** with **autonomous agent
loops**. The closest academic analogue to this app is Stanford's *Generative
Agents* (Park et al., 2023): Sims-style avatars in a 2D world with a memory
stream, retrieval, reflection, and planning.

---

## 2. Locked design decisions

1. **Git as the coordination/audit layer, single committer.** Everything the
   hive knows is files in one local git repo. To avoid `.git/index.lock`
   corruption with many concurrent agents, **only the Electron main process
   commits**. Agents never call git — they write plain files. (Research:
   GitHub Desktop's commit-queue pattern; lazygit/git-retry backoff.)
2. **Single-writer-per-file.** Each agent writes only inside its own
   `agents/<id>/` directory. Cross-agent delivery happens by the **router**
   (main process) moving messages from a sender's `outbox/` into a recipient's
   `inbox/`. No file is ever written by two processes.
3. **God-mode autonomy, native HITL.** A privileged **god agent** (lives in
   Michael's room) adjudicates cross-agent traffic. Routine requests
   (clarifications, data asks, plan tweaks) it resolves itself and the system
   keeps running fully autonomously. **Critical** items (destructive ops, spend,
   scope changes, unresolvable conflicts) route to the god, who surfaces them to
   the human natively in his own Claude Code session — there is no separate
   approval queue. Tool-permission prompts are the HITL gate, and they're
   approvable remotely from a phone via `/remote-control`.
4. **Memory: markdown first.** Per-agent `memory.md` + shared blackboard, with a
   SQLite FTS index when keyword recall isn't enough. A heavyweight vector layer
   (Letta/Mem0/Zep) is *not* needed at 5–15 agents and is architecturally wrong
   here (they want to own the agent runtime; our runtime is the `claude` CLI).
   Optional future upgrade: **MemPalace over MCP** (validate its retrieval first —
   its public benchmarks are overstated per independent audit).
5. **Autonomous loop = `Stop` hook.** An agent that finishes drains its inbox via
   a `Stop` hook that returns `{"decision":"block","reason":…}` to keep it
   working, guarded by `stop_hook_active` to prevent infinite loops.

---

## 3. On-disk layout — the "hive"

Lives under `<harnessHome>/hive/`, a git repo committed only by the main process.

```
hive/
  PROTOCOL.md            # the agent-facing contract (how to remember + message)
  registry.json          # roster: every agent, role, duty, capabilities, status, seat
  board.md               # shared blackboard / co-authored plans
  tasks.json             # task ledger (id, assignee, spec, status, result ref)
  log.jsonl              # append-only event feed (drives the UI activity stream)
  agents/<agentId>/
    identity.md          # who am I, my role, my capabilities  (read at start)
    memory.md            # my long-term memory  (I read at start, append as I learn)
    inbox/               # messages delivered TO me — <ts>-<msgid>.json
    inbox/.done/         # processed messages (kept for audit, not deleted)
    outbox/              # messages I want to SEND — router drains these
    cursor.json          # { lastProcessed: <msgid> }  — avoids reprocessing
```

Design rules that make this robust:
- **One JSON file per message**, written via temp-file + atomic `rename` — never
  a co-edited shared mailbox file (those conflict under git).
- **Append-only** `log.jsonl`; consumers track their own cursor.
- `board.md` is the one genuinely co-edited file — it goes through the god agent
  (single scribe) to avoid conflicts.

---

## 4. Message schema (FIPA-lite)

Borrow the one useful idea from FIPA-ACL/KQML — the **speech act** — and drop the
LISP syntax. Seven semantic fields:

```jsonc
{
  "id":            "2026-05-30T14-03-11-123Z-a1b2",  // unique, time-sortable
  "conversation":  "conv-7f3",                        // groups a thread
  "in_reply_to":   "<prev msgid> | null",
  "from":          "agent.researcher",
  "to":            "agent.coder | god | broadcast",
  "act":           "request | inform | propose | query | agree | refuse | done",
  "subject":       "short human-readable summary",
  "body":          "free text / markdown / structured payload",
  "hops":          3,            // ++ per reply; capped to kill ping-pong loops
  "requires_reply": true,        // only request/query/propose obligate a reply
  "needs_human":   false,        // router/god may flip this to escalate
  "created_at":    "ISO-8601"
}
```

Anti-livelock rules: only `request`/`query`/`propose` obligate a reply (pure
`inform`/`done` are terminal); every reply increments `hops`; past a hop cap the
god agent escalates instead of letting two agents loop forever; re-seeing a
processed `id` is a no-op (idempotent via cursor).

---

## 5. Control flow

```
agent B mid-task needs something from agent C
        │ writes  agents/B/outbox/<msg>.json   (act:request, to:C)
        ▼
┌─────────────────────── main process (the harness) ───────────────────────┐
│  Router watches every outbox/                                             │
│    → deliver to agents/C/inbox/   (to:"human" → routed to the god proxy;  │
│       the god surfaces critical calls natively in its own session)        │
│    → append to log.jsonl → git commit (single committer, retry+backoff)   │
└──────────────────────────────────────────────────────────────────────────┘
        │ delivered to C's inbox
        ▼
agent C finishes its current turn → Stop hook fires
        │ hook POSTs to the hive socket; main process checks C's inbox
        │ unread messages?  → reply {"decision":"block","reason": <messages>}
        ▼
agent C keeps working: reads the messages, acts, replies via its own outbox
```

The same hook socket drives the avatars: `PreToolUse`/`PostToolUse` payloads move
an agent to the right station (replacing today's `mockEvents.ts` / PTY-scraping).

---

## 6. The god agent (orchestrator)

A fixed, always-on agent seated at `desk-ceo` (Michael's room), `character:
michael`, flagged `isGod`. It is an ordinary `claude` process — the *intelligence*
— while the main process is the *mechanism* (git, sockets, routing). It owns:

- **Roster & routing** (`registry.json`): who exists, their capabilities, status.
- **Adjudication**: read each outbound request; resolve routine ones itself
  (answer clarifications, route to the right specialist with a self-contained
  task spec), escalate only critical ones. This is "god mode."
- **Blackboard scribe**: the single writer of `board.md`, so shared plans never
  conflict.
- **Task ledger** (`tasks.json`): assign, track, retry, checkpoint.

Its escalation policy (what counts as "critical") lives in its system prompt and
is the primary control surface — tune the prompt, not the code.

---

## 6a. Duties and the review gate

Every agent carries two independent descriptions of itself in `registry.json`:

| field | what it is | who reads it |
| --- | --- | --- |
| `role` | free-text hire one-liner ("Head of Marketing — owns …") | humans, and the agent itself |
| `duty` | a closed set the harness enforces | the harness |

They are not merged, and the temptation to merge them is the reason this table
exists: a gate cannot be driven by a string a human types freehand, and a hire
one-liner cannot be compressed into one word without losing its whole point.

`duty` is one of `planner` · `developer` · `reviewer` · `final-reviewer` ·
`unassigned` (`shared/agentDuty.ts`). A planner turns the human's requirements
into the plan and neither implements nor reviews; a developer implements that
plan; a reviewer reviews and does not implement; a final reviewer reviews
**last** and is the only duty whose approval completes a card. `unassigned` is
what every agent registered before this existed, and it behaves like a
developer.

**Every card walks planner → developer → reviewer → final reviewer → done.** A verdict is a
**message, not an edit** — locked decision #2 (single-writer-per-file) holds. An
agent drops one JSON into its own `outbox/` carrying
`"review": { "task": "<id>", "verdict": "submitted | approved | changes-requested" }`.
The router picks it up in `routeOnce`, the one place the sender is proven (by
which outbox the file came from — the file's own `from` is ignored), reads the
sender's duty from the registry, and records the verdict on the card itself.
No payload can therefore claim an authority its author does not hold, and no
agent ever writes `tasks.json`. The rules live in `shared/reviewGate.ts` and
are enforced by `hive.ts`:

- A `final-reviewer` approval only counts **after** a `reviewer` approval. The
  point of the whole design is the word *after* — "two approvals exist on the
  card" is easy and worthless, because a developer can push a change the moment
  both are in and the card still reads as signed off.
- So the trail is **versioned**. Each card has a `revision`; only entries at the
  current revision count. `changes-requested` bumps it, voiding every approval
  in that round — the developer fixes it, the reviewer approves again, then the
  final reviewer. Re-submitting already-approved work bumps it too.
- An agent's verdict on a card **assigned to itself** never counts, planning
  included.
- Several final reviewers may exist; **any one** of them suffices. Unanimity is
  not required.

### The plan is the one thing that is not versioned

A card is planned ONCE, and `isPlanned` is the only function in `reviewGate.ts`
that reads the whole trail instead of the current revision. That asymmetry is
the feature, not an oversight.

Everything else on a card is versioned precisely so a rejection forces the
reviewer and the final reviewer to look again. Had the plan been an ordinary
entry it would have been voided by the same bump, and **every rejection would
have routed the card back to the planner** — which is exactly the round trip the
operator ruled out. A review is a statement about the implementation, not about
the brief, so a bounced card is the developer's, working from the same plan,
however many rounds it takes. If the plan itself is wrong, that is a new
decision for the human, not a step in this loop.

The plan lives on the card's own `plan` field rather than in the trail: the
developer reads it on every round, and burying it in a history that grows with
each rejection would hide the brief behind the arguments about the brief. A
planner's whole message body becomes that field (capped at `PLAN_MAX_CHARS`),
where every other verdict's body is a 500-char review note.

### Where the gate actually holds

Two places, and the second one is the one that matters:

1. **`writeTasks`** — the choke point every IPC, kanban, voice, Slack and
   webhook write funnels through. A refused `done` is persisted as `doing` and a
   `review-gate` event naming the missing stage is appended to `log.jsonl`.
2. **`tasks()`** — the *read* boundary. The god is a `claude` process holding
   Write, and `tasks.json` is a file: it can put `"status": "done"` on a card
   with no trail and nothing intercepts the write. A file watcher was the other
   option and it is worse — it fights the writer, and rewrite-on-change against
   a git-committing store is a bad trade for a rule that only has to hold at the
   point of *use*. So every consumer that asks "is this card done?" asks
   `tasks()`, and it answers `doing`. The god can write the word; it cannot make
   the system agree. The correction is not persisted by a read (that would turn
   every poll into a commit) — the next real write applies it.

Mutations read `rawTasks()` instead, so the gate never leaks into a write: a
card the god claimed done keeps saying so on disk, and the moment its final
approval lands, `writeTasks` passes it without the god having to claim it twice.

### god always hears

god is the router, so a stage nobody routes is a card that waits for the next
heartbeat. Three things therefore reach his inbox as mail, not as log lines:

- **Every recorded verdict**, with the card's new stage and the ids that can
  clear it (`recordTaskReview` → `reviewOutcomeLine`). A verdict the reviewer
  already addressed to god gets that account appended to the same message —
  once, not twice.
- **A card he closed by hand that the gate holds open.** `sweepReviewGate` runs
  on every fourth router tick (~6s), reads the raw ledger, and mails once per
  `card@revision:stage`. It never rewrites the file — that is what a watcher
  would do, and fighting the writer is the thing this design avoids.
- **A duty change** (`patchAgentDuty`), because a reviewer appointed mid-session
  would otherwise sit idle until something else woke him. Appointing a *planner*
  additionally tells him that new work goes there first.

And the duty is in every place he already looks: the LIVE ROSTER line injected
on each turn (`DUTY: reviewer`), `fleet.json`, `registry.json`, and the voice
directory. His seed prompt carries the workflow unconditionally — it used to be
gated on a reviewer already existing, and Michael boots before anyone is hired.
A god-authored spawn request may carry `duty`, which is the one way he can put a
reviewer on the floor by himself.

### Two degradations, both deliberate

Without these, turning the feature on breaks every hive that predates it:

- **No regime, no gate.** If no active agent holds a reviewing duty, `done`
  passes through untouched.
- **A stage nobody can clear is skipped.** Reviewers but no final reviewer → the
  reviewer's approval completes the card. This is also what makes the
  self-approval rule safe: eligibility is computed *per card* with the assignee
  excluded, so a hive whose only reviewer **is** the assignee skips the stage
  rather than deadlocking on an approval that could never legally count.

Implementing is the one stage this cannot apply to: the moment any gating duty
exists, the regime is on and cards need an implementer. A mix of planner,
reviewer and final reviewer with **nobody holding the developer duty (and
nobody unassigned)** is the one duty configuration the harness pushes back on —
god is mailed once per episode (`developer-gap` in `log.jsonl`) naming the three
ways out: set `"duty": "developer"` on an agent in `registry.json`, write a
spawn request with `"duty": "developer"`, or leave an agent unassigned —
unassigned implements. The mail latches until an implementer appears, so a mix
that loses its implementer again is announced again; the sweep covers the
transitions a duty change cannot see (the last developer archived or gone).
- **`registry.dutyRegimeSince`** is stamped when the first gating duty is
  assigned, and never moved. Cards created before it are grandfathered — else
  appointing the first reviewer would drag every card the hive ever finished
  back onto the board.

The operator sets a duty in Add Agent / Edit Agent (`DutyPicker`). Editing takes
effect without a respawn: `registry.json` and the agent's `identity.md` are both
rewritten, so the agent reads its new limits at the start of its next task. A
duty is deliberately **not** taken from an imported hire manifest — it is the one
field that grants authority over other agents' work, and a downloaded hire that
nominated itself `final-reviewer` would hand external content the sign-off on
this hive's cards.

---

## 7. Phased plan

- **Phase 0 — Foundation** ✅: `hive.ts` on-disk layer + spawn injection
  (identity, protocol, env) + IPC to read hive state. Agents are hive-aware: they
  read their memory/inbox at task start and send via outbox; the router delivers;
  everything is committed and visible.
- **Phase 1 — Autonomy** ✅: `hooks.ts` UDS server + `cth-hook` shim (attached per
  agent via `--settings`) + `Stop`-loop so agents drain their inbox automatically
  and keep running (guarded by `stop_hook_active` + cursor); hook events stream to
  the renderer to drive avatars.
- **Phase 2 — God mode** ✅: the god agent auto-spawns into Michael's room
  (`desk-ceo` reserved) and, on a fresh spawn, is started with `/remote-control`
  (best-effort) plus an orientation prompt so it begins running the floor on its
  own. The router routes `to:"human"` traffic to the god (the human's proxy);
  there is no separate approval queue — human-in-the-loop is native to each
  agent's Claude Code session (permission prompts, approvable remotely from a
  phone). Idle agents are woken when they hold unread inbox messages.
- **Phase 3 — Semantic memory** ✅ (CLI integration): `memory.ts` wraps the
  **MemPalace CLI** (not MCP, by decision). The harness keeps one shared palace
  under `harnessHome`, points every agent's `MEMPALACE_PALACE_PATH` at it, mines
  each agent's `memory.md` into its own wing (mtime-gated), and agents recall via
  `mempalace search` / `wake-up`. Detect-and-degrade: a no-op when `mempalace`
  isn't installed (markdown memory still works). Default model `minilm` (light,
  for low-RAM Macs); `embeddinggemma` is the multilingual opt-in. A `MemoryPanel`
  lets the human search the same palace.
  - *Still open*: reflection/summarization to bound `memory.md`; needs a live
    `mempalace` install to validate retrieval end-to-end.

---

## 8. Key risks & mitigations

| Risk | Mitigation |
| --- | --- |
| `index.lock` corruption | Single committer (main process), retry+backoff, stale-lock cleanup |
| Infinite Stop-hook loop | Guard on `stop_hook_active`; `hops` cap; `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` |
| Two agents ping-ponging | Only request/query/propose obligate replies; hop cap → god escalates |
| Reprocessing messages | Per-agent `cursor.json`; processed messages move to `inbox/.done/` |
| `memory.md` unbounded growth | Phase 3 reflection/summarization |
| Modifying the user's repo with hooks | Write hooks to `<cwd>/.claude/settings.local.json` (gitignored convention) |

---

## 9. References

- Anthropic — *Building a multi-agent research system* (lead/subagent, plan-to-memory).
- LangGraph supervisor (structured routing + handoff registry + checkpoints).
- FIPA-ACL / KQML (speech acts).
- Stanford *Generative Agents* (memory stream, reflection, 2D world).
- Claude Code hooks reference (`Stop`, `PreToolUse`, `UserPromptSubmit`; `stop_hook_active`).

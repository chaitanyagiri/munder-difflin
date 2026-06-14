---
title: "Treating a Hire Manifest as Untrusted Input"
description: "A shareable agent-config manifest is attacker input. How Munder Difflin's import pipeline stays inert: no auto-spawn, default-deny flags, and an SSRF-safe bounded fetch."
date: 2026-06-15
category: internals
categoryLabel: Internals
type: Technical
primaryKeyword: "untrusted input agent config"
secondaryKeywords: ["command injection electron", "ssrf deep link", "default-deny allowlist", "shareable agent config security", "cmd.exe argument quoting"]
tags: ["Security", "Internals", "Electron", "Command Injection", "SSRF"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "Why is a shareable agent-config file a security problem?"
    a: "Because importing one is the same trust event as opening any link or downloading any file: the bytes are attacker-controlled. A 'hire' manifest is a JSON document you get by clicking a munderdifflin:// link or saving a file someone sent you. If any field in it can influence what process runs, what flags get passed, or what URL the app fetches, then a manifest is no longer data — it's an action an attacker triggers on your machine. So the import pipeline is built as a security boundary, not a convenience."
  - q: "Can importing a hire manifest spawn an agent on its own?"
    a: "No. Import only pre-fills the Add-Agent modal behind an 'imported' banner. The agent spawns solely when the human clicks submit in that modal. There is no code path that spawns on import — the manifest is data that proposes a configuration; the human is always the spawn gate."
  - q: "Can a manifest choose what program runs?"
    a: "No. There is no command or executable field in the schema. The binary always comes from the user's locally configured provider preset — claude, antigravity, or codex. provider: \"custom\" is rejected outright. A manifest can only select among providers you already installed; it can never name a new program to run."
  - q: "Why an allowlist for command flags instead of blocking the dangerous ones?"
    a: "Because the manifest's provider is attacker-chosen and each CLI keeps adding flags, a denylist is a bet that you enumerated every dangerous value — and it drifts and leaks as the tools evolve (ours leaked across three review rounds). A default-deny allowlist (SAFE_FLAG_NAMES) is a bet that you enumerated every safe value, and the safe set is small and stable. For attacker-controlled input, allowlist beats denylist."
  - q: "How does the deep-link fetch avoid SSRF?"
    a: "The fetch is https-only (plain http allowed only for loopback, for local gallery dev), follows redirects manually and re-validates every Location hop against the same https/loopback allowlist (capped at 5 hops), resolves and blocks private/loopback/link-local addresses including the 169.254.169.254 cloud-metadata endpoint, and streams the body through a bounded reader that aborts past 64 KB with a 10s timeout. A remote page can never redirect the app into http://127.0.0.1 or a metadata IP, and a hostile host can't OOM the main process by streaming an unbounded body."
  - q: "What risk is still left after all this?"
    a: "Free-text fields — goal and description — pre-fill the prompt the agent will run on, which is a prompt-injection surface. v1 accepts this because the human reviews every field before spawning and the binary and flags are locked down. The human remains the spawn gate; the manifest can suggest a task, but a person decides to run it."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>In v0.2.8 we shipped <strong>shareable hires</strong> — JSON manifests that configure an agent role and travel by link. A manifest is <strong>attacker-controlled input</strong> (you click a link, you download a file), so the import pipeline is a <strong>security boundary</strong>. The defenses: <strong>import never spawns</strong> (it only pre-fills a modal the human submits); <strong>no executable field</strong> (the binary comes from your own provider presets, <code>custom</code> is rejected); a <strong>default-deny flag allowlist</strong> (allowlist &gt; denylist for hostile input); strict charset validation on every stringly-typed field <em>plus</em> a hardened <code>cmd.exe</code> quoter at the sink; and an <strong>SSRF-safe, bounded fetch</strong> that re-validates every redirect hop and caps the body at 64 KB. Validate at the boundary <em>and</em> quote at the sink — defense in depth, both layers.</p></div>

A shareable hire is a nice feature with a sharp edge. You see a link — `munderdifflin://hire?src=https://gallery.example/pr-reviewer.json` — you click it, and the Add-Agent modal opens pre-filled with a tidy "PR Reviewer" role: a sprite, a model, a goal, a couple of flags. One more click and it's on your office floor. The convenience is the whole point. The problem is that everything in that manifest came from *someone else*.

That makes a hire manifest the same category of thing as a downloaded file or a clicked URL: **attacker-controlled input**. Nobody audits a JSON file before importing it any more than they read a `.dmg` before opening it. So the import pipeline can't treat the manifest as a trusted config object. It has to treat it as hostile bytes and prove, field by field, that nothing in it can turn into an *action* on your machine. This post is the threat model and the defense-in-depth that came out of a two-round security review — including one HIGH-severity bug that turned a clicked link into arbitrary code execution on Windows.

## The shape of the feature

A "hire" is a JSON manifest tagged `munder-difflin/hire@1`. The interesting fields:

```json
{
  "spec": "munder-difflin/hire@1",
  "name": "PR Reviewer",
  "sprite": "dwight",
  "provider": "claude",
  "model": "claude-sonnet-4-6",
  "commandFlags": ["--verbose"],
  "goal": "Review open PRs and leave inline comments.",
  "capabilities": ["read", "comment"],
  "tokenCap": 200000,
  "isolate": true
}
```

`provider` must be one of `claude` | `antigravity` | `codex`. There are two ways a manifest gets in: a `munderdifflin://hire?src=<https-url>` deep link, which the Electron **main** process fetches and validates, and a plain local-file import. Both paths funnel into **one** validator (`src/shared/hire.ts`) and end at the same place: the Add-Agent modal, pre-filled.

The single most important property of the whole design falls out of that last sentence.

## Trust boundary #1: import never spawns

**The manifest is data, never an action.** Importing a hire does exactly one thing — it pre-fills the Add-Agent modal, behind an "imported" banner that tells you these values came from outside. It does not start anything. The agent spawns only when *you* click submit in that modal, after the fields are sitting in front of you.

There is no code path — not the deep link, not the file import, not a malformed-but-clever payload — that spawns an agent as a side effect of import. This is the cleanest defense there is, because it makes the human the spawn gate by construction. Every other layer below is about ensuring that the *configuration* a manifest proposes is safe to hand to a person for one-click approval. But even if a field slipped through, nothing runs until a human says so. Import proposes; the human disposes.

## No executable field

The second structural defense is an absence. **There is no `command` or `executable` field in the schema.** A manifest cannot name the program that runs. The binary always comes from the user's **locally configured provider preset** — the `claude`, `agy`, or `codex` you installed and pointed the app at. `provider: "custom"` is rejected by the validator outright, precisely because a custom provider is a user-side escape hatch for naming an arbitrary binary, and we will not let a downloaded file reach through it.

So the worst a manifest can do on the "what runs" axis is *select among providers you already trust*. It picks `claude` or `codex`; it cannot introduce `curl` or `/bin/sh`. That shrinks the attack surface to the *arguments* passed to a binary you already chose to install — which is exactly where the interesting bug lived.

## The HIGH-severity bug: Windows command injection via `model`

The first review found it. `commandFlags` were validated tightly from day one — but `model` was only **length-capped**, never **shape-checked**. And `model` is not inert: it flows onto the spawn command line as `--model <model>`, quoted only if it contained whitespace.

That "quoted only if it contained whitespace" is the whole bug. Consider this manifest field:

```json
"model": "x&calc"
```

No whitespace, so the spawn logic passed it through unquoted. On macOS and Linux that's harmless — argv goes straight to `node-pty`, no shell is involved, and `x&calc` is just one literal (nonsense) argument. But on **Windows**, when the provider binary is a `.cmd` or `.bat` shim — which is the **default** for an npm-installed `claude` / `agy` / `codex` — Node routes the spawn through `cmd.exe /d /s /c`. And `cmd.exe`'s argument quoter, at the time, only escaped space, tab, and `"`. It did **not** escape `cmd` metacharacters like `&`. So the command line became:

```text
claude --model x & calc
```

`cmd.exe` reads `&` as a command separator. It runs `claude --model x`, then runs `calc`. One clicked `munderdifflin://hire` link → arbitrary code execution.

This is the classic failure mode for untrusted input, and worth naming precisely: **untrusted JSON is supposed to stay inert, but a stringly-typed field leaked out of the data plane and into a shell.** `commandFlags` got the scrutiny because it *looked* dangerous; `model` looked like a harmless label, so it was only length-checked — and a label that reaches a command line is not a label, it's an argument, and on Windows an argument that reaches `cmd.exe` is potentially a command.

## The two-layer fix (do both)

The fix is deliberately redundant, because the two layers fail differently and a defense-in-depth posture wants both.

**Layer 1 — validate at the boundary.** Constrain `model` to a safe charset so a hostile value never makes it past the validator in the first place:

```js
const MODEL_RE = /^[A-Za-z0-9 ._()[\]\/:@+-]{1,80}$/;
```

`&` is not in that class. Neither is `| ^ < > ; $ % \` " '`. The PoC `x&calc` fails `MODEL_RE.test(model)` and the import is rejected with a validation error. This restores the invariant that *untrusted JSON stays inert* — a malicious `model` can't even reach the modal, let alone a spawn.

**Layer 2 — quote at the sink.** Harden the Windows `cmd.exe` argument quoter so it also quotes any token containing `& | ^ < > ( ) % !`. This is the belt to the validation suspenders, and it's broader than the hire feature: it guards **every** spawn path in the app, not just imported manifests. If some *other* future field ever leaks a metacharacter onto a command line, the quoter catches it even if a validator forgot to.

Why both? Because they protect against different mistakes. Validation is the *specific* fix — it knows `model` should look like a model id. The quoter is the *general* fix — it knows that no argument, from any source, should be able to break out of its slot on a Windows command line. Either one alone closes the PoC; together they mean a single forgotten check on one field is not, by itself, a code-execution bug. **Validate at the boundary and quote at the sink** is one of the durable lessons here.

## Default-deny: the flag allowlist

`commandFlags` is the field most obviously capable of mischief, and it's where the review process taught the cleanest lesson. The first version used a **denylist** — a set of dangerous flags to reject (`--dangerously-*`, settings overrides, MCP config, and so on). It was reasonable, and it leaked.

It leaked because the manifest's `provider` is attacker-chosen, and each CLI — claude, agy, codex — keeps adding flags release over release. A denylist is a snapshot of "every bad flag we could think of," and the moment a CLI ships a new dangerous flag (or you discover a `codex`/`agy` superset gap you'd missed), the denylist has a hole. Ours leaked across **three** review rounds: each round found another flag — a config-override here, a base-URL redirect there — that the denylist didn't know to block.

So we flipped it. `commandFlags` is now a **default-deny allowlist**. Every flag-shaped token has to clear two gates:

```js
const FLAG_RE = /^[A-Za-z0-9._\/=:,@+-]{1,100}$/;   // no whitespace, no shell metachars, no % env-expansion
const SAFE_FLAG_NAMES = new Set([ /* a small, curated set of known-harmless flags */ ]);
```

A token must (a) match `FLAG_RE` — so no whitespace, no shell metacharacters, no `%` (which would invite `cmd.exe` environment expansion) — **and** (b) have a flag name that's in `SAFE_FLAG_NAMES`. Nothing system-prompt-related, settings-related, MCP-related, or provider/base-URL-related is ever allowlisted, because those are the flags that change *what the agent trusts* or *where it talks to*. And the args, once validated, go to `node-pty` as an **argv array** — never concatenated into a shell string.

The general principle is worth stating plainly: **for attacker-controlled input, an allowlist beats a denylist.** A denylist is a bet that you enumerated every *bad* value — and that bet loses every time the world adds a new bad value you didn't anticipate. An allowlist is a bet that you enumerated every *safe* value — and the safe set is small, well-understood, and changes slowly. When the input is hostile and the surface keeps growing, you want to be betting on the small stable set, not the unbounded one.

## SSRF-safe, bounded fetch

The deep link `munderdifflin://hire?src=<url>` hands the app a URL it will fetch from the **main** process — which has the network and the OS at its disposal. A naive fetch here is a classic server-side request forgery (SSRF) primitive: a remote page tells *your* app to make a request *you* didn't intend. The transport (`src/main/hire.ts`) is hardened on three axes, each of which started out wrong in the first cut.

### https-only, with a loopback carve-out

The fetch is **https-only**. Plain `http` is allowed *only* for loopback, so the local hire-gallery dev server works over `http://127.0.0.1`. The carve-out is deliberately narrow: a remote, public page can never point the app at an `http://` target, so it can't downgrade you onto an internal plaintext service.

### Redirect SSRF, closed

The first version used `fetch(url, { redirect: 'follow' })`. That validates only the **initial** URL — the final hop after a redirect is never re-checked. So an attacker hosts `https://evil.example/m.json`, the app validates *that* (it's https, it's public, fine), and then the server answers `302 Location: http://127.0.0.1:PORT/...` or `→ http://169.254.169.254/...` (the cloud-metadata endpoint). `fetch` follows the redirect, and the app has now made a request to an internal address it would never have accepted directly.

The fix is to take over redirect handling:

```text
redirect: 'manual'              // don't auto-follow
for hop in 0..5:                // cap at 5 hops
    if status is 3xx:
        loc  = response Location header
        next = new URL(loc, current)
        if next.protocol !== 'https:'  → reject   // a hop may not drop into http/loopback
        if !isPublicAddress(next.host)  → reject   // re-validate the resolved address
        current = next; continue
    else: this is the real response
```

Every `Location` is re-validated against the **same** https/public-address allowlist as the initial request, with a hard cap of ≤5 hops. `https → https` redirects (link shorteners, CDNs) still work; `https → http://127.0.0.1` and `https → 169.254.169.254` are dead. The same pass also closed an **IPv6-bracket bypass** in the host check — the host parser strips `[`/`]` before resolving, so `https://[::1]/` and friends can't sneak a loopback address past a string comparison.

### Streamed byte cap

The first version trusted the `content-length` header, then did `await res.text()`. Two bugs in one line. First, it buffered the **entire** body before checking length — so a hostile host could just *not send* a `content-length` (or lie about it) and stream gigabytes, OOM-ing the main process. Second, `.length` on the resulting string counts UTF-16 code units, not bytes, so the cap it *did* apply was measuring the wrong thing.

The fix is a bounded reader (`readBounded`) that streams the response and **aborts the moment the accumulated byte count exceeds 64 KB**, never trusting `content-length` as anything but a hint. A 10-second timeout bounds the time axis too. A manifest is a few hundred bytes of JSON; anything claiming to be megabytes is, by definition, not a hire.

## One validator, four copies in sync

A security boundary is only as good as its consistency. The validator in `src/shared/hire.ts` is **dependency-free and pure** — no I/O, no imports beyond the language — which is exactly what lets it run in three places at once: the Electron **main** process (for the deep-link path) and the **renderer** (for file import and modal pre-fill). The hire **gallery** mirrors the same rules in a client-side validator (`docs/hires/validator.js`), and a JSON schema (`docs/hires/spec/hire.schema.json`) encodes them once more for tooling. Same charset rules, same allowlist, same provider constraint, everywhere — so a manifest that the gallery says is valid is the manifest the app will accept, and there's no soft spot where one copy is laxer than another.

## What's still on the human

The honest caveat. Two fields — `goal` and `description` — are free text, and they pre-fill the **prompt** the agent will run on. That's a prompt-injection surface: a manifest can suggest a task, and the words of that task are attacker-influenced. v1 accepts this deliberately, on two grounds. First, the human **reviews every field** in the modal before clicking spawn — the goal text is right there to read. Second, the things that would turn a poisoned prompt into real damage are locked down upstream: the binary is your own provider, the flags are allowlisted, no settings or system-prompt overrides get through. The prompt can ask the agent to do something dubious, but the agent runs inside the same [permission and sandboxing model](/blog/agent-security-and-sandboxing/) as any other, and the [human is in the loop](/blog/human-in-the-loop-ai-agents/) on the actions that matter. The manifest never gets to be the spawn gate. A person does.

That's the line we hold for v1, and we're candid that it *is* a line and not a wall: free text into a prompt is, fundamentally, part of the [lethal trifecta](/blog/the-lethal-trifecta-for-coding-agents/) story, and the durable answer there is architectural, not a regex. Locking the binary and flags is how we keep a poisoned goal a *nuisance* rather than a *breach*.

## The transferable lessons

Strip away the specifics and the hire pipeline is a small catalog of rules for any "import an untrusted config" feature:

- **Make import inert.** Importing data should never be an action. Pre-fill, then make a human commit. The spawn gate is a person, by construction.
- **Don't let data name the executable.** Configs select among *your* trusted programs; they never introduce one. Reject the custom-provider escape hatch.
- **Validate at the boundary *and* quote at the sink.** A charset check on each field and a hardened quoter on the command line catch different mistakes; defense in depth wants both.
- **Allowlist, don't denylist, hostile input.** A denylist bets you enumerated every bad value against a growing surface; an allowlist bets you enumerated the small, stable safe set. The latter doesn't rot.
- **Re-validate every redirect hop, and never trust `content-length`.** SSRF lives in the *final* hop and in *unbounded* bodies. Follow redirects manually, re-check each target's protocol and resolved address, cap the hops, and stream the body to a hard byte limit with a timeout.

A shareable hire is a link you click. The whole point of the import pipeline is that clicking it stays as boring as it looks.

---

Shareable hires shipped in **v0.2.8** — see the [launch notes](/blog/launching-munder-difflin-v0-2-8/) and the [concept companion on shareable agent roles](/blog/shareable-agent-roles/) for the feature side, and the [CHANGELOG](https://github.com/chaitanyagiri/munder-difflin/blob/main/CHANGELOG.md) for the full diff. The security posture here is the same one that runs through the rest of the harness: [permission modes and sandboxing](/blog/agent-security-and-sandboxing/), the [lethal trifecta](/blog/the-lethal-trifecta-for-coding-agents/), and [human-in-the-loop on the actions that matter](/blog/human-in-the-loop-ai-agents/).

---
title: "Run Munder Difflin Locally on a Mac Mini"
description: "A step-by-step guide to running a whole Munder Difflin hive offline on an Apple Silicon Mac Mini — how to size models to your unified memory, install Ollama or LM Studio, and wire OpenCode and Crush to a local endpoint."
date: 2026-06-22
category: guides
categoryLabel: Guides
type: Technical
draft: false
primaryKeyword: "run munder difflin on a mac mini"
secondaryKeywords: ["local llm mac mini", "ollama mac mini", "apple silicon unified memory llm", "offline ai agents mac", "lm studio mac mini agents"]
tags: ["Guides", "Local-First", "Mac Mini", "Ollama", "LM Studio", "BYOK"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "Can a Mac Mini run a Munder Difflin hive offline?"
    a: "Yes. An Apple Silicon Mac Mini runs the model locally through Ollama or LM Studio, and Munder Difflin points OpenCode and Crush at that local OpenAI-compatible endpoint (in v0.3.1 pi reaches models through a third-party provider key rather than a local server). The hive's control plane (router, scheduler, mailboxes, audit log) is already local-first, so once the model is local there is no cloud dependency at all."
  - q: "How much RAM does the Mac Mini need for local AI agents?"
    a: "It depends on the model size, not the agent count — every worker shares one local model server. As a rule of thumb on Apple Silicon's unified memory: 16GB comfortably runs 7–8B models, 24GB runs up to ~14B, 32GB up to ~32B (tight), and 48–64GB (M4 Pro) runs a 70B-class model quantized to 4-bit. See the RAM-tier table below."
  - q: "Ollama or LM Studio — which should I use on a Mac Mini?"
    a: "Either works; both expose an OpenAI-compatible server that Munder Difflin's engines can target. Ollama is a lightweight CLI/daemon (great for headless, always-on hives); LM Studio is a GUI with a model browser and a one-click local server. You can even run both and point different engines at different ports."
  - q: "Which open-source models run best on each engine?"
    a: "All three engines — OpenCode, Crush, and pi — select models in `provider/model` form. For the fully-local path, OpenCode and Crush point at a local OpenAI-compatible endpoint, so the same locally-served model works across both; in v0.3.1 pi runs through a third-party provider key instead. For the exact, version-verified model slugs and per-RAM-tier picks, see the open-source model catalog linked below — that's the single source of truth we keep current."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>A <strong>Mac Mini</strong> with Apple
Silicon can run an entire <strong>Munder Difflin</strong> hive <em>offline</em>. Serve an open-source
model locally with <strong>Ollama</strong> or <strong>LM Studio</strong>, size the model to your
<strong>unified memory</strong> (16GB → ~7–8B, 24GB → ~14B, 32GB → ~32B, 48–64GB → 70B-class at 4-bit),
then point <a href="/blog/why-cli-agents-are-powerful/">OpenCode and Crush</a> at the local endpoint via
<strong>Settings → AI Engines</strong> (pi uses a third-party provider key in v0.3.1). The hive's control plane is
<a href="/blog/local-first-ai-agent-orchestration/">already local-first</a>, so nothing leaves the box.</p></div>

It's one thing to run a single local model in a chat window. It's another to put a whole *team* of
agents to work on your own hardware, with no API bill and no data leaving the room. That's the promise
of running Munder Difflin on a Mac Mini: the [orchestration is already
local-first](/blog/local-first-ai-agent-orchestration/) — the message router, scheduler, mailboxes, and
git audit log are all processes on your machine — so the only remaining cloud dependency is the model
call itself. Move that local, and the hive is fully offline.

This guide walks the whole setup: picking a Mac Mini tier, understanding how Apple Silicon's unified
memory bounds what you can run, installing a local model server, and wiring each CLI engine to it.

## Why the Mac Mini is a good hive box

The Mac Mini is the cheapest way into Apple Silicon's **unified memory** architecture, and unified
memory is exactly what local LLMs want. On a Mac, the CPU, GPU, and Neural Engine all share one pool of
high-bandwidth RAM — so the model's weights live in the same memory the GPU computes against, with no
copy across a PCIe bus. A 32GB Mac Mini can hold a model that would need a 32GB *discrete* GPU on a PC,
at a fraction of the price and power draw. And because the Mini is small, quiet, and sips power, it's a
natural always-on box for a hive you leave running for hours.

One catch worth knowing up front: **Apple Silicon RAM is soldered to the chip and cannot be upgraded
after purchase.** Buy the memory you'll want for the largest model you intend to run — it's the one
spec you can't change later.

## Step 1 — Pick a Mac Mini tier for the model you want to run

Model count doesn't drive your RAM — *model size* does. Every worker in the hive shares one local model
server, so a ten-agent hive and a two-agent hive on the same model need roughly the same memory. What
you're really choosing is **how large a model the box can hold.**

A 4-bit-quantized model needs roughly **0.6 GB of memory per billion parameters** for its weights, plus
headroom for the KV cache (grows with context length), the model server, and macOS itself. macOS also
caps how much unified memory the GPU may pin — by default around 65–75% — though you can raise that
ceiling on a dedicated box with `sudo sysctl iogpu.wired_limit_mb=<MB>` when you need to fit a large
model. A practical rule: **plan for the model to use about two-thirds of your unified memory** and leave
the rest for context and the OS.

Current Mac Mini lineup and what each tier comfortably runs (4-bit quant):

| Mac Mini | Unified memory | Memory bandwidth | Comfortable model size (Q4) |
|---|---|---|---|
| M4 (base) | 16GB | 120 GB/s | ~7–8B (e.g. an 8B-class coder) |
| M4 | 24GB | 120 GB/s | up to ~14B |
| M4 | 32GB | 120 GB/s | up to ~32B (tight; short context) |
| M4 Pro | 48GB | 273 GB/s | ~32B with room, or a 70B at heavy quant |
| M4 Pro | 64GB | 273 GB/s | 70B-class at 4-bit |

*(Newer Mac Mini chips raise bandwidth and the memory ceiling, but the same "model ≈ two-thirds of
unified memory" sizing rule carries over — pick the tier by the model size you want.)*

Here's a concrete pick for each tier. Pull these with Ollama (LM Studio carries the same models as
GGUF/MLX): `ollama pull <tag>`, then reference the model as `local/<tag>` in OpenCode or `ollama/<tag>` in
Crush (more on that in Step 3).

| Mac Mini RAM | Recommended pick (Ollama tag) | Weights (Q4) | Good for |
|---|---|---|---|
| 16GB | `gpt-oss:20b` (tight) — or lighter `qwen3:8b` / `deepseek-r1:8b` | ~14GB / ~5GB | Smallest genuinely capable default; the 8B picks leave more context headroom |
| 24GB | `qwen3:14b` · `mistral-small:24b` | 9–14GB | Roomy generalist with context to spare |
| 32GB | `qwen3:30b-a3b` (MoE) · `qwen3-coder:30b` · `deepseek-r1:32b` | ~19–20GB | The sweet spot — fast MoE generalist, coding, or reasoning |
| 48GB (M4 Pro) | `glm-4.7-flash` (q8) · `mixtral:8x7b` | 26–32GB | Bigger context, plus the only Mac-viable GLM |
| 64GB (M4 Pro) | `llama3.3:70b` · `deepseek-r1:70b` | ~43GB | A 70B-class generalist or reasoner at 4-bit |
| 96GB+ (Studio-class) | `gpt-oss:120b` · `llama4:scout` | 65–67GB | Top local models; need ~80GB resident |

These picks are drawn from the model families our open-source model catalog tracks — the single source of
truth we keep version-current.
The companion guide, <a href="/blog/run-munder-difflin-on-open-models/">running Munder Difflin on open
models</a>, pairs each tier with the same picks and adds the third-party-provider route.

<div class="callout"><span class="ic">⚠️</span><p><strong>What a Mac Mini <em>can't</em> run
locally.</strong> The frontier open-weight flagships — <strong>Kimi K2.x</strong> (~1&nbsp;trillion
parameters) and <strong>GLM-5.2</strong> (744B) — are server-class: their 4-bit weights run to hundreds of
gigabytes, far past any Mac Mini. To use those, skip the local server and point an engine at a third-party
open-source-model provider (OpenRouter, Groq, DeepInfra, and friends) with an API key — covered in the
<a href="/blog/run-munder-difflin-on-open-models/">open-models guide</a>. For a genuinely local GLM,
<code>glm-4.7-flash</code> (~30B) is the Mac-friendly member of the family.</p></div>

## Step 2 — Install a local model server

You have two solid options. Both expose an **OpenAI-compatible HTTP endpoint**, which is exactly what
Munder Difflin's engines target.

### Option A — Ollama (lightweight, headless-friendly)

```bash
# Install (Homebrew) and start the daemon
brew install ollama
ollama serve              # runs the API on http://localhost:11434

# Pull a model (pick the tag for your RAM tier — see Step 1)
ollama pull gpt-oss:20b   # 16GB-friendly default; swap for your tier's tag
```

Ollama's OpenAI-compatible API is served at **`http://localhost:11434/v1`**. It runs as a background
daemon, which makes it the natural choice for an always-on hive box.

### Option B — LM Studio (GUI, model browser, one-click server)

Download LM Studio from [lmstudio.ai](https://lmstudio.ai), search and download a model in its UI, then
start the **Local Server** (the "Developer" / server tab). LM Studio serves an OpenAI-compatible API at
**`http://localhost:1234/v1`**.

<div class="callout"><span class="ic">💡</span><p>You can run <em>both</em> — Ollama on :11434 and LM
Studio on :1234 — and point different engines at different ports if you want to compare models side by
side across your workers.</p></div>

## Step 3 — Wire each CLI engine to the local endpoint

Munder Difflin runs each agent on a pluggable [CLI engine](/blog/why-cli-agents-are-powerful/). All three engines select models in **`provider/model`** form, but for the fully-local path it's **two** —
OpenCode and Crush — that wire a local OpenAI-compatible endpoint in v0.3.1, so the same locally-served
model works across both. (pi reaches models through a third-party provider key in this release — see its
note below.) The fastest path
is **Settings → AI Engines**: set the per-engine base URL to your local server and pick the model; the
harness writes the right per-agent config for you. Here's what that maps to under the hood for each
engine.

### Crush

Crush reads a JSON config. Define the local server as an **`openai-compat`** provider (this keeps it on
the OpenAI wire, which is what the harness proxy expects — don't use Crush's native `ollama`/`lmstudio`
discovery types for the hive path):

```json
{
  "providers": {
    "ollama": {
      "name": "Ollama",
      "type": "openai-compat",
      "base_url": "http://localhost:11434/v1",
      "api_key": "ollama",
      "models": [
        { "name": "gpt-oss 20B", "id": "gpt-oss:20b", "context_window": 131072, "default_max_tokens": 8192 }
      ]
    }
  }
}
```

Then select the model as `ollama/gpt-oss:20b` (swap in the tag for your RAM tier from Step 1). For LM
Studio, use `base_url: "http://localhost:1234/v1"`, `api_key: "lm-studio"`, and a `lmstudio` provider key,
then select `lmstudio/<model-id>`.

### OpenCode

OpenCode reaches a local model through a custom OpenAI-compatible provider (the `@ai-sdk/openai-compatible`
adapter with `options.baseURL`). In Munder Difflin, set the OpenCode base URL in Settings → AI Engines to
your local server and choose the model in `provider/model` form; the harness supplies the engine config.

### pi

A heads-up specific to **v0.3.1**: pi's local-endpoint field is **reserved.** This release wires a local
base URL for OpenCode and Crush only — it does not yet write a local provider into pi's `models.json` — so
the fully-offline path today runs on **OpenCode or Crush.** To put pi to work in this release, point it at
a third-party open-source-model provider instead of a local server: set a provider key in **Settings → AI
Engines** (e.g. an OpenRouter or Groq key) and pick an open-model slug such as
`openrouter/openai/gpt-oss-120b` or `groq/llama-3.3-70b-versatile`. pi joins the local path once its
local-endpoint field ships; until then, build your offline hive on OpenCode and Crush.

<div class="callout"><span class="ic">📋</span><p><strong>The same local model, three prefixes.</strong>
Once a model is served locally, each engine names it slightly differently: OpenCode as
<code>local/&lt;tag&gt;</code>, Crush as <code>ollama/&lt;tag&gt;</code>. For example, gpt-oss 20B is
<code>local/gpt-oss:20b</code> in OpenCode and <code>ollama/gpt-oss:20b</code> in Crush. (In v0.3.1, pi
points at a third-party <code>provider/model</code> slug instead, per the note above.) The exact slugs for
every tier live in the <a href="/blog/run-munder-difflin-on-open-models/">open-source model catalog</a>,
kept in one place so they don't drift.</p></div>

## Step 4 — Run the hive offline

With a model served locally and the engines pointed at it, the rest of Munder Difflin is already
local-first. Spin up your workers from the [Agent Gallery or Add Agent](/blog/how-to-install-and-use-munder-difflin/),
give the hive a goal, and let it run. The [message router](/blog/atomic-file-mailboxes-for-agents/) moves
work between agents through file mailboxes, the scheduler fires tasks on local timers, and git records
the audit trail — none of it touches a network. Pull the Ethernet cable and the hive keeps working.

A few operational notes for an offline Mac Mini hive:

- **One model, many workers.** Every agent shares the local server, so concurrency is bounded by the
  Mac Mini's compute, not by per-agent memory. Watch tokens/sec under load and keep contexts trim on the
  16/24GB tiers.
- **Keep it awake.** A headless always-on hive wants the Mini to not sleep — set Energy settings to
  prevent sleep (or `caffeinate` the session) so the router and scheduler keep ticking.
- **Quantization is your lever.** If a model won't fit, drop to a heavier quant before dropping a tier —
  4-bit is the usual sweet spot for coder models on these boxes.
- **Fully offline means OpenCode or Crush.** In v0.3.1 those are the two engines that wire a local base
  URL, so a hive built on them runs with the cable pulled. pi currently reaches models through a
  third-party provider key (its local field is reserved), so pi workers need a network — mix engines
  accordingly if total isolation is the goal.

## Where to go next

- The companion guide, [run Munder Difflin on open models](/blog/run-munder-difflin-on-open-models/),
  covers running fully local *or* through a third-party open-source provider, and pairs each RAM tier
  with a concrete model pick.
- For the *why* behind keeping it all on your machine, see [why local-first matters for AI
  agents](/blog/why-local-first-matters-for-ai-agents/).
- New to the app? Start with [how to install and use Munder
  Difflin](/blog/how-to-install-and-use-munder-difflin/).

---
title: "Run Munder Difflin on Open-Source Models — Fully Local or via a Third-Party Provider"
description: "Munder Difflin v0.3.1 runs your agent floor on open-weight models — gpt-oss, Qwen3, DeepSeek, Llama, Mistral, GLM, Kimi — either fully local (Ollama/LM Studio/vLLM) or through a third-party OSS provider. Here's how to wire each across the OpenCode, Crush, and pi engines."
date: 2026-06-22
category: guides
categoryLabel: Guides
type: Technical
primaryKeyword: "run ai agents on open source models"
secondaryKeywords: ["local llm coding agent", "ollama coding agent", "openrouter coding agent", "gpt-oss", "byok open models", "opencode crush pi"]
tags: ["Guides", "Local-First", "Open Source", "CLI Agents", "Tutorial"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "Can Munder Difflin run entirely on open-source models?"
    a: "Yes. As of v0.3.1 the OpenCode, Crush, and pi engines all support bring-your-own-key (BYOK) and local models. You can run every agent — workers and the god orchestrator — on open-weight models like gpt-oss, Qwen3, DeepSeek, Llama, Mistral, GLM, or Kimi, either fully local on your own hardware or through a third-party OSS provider with your own API key."
  - q: "What's the difference between running local and using a third-party provider?"
    a: "Local (Ollama, LM Studio, vLLM) runs the weights on your own machine — fully private, no per-token bill, but bounded by your RAM and GPU. A third-party OSS provider (OpenRouter, Groq, Together, Fireworks, DeepInfra) hosts the same open weights on their hardware and you pay per token with your own key — no local hardware limit, so you can reach the 100B–1T-parameter frontier models a laptop can't hold."
  - q: "Which open model should I pick for the god orchestrator?"
    a: "The god seat does the reasoning and long-context coordination, so give it a strong model: locally, gpt-oss-120b or Llama 3.3 70B on a 64–96 GB machine; via a provider, DeepSeek-V4-Flash, GLM-4.6, or Kimi-K2.6 on OpenRouter. Small local models (8B and under) are fine for routine workers but underpowered for orchestration."
  - q: "Do I need a different model id for each engine?"
    a: "No — the upstream model id is the same. All three engines use a provider/model slug; only the provider prefix and how the key or base-URL is wired differ. For local models, OpenCode uses local/<id> while Crush and pi use ollama/<id>."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p><strong>Munder Difflin v0.3.1 runs entirely on open models.</strong> The three new engines — <strong>OpenCode</strong>, <strong>Crush</strong>, and <strong>pi</strong> — all support bring-your-own-key and local LLMs, for workers <em>and</em> the god orchestrator. Two routes: <strong>fully local</strong> (Ollama / LM Studio / vLLM on your own machine — private, no per-token bill, bounded by RAM) or a <strong>third-party OSS provider</strong> (OpenRouter, Groq, Together, Fireworks, DeepInfra — their hardware, your key, reaching frontier 100B–1T models a laptop can't hold). Every engine uses a <code>provider/model</code> slug; you set keys and local base-URLs in <strong>Settings → AI Engines</strong>, then pick the model in the Add-Agent modal.</p></div>

Munder Difflin started as a harness for the closed frontier CLIs — Claude Code, Codex, Antigravity. Useful, but it tied your agent floor to a handful of vendors and their pricing. **v0.3.1 breaks that open.** It adds three engines that were built, from the start, to point at *any* model: [OpenCode](https://opencode.ai), [Crush](https://charm.land), and [pi](https://pi.dev). All three speak the open-weight ecosystem — and that means you can run an entire office of agents on models whose weights are public.

There are two honest ways to do that, and they trade off differently. This guide walks both, then shows the exact wiring for each engine. (For the why-bother, see [why local-first matters for AI agents](/blog/why-local-first-matters-for-ai-agents/) and [why CLI agents are so powerful](/blog/why-cli-agents-are-powerful/).)

## Two routes: your hardware, or someone else's

"Open source models" is one phrase covering two very different setups. Pick by what you're optimizing for.

| | Fully local | Third-party OSS provider |
|---|---|---|
| **Runs on** | Your machine (Ollama, LM Studio, vLLM) | Their GPUs (OpenRouter, Groq, Together, Fireworks, DeepInfra, Novita) |
| **Cost** | Electricity. No per-token bill. | Per-token, billed to your own key. |
| **Privacy** | Total — code never leaves the box. | Prompts transit a third party. |
| **Ceiling** | Bounded by RAM/VRAM (≈7B–70B realistic on a Mac). | The whole frontier — 235B, 480B, even 1T-parameter models. |
| **Setup** | Pull a model + point the engine at `localhost`. | Paste one API key. |
| **Best for** | Private work, 24/7 unattended, fixed cost. | Frontier quality, zero local hardware, bursty use. |

You don't have to choose globally — Munder Difflin sets the engine and model *per agent*. A common pattern: a strong provider-hosted model in the god seat for orchestration, and cheap local workers for the routine majority. That's exactly the [capability-routing](/blog/do-more-with-less-model-routing/) idea, now with open weights on both ends.

## How the three engines name a model

One thing to internalize before any wiring: **all three engines use the same `provider/model` slug form.** The *model* part is just the upstream's id (e.g. `openai/gpt-oss-120b`, `qwen3:30b-a3b`). The *provider* prefix resolves one of two ways:

- **A built-in provider** the engine already knows — supply the matching API-key env var and you're done. OpenCode (via the AI-SDK / models.dev registry), Crush, and pi each ship a list of recognized providers: `openrouter`, `openai`, `anthropic`, `groq`, `deepseek`, `mistral`, and the local ones.
- **A custom OpenAI-compatible provider** you define once (a `base_url` + key block) for any host that isn't built in — Together, Fireworks, DeepInfra, Novita, Z.ai, Moonshot. Then the slug is `<your-name>/<model-id>`.

The *local* route differs slightly by engine — same id, different prefix and wiring:

| Engine | How v0.3.1 wires local | Local slug |
|---|---|---|
| **OpenCode** | Injects a custom provider named `local` (OpenAI-compatible) with your base-URL. | `local/<id>` |
| **Crush** | Writes a provider block (`type: ollama / lmstudio / openai-compat`) into the agent's config. | `ollama/<id>` |
| **pi** | Not wired in v0.3.1 — the local base-URL field is **reserved** (file-based `models.json` is a fast-follow). Run open models on pi via a third-party provider key for now (see Path B). | — |

Default endpoints are the usual ones: Ollama `http://localhost:11434/v1`, LM Studio `http://127.0.0.1:1234/v1`, vLLM whatever you exposed (often `:8000/v1`). You set these in the app — no shell exports required.

## Path A — fully local (Ollama / LM Studio / vLLM)

Three steps: pull a model, tell Munder Difflin where it lives, pick it for an agent.

**1. Pull a model.** With [Ollama](https://ollama.com) installed, grab one sized to your RAM:

```bash
ollama pull gpt-oss:20b        # 14 GB — runs on a 16 GB Mac, the safe default
ollama pull qwen3:30b-a3b      # 19 GB — fast MoE generalist, 32 GB
ollama pull deepseek-r1:32b    # 20 GB — strong reasoning, 32 GB
ollama serve                   # exposes the OpenAI-compatible API on :11434
```

(LM Studio works the same way — load the model in the app and it serves on `:1234`. vLLM and llama.cpp expose their own OpenAI-compatible endpoint.)

**2. Point the engine at it.** Open **Settings → AI Engines**, find the engine you'll use (**OpenCode** or **Crush**), and set its **local base-URL** field to your endpoint — e.g. `http://localhost:11434/v1` for Ollama. This is the per-CLI local field v0.3.1 added; the harness uses it to inject the right provider config when it spawns the agent. No API key needed for local. (pi's local base-URL field is **reserved** in v0.3.1 — the harness doesn't yet write it a `models.json` — so to run open models on pi today, use a third-party provider key via Path B below.)

**3. Hire an agent on that model.** In the **Add-Agent** modal, choose the engine, then pick the local model. The picker offers the open-model quick-picks; the slug it sends is `local/gpt-oss:20b` on OpenCode, or `ollama/gpt-oss:20b` on Crush (keep the colon in the tag). That agent now runs fully on your hardware.

Which local model? Match it to your machine. These picks are from the project's open-model catalog, by RAM tier:

| Model | Ollama tag | Min RAM | Good for |
|---|---|---|---|
| gpt-oss 20B | `gpt-oss:20b` | 16 GB | Smallest capable default |
| Mistral Small 24B | `mistral-small:24b` | 16–32 GB | Lightweight generalist |
| Qwen3 30B-A3B (MoE) | `qwen3:30b-a3b` | 32 GB | Fast MoE generalist |
| Qwen3-Coder 30B | `qwen3-coder:30b` | 32 GB | Coding |
| DeepSeek-R1 32B | `deepseek-r1:32b` | 32 GB | Reasoning |
| GLM-4.7-Flash | `glm-4.7-flash` | 32 GB | The only Mac-viable GLM |
| Llama 3.3 70B | `llama3.3:70b` | 64 GB | Bigger generalist |
| gpt-oss 120B | `gpt-oss:120b` | 96 GB | Top local (Studio-class) |

A note on what *won't* fit: the headline frontier open models — DeepSeek-V4 (1.6T / 284B), Kimi K2.6 (~1T), GLM-5.2 (744B), Qwen3-235B — are server-class. The Ollama tags exist, but no consumer Mac holds them. For those, you want Path B. (Choosing a local model by RAM is the whole subject of the companion [Mac Mini setup guide](/blog/run-munder-difflin-on-a-mac-mini/).)

## Path B — a third-party OSS provider (BYOK)

Same open weights, hosted on someone else's GPUs, billed to your own key. This is how you reach the big models, and it's a two-field setup.

**1. Get a key.** Sign up with a provider and copy an API key. [OpenRouter](https://openrouter.ai) is the easiest start — one key, the widest catalog (it fronts most of the others). [Groq](https://groq.com) is the fastest for the models it carries. Together, Fireworks, and DeepInfra host the heavyweights.

**2. Paste it into the app.** In **Settings → AI Engines**, enter the key in the matching field. Keys are stored **write-only through the broker** — the renderer can set a key but never read it back; only the main process injects it as the right env var (`OPENROUTER_API_KEY`, `GROQ_API_KEY`, …) when an agent spawns, and only for the provider that agent actually uses. Nothing lands in plaintext config.

**3. Pick a model.** In Add-Agent, select the engine and a provider-hosted model. The slug carries the provider prefix — e.g. `openrouter/deepseek/deepseek-v4-flash` or `groq/openai/gpt-oss-120b`. The recommended BYOK quick-picks:

| Model | Route | Slug | Key env |
|---|---|---|---|
| gpt-oss 120B (fastest) | Groq | `groq/openai/gpt-oss-120b` | `GROQ_API_KEY` |
| Llama 3.3 70B | Groq | `groq/llama-3.3-70b-versatile` | `GROQ_API_KEY` |
| DeepSeek-V4-Flash | OpenRouter | `openrouter/deepseek/deepseek-v4-flash` | `OPENROUTER_API_KEY` |
| GLM-4.6 | OpenRouter | `openrouter/z-ai/glm-4.6` | `OPENROUTER_API_KEY` |
| Kimi K2.6 | OpenRouter | `openrouter/moonshotai/kimi-k2.6` | `OPENROUTER_API_KEY` |
| Qwen3-Coder 480B | OpenRouter | `openrouter/qwen/qwen3-coder` | `OPENROUTER_API_KEY` |
| gpt-oss 120B | OpenRouter | `openrouter/openai/gpt-oss-120b` | `OPENROUTER_API_KEY` |

Prefer a model maker's own API? Those work too: DeepSeek (`deepseek/deepseek-v4-flash`, `DEEPSEEK_API_KEY`), Mistral (`mistral/...`, `MISTRAL_API_KEY`), Z.ai for GLM, Moonshot for Kimi. A couple of moving targets worth knowing as of mid-2026: DeepSeek's `deepseek-chat` / `deepseek-reasoner` aliases retire on 2026-07-24 (wire `deepseek-v4-flash` directly), and Groq is sunsetting Llama 4 — so on Groq stick to gpt-oss and `llama-3.3-70b-versatile`. The full slug-by-slug table, with citations and verify-live caveats, lives in the project's open-model catalog (the single source of truth this post and the Mac Mini guide both cite).

## Per-engine cheat-sheet

You rarely touch these directly — the AI Engines panel writes them — but here's what each engine does under the hood, so the model field makes sense.

**OpenCode** is OpenAI-SDK native and knows most providers out of the box. BYOK is just the env var; local is a custom provider named `local`. Slugs: `openrouter/openai/gpt-oss-120b`, `local/qwen3:30b-a3b`.

**Crush** reads BYOK env vars for its built-in providers and uses a written config block for anything custom or local. For local Ollama it's literally:

```json
{ "providers": { "ollama": { "type": "ollama", "base_url": "http://localhost:11434/v1" } } }
```

then select `ollama/qwen3:30b-a3b`. For a host like Together, it's an `openai-compat` block with that provider's `base_url` and your key.

**pi** (the Pi Coding Agent) ships 15+ built-in providers, so BYOK is just the provider key. Slugs look like `groq/llama-3.3-70b-versatile` or `openrouter/qwen/qwen3-coder`. Its local base-URL field is **reserved** in v0.3.1 — Munder Difflin doesn't yet write pi a `models.json` — so for now run open models on pi through a third-party provider key rather than a local endpoint; local-via-base-URL is a fast-follow.

All three are god-eligible in v0.3.1, so you can put an open model in the orchestrator seat, not just the workers. For the god seat, give it a strong one — `gpt-oss:120b` or `llama3.3:70b` locally (64–96 GB), or a frontier provider model like `openrouter/deepseek/deepseek-v4-flash`. Sub-8B models are great workers but thin for orchestration.

## The bottom line

Open weights turn Munder Difflin from "a harness for three vendors' CLIs" into "a harness for the whole open ecosystem." Run it **fully local** when privacy and fixed cost matter and your RAM can hold the model; run it on a **third-party provider** when you want frontier quality or no local hardware at all — and mix the two across your floor, agent by agent. The setup is two fields in **Settings → AI Engines** and a pick in Add-Agent; the open-model slugs are curated in the project catalog so you don't have to guess.

That's the promise kept: a virtual office of CLI agents on your own computer, now running on models whose weights anyone can read. [Download Munder Difflin](https://munderdiffl.in/#install) — it's free, open source, and local-first. Then point your favorite open model at it. (On a Mac and want the hardware-by-RAM walkthrough? Read the [Mac Mini setup guide](/blog/run-munder-difflin-on-a-mac-mini/).)

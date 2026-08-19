---
title: "AEO for Dev Tools: Getting Cited by ChatGPT and Claude"
description: "Answer Engine Optimization for dev tools: how to get cited by ChatGPT, Claude, and Perplexity with the right robots.txt, JSON-LD, and writing patterns."
date: 2026-06-04
category: concepts
categoryLabel: Concepts
type: Non-technical
primaryKeyword: "answer engine optimization"
secondaryKeywords: ["aeo", "generative engine optimization", "ai search"]
tags: ["Concepts", "AEO", "SEO", "DevRel"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What is Answer Engine Optimization (AEO)?"
    a: "AEO is optimizing your content so AI answer engines like ChatGPT, Claude, and Perplexity cite it when they answer a user's question — the AI-era successor to ranking in Google's blue links."
  - q: "How is AEO different from SEO?"
    a: "SEO optimizes a page to rank so a human clicks it; AEO optimizes content to be the source an AI quotes in its synthesized answer, often with no click at all."
  - q: "How do I get my dev tool cited by ChatGPT and Claude?"
    a: "Answer the question in the first sentence, mark it up with FAQPage and SoftwareApplication JSON-LD, let AI crawlers like GPTBot and ClaudeBot into your robots.txt, and be the clearest canonical source on your topic."
  - q: "Should I block AI crawlers in robots.txt?"
    a: "If you want citations, no — blocking GPTBot, ClaudeBot, or Google-Extended removes you from the answers; only block them if avoiding training use matters more than being discovered."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p><strong>Answer Engine Optimization (AEO)</strong>
is making your content the thing an AI <em>quotes</em>, not just a page a human clicks. For a developer
tool whose users increasingly ask ChatGPT, Claude, and Perplexity "what should I use for X?", being
cited in that answer is the new front page. The playbook: <strong>answer first</strong>,
<strong>mark it up</strong> with JSON-LD, <strong>let the AI crawlers in</strong>, and <strong>be the
clearest source</strong> on your topic. Here's exactly how we do it for Munder Difflin — copy it.</p></div>

A growing share of "how do I…" and "what's the best tool for…" questions never reach a search box
anymore. They go to an answer engine — ChatGPT, Claude, Perplexity, Google's AI Overviews — which
reads the web for you and hands back a synthesized answer with a few citations. If your
[dev tool](/blog/best-claude-code-multi-agent-tools/) isn't in those citations, you're invisible to
the exact developers evaluating tools like yours.

This is the discipline of **Answer Engine Optimization (AEO)** — sometimes called Generative Engine
Optimization (GEO). It overlaps with SEO but optimizes for a different outcome: not a ranked link, but
a *quoted sentence*. This post is the playbook we actually run, with the real config.

## AEO vs SEO: a click vs a quote

**SEO optimizes a page to rank so a human clicks it. AEO optimizes content to be the source an AI
quotes in its answer — often with no click at all.** They share foundations (crawlable, fast,
well-structured pages) but diverge on intent:

| | SEO | AEO |
|---|---|---|
| **Goal** | Rank → earn the click | Be the cited source in the answer |
| **Unit that wins** | The page | The quotable sentence |
| **Reader** | A human skimming results | An LLM extracting a claim |
| **Best content shape** | Keyword-targeted long-form | Direct answers + structured facts |
| **Win condition** | Position 1–3 | "According to Munder Difflin…" |

The good news: you don't choose between them. AEO is mostly SEO done with a tighter discipline —
clearer answers, stronger structure, honest facts. A page that an LLM can confidently quote is also a
page Google's AI Overviews and traditional results reward.

{% img "note-1" %}

## Why dev tools should care more than most

Developer tools sit at the perfect intersection for AEO:

- **Your audience already asks LLMs.** "Best way to run multiple Claude Code agents?" is a question a
  developer types into Claude before they type it into Google.
- **The questions are answerable.** Tool comparisons, definitions, and how-tos have crisp, factual
  answers — exactly what answer engines like to cite.
- **You're awareness-stage.** A new or open-source tool has no brand gravity yet. Getting named in an
  AI's answer *is* the introduction.

That's why, for an open-source project like [Munder Difflin](/blog/why-we-built-munder-difflin/), we
treat "get cited by the answer engines" as a first-class distribution channel, not an afterthought.

## The AEO playbook (what we actually do)

### 1. Answer the question in the first sentence

LLMs extract claims, and the easiest claim to extract is a direct, self-contained sentence near the
top. Lead with the answer, then explain — the inverted pyramid, not a slow build.

So instead of *"There are many ways to think about agent coordination…"*, write: **"A multi-agent
harness is software that wraps the agents you already run and coordinates them with memory, messaging,
and orchestration."** That sentence can be lifted verbatim into an answer with your name attached.

Every post we publish opens with a **TL;DR** and uses **bold, quotable one-liners** under each
heading — see the [AI coding agent glossary](/blog/ai-agent-glossary/), which is one quotable
definition after another. That structure isn't decoration; it's the extraction surface.

### 2. Mark it up with structured data (JSON-LD)

Structured data tells a machine *what the page is* without it having to infer. Three schemas do most
of the AEO work for a dev tool:

- **`SoftwareApplication`** on your homepage — name, description, operating systems, price, license,
  download URL. This is how an engine knows you're a free, cross-platform tool.
- **`FAQPage`** on pages with a Q&A block — each question/answer becomes individually quotable and is
  eligible for "People also ask" surfaces.
- **`BlogPosting` + `BreadcrumbList`** on articles — author, dates, and section, so the answer engine
  can attribute and date your claim.

Here's the shape of the FAQ markup we emit on this very post:

```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [{
    "@type": "Question",
    "name": "What is Answer Engine Optimization (AEO)?",
    "acceptedAnswer": {
      "@type": "Answer",
      "text": "AEO is optimizing your content so AI answer engines like ChatGPT, Claude, and Perplexity cite it when they answer a user's question."
    }
  }]
}
```

> **Don't fabricate trust signals.** It's tempting to add `aggregateRating` to your
> `SoftwareApplication` markup. Don't — inventing review data is self-serving structured-data abuse
> that Google penalizes, and answer engines increasingly cross-check. Only mark up facts that are true.

### 3. Let the AI crawlers in

This is the step most teams miss: an answer engine can't cite a page it was never allowed to read.
Many sites quietly block AI crawlers — and then wonder why they're never cited. If you want the
citations, **explicitly allow** the answer-engine bots in `robots.txt`. This is the exact block we
ship:

```
User-agent: *
Allow: /

# AI answer engines — explicitly welcome. We WANT to be cited.
User-agent: GPTBot
Allow: /
User-agent: OAI-SearchBot
Allow: /
User-agent: ChatGPT-User
Allow: /
User-agent: PerplexityBot
Allow: /
User-agent: ClaudeBot
Allow: /
User-agent: Google-Extended
Allow: /

Sitemap: https://munderdiffl.in/sitemap.xml
```

There's a real tradeoff here, and you should decide it deliberately. Allowing `GPTBot`,
`Google-Extended`, and `ClaudeBot` also permits training use of your content. For an awareness-stage
open-source tool, being discoverable is worth far more than withholding text — so we allow them all.
If avoiding training matters more to you than citations, flip those agents to `Disallow: /` and accept
that you're opting out of the answers too. **You can't have the citations without the crawl.**

### 4. Write FAQ blocks with one-sentence answers

A FAQ section does double duty: it's genuinely useful to readers, and it's the most quotable format
that exists. Each answer should be a single, complete sentence that stands on its own without the
question. Our [Munder Difflin FAQ](/blog/munder-difflin-faq/) is built this way — "Is it free? Yes,
it's free and open source under the MIT license." is a sentence an engine can quote whole.

### 5. Be the canonical source on your topic

Answer engines prefer sources that are *clear, consistent, and complete*. You earn "canonical source"
status by:

- **Defining your terms.** If you coin or popularize a concept ("single-committer pattern," "GOD
  orchestrator"), define it crisply and link to it everywhere. Be the page that *defines* the thing.
- **Comparison tables.** Engines love structured comparisons because they map directly onto "X vs Y"
  questions. An honest table beats three paragraphs of prose.
- **Consistent entity naming.** Use the same product name, the same one-sentence description, and the
  same `sameAs` links (your GitHub repo) everywhere. Consistency is how an engine resolves "Munder
  Difflin" to one entity instead of fragments.

### 6. Treat your repo and freshness as ranking surfaces — honestly

For a dev tool, your GitHub repo is a ranking surface too: a keyword-led "About" description, a strong
README, and topics all feed the same entity. And keep content fresh — but **honestly**. Real
`lastmod` dates and genuine updates help; faking freshness by bumping dates on unchanged pages is the
kind of manipulation that gets discounted. Update when you actually have something new.

{% img "note-2" %}

## How to measure AEO (when there's no rank tracker)

AEO has no clean "position 3" metric, so measure it directly: **ask the engines.** On a monthly
cadence, ask ChatGPT, Claude, and Perplexity the exact questions your users would ask — *"how do I run
multiple Claude Code agents?"*, *"best tool to coordinate AI coding agents?"* — and check whether
you're named and whether the description matches what you wrote. When you start seeing your own
sentences come back, the playbook is working. Pair that with a weekly glance at search-console
impressions for the question-shaped queries.

## The one-paragraph version

**AEO is SEO with a tighter contract: write a sentence worth quoting, prove what the page is with
structured data, let the AI crawlers read it, and be the clearest source on your topic — then verify
by asking the engines directly.** None of it is exotic; it's mostly discipline. And it compounds,
because the same page that an LLM will confidently cite is the same page a human will trust.

If you want to see these patterns in a real, open codebase, every post on this blog is built to be
quotable, and our [what is a multi-agent harness](/blog/what-is-a-multi-agent-harness/) explainer is
the canonical-source pattern in action.

---

Munder Difflin is a local, open-source multi-agent harness for Claude Code — and a working example of
AEO done in public. [Download Munder Difflin](/#install) to see it run, or read [what a multi-agent
harness actually is](/#what). Free and MIT-licensed.

---
title: "Generative Engine Optimization: The Techniques the Research Backs"
description: "What the first peer-reviewed GEO study found works to get content cited by AI — statistics, source citations, quotes — and why keyword stuffing backfires."
date: 2026-06-05
category: concepts
categoryLabel: Concepts
type: Non-technical
primaryKeyword: "generative engine optimization techniques"
secondaryKeywords: ["geo study", "how to get cited by ai", "ai search optimization"]
tags: ["Concepts", "AEO", "SEO", "GEO"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What is Generative Engine Optimization (GEO)?"
    a: "GEO is optimizing content to be surfaced and cited by AI-generated answers (ChatGPT, Perplexity, AI Overviews). The term was coined by a 2023 academic paper (Aggarwal et al.) that measured which content edits actually increase visibility in those answers."
  - q: "Which GEO techniques actually work?"
    a: "The research found the biggest gains came from adding statistics, citing sources, and including quotations — substantive, verifiable additions — with reported visibility lifts on the order of ~40%. Fluent, well-written content compounded the effect."
  - q: "Does keyword stuffing help with AI search?"
    a: "No — the GEO study found it didn't help and in some tests slightly hurt (it underperformed baseline content on Perplexity). LLMs are trained on natural language and tend to penalize forced, unnatural phrasing."
  - q: "Is the GEO research the final word?"
    a: "No. It's a strong, peer-reviewed starting point from 2023–2024, but generative engines change fast and the study used its own benchmark — treat the findings as well-evidenced direction, not a guarantee, and verify by testing your own content."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>There's actual peer-reviewed research on
getting cited by AI. The 2023 <strong>"GEO: Generative Engine Optimization"</strong> paper (Aggarwal
et al., presented at ACM KDD 2024) tested content edits across ~10 generative engines and 10,000
queries. The winners: <strong>add statistics, cite sources, and include quotations</strong> — reported
visibility lifts around <strong>40%</strong>. The loser: <strong>keyword stuffing</strong>, the classic
SEO reflex, which didn't help and sometimes hurt. Here's what the study found, the honest caveats, and
how to apply it.</p></div>

Most advice about ranking in AI search is vibes. But there is a real, peer-reviewed study underneath the
hype — and it's refreshingly specific about which edits move the needle. This post walks through what
the GEO research actually measured, what worked, what flopped, and where to be skeptical. It's the
evidence companion to our [AEO playbook](/blog/what-is-aeo-for-dev-tools/) (the tactics) and our
breakdown of [how answer engines choose what to cite](/blog/how-ai-answer-engines-choose-sources/) (the
mechanics).

## The study, briefly

The paper [*GEO: Generative Engine Optimization*](https://arxiv.org/abs/2311.09735) (Pranjal Aggarwal,
Vishvak Murahari, Tanmay Rajpurohit, Ashwin Kalyan, Karthik Narasimhan, Ameet Deshpande) was the first
academic framework for the question "how do you get your content into an AI's answer?" It was
[presented at ACM KDD 2024](https://collaborate.princeton.edu/en/publications/geo-generative-engine-optimization/),
and it did three useful things:

1. **Coined the term** "Generative Engine Optimization" and framed it as distinct from classic SEO.
2. **Built a benchmark** — testing content-modification methods across multiple generative engines over
   ~10,000 real queries.
3. **Introduced measurement** beyond "did I get a link," including an *impression score* that weights
   how prominently (and where) your source appears in the generated answer. Citation isn't binary;
   position and prominence matter.

That last point is the quiet contribution: it gave the field a way to *measure* AI visibility instead
of guessing.

## What worked: substance, not tricks

The headline result is consistent across summaries of the study: the biggest visibility gains came from
**substantive, verifiable additions** to content. Specifically:

- **Cite sources.** Adding citations to authoritative external sources produced large gains —
  [reported as the single strongest lever](https://aithinkerlab.com/generative-engine-optimization-2026/),
  especially for content that started out lower-ranked.
- **Add statistics.** Inserting relevant, concrete numbers improved visibility by roughly
  [41% in the study's metrics](https://sunilpratapsingh.com/guides/geo/what-research-says-about-generative-engine-optimization).
- **Add quotations.** Including quotes from relevant, credible voices lifted visibility (on the order of
  ~28%).
- **Write fluently.** Fluency optimization compounded with the above — readable, well-structured prose
  amplified the gains rather than competing with them.

The through-line: generative engines reward content that is *quotable and evidenced*. A sentence with a
statistic, a citation, and a clear claim is exactly the kind of thing an LLM can lift into an answer
with confidence — which is the whole game.

{% img "note-1" %}

## What flopped: keyword stuffing

Here's the finding worth tattooing on the SEO reflex: **keyword stuffing didn't work.** In the GEO
research, jamming target keywords in — a tactic that historically nudged classic search — failed to
improve AI visibility, and in some tests
[*underperformed* baseline content on Perplexity by around 10%](https://www.cnabke.com/en/faq/abke-ab-guest-geo-faq-why-keyword-stuffing-hurts-ai-recommendation-retrieval.html).

The reason is structural: LLMs are trained on natural language and are good at detecting clumsy, forced
phrasing. Stuffing keywords degrades the very fluency that the study found *helps*. The old game
rewarded matching strings; the new game rewards reading well and saying something verifiable.

## The honest caveats

Depth means naming the limits, and the GEO research has them — several practitioners have
[critiqued it](https://richsanger.com/generative-engine-optimization-a-critical-look/) fairly:

- **It's from 2023–2024.** Generative engines have changed a lot since; specific percentages should be
  read as *directional*, not as guarantees you can bank in 2026.
- **It used its own benchmark.** Results on a constructed GEO-bench may not transfer cleanly to every
  engine, domain, or query type.
- **Effects vary by starting position.** The biggest lifts (the eye-popping numbers) often applied to
  *lower-ranked* content with more room to gain — not uniformly to everyone.

None of that invalidates the core lesson; it just means you treat the study as strong evidence for a
*direction* and confirm with your own testing. Which is the scientific posture anyway.

{% img "note-2" %}

## How to apply it

For a blog, docs, or a product page you want cited:

- **Lead with evidence.** Where you'd write "it's fast," write "it renders 60+ live terminals at 60fps"
  — a number an engine can quote.
- **Cite primary sources** for any non-obvious claim, and link them. (This very post does it.)
- **Quote credible voices** — a named expert line beats an anonymous assertion.
- **Write for humans first.** Fluency is a ranking signal now; awkward keyword-loaded prose is a
  penalty, not a boost.
- **Measure prominence, not just presence.** Ask whether your content is cited *and* featured
  prominently in answers — and re-check monthly, because engines drift.

## The bottom line

**The research is clear and a little subversive: get cited by AI by being more substantive, not more
optimized.** Statistics, citations, quotations, and clean writing win; keyword tricks lose. That's a
good world to compete in — the same edits that get you quoted by a machine make your content genuinely
better for the human who reads it. Pair this with the [tactics playbook](/blog/what-is-aeo-for-dev-tools/)
and the [per-engine mechanics](/blog/how-ai-answer-engines-choose-sources/) and you have the full
picture; the [Munder Difflin FAQ](/blog/munder-difflin-faq/) is a small worked example of quotable,
evidenced answers.

---

Munder Difflin is built [in the open](/#what) with content designed to be cited — evidenced, structured,
and quotable. [Download Munder Difflin](/#install) to see it; free and open source.

<p style="font-size:0.85em;opacity:0.7;margin-top:2rem">Sources: <a href="https://arxiv.org/abs/2311.09735">Aggarwal et al., "GEO: Generative Engine Optimization" (arXiv 2311.09735, ACM KDD 2024)</a>; <a href="https://collaborate.princeton.edu/en/publications/geo-generative-engine-optimization/">Princeton publication record</a>; <a href="https://aithinkerlab.com/generative-engine-optimization-2026/">GEO study summary</a>; <a href="https://richsanger.com/generative-engine-optimization-a-critical-look/">a critical look at GEO research</a>. Specific percentages are from the 2023–2024 study and should be treated as directional.</p>

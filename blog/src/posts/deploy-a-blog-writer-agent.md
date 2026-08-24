---
title: "Deploy a Blog-Writer Agent: The One That Wrote This Post"
description: "How Munder Difflin's blog is written by an automated writer agent in the hive — drafts in a worktree, single-committer integration, Eleventy build, human-gated deploy, and now hand-drawn illustrations from the same office. Build your own."
date: 2026-06-10
updated: 2026-08-20
category: use-cases
categoryLabel: Use Cases
type: Non-technical
primaryKeyword: "automated blog writer agent"
secondaryKeywords: ["ai blog automation", "content agent", "multi-agent blogging", "automated content pipeline"]
tags: ["Use Cases", "Automation", "Content", "Multi-Agent", "Open Source"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "Did an AI actually write the Munder Difflin blog?"
    a: "Yes — most of it. A writer agent in the hive drafts each post from a topic brief and a house-style reference, Michael integrates it as the single committer, Eleventy builds the markdown into the static site, and a human approves the final deploy to munderdiffl.in. This very post is an example of that pipeline running — and as of August 2026, the same office also draws every post's illustrations as code."
  - q: "Is the blog-writer agent fully autonomous?"
    a: "Almost — it's deliberately human-gated at one point: publish. The agent drafts and self-reviews against a style reference in an isolated worktree; the orchestrator integrates and builds; a person reviews the diff and approves the deploy. That keeps the volume high and hands-off without putting an unreviewed post on the live domain."
  - q: "How do I build my own blog-writer agent?"
    a: "Give one agent in the hive three things: a topic or brief, a house-style reference (a few of your best existing posts), and write access to an isolated worktree. Let it draft, have a reviewer agent or the orchestrator check it, then human-approve the build and deploy. Munder Difflin gives you the worktree isolation, single-committer git, skills, and approval queue out of the box."
  - q: "Why use a multi-agent hive instead of one prompt to write blog posts?"
    a: "One prompt writes one post. A hive runs a content function: a writer drafts, a reviewer checks, the orchestrator integrates and builds, and a scheduled mission can fire the loop on a cadence — so you get a steady, compounding stream of on-topic posts rather than a single output you have to re-prompt for each time."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>The Munder Difflin blog is written by an
<strong>automated writer agent</strong> living in the hive. The loop: a writer agent drafts a post in an
<strong>isolated worktree</strong> from a topic brief + a house-style reference; <strong>Michael</strong>
integrates it as the single committer; <strong>Eleventy</strong> builds
<code>blog/src/posts</code> → <code>docs/blog</code>; and a human approves the deploy to
<strong>munderdiffl.in</strong>. The outcome is a steady, on-topic stream — <strong>well over a hundred
posts and counting</strong>, every one now illustrated by code the same office wrote.
<em>This post was made that way.</em></p></div>

Here's a fact that's either a confession or a flex, depending on how you read it: the blog you're reading
is mostly written by one of our own agents. Not "AI-assisted." Not "drafted then heavily rewritten." A
**writer agent** in the Munder Difflin hive takes a brief, drafts a full post, and hands it down a pipeline
that ends — after one human nod — on the live site.

This very post is an instance of that system working. So let me do the most on-brand thing possible and use
it as the worked example. Here's how the blog-writer agent is automated, why the outcome compounds, and how
to stand up your own.

## The outcome first: a library, not a launch post

Before the *how*, the *why it matters*. This blog now holds **well over a hundred published posts** —
the topic chips at the top of [the index](/blog/) show the live counts. They're not filler — they
cluster into a real content strategy: guides, internals deep-dives, concept explainers, comparisons,
orchestration patterns, and a pointed story set, including [why we built
Munder Difflin](/blog/why-we-built-munder-difflin/) and the
[launch-week retros](/blog/what-reddit-told-us-about-munder-difflin/). The thought-leadership thread
does the heavy SEO lifting — the [multi-agent cost playbook](/blog/the-multi-agent-cost-playbook/),
[compressing agent memory](/blog/compressing-agent-memory/),
[context engineering for AI agents](/blog/context-engineering-for-ai-agents/), and more.

That's the whole point of automating the writer: **volume that stays on-topic compounds**. A hundred-plus
internally-linked, keyword-targeted posts is a discoverability moat you cannot hand-write at a startup's
spare-time pace. When someone — or an AI answer engine — searches "single-committer git multi-agent" or
"compressing agent memory," there's a post for that, and it links to five neighbors. The blog-writer agent
is how a one-person project publishes like a content team.

And crucially: it's *largely hands-off*. The expensive part of blogging isn't typing — it's the discipline
to keep shipping. An agent has no problem with discipline.

{% img "note-1", "The content function: brief in, draft in a worktree, one committer, one build, one human gate — on a timer." %}

## The pipeline, end to end

The writer agent isn't a magic monolith. It's one role in a hive, and the post moves through the same
machinery any work does. Four stages:

### 1. Draft — in an isolated worktree

The writer agent gets a **brief** (a topic + intent, usually straight from our SEO backlog) and a
**house-style reference**: a handful of existing posts to mirror for voice, front-matter, and structure. It
works in its **own git worktree** — a separate working directory so its in-progress draft never collides
with anyone else's files. (We wrote about why that isolation matters in
[git worktrees vs a hive](/blog/claude-code-git-worktrees-vs-hive/).) Since v0.4.4 the writer can also
carry an installed **skill** — a house-style checklist it re-reads on every draft, instead of a prompt
we hope it remembers.

The agent reads the reference posts, picks internal links to neighbors, writes the front-matter (title,
description, category, keywords, FAQ schema), and drafts ~1,000–1,400 words of body. It self-checks
against the style reference before handing off. The output is a single `.md` file in
`blog/src/posts/` — filename becomes the URL slug.

### 2. Integrate — the orchestrator is the single committer

The writer **never commits**. It writes a plain file; **Michael** owns every commit. This is
the [single-committer pattern](/blog/single-committer-git-pattern/) — agents write files, one process
serializes all the git, so parallel agents never race on `.git/index.lock` and the repo stays a clean audit
log. The orchestrator picks up the finished draft, reviews routing, and commits it into the real tree.

### 3. Build — Eleventy turns markdown into a site

A static [Eleventy](https://www.11ty.dev/) build compiles `blog/src/posts` → `docs/blog`. Dropping one
markdown file is the entire authoring action: the build auto-adds the post to the index, its topic page,
each tag page, the sitemap, and the RSS feed — plus the SEO that's already wired (canonical URLs, OpenGraph,
`BlogPosting` + `FAQPage` JSON-LD). No other file gets touched. That's deliberate: the agent's job is *write
one file correctly*, and the build does the rest.

**And since August 2026, the pictures are part of the pipeline too.** Every post's hero and inline
sketches are [drawn as code by an agent](/blog/an-agent-redesigned-this-blog/) — an SVG parts library,
composition archetypes, and one spec file, rendered through a headless browser for exactly $0 in image
APIs. One `media.json` manifest drives every image on the blog; a post ships with designed placeholders
until its drawings land, so nothing is ever broken.

### 4. Deploy — human-gated, on purpose

This is the one stage that is **not** automated, by design. The build output under `docs/blog` is served by
GitHub Pages at **munderdiffl.in/blog**. Before that goes live, a person reviews the diff and approves the
deploy. The orchestrator [escalates exactly this kind of "publish to the world"
action](/blog/how-the-god-orchestrator-works/) to the human-approval queue rather than shipping it itself.

The split is the lesson: **drafting and integration are autonomous; publishing is human-gated.** You get the
throughput of an agent and the safety of a final human read. Nobody wants a hallucinated claim on their
front page — so that one gate stays manual while everything upstream runs hands-off.

{% img "note-2", "One gate stays human on purpose: the deploy. Everything upstream of it runs itself." %}

## Build your own blog-writer agent

You don't need our exact stack. The pattern transfers to any static site or CMS. Here's the recipe.

**1. Give it a brief.** One topic, the search intent, and the angle. Pull it from a keyword backlog so the
agent is always writing something discoverable, not random.

**2. Give it a house-style reference.** This is the highest-leverage input. Point the agent at three to five
of your *best* existing posts and tell it to mirror their front-matter, voice, length, and link density —
or install that guidance as a **skill**, so every draft re-reads it. A writer with a strong reference
produces something publishable; a writer without one produces generic AI slop.

**3. Isolate the draft.** Let the agent write in its own worktree (or branch, or scratch directory) so an
in-flight draft can't clobber live files. In Munder Difflin this is a per-agent Git isolation toggle.

**4. Review before publish.** Have a reviewer agent or your orchestrator check the draft against the brief,
then put the **deploy** behind a human approval. Draft and integrate automatically; publish on a click.

**5. Make it recurring.** The real unlock is a scheduled mission: fire the writer on a cadence, feeding it
the next backlog item each time. One prompt to the orchestrator stood up [an hourly PR
reviewer](/blog/one-prompt-automated-pr-review/) for us the same way — automation that just keeps running.
Point that same scheduling at content and the blog writes itself on a timer.

## The meta-point

A multi-agent hive isn't only for code. Once you have a writer that drafts, an orchestrator that integrates
and commits, a build that publishes, and one human gate, you have a **content function** — not a one-off
prompt. The difference shows up as a library instead of a launch post.

So consider this post Exhibit A. It was briefed, drafted in a worktree against a style reference, integrated
single-committer, Eleventy-built, illustrated by code, and human-approved to the domain — the exact loop it
describes. The system is, quite literally, writing about itself.

---

Munder Difflin runs a [hive of agents on ten engines](https://munderdiffl.in/#how) on
your own machine — with isolated worktrees, single-committer git, skills, and a human-approval queue built
in, so an agent can draft and integrate while you keep the one gate that matters.
[Download Munder Difflin](https://munderdiffl.in/#install) to put a blog-writer (or any worker) on your
floor; it's free and open source.

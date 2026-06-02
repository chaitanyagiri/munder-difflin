# Munder Difflin Blog

The Munder Difflin blog — a static [Eleventy](https://www.11ty.dev/) site that builds into
`docs/blog/` and is served at **https://munderdiffl.in/blog** by the same GitHub Pages deploy as
the marketing site.

It's a native extension of [munderdiffl.in](https://munderdiffl.in): warm-paper neo-brutalist,
JetBrains Mono + Geist, hard offset shadows, square corners. The design tokens mirror
`docs/DESIGN.md` (the marketing-site source of truth).

---

## Why Eleventy (and why it builds into `docs/blog`)

- **Eleventy** gives full control over bespoke, on-brand HTML (no Ruby, lighter than Astro),
  with plain **markdown + frontmatter** authoring and built-in collections.
- It's a **self-contained subproject** (`/blog`) with its own `package.json`, so it never touches
  the Electron app's dependencies.
- Output goes to **`docs/blog/`**, which the existing Pages deploy (branch → `/docs` + `CNAME`)
  already serves. **No GitHub Pages settings change is required** — the blog just appears under
  `/blog`.

---

## Quick start

```bash
cd blog
npm install
npm run dev      # live-reload dev server at http://localhost:8088/blog/
npm run build    # one-shot build into ../docs/blog
```

> The built output under `docs/blog/` is committed to the repo (that's what Pages serves).
> Run `npm run build` and commit the result, or let the **Build blog** GitHub Action do it for you
> (see [Deploy](#deploy)).

---

## Add a new post

Drop a markdown file into `blog/src/posts/`. The filename becomes the URL slug
(`my-post.md` → `/blog/my-post/`). Minimum frontmatter:

```markdown
---
title: "Your post title"
description: "One-sentence summary used for SEO + the card + the feed."
date: 2026-06-10
category: guides            # cluster slug: guides | orchestration | memory | internals
                            #               | concepts | comparisons | use-cases | story
categoryLabel: Guides       # human label shown in chips/breadcrumbs + JSON-LD articleSection
type: Technical             # Technical | Non-technical (from BLOG_IDEAS.md)
primaryKeyword: "your focus keyword"
secondaryKeywords: ["supporting term", "another"]
tags: ["Getting Started", "Hive"]
---

Your post body in **markdown**. Use `## H2` and `### H3` — they auto-generate the
table-of-contents and deep-link anchors.
```

Then `npm run build`. The post is automatically added to the index, its topic page, each tag page,
the sitemap, and the RSS feed. No other file needs editing.

### Frontmatter schema

| Field | Required | Notes |
|---|---|---|
| `title` | ✅ | Post headline. |
| `description` | ✅ | SEO meta description + card dek + feed summary. ~150 chars. |
| `date` | ✅ | `YYYY-MM-DD`. Drives ordering, prev/next, and feed timestamps. |
| `category` | ✅ | Cluster slug — groups the post on a `/topics/<category>/` page. |
| `categoryLabel` | ✅ | Display label for the cluster (e.g. `Engineering`). |
| `tags` | – | Array of free-form tags; each gets a `/tags/<slug>/` archive page. |
| `updated` | – | `YYYY-MM-DD` last-modified; used in JSON-LD + sitemap `lastmod`. |
| `author` | – | `{ name, initials }`. Defaults to "Munder Difflin" / "MD". |
| `ogImage` | – | Absolute URL of a custom social image. Defaults to `site.defaultOgImage`. |
| `seoTitle` | – | Override the `<title>` (else `"<title> — Munder Difflin Blog"`). |
| `ogTitle` | – | Override the OG/Twitter title only. |
| `canonicalUrl` | – | Override the canonical (rarely needed; auto-derived from the URL). |
| `thumb` | – | Image URL for the card thumbnail (else a tinted label tile is used). |
| `faq` | – | Array of `{ q, a }` → emits `FAQPage` JSON-LD. |
| `draft` | – | `true` hides the post from all collections + the build output. |
| `noindex` | – | `true` adds `robots: noindex` (used by 404). |

Categories/clusters are listed in `src/_data/site.js` (`clusters`) and also derived live from the
posts, so adding a post with a new `category` "just works."

---

## How Kevin's SEO files flow in

The SEO expert (Kevin) ships two files:

- **`SEO_METADATA.md`** — keyword strategy + per-page metadata (titles, descriptions, OG/Twitter,
  canonicals), JSON-LD plan, sitemap/robots/RSS plan.
- **`BLOG_IDEAS.md`** — the backlog of post ideas with type (technical / non-technical), keywords,
  intent, and synopsis.

They map onto this blog as follows:

| Kevin's input | Where it lands |
|---|---|
| Site-level title/description/OG defaults | `src/_data/site.js` |
| Keyword **clusters** + technical/non-technical split | `site.js` `clusters` + each post's `category` |
| Per-page `<title>` / description / canonical / OG | each post's frontmatter (`seoTitle`, `description`, `ogImage`, …) |
| JSON-LD (`BlogPosting`, `BreadcrumbList`, `FAQPage`) | wired in `src/_includes/post.njk` (FAQ via the `faq` frontmatter) |
| sitemap / robots / RSS | `src/sitemap.njk`, `src/robots.njk`, `src/feed.njk` (auto-generated) |
| Post backlog (`BLOG_IDEAS.md`) | becomes new `.md` files in `src/posts/` |

> The three seeded posts are real, on-brand examples. When `BLOG_IDEAS.md` lands, reconcile the
> `category` slugs in `site.js` with Kevin's exact cluster names and start turning backlog rows into
> posts.

---

## SEO that's already wired

- Per-page `<title>`, meta description, **canonical** (`https://munderdiffl.in/blog/...`).
- **OpenGraph** + **Twitter** card tags, with a default OG image and per-post override.
- **JSON-LD**: `Blog` (index), `BlogPosting` + `BreadcrumbList` (every post), `FAQPage` (when a post
  declares `faq`).
- Auto-generated **root `sitemap.xml`** and an Atom **`feed.xml`**.
- **`robots.txt`** is owned by the marketing site (`docs/robots.txt`, maintained alongside
  `docs/index.html`) and points at `https://munderdiffl.in/sitemap.xml`.
- Semantic HTML, single `<h1>`, skip-link, `:focus-visible` outlines, WCAG-AA contrast,
  `prefers-reduced-motion` support, lazy-loaded images.

---

## Deploy

The blog ships as static files under `docs/blog/`, served by the **existing** Pages deploy
(branch → `/docs`, custom domain `munderdiffl.in`). Two ways to publish:

1. **Manual:** `cd blog && npm run build`, then commit `docs/blog/` and push. Pages redeploys.
2. **Automated (recommended):** the **Build blog** GitHub Action
   (`.github/workflows/blog.yml`) rebuilds `docs/blog` and commits it whenever anything under
   `blog/**` changes on `main`. It's scoped to `blog/**`, so its own commit (under `docs/`) never
   re-triggers it.

No GitHub Pages configuration change is needed. If you ever move the blog off `/blog`, update
`BASE` in `eleventy.config.js` and `origin`/`baseUrl` in `src/_data/site.js`.

### Sitemap ownership

This build **owns the root `docs/sitemap.xml`** (agreed with the SEO owner — "Option A"). The build
generates the full sitemap — the marketing homepage **plus** every blog page — and a postbuild step
(`scripts/postbuild.mjs`) moves it from `docs/blog/sitemap.xml` up to `docs/sitemap.xml`, which is
where `docs/robots.txt` points crawlers. Post `<lastmod>` values come from real publish/update dates,
never build time. Don't hand-edit `docs/sitemap.xml` — it's regenerated every build.

The blog **RSS** feed is emitted at `docs/blog/feed.xml` (served at `/blog/feed.xml`), matching the
`<link rel="alternate">` already in the marketing site's `<head>`.

---

## Project layout

```
blog/
  eleventy.config.js     # config, filters, collections, /blog base + markdown anchors
  package.json
  scripts/postbuild.mjs  # moves the generated sitemap to docs/sitemap.xml (root)
  src/
    _data/
      site.js            # site-level SEO + cluster config (Kevin's site-level inputs)
      build.js           # build timestamp / year
    _includes/
      base.njk           # <head> (SEO, OG, fonts), nav, footer shell
      page.njk           # static page layout (about)
      post.njk           # article layout: JSON-LD, TOC, byline, prev/next, related
      nav.njk footer.njk card.njk
    assets/blog.css      # the design system (mirrors docs/DESIGN.md tokens)
    posts/               # ← your markdown posts live here
    index.njk            # blog home (featured + grid + cluster filters)
    topics-index.njk     # /topics
    topic.njk            # /topics/<cluster>/  (paginated per category)
    tag.njk              # /tags/<tag>/        (paginated per tag)
    about.md  404.njk  feed.njk  sitemap.njk
→ builds into ../docs/blog/  (+ ../docs/sitemap.xml at the root)
```

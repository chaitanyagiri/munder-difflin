import syntaxHighlight from "@11ty/eleventy-plugin-syntaxhighlight";
import { DateTime } from "luxon";
import markdownIt from "markdown-it";
import markdownItAnchor from "markdown-it-anchor";
import { readFileSync } from "node:fs";

// The blog is always served under this path on munderdiffl.in. We prefix links
// explicitly (via the `u` filter) instead of Eleventy's pathPrefix, whose HTML
// auto-transform double-applies the prefix when combined with the `url` filter.
// Theme previews override both via env (see package.json preview:* scripts).
const BASE = process.env.BLOG_BASE || "/blog";
const OUT = process.env.BLOG_OUT || "../docs/blog";

// The single media manifest: every hero image, inline figure, and video for
// every post lives in this one file (built by scripts/build-media-manifest.mjs,
// filled in by the image-generation script).
const media = JSON.parse(readFileSync("src/_data/media.json", "utf8"));

export default function (eleventyConfig) {
  // ---- markdown: heading anchors so the TOC + deep links work ----
  const md = markdownIt({ html: true, linkify: true, typographer: true }).use(
    markdownItAnchor,
    {
      permalink: markdownItAnchor.permalink.linkInsideHeader({
        symbol: "#",
        class: "anchor",
        placement: "after",
        ariaHidden: true,
      }),
      level: [2, 3],
      slugify,
    }
  );
  eleventyConfig.setLibrary("md", md);

  // ---- plugins ----
  eleventyConfig.addPlugin(syntaxHighlight);

  // ---- passthrough static assets ----
  eleventyConfig.addPassthroughCopy({ "src/assets": "assets" });

  // ---- collections ----
  // All published posts, newest first.
  eleventyConfig.addCollection("posts", (api) =>
    api
      .getFilteredByGlob("src/posts/*.md")
      .filter((p) => !p.data.draft)
      .sort((a, b) => b.date - a.date)
  );

  // Topic clusters (categories) — derived from each post's `category` field.
  eleventyConfig.addCollection("categories", (api) => {
    const map = {};
    for (const post of api.getFilteredByGlob("src/posts/*.md")) {
      if (post.data.draft) continue;
      const cat = post.data.category;
      if (!cat) continue;
      (map[cat] ||= []).push(post);
    }
    return Object.entries(map)
      .map(([name, posts]) => ({
        name,
        slug: slugify(name),
        posts: posts.sort((a, b) => b.date - a.date),
      }))
      .sort((a, b) => b.posts.length - a.posts.length);
  });

  // Flat tag list with counts.
  eleventyConfig.addCollection("tagList", (api) => {
    const counts = {};
    for (const post of api.getFilteredByGlob("src/posts/*.md")) {
      if (post.data.draft) continue;
      for (const tag of post.data.tags || []) {
        counts[tag] = (counts[tag] || 0) + 1;
      }
    }
    return Object.entries(counts)
      .map(([name, count]) => ({ name, slug: slugify(name), count }))
      .sort((a, b) => b.count - a.count);
  });

  // ---- filters ----
  eleventyConfig.addFilter("slug", slugify);

  // Root-relative URL with the /blog base. Leaves absolute URLs untouched.
  eleventyConfig.addFilter("u", (p) => {
    if (p === undefined || p === null || p === "") return BASE + "/";
    if (/^https?:\/\//.test(String(p))) return p;
    const path = String(p).startsWith("/") ? p : "/" + p;
    return (BASE + path).replace(/([^:])\/{2,}/g, "$1/");
  });

  eleventyConfig.addFilter("readableDate", (d, zone = "utc") =>
    DateTime.fromJSDate(d, { zone }).toFormat("LLL d, yyyy")
  );
  eleventyConfig.addFilter("isoDate", (d) =>
    DateTime.fromJSDate(d, { zone: "utc" }).toISO()
  );
  eleventyConfig.addFilter("htmlDate", (d) =>
    DateTime.fromJSDate(d, { zone: "utc" }).toFormat("yyyy-LL-dd")
  );

  // Reading time from rendered HTML / raw content (~225 wpm).
  eleventyConfig.addFilter("readingTime", (content) => {
    const text = String(content || "").replace(/<[^>]+>/g, " ");
    const words = text.split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(words / 225));
  });

  eleventyConfig.addFilter("absoluteUrl", (path, base) => {
    try {
      return new URL(path, base).toString();
    } catch {
      return path;
    }
  });

  // Related posts: same category, excluding self, newest first.
  eleventyConfig.addFilter("relatedPosts", (collection, url, category, limit = 3) =>
    (collection || [])
      .filter((p) => p.url !== url && p.data.category === category)
      .sort((a, b) => b.date - a.date)
      .slice(0, limit)
  );

  // Build a table of contents from rendered post HTML (h2 + h3).
  eleventyConfig.addFilter("toc", (html) => {
    const items = [];
    const re = /<h([23])[^>]*\bid="([^"]+)"[^>]*>(.*?)<\/h\1>/gis;
    let m;
    while ((m = re.exec(String(html || "")))) {
      const level = Number(m[1]);
      const id = m[2];
      // strip the appended anchor link + any inline tags
      const text = m[3]
        .replace(/<a class="anchor"[\s\S]*?<\/a>/gi, "")
        .replace(/<[^>]+>/g, "")
        .trim();
      if (text) items.push({ level, id, text });
    }
    return items;
  });

  eleventyConfig.addFilter("byTag", (posts, tag) =>
    (posts || []).filter((p) => (p.data.tags || []).includes(tag))
  );

  eleventyConfig.addFilter("limit", (arr, n) => (arr || []).slice(0, n));
  eleventyConfig.addFilter("excludeSelf", (arr, url) =>
    (arr || []).filter((p) => p.url !== url)
  );

  // ---- media: figures + video, all driven by src/_data/media.json ----

  // Render one manifest entry (hero or inline slot) as a <figure>. Until the
  // generation script flips status to "ready", we render a designed placeholder
  // tinted by the post's topic — never a broken <img>.
  const renderFigure = (entry, category, extraClass = "", caption = "") => {
    if (!entry) return "";
    const cat = slugify(category || "notes");
    const cap = caption ? `<figcaption>${caption}</figcaption>` : "";
    if (entry.status === "ready") {
      return `<figure class="fig ${extraClass}"><img src="${BASE}/${entry.file}" alt="${(
        entry.alt || ""
      ).replace(/"/g, "&quot;")}" loading="lazy" decoding="async" />${cap}</figure>`;
    }
    return `<figure class="fig fig-placeholder t-${cat} ${extraClass}" role="img" aria-label="${(
      entry.alt || "Illustration coming soon"
    ).replace(/"/g, "&quot;")}"><div class="ph-art" aria-hidden="true"><span class="ph-glyph">✶</span><span class="ph-note">illustration on its way</span></div>${cap}</figure>`;
  };

  // {% img "slot-id" %} or {% img "slot-id", "Caption" %} inside a post's
  // markdown — looks up media.json → <this post>.inline["slot-id"].
  eleventyConfig.addShortcode("img", function (slot, caption = "") {
    const slug = this.page?.fileSlug;
    const post = media[slug];
    const entry = post?.inline?.[slot];
    if (!entry) return ""; // slot not declared in the manifest yet — render nothing
    return renderFigure(entry, post.category, "fig-inline", caption);
  });

  // Hero figure for a given slug — used by post.njk (and card thumbs).
  eleventyConfig.addShortcode("hero", function (slugArg) {
    const slug = slugArg || this.page?.fileSlug;
    const post = media[slug];
    if (!post?.hero) return "";
    return renderFigure(post.hero, post.category, "fig-hero");
  });

  // {% youtube "VIDEO_ID", "Human title" %} — click-to-load embed: renders the
  // thumbnail + play button (fast, no third-party JS on page load), swaps in
  // the youtube-nocookie iframe on click. Script lives in base.njk.
  // An empty id (or one starting with "TODO") renders a styled placeholder —
  // same publish-now-fill-later flow as the image manifest.
  eleventyConfig.addShortcode("youtube", (id, title = "Watch on YouTube") => {
    const safeTitle = String(title).replace(/"/g, "&quot;");
    if (!id || String(id).startsWith("TODO")) {
      return `<div class="yt yt-placeholder" role="img" aria-label="Video coming soon: ${safeTitle}">
  <div class="ph-art"><span class="yt-badge" aria-hidden="true"><svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg></span><span class="ph-note">video on its way</span><span class="yt-ph-title">${safeTitle}</span></div>
</div>`;
    }
    return `<div class="yt" data-yt="${id}" data-title="${safeTitle}">
  <button type="button" class="yt-load" aria-label="Play video: ${safeTitle}">
    <img src="https://i.ytimg.com/vi/${id}/hqdefault.jpg" alt="" loading="lazy" decoding="async" />
    <span class="yt-badge" aria-hidden="true"><svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg></span>
    <span class="yt-title">${safeTitle}</span>
  </button>
</div>`;
  });

  // Card thumbnails: expose the manifest to templates that already have data
  // (media.json is also on the data cascade as `media`), plus a tiny helper.
  eleventyConfig.addFilter("heroReady", (slug) => media[slug]?.hero?.status === "ready");
  eleventyConfig.addFilter("heroFile", (slug) => media[slug]?.hero?.file || "");
  eleventyConfig.addFilter("heroAlt", (slug) => media[slug]?.hero?.alt || "");

  // ---- config ----
  return {
    dir: {
      input: "src",
      output: OUT,
      includes: "_includes",
      data: "_data",
    },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
    templateFormats: ["njk", "md", "11ty.js"],
  };
}

function slugify(str) {
  return String(str)
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-");
}

// Build (or refresh) src/_data/media.json — the single manifest that drives
// every hero image, inline figure, and YouTube embed on the blog.
//
// One file, one source of truth. The image-generation script reads this,
// renders each entry whose status is "placeholder", writes the file to
// blog/src/assets/media/<slug>/, and flips status to "ready". Templates render
// a styled placeholder until then, so the site never shows a broken image.
//
// Re-running is safe: existing entries are preserved (prompts you've hand-tuned,
// statuses the generator already flipped); only new posts get fresh entries.
//
// Usage: node scripts/build-media-manifest.mjs   (cwd = blog/)
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const POSTS_DIR = "src/posts";
const OUT = "src/_data/media.json";

// Global art direction — the generation script prepends this to every prompt.
const STYLE =
  "Warm, hand-drawn editorial illustration for a developer blog. Flat colors, " +
  "visible texture, generous negative space, no text in the image. The recurring " +
  "world is a cozy pixel-art office of small AI agents at desks (The Office " +
  "homage): terminals, sticky notes, coffee mugs, a kanban wall. Palette keyed " +
  "to the post's topic color. 16:9, crisp at 1600x900.";

function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    )
      v = v.slice(1, -1);
    fm[kv[1]] = v;
  }
  return fm;
}

let existing = {};
try {
  existing = JSON.parse(await readFile(OUT, "utf8"));
} catch {
  /* first run */
}

const manifest = { _style: STYLE };
const files = (await readdir(POSTS_DIR)).filter((f) => f.endsWith(".md")).sort();
let added = 0;

for (const file of files) {
  const slug = path.basename(file, ".md");
  if (existing[slug]) {
    manifest[slug] = existing[slug];
    continue;
  }
  const fm = parseFrontmatter(await readFile(path.join(POSTS_DIR, file), "utf8"));
  const title = fm.title || slug;
  const desc = fm.description || "";
  manifest[slug] = {
    title,
    category: fm.category || "notes",
    hero: {
      file: `assets/media/${slug}/hero.png`,
      alt: `Illustration: ${title}`,
      prompt: `Hero image for a blog post titled "${title}". The post is about: ${desc}`,
      status: "placeholder",
    },
    // Inline figures: add slots here (key = slot id used by {% img "key" %} in
    // the markdown). Same shape as hero.
    inline: {},
    // YouTube videos this post should feature: [{ id, title }]. Rendered via
    // {% youtube id, title %} in the markdown; listed here so one file knows
    // every media asset a post owns.
    youtube: [],
  };
  added++;
}

await writeFile(OUT, JSON.stringify(manifest, null, 2) + "\n");
console.log(
  `[media] ${files.length} posts → ${OUT} (${added} new, ${files.length - added} kept)`
);

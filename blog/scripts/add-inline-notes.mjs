// Give every post 2 inline sketch figures ("notes") between sections, and
// register every {% img %} slot in the media manifest.
//
// - Posts that already contain {% img "note-… %} shortcodes (hand-placed, with
//   captions) are left untouched textually.
// - All other posts get `{% img "note-1" %}` and `{% img "note-2" %}` inserted
//   at roughly 1/3 and 2/3 of their H2 sections (outside code fences).
// - Then every slot referenced by any post gets an inline entry in
//   src/_data/media.json (existing entries are preserved).
//
// The sketches themselves are drawn by media-src/scene-lib.js buildNote() and
// rendered via render.html?slug=<slug>&note=<n>. Run this, render, then build.
//
// Usage: node scripts/add-inline-notes.mjs   (cwd = blog/)
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const POSTS_DIR = "src/posts";
const MANIFEST = "src/_data/media.json";

const media = JSON.parse(await readFile(MANIFEST, "utf8"));
const files = (await readdir(POSTS_DIR)).filter((f) => f.endsWith(".md")).sort();

let injected = 0, slotsAdded = 0;

for (const file of files) {
  const slug = path.basename(file, ".md");
  const p = path.join(POSTS_DIR, file);
  let text = await readFile(p, "utf8");

  if (!/\{%\s*img\s+"note-/.test(text)) {
    // find H2 lines outside code fences, after frontmatter
    const lines = text.split("\n");
    let inFence = false;
    const h2 = [];
    let fmEnd = 0, dashes = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/^---\s*$/.test(lines[i]) && dashes < 2) { dashes++; if (dashes === 2) fmEnd = i; continue; }
      if (/^```/.test(lines[i])) { inFence = !inFence; continue; }
      if (!inFence && /^## /.test(lines[i]) && i > fmEnd) h2.push(i);
    }
    if (h2.length >= 2) {
      const p1 = Math.max(1, Math.floor(h2.length / 3));
      let p2 = Math.min(h2.length - 1, Math.floor((2 * h2.length) / 3));
      if (p2 <= p1) p2 = p1 + 1 <= h2.length - 1 ? p1 + 1 : -1;
      const inserts = [[h2[p1], 1]];
      if (p2 > 0) inserts.push([h2[p2], 2]);
      // insert bottom-up so line numbers stay valid
      for (const [line, n] of inserts.reverse()) {
        lines.splice(line, 0, `{% img "note-${n}" %}`, "");
      }
      text = lines.join("\n");
      await writeFile(p, text);
      injected++;
    }
  }

  // register every referenced slot in the manifest
  const entry = media[slug];
  if (!entry) continue;
  entry.inline = entry.inline || {};
  for (const m of text.matchAll(/\{%\s*img\s+"([\w-]+)"/g)) {
    const slot = m[1];
    if (entry.inline[slot]) continue;
    entry.inline[slot] = {
      file: `assets/media/${slug}/${slot}.png`,
      alt: `Hand-drawn sketch from “${entry.title}”`,
      prompt: "",
      status: "ready",
    };
    slotsAdded++;
  }
}

await writeFile(MANIFEST, JSON.stringify(media, null, 2) + "\n");
console.log(`[notes] injected shortcodes into ${injected} posts, added ${slotsAdded} inline slots to ${MANIFEST}`);

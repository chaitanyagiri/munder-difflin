// Generate blog images from src/_data/media.json via the OpenAI Images API.
//
// The manifest is the single source of truth: every hero and inline slot has a
// prompt and a status. This script renders each pending ("placeholder") entry
// with gpt-image-2, writes the PNG to the entry's `file` path under src/, and
// flips status to "ready". media.json is rewritten after EVERY image, so a
// crash, quota error, or Ctrl-C loses nothing — rerun and it resumes.
//
// Usage (cwd = blog/):
//   OPENAI_API_KEY=sk-... node scripts/generate-images.mjs --posts slug-a,slug-b
//   OPENAI_API_KEY=sk-... node scripts/generate-images.mjs --all
//
// Flags:
//   --posts <a,b,c>    only these post slugs
//   --all              every post still pending
//   --quality <q>      high | medium | low        (default: high)
//   --inline           also render inline slots   (default: heroes only)
//   --dry-run          print prompts + cost estimate, no API calls, no writes
//   --force            regenerate entries already "ready"
//   --max-cost <usd>   abort if the pre-run estimate exceeds this (default: 25)
//   --suffix <s>       write files as <name>-<s>.png and DON'T flip status —
//                      for side-by-side quality comparisons (e.g. --suffix medium)
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const MANIFEST = "src/_data/media.json";
const MODEL = "gpt-image-2";
const SIZE = "1536x1024"; // 16:9-ish landscape; matches the blog's aspect
// Published per-image landscape pricing (see plan): used for estimates + caps.
const PRICE = { low: 0.005, medium: 0.041, high: 0.165 };

// ---- args ----
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};
const POSTS = opt("posts", "") ? opt("posts", "").split(",").map((s) => s.trim()).filter(Boolean) : null;
const ALL = flag("all");
const QUALITY = opt("quality", "high");
const INLINE = flag("inline");
const DRY = flag("dry-run");
const FORCE = flag("force");
const MAX_COST = Number(opt("max-cost", "25"));
const SUFFIX = opt("suffix", "");

if (!POSTS && !ALL) {
  console.error("Pick a scope: --posts slug-a,slug-b   or   --all   (add --dry-run to preview)");
  process.exit(1);
}
if (!PRICE[QUALITY]) {
  console.error(`--quality must be one of: ${Object.keys(PRICE).join(" | ")}`);
  process.exit(1);
}

// ---- collect work ----
const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
const style = manifest._style || "";
const jobs = [];
for (const [slug, post] of Object.entries(manifest)) {
  if (slug.startsWith("_")) continue;
  if (POSTS && !POSTS.includes(slug)) continue;
  const slots = { hero: post.hero, ...(INLINE ? post.inline : {}) };
  for (const [name, entry] of Object.entries(slots)) {
    if (!entry || !entry.prompt) continue;
    if (entry.status === "ready" && !FORCE && !SUFFIX) continue;
    jobs.push({ slug, name, entry });
  }
}
if (POSTS) {
  for (const p of POSTS) if (!manifest[p]) console.warn(`[warn] no manifest entry for slug: ${p}`);
}
if (!jobs.length) {
  console.log("Nothing to generate — all selected entries are already ready (use --force to redo).");
  process.exit(0);
}

const estimate = jobs.length * PRICE[QUALITY];
console.log(`Model ${MODEL} · ${SIZE} · quality=${QUALITY}${SUFFIX ? ` · suffix=-${SUFFIX}` : ""}`);
console.log(`${jobs.length} image(s) → estimated ~$${estimate.toFixed(2)}\n`);
if (estimate > MAX_COST) {
  console.error(`Estimate $${estimate.toFixed(2)} exceeds --max-cost ${MAX_COST}. Aborting before any API call.`);
  process.exit(1);
}

if (DRY) {
  for (const j of jobs) {
    console.log(`--- ${j.slug} / ${j.name} → ${j.entry.file}`);
    console.log(`${style}\n${j.entry.prompt}\n`);
  }
  console.log(`[dry-run] ${jobs.length} image(s), ~$${estimate.toFixed(2)}, no API calls made.`);
  process.exit(0);
}

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) {
  console.error("OPENAI_API_KEY is not set. Export it and rerun:\n  OPENAI_API_KEY=sk-... node scripts/generate-images.mjs ...");
  process.exit(1);
}

// ---- generate ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function generate(prompt) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, prompt, size: SIZE, quality: QUALITY, n: 1 }),
    });
    if (res.ok) {
      const data = await res.json();
      const b64 = data?.data?.[0]?.b64_json;
      if (b64) return Buffer.from(b64, "base64");
      // some responses return a URL instead of b64
      const url = data?.data?.[0]?.url;
      if (url) return Buffer.from(await (await fetch(url)).arrayBuffer());
      throw new Error("response had neither b64_json nor url");
    }
    const body = await res.text();
    // unsupported size for this model → let the API tell us, don't guess again
    if (res.status === 400 && /size/i.test(body)) {
      throw new Error(`API rejected size ${SIZE}: ${body.slice(0, 300)}`);
    }
    lastErr = new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
    if (res.status === 429 || res.status >= 500) {
      const wait = attempt * 15_000;
      console.warn(`  retry ${attempt}/3 in ${wait / 1000}s (${res.status})`);
      await sleep(wait);
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

let done = 0, failed = 0;
for (const j of jobs) {
  const outRel = SUFFIX ? j.entry.file.replace(/\.png$/, `-${SUFFIX}.png`) : j.entry.file;
  const outPath = path.join("src", outRel);
  process.stdout.write(`[${done + failed + 1}/${jobs.length}] ${j.slug}/${j.name} → ${outPath} ... `);
  try {
    const png = await generate(`${style}\n\n${j.entry.prompt}`);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, png);
    if (!SUFFIX) {
      j.entry.status = "ready";
      await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n"); // save after EVERY image
    }
    done++;
    console.log("ok");
  } catch (err) {
    failed++;
    console.log(`FAILED: ${err.message}`);
  }
  await sleep(2000);
}

console.log(`\n${done} generated, ${failed} failed · actual spend ≈ $${(done * PRICE[QUALITY]).toFixed(2)}`);
if (failed) {
  console.log("Failed entries are still 'placeholder' — rerun the same command to retry just those.");
  process.exit(1);
}

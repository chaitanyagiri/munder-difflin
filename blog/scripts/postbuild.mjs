// Postbuild: move the generated sitemap to the site ROOT (docs/sitemap.xml).
//
// Eleventy can only write inside its output dir (docs/blog), but robots.txt
// points crawlers at https://munderdiffl.in/sitemap.xml — the repo root. So we
// move docs/blog/sitemap.xml up to docs/sitemap.xml after the build. The sitemap
// uses absolute URLs, so its location on disk doesn't affect its contents.
//
// Runs with cwd = blog/ (npm sets it to the package dir).
import { rename } from "node:fs/promises";

const from = "../docs/blog/sitemap.xml";
const to = "../docs/sitemap.xml";

try {
  await rename(from, to);
  console.log(`[postbuild] sitemap → docs/sitemap.xml (root)`);
} catch (err) {
  console.error(`[postbuild] failed to move sitemap: ${err.message}`);
  process.exit(1);
}

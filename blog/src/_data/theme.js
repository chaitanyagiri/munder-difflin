// Blog theme switch. The blog deliberately has its own identity, separate from
// the marketing site (Reddit feedback: the mono/neo-brutalist skin was hard to
// read as a blog). Two candidates, both built here:
//
//   sunroom — friendly & playful; rounded, candy-gradient accents, humanist
//             sans. Inspired by Josh W. Comeau's blog.
//   press   — bold editorial magazine; display serif headlines, loud per-topic
//             color blocks, drop caps. Inspired by The Verge's 2022 redesign.
//
// Pick with BLOG_THEME=sunroom|press (default sunroom). Preview builds set
// BLOG_PREVIEW=1 which adds <meta name="robots" content="noindex"> so the
// side-by-side previews never compete with the real blog in search.
const KEY = process.env.BLOG_THEME === "sunroom" ? "sunroom" : "press";

const FONTS = {
  sunroom:
    "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,700;12..96,800&family=Nunito+Sans:opsz,wght@6..12,400;6..12,600;6..12,700;6..12,800&family=JetBrains+Mono:wght@400;600&display=swap",
  press:
    "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700;9..144,900&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;600&display=swap",
};

export default {
  key: KEY,
  fonts: FONTS[KEY],
  css: `/assets/blog-${KEY}.css`,
  preview: process.env.BLOG_PREVIEW === "1",
};

/**
 * Regenerate src/shared/dropFonts.ts from the bundled woff2.
 *
 * The release-drop iframe is sandboxed with an opaque origin and a
 * `font-src data:` CSP, so it cannot load a bundled font by URL — the design
 * fonts have to be embedded as data: URIs. This bakes the SAME woff2 the app
 * self-hosts (src/renderer/src/design/fonts.css) into a base64 constant the
 * drop's buildDropSrcDoc inlines. Run after changing either woff2:
 *
 *   node scripts/gen-drop-fonts.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILES = {
  inter: 'src/renderer/src/assets/fonts/inter-latin-var.woff2',
  jetbrainsMono: 'src/renderer/src/assets/fonts/jetbrains-mono-latin-var.woff2'
};

const b64 = Object.fromEntries(
  Object.entries(FILES).map(([k, p]) => [k, readFileSync(p).toString('base64')])
);

const out = `/**
 * Self-hosted webfonts for the release-drop iframe, base64-encoded.
 *
 * The drop renders in a sandboxed iframe (srcDoc, opaque origin, CSP
 * default-src 'none'). That frame CANNOT reach a bundled font URL — no
 * same-origin, and font-src is data: only — so the design fonts have to travel
 * INSIDE the document as data: URIs. This is the drop's equivalent of the
 * app's own self-hosting (src/renderer/src/design/fonts.css): no launch-time
 * Google Fonts fetch, nothing to hang on a blocked fonts.googleapis.com.
 *
 * Generated from the SAME woff2 the app ships:
 *   - Inter    → src/renderer/src/assets/fonts/inter-latin-var.woff2 (drop --font-sans; substitutes Geist)
 *   - JetBrains Mono → …/jetbrains-mono-latin-var.woff2 (drop --font-mono, exact)
 * Both are variable (one file spans weight 400–700). Regenerate with
 * scripts/gen-drop-fonts.mjs if the woff2 change. Do not hand-edit the base64.
 */

export const DROP_FONT_WOFF2_BASE64 = {
  inter: '${b64.inter}',
  jetbrainsMono: '${b64.jetbrainsMono}'
} as const;
`;

writeFileSync('src/shared/dropFonts.ts', out);
console.log('wrote src/shared/dropFonts.ts (inter %d + jbm %d base64 chars)', b64.inter.length, b64.jetbrainsMono.length);

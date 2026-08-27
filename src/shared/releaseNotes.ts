/**
 * Release-note digest — turns a GitHub release body into 3-5 short lines.
 *
 * The updater has always carried `notes` (electron-updater's
 * `info.releaseNotes`, i.e. the release body) on the `available` /
 * `downloaded` / `available-manual` states, and the UI has always thrown it
 * away. The update toast is the only notification this app ever raises, so the
 * one moment we have someone's attention we were spending on a version number.
 *
 * Why this is not just `body.slice(0, 280)`:
 *
 *   1. The body is RELEASE.md (see .github/workflows/release.yml → `body_path`),
 *      which is ~200 lines: a tagline, a link, download tables for three
 *      platforms, build-from-source instructions, a "Previously" list. The
 *      actual news sits under a `## What's new in <version>` heading a third of
 *      the way down. Taking "the first lines" of that body gives you the
 *      product tagline — text the user has already read. So when the body has a
 *      "what's new" heading we start there, and stop at the next heading or
 *      horizontal rule so we don't bleed into "Still new in 0.4.2".
 *
 *   2. It is markdown, and the toast renders plain text. Links have to collapse
 *      to their label (a raw `https://github.com/...` eats the whole budget),
 *      images and badges have to disappear entirely, and emphasis markers have
 *      to go — but ONLY when they are emphasis. `DO_NOT_TRACK` and `first_run`
 *      are real strings in this project's release notes and must survive.
 *
 *   3. Release bullets wrap across source lines. Splitting on `\n` and clipping
 *      would cut a sentence at the author's line break, which is arbitrary, so
 *      continuation lines are folded back into their bullet before clipping.
 *
 * Deliberately pure and electron-free (same contract as updateState.ts): no DOM,
 * no `window`, no imports. The toast and the Settings block both call it, and
 * test/release-notes.test.cjs pins the behaviour without booting anything.
 */

/** At most this many lines in the digest — a toast, not a changelog. */
export const RELEASE_NOTES_MAX_BULLETS = 5;
/** Total character budget across all lines. Sized so the 340px toast stays
 *  roughly six lines tall even before the block's own scroll clamp. */
export const RELEASE_NOTES_MAX_CHARS = 280;
/** No single line may hog the whole budget. Tuned against this project's own
 *  release notes, whose bullets lead with a bolded sentence and then explain
 *  themselves for another two lines: 110 keeps the lead plus a clause, and
 *  leaves room for the two or three bullets after it. */
export const RELEASE_NOTES_MAX_BULLET_CHARS = 110;
/** Below this, a clipped tail is unreadable ("Icons are nat…") — stop instead. */
const MIN_PARTIAL_CHARS = 40;

export interface ReleaseNotesOptions {
  maxBullets?: number;
  maxChars?: number;
  maxBulletChars?: number;
}

const FENCE_RE = /^\s{0,3}(?:```|~~~)/;
const HEADING_RE = /^\s{0,3}#{1,6}\s+/;
/** `---`, `***`, `___` (and spaced variants). Checked BEFORE the bullet test,
 *  because `- - -` is a rule and `- x` is a bullet. */
const RULE_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET_RE = /^\s*(?:[-*+]|\d{1,2}[.)])\s+/;
const TABLE_ROW_RE = /^\s*\|/;
/** Setext underline (`====` under a title) — structure, never content. */
const SETEXT_RE = /^\s{0,3}=+\s*$/;
const WHATS_NEW_RE = /^\s{0,3}#{1,6}\s+.*what[’']?s\s+new/i;
/** GitHub appends this to auto-generated bodies; it is a URL, not news. */
const FULL_CHANGELOG_RE = /^\s*\**\s*full\s+changelog\s*\**\s*:/i;
const BARE_URL_RE = /^\s*<?https?:\/\/\S+>?\s*$/i;

/**
 * GitHub's releases.atom feed carries the release body as RENDERED HTML, not as
 * the markdown that produced it, and electron-updater falls back to that feed
 * whenever the channel yml has no releaseNotes. So this parser has to survive
 * HTML even though every one of its tests fed it markdown.
 *
 * Untreated, rendered HTML has no `##` headings, so the what's-new section is
 * never found and the bullet scan takes over. In OUR body the only line that
 * looks like a markdown bullet is `* { box-sizing: border-box; }` from the
 * <style> block, because `*` followed by a space IS the bullet syntax. The
 * shipped toast said exactly that and nothing else.
 *
 * Belt and braces only: the real fix is releaseInfo.releaseNotesFile in
 * electron-builder.yml, which puts markdown in the yml so the feed is never
 * read. This just makes a future release that forgets the yml degrade to
 * something correct rather than to CSS.
 */
const STYLE_SCRIPT_RE = /<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi;
const HTML_HEADING_RE = /^\s*<h[1-6]\b[^>]*>/i;
const HTML_LI_RE = /^\s*<li\b[^>]*>/i;
/** Only the apostrophe forms, decoded early so WHATS_NEW_RE still matches
 *  `<h2>What&#39;s new</h2>`. Deliberately NOT &lt;/&gt;, which would
 *  manufacture tags out of escaped text. */
const APOS_ENTITY_RE = /&(?:#0*39|#x0*27|apos|rsquo|lsquo);/gi;

/** A heading in either syntax. */
function isHeadingLine(line: string): boolean {
  return HEADING_RE.test(line) || HTML_HEADING_RE.test(line);
}

/** The what's-new heading in either syntax. */
function isWhatsNewLine(line: string): boolean {
  if (WHATS_NEW_RE.test(line)) return true;
  return HTML_HEADING_RE.test(line) && /what[’']?s\s+new/i.test(line);
}

/** The bullet marker this line opens with, in either syntax, or null. */
function bulletPrefix(line: string): string | null {
  if (RULE_RE.test(line)) return null;
  const md = line.match(BULLET_RE);
  if (md) return md[0];
  const li = line.match(HTML_LI_RE);
  return li ? li[0] : null;
}

/**
 * Markdown → plain text for one already-joined line.
 *
 * Exported for the tests: this is where every "the toast showed a raw URL"
 * class of bug lives, and it is far easier to pin here than through the digest.
 */
export function stripMarkdown(md: string): string {
  return String(md ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')            // images/badges: gone entirely
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')         // inline links → their label
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')        // reference links → their label
    .replace(/<https?:\/\/[^>]*>/g, '')              // autolinks: the URL is noise here
    .replace(/<[^>\s][^>]*>/g, '')                   // stray inline HTML
    .replace(/`([^`]*)`/g, '$1')                     // inline code, backticks only
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    // Struck-through text is retracted, not emphasised — "on ~~Windows~~ macOS"
    // must not come out as "on Windows macOS".
    .replace(/~~[^~]+~~/g, '')
    // Single-marker emphasis needs the word-boundary guards, otherwise
    // `DO_NOT_TRACK` and `agent_spawned` come out mangled.
    .replace(/(?<![\w*])\*([^*\n]+)\*(?!\w)/g, '$1')
    .replace(/(?<![\w_])__([^_\n]+)__(?!\w)/g, '$1')
    .replace(/(?<![\w_])_([^_\n]+)_(?!\w)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/, '')                // a heading marker that slipped through
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s—–:.,;·-]+/, '')         // leading orphan punctuation from a stripped link
    .trim();
}

/** Anything with at least one word character and enough of it to be a sentence. */
function isMeaningful(text: string): boolean {
  return text.length >= 3 && /[A-Za-z0-9]/.test(text);
}

/**
 * Drop everything that is markup rather than prose: fenced code, HTML comments,
 * download/checksum tables, blockquote wrappers and GitHub's `[!NOTE]` markers.
 * Blockquotes are unwrapped rather than dropped — this project's release notes
 * put real caveats ("Appearance only. No functional change") inside one.
 */
function usableLines(body: string): string[] {
  const out: string[] = [];
  let inFence = false;
  // Whole blocks, before any line splitting: a <style> body is CSS on every one
  // of its lines, and one of those lines parses as a markdown bullet.
  const cleaned = body
    .replace(/\r\n?/g, '\n')
    .replace(STYLE_SCRIPT_RE, '')
    .replace(APOS_ENTITY_RE, "'");
  for (const raw of cleaned.split('\n')) {
    if (FENCE_RE.test(raw)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const line = raw
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^\s{0,3}>\s?/, '')
      .replace(/^\s*\[![A-Za-z]+\]\s*/, '');
    if (TABLE_ROW_RE.test(line)) continue;
    if (SETEXT_RE.test(line)) continue;
    if (FULL_CHANGELOG_RE.test(line)) continue;
    if (BARE_URL_RE.test(line)) continue;
    out.push(line);
  }
  return out;
}

/**
 * The slice of the body that is actually "what's new".
 *
 * Starts after the first `what's new` heading when there is one, otherwise at
 * the top; either way headings and rules are skipped while we're still in the
 * preamble and END the section once content has been collected.
 */
function firstSection(lines: string[]): string[] {
  const marker = lines.findIndex(isWhatsNewLine);
  const start = marker >= 0 ? marker + 1 : 0;
  const out: string[] = [];
  let seenContent = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (isHeadingLine(line) || RULE_RE.test(line)) {
      if (seenContent) break;
      continue;
    }
    if (!seenContent && isMeaningful(stripMarkdown(line))) seenContent = true;
    out.push(line);
  }
  return out;
}

/**
 * Fold the section into digest items.
 *
 * Bullets win when the section has any: a changelog's bullets ARE the summary,
 * and the paragraph above them is usually scene-setting that would eat two of
 * the five slots. A release with no bullets at all falls back to its
 * paragraphs, so a one-line "Fixes the crash on launch." body still says
 * something.
 */
function collectItems(section: string[]): string[] {
  const bullets: string[] = [];
  const prose: string[] = [];
  let current: string[] = [];
  let currentIsBullet = false;

  const flush = (): void => {
    if (current.length === 0) return;
    const text = stripMarkdown(current.join(' '));
    if (isMeaningful(text)) (currentIsBullet ? bullets : prose).push(text);
    current = [];
  };

  for (const line of section) {
    if (line.trim() === '') { flush(); continue; }
    const bullet = bulletPrefix(line);
    if (bullet) {
      flush();
      current = [line.slice(bullet.length)];
      currentIsBullet = true;
    } else if (current.length > 0) {
      current.push(line.trim());   // a wrapped continuation of the item above
    } else {
      current = [line.trim()];
      currentIsBullet = false;
    }
  }
  flush();

  return bullets.length > 0 ? bullets : prose;
}

/** Clip to `max` chars on a word boundary, ellipsis included in the count. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  const head = space > max * 0.5 ? cut.slice(0, space) : cut;
  return `${head.replace(/[\s,;:.—–-]+$/, '')}…`;
}

/**
 * Parse a GitHub release body into a short "What's new" digest.
 *
 * Returns `[]` — never a placeholder — for a missing, empty, or
 * structure-only body, so callers can render nothing at all rather than an
 * empty heading. Most releases in the wild have no usable body.
 */
export function summarizeReleaseNotes(
  body: string | null | undefined,
  opts: ReleaseNotesOptions = {}
): string[] {
  const maxBullets = opts.maxBullets ?? RELEASE_NOTES_MAX_BULLETS;
  const maxChars = opts.maxChars ?? RELEASE_NOTES_MAX_CHARS;
  const maxBulletChars = opts.maxBulletChars ?? RELEASE_NOTES_MAX_BULLET_CHARS;
  if (typeof body !== 'string' || body.trim() === '') return [];

  const items = collectItems(firstSection(usableLines(body)));

  const out: string[] = [];
  let used = 0;
  for (const item of items) {
    if (out.length >= maxBullets) break;
    const room = Math.min(maxBulletChars, maxChars - used);
    // The first line always gets rendered (clipped if it must be); after that a
    // stub too short to read is worse than one bullet fewer.
    if (out.length > 0 && room < MIN_PARTIAL_CHARS) break;
    const text = clip(item, Math.max(room, 1));
    out.push(text);
    used += text.length;
  }
  return out;
}

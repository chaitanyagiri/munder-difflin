/**
 * Arabic rendering for the terminal — the working recipe, three parts:
 *
 * 1. DOM renderer (terminalPool skips the WebGL lease in Arabic mode). Rows
 *    become real DOM text, so the browser's text engine is in play at all.
 *
 * 2. A character joiner (this file). On its own the DOM renderer emits a span
 *    PER CELL with letter-spacing — atomic boxes the browser can neither shape
 *    across nor reorder. Joining every Arabic phrase into one range makes it a
 *    single span: real contextual shaping, lam-alef ligatures, marks on their
 *    letters — by the font itself, no presentation-form tricks.
 *
 * 3. CSS in design/global.css: rows get `unicode-bidi: plaintext` (each row
 *    takes its base direction from its first strong character, like dir=auto)
 *    and spans drop to `display: inline` (inline-block boxes are atomic to the
 *    bidi algorithm — inline text isn't, so phrase order follows the UBA).
 *
 * Result measured in a real browser: Arabic rows right-aligned and correctly
 * ordered, mixed Arabic/Latin rows interleave properly, Latin rows unchanged.
 *
 * KNOWN TRADE: the block cursor is drawn at the logical cell offset, counted
 * from the left — on an RTL row it does not sit where the next glyph will
 * appear. Reading correctness is worth a misplaced cursor.
 */

/** Arabic script, its supplements, and the presentation-form blocks. */
export function isArabicCp(cp: number): boolean {
  return (cp >= 0x0600 && cp <= 0x06ff) || (cp >= 0x0750 && cp <= 0x077f) ||
         (cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff);
}

/** Characters a phrase may flow across without ending the join: the space and
 *  punctuation that sit BETWEEN Arabic words. The range still only extends as
 *  far as the last Arabic character, so trailing punctuation stays outside. */
const PHRASE_GLUE = ' ,.:;()«»،؛؟!ـ-—';

/**
 * Ranges of `text` (one terminal row) to render as single units: every maximal
 * stretch that containsArabic, glued across the punctuation between words.
 * Shape matches xterm's registerCharacterJoiner contract: [start, end).
 */
export function arabicJoinRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let i = 0;
  while (i < text.length) {
    if (!isArabicCp(text.charCodeAt(i))) { i++; continue; }
    const start = i;
    let end = i + 1;
    let lastArabic = i + 1;
    while (end < text.length) {
      const cp = text.charCodeAt(end);
      if (isArabicCp(cp)) { end++; lastArabic = end; continue; }
      if (PHRASE_GLUE.includes(text[end])) { end++; continue; }
      break;
    }
    if (lastArabic - start > 1) ranges.push([start, lastArabic]);
    i = Math.max(end, lastArabic);
  }
  return ranges;
}

/**
 * Part 4 of the Arabic terminal recipe (see arabicJoiner.ts for parts 1–3):
 * neutralize xterm's letter-spacing on Arabic spans.
 *
 * The DOM renderer pads every text run with `letter-spacing` so its width comes
 * out at an exact number of cells. For Latin monospace that is a sub-pixel
 * correction; for a joined Arabic phrase — whose natural width is far narrower
 * than one-cell-per-character — it stretches the phrase across its whole cell
 * span. Two failures at once: huge gaps between letters, and the browser
 * DISABLES cursive joining on any text with letter-spacing, so the letters
 * disconnect exactly like the bug this whole effort exists to fix.
 *
 * CSS cannot express "spans whose text is Arabic", so this is a
 * MutationObserver: whenever rows change, any span containing Arabic gets its
 * letter-spacing forced to normal. Latin spans keep their correction, so TUI
 * box-drawing stays cell-aligned. The pass is cheap — it touches only added
 * nodes and changed text, a handful of spans per repaint.
 */
import { isArabicCp } from './arabicJoiner';

function hasArabic(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (isArabicCp(s.charCodeAt(i))) return true;
  return false;
}

function fixSpan(el: Element): void {
  if (el.tagName === 'SPAN' && hasArabic(el.textContent ?? '')) {
    (el as HTMLElement).style.letterSpacing = 'normal';
  }
}

function sweep(root: ParentNode): void {
  for (const el of root.querySelectorAll('span')) fixSpan(el);
}

/** Observe a terminal's host element; returns a disposer. */
export function attachArabicSpacingFix(host: HTMLElement): () => void {
  sweep(host);
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') {
        const el = r.target.parentElement;
        if (el) fixSpan(el);
        continue;
      }
      for (const n of r.addedNodes) {
        if (n.nodeType !== Node.ELEMENT_NODE) continue;
        fixSpan(n as Element);
        sweep(n as Element);
      }
    }
  });
  mo.observe(host, { subtree: true, childList: true, characterData: true });
  return () => mo.disconnect();
}

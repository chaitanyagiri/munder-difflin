/**
 * Colour helpers for the terminal's OSC 10/11 replies.
 *
 * Free of xterm and of every browser global on purpose, so the parsing rules are
 * unit-testable. `terminalPool.ts` itself cannot be loaded in a test: it imports
 * xterm, which touches `self`. Same reasoning as `hooks/queueDelivery.ts` and
 * `store/focusMode.ts`.
 */

/**
 * `#rgb` or `#rrggbb` to [r, g, b], or null for anything else.
 *
 * Null means "stay silent". Answering an OSC colour query with a guess is worse
 * than not answering at all, because the TUI then styles itself confidently
 * wrong, which is the exact failure this code exists to fix.
 */
export function parseHexColor(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * The body of an OSC 10/11 reply for a colour, in xterm's 16-bit-per-channel
 * form. Doubling each byte is the conventional widening, so 0x1a becomes 0x1a1a.
 */
export function oscColorBody(rgb: [number, number, number]): string {
  const wide = (v: number) => v.toString(16).padStart(2, '0').repeat(2);
  return `rgb:${wide(rgb[0])}/${wide(rgb[1])}/${wide(rgb[2])}`;
}

/**
 * Is this background colour a dark one?
 *
 * Used to answer "which theme are we?" for a program that just enabled DEC 2031,
 * where the only thing we hold is the palette itself. Rec. 601 luma, which is
 * good enough for a light/dark split and does not need the full sRGB transfer
 * curve.
 */
export function isDarkBackground(hex: string): boolean {
  const rgb = parseHexColor(hex);
  if (!rgb) return true; // unknown: assume dark, the safer default for a terminal
  const [r, g, b] = rgb;
  return (0.299 * r + 0.587 * g + 0.114 * b) < 128;
}

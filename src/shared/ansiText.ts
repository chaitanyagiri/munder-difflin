/**
 * Strip ANSI escape sequences from scraped terminal output.
 *
 * The pty parser used to remove ONLY SGR color codes (`ESC[…m`), so every other
 * escape flavor leaked into the text the thought bubbles and desk cards show
 * (issue #141): the CLI repaints its live status line with cursor-forward moves
 * (`ESC[1C`) standing in for runs of spaces it knows are already on screen,
 * plus cursor addressing (`ESC[14;6H`) and erases — scraped, that rendered as
 * "all␛[1Cthree␛[1Cland…".
 *
 * Cursor-forward is TRANSLATED into the spaces it stands for (dropping it would
 * fuse adjacent words); everything else is control, not content, and is
 * removed: OSC strings (window title, hyperlinks), any remaining CSI (SGR,
 * cursor, erase, modes), charset selects, and whatever two-byte escape is left.
 *
 * DELIBERATE asymmetry: only cursor-FORWARD becomes text. Cursor-up/back/
 * addressing are deleted outright, so `up ESC[2A ESC[5D down` scrapes as
 * "updown" — there is no sane linear-text rendering of "move back 5", and a
 * scraper isn't a terminal emulator. If that fusion ever matters in practice,
 * the fix is a real screen model, not a smarter regex.
 *
 * ORDER IS LOAD-BEARING, twice: CUF_RE must run before CSI_RE (which would
 * otherwise eat cursor-forwards before they can become spaces), and ESC2_RE
 * must run LAST (it matches `ESC + any byte`, so running it earlier would
 * swallow a CSI/OSC introducer and leave the sequence body behind as text).
 *
 * Lives in src/shared: the only scraper today is the renderer's usePtyParser,
 * but main also handles raw PTY streams and shared keeps it reachable from
 * both sides.
 */

/** Cap on the spaces one cursor-forward can translate into — a bubble never
 *  needs more than a terminal width of padding, and an adversarial `ESC[9999C`
 *  shouldn't allocate it. */
const MAX_CUF_SPACES = 80;

const CUF_RE = /\x1b\[(\d*)C/g; // cursor-forward: the TUI's stand-in for spaces
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g; // OSC … BEL/ST (titles, links)
const CSI_RE = /\x1b\[[0-9;:?]*[ -/]*[@-~]/g; // any CSI: SGR, cursor, erase, modes
const CHARSET_RE = /\x1b[()][0-9A-B]/g; // charset selects (ESC ( B …)
const ESC2_RE = /\x1b./g; // stray two-byte escapes (ESC 7, ESC = …)

export function stripAnsi(chunk: string): string {
  return chunk
    .replace(CUF_RE, (_, n: string) => ' '.repeat(Math.min(parseInt(n || '1', 10) || 1, MAX_CUF_SPACES)))
    .replace(OSC_RE, '')
    .replace(CSI_RE, '')
    .replace(CHARSET_RE, '')
    .replace(ESC2_RE, '');
}

/** Longest tail we are willing to hold between chunks. Real escape sequences
 *  are a handful of bytes; past this we assume the ESC was stray (or the OSC
 *  string pathological) and let the text through rather than stall the bubble
 *  on a terminator that may never come. */
export const MAX_ESC_CARRY = 64;

/** A trailing UNFINISHED escape sequence: a bare ESC, `ESC[` + parameter/
 *  intermediate bytes with no final byte yet, an OSC with no BEL/ST yet, or a
 *  charset select missing its set byte. Completed sequences never match — the
 *  final byte breaks the anchored tail. */
const PARTIAL_ESC_RE = /\x1b(?:\[[0-9;:?]*[ -/]*|\][^\x07\x1b]*|[()])?$/;

/**
 * PTY data arrives on arbitrary chunk boundaries, so an escape can be split
 * mid-sequence — `…ESC[1` in one read, `C…` in the next. Fed to stripAnsi
 * separately the halves match nothing and land in the bubble as literal text:
 * the same user-visible garbling #141 was about, through a different door.
 *
 * The caller holds `carry` and prepends it to the next chunk, so the sequence
 * reassembles before stripping. Bounded by MAX_ESC_CARRY (see there).
 */
export function splitTrailingPartialEscape(chunk: string): { text: string; carry: string } {
  const m = PARTIAL_ESC_RE.exec(chunk);
  if (!m) return { text: chunk, carry: '' };
  const carry = chunk.slice(m.index);
  if (carry.length > MAX_ESC_CARRY) return { text: chunk, carry: '' };
  return { text: chunk.slice(0, m.index), carry };
}

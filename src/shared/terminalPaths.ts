/**
 * What a ⌘-clicked path token in terminal output should DO.
 *
 * v0.3.4 shipped this for markdown only: `*.md` in agent output became a link
 * that opened the rendered preview. Everything else in the same line stayed
 * dead text, so a printed `src/main/updater.ts` was something you had to
 * retype into the file tree by hand.
 *
 * Three outcomes, and the split is about what we can HONESTLY do with the file:
 *
 *   preview → markdown. There is a renderer for it, and reading is the point.
 *   edit    → source and config we can put in Monaco without lying about it.
 *   reveal  → everything else: images, archives, binaries, PDFs, unknown
 *             extensions, directories. We open the OS file browser at the
 *             file's parent instead of pretending to understand the bytes.
 *
 * WHY REVEAL RATHER THAN OPEN. The token comes from AGENT OUTPUT, which is
 * hostile input. Handing an arbitrary path to the OS "open with default app"
 * call would let a line of terminal text become an execution: a printed
 * `installer.dmg`, `payload.app`, or `.desktop` file is one ⌘-click from
 * running. Revealing only ever opens a file browser, so the worst an agent can
 * do by printing a path is show you a folder you could already reach yourself.
 * That is why this module never returns an "open" verdict for an unknown type.
 *
 * MATCHING IS THE HARD PART, not classifying. Anchoring on a known extension
 * (what the markdown version did) cannot see `report.pdf` — and `report.pdf` is
 * exactly the case that needs reveal. Opening the match up to ANY extension
 * instead drags in every version string and decimal on the line: `v0.4.5`,
 * `1.5`, `electron 43.0`. The rule that separates them is below.
 */

import { isImagePath } from './imageTypes';

/** Extensions that open in the markdown preview. */
const PREVIEW_EXTS = new Set(['md', 'markdown']);

/**
 * Extensions we are willing to put in the editor. Deliberately a list rather
 * than "anything that isn't binary": a wrong guess here opens a font or a
 * sqlite file as mojibake, and the reveal fallback is a strictly better answer
 * for anything we are not sure about.
 */
const EDIT_EXTS = new Set([
  // source
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp',
  'hpp', 'cs', 'php', 'lua', 'pl', 'r', 'scala', 'clj', 'ex', 'exs', 'erl',
  'dart', 'zig', 'hs', 'ml', 'vue', 'svelte', 'astro',
  // shell
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  // markup and style
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'xml', 'xsl',
  // data and config
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'env', 'properties', 'lock', 'gradle', 'tf', 'tfvars', 'graphql', 'gql',
  'proto', 'sql', 'csv', 'tsv',
  // plain text
  'txt', 'text', 'log', 'diff', 'patch', 'gitignore', 'dockerignore',
  'editorconfig', 'npmrc', 'nvmrc'
]);

export type PathAction = 'preview' | 'edit' | 'reveal';

/**
 * Lower-cased extension of the last path segment, or '' when there is none.
 * Local rather than imported from imageTypes so a `?query` suffix cannot reach
 * a filesystem call: terminal tokens are filesystem paths, and a literal `?` in
 * a filename is legal on every platform we ship.
 */
function extOf(token: string): string {
  const base = token.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Candidate path tokens in one line of terminal output.
 *
 * The extension must START WITH A LETTER and run 1-8 more alphanumerics. That
 * single constraint is what keeps `v0.4.5`, `1.5`, and `0.92` out: their
 * "extension" is digits. `node_modules/.bin` has no extension and is caught by
 * the separator rule in `isPathToken` instead.
 *
 * The leading `X:\` group exists because `:` cannot be in the body class (it
 * would swallow the `:line` suffix). Without the group the match on
 * `C:\Users\x\a.ts` starts at the backslash, and a drive-less `\Users\x\a.ts`
 * then looks RELATIVE and gets joined onto the agent's cwd.
 */
const PATH_TOKEN_RE = /(?:[A-Za-z]:[\\/])?[A-Za-z0-9_@.~/\\+-]*[A-Za-z0-9_@~/\\+-]\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+)?/g;

/** A fresh matcher. The regex is stateful (`g`), so callers must never share one. */
export function pathTokenMatcher(): RegExp {
  return new RegExp(PATH_TOKEN_RE.source, 'g');
}

/**
 * URL tokens in terminal output.
 *
 * `https` only, deliberately. The main-process opener (`app:openExternal`)
 * accepts nothing else, so underlining an `http://` would hand back a link that
 * cannot open — which is the complaint in #281, not a fix for it.
 *
 * A matched URL is offered as-is. Punycode homographs and embedded credentials
 * (`https://user:pass@evil.com@good.com/x`) therefore reach the opener intact —
 * the same as every terminal linkifier, with the browser as the mitigation.
 * Filtering here would only give a false sense that the string was vetted.
 *
 * These must be matched BEFORE path tokens, and their spans skipped there. The
 * path matcher's Windows-drive branch reads the `s:/` inside `https://` as
 * drive `s:`, so a URL currently matches as an absolute path on a drive nobody
 * has, resolves to nothing, and silently does nothing on click.
 */
const URL_TOKEN_RE = /https:\/\/[^\s<>"'`{}|\\^]+/gi;

/** A fresh matcher. The regex is stateful (`g`), so callers must never share one. */
export function urlTokenMatcher(): RegExp {
  return new RegExp(URL_TOKEN_RE.source, 'gi');
}

const URL_TRAILING_PROSE = /["'`>,.;:!?]+$/;

/**
 * Strip the prose a URL picked up from a sentence: `(see https://x.com/a).`
 *
 * A closing bracket is only prose when the URL does not open it — Wikipedia and
 * MSDN links carry balanced ones (`/wiki/Foo_(bar)`), and eating that character
 * lands the user on a 404 with nothing to show why.
 *
 * The scheme is lowercased because the main-process opener matches `^https://`
 * case-sensitively; a terminal that printed `HTTPS://` would otherwise be
 * refused after we had already underlined it.
 */
export function stripUrlToken(raw: string): string {
  let out = raw.replace(URL_TRAILING_PROSE, '');
  const unbalanced = (open: string, close: string): boolean =>
    (out.split(open).length - 1) < (out.split(close).length - 1);
  let trimmed = true;
  while (trimmed) {
    trimmed = false;
    if (out.endsWith(')') && unbalanced('(', ')')) { out = out.slice(0, -1); trimmed = true; }
    if (out.endsWith(']') && unbalanced('[', ']')) { out = out.slice(0, -1); trimmed = true; }
    const next = out.replace(URL_TRAILING_PROSE, '');
    if (next !== out) { out = next; trimmed = true; }
  }
  return out.replace(/^https:\/\//i, 'https://');
}

/** One underlinable token on a line, with its 0-based half-open span. */
export interface TerminalLinkSpan {
  kind: 'url' | 'path';
  /** The cleaned token: the URL, or the path with wrapping and `:line` stripped. */
  token: string;
  /** Raw matched text, so a caller can size the underline. */
  raw: string;
  start: number;
  end: number;
}

/**
 * Every token on one line of terminal output that is worth underlining.
 *
 * URLs are resolved FIRST and win any overlap, because the path matcher's
 * Windows-drive branch reads the `s:/` inside `https://` as drive `s:` — so
 * without this ordering a URL is offered as an absolute path on a drive nobody
 * has, resolves to nothing, and the click silently does nothing (issue #281).
 *
 * Path tokens are returned unfiltered by `isPathToken`; the caller still decides
 * whether a path is worth offering, since only it can resolve a relative one.
 */
export function terminalLinkSpans(text: string): TerminalLinkSpan[] {
  const out: TerminalLinkSpan[] = [];

  const ure = urlTokenMatcher();
  let um: RegExpExecArray | null;
  while ((um = ure.exec(text)) !== null) {
    const token = stripUrlToken(um[0]);
    // `https://)` strips down to the bare scheme; underlining that would open
    // the browser on nothing.
    if (!/^https:\/\/./.test(token)) continue;
    out.push({ kind: 'url', token, raw: token, start: um.index, end: um.index + token.length });
  }

  const pre = pathTokenMatcher();
  let pm: RegExpExecArray | null;
  while ((pm = pre.exec(text)) !== null) {
    const raw = pm[0];
    const start = pm.index;
    const end = start + raw.length;
    if (out.some((u) => start < u.end && end > u.start)) continue;
    out.push({ kind: 'path', token: stripPathToken(raw), raw, start, end });
  }

  return out.sort((a, b) => a.start - b.start);
}

/** Strip shell/prose wrapping and any trailing `:line` from a raw match. */
export function stripPathToken(raw: string): string {
  return raw
    .replace(/^["'`([<]+/, '')
    .replace(/["'`)\]>,.;:]+$/, '')
    .replace(/:(\d+)$/, '');
}

/**
 * Is this token worth underlining at all?
 *
 * A token qualifies when it carries an extension we KNOW, or when it contains a
 * path separator. The separator clause is what lets `docs/report.pdf` and
 * `/tmp/dump.bin` reach the reveal branch while a bare `electron.43` on a prose
 * line stays dead text. It is a heuristic and it is meant to be: the cost of a
 * false positive is one underline that stats to nothing and does nothing.
 */
export function isPathToken(token: string): boolean {
  const ext = extOf(token);
  if (!ext) return false;
  if (PREVIEW_EXTS.has(ext) || EDIT_EXTS.has(ext) || isImagePath(token)) return true;
  return /[/\\]/.test(token);
}

/**
 * What ⌘-click should do with `token`.
 *
 * Images resolve to `reveal` on purpose. The app HAS an image viewer (the IDE
 * routes there), but a terminal click is a navigation gesture: you clicked a
 * path because you want to get to the file, and Finder is where you can then
 * drag, rename, or open it with the tool you actually wanted. Change this to
 * 'preview' if that reading turns out to be wrong; the classifier is the only
 * place that decides.
 */
export function classifyPathToken(token: string): PathAction {
  const ext = extOf(token);
  if (PREVIEW_EXTS.has(ext)) return 'preview';
  if (isImagePath(token)) return 'reveal';
  if (EDIT_EXTS.has(ext)) return 'edit';
  return 'reveal';
}

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

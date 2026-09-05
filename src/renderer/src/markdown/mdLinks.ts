/**
 * Pure link/path logic for the markdown preview.
 *
 * Extracted from MarkdownPreview.tsx so it can be unit-tested: these are the
 * functions that decide what a rendered document is allowed to REACH, and a
 * `.tsx` file cannot be loaded by the `node --test` harness. The component keeps
 * only the rendering.
 */
import { isImagePath } from '@shared/imageTypes';

/** Resolve `href` against the directory of `baseRel` ('' when unknown).
 *
 *  Note that `..` can only ever pop segments that this function itself pushed —
 *  once `parts` is empty a `..` is dropped — so the result is always a path
 *  UNDER the workspace root, never a sibling of it. That is a convenience, not
 *  the security boundary: the real containment check is `safeResolve` in the main
 *  process, which every read goes through. */
export function resolveRel(baseRel: string | undefined, href: string): string {
  const baseDir = (baseRel ?? '').split('/').slice(0, -1);
  const parts = [...baseDir];
  for (const seg of href.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

export function isExternal(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href);
}

/** True when `href` carries any URI scheme (http:, data:, file:, javascript:…). */
function hasScheme(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

export function isRelativeMd(href: string): boolean {
  return !hasScheme(href) && /\.(md|markdown)(#.*)?$/i.test(href);
}

/**
 * Workspace-relative path for a markdown `<img src>`, or null when the source is
 * not a local image we may load.
 *
 * WHY THIS EXISTS: the preview used to replace EVERY image with a placeholder
 * chip, so an agent-written report containing screenshots rendered as a row of
 * "🖼 screenshot" pills — the report's evidence was invisible everywhere in the
 * app. Local images can now be resolved and read through the same root-confined
 * IPC as everything else.
 *
 * What is refused, and why:
 *  - anything with a SCHEME (http:, https:, data:, file:, javascript:). Remote
 *    URLs are already dead under the CSP (`img-src 'self' data: blob:`), and
 *    silently proxying them through the main process would turn a rendered
 *    document into a network beacon that leaks "this user opened this file" to
 *    whoever authored the markdown. Agent-generated markdown is untrusted.
 *  - anything whose extension is not a known image type — there is no reason for
 *    an <img> to pull an arbitrary file's bytes into the renderer.
 *
 * A leading `/` is read as workspace-root-relative rather than as a filesystem
 * absolute path; the leading slashes are stripped and the rest resolves from the
 * root, so `/etc/passwd` becomes the (harmless, nonexistent) `etc/passwd` inside
 * the workspace instead of escaping to the real one.
 */
export function resolveLocalImageRel(baseRel: string | undefined, src: string | undefined): string | null {
  if (typeof src !== 'string') return null;
  const raw = src.trim();
  if (!raw) return null;
  if (hasScheme(raw)) return null;
  if (!isImagePath(raw)) return null;
  // Strip the query/hash before resolving — they are cache-busters, not path.
  const clean = raw.split('#')[0].split('?')[0];
  const rooted = clean.startsWith('/');
  const rel = resolveRel(rooted ? undefined : baseRel, clean);
  return rel || null;
}

/**
 * rehype plugin: stamp `dir="auto"` on every block-level element of rendered
 * markdown, so each block picks its own reading direction from its first strong
 * character.
 *
 * WHY a plugin and not CSS: `unicode-bidi: plaintext` resolves the *bidi* order
 * of a block but leaves the `direction` property alone — so an Arabic list item
 * would read right-to-left while its bullet stayed pinned on the left, and
 * `text-align: start` would still resolve against the container's LTR. `dir`
 * sets the real base direction, which markers, alignment and trailing
 * punctuation all follow. Doing it here rather than in `components` covers every
 * block element in one pass, including ones nobody has overridden yet.
 *
 * Applied per BLOCK, never to the root: a document with English headings and
 * Arabic prose (the common case for agent output) gets each block right, where a
 * single `dir` on the wrapper would have to be wrong for one of them.
 *
 * `pre`/`code` are skipped deliberately — code is LTR regardless of the language
 * of the comments inside it, and reordering a shell command would be a bug.
 */
import type { Root, Element } from 'hast';

/** Block elements whose text is prose, so direction should follow content. */
const AUTO_DIR = new Set([
  'p', 'li', 'blockquote', 'td', 'th', 'dd', 'dt', 'figcaption', 'summary',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  // The list CONTAINER too, not just its items: `dir` on a `ul` resolves from
  // the first strong character in its subtree, which is the first item's text.
  // Without it the container stays LTR and an Arabic item reads right-to-left
  // with its bullet stranded on the left, over the container's left padding.
  // `table` is left out on purpose — there `dir` would reverse COLUMN order,
  // which is a bigger claim than "this text is Arabic"; the per-cell `td`/`th`
  // entries above already give each cell the right alignment.
  'ul', 'ol'
]);

/** Subtrees to leave strictly LTR (code keeps its own order). */
const SKIP = new Set(['pre', 'code']);

export function rehypeAutoDir() {
  return (tree: Root): void => {
    const walk = (node: Root | Element): void => {
      for (const child of node.children) {
        if (child.type !== 'element') continue;
        if (SKIP.has(child.tagName)) continue;
        if (AUTO_DIR.has(child.tagName)) {
          child.properties = { ...child.properties, dir: 'auto' };
        }
        walk(child);
      }
    };
    walk(tree);
  };
}

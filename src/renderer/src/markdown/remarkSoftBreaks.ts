/**
 * Treat a single newline as a line break.
 *
 * CommonMark folds a soft break into a space, so a question written as
 *
 *     Do X first.
 *     Then tell me about Y.
 *
 * renders as one run-on line. That is correct for a document, and wrong for a
 * card that used to be a `white-space: pre-wrap` block — the ASK ME question
 * and the task detail's Q&A trail both read as messages, not as prose files.
 * So the card variant of MarkdownPreview runs this and the document variant
 * does not.
 *
 * The walk only rewrites `text` nodes. Fenced and indented code are `code`
 * nodes carrying a raw `value` with no children, and inline code is
 * `inlineCode` — neither is touched, so newlines inside code survive as-is.
 */

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

function walk(node: MdNode): void {
  const children = node.children;
  if (!children) return;
  const out: MdNode[] = [];
  for (const child of children) {
    if (child.type === 'text' && typeof child.value === 'string' && child.value.includes('\n')) {
      const parts = child.value.split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) out.push({ type: 'break' });
        if (parts[i]) out.push({ type: 'text', value: parts[i] });
      }
      continue;
    }
    walk(child);
    out.push(child);
  }
  node.children = out;
}

export function remarkSoftBreaks() {
  return (tree: unknown): void => { walk(tree as MdNode); };
}

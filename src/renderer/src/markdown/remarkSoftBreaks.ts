/**
 * 将单个换行视为换行符。
 *
 * CommonMark 将软断行折叠为空格，因此写成如下形式的提问
 *
 *     先做 X。
 *     然后告诉我关于 Y。
 *
 * 会渲染为一条连在一起的行。这对文档是正确的，但对曾经
 * 是 `white-space: pre-wrap` 块的卡片是错误的 —— ASK ME 问题
 * 和任务详情的 Q&A 跟踪都读作消息，而非散文文件。
 * 因此 MarkdownPreview 的 card 变体运行此插件，document 变体不运行。
 *
 * walk 只重写 `text` 节点。围栏和缩进代码是携带原始 `value`
 * 且无子节点的 `code` 节点，行内代码是 `inlineCode` —— 都不碰，
 * 因此代码内的换行原样保留。
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

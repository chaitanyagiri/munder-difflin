/**
 * rehype 插件：给渲染后 markdown 的每个块级元素打上 `dir="auto"`，
 * 使每块从其第一个强字符中自主选择阅读方向。
 *
 * 为什么用插件而非 CSS：`unicode-bidi: plaintext` 解析块的 *双向* 顺序，
 * 但会忽略 `direction` 属性 —— 因此阿拉伯语列表项会右到左阅读，
 * 而其项目符号仍固定在左侧，`text-align: start` 仍会相对于
 * 容器的 LTR 解析。`dir` 设置真实的基础方向，标记、对齐和尾部
 * 标点都遵循它。在此处而非 `components` 中做，一次覆盖所有
 * 块级元素，包括那些尚未被覆盖的。
 *
 * 按块应用，从不应用于根：一篇带有英文标题和阿拉伯语正文的文档
 * （agent 输出的常见情况）每块都正确，而在包装器上设单一 `dir`
 * 则必有一方错误。
 *
 * `pre`/`code` 被刻意跳过 —— 代码无论其内部注释的语言如何都是 LTR，
 * 重新排列 shell 命令会是 bug。
 */
import type { Root, Element } from 'hast';

/** 文本为散文的块级元素，因此方向应跟随内容。 */
const AUTO_DIR = new Set([
  'p', 'li', 'blockquote', 'td', 'th', 'dd', 'dt', 'figcaption', 'summary',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  // 列表 CONTAINER 本身，而非只是其项目：`dir` 在 `ul` 上从其
  // 子树中的第一个强字符解析，即第一个项目的文本。
  // 没有它容器保持 LTR，阿拉伯语项目右到左阅读，
  // 其项目符号滞留在左侧，位于容器左边距之上。
  // `table` 被刻意排除 —— 那里 `dir` 会反转列顺序，
  // 这是一个比 "这段文本是阿拉伯语" 更大的主张；
  // 上面的每个单元格 `td`/`th` 条目已经给每个单元格正确的对齐。
  'ul', 'ol'
]);

/** 保持严格 LTR 的子树（代码保留自己的顺序）。 */
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

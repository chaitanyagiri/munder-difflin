/**
 * 阿拉伯语终端配方的第 4 部分（第 1–3 部分见 arabicJoiner.ts）：
 * 中和 xterm 在阿拉伯语 span 上的 letter-spacing。
 *
 * DOM 渲染器用 `letter-spacing` 填充每个文本运行，使其宽度
 * 恰好是整数个单元格。对拉丁等宽字体这是亚像素修正；
 * 对已粘合的阿拉伯语短语 —— 其自然宽度远窄于每字符一单元格 ——
 * 它把短语拉伸到整个单元格跨度。两个错误同时发生：
 * 字母间巨大间隙，且浏览器在任何带 letter-spacing 的文本上
 * 禁用草书连接，因此字母恰好断开 —— 这正是整个努力的
 * 要修复的 bug。
 *
 * CSS 无法表达 "文本是阿拉伯语的 span"，因此这是一个
 * MutationObserver：行变化时，任何包含阿拉伯语的 span
 * 的 letter-spacing 强制为 normal。拉丁语 span 保留修正，
 * 使 TUI 框线绘制保持单元格对齐。遍历代价低廉 ——
 * 只触及新增节点和变更文本，每次重绘仅少数几个 span。
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

/** 观察终端的宿主元素；返回清理函数。 */
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

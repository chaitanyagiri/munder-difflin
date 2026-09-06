/**
 * 终端阿拉伯语渲染 —— 工作配方，三部分：
 *
 * 1. DOM 渲染器（terminalPool 在阿拉伯语模式下跳过 WebGL 租赁）。行
 *    变为真实 DOM 文本，浏览器文本引擎全程参与。
 *
 * 2. 字符连接符（本文件）。仅 DOM 渲染器会按单元格发一个 span，
 *    带 letter-spacing —— 原子盒子，浏览器既不能跨盒
 *    拼形也不能重排。将每段阿拉伯语短语合并为一个范围，就是一个
 *    单独的 span：真实的语境拼形、lam-alef 连字、标点落在字符上 ——
 *    由字体本身负责，无需预组合形字符的 trick。
 *
 * 3. design/global.css 中的 CSS：行获得 `unicode-bidi: plaintext`（每行
 *    从其第一个强字符取基础方向，类似 dir=auto），span 降为
 *    `display: inline`（inline-block 盒子对
 *    双向算法是原子的 —— inline 文本不是，因此短语顺序遵循 UBA）。
 *
 * 真实浏览器测量结果：阿拉伯语行右对齐且顺序正确，
 * 混合阿拉伯语/拉丁语行正确交错，拉丁语行不变。
 *
 * 已知权衡：块光标绘制在逻辑单元格偏移处，从左计数 ——
 * 在 RTL 行上它不会落在下一个字形出现的位置。
 * 阅读正确性值得一个错位的光标。
 */

/** 阿拉伯字母、其补充区块，以及预组合形区块。 */
export function isArabicCp(cp: number): boolean {
  return (cp >= 0x0600 && cp <= 0x06ff) || (cp >= 0x0750 && cp <= 0x077f) ||
         (cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff);
}

/** 短语可跨越而不结束连接的字符：阿拉伯语单词之间的空格和
 *  标点。范围仍只延伸到最后一个阿拉伯字符，因此尾部标点留在范围外。 */
const PHRASE_GLUE = ' ,.:;()«»،؛؟!ـ-—';

/**
 * 要作为单个单位渲染的 `text`（终端一行）的范围：每个包含
 * 阿拉伯语的最大连续段，跨单词间的标点粘合。
 * 拼形匹配 xterm 的 registerCharacterJoiner 约定：[start, end)。
 */
export function arabicJoinRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let i = 0;
  while (i < text.length) {
    if (!isArabicCp(text.charCodeAt(i))) { i++; continue; }
    const start = i;
    let end = i + 1;
    let lastArabic = i + 1;
    while (end < text.length) {
      const cp = text.charCodeAt(end);
      if (isArabicCp(cp)) { end++; lastArabic = end; continue; }
      if (PHRASE_GLUE.includes(text[end])) { end++; continue; }
      break;
    }
    if (lastArabic - start > 1) ranges.push([start, lastArabic]);
    i = Math.max(end, lastArabic);
  }
  return ranges;
}

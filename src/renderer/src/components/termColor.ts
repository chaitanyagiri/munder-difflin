/**
 * 终端 OSC 10/11 回复的颜色辅助函数。
 *
 * 刻意不依赖 xterm 和任何浏览器全局，以便解析规则可以做单元测试。
 * `terminalPool.ts` 本身无法在测试中加载：它 import 了 xterm，而 xterm 会碰
 * `self`。与 `hooks/queueDelivery.ts` 和 `store/focusMode.ts` 同理。
 */

/**
 * `#rgb` 或 `#rrggbb` 转 [r, g, b]，其它任何形式返回 null。
 *
 * null 表示“保持沉默”。用猜测回答 OSC 颜色查询比完全不回答更糟，因为 TUI 会
 * 因此自信地用错误的样式呈现自己——这正是这段代码存在要修复的故障。
 */
export function parseHexColor(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * 某种颜色的 OSC 10/11 回复正文，采用 xterm 的每通道 16 位形式。
 * 把每个字节翻倍是常规的加宽方式，所以 0x1a 变成 0x1a1a。
 */
export function oscColorBody(rgb: [number, number, number]): string {
  const wide = (v: number) => v.toString(16).padStart(2, '0').repeat(2);
  return `rgb:${wide(rgb[0])}/${wide(rgb[1])}/${wide(rgb[2])}`;
}

/**
 * 这个背景色是深色吗？
 *
 * 用于回答“我们现在是哪个主题？”，当程序刚启用 DEC 2031、而我们手上只有
 * 调色板本身的时候。采用 Rec. 601 亮度，足以区分明暗，不需要完整的 sRGB
 * 传递曲线。
 */
export function isDarkBackground(hex: string): boolean {
  const rgb = parseHexColor(hex);
  if (!rgb) return true; // 未知：假定深色，对终端来说是更稳妥的默认值
  const [r, g, b] = rgb;
  return (0.299 * r + 0.587 * g + 0.114 * b) < 128;
}

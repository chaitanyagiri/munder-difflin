/**
 * 终端选区的复制卫生。
 *
 * agent CLI 会把它们的装饰画进字符网格。Claude Code 把 markdown 引用画成
 * `▎ text`，所以那条竖轨是该行上的一个真实单元格——不是画在旁边的边框。
 * 选中该行（三击或全宽拖拽正是这么做的）会把竖轨连同正文一起复制，粘贴出来
 * 就成了：
 *
 *     ▎ Munder Difflin — clones for you and your team, working 24/7.
 *
 * 下游没有任何东西想要那个字形，所以在进剪贴板的路上把它剥掉。
 *
 * 防止这个吃掉真实内容的守卫：只有当竖轨后面跟着空格或是在行尾时才算数——
 * 这正是引用槽的形状。条形图（`▌▌▌▌ 40%`）或块状艺术会保留它们的条，
 * 因为它们连在一起。
 *
 * 刻意做得很窄。集合里只放 CLI 用作槽的左右 BLOCK 元素；方框线竖线
 * （`│`、`┃`）不在其中。`tree`、`git log --graph` 以及每个带边框的表格都会用
 * `│   ` 缩进续行，剥掉它破坏的复制会比修复的多得多。
 */

/** ▌ ▍ ▎ ▏（左半 → 左八分之一）和 ▐ ▕（右半、右八分之一）。 */
const RAIL_CHARS = '▌▍▎▏▐▕';

/** 前导缩进，然后一个或多个 `竖轨 + 空格` / `竖轨 + 行尾` 序列。
 *  嵌套引用渲染成 `▎ ▎ text`，所以要用重复。 */
const LEADING_RAIL = new RegExp(`^([ \\t]*)(?:[${RAIL_CHARS}](?: |(?=\\r?$)))+`);

const ANY_RAIL = new RegExp(`[${RAIL_CHARS}]`);

/** 从单行开头去掉引用/槽竖轨，保留缩进。 */
export function stripLeadingRail(line: string): string {
  return line.replace(LEADING_RAIL, '$1');
}

/**
 * 清理要进剪贴板的终端选区：逐行去掉 CLI 画在第 0 列的槽竖轨。其它一切——
 * 缩进、方框线、行内字形——都逐字节原样保留。
 */
export function sanitizeTerminalSelection(text: string): string {
  // 绝大多数复制的文本根本没有竖轨；跳过 split。
  if (!text || !ANY_RAIL.test(text)) return text;
  return text.split('\n').map(stripLeadingRail).join('\n');
}

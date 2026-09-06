// 16×16 像素图标。最多 2 种颜色。路径只使用整数坐标。
// 要扩充图标库，请扩展下面的 `paths`。

import { CSSProperties } from 'react';

export type IconName =
  | 'gear' | 'plus' | 'x' | 'check' | 'arrow-right' | 'pause' | 'play'
  | 'bell' | 'folder' | 'terminal' | 'code' | 'web' | 'mcp' | 'sparkle'
  | 'expand' | 'minimize' | 'clock' | 'mic' | 'ledger' | 'info' | 'sidebar'
  | 'image' | 'edit' | 'git';

interface IconDef {
  ink: string;     // 主色路径 d
  accent?: string; // 可选强调色路径 d
  accentColor: string; // CSS 变量名
}

const paths: Record<IconName, IconDef> = {
  // 每个均为 16x16，按像素网格设计
  // 四齿齿轮（N/S/E/W）+ 方形中心孔。该孔是第二个子路径，
  // 通过 fill-rule: evenodd（设置在下方的 <path> 上）镂空而成。
  gear: {
    accentColor: 'var(--cth-ink-300)',
    ink:   'M6 1h4v3h2v2h3v4h-3v2h-2v3h-4v-3h-2v-2h-3v-4h3v-2h2v-3zM6 6h4v4h-4z'
  },
  plus: {
    accentColor: 'var(--cth-mint)',
    ink:   'M7 2h2v5h5v2H9v5H7V9H2V7h5V2z'
  },
  x: {
    accentColor: 'var(--cth-coral)',
    ink:   'M3 3h2v2h2v2h2V5h2V3h2v2h-2v2h-2v2h2v2h2v2h-2v-2h-2V9H7v2H5v2H3v-2h2v-2h2V7H5V5H3V3z'
  },
  check: {
    accentColor: 'var(--cth-mint)',
    ink:   'M13 4h2v2h-2v2h-2v2H9v2H7v2H5v-2H3v-2H1V8h2v2h2v2h2v-2h2V8h2V6h2V4z'
  },
  'arrow-right': {
    accentColor: 'var(--cth-sky)',
    ink:   'M8 3h2v2h2v2h2v2h-2v2h-2v2H8v-2h2V9H2V7h8V5H8V3z'
  },
  // 记事本 + 笔。前两次尝试都是实心像素铅笔，在 16px 下都糊成一团；
  // 它和 `code`、`terminal` 排在同一行，因此绘制风格与它们一致——
  // 发丝级细轮廓、单色、两个完整对象之间留有清晰空隙，而不是彼此重叠。
  // 记事本上的笔横跨其右上角摆放，而不是停在旁边。
  // 笔在交叉处打断记事本的轮廓，这条断边正是关键所在——共享同一种墨色的
  // 两个形状，只有当下方那个明显中断时，才会被读作"叠放在上"。
  // 与 code/terminal/git 使用相同的发丝级粗细。
  edit: {
    accentColor: 'var(--cth-lilac)',
    ink:   'M13 1h2v1h-2zM1 2h10v1h-10zM12 2h2v1h-2zM1 3h1v1h-1zM11 3h2v1h-2zM1 4h1v1h-1zM10 4h2v1h-2zM1 5h1v1h-1zM9 5h2v1h-2zM1 6h1v1h-1zM3 6h5v1h-5zM9 6h1v1h-1zM1 7h1v1h-1zM10 7h1v1h-1zM1 8h1v1h-1zM10 8h1v1h-1zM1 9h1v1h-1zM3 9h5v1h-5zM10 9h1v1h-1zM1 10h1v1h-1zM10 10h1v1h-1zM1 11h1v1h-1zM10 11h1v1h-1zM1 12h1v1h-1zM3 12h5v1h-5zM10 12h1v1h-1zM1 13h1v1h-1zM10 13h1v1h-1zM1 14h1v1h-1zM10 14h1v1h-1zM1 15h10v1h-10z'
  },
  pause: {
    accentColor: 'var(--cth-lemon)',
    ink:   'M4 3h3v10H4V3zm5 0h3v10H9V3z'
  },
  play: {
    accentColor: 'var(--cth-mint)',
    ink:   'M4 3h2v2h2v2h2v2H8v2H6v2H4V3z'
  },
  bell: {
    accentColor: 'var(--cth-peach)',
    ink:   'M7 1h2v1h1v1h1v6h1v2H3V9h1V3h1V2h1V1h1zm0 12h2v2H7v-2z'
  },
  folder: {
    accentColor: 'var(--cth-lemon)',
    ink:   'M1 3h6v1h8v9H1V3zm1 1v8h12V5H6V4H2z'
  },
  // 相框 + 层叠的山 + 太阳。相框的两个子路径用 evenodd 镂出孔洞
  // （与 `terminal` 同款技巧）；山的几行像素位于孔内，
  // 每行再增加一次交叉，于是又填充回来。
  image: {
    accentColor: 'var(--cth-lemon)',
    accent: 'M4 5h2v2H4V5z',
    ink:   'M1 2h14v12H1V2zm1 1v10h12V3H2zM8 6h2v1H8zM7 7h4v1H7zM6 8h6v1H6zM5 9h8v1H5zM4 10h9v2H4z'
  },
  terminal: {
    accentColor: 'var(--cth-mint)',
    ink:   'M1 2h14v12H1V2zm1 1v10h12V3H2zm1 2h1v1h1v1h1v1H5v1H4v1H3V9h1V8h1V7H4V6H3V5zm5 5h4v1H8v-1z'
  },
  // 分支图——这正是 git 自身的标识：一条主干、两个提交节点、
  // 一条分叉出去的弧线通向第三个节点。与 `code`、`terminal` 采用相同的
  // 发丝级粗细绘制，使同一行图标读起来像一套——若换成实心填充的标记，
  // 放在这两个旁边会显得像是另一种图标家族。
  git: {
    accentColor: 'var(--cth-coral)',
    ink:   'M5 1h3v1h-3zM4 2h1v1h-1zM8 2h1v1h-1zM4 3h1v1h-1zM8 3h1v1h-1zM5 4h3v1h-3zM6 5h1v1h-1zM6 6h1v1h-1zM9 6h3v1h-3zM6 7h1v1h-1zM8 7h1v1h-1zM12 7h1v1h-1zM6 8h3v1h-3zM12 8h1v1h-1zM6 9h1v1h-1zM9 9h3v1h-3zM6 10h1v1h-1zM5 11h3v1h-3zM4 12h1v1h-1zM8 12h1v1h-1zM4 13h1v1h-1zM8 13h1v1h-1zM5 14h3v1h-3z'
  },
  code: {
    accentColor: 'var(--cth-sky)',
    ink:   'M5 3h1v1H5v1H4v1H3v1H2v1h1v1h1v1h1v1h1v1H5v-1H4v-1H3v-1H2v-1H1V7h1V6h1V5h1V4h1V3zm5 0h1v1h1v1h1v1h1v1h1v1h-1v1h-1v1h-1v1h-1v1h-1v-1h1v-1h1v-1h1V9h1V7h-1V6h-1V5h-1V4h-1V3z'
  },
  web: {
    accentColor: 'var(--cth-lilac)',
    ink:   'M7 1h2v1h2v1h1v1h1v2h1v2h-1v2h-1v1h-1v1H9v1H7v-1H5v-1H4v-1H3V9H2V7h1V5h1V4h1V3h2V2h0V1zm0 2v1H5v1H4v1H3v2h2V8h0V7h2V6h0V5h2V4h0V3H7zm2 1h1v1h1v1h1v2h-1v1H9V8h1V7h0V6h0V5h-1V4z'
  },
  mcp: {
    accentColor: 'var(--cth-lilac)',
    ink:   'M8 1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h-1v1h-1v1h-1v1h-1v1h-1v1H8v1H7v-1H6v-1H5v-1H4v-1H3v-1H2V9H1V8h1V7h1V6h1V5h1V4h1V3h1V2h1V1zm0 2v1H7v1H6v1H5v1H4v1H3v1h1v1h1v1h1v1h1v1h1v1h1v-1h1v-1h1v-1h1v-1h1V9h1V8h-1V7h-1V6h-1V5h-1V4h-1V3h-1V2H8z'
  },
  sparkle: {
    accentColor: 'var(--cth-lemon)',
    ink:   'M8 1h1v3h3v1H9v3H8V5H5V4h3V1zm-4 8h1v2h2v1H5v2H4v-2H2v-1h2V9zm8-1h1v2h2v1h-2v2h-1v-2H10v-1h2V8z'
  },
  expand: {
    accentColor: 'var(--cth-sky)',
    ink:   'M1 1h6v2H3v4H1V1zm14 0v6h-2V3H9V1h6zM1 9h2v4h4v2H1V9zm14 0v6H9v-2h4V9h2z'
  },
  minimize: {
    accentColor: 'var(--cth-sky)',
    ink:   'M5 1h2v6H1V5h4V1zm4 0h2v4h4v2H9V1zM1 9h6v6H5v-4H1V9zm8 0h6v2h-4v4H9V9z'
  },
  // 五点整的挂钟——打烊时间。表盘用 evenodd 镂空成圆环，
  // 指针作为第二个子路径（分针朝上，时针指向 5）。
  clock: {
    accentColor: 'var(--cth-lemon)',
    ink:   'M5 1h6v1h2v2h1v2h1v4h-1v2h-1v2h-2v1H5v-1H3v-2H2V8H1V6h1V4h1V2h2V1zm0 2H4v1H3v2H2v4h1v2h1v1h1v1h6v-1h1v-1h1v-2h1V6h-1V4h-1V3h-1V2H5v1zm2 1h2v4h2v1h1v1h-1v1h-1v-1H9v1H7V4z'
  },
  // 带横线的页面——触发器历史台账。边框用 evenodd 镂空，
  // 内部画三条书写线（最后一条较短，像一条只填了一部分的记录）。
  ledger: {
    accentColor: 'var(--cth-lemon)',
    ink:   'M2 1h12v14H2V1zM3 2v12h10V2H3zM5 4h6v1H5zM5 7h6v1H5zM5 10h4v1H5z'
  },
  // 麦克风：实心胶囊头、开口的支架、杆和底座。
  mic: {
    accentColor: 'var(--cth-coral)',
    ink:   'M6 2h4v7H6V2z M4 9h1v2H4z M11 9h1v2h-1z M4 11h8v1H4z M7 12h2v2H7z M5 14h6v1H5z'
  },
  // 实心圆盘把 'i' 镂空出来——圆点和竖线是独立的子路径，
  // 用 fill-rule: evenodd 切割，与齿轮中心孔同款技巧。
  // 镂空出来的字形在 16px 下依然清晰，而 1px 描边轮廓反而
  // 会在像素网格上产生抖动。
  info: {
    accentColor: 'var(--cth-sky)',
    ink:   'M5 1h6v1h2v1h1v2h1v6h-1v2h-1v1h-2v1H5v-1H3v-1H2v-2H1V5h1V3h1V2h2V1z M7 4h2v2H7z M7 7h2v5H7z'
  },
  // 面板轮廓 + 左侧栏填充——标准的侧边栏切换字形。fill-rule: evenodd
  // 下的三个子路径——外框、镂空内部、然后是左侧栏，
  // 左侧栏落在奇数次交叉上，因此重新填充回来。
  // 刻意不用 `minimize`/`expand`：它们在同一工具栏里表示"退出全屏"，
  // 两个尺寸类箭头并排摆放会被误读为同一个控件出现两次。
  sidebar: {
    accentColor: 'var(--cth-ink-300)',
    ink:   'M1 3h14v10H1z M2 4h12v8H2z M2 4h4v8H2z'
  }
};

export interface IconProps {
  name: IconName;
  size?: number; // 整数倍率：1 = 16px, 2 = 32px, ...
  style?: CSSProperties;
}

export function Icon({ name, size = 1, style }: IconProps) {
  const def = paths[name];
  const dim = 16 * size;
  return (
    <svg
      viewBox="0 0 16 16"
      width={dim}
      height={dim}
      shapeRendering="crispEdges"
      style={{ display: 'inline-block', ...style }}
      aria-hidden
    >
      {def.accent && <path d={def.accent} fill={def.accentColor} fillRule="evenodd" />}
      {/* 用 currentColor，而不是硬编码的 `--cth-ink-900`。`body` 已把同一 token
          设为自身颜色，因此在普通表面上这对每个图标都是无操作——
          但在反色表面上，它决定了一个图标是可见还是一块空白。
          主色 PixelButton 用 `--cth-ink-900` 填充自身，而用同一 token
          着色的图标会融进按钮里（两个主题下 Send 上的箭头都如此）。
          继承意味着图标始终取旁边文本的颜色，这正是每个调用处的本意。 */}
      <path d={def.ink} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

import { Container, Graphics, Text } from 'pixi.js';
import { colors } from '@/design/tokens';
import { toolIcon } from './ToolBubble';

// 一个漫画式“思想云”，钉在头像上方，显示它此刻正在做什么（agent 的实时
// `action`，例如 "edit App.tsx" / "bash npm test"）。与较暗的 ToolBubble 对话
// 气泡不同：一个浅奶油色云朵，带一串拖尾小 puff 尾巴——“思考中”的视觉速记。
// 按 DESIGN.md 构建：整像素、硬 1px 墨线轮廓、有限调色板、无软阴影。
//
// 与 ToolBubble 共享淡入淡出状态机和自动换行，让行为读起来一致；区别在于
// 外观（云 + 尾巴、浅填充），以及它会一直停留到动作变化为止（agent 工作期间
// 不自动停留）。

const PADDING_X = 6;
const PADDING_Y = 3;
const CORNER_RADIUS = 5;
const MAX_WIDTH = 150;
const FILL_COLOR = colors.cream[50];   // 浅色云朵
const OUTLINE_COLOR = colors.ink[900];
const TEXT_COLOR = '#3d2e4a';           // ink-700
const FONT_SIZE = 12;
const RENDER_SCALE = 0.5;               // 以 2x 渲染、缩小以求清晰
const OFFSET_Y = -38;                   // 比工具气泡略高
const FADE_IN_DURATION = 0.15;
const FADE_OUT_DURATION = 0.3;
const LINGER_DURATION = 1.2;            // 仅在请求 hide() 时使用
const DOTS_CYCLE_SPEED = 0.45;
// 内部（未缩放）空间里的换行宽度——内部容器以 RENDER_SCALE 渲染，所以屏幕
// 上限是 MAX_WIDTH。breakWords 拆分那些本会溢过云朵的无断点 token（长路径/
// 哈希）。
const WRAP_WIDTH = MAX_WIDTH / RENDER_SCALE - PADDING_X * 2;
// 原始字符的硬性上限，让病态的长 action 字符串折成几行，而不是变成高得离谱
// 的云朵（此宽度下约 4 行）。
const MAX_CHARS = 160;

type BubbleState = 'hidden' | 'fading-in' | 'visible' | 'lingering' | 'fading-out';

export class ThoughtBubble {
  readonly container: Container;
  private inner: Container;
  private bg: Graphics;
  private tail: Graphics;
  private label: Text;
  private state: BubbleState = 'hidden';
  private fadeElapsed = 0;
  private lingerElapsed = 0;
  private bgW = 0;
  private bgH = 0;
  private isThinking = false;
  private dotsElapsed = 0;
  private dotsPhase = 0;
  // 叠加在 OFFSET_Y 之上的额外向上位移（px），让两个相邻气泡能堆叠而不是
  // 重叠。每帧由场景的重叠扫描设置。
  private extraLift = 0;
  // 当前相机缩放。气泡活在已缩放的世界上层容器里，所以窗口缩小时
  // （fit-to-screen 缩放 < 1）文字原本会随地图一起缩小、变成粗糙的糊状。
  // 反向缩放，让气泡永不渲染到设计 1:1 屏幕尺寸以下；缩放 ≥ 1 时它像以前
  // 一样随世界缩放。
  private zoom = 1;
  // 世界边界（地图尺寸，px）。靠近地图边缘的头像——Michael 的 CEO 室在
  // 左上角——否则会把它的云推出可见世界。setPosition 以 tooltip 方式把矩形
  // 钳回内部。
  private boundsW = 0;
  private boundsH = 0;

  constructor() {
    this.container = new Container();
    this.container.zIndex = 100000;
    this.container.eventMode = 'none';
    this.container.alpha = 0;
    this.container.visible = false;

    this.inner = new Container();
    this.inner.scale.set(RENDER_SCALE);
    this.container.addChild(this.inner);

    this.tail = new Graphics();
    this.bg = new Graphics();
    this.label = new Text({
      text: '',
      style: {
        fontSize: FONT_SIZE,
        fontWeight: 'bold',
        fill: TEXT_COLOR,
        fontFamily: 'monospace',
        align: 'left',
        wordWrap: true,
        wordWrapWidth: WRAP_WIDTH,
        breakWords: true
      }
    });
    this.label.x = PADDING_X;
    this.label.y = PADDING_Y;

    // 尾巴先加，让它坐在身体后面
    this.inner.addChild(this.tail, this.bg, this.label);
  }

  /** 显示当前活动。空文本 → 动画省略号“…”（模型思考中）。
   *  `tool`（agent 的 `carrying`）存在时前缀一个小图标。 */
  show(text: string, tool?: string): void {
    this.isThinking = !text.trim();
    if (this.isThinking) {
      this.dotsElapsed = 0;
      this.dotsPhase = 0;
      this.label.text = '.';
    } else {
      const display = tool ? `${toolIcon(tool)} ${text}` : text;
      // 自动换行（style.wordWrap）处理横向适配，所以卡片不会再溢出；我们
      // 只限制原始长度，让很长的 action 折成几行而不是一整墙文字。
      this.label.text = display.length > MAX_CHARS
        ? display.slice(0, MAX_CHARS - 1).trimEnd() + '…'
        : display;
    }
    this.redraw();
    this.reveal();
  }

  private reveal(): void {
    if (this.state === 'hidden' || this.state === 'fading-out') {
      this.state = 'fading-in';
      this.fadeElapsed = 0;
      this.container.visible = true;
    } else {
      // 已经显示了——原地换文本，不再重新淡入
      this.state = 'visible';
      this.container.alpha = 1;
    }
    this.lingerElapsed = 0;
  }

  /** 开始淡出（短暂停留后）——agent 安静下来时调用。 */
  startLinger(): void {
    if (this.state === 'hidden') return;
    this.state = 'lingering';
    this.lingerElapsed = 0;
  }

  /** 为相机缩放更新：世界被缩小显示时反向缩放，让气泡的屏幕尺寸不低于 1:1。 */
  setZoom(z: number): void {
    if (!(z > 0) || z === this.zoom) return;
    this.zoom = z;
    this.container.scale.set(this.compensation());
  }

  /** 取消 < 1 相机缩放的世界单位乘数（缩放 ≥ 1 时为 1）。 */
  private compensation(): number {
    return 1 / Math.min(this.zoom, 1);
  }

  /** 气泡必须待在其中的世界矩形（地图尺寸，px）。 */
  setBounds(w: number, h: number): void {
    this.boundsW = w;
    this.boundsH = h;
  }

  setPosition(px: number, py: number): void {
    const comp = this.compensation();
    const w = this.bgW * RENDER_SCALE * comp;
    const h = this.bgH * RENDER_SCALE * comp;
    let x = px - w / 2;
    let y = py + OFFSET_Y - h - this.extraLift;
    if (this.boundsW > 0) {
      // 以 tooltip 方式钳进世界：水平滑动；而会从顶部戳出去的气泡改为向下滑
      // （它可能盖住头像的帽子——总比在世界外读不到好）。
      x = Math.min(Math.max(x, 1), Math.max(1, this.boundsW - w - 1));
      y = Math.min(Math.max(y, 1), Math.max(1, this.boundsH - h - 1));
    }
    this.container.x = Math.round(x);
    this.container.y = Math.round(y);
  }

  /** 额外向上位移（px），由场景的气泡重叠扫描设置。 */
  setLift(px: number): void {
    this.extraLift = px;
  }

  /** 气泡对给定锚点的基准屏幕矩形（忽略任何位移），隐藏时为 null。供场景
   *  检测并解决重叠。 */
  getLayout(px: number, py: number): { x: number; y: number; w: number; h: number } | null {
    if (this.state === 'hidden') return null;
    const comp = this.compensation();
    const w = this.bgW * RENDER_SCALE * comp;
    const h = this.bgH * RENDER_SCALE * comp;
    let x = px - w / 2;
    let y = py + OFFSET_Y - h;
    if (this.boundsW > 0) {
      // 报告钳制后的基准矩形，让重叠解析器在气泡实际渲染处堆叠它们，
      // 而不是理想位置上。
      x = Math.min(Math.max(x, 1), Math.max(1, this.boundsW - w - 1));
      y = Math.min(Math.max(y, 1), Math.max(1, this.boundsH - h - 1));
    }
    return { x, y, w, h };
  }

  hide(): void {
    this.state = 'hidden';
    this.isThinking = false;
    this.container.alpha = 0;
    this.container.visible = false;
  }

  isHidden(): boolean {
    return this.state === 'hidden';
  }

  update(dt: number): void {
    if (this.isThinking && (this.state === 'visible' || this.state === 'fading-in')) {
      this.dotsElapsed += dt;
      const newPhase = Math.floor(this.dotsElapsed / DOTS_CYCLE_SPEED) % 3;
      if (newPhase !== this.dotsPhase) {
        this.dotsPhase = newPhase;
        this.label.text = ['.', '..', '...'][this.dotsPhase];
        this.redraw();
      }
    }

    switch (this.state) {
      case 'fading-in': {
        this.fadeElapsed += dt;
        const t = Math.min(this.fadeElapsed / FADE_IN_DURATION, 1);
        this.container.alpha = t;
        if (t >= 1) this.state = 'visible';
        break;
      }
      case 'lingering': {
        this.lingerElapsed += dt;
        if (this.lingerElapsed >= LINGER_DURATION) {
          this.state = 'fading-out';
          this.fadeElapsed = 0;
        }
        break;
      }
      case 'fading-out': {
        this.fadeElapsed += dt;
        const t = Math.min(this.fadeElapsed / FADE_OUT_DURATION, 1);
        this.container.alpha = 1 - t;
        if (t >= 1) this.hide();
        break;
      }
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }

  private redraw(): void {
    // 云朵总是包裹实测文本。之前把 bg 钳到 MAX_WIDTH 而 label 保持真实宽度，
    // 一旦测量略微超过 wordWrapWidth（emoji 字形、回退字体度量），文字就会
    // 画过气泡边缘——在深色地图上读起来像“横向被切”。wordWrap 已经界定了
    // label，所以 bg 无需自己的钳制。
    this.bgW = this.label.width + PADDING_X * 2;
    this.bgH = this.label.height + PADDING_Y * 2;

    this.bg.clear();
    this.bg.roundRect(0, 0, this.bgW, this.bgH, CORNER_RADIUS);
    this.bg.fill({ color: FILL_COLOR });
    this.bg.stroke({ color: OUTLINE_COLOR, width: 1 });

    // 思想云尾巴：两团缩小的 puff 从气泡左下角朝下方头部拖出——这是说
    // “思考中”而不是“说话中”的提示。
    this.tail.clear();
    const baseX = this.bgW * 0.32;
    const puff = (cx: number, cy: number, r: number) => {
      this.tail.circle(cx, cy, r).fill({ color: FILL_COLOR }).stroke({ color: OUTLINE_COLOR, width: 1 });
    };
    puff(baseX, this.bgH + 4, 3);
    puff(baseX - 5, this.bgH + 9, 2);
  }
}

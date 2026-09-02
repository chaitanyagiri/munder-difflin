import { Container, Graphics, Text } from 'pixi.js';

// 显示在角色上方的对话气泡：“<icon> <target>”（例如 “> App.tsx”）。
// 从 shahar061/the-office 移植（office/characters/ToolBubble.ts）；工具图标
// 映射扩展以覆盖我们的 ToolKind 集合。

const TOOL_ICONS: Record<string, string> = {
  Read: '<',
  Edit: '>',
  Write: '>',
  Bash: '$',
  Grep: '?',
  Glob: '?',
  WebFetch: '@',
  WebSearch: '@',
  TodoWrite: '=',
  MCP: '*',
};

const DEFAULT_ICON = '*';

const PADDING_X = 6;
const PADDING_Y = 3;
const CORNER_RADIUS = 4;
const MAX_WIDTH = 140;
const BG_COLOR = 0x1a1320; // ink-900
const BG_ALPHA = 0.95;     // 近不透明：在繁忙地板上细文字原本很难读
const TEXT_COLOR = '#fffdf5';
const FONT_SIZE = 12;
const RENDER_SCALE = 0.5; // 以 2x 渲染、缩小以求清晰
const OFFSET_Y = -36;
const FADE_IN_DURATION = 0.15;
const FADE_OUT_DURATION = 0.3;
const LINGER_DURATION = 2.0;
const DOTS_CYCLE_SPEED = 0.5;
// 内部（未缩放）空间里的换行宽度——内部以 RENDER_SCALE 渲染，所以屏幕上限
// 是 MAX_WIDTH。breakWords 拆分那些本会溢过气泡的无断点 token（长路径/哈希）。
const WRAP_WIDTH = MAX_WIDTH / RENDER_SCALE - PADDING_X * 2;
// 限制原始字符，让长 target 折成几行，而不是高得离谱的气泡。
const MAX_CHARS = 150;

type BubbleState = 'hidden' | 'fading-in' | 'visible' | 'lingering' | 'fading-out';

export function toolIcon(toolName: string): string {
  return TOOL_ICONS[toolName] ?? DEFAULT_ICON;
}

export class ToolBubble {
  readonly container: Container;
  private inner: Container;
  private bg: Graphics;
  private label: Text;
  private state: BubbleState = 'hidden';
  private fadeElapsed = 0;
  private lingerElapsed = 0;
  private bgW = 0;
  private bgH = 0;
  private isThinking = false;
  private dotsElapsed = 0;
  private dotsPhase = 0;

  constructor() {
    this.container = new Container();
    this.container.zIndex = 100000;
    this.container.eventMode = 'none';
    this.container.alpha = 0;
    this.container.visible = false;

    this.inner = new Container();
    this.inner.scale.set(RENDER_SCALE);
    this.container.addChild(this.inner);

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
        breakWords: true,
      },
    });
    this.label.x = PADDING_X;
    this.label.y = PADDING_Y;

    this.inner.addChild(this.bg, this.label);
  }

  /** 显示一个工具动作。传 toolName='' & target='...' 以渲染思考省略号。 */
  show(toolName: string, target: string): void {
    const icon = toolIcon(toolName);
    this.isThinking = !toolName && target === '...';

    if (this.isThinking) {
      this.dotsElapsed = 0;
      this.dotsPhase = 0;
      this.label.text = '.';
    } else {
      const displayText = target ? `${icon} ${target}` : icon;
      // 自动换行（style.wordWrap）处理横向适配，所以气泡不会再溢出；我们
      // 只限制原始长度，让它保持几行高。
      this.label.text = displayText.length > MAX_CHARS
        ? displayText.slice(0, MAX_CHARS - 1).trimEnd() + '…'
        : displayText;
    }

    this.redrawBg();
    this.reveal();
  }

  /** 显示纯文本（无工具图标）——用于坐姿 agent 上方的“上一条提示”卡片。
   *  一直停留到被替换/隐藏（不自动停留）。 */
  showText(text: string): void {
    this.isThinking = false;
    const display = text || '…';
    // 自动换行处理横向适配；限制原始长度以界定高度。
    this.label.text = display.length > MAX_CHARS
      ? display.slice(0, MAX_CHARS - 1).trimEnd() + '…'
      : display;
    this.redrawBg();
    this.reveal();
  }

  private reveal(): void {
    if (this.state === 'hidden' || this.state === 'fading-out') {
      this.state = 'fading-in';
      this.fadeElapsed = 0;
      this.container.visible = true;
    } else {
      this.state = 'visible';
      this.container.alpha = 1;
    }
    this.lingerElapsed = 0;
  }

  startLinger(): void {
    if (this.state === 'hidden') return;
    this.state = 'lingering';
    this.lingerElapsed = 0;
  }

  setPosition(px: number, py: number): void {
    const halfBubble = (this.bgW * RENDER_SCALE) / 2;
    // 取整：头像每帧以亚像素步长滑行，而跟在它后面的气泡若用小数坐标，会让
    // 半缩放的文字每帧重采样不同——角色行走时表现为闪烁/抖动。
    // （ThoughtBubble 已经这么做。）
    this.container.x = Math.round(px - halfBubble);
    this.container.y = Math.round(py + OFFSET_Y - this.bgH * RENDER_SCALE);
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
        this.redrawBg();
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

  private redrawBg(): void {
    // 总是包裹实测文本——之前把 bg 钳住而 label 保持真实宽度，测量略微超过
    // wordWrapWidth（emoji 字形、回退度量）时文字就会画过气泡边缘。wordWrap
    // 已经界定了 label，所以 bg 无需自己的钳制。
    this.bgW = this.label.width + PADDING_X * 2;
    this.bgH = this.label.height + PADDING_Y * 2;
    this.bg.clear();
    this.bg.roundRect(0, 0, this.bgW, this.bgH, CORNER_RADIUS);
    this.bg.fill({ color: BG_COLOR, alpha: BG_ALPHA });
  }
}

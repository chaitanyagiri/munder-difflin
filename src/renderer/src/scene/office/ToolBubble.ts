import { Container, Graphics, Text } from 'pixi.js';

// Speech bubble shown above a character: "<icon> <target>" (e.g. "> App.tsx").
// Ported from shahar061/the-office (office/characters/ToolBubble.ts); tool icon
// map extended to cover our ToolKind set.

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
const BG_ALPHA = 0.95;     // near-opaque: thin text over a busy floor was hard to read
const TEXT_COLOR = '#fffdf5';
const FONT_SIZE = 12;
const RENDER_SCALE = 0.5; // render at 2x, scale down for crispness
const OFFSET_Y = -36;
const FADE_IN_DURATION = 0.15;
const FADE_OUT_DURATION = 0.3;
const LINGER_DURATION = 2.0;
const DOTS_CYCLE_SPEED = 0.5;
// Word-wrap width in the inner (unscaled) space — the inner renders at
// RENDER_SCALE, so the on-screen cap is MAX_WIDTH. breakWords splits unbroken
// tokens (long paths/hashes) that would otherwise still spill past the bubble.
const WRAP_WIDTH = MAX_WIDTH / RENDER_SCALE - PADDING_X * 2;
// Cap raw chars so a long target wraps to a few lines, not a runaway-tall bubble.
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

  /** Show a tool action. Pass toolName='' & target='...' to render a thinking ellipsis. */
  show(toolName: string, target: string): void {
    const icon = toolIcon(toolName);
    this.isThinking = !toolName && target === '...';

    if (this.isThinking) {
      this.dotsElapsed = 0;
      this.dotsPhase = 0;
      this.label.text = '.';
    } else {
      const displayText = target ? `${icon} ${target}` : icon;
      // Word-wrap (style.wordWrap) handles the horizontal fit, so the bubble can no
      // longer overflow; we only cap the raw length to keep it a few lines tall.
      this.label.text = displayText.length > MAX_CHARS
        ? displayText.slice(0, MAX_CHARS - 1).trimEnd() + '…'
        : displayText;
    }

    this.redrawBg();
    this.reveal();
  }

  /** Show plain text (no tool icon) — used for the "last prompt" card above a
   *  seated agent. Stays put until replaced/hidden (no auto-linger). */
  showText(text: string): void {
    this.isThinking = false;
    const display = text || '…';
    // Word-wrap handles the horizontal fit; cap raw length to bound the height.
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
    // Round: the avatar glides at sub-pixel steps every frame, and a bubble
    // following it on fractional coordinates makes the half-scaled text
    // resample differently each frame — visible as shimmering/flickering
    // while the character walks. (ThoughtBubble already does this.)
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
    // Always wrap the MEASURED text — clamping the bg while the label keeps
    // its real width lets text paint past the bubble edge when the measurement
    // overshoots wordWrapWidth (emoji glyphs, fallback metrics). wordWrap
    // already bounds the label, so the bg needs no clamp of its own.
    this.bgW = this.label.width + PADDING_X * 2;
    this.bgH = this.label.height + PADDING_Y * 2;
    this.bg.clear();
    this.bg.roundRect(0, 0, this.bgW, this.bgH, CORNER_RADIUS);
    this.bg.fill({ color: BG_COLOR, alpha: BG_ALPHA });
  }
}

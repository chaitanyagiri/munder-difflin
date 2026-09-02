import { Container, Graphics } from 'pixi.js';
import { colors } from '@/design/tokens';

/** Hive 言语行为（镜像主进程里的 HiveMessage['act']）。 */
export type MessageAct = 'request' | 'inform' | 'propose' | 'query' | 'agree' | 'refuse' | 'done';

// 一个小像素画信封：hive 路由消息时从发件人的桌子飞向收件人的桌子，然后
// 迸出一小圈到达光点。活在角色层的世界空间里，所以相机像对待其它一切一样
// 变换它。完全自包含：生成它、tick 它、done() 为 true 时丢弃它。
//
// 美感遵循 DESIGN.md——硬边、整像素、无圆角、墨线轮廓、按言语行为取状态色，
// 一眼读出“谁在问谁”。

/** 言语行为 → 信封色调。镜像楼层的状态调色板意图：
 *  请求是冷色、回答是暖/正色、拒绝是红色。 */
const ACT_COLOR: Record<MessageAct, number> = {
  request: colors.accent.sky,
  query:   colors.accent.lilac,
  propose: colors.accent.lemon,
  inform:  colors.cream[200],
  agree:   colors.accent.mint,
  done:    colors.accent.mint,
  refuse:  colors.accent.coral
};

const OUTLINE = colors.ink[900];
const HUMAN_COLOR = colors.accent.coral; // 升级给人类的消息

const FLY_HEIGHT = 22;       // 信封骑乘在足部锚点上方的 px
const ARC_LIFT = 38;         // 飞行弧线的峰高（负 y）
const SPEED = 230;           // px/秒 —— 时长由飞行距离推导
const MIN_DURATION = 0.8;
const MAX_DURATION = 2.0;
const FADE_IN = 0.14;
const FADE_OUT = 0.22;
const BURST_DURATION = 0.34; // 到达闪光环

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export class MessageEnvelope {
  readonly container: Container;
  private body: Graphics;
  private burst: Graphics;

  private sx: number; private sy: number;
  private ex: number; private ey: number;
  private duration: number;
  private elapsed = 0;
  private bursting = false;
  private burstElapsed = 0;
  private finished = false;

  /** start/end 是发件人与收件人的世界像素足部锚点。 */
  constructor(
    start: { x: number; y: number },
    end: { x: number; y: number },
    act: MessageAct,
    needsHuman: boolean
  ) {
    this.sx = start.x; this.sy = start.y - FLY_HEIGHT;
    this.ex = end.x;   this.ey = end.y - FLY_HEIGHT;
    const dist = Math.hypot(this.ex - this.sx, this.ey - this.sy);
    this.duration = Math.min(MAX_DURATION, Math.max(MIN_DURATION, dist / SPEED));

    const fill = needsHuman ? HUMAN_COLOR : (ACT_COLOR[act] ?? colors.cream[200]);

    this.container = new Container();
    this.container.zIndex = 1_000_000; // 永远在角色群之上
    this.container.eventMode = 'none';
    this.container.alpha = 0;

    // 信封：带墨线轮廓和“封盖”山形折线的 14×10 矩形。居中绘制，让旋转/
    // 缩放以中心为支点。
    this.body = new Graphics();
    const w = 14, h = 10;
    this.body.rect(-w / 2, -h / 2, w, h).fill({ color: fill }).stroke({ color: OUTLINE, width: 1 });
    // 封盖——从两个顶角汇聚到中心的两条线
    this.body.moveTo(-w / 2, -h / 2).lineTo(0, h / 2 - 3).lineTo(w / 2, -h / 2)
      .stroke({ color: OUTLINE, width: 1 });
    this.container.addChild(this.body);

    this.burst = new Graphics();
    this.burst.visible = false;
    this.container.addChild(this.burst);

    this.setPos(this.sx, this.sy);
  }

  private setPos(x: number, y: number): void {
    this.container.x = Math.round(x);
    this.container.y = Math.round(y);
  }

  /** 推进动画。完全播完时返回 true。 */
  update(dt: number): boolean {
    if (this.finished) return true;

    if (!this.bursting) {
      this.elapsed += dt;
      const t = Math.min(this.elapsed / this.duration, 1);
      const e = easeInOut(t);
      // 二次曲线弧：插值端点，抬高中点
      const x = this.sx + (this.ex - this.sx) * e;
      const lift = -ARC_LIFT * Math.sin(Math.PI * e);
      const y = this.sy + (this.ey - this.sy) * e + lift;
      this.setPos(x, y);

      // 开头淡入、临近结尾淡出；轻微钟摆旋转
      const fadeIn = Math.min(this.elapsed / FADE_IN, 1);
      const fadeOut = t > 1 - FADE_OUT / this.duration
        ? Math.max(0, (1 - t) / (FADE_OUT / this.duration))
        : 1;
      this.container.alpha = Math.min(fadeIn, fadeOut);
      this.body.rotation = Math.sin(this.elapsed * 6) * 0.12;

      if (t >= 1) {
        this.bursting = true;
        this.body.visible = false;
        this.burst.visible = true;
        this.container.alpha = 1;
        this.setPos(this.ex, this.ey);
      }
      return false;
    }

    // 到达光点——一圈扩张并淡出的墨环
    this.burstElapsed += dt;
    const bt = Math.min(this.burstElapsed / BURST_DURATION, 1);
    const r = 3 + bt * 12;
    this.burst.clear();
    this.burst.circle(0, 0, r).stroke({ color: colors.accent.lemon, width: 2, alpha: 1 - bt });
    this.container.alpha = 1 - bt;
    if (bt >= 1) {
      this.finished = true;
      return true;
    }
    return false;
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}

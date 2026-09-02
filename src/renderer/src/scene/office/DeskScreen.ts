import { Container, Graphics, Sprite } from 'pixi.js';
import type { TiledMapRenderer } from './TiledMapRenderer';
import type { MonitorConfig } from './themeRegistry';

// 办公室 tileset 把每台桌机画了两遍：深色关机的显示器（gids 365/366 +
// 381/382 —— 地图画的就是它）和同一台点亮蓝色桌面的显示器（367/368 +
// 383/384）。DeskScreen 在 agent 坐下时把点亮变体叠到桌子的显示器块上，
// 再加一段微小的屏幕活跃动画（滚动行 + 闪烁光标），让电脑在主人工作时
// 明显在运行。隐藏时地图的关机美术透出——没有需要撤销的状态。

/** OFF 显示器块的左上瓦片 gid，按办公室地图所画。办公室主题的默认值；
 *  主题可通过自己的 MonitorConfig 提供。 */
export const MONITOR_OFF_TOPLEFT_GID = 365;
/** 办公室主题匹配的 ON 瓦片，直接铺在 OFF 块右侧 2×2 处——在没传
 *  每主题 MonitorConfig 时使用。 */
const DEFAULT_ON_GIDS: ReadonlyArray<readonly [number, number, number]> = [
  // [gid, dx, dy] 以瓦片为单位，相对块左上角
  [367, 0, 0], [368, 1, 0],
  [383, 0, 1], [384, 1, 1]
];

/** 2×2（32×32px）块的屏幕内部，以本地像素计——瓦片美术里蓝色桌面的
 *  绘制处。动画保持在它内部。 */
const SCREEN = { x: 3, y: 5, w: 25, h: 12 };

export class DeskScreen {
  readonly container = new Container();
  private anim = new Graphics();
  private on = false;
  private t = 0;

  constructor(mapRenderer: TiledMapRenderer, topLeft: { x: number; y: number }, monitor?: MonitorConfig) {
    const ts = mapRenderer.tileSize;
    const onGids = monitor?.onGids ?? DEFAULT_ON_GIDS;
    for (const [gid, dx, dy] of onGids) {
      const tex = mapRenderer.textureForGid(gid);
      if (!tex) continue;
      const s = new Sprite(tex);
      s.x = dx * ts;
      s.y = dy * ts;
      this.container.addChild(s);
    }
    this.anim.eventMode = 'none';
    this.container.addChild(this.anim);
    this.container.x = topLeft.x * ts;
    this.container.y = topLeft.y * ts;
    // 与角色一起排序：块的底边位于坐姿 agent 的锚点行上方，所以头像画在
    // 键盘之上、而不是之下——与地图美术暗示的画家顺序一致。
    this.container.zIndex = (topLeft.y + 2) * ts - 1;
    this.container.visible = false;
    this.container.eventMode = 'none';
  }

  /** 点亮屏幕（agent 坐下）或熄灭（站起 / 离开）。 */
  setOn(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.container.visible = on;
    if (!on) { this.anim.clear(); this.t = 0; }
  }

  update(dt: number): void {
    if (!this.on) return;
    this.t += dt;
    const g = this.anim;
    g.clear();
    // 两行微弱的“输出”行在桌面上向上滚动、循环往复——
    // 永恒的构建日志——加上左下角闪烁的光标。
    for (let i = 0; i < 2; i++) {
      const phase = (this.t * 3.2 + i * (SCREEN.h / 2)) % SCREEN.h;
      const y = SCREEN.y + SCREEN.h - 1 - phase;
      const w = 6 + ((i * 7 + Math.floor(this.t / 1.7)) % 9);
      g.rect(SCREEN.x + 2, Math.round(y), w, 1).fill({ color: 0xcfe6ff, alpha: 0.55 });
    }
    if (Math.floor(this.t / 0.53) % 2 === 0) {
      g.rect(SCREEN.x + 2, SCREEN.y + SCREEN.h - 2, 2, 2).fill({ color: 0xffffff, alpha: 0.9 });
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}

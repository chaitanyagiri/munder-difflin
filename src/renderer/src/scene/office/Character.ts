import { Container, Graphics, Texture } from 'pixi.js';
import { CharacterSprite, type Direction, type AnimState } from './CharacterSprite';
import { findPath } from './pathfinding';
import type { TiledMapRenderer } from './TiledMapRenderer';
import { ThoughtBubble } from './ThoughtBubble';

// 改编自 shahar061/the-office（office/characters/Character.ts）。
// 差异：按我们的动态 agentId 索引（不是固定角色）；座位瓦片 + 光晕颜色是
// 注入的（我们从池子里给 agent 分配座位）；CSS 主题光晕脉冲换成常量；新增
// 阻塞“!” + 成功闪光覆盖层，以覆盖我们的状态模型。

export type CharacterAnimation = 'idle' | 'walk' | 'type' | 'read';
export type StatusGlyph = 'none' | 'blocked' | 'success' | 'compacting' | 'looping';

function lerp(a: number, b: number, t: number): number {
  const tt = Math.min(Math.max(t, 0), 1);
  return a + (b - a) * tt;
}

/** 一个小咖啡马克杯（白身、黄条、把手），(x, y) = 它的左下角。与 tileset
 *  曾经烘在每张桌子上的马克杯同轮廓——现在它只存在于 agent 真的放下一个的
 *  地方。与场景共享（干净杯具餐边柜用它渲染库存）。 */
export function paintCup(g: Graphics, x: number, y: number): void {
  g.rect(x, y - 4, 5, 4).fill(0xf2ede2);
  g.rect(x, y - 2, 5, 1).fill(0xe8c14d);
  g.rect(x + 5, y - 3, 1, 2).fill(0xd9d2c4);
  g.rect(x, y - 4, 5, 1).fill(0xffffff);
}

const SPEED = 48; // 像素/秒（tileSize=16）
// 坐下时滑动精灵，让它读起来是“坐在椅子上”而不是站在瓦片上。椅子瓦片放
// 着椅子/桶，agent 面对的那块瓦片是桌子。脚锚在座位瓦片底部、身体约 2 个
// 瓦片高，所以没有推挤的话头会越到远处桌沿外、下面的椅子看起来空着。我们把
// 身体朝观看者推（向下，用于上/侧向座位；桌子在它们后面），让头落在显示器
// 处、躯干坐在椅子上。面向下的 agent（桌子在前）被推进桌子。
const SIT_OFFSET = 5;
const SIT_OFFSET_DOWN = 12;
const SIT_OFFSET_UP = 5;   // 面向向上：把身体放低到椅子上
const SIT_OFFSET_SIDE = 4; // 左/右：小一点的落差 + 侧向收拢
// 坐姿时从 32px 精灵底部裁掉的像素。上/侧向座位只裁脚，让大部分躯干露出并
// 填满椅面；面向下的裁剪更大，让腿收进前面的桌子下面。
const SEAT_LEG_CROP = 8;
const SEAT_BACK_CROP = 2;

// 空闲 30/30 循环：任务之间 agent 在地板上游荡与在自己桌前休息交替——
// 每闲逛 IDLE_LINGER_SECONDS 秒就在桌前坐 DESK_REST_SECONDS 秒，如此反复。
// 工作中的 agent 完全跳过它（他们经 sitAtDesk 保持坐着）。
const IDLE_LINGER_SECONDS = 30;
const DESK_REST_SECONDS = 30;

interface CharacterOptions {
  agentId: string;
  mapRenderer: TiledMapRenderer;
  frames: Texture[][];
  seatTile: { x: number; y: number };
  /** 头像首次出现的位置（办公室门）。默认 seatTile。 */
  spawnTile?: { x: number; y: number };
  glowColor: number;
  /** 坐姿时朝向。默认 'down'，让脸朝向用户。 */
  seatDirection?: Direction;
  onClick?: (agentId: string) => void;
}

export class Character {
  readonly agentId: string;
  readonly sprite: CharacterSprite;

  private state: CharacterAnimation = 'idle';
  private mapRenderer: TiledMapRenderer;
  private deskTile: { x: number; y: number };
  private seatDirection: Direction;
  private px: number;
  private py: number;
  private path: { x: number; y: number }[] = [];
  private pendingWork: CharacterAnimation | null = null;
  private pendingSit = false;
  private sitting = false;
  private wandering = false;
  private idleTimer = 0;
  private idleWanderDelay = 1 + Math.random() * 3;
  // 空闲 30/30 循环状态（见上方常量）。仅在任务之间激活。
  private idleLoop = false;
  private idleLoopPhase: 'linger' | 'toDesk' | 'resting' = 'linger';
  private idleLoopTimer = 0;
  private direction: Direction = 'down';
  private arrivalCallback: (() => void) | null = null;

  public isVisible = false;
  private fadeDirection: 'in' | 'out' | null = null;
  private fadeDuration = 0;
  private fadeElapsed = 0;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  private thoughtBubble: ThoughtBubble;
  private workGlow: Graphics;
  private workGlowElapsed = 0;
  private glowOn = false;

  private overlay: Graphics;
  private statusGlyph: StatusGlyph = 'none';
  private glyphElapsed = 0;
  private onClick?: (agentId: string) => void;

  // ── 办公室生活特效（欢呼 / 咖啡 / 浇水）────────────────────────────
  /** 挂在精灵上的特效层：彩纸、手持的杯子、水滴。 */
  private fx: Graphics;
  private fxDirty = false;            // fx 上一帧画过 → 空闲时需要清除
  private cheerT = -1;                // -1 = 未在欢呼
  private confetti: Array<{ x: number; y: number; vx: number; vy: number; c: number }> = [];
  private carryingCup = false;
  /** 停在该 agent 桌子上的杯子（世界坐标定位，活在角色层里，agent 走开也还在）。 */
  private deskCup: Graphics;
  private deskCupOn = false;
  private cupSpot: { x: number; y: number } | null = null;
  private waterT = -1;                // -1 = 未在浇水
  private waterDur = 0;
  private onWaterDone: (() => void) | null = null;
  private smokeT = -1;                // -1 = 未在抽烟（老板的雪茄）
  private smokeDur = 0;
  private onSmokeDone: (() => void) | null = null;

  constructor(options: CharacterOptions) {
    this.agentId = options.agentId;
    this.mapRenderer = options.mapRenderer;
    this.sprite = new CharacterSprite(options.frames);
    this.deskTile = options.seatTile;
    this.seatDirection = options.seatDirection ?? 'down';
    this.onClick = options.onClick;

    // 出现在出生瓦片（门）处，然后从这里走进来。
    const start = options.spawnTile ?? this.deskTile;
    const pos = this.mapRenderer.tileToPixel(start.x, start.y);
    this.px = pos.x + this.mapRenderer.tileSize / 2;
    this.py = pos.y + this.mapRenderer.tileSize;
    this.sprite.setPosition(this.px, this.py);

    this.thoughtBubble = new ThoughtBubble();
    // 让气泡留在世界内——否则 Michael 的角落办公室会把他的气泡
    // 挤出地图上/左边缘。
    this.thoughtBubble.setBounds(
      this.mapRenderer.width * this.mapRenderer.tileSize,
      this.mapRenderer.height * this.mapRenderer.tileSize
    );

    this.workGlow = new Graphics();
    this.workGlow.circle(0, 0, 14);
    this.workGlow.fill({ color: options.glowColor, alpha: 1 });
    this.workGlow.alpha = 0;
    this.workGlow.eventMode = 'none';

    this.overlay = new Graphics();
    this.overlay.eventMode = 'none';

    this.fx = new Graphics();
    this.fx.eventMode = 'none';

    this.deskCup = new Graphics();
    this.deskCup.eventMode = 'none';
    this.deskCup.visible = false;
  }

  getAnimation(): CharacterAnimation { return this.state; }
  getDeskTile(): { x: number; y: number } { return this.deskTile; }
  getPixelPosition(): { x: number; y: number } { return { x: this.px, y: this.py }; }

  getTilePosition(): { x: number; y: number } {
    return this.mapRenderer.pixelToTile(this.px, this.py - 1);
  }

  moveTo(tile: { x: number; y: number }): void {
    const path = findPath(this.mapRenderer, this.getTilePosition(), tile);
    if (path && path.length > 0) {
      this.sitting = false; // 走路前先站起来（清掉坐姿偏移）
      this.sprite.setSeatedCrop(0); // 站立/走路时重新露出腿
      this.path = path;
      this.state = 'walk';
      this.sprite.setAnimation('walk', this.direction);
    }
  }

  walkToAndThen(tile: { x: number; y: number }, callback: () => void): void {
    this.idleLoop = false; // 定向“走过去然后做某事”（如咖啡休息）占据头像
    this.arrivalCallback = callback;
    this.moveTo(tile);
    if (this.state !== 'walk') {
      // 没有生成路径。如果已经在这块瓦片上，现在就触发回调；
      // 否则不可达——丢掉它，免得“到达”别的地方。
      this.arrivalCallback = null;
      const t = this.getTilePosition();
      if (t.x === tile.x && t.y === tile.y) callback();
    }
  }

  /** 坐在分配的桌子前，面向显示器。若不在则先走过去。
   *  `working` 切换脉冲式专注光晕。这是默认姿态——agent
   *  除非被阻塞，否则保持坐着。 */
  sitAtDesk(working: boolean): void {
    this.idleLoop = false;     // 显式的坐桌命令结束空闲循环
    this.walkToDeskAndSit(working);
  }

  /** 走到家桌（若不在）并坐下。`working` 切换专注光晕。
   *  由 sitAtDesk（真正的工作/等待）和空闲循环休息共用。 */
  private walkToDeskAndSit(working: boolean): void {
    this.glowOn = working;
    this.wandering = false;
    const t = this.getTilePosition();
    if (t.x === this.deskTile.x && t.y === this.deskTile.y) {
      this.applySit();
    } else {
      this.pendingSit = true;
      this.pendingWork = null;
      this.arrivalCallback = null;
      this.moveTo(this.deskTile); // updateWalk() 到达时坐下
    }
  }

  /** 在当前（桌子）瓦片上瞬间进入坐姿。 */
  private applySit(): void {
    this.applySitPose(this.seatDirection);
  }

  /** 在当前瓦片上瞬间进入面向 `dir` 的坐姿。由
   *  家桌（applySit）和任意咖啡座（sitInPlace）共用。 */
  private applySitPose(dir: Direction): void {
    this.state = 'idle';
    this.pendingWork = null;
    this.pendingSit = false;
    this.path = [];
    this.sitting = true;
    this.direction = dir;
    this.sprite.setAnimation('idle', dir);
    // 朝桌子滑动，让 agent 收进去而不是飘在过道里，再裁掉腿，
    // 让它们读起来是坐着的（没有站立的腿）。
    let dx = 0, dy = 0;
    switch (dir) {
      case 'down':  dy = SIT_OFFSET_DOWN; break;
      case 'up':    dy = SIT_OFFSET_UP; break;
      case 'left':  dx = -SIT_OFFSET; dy = SIT_OFFSET_SIDE; break;
      case 'right': dx = SIT_OFFSET; dy = SIT_OFFSET_SIDE; break;
    }
    this.sprite.setPosition(this.px + dx, this.py + dy);
    this.sprite.setSeatedCrop(dir === 'down' ? SEAT_LEG_CROP : SEAT_BACK_CROP);
  }

  /** 坐在当前瓦片上的咖啡座，面向 `dir`。agent 必须先已经
   *  走到座位瓦片上（用 walkToAndThen 驱动）。与 sitAtDesk 不同，
   *  这不动 agent 的家桌，也从不点亮专注光晕——这是休息，不是工作。 */
  sitInPlace(dir: Direction): void {
    this.idleLoop = false;
    this.wandering = false;
    this.glowOn = false;
    this.arrivalCallback = null;
    this.applySitPose(dir);
  }

  /** 头像是否停在坐姿（桌子或咖啡座）。 */
  isSitting(): boolean {
    return this.sitting;
  }

  /** 让站立/空闲的头像面向 `dir`（例如站着休息时面朝咖啡机）。
   *  走路中途或坐着时无操作。 */
  faceDirection(dir: Direction): void {
    this.direction = dir;
    if (!this.sitting && this.state !== 'walk') {
      this.sprite.setAnimation('idle', dir);
    }
  }

  setIdle(): void {
    this.idleLoop = false;
    this.state = 'idle';
    this.pendingWork = null;
    this.pendingSit = false;
    this.sitting = false;
    this.wandering = false;
    this.path = [];
    this.glowOn = false;
    this.sprite.setSeatedCrop(0);
    this.sprite.setAnimation('idle', this.direction);
    this.sprite.setPosition(this.px, this.py);
  }

  /** 任务之间在办公室里闲逛。挑随机的可行走瓦片一直溜达，
   *  直到 agent 再次被派活。 */
  startWandering(): void {
    if (this.idleLoop && this.wandering) return; // 已经在闲逛阶段
    // （重新）从闲逛阶段进入空闲循环，然后开始游荡。
    this.idleLoop = true;
    this.idleLoopPhase = 'linger';
    this.idleLoopTimer = 0;
    this.beginWander();
  }

  /** 底层：现在就起步在地板上游荡。驱动空闲循环的
   *  闲逛阶段（休息结束时也会复用）。不改循环状态。 */
  private beginWander(): void {
    if (this.wandering) return;
    this.glowOn = false;
    this.sitting = false;
    this.pendingSit = false;
    this.pendingWork = null;
    this.wandering = true;
    this.idleTimer = 0;
    this.idleWanderDelay = 0.5 + Math.random() * 2;
    this.sprite.setSeatedCrop(0);
    if (this.state !== 'walk') {
      this.state = 'idle';
      this.sprite.setAnimation('idle', this.direction);
      this.sprite.setPosition(this.px, this.py); // 清掉坐姿偏移
    }
  }

  /** 走到任意瓦片（如阻塞时去等候区）；到达后站着。 */
  walkToTile(tile: { x: number; y: number }): void {
    this.idleLoop = false;
    this.pendingWork = null;
    this.pendingSit = false;
    this.sitting = false;
    this.wandering = false;
    this.arrivalCallback = null;
    this.moveTo(tile);
  }

  repositionTo(tx: number, ty: number): void {
    this.deskTile = { x: tx, y: ty };
    const pos = this.mapRenderer.tileToPixel(tx, ty);
    this.px = pos.x + this.mapRenderer.tileSize / 2;
    this.py = pos.y + this.mapRenderer.tileSize;
    this.sprite.setPosition(this.px, this.py);
  }

  /** 在头像头顶的气泡里显示它此刻在做什么。空文本渲染一个
   *  动画“…”（思考中）；`tool` 加一个小图标。 */
  showThought(text: string, tool?: string): void {
    this.thoughtBubble.show(text, tool);
  }

  /** 短暂停留后让气泡淡出——agent 安静下来了。 */
  hideThought(): void {
    this.thoughtBubble.startLinger();
  }

  /** 气泡当前的基础屏幕矩形（无抬升），或隐藏时为 null。
   *  场景用它检测并消解重叠的气泡。 */
  getThoughtLayout(): { x: number; y: number; w: number; h: number } | null {
    return this.thoughtBubble.getLayout(this.px, this.py);
  }

  /** 把该头像的气泡向上移 `px`，让它避开附近的一个。 */
  setThoughtLift(px: number): void {
    this.thoughtBubble.setLift(px);
  }

  /** 转发相机缩放，让气泡可以反向缩放，在窗口（以及整个世界）缩小时
   *  保持其屏幕上的文字大小不变。 */
  setBubbleZoom(z: number): void {
    this.thoughtBubble.setZoom(z);
  }

  setStatusGlyph(glyph: StatusGlyph): void {
    if (glyph === this.statusGlyph) return;
    this.statusGlyph = glyph;
    this.glyphElapsed = 0;
    if (glyph === 'none') this.overlay.clear();
  }

  // ── 欢呼 ────────────────────────────────────────────────────────────────

  /** 庆祝完成的工作：在一阵彩纸爆开下蹦跳几下。
   *  期间暂停移动（游荡/空闲循环），让跳跃在当场可读；
   *  之后头像原本被吩咐做的事立即恢复。 */
  cheer(): void {
    if (this.sitting) return; // 坐姿欢呼会跟坐姿偏移/裁剪打架
    // 原地停下，让跳跃在当场可读；随后继续游荡。
    this.path = [];
    if (this.state === 'walk') {
      this.state = 'idle';
      this.sprite.setAnimation('idle', this.direction);
    }
    this.cheerT = 0;
    this.confetti = [];
    const colors = [0xffd93d, 0xff6b6b, 0x6bcb77, 0x4d96ff, 0xf6a6ff];
    for (let i = 0; i < 14; i++) {
      this.confetti.push({
        x: (Math.random() - 0.5) * 8,
        y: -22 - Math.random() * 6,
        vx: (Math.random() - 0.5) * 46,
        vy: -30 - Math.random() * 40,
        c: colors[i % colors.length]
      });
    }
  }

  /** 欢呼动画是否正把头像按在原地。 */
  isCheering(): boolean {
    return this.cheerT >= 0;
  }

  // ── 咖啡杯 ─────────────────────────────────────────────────────────────

  /** 该 agent 的杯子停在桌上时的位置（世界像素）。
   *  通常在显示器旁边——旧 tileset 烘烤的马克杯所在处。 */
  setCupSpot(spot: { x: number; y: number } | null): void {
    this.cupSpot = spot;
    if (spot) {
      this.deskCup.position.set(spot.x, spot.y);
      this.deskCup.zIndex = spot.y;
    }
  }

  /** 显示/隐藏 avatar 手里的杯子（端去/端回咖啡馆时）。 */
  setCarryingCup(carrying: boolean): void {
    this.carryingCup = carrying;
  }

  /** 把端着的杯子放到桌上 / 再拿起来。没有放置点时无操作。 */
  setCupOnDesk(on: boolean): void {
    if (!this.cupSpot) return;
    this.deskCupOn = on;
    this.deskCup.visible = on;
    if (on) this.drawCup(this.deskCup, 0, 0);
    else this.deskCup.clear();
  }

  hasCupOnDesk(): boolean {
    return this.deskCupOn;
  }

  isCarryingCup(): boolean {
    return this.carryingCup;
  }

  // ── 浇水 ───────────────────────────────────────────────────────────────

  /** 给 avatar 面前的那盆植物浇水：手持喷壶 + 持续 `seconds` 的
   *  稳定水滴弧线，然后触发 `onDone`（恢复游荡等）。 */
  startWatering(seconds: number, onDone?: () => void): void {
    this.waterT = 0;
    this.waterDur = seconds;
    this.onWaterDone = onDone ?? null;
  }

  isWatering(): boolean {
    return this.waterT >= 0;
  }

  /** 中止进行中的浇水（来了真正的活）。回调被丢弃。 */
  stopWatering(): void {
    this.waterT = -1;
    this.onWaterDone = null;
  }

  // ── 老板的雪茄 ────────────────────────────────────────────────────────

  /** 点上雪茄持续 `seconds`：手里一根发光的烟头，烟雾袅袅
   *  飘起。纯粹的老板气质；配一扇窗户即可合理自辩。
   *  `onDone` 在抽完时触发。 */
  startSmoking(seconds: number, onDone?: () => void): void {
    this.smokeT = 0;
    this.smokeDur = seconds;
    this.onSmokeDone = onDone ?? null;
  }

  isSmoking(): boolean {
    return this.smokeT >= 0;
  }

  /** 提前掐灭雪茄（来了真正的活）。回调被丢弃。 */
  stopSmoking(): void {
    this.smokeT = -1;
    this.onSmokeDone = null;
  }

  setBaseAlpha(alpha: number): void {
    this.targetAlpha = alpha;
  }
  private targetAlpha = 1;

  private enableClick(): void {
    this.sprite.container.eventMode = 'static';
    this.sprite.container.cursor = 'pointer';
    this.sprite.container.on('pointertap', (e) => {
      e.stopPropagation();
      this.onClick?.(this.agentId);
    });
  }

  show(parent: Container): void {
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
    this.isVisible = true;
    this.sprite.setAlpha(0);
    parent.addChild(this.workGlow);
    parent.addChild(this.sprite.container);
    this.sprite.container.addChild(this.overlay);
    this.sprite.container.addChild(this.fx);
    parent.addChild(this.deskCup);
    parent.addChild(this.thoughtBubble.container);
    this.enableClick();
    this.fadeDirection = 'in';
    this.fadeDuration = 0.5;
    this.fadeElapsed = 0;
  }

  hide(delay = 0): void {
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
    const begin = () => {
      this.hideTimer = null;
      this.fadeDirection = 'out';
      this.fadeDuration = 0.6;
      this.fadeElapsed = 0;
    };
    if (delay > 0) this.hideTimer = setTimeout(begin, delay);
    else begin();
  }

  update(dt: number): void {
    if (this.fadeDirection) {
      this.fadeElapsed += dt;
      const t = Math.min(this.fadeElapsed / this.fadeDuration, 1);
      const alpha = (this.fadeDirection === 'in' ? t : 1 - t) * this.targetAlpha;
      this.sprite.setAlpha(alpha);
      if (t >= 1) {
        const reachedZero = this.fadeDirection === 'out';
        this.fadeDirection = null;
        if (reachedZero) {
          this.isVisible = false;
          this.sprite.container.parent?.removeChild(this.sprite.container);
          this.thoughtBubble.hide();
          this.thoughtBubble.container.parent?.removeChild(this.thoughtBubble.container);
          this.workGlow.parent?.removeChild(this.workGlow);
          this.deskCup.parent?.removeChild(this.deskCup);
        }
      }
    } else if (this.isVisible) {
      // 把精灵 alpha 缓动到目标值（用于幽灵变暗）
      const a = this.sprite.container.alpha;
      if (Math.abs(a - this.targetAlpha) > 0.01) {
        this.sprite.setAlpha(lerp(a, this.targetAlpha, Math.min(1, dt / 0.2)));
      }
    }

    this.thoughtBubble.update(dt);
    if (!this.isVisible) return;

    // 工作中的 agent 保持坐着；任务之间他们在办公室里游荡。
    // 欢呼、浇水或雪茄会暂停游荡，让特效原地播放。
    const heldByFx = this.cheerT >= 0 || this.waterT >= 0 || this.smokeT >= 0;
    if (this.state === 'walk') this.updateWalk(dt);
    else if (this.wandering && !heldByFx) this.updateWander(dt);
    if (this.idleLoop && !heldByFx) this.updateIdleLoop(dt);

    this.sprite.container.zIndex = this.py;
    this.thoughtBubble.setPosition(this.px, this.py);

    // 工作光晕
    const ts = this.mapRenderer.tileSize;
    this.workGlow.x = this.px;
    this.workGlow.y = this.py - ts / 2;
    this.workGlow.zIndex = this.py - 1;
    if (this.glowOn) {
      this.workGlowElapsed += dt;
      const phase = (Math.sin((this.workGlowElapsed * Math.PI) / 0.6) + 1) / 2;
      this.workGlow.alpha = (0.18 + 0.27 * phase) * this.sprite.container.alpha;
      this.workGlow.scale.set(0.95 + 0.15 * phase);
    } else {
      this.workGlow.alpha = 0;
      this.workGlowElapsed = 0;
    }

    this.updateStatusGlyph(dt);
    this.updateFx(dt);
  }

  /** 是否以坐姿停在家桌（而非咖啡座）。 */
  isSittingAtDesk(): boolean {
    if (!this.sitting) return false;
    const t = this.getTilePosition();
    return t.x === this.deskTile.x && t.y === this.deskTile.y;
  }

  // ── 特效渲染（欢呼彩纸、手持杯子、浇水、杯上蒸汽）────────────────

  /** 手持杯子相对脚锚点的偏移，按朝向分。 */
  private carryOffset(): { x: number; y: number } {
    switch (this.direction) {
      case 'left':  return { x: -7, y: -9 };
      case 'right': return { x: 7, y: -9 };
      case 'up':    return { x: -5, y: -10 };
      default:      return { x: 5, y: -9 };
    }
  }

  /** 浇水时手的位置，按朝向分。 */
  private handOffset(): { x: number; y: number } {
    switch (this.direction) {
      case 'left':  return { x: -6, y: -9 };
      case 'right': return { x: 6, y: -9 };
      case 'up':    return { x: 0, y: -13 };
      default:      return { x: 0, y: -6 };
    }
  }

  private drawCup(g: Graphics, x: number, y: number): void {
    paintCup(g, x, y);
  }

  private steamT = 0;

  private updateFx(dt: number): void {
    this.steamT += dt;

    // ── 桌上杯子（世界锚定，agent 游荡时也持续存在）───────────────
    if (this.deskCupOn && this.cupSpot) {
      this.deskCup.clear();
      this.drawCup(this.deskCup, 0, 0);
      // 两缕错开的蒸汽像素，向上飘并淡出
      for (let i = 0; i < 2; i++) {
        const ph = (this.steamT * 0.7 + i * 0.5) % 1;
        this.deskCup.rect(1 + i * 2, -5 - Math.round(ph * 5), 1, 1)
          .fill({ color: 0xffffff, alpha: 0.5 * (1 - ph) });
      }
    }

    // ── 跟随精灵的特效 ──────────────────────────────────────────────────
    const active = this.cheerT >= 0 || this.waterT >= 0 || this.smokeT >= 0 || this.carryingCup;
    if (!active) {
      if (this.fxDirty) { this.fx.clear(); this.fxDirty = false; }
      return;
    }
    this.fx.clear();
    this.fxDirty = true;

    // 欢呼：快乐的蹦跳 + 一阵彩纸，约 1.6 秒，然后回到
    // avatar 原本在做的事（期间移动被按住——见 update()）。
    if (this.cheerT >= 0) {
      this.cheerT += dt;
      const t = this.cheerT;
      if (t >= 1.6) {
        this.cheerT = -1;
        this.sprite.setPosition(this.px, this.py); // 落定最后一跳
      } else {
        const decay = 1 - t / 1.6;
        const hop = Math.abs(Math.sin(t * Math.PI * 2.2)) * 5 * decay;
        this.sprite.setPosition(this.px, this.py - hop);
        for (const p of this.confetti) {
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.vy += 110 * dt;
          const alpha = Math.max(0, Math.min(1, (1.45 - t) / 0.5));
          this.fx.rect(Math.round(p.x), Math.round(p.y), 2, 2).fill({ color: p.c, alpha });
        }
      }
    }

    // 手持杯子，在朝向侧的手里（+ 蒸汽）。
    if (this.carryingCup) {
      const o = this.carryOffset();
      this.drawCup(this.fx, o.x, o.y);
      const ph = (this.steamT * 0.9) % 1;
      this.fx.rect(o.x + 2, o.y - 5 - Math.round(ph * 4), 1, 1)
        .fill({ color: 0xffffff, alpha: 0.5 * (1 - ph) });
    }

    // 雪茄：手里一根烟头带发光的余烬，烟圈升起、
    // 一边飘一边淡出。纯粹的老板气质。
    if (this.smokeT >= 0) {
      this.smokeT += dt;
      if (this.smokeT >= this.smokeDur) {
        this.smokeT = -1;
        const cb = this.onSmokeDone;
        this.onSmokeDone = null;
        cb?.();
      } else {
        const h = this.handOffset();
        const dirX = this.direction === 'left' ? -1 : this.direction === 'right' ? 1 : 0;
        const tipX = h.x + (dirX >= 0 ? 4 : -4);
        // 烟身 + 烟箍 + 烟头处脉冲发光的余烬
        this.fx.rect(Math.min(h.x, tipX), h.y - 1, 4, 1).fill(0x6b4a33);
        this.fx.rect(h.x + (dirX >= 0 ? 1 : -2), h.y - 1, 1, 1).fill(0xd9a04a);
        const ember = 0.5 + 0.5 * Math.sin(this.smokeT * 5);
        this.fx.rect(tipX, h.y - 1, 1, 1).fill({ color: 0xff7a3c, alpha: 0.55 + 0.45 * ember });
        // 三缕错开的烟圈从烟头升起，一边飘一边淡出
        for (let i = 0; i < 3; i++) {
          const ph = (this.smokeT * 0.45 + i / 3) % 1;
          const px2 = tipX + Math.sin((this.smokeT + i * 2) * 1.7) * 2 + ph * 2 * (dirX || 1);
          const py2 = h.y - 3 - ph * 12;
          this.fx.circle(px2, py2, 1 + ph * 1.5)
            .fill({ color: 0xcfcad4, alpha: 0.45 * (1 - ph) });
        }
      }
    }

    // 浇水：手里一个小喷壶，一串水滴弧线落在
    // 面前的植物上，直到时长耗尽 → onDone（恢复空闲）。
    if (this.waterT >= 0) {
      this.waterT += dt;
      if (this.waterT >= this.waterDur) {
        this.waterT = -1;
        const cb = this.onWaterDone;
        this.onWaterDone = null;
        cb?.();
      } else {
        const h = this.handOffset();
        const dirX = this.direction === 'left' ? -1 : this.direction === 'right' ? 1 : 0;
        const dirY = this.direction === 'up' ? -1 : this.direction === 'down' ? 1 : 0;
        // 壶身 + 壶嘴朝植物
        this.fx.rect(h.x - 2, h.y - 2, 5, 3).fill(0x9aa7b0);
        this.fx.rect(h.x + (dirX >= 0 ? 3 : -4), h.y - 2, 2, 1).fill(0x9aa7b0);
        for (let i = 0; i < 4; i++) {
          const ph = (this.waterT * 1.3 + i / 4) % 1;
          const reach = 4 + ph * 7;
          const dx = dirX !== 0 ? reach * dirX : (i - 1.5) * 1.5;
          const dy = dirY !== 0 ? reach * dirY : 0;
          const fall = ph * ph * 9;
          this.fx.rect(Math.round(h.x + dx), Math.round(h.y + dy + fall - 2), 1, 2)
            .fill({ color: 0x5bb7e8, alpha: 1 - ph * 0.45 });
        }
      }
    }
  }

  private updateStatusGlyph(dt: number): void {
    if (this.statusGlyph === 'none') return;
    this.glyphElapsed += dt;
    const g = this.overlay;
    g.clear();
    const yTop = -34; // 刚好在 32px 精灵上方
    if (this.statusGlyph === 'blocked') {
      // 脉冲“!”——约 2.5Hz 闪烁
      if (Math.floor(this.glyphElapsed / 0.4) % 2 === 0) {
        g.rect(-1, yTop, 2, 5).fill(0xff6b6b);
        g.rect(-1, yTop + 6, 2, 2).fill(0xff6b6b);
      }
    } else if (this.statusGlyph === 'success') {
      // 短暂的四点闪光，0.9 秒后自动清除
      const p = (Math.sin(this.glyphElapsed * 18) + 1) / 2;
      const s = 2 + p * 2;
      g.rect(-0.5, yTop - s, 1, s * 2).fill(0xffd93d);
      g.rect(-s, yTop - 0.5, s * 2, 1).fill(0xffd93d);
      if (this.glyphElapsed > 0.9) this.setStatusGlyph('none');
    } else if (this.statusGlyph === 'compacting') {
      // #5C — 紫色方块，节奏性地“打包压实”（把上下文装箱）。
      const p = (Math.sin(this.glyphElapsed * 6) + 1) / 2; // 0..1
      const s = 2 + p * 3;
      g.rect(-s, yTop - s, s * 2, s * 2).fill(0x9b7ede);
    } else if (this.statusGlyph === 'looping') {
      // #5C — 橙色四点警告环，一个亮点绕环旋转。
      const idx = Math.floor(this.glyphElapsed * 8) % 4;
      const pts: [number, number][] = [[-3, yTop - 3], [3, yTop - 3], [3, yTop + 3], [-3, yTop + 3]];
      for (let i = 0; i < 4; i++) {
        const [x, y] = pts[i];
        g.rect(x - 1, y - 1, 2, 2).fill(i === idx ? 0xff9f43 : 0x6b5878);
      }
    }
  }

  private updateWalk(dt: number): void {
    if (this.path.length === 0) {
      if (this.pendingSit) {
        this.applySit();
      } else if (this.pendingWork) {
        this.state = this.pendingWork;
        this.pendingWork = null;
        this.sprite.setAnimation(this.state as AnimState, this.seatDirection);
      } else if (this.wandering) {
        // 到达一个游荡路点——停一下，发呆，之后另挑一个。
        this.state = 'idle';
        this.idleTimer = 0;
        this.idleWanderDelay = 1 + Math.random() * 3;
        this.sprite.setAnimation('idle', this.direction);
      } else {
        this.setIdle();
      }
      if (this.arrivalCallback) {
        const cb = this.arrivalCallback;
        this.arrivalCallback = null;
        cb();
      }
      return;
    }

    const target = this.path[0];
    const ts = this.mapRenderer.tileSize;
    const targetPx = target.x * ts + ts / 2;
    const targetPy = target.y * ts + ts;
    const dx = targetPx - this.px;
    const dy = targetPy - this.py;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 1) {
      this.px = targetPx;
      this.py = targetPy;
      this.path.shift();
      return;
    }

    const step = Math.min(SPEED * dt, dist);
    this.px += (dx / dist) * step;
    this.py += (dy / dist) * step;
    this.direction = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    this.sprite.setAnimation('walk', this.direction);
    this.sprite.setPosition(this.px, this.py);
  }

  /** 驱动空闲 30/30 循环：在地板上闲逛，然后在桌前休息，
   *  再闲逛——独立于底层的走/游荡动画。 */
  private updateIdleLoop(dt: number): void {
    switch (this.idleLoopPhase) {
      case 'linger':
        // 游荡（beginWander）负责动作；我们只计算阶段时长。
        this.idleLoopTimer += dt;
        if (this.idleLoopTimer >= IDLE_LINGER_SECONDS) {
          this.idleLoopPhase = 'toDesk';
          this.idleLoopTimer = 0;
          this.walkToDeskAndSit(false); // 回桌并坐下（无专注光晕）
        }
        break;
      case 'toDesk':
        // 等到真正到达并坐下，再开始休息计时。看门狗：
        // 如果桌子不知何故不可达，恢复闲逛。
        this.idleLoopTimer += dt;
        if (this.sitting) {
          this.idleLoopPhase = 'resting';
          this.idleLoopTimer = 0;
        } else if (this.idleLoopTimer >= 20) {
          this.idleLoopPhase = 'linger';
          this.idleLoopTimer = 0;
          this.beginWander();
        }
        break;
      case 'resting':
        this.idleLoopTimer += dt;
        if (this.idleLoopTimer >= DESK_REST_SECONDS) {
          this.idleLoopPhase = 'linger';
          this.idleLoopTimer = 0;
          this.beginWander(); // 站起来再游荡
        }
        break;
    }
  }

  private updateWander(dt: number): void {
    this.idleTimer += dt;
    if (this.idleTimer < this.idleWanderDelay) return;
    this.idleTimer = 0;
    this.idleWanderDelay = 1 + Math.random() * 3;
    // 挑一块附近可行的瓦片溜达过去。
    const cur = this.getTilePosition();
    const range = 6;
    for (let attempt = 0; attempt < 14; attempt++) {
      const tx = cur.x + Math.floor(Math.random() * range * 2) - range;
      const ty = cur.y + Math.floor(Math.random() * range * 2) - range;
      if ((tx !== cur.x || ty !== cur.y) && this.mapRenderer.isWalkable(tx, ty)) {
        const wasWandering = this.wandering;
        this.moveTo({ x: tx, y: ty });   // moveTo() 会把 state 设为 'walk'
        this.wandering = wasWandering;   // 走路过程中保持游荡
        return;
      }
    }
  }

  destroy(): void {
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
    this.thoughtBubble.destroy();
    this.sprite.destroy();
    this.workGlow.destroy();
    this.overlay.destroy();
    this.fx.destroy();
    this.deskCup.parent?.removeChild(this.deskCup);
    this.deskCup.destroy();
  }
}

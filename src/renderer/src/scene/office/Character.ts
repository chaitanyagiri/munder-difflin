import { Container, Graphics, Texture } from 'pixi.js';
import { CharacterSprite, type Direction, type AnimState } from './CharacterSprite';
import { findPath } from './pathfinding';
import type { TiledMapRenderer } from './TiledMapRenderer';
import { ThoughtBubble } from './ThoughtBubble';

// Adapted from shahar061/the-office (office/characters/Character.ts).
// Differences: keyed by our dynamic agentId (not a fixed role); seat tile +
// glow color are injected (we seat agents from a pool); CSS-theme halo pulse
// replaced with constants; added blocked "!" + success sparkle overlays to
// cover our status model.

export type CharacterAnimation = 'idle' | 'walk' | 'type' | 'read';
export type StatusGlyph = 'none' | 'blocked' | 'success' | 'compacting' | 'looping';

function lerp(a: number, b: number, t: number): number {
  const tt = Math.min(Math.max(t, 0), 1);
  return a + (b - a) * tt;
}

/** A tiny coffee mug (white body, yellow stripe, handle) at (x, y) = its
 *  bottom-left. Same silhouette as the mug the tileset used to bake onto
 *  every desk — now it only exists where an agent actually put one down.
 *  Shared with the scene (the clean-cup sideboard renders its stock with it). */
export function paintCup(g: Graphics, x: number, y: number): void {
  g.rect(x, y - 4, 5, 4).fill(0xf2ede2);
  g.rect(x, y - 2, 5, 1).fill(0xe8c14d);
  g.rect(x + 5, y - 3, 1, 2).fill(0xd9d2c4);
  g.rect(x, y - 4, 5, 1).fill(0xffffff);
}

const SPEED = 48; // pixels/sec (tileSize=16)
// Slide the sprite when seated so it reads as "sitting on the chair" rather than
// standing on the tile. The chair tile holds the chair/barrel, with the desk in
// the tile the agent faces. The feet are anchored at the seat tile's bottom and
// the body is ~2 tiles tall, so without a nudge the head overshoots past the far
// desk edge and the chair below looks empty. We push the body toward the viewer
// (down, for up/side seats; the desk is behind them) so the head settles at the
// monitor and the torso rests on the chair. Down-facing agents (desk in front)
// are pushed into the desk instead.
const SIT_OFFSET = 5;
const SIT_OFFSET_DOWN = 12;
const SIT_OFFSET_UP = 5;   // up-facing: drop the body down onto the chair
const SIT_OFFSET_SIDE = 4; // left/right: a smaller drop plus the sideways tuck
// Pixels cropped off the bottom of the 32px sprite while seated. Up/side seats
// trim just the feet so most of the torso shows and fills the chair seat; the
// down-facing crop is larger so the legs tuck under the desk in front.
const SEAT_LEG_CROP = 8;
const SEAT_BACK_CROP = 2;

// Idle 30/30 loop: between tasks an agent alternates roaming the floor with
// resting at its own desk — for every IDLE_LINGER_SECONDS it spends lingering it
// then sits at its desk for DESK_REST_SECONDS, and repeats. Working agents skip
// this entirely (they stay seated via sitAtDesk).
const IDLE_LINGER_SECONDS = 30;
const DESK_REST_SECONDS = 30;

interface CharacterOptions {
  agentId: string;
  mapRenderer: TiledMapRenderer;
  frames: Texture[][];
  seatTile: { x: number; y: number };
  /** Where the avatar first appears (the office door). Defaults to seatTile. */
  spawnTile?: { x: number; y: number };
  glowColor: number;
  /** Direction faced while seated. Default 'down' so the face is toward the user. */
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
  // Idle 30/30 loop state (see constants above). Active only between tasks.
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

  // ── Office-life effects (cheer / coffee / watering) ────────────────────────
  /** Effect layer riding on the sprite: confetti, the carried cup, droplets. */
  private fx: Graphics;
  private fxDirty = false;            // fx drew last frame → needs a clear when idle
  private cheerT = -1;                // -1 = not cheering
  private confetti: Array<{ x: number; y: number; vx: number; vy: number; c: number }> = [];
  private carryingCup = false;
  /** The cup parked on this agent's desk (world-positioned, lives in the char
   *  layer so it survives the agent walking away). */
  private deskCup: Graphics;
  private deskCupOn = false;
  private cupSpot: { x: number; y: number } | null = null;
  private waterT = -1;                // -1 = not watering
  private waterDur = 0;
  private onWaterDone: (() => void) | null = null;

  constructor(options: CharacterOptions) {
    this.agentId = options.agentId;
    this.mapRenderer = options.mapRenderer;
    this.sprite = new CharacterSprite(options.frames);
    this.deskTile = options.seatTile;
    this.seatDirection = options.seatDirection ?? 'down';
    this.onClick = options.onClick;

    // Appear at the spawn tile (the door) and walk in from there.
    const start = options.spawnTile ?? this.deskTile;
    const pos = this.mapRenderer.tileToPixel(start.x, start.y);
    this.px = pos.x + this.mapRenderer.tileSize / 2;
    this.py = pos.y + this.mapRenderer.tileSize;
    this.sprite.setPosition(this.px, this.py);

    this.thoughtBubble = new ThoughtBubble();

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
      this.sitting = false; // stand up before walking (clears the sit offset)
      this.sprite.setSeatedCrop(0); // show legs again while standing/walking
      this.path = path;
      this.state = 'walk';
      this.sprite.setAnimation('walk', this.direction);
    }
  }

  walkToAndThen(tile: { x: number; y: number }, callback: () => void): void {
    this.idleLoop = false; // a directed walk-and-do (e.g. a café break) owns the avatar
    this.arrivalCallback = callback;
    this.moveTo(tile);
    if (this.state !== 'walk') {
      // No path produced. If we're already on the tile, fire the callback now;
      // otherwise it's unreachable — drop it so we don't "arrive" somewhere else.
      this.arrivalCallback = null;
      const t = this.getTilePosition();
      if (t.x === tile.x && t.y === tile.y) callback();
    }
  }

  /** Sit at the assigned desk, facing the monitor. Walks there first if away.
   *  `working` toggles the pulsing focus halo. This is the default pose — agents
   *  stay seated unless blocked. */
  sitAtDesk(working: boolean): void {
    this.idleLoop = false;     // an explicit desk command ends the idle loop
    this.walkToDeskAndSit(working);
  }

  /** Walk to the home desk (if away) and sit. `working` toggles the focus halo.
   *  Shared by sitAtDesk (real work/wait) and the idle-loop rest. */
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
      this.moveTo(this.deskTile); // updateWalk() sits on arrival
    }
  }

  /** Snap into the seated pose at the current (desk) tile. */
  private applySit(): void {
    this.applySitPose(this.seatDirection);
  }

  /** Snap into a seated pose facing `dir` at the current tile. Shared by the
   *  home desk (applySit) and any café seat (sitInPlace). */
  private applySitPose(dir: Direction): void {
    this.state = 'idle';
    this.pendingWork = null;
    this.pendingSit = false;
    this.path = [];
    this.sitting = true;
    this.direction = dir;
    this.sprite.setAnimation('idle', dir);
    // Slide toward the desk so the agent tucks in instead of floating in the
    // aisle, then crop the legs so they read as seated (no standing legs).
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

  /** Sit on a café seat at the CURRENT tile, facing `dir`. The agent must have
   *  already walked onto the seat tile (drive this from walkToAndThen). Unlike
   *  sitAtDesk this leaves the agent's home desk untouched and never lights the
   *  focus halo — it's a break, not work. */
  sitInPlace(dir: Direction): void {
    this.idleLoop = false;
    this.wandering = false;
    this.glowOn = false;
    this.arrivalCallback = null;
    this.applySitPose(dir);
  }

  /** True while the avatar is parked in a seated pose (desk or café). */
  isSitting(): boolean {
    return this.sitting;
  }

  /** Turn a standing/idle avatar to face `dir` (e.g. toward the coffee machine
   *  while taking a standing break). No-op mid-walk or while seated. */
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

  /** Roam the office between tasks. Picks random walkable tiles and strolls
   *  to them until the agent is given work again. */
  startWandering(): void {
    if (this.idleLoop && this.wandering) return; // already in the linger phase
    // (Re)enter the idle loop at its linger phase, then begin roaming.
    this.idleLoop = true;
    this.idleLoopPhase = 'linger';
    this.idleLoopTimer = 0;
    this.beginWander();
  }

  /** Low-level: start roaming the floor now. Drives the linger phase of the
   *  idle loop (and is reused when a rest ends). Does not touch the loop state. */
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
      this.sprite.setPosition(this.px, this.py); // clear any sit offset
    }
  }

  /** Walk to an arbitrary tile (e.g. the waiting area when blocked); stands on arrival. */
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

  /** Show what the agent is doing right now in the thought cloud above its head.
   *  Empty text renders an animated "…" (thinking); `tool` adds a small glyph. */
  showThought(text: string, tool?: string): void {
    this.thoughtBubble.show(text, tool);
  }

  /** Fade the thought cloud out after a short linger — the agent went quiet. */
  hideThought(): void {
    this.thoughtBubble.startLinger();
  }

  /** The thought cloud's current base screen rect (no lift), or null if hidden.
   *  The scene uses this to detect and resolve overlapping bubbles. */
  getThoughtLayout(): { x: number; y: number; w: number; h: number } | null {
    return this.thoughtBubble.getLayout(this.px, this.py);
  }

  /** Shift this avatar's thought cloud up by `px` so it clears a nearby one. */
  setThoughtLift(px: number): void {
    this.thoughtBubble.setLift(px);
  }

  /** Forward the camera zoom so the thought cloud can counter-scale and keep
   *  its on-screen text size when the window (and thus the world) shrinks. */
  setBubbleZoom(z: number): void {
    this.thoughtBubble.setZoom(z);
  }

  setStatusGlyph(glyph: StatusGlyph): void {
    if (glyph === this.statusGlyph) return;
    this.statusGlyph = glyph;
    this.glyphElapsed = 0;
    if (glyph === 'none') this.overlay.clear();
  }

  // ── Cheer ──────────────────────────────────────────────────────────────────

  /** Celebrate finished work: a couple of happy hops under a confetti burst.
   *  Movement (wander / idle loop) is held for the duration so the jump reads
   *  on the spot; whatever the avatar was told to do resumes right after. */
  cheer(): void {
    if (this.sitting) return; // seated cheer would fight the sit offset/crop
    // Stop in place so the hops read on the spot; roaming resumes right after.
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

  /** True while the cheer animation holds the avatar in place. */
  isCheering(): boolean {
    return this.cheerT >= 0;
  }

  // ── Coffee cup ─────────────────────────────────────────────────────────────

  /** Where this agent's cup rests when parked on its desk (world pixels).
   *  Typically beside the monitor — where the old baked-in tileset mug sat. */
  setCupSpot(spot: { x: number; y: number } | null): void {
    this.cupSpot = spot;
    if (spot) {
      this.deskCup.position.set(spot.x, spot.y);
      this.deskCup.zIndex = spot.y;
    }
  }

  /** Show/hide the cup in the avatar's hand (walking it to/from the café). */
  setCarryingCup(carrying: boolean): void {
    this.carryingCup = carrying;
  }

  /** Park the carried cup on the desk / pick it back up. No-op without a spot. */
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

  // ── Watering ───────────────────────────────────────────────────────────────

  /** Water the plant the avatar is facing: a held watering can + a steady arc
   *  of droplets for `seconds`, then `onDone` (resume wandering etc.). */
  startWatering(seconds: number, onDone?: () => void): void {
    this.waterT = 0;
    this.waterDur = seconds;
    this.onWaterDone = onDone ?? null;
  }

  isWatering(): boolean {
    return this.waterT >= 0;
  }

  /** Abort a watering in progress (real work arrived). The callback is dropped. */
  stopWatering(): void {
    this.waterT = -1;
    this.onWaterDone = null;
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
      // ease sprite alpha toward target (for ghost dimming)
      const a = this.sprite.container.alpha;
      if (Math.abs(a - this.targetAlpha) > 0.01) {
        this.sprite.setAlpha(lerp(a, this.targetAlpha, Math.min(1, dt / 0.2)));
      }
    }

    this.thoughtBubble.update(dt);
    if (!this.isVisible) return;

    // Working agents stay seated; between tasks they wander the office.
    // A cheer or a watering holds roaming so the effect plays out in place.
    const heldByFx = this.cheerT >= 0 || this.waterT >= 0;
    if (this.state === 'walk') this.updateWalk(dt);
    else if (this.wandering && !heldByFx) this.updateWander(dt);
    if (this.idleLoop && !heldByFx) this.updateIdleLoop(dt);

    this.sprite.container.zIndex = this.py;
    this.thoughtBubble.setPosition(this.px, this.py);

    // work glow
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

  /** True while parked in the seated pose at the HOME desk (not a café seat). */
  isSittingAtDesk(): boolean {
    if (!this.sitting) return false;
    const t = this.getTilePosition();
    return t.x === this.deskTile.x && t.y === this.deskTile.y;
  }

  // ── Effect rendering (cheer confetti, carried cup, watering, cup steam) ────

  /** Carried-cup offset from the feet anchor, per facing direction. */
  private carryOffset(): { x: number; y: number } {
    switch (this.direction) {
      case 'left':  return { x: -7, y: -9 };
      case 'right': return { x: 7, y: -9 };
      case 'up':    return { x: -5, y: -10 };
      default:      return { x: 5, y: -9 };
    }
  }

  /** Hand position while watering, per facing direction. */
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

    // ── Desk cup (world-anchored, persists while the agent roams) ───────────
    if (this.deskCupOn && this.cupSpot) {
      this.deskCup.clear();
      this.drawCup(this.deskCup, 0, 0);
      // two staggered steam pixels drifting up and fading
      for (let i = 0; i < 2; i++) {
        const ph = (this.steamT * 0.7 + i * 0.5) % 1;
        this.deskCup.rect(1 + i * 2, -5 - Math.round(ph * 5), 1, 1)
          .fill({ color: 0xffffff, alpha: 0.5 * (1 - ph) });
      }
    }

    // ── Sprite-riding effects ────────────────────────────────────────────────
    const active = this.cheerT >= 0 || this.waterT >= 0 || this.carryingCup;
    if (!active) {
      if (this.fxDirty) { this.fx.clear(); this.fxDirty = false; }
      return;
    }
    this.fx.clear();
    this.fxDirty = true;

    // Cheer: happy hops + a confetti burst, ~1.6s, then back to whatever the
    // avatar was doing (movement is held meanwhile — see update()).
    if (this.cheerT >= 0) {
      this.cheerT += dt;
      const t = this.cheerT;
      if (t >= 1.6) {
        this.cheerT = -1;
        this.sprite.setPosition(this.px, this.py); // land the final hop
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

    // Carried cup, riding in the hand on the facing side (+ steam).
    if (this.carryingCup) {
      const o = this.carryOffset();
      this.drawCup(this.fx, o.x, o.y);
      const ph = (this.steamT * 0.9) % 1;
      this.fx.rect(o.x + 2, o.y - 5 - Math.round(ph * 4), 1, 1)
        .fill({ color: 0xffffff, alpha: 0.5 * (1 - ph) });
    }

    // Watering: a little can in the hand and an arc of droplets falling onto
    // the plant in front, until the duration elapses → onDone (resume idling).
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
        // can body + spout toward the plant
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
    const yTop = -34; // just above the 32px sprite
    if (this.statusGlyph === 'blocked') {
      // pulsing "!" — blink ~2.5Hz
      if (Math.floor(this.glyphElapsed / 0.4) % 2 === 0) {
        g.rect(-1, yTop, 2, 5).fill(0xff6b6b);
        g.rect(-1, yTop + 6, 2, 2).fill(0xff6b6b);
      }
    } else if (this.statusGlyph === 'success') {
      // brief 4-point sparkle, auto-clears after 0.9s
      const p = (Math.sin(this.glyphElapsed * 18) + 1) / 2;
      const s = 2 + p * 2;
      g.rect(-0.5, yTop - s, 1, s * 2).fill(0xffd93d);
      g.rect(-s, yTop - 0.5, s * 2, 1).fill(0xffd93d);
      if (this.glyphElapsed > 0.9) this.setStatusGlyph('none');
    } else if (this.statusGlyph === 'compacting') {
      // #5C — violet box that rhythmically "packs down" (boxing up context).
      const p = (Math.sin(this.glyphElapsed * 6) + 1) / 2; // 0..1
      const s = 2 + p * 3;
      g.rect(-s, yTop - s, s * 2, s * 2).fill(0x9b7ede);
    } else if (this.statusGlyph === 'looping') {
      // #5C — orange 4-dot warning ring with one lit dot spinning around it.
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
        // Reached a wander waypoint — pause, idle, then pick another later.
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

  /** Drive the idle 30/30 loop: linger on the floor, then rest at the desk,
   *  then linger again — independent of the low-level walk/wander animation. */
  private updateIdleLoop(dt: number): void {
    switch (this.idleLoopPhase) {
      case 'linger':
        // Roaming (beginWander) handles the motion; we just time the phase.
        this.idleLoopTimer += dt;
        if (this.idleLoopTimer >= IDLE_LINGER_SECONDS) {
          this.idleLoopPhase = 'toDesk';
          this.idleLoopTimer = 0;
          this.walkToDeskAndSit(false); // head home and sit (no focus halo)
        }
        break;
      case 'toDesk':
        // Wait until we've actually arrived and sat down, then start the rest
        // clock. Watchdog: if the desk is somehow unreachable, resume lingering.
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
          this.beginWander(); // stand up and roam again
        }
        break;
    }
  }

  private updateWander(dt: number): void {
    this.idleTimer += dt;
    if (this.idleTimer < this.idleWanderDelay) return;
    this.idleTimer = 0;
    this.idleWanderDelay = 1 + Math.random() * 3;
    // Pick a nearby walkable tile and stroll to it.
    const cur = this.getTilePosition();
    const range = 6;
    for (let attempt = 0; attempt < 14; attempt++) {
      const tx = cur.x + Math.floor(Math.random() * range * 2) - range;
      const ty = cur.y + Math.floor(Math.random() * range * 2) - range;
      if ((tx !== cur.x || ty !== cur.y) && this.mapRenderer.isWalkable(tx, ty)) {
        const wasWandering = this.wandering;
        this.moveTo({ x: tx, y: ty });   // moveTo() leaves state='walk'
        this.wandering = wasWandering;   // keep wandering through the walk
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

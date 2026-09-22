import { AnimatedSprite, Container, Graphics, Texture, type Ticker } from 'pixi.js';

export type Direction = 'down' | 'up' | 'right' | 'left';
export type AnimState = 'walk' | 'type' | 'read' | 'idle';

// Output rows from SpriteAdapter: down=0, up=1, right=2 (left = flipped right)
const DIRECTION_ROW: Record<Direction, number> = {
  down: 0,
  up: 1,
  right: 2,
  left: 2,
};

const ANIM_FRAMES: Record<AnimState, number[]> = {
  walk: [0, 1, 2, 1],
  type: [0, 1, 2, 1],
  read: [0, 1, 2, 1],
  idle: [0],
};

// Render characters a bit larger than their native 18×32 so heads/faces read
// clearly on the floor. Applied to the container so the leg-crop mask (a child)
// scales with the sprite and stays aligned.
const CHAR_SCALE = 1.08;

/** Ported from shahar061/the-office (office/characters/CharacterSprite.ts). */
export class CharacterSprite {
  readonly container: Container;
  private sprite: AnimatedSprite;
  private frames: Texture[][];
  private currentDirection: Direction = 'down';
  private currentAnim: AnimState = 'idle';
  private frameSpeed = 0.15;
  private frameW: number;
  private frameH: number;
  private cropMask: Graphics | null = null;

  constructor(frames: Texture[][]) {
    this.frames = frames;
    this.container = new Container();

    const initialFrames = this.getFrames('down', 'idle');
    this.sprite = new AnimatedSprite(initialFrames);
    this.sprite.anchor.set(0.5, 1);
    this.sprite.animationSpeed = this.frameSpeed;
    // Pixi's AnimatedSprite defaults to autoUpdate, which subscribes it to
    // Ticker.shared — a SECOND requestAnimationFrame loop, running at the display's
    // full rate whatever the floor's own ticker is capped to, and still running
    // while the floor is paused behind a fullscreen terminal or the IDE. On a floor
    // of twenty agents that is twenty sprite updates 120 times a second producing
    // texture swaps the renderer never draws. Drive it from the scene's own tick
    // instead, so the walk cycle shares one clock with everything else: capped with
    // the floor, and stopped with it.
    this.sprite.autoUpdate = false;
    this.sprite.play();
    // Anchor is (0.5, 1): in container space the sprite spans x∈[-w/2, w/2],
    // y∈[-h, 0] (feet at the origin). Used by the seated leg-crop mask.
    this.frameW = this.sprite.texture.frame.width || this.sprite.width || 16;
    this.frameH = this.sprite.texture.frame.height || this.sprite.height || 32;

    this.container.addChild(this.sprite);
    this.container.scale.set(CHAR_SCALE);
  }

  /**
   * Crop `cropPx` off the bottom of the sprite (the legs) so a seated agent
   * reads as tucked under the desk instead of standing on top of it. Pass 0 to
   * clear the crop (standing / walking). The mask only covers the sprite, so
   * status glyphs / bubbles parented elsewhere are unaffected.
   */
  setSeatedCrop(cropPx: number): void {
    if (cropPx <= 0) {
      if (this.cropMask) {
        this.sprite.mask = null;
        this.cropMask.visible = false;
      }
      return;
    }
    if (!this.cropMask) {
      this.cropMask = new Graphics();
      this.container.addChild(this.cropMask);
    }
    const w = this.frameW;
    const h = this.frameH;
    this.cropMask.clear();
    // Keep the top (h - cropPx) of the sprite; reveal whatever (the desk) is
    // behind where the legs were.
    this.cropMask
      .rect(-w / 2 - 2, -h - 2, w + 4, h - cropPx + 2)
      .fill(0xffffff);
    this.cropMask.visible = true;
    this.sprite.mask = this.cropMask;
  }

  /** Advance the walk/idle cycle by `dt` seconds.
   *
   *  AnimatedSprite.update() reads exactly one field off what it is handed —
   *  `deltaTime`, in 60 Hz frames — so a reused scratch object drives it without
   *  allocating per character per frame or owning a second Ticker. */
  advance(dt: number): void {
    CharacterSprite.beat.deltaTime = dt * 60;
    this.sprite.update(CharacterSprite.beat);
  }

  private static readonly beat = { deltaTime: 0 } as unknown as Ticker;

  private getFrames(direction: Direction, anim: AnimState): Texture[] {
    const row = DIRECTION_ROW[direction];
    return ANIM_FRAMES[anim].map((col) => this.frames[row][col]);
  }

  setAnimation(anim: AnimState, direction: Direction): void {
    if (anim === this.currentAnim && direction === this.currentDirection) return;

    this.currentAnim = anim;
    this.currentDirection = direction;

    this.sprite.textures = this.getFrames(direction, anim);
    this.sprite.scale.x = direction === 'left' ? -1 : 1;
    this.sprite.animationSpeed = anim === 'walk' ? 0.15 : anim === 'idle' ? 0.08 : 0.06;
    this.sprite.play();
  }

  setPosition(x: number, y: number): void {
    this.container.x = x;
    this.container.y = y;
  }

  setAlpha(alpha: number): void {
    this.container.alpha = alpha;
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}

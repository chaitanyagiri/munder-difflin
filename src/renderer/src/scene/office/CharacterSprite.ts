import { AnimatedSprite, Container, Graphics, Text, Texture } from 'pixi.js';
import { colors, type } from '@/design/tokens';

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
// Keep a long hire name from turning into a banner across the office floor.
const MAX_NAME_CHARS = 12;
const TAG_HEIGHT = 8;
const TAG_TEXT_Y = 5;

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
  private nametag: Text;
  private nametagBackground: Graphics;

  constructor(frames: Texture[][]) {
    this.frames = frames;
    this.container = new Container();

    const initialFrames = this.getFrames('down', 'idle');
    this.sprite = new AnimatedSprite(initialFrames);
    this.sprite.anchor.set(0.5, 1);
    this.sprite.animationSpeed = this.frameSpeed;
    this.sprite.play();
    // Anchor is (0.5, 1): in container space the sprite spans x∈[-w/2, w/2],
    // y∈[-h, 0] (feet at the origin). Used by the seated leg-crop mask.
    this.frameW = this.sprite.texture.frame.width || this.sprite.width || 16;
    this.frameH = this.sprite.texture.frame.height || this.sprite.height || 32;

    this.container.addChild(this.sprite);
    this.container.scale.set(CHAR_SCALE);

    // The nametag belongs to the sprite's own container, so it inherits the
    // avatar's movement, world scale, ghost dimming, and fade-out. It sits
    // below the feet because the space above the head belongs to the status
    // glyph and thought cloud.
    this.nametagBackground = new Graphics();
    this.nametag = new Text({
      text: '',
      style: {
        fontFamily: type.display,
        fontSize: 5,
        fill: colors.ink[900],
        align: 'center',
      },
    });
    this.nametag.resolution = 2;
    this.nametag.anchor.set(0.5, 0.5);
    this.nametag.y = TAG_TEXT_Y;
    this.nametag.eventMode = 'none';
    this.nametag.visible = false;
    this.container.addChild(this.nametagBackground, this.nametag);
    this.setName('');
  }

  /** Show the agent's display name under its feet. */
  setName(name: string): void {
    const trimmed = name.trim();
    const display = trimmed.length > MAX_NAME_CHARS
      ? trimmed.slice(0, MAX_NAME_CHARS - 1) + '…'
      : trimmed;
    if (display === this.nametag.text) return;
    this.nametag.text = display;
    this.nametag.visible = display.length > 0;
    this.layoutNametag();
  }

  private layoutNametag(): void {
    const width = Math.ceil(this.nametag.width / 2) * 2 + 4;
    // Outer/inner rects make the border a whole pixel instead of straddling
    // the pixel grid. Keep it flush with the avatar's feet baseline.
    this.nametagBackground.clear();
    this.nametagBackground
      .rect(-(width / 2) - 1, 0, width + 2, TAG_HEIGHT + 1)
      .fill(colors.ink[900])
      .rect(-width / 2, 1, width, TAG_HEIGHT)
      .fill(colors.cream[100]);
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

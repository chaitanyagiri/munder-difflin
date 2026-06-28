import { Texture, Rectangle } from 'pixi.js';

export interface SpriteSheetConfig {
  frameWidth: number;          // pixel width of one frame (LimeZu: 16)
  frameHeight: number;         // pixel height of one frame (LimeZu: 32)
  walkRow: number;             // which 32px row holds the walk frames (LimeZu: 1)
  framesPerDirection: number;  // walk frames per direction in that row (LimeZu: 6)
}

/**
 * Brooklyn-99 sheet layout (Pam's ART CONTRACT). The license-clean B99 sheets
 * are authored DIRECTLY to the 3-row grid CharacterSprite renders — one physical
 * row per facing (down, up, right; left is the right row flipped at draw time)
 * and a fixed set of columns per row in the order CharacterSprite/cast.ts expect:
 *   [walk1, walk2, walk3, type1, type2, read1, read2]
 * Unlike the LimeZu sheets (4 facings packed into one walk row), no facing
 * remapping is needed — the rows ARE the facings.
 *
 * `rowOrder` lets the contract pin the physical top→bottom row order should Pam
 * author them differently; it defaults to the CharacterSprite order.
 */
export interface B99SheetConfig {
  /** Pixel width of one frame cell (per Pam's per-char canvas px). */
  frameWidth: number;
  /** Pixel height of one frame cell. */
  frameHeight: number;
  /** Physical row order in the sheet, top→bottom. Default ['down','up','right']. */
  rowOrder?: ReadonlyArray<'down' | 'up' | 'right'>;
  /** How many frame columns the sheet actually provides per row (≥1). The slicer
   *  samples up to 7 ([walk1..3, type1..2, read1..2]) and pads a short sheet by
   *  repeating the idle/stand frame — the same shape cast.ts emits. */
  columns: number;
}

/**
 * Maps a LimeZu character walk sheet to the 3-row frame grid CharacterSprite
 * expects. Ported from shahar061/the-office (office/characters/SpriteAdapter.ts).
 *
 * LimeZu walk row packs 4 directions, each with `framesPerDirection` frames,
 * in the order: right, up, left, down.
 *
 * Output: 3 rows (down, up, right) each with 7 frames:
 *   [walk1, walk2, walk3, type1, type2, read1, read2]
 * Left is rendered by horizontally flipping the "right" row at draw time.
 * Type/read frames reuse the idle (first walk) frame — LimeZu has no desk anims.
 */
export class SpriteAdapter {
  private static readonly DIRECTION_GROUP = { down: 3, left: 2, up: 1, right: 0 };
  private static readonly OUTPUT_DIRECTIONS: Array<'down' | 'up' | 'right'> = ['down', 'up', 'right'];

  static extractFrames(sheetTexture: Texture, config: SpriteSheetConfig): Texture[][] {
    const { frameWidth, frameHeight, walkRow, framesPerDirection } = config;
    const output: Texture[][] = [];

    for (const dir of this.OUTPUT_DIRECTIONS) {
      const frames: Texture[] = [];
      const groupStart = this.DIRECTION_GROUP[dir] * framesPerDirection;

      // 3 walk frames sampled every other frame from the cycle
      for (let i = 0; i < framesPerDirection; i += 2) {
        const frame = new Rectangle(
          (groupStart + i) * frameWidth,
          walkRow * frameHeight,
          frameWidth,
          frameHeight,
        );
        frames.push(new Texture({ source: sheetTexture.source, frame }));
      }

      while (frames.length < 3) frames.push(frames[0]);

      const idleFrame = frames[0];
      frames.push(idleFrame, idleFrame, idleFrame, idleFrame);

      output.push(frames);
    }

    return output;
  }

  /**
   * Slice a Brooklyn-99 sheet (authored to the 3-row grid, per Pam's contract)
   * into the `Texture[][]` CharacterSprite renders: 3 rows (down, up, right) ×
   * 7 frames [walk1, walk2, walk3, type1, type2, read1, read2].
   *
   * Each physical row is one facing; column c is sampled at (c·frameWidth,
   * rowIndex·frameHeight). Sheets with fewer than 7 columns are padded by
   * repeating the idle/stand frame (column 0) — identical to the shape cast.ts
   * emits, so a partial sheet still animates without out-of-range access
   * (CharacterSprite only ever indexes columns 0–2).
   */
  static extractB99Frames(sheetTexture: Texture, config: B99SheetConfig): Texture[][] {
    const { frameWidth, frameHeight, columns } = config;
    const rowOrder = config.rowOrder ?? this.OUTPUT_DIRECTIONS;
    const cols = Math.max(1, Math.floor(columns));
    const FRAMES_PER_ROW = 7; // walk1..3, type1..2, read1..2
    const output: Texture[][] = [];

    rowOrder.forEach((_dir, rowIndex) => {
      const frames: Texture[] = [];
      for (let c = 0; c < Math.min(cols, FRAMES_PER_ROW); c++) {
        const frame = new Rectangle(
          c * frameWidth,
          rowIndex * frameHeight,
          frameWidth,
          frameHeight,
        );
        frames.push(new Texture({ source: sheetTexture.source, frame }));
      }
      // Pad a short sheet up to the full 7-frame row by repeating the stand
      // frame, so [type/read] reuse the idle pose (B99 sheets may omit desk anims).
      const idleFrame = frames[0];
      while (frames.length < FRAMES_PER_ROW) frames.push(idleFrame);
      output.push(frames);
    });

    return output;
  }
}

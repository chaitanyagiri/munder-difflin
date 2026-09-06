import { Texture, Rectangle } from 'pixi.js';

export interface SpriteSheetConfig {
  frameWidth: number;          // pixel width of one frame (LimeZu: 16)
  frameHeight: number;         // pixel height of one frame (LimeZu: 32)
  walkRow: number;             // which 32px row holds the walk frames (LimeZu: 1)
  framesPerDirection: number;  // walk frames per direction in that row (LimeZu: 6)
}

/**
 * 把 LimeZu 角色行走表映射到 CharacterSprite 期望的 3 行帧网格。从
 * shahar061/the-office 移植（office/characters/SpriteAdapter.ts）。
 *
 * LimeZu 行走行打包了 4 个方向，每个方向 `framesPerDirection` 帧，
 * 顺序为：右、上、左、下。
 *
 * 输出：3 行（down、up、right），每行 7 帧：
 *   [walk1, walk2, walk3, type1, type2, read1, read2]
 * 左侧通过绘制时水平翻转“right”行渲染。
 * Type/read 帧复用 idle（第一帧 walk）帧——LimeZu 没有办公桌动画。
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

      // 从循环里每隔一帧采样 3 个行走帧
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
}

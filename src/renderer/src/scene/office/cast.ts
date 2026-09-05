// 《办公室》角色群——名单元数据 + 精灵帧。
//
// 静态肖像（卡片 / 选择器）和场景内行走精灵现在都完全按 portraitArt.ts 里
// 每个角色的配方自定义绘制：场景精灵复用肖像的精确头/脸/服装并加上腿，
// 所以办公室地板上的 agent 与它的卡片看起来一模一样。LimeZu 基础表不再
// 用于角色群。见 assets/ATTRIBUTION.md。

import { Texture } from 'pixi.js';
import { paintPortrait, sceneFrameBufs, SCENE_W, SCENE_H } from './portraitArt';

export type OfficeCharacterName =
  | 'michael' | 'jim' | 'pam' | 'dwight' | 'kevin' | 'angela'
  | 'oscar' | 'stanley' | 'phyllis' | 'andy' | 'kelly' | 'ryan'
  | 'toby' | 'creed' | 'meredith';

export interface CastMember {
  name: OfficeCharacterName;
  displayName: string;
  /** 招牌强调色（十六进制）——用于场景内的选中光晕。 */
  shirt: string;
  /** 该角色被选中 / 尚无描述时显示的一句话。 */
  blurb: string;
}

/** 可选择的角色名单，按显示顺序。 */
export const OFFICE_CAST: CastMember[] = [
  { name: 'michael',  displayName: 'Michael',  shirt: '#5a6b8c', blurb: "World's best boss" },
  { name: 'jim',      displayName: 'Jim',      shirt: '#6fa8dc', blurb: 'Salesman, prankster' },
  { name: 'pam',      displayName: 'Pam',      shirt: '#9caf88', blurb: 'Receptionist, artist' },
  { name: 'dwight',   displayName: 'Dwight',   shirt: '#b89b3e', blurb: 'Assistant (to the) RM' },
  { name: 'kevin',    displayName: 'Kevin',    shirt: '#4a7ab5', blurb: 'Accounting' },
  { name: 'angela',   displayName: 'Angela',   shirt: '#8a86a6', blurb: 'Head of accounting' },
  { name: 'oscar',    displayName: 'Oscar',    shirt: '#7a4b6b', blurb: 'Accountant' },
  { name: 'stanley',  displayName: 'Stanley',  shirt: '#8c5a4b', blurb: 'Sales, crossword' },
  { name: 'phyllis',  displayName: 'Phyllis',  shirt: '#b08bbf', blurb: 'Sales' },
  { name: 'andy',     displayName: 'Andy',     shirt: '#6fae6f', blurb: 'Cornell, a cappella' },
  { name: 'kelly',    displayName: 'Kelly',    shirt: '#d16ba5', blurb: 'Customer service' },
  { name: 'ryan',     displayName: 'Ryan',     shirt: '#3a3a44', blurb: 'The temp' },
  { name: 'toby',     displayName: 'Toby',     shirt: '#9a8c5a', blurb: 'Human resources' },
  { name: 'creed',    displayName: 'Creed',    shirt: '#6b7a4b', blurb: 'Quality assurance' },
  { name: 'meredith', displayName: 'Meredith', shirt: '#b5544a', blurb: 'Supplier relations' },
];

export const CAST_BY_NAME: Record<OfficeCharacterName, CastMember> =
  Object.fromEntries(OFFICE_CAST.map((c) => [c.name, c])) as Record<OfficeCharacterName, CastMember>;

export const DEFAULT_CHARACTER: OfficeCharacterName = 'jim';

export function hexToNumber(hex: string): number {
  return parseInt(hex.replace('#', ''), 16);
}

// ─── 场景帧 ──────────────────────────────────────────────────────────
const frameCache = new Map<OfficeCharacterName, Texture[][]>();

function bufToTexture(buf: Uint8ClampedArray): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = SCENE_W; canvas.height = SCENE_H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(SCENE_W, SCENE_H);
  img.data.set(buf);
  ctx.putImageData(img, 0, 0);
  const tex = Texture.from(canvas);
  tex.source.scaleMode = 'nearest';
  return tex;
}

/**
 * CharacterSprite 期望的帧网格：3 行（down、up、right）× 7 帧
 * [walk1, walk2, walk3, type1, type2, read1, read2]。我们提供正面视角
 * （down——并复用于侧行，所以左/右行走者仍露脸）和背面视角（up——面朝
 * 桌子坐下的 agent 显示后背）。三个行走帧是站立 / 左步 / 右步。
 */
export async function getCastFrames(name: OfficeCharacterName): Promise<Texture[][]> {
  const cached = frameCache.get(name);
  if (cached) return cached;
  const { front, back } = sceneFrameBufs(name);
  const toRow = (bufs: Uint8ClampedArray[]): Texture[] => {
    const [stand, stepL, stepR] = bufs.map(bufToTexture);
    return [stand, stepL, stepR, stand, stand, stand, stand];
  };
  const frontRow = toRow(front);
  const frames: Texture[][] = [frontRow, toRow(back), frontRow]; // down, up, right
  frameCache.set(name, frames);
  return frames;
}

/**
 * 为卡片 / 选择器绘制角色的静态肖像（委托给 portraitArt.ts 里的自定义
 * 程序化合成器）。
 */
export async function paintCastPortrait(
  ctx: CanvasRenderingContext2D,
  name: OfficeCharacterName,
  scale = 2,
): Promise<void> {
  paintPortrait(ctx, name, scale);
}

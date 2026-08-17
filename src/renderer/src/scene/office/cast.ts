// The Office cast — roster metadata + sprite frames.
//
// Both the static portraits (cards / picker) and the in-scene walking sprites are
// now fully custom-drawn from the same per-character recipes in portraitArt.ts:
// the scene sprite reuses the portrait's exact head/face/clothing and adds legs,
// so an agent on the office floor looks identical to its card. The LimeZu base
// sheets are no longer used for the cast. See assets/ATTRIBUTION.md.

import { Texture } from 'pixi.js';
import { paintPortrait, sceneFrameBufs, SCENE_W, SCENE_H } from './portraitArt';
import {
  paintPlanetExpressPortrait,
  planetExpressSceneFrameBufs,
} from './planetExpressArt';

export type OfficeCharacterName =
  | 'michael' | 'jim' | 'pam' | 'dwight' | 'kevin' | 'angela'
  | 'oscar' | 'stanley' | 'phyllis' | 'andy' | 'kelly' | 'ryan'
  | 'toby' | 'creed' | 'meredith';

export type PlanetExpressCharacterName =
  | 'professor-farnsworth' | 'leela' | 'fry' | 'bender'
  | 'hermes' | 'amy' | 'zoidberg' | 'scruffy';

export type CharacterName = OfficeCharacterName | PlanetExpressCharacterName;

export interface CastMember<Name extends string = CharacterName> {
  name: Name;
  displayName: string;
  /** Signature accent color (hex) — used for the in-scene selection glow. */
  shirt: string;
  /** Blurb shown when this character is picked / has no description yet. */
  blurb: string;
}

/** Selectable roster, in display order. */
export const OFFICE_CAST: CastMember<OfficeCharacterName>[] = [
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

export const CAST_BY_NAME: Record<OfficeCharacterName, CastMember<OfficeCharacterName>> =
  Object.fromEntries(OFFICE_CAST.map((c) => [c.name, c])) as Record<OfficeCharacterName, CastMember<OfficeCharacterName>>;

export const DEFAULT_CHARACTER: OfficeCharacterName = 'jim';

export const PLANET_EXPRESS_CAST: CastMember<PlanetExpressCharacterName>[] = [
  { name: 'professor-farnsworth', displayName: 'Professor Farnsworth', shirt: '#8cc7b5', blurb: 'Founder, inventor, occasional doomsayer' },
  { name: 'leela',                displayName: 'Leela',                shirt: '#7d5aa6', blurb: 'Captain, pilot, keeps the ship moving' },
  { name: 'fry',                  displayName: 'Fry',                  shirt: '#d85a32', blurb: 'Delivery boy, future-shocked optimist' },
  { name: 'bender',               displayName: 'Bender',               shirt: '#9fb0b8', blurb: 'Robot, bending unit, chaos consultant' },
  { name: 'hermes',               displayName: 'Hermes',               shirt: '#4b9c6b', blurb: 'Bureaucrat, operations, forms champion' },
  { name: 'amy',                  displayName: 'Amy',                  shirt: '#ef8aae', blurb: 'Engineer, intern, knows the expensive tools' },
  { name: 'zoidberg',             displayName: 'Zoidberg',             shirt: '#e37468', blurb: 'Doctor, morale event, probably hungry' },
  { name: 'scruffy',              displayName: 'Scruffy',              shirt: '#6f7f64', blurb: 'Janitor, philosopher, quietly essential' },
];

export const PLANET_EXPRESS_CAST_BY_NAME: Record<PlanetExpressCharacterName, CastMember<PlanetExpressCharacterName>> =
  Object.fromEntries(PLANET_EXPRESS_CAST.map((c) => [c.name, c])) as Record<PlanetExpressCharacterName, CastMember<PlanetExpressCharacterName>>;

export const PLANET_EXPRESS_DEFAULT_CHARACTER: PlanetExpressCharacterName = 'fry';
export const PLANET_EXPRESS_BOSS_CHARACTER: PlanetExpressCharacterName = 'professor-farnsworth';

export const ALL_CAST_BY_NAME: Record<CharacterName, CastMember<CharacterName>> = {
  ...CAST_BY_NAME,
  ...PLANET_EXPRESS_CAST_BY_NAME,
};

export function hexToNumber(hex: string): number {
  return parseInt(hex.replace('#', ''), 16);
}

// ─── scene frames ────────────────────────────────────────────────────────────
const frameCache = new Map<CharacterName, Texture[][]>();

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
 * Frame grid CharacterSprite expects: 3 rows (down, up, right) × 7 frames
 * [walk1, walk2, walk3, type1, type2, read1, read2]. We provide a front view
 * (down — and reused for the side row, so left/right walkers still show a face)
 * and a back view (up — agents seated facing their desk show their back). The
 * three walk frames are stand / step-left / step-right.
 */
function isPlanetExpressCharacter(name: string): name is PlanetExpressCharacterName {
  return Object.prototype.hasOwnProperty.call(PLANET_EXPRESS_CAST_BY_NAME, name);
}

function isOfficeCharacter(name: string): name is OfficeCharacterName {
  return Object.prototype.hasOwnProperty.call(CAST_BY_NAME, name);
}

export async function getCastFrames(name: CharacterName): Promise<Texture[][]> {
  const cached = frameCache.get(name);
  if (cached) return cached;
  const { front, back } = isPlanetExpressCharacter(name)
    ? planetExpressSceneFrameBufs(name)
    : sceneFrameBufs(isOfficeCharacter(name) ? name : DEFAULT_CHARACTER);
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
 * Paint a character's static portrait for cards / the picker (delegates to the
 * custom procedural composer in portraitArt.ts).
 */
export async function paintCastPortrait(
  ctx: CanvasRenderingContext2D,
  name: CharacterName,
  scale = 2,
): Promise<void> {
  if (isPlanetExpressCharacter(name)) paintPlanetExpressPortrait(ctx, name, scale);
  else paintPortrait(ctx, isOfficeCharacter(name) ? name : DEFAULT_CHARACTER, scale);
}

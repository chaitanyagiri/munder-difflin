// The Office cast — roster metadata + sprite frames.
//
// The built-in cast is closed (BuiltinCharacterName); the *selectable* cast is
// open. Call `registerCastMember` to add one — see it and OfficeCharacterName
// below for why the type is widened rather than the array being replaced.
//
// Both the static portraits (cards / picker) and the in-scene walking sprites are
// now fully custom-drawn from the same per-character recipes in portraitArt.ts:
// the scene sprite reuses the portrait's exact head/face/clothing and adds legs,
// so an agent on the office floor looks identical to its card. The LimeZu base
// sheets are no longer used for the cast. See assets/ATTRIBUTION.md.

import { Texture } from 'pixi.js';
import { paintPortrait, registerRecipe, sceneFrameBufs, SCENE_W, SCENE_H, type Recipe } from './portraitArt';

/** The cast that ships with the app. Closed on purpose: portraitArt's RECIPES
 *  is keyed on this, so adding a name here fails the build until its recipe
 *  exists — which is exactly the check you want for the built-ins. */
export type BuiltinCharacterName =
  | 'michael' | 'jim' | 'pam' | 'dwight' | 'kevin' | 'angela'
  | 'oscar' | 'stanley' | 'phyllis' | 'andy' | 'kelly' | 'ryan'
  | 'toby' | 'creed' | 'meredith';

/** Any character name — built-in, or one added through `registerCastMember`.
 *
 *  `(string & {})` keeps the built-in names as editor autocomplete while still
 *  admitting registered ones. The scene already tolerates a name it does not
 *  know (OfficeFloor falls back to the theme's default character, and
 *  portraitArt falls back to a stand-in recipe), so widening this costs no
 *  runtime safety — it only stops the type from being the thing that makes a
 *  custom character impossible. */
// eslint-disable-next-line @typescript-eslint/ban-types
export type OfficeCharacterName = BuiltinCharacterName | (string & {});

export interface CastMember {
  name: OfficeCharacterName;
  displayName: string;
  /** Signature accent color (hex) — used for the in-scene selection glow. */
  shirt: string;
  /** Blurb shown when this character is picked / has no description yet. */
  blurb: string;
}

/** Selectable roster, in display order. Registered members are appended
 *  by `registerCastMember`, so every picker that maps over this array picks
 *  them up without knowing the registry exists. */
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

export const CAST_BY_NAME: Record<string, CastMember> =
  Object.fromEntries(OFFICE_CAST.map((c) => [c.name, c]));

export const DEFAULT_CHARACTER: OfficeCharacterName = 'jim';

/** Rendered scene frames, keyed by character. Declared here rather than beside
 *  `getCastFrames` below so `registerCastMember` can invalidate it without a
 *  forward reference. */
const frameCache = new Map<OfficeCharacterName, Texture[][]>();

/**
 * Add a character to the selectable cast at runtime.
 *
 * Both `OFFICE_CAST` and `CAST_BY_NAME` are mutated in place rather than
 * rebuilt: every consumer holds the same array/object reference (the pickers
 * map over OFFICE_CAST, the theme registry hands CAST_BY_NAME to the floor),
 * so replacing them would leave those references pointing at a stale snapshot.
 *
 * Call this at module scope, before the first render.
 *
 * @param member  Roster entry — name, display name, accent color, blurb.
 * @param recipe  How to draw them. Same shape the built-ins use.
 */
export function registerCastMember(member: CastMember, recipe: Recipe): void {
  const existing = OFFICE_CAST.findIndex((c) => c.name === member.name);
  if (existing >= 0) OFFICE_CAST[existing] = member;
  else OFFICE_CAST.push(member);
  CAST_BY_NAME[member.name] = member;
  registerRecipe(member.name, recipe);
  frameCache.delete(member.name);
}

export function hexToNumber(hex: string): number {
  return parseInt(hex.replace('#', ''), 16);
}

// ─── scene frames ────────────────────────────────────────────────────────────

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
 * Paint a character's static portrait for cards / the picker (delegates to the
 * custom procedural composer in portraitArt.ts).
 */
export async function paintCastPortrait(
  ctx: CanvasRenderingContext2D,
  name: OfficeCharacterName,
  scale = 2,
): Promise<void> {
  paintPortrait(ctx, name, scale);
}

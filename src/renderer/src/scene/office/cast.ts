// Precinct identity presets and their original procedural sprite frames.

import { Texture } from 'pixi.js';
import { paintPortrait, sceneFrameBufs, SCENE_W, SCENE_H } from './portraitArt';

export type CharacterName =
  | 'holt' | 'terry' | 'jake' | 'amy' | 'rosa' | 'charles' | 'gina'
  | 'hitchcock' | 'scully';

export interface CastMember {
  name: CharacterName;
  displayName: string;
  /** Signature accent color (hex) — used for the in-scene selection glow. */
  shirt: string;
  /** Blurb shown when this character is picked / has no description yet. */
  blurb: string;
  /** Optional briefing defaults. They never select or constrain an AI engine. */
  description: string;
  goal: string;
}

/** Selectable roster, in display order. */
export const PRECINCT_CAST: CastMember[] = [
  { name: 'holt', displayName: 'Raymond Holt', shirt: '#34465c', blurb: 'Captain and coordinator', description: 'precise precinct captain and primary coordinator', goal: 'Triage incoming work, delegate deliberately, maintain a clear operational picture, and keep the team unblocked.' },
  { name: 'terry', displayName: 'Terry Jeffords', shirt: '#476c91', blurb: 'Operations lead', description: 'supportive operations lead who turns plans into action', goal: 'Break large objectives into safe executable work, track progress, and help teammates clear practical blockers.' },
  { name: 'jake', displayName: 'Jake Peralta', shirt: '#537fa6', blurb: 'Creative investigator', description: 'inventive investigator for difficult technical leads', goal: 'Explore ambiguous problems, reproduce failures, test unconventional hypotheses, and return evidence-backed solutions.' },
  { name: 'amy', displayName: 'Amy Santiago', shirt: '#7b6696', blurb: 'Methodical planner', description: 'methodical planner focused on correctness and evidence', goal: 'Turn requirements into a rigorous checklist, verify every assumption, and deliver well-tested, clearly documented work.' },
  { name: 'rosa', displayName: 'Rosa Diaz', shirt: '#3d3c48', blurb: 'Focused specialist', description: 'direct specialist for high-risk technical work', goal: 'Own the hardest scoped task, minimize surface area, expose risks early, and validate the result without unnecessary ceremony.' },
  { name: 'charles', displayName: 'Charles Boyle', shirt: '#8a6751', blurb: 'Detail investigator', description: 'persistent detail investigator and teammate', goal: 'Follow every relevant clue, handle edge cases carefully, and keep collaborators informed with concrete findings.' },
  { name: 'gina', displayName: 'Gina Linetti', shirt: '#a14f78', blurb: 'Signal and workflow analyst', description: 'sharp workflow analyst who finds the human signal', goal: 'Identify friction, simplify the operator experience, and communicate the highest-leverage improvements with clarity.' },
  { name: 'hitchcock', displayName: 'Hitchcock', shirt: '#7b684c', blurb: 'Veteran case reviewer', description: 'veteran reviewer for overlooked regressions', goal: 'Inspect old assumptions, search for recurring failure patterns, and flag practical regressions before they ship.' },
  { name: 'scully', displayName: 'Scully', shirt: '#67806a', blurb: 'Steady verification partner', description: 'steady verification partner for routine and recovery work', goal: 'Run dependable checks, confirm fixes under realistic conditions, and record concise reproducible results.' },
];

export const CAST_BY_NAME: Record<CharacterName, CastMember> =
  Object.fromEntries(PRECINCT_CAST.map((c) => [c.name, c])) as Record<CharacterName, CastMember>;

export const DEFAULT_CHARACTER: CharacterName = 'jake';
export const GOD_CHARACTER: CharacterName = 'holt';

/** Old roster files stored cast IDs. Preserve those agents without preserving the
 * retired content or expanding the public preset list. */
export const LEGACY_CHARACTER_ALIASES: Record<string, CharacterName> = {
  michael: 'holt', jim: 'jake', pam: 'amy', dwight: 'rosa', kevin: 'scully',
  angela: 'gina', oscar: 'terry', stanley: 'hitchcock', phyllis: 'amy',
  andy: 'charles', kelly: 'gina', ryan: 'jake', toby: 'charles',
  creed: 'hitchcock', meredith: 'rosa',
};

export function normalizeCharacterName(value?: string): CharacterName {
  if (value && value in CAST_BY_NAME) return value as CharacterName;
  return (value && LEGACY_CHARACTER_ALIASES[value.toLowerCase()]) || DEFAULT_CHARACTER;
}

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
export async function getCastFrames(name: CharacterName): Promise<Texture[][]> {
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
  name: CharacterName,
  scale = 2,
): Promise<void> {
  paintPortrait(ctx, name, scale);
}

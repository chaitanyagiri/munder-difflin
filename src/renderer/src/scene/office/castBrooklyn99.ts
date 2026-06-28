// Brooklyn Nine-Nine cast — the 99th-precinct reskin of the office roster.
//
// The engine assigns each agent an OfficeCharacterName (useHive.ts, by agent
// name) and never changes. A theme's `cast.byName[officeName]` layer is the seam
// that reskins those same keys per show — so ALL B99 casting lives here, with
// ZERO edits to the agent→character assignment or the office theme.
//
// getB99CastFrames() slices Pam's license-clean B99 sprite sheets (ART-CONTRACT
// v1: 108×96, 3 rows down/up/right × 6 cols, 18×32 frames) into the grid
// CharacterSprite renders, via SpriteAdapter.extractB99Frames. All 8 contract
// skins are BOUND in SHEET_URLS; getB99CastFrames falls back to the office
// procedural frames only if a sheet is missing or fails to load, so the floor
// always renders a sensible avatar and never breaks (report §E).

import { Texture } from 'pixi.js';
import { SpriteAdapter, type B99SheetConfig } from './SpriteAdapter';
import {
  getCastFrames,
  type CastMember,
  type OfficeCharacterName,
} from './cast';

// Pam's license-clean B99 sheets (ART-CONTRACT v1): 108×96 each, 3 rows
// (down/up/right) × 6 cols (walk1/2/3, type, read1, read2), 18×32 frames.
import holtSheet from '@/assets/sprites/brooklyn99/holt.png?url';
import jakeSheet from '@/assets/sprites/brooklyn99/jake.png?url';
import amySheet from '@/assets/sprites/brooklyn99/amy.png?url';
import rosaSheet from '@/assets/sprites/brooklyn99/rosa.png?url';
import terrySheet from '@/assets/sprites/brooklyn99/terry.png?url';
import charlesSheet from '@/assets/sprites/brooklyn99/charles.png?url';
import hitchcockSheet from '@/assets/sprites/brooklyn99/hitchcock.png?url';
import scullySheet from '@/assets/sprites/brooklyn99/scully.png?url';

/** The eight precinct skins Pam draws (b99-art-assets). */
export type B99CharacterName =
  | 'holt' | 'jake' | 'amy' | 'rosa'
  | 'terry' | 'charles' | 'hitchcock' | 'scully';

/** Per-skin likeness metadata. `shirt` is the in-scene selection-glow accent;
 *  `blurb` shows on the card/picker. Real palette tones bind to Pam's §D once
 *  her sheets land — these are sensible stand-ins, tunable in the PR. */
interface B99Skin {
  display: string;
  shirt: string;
  blurb: string;
}

const B99_SKINS: Record<B99CharacterName, B99Skin> = {
  holt:      { display: 'Holt',      shirt: '#2b3a55', blurb: 'Captain. Bone dry.' },
  jake:      { display: 'Jake',      shirt: '#3f6fb0', blurb: 'Detective. Cool cool cool.' },
  amy:       { display: 'Amy',       shirt: '#7a9b5c', blurb: 'Detective. Binder enthusiast.' },
  rosa:      { display: 'Rosa',      shirt: '#2a2a30', blurb: 'Detective. Do not ask.' },
  terry:     { display: 'Terry',     shirt: '#b06a3a', blurb: 'Sergeant. Loves yogurt.' },
  charles:   { display: 'Charles',   shirt: '#9a6b4a', blurb: 'Detective. Your best friend.' },
  hitchcock: { display: 'Hitchcock', shirt: '#8a8470', blurb: 'Detective. Probably napping.' },
  scully:    { display: 'Scully',    shirt: '#7a7a86', blurb: 'Almost lunchtime.' },
};

// Casting (tunable in PR). The five active leads are pinned per the human's
// decision; the rest map to the spares — and the comic-relief duo Hitchcock/
// Scully skin the quieter/idle/archived roles, per the card.
//   god=Holt · Jim=Jake · Pam=Amy · Oscar=Rosa · Kevin=Charles
const CASTING: Record<OfficeCharacterName, B99CharacterName> = {
  michael:  'holt',     // god → Captain Raymond Holt
  jim:      'jake',     // → Jake Peralta
  pam:      'amy',      // → Amy Santiago
  oscar:    'rosa',     // → Rosa Diaz
  kevin:    'charles',  // me → Charles Boyle
  // spares — prominent secondary first, then the idle/archived comic duo
  dwight:   'terry',    // → Sergeant Terry Jeffords
  angela:   'hitchcock',
  stanley:  'scully',
  phyllis:  'hitchcock',
  andy:     'scully',
  kelly:    'hitchcock',
  ryan:     'scully',
  toby:     'hitchcock',
  creed:    'scully',
  meredith: 'hitchcock',
};

/** Resolve the office-character key an agent carries to its B99 skin. */
export function b99SkinFor(officeName: string): B99CharacterName {
  return CASTING[officeName as OfficeCharacterName] ?? 'jake';
}

/** Cast lookup keyed by the SAME OfficeCharacterName the engine assigns, so it
 *  drops straight into `theme.cast.byName[agent.character]`. displayName/shirt/
 *  blurb carry the precinct likeness; `name` stays the office key the floor uses. */
export const B99_CAST_BY_NAME: Record<OfficeCharacterName, CastMember> =
  Object.fromEntries(
    (Object.keys(CASTING) as OfficeCharacterName[]).map((officeName) => {
      const skin = B99_SKINS[CASTING[officeName]];
      return [officeName, {
        name: officeName,
        displayName: skin.display,
        shirt: skin.shirt,
        blurb: skin.blurb,
      } satisfies CastMember];
    }),
  ) as Record<OfficeCharacterName, CastMember>;

/** Default skin when an agent's character key has no casting entry. Jake =
 *  the everyman detective. (Keyed by office name so byName resolves it.) */
export const B99_DEFAULT_CHARACTER: OfficeCharacterName = 'jim'; // → Jake

// ─── sprite sheets (bind on Pam's delivery) ──────────────────────────────────

/**
 * Frame layout for Pam's B99 sheets, per ART-CONTRACT v1 §1: 18×32 frames in a
 * 3-row (down/up/right) × 6-col (walk1/2/3, type, read1, read2) grid — drop-in
 * for the procedural cast scale (SCENE_W=18, SCENE_H=32). extractB99Frames slices
 * all 6 cols (only 0–2 are used by ANIM_FRAMES today; 3–5 are authored ahead so
 * type/read can extend later without re-cutting art) and pads to the 7-frame row.
 */
const B99_SHEET_CONFIG: B99SheetConfig = {
  frameWidth: 18,
  frameHeight: 32,
  columns: 6,
};

/**
 * Per-skin sheet URLs (bound to Pam's committed PNGs, fingerprinted by Vite via
 * `?url`). An entry present ⇒ that skin slices from the sheet; absent ⇒ the
 * procedural office fallback (kept as a safety net, e.g. if a future skin ships
 * without art). All 8 contract skins are bound.
 */
const SHEET_URLS: Partial<Record<B99CharacterName, string>> = {
  holt: holtSheet,
  jake: jakeSheet,
  amy: amySheet,
  rosa: rosaSheet,
  terry: terrySheet,
  charles: charlesSheet,
  hitchcock: hitchcockSheet,
  scully: scullySheet,
};

/** Load a sheet texture via an <img> (mirrors OfficeFloor.loadTexture — handles
 *  Vite's inlined data: URLs the Assets resolver mistypes). */
function loadSheetTexture(url: string): Promise<Texture> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const tex = Texture.from(img);
      tex.source.scaleMode = 'nearest';
      resolve(tex);
    };
    img.onerror = () => reject(new Error('failed to load B99 sheet ' + url.slice(0, 40)));
    img.src = url;
  });
}

const frameCache = new Map<B99CharacterName, Texture[][]>();

/**
 * Frames for an agent's character in the B99 theme. Slices the skin's sheet when
 * one is bound; otherwise falls back to the office procedural frames for the
 * agent's ORIGINAL office character — so the floor renders a sensible avatar
 * (the current placeholder behaviour) until Pam's art is wired. Any load/slice
 * failure also falls back, so a bad sheet never breaks the floor.
 *
 * @param officeName the OfficeCharacterName the engine assigned (theme.cast key).
 */
export async function getB99CastFrames(officeName: string): Promise<Texture[][]> {
  const skin = b99SkinFor(officeName);
  const cached = frameCache.get(skin);
  if (cached) return cached;

  const url = SHEET_URLS[skin];
  if (url) {
    try {
      const tex = await loadSheetTexture(url);
      const frames = SpriteAdapter.extractB99Frames(tex, B99_SHEET_CONFIG);
      frameCache.set(skin, frames);
      return frames;
    } catch (err) {
      console.warn(`[castBrooklyn99] sheet for '${skin}' failed — using office fallback`, err);
    }
  }
  // Fallback: procedural office frames for the original character key.
  return getCastFrames(officeName as OfficeCharacterName);
}

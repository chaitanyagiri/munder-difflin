// Brooklyn Nine-Nine cast — the 99th-precinct reskin of the office roster.
//
// The engine assigns each agent an OfficeCharacterName (useHive.ts, by agent
// name) and never changes. A theme's `cast.byName[officeName]` layer is the seam
// that reskins those same keys per show — so ALL B99 casting lives here, with
// ZERO edits to the agent→character assignment or the office theme.
//
// getB99CastFrames() slices Pam's license-clean B99 sprite sheets into the 3-row
// (down/up/right) grid CharacterSprite renders, via SpriteAdapter.extractB99Frames.
// INTERFACE-FIRST: until Pam's PNGs land, SHEET_URLS is empty and getFrames
// FALLS BACK to the office procedural frames for the agent's original character,
// so the floor still renders a sensible avatar and never breaks (report §E).
// Binding Pam's art = add one `?url` import + one SHEET_URLS entry per character.

import { Texture } from 'pixi.js';
import { SpriteAdapter, type B99SheetConfig } from './SpriteAdapter';
import {
  getCastFrames,
  type CastMember,
  type OfficeCharacterName,
} from './cast';

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
 * Frame layout for Pam's B99 sheets, per her ART CONTRACT (§B). PLACEHOLDER
 * dimensions — rebind to the contract's exact per-char canvas px when it lands.
 * The office scene renders ~18×32 natively, so 32-wide cells leave headroom.
 */
const B99_SHEET_CONFIG: B99SheetConfig = {
  frameWidth: 32,
  frameHeight: 32,
  columns: 3, // walk1/2/3 minimum; widen to 7 if the contract ships type/read
};

/**
 * Per-skin sheet URLs. EMPTY until Pam's license-clean PNGs land under
 * src/renderer/src/assets/characters/brooklyn99/. Bind each with a static
 * `?url` import so Vite fingerprints it, e.g.:
 *   import holtSheet from '@/assets/characters/brooklyn99/holt.png?url';
 *   const SHEET_URLS = { holt: holtSheet, ... };
 * An entry present ⇒ that skin slices from the sheet; absent ⇒ procedural
 * fallback. Static imports of not-yet-existing files would break the build, so
 * we keep this empty and resolve at runtime until the art is committed.
 */
const SHEET_URLS: Partial<Record<B99CharacterName, string>> = {};

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

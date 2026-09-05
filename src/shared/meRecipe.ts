/**
 * The "make Michael yours" character recipe — the serialised, user-facing half
 * of the procedural portrait engine.
 *
 * WHY THIS LIVES IN shared/ AND NOT NEXT TO THE PAINTER. Three callers need the
 * same answer on opposite sides of the IPC boundary: the renderer builds a
 * painter recipe from it, main validates it before it reaches config.json, and
 * the tests exercise it without a DOM. `portraitArt.ts` is renderer-only (it
 * draws into a canvas and its sibling pulls in Pixi), so the catalogue and the
 * validation cannot live there.
 *
 * TWO SHAPES, DELIBERATELY DIFFERENT:
 *   `MeRecipe`      — what the user picked and what we persist. JSON-safe: ids
 *                     and '#rrggbb' strings, no tuples, every field required.
 *   `PainterRecipe` — what portraitArt.ts draws. RGB triples, optional fields,
 *                     internal style names.
 * `toPainterRecipe` is the only bridge. Keeping them apart is what lets the UI
 * say "Broad" where the engine says `heavy`, and what stops a persisted file
 * from depending on the painter's private vocabulary.
 *
 * NOTHING HERE THROWS. `normalizeMeRecipe` falls back per field, because the
 * painter's `Recipe.skin` is typed `string` and `drawHead` dereferences
 * `SKIN[skin].base` — an unrecognised skin is a TypeError inside the render
 * loop, not a missing swatch. A persisted file is user-editable and survives
 * downgrades, so it is exactly the input that can carry a value we retired.
 */

// ─── the painter's shape (structurally mirrored, not imported) ───────────────
// portraitArt.ts owns the real `Recipe`. The renderer assigns the return of
// `toPainterRecipe` to it, so tsconfig.web catches any drift between the two at
// compile time — see meCharacter.ts.
export type RGB = [number, number, number];

export interface PainterRecipe {
  skin: string;
  hairc: RGB;
  hair: string;
  hairargs?: { part?: 'L' | 'R'; recede?: number; length?: number; vol?: number };
  cloth: string;
  c1: RGB;
  tie?: RGB;
  brow?: string;
  mouth?: string;
  blush?: boolean;
  facial?: string;
  glasses?: boolean;
  lashes?: boolean;
  heavy?: boolean;
}

// ─── the persisted shape ─────────────────────────────────────────────────────
export type SkinToneId = 'light' | 'tan' | 'brown' | 'dark';
export type BuildId = 'regular' | 'broad';
export type FacialId = 'none' | 'stubble' | 'moustache' | 'moustacheSmall' | 'goatee';
export type GarmentId = 'suit' | 'dressShirt' | 'polo' | 'blouse' | 'cardigan' | 'sweater';
export type BrowId = 'flat' | 'angry' | 'raised' | 'soft';
export type MouthId = 'neutral' | 'smile' | 'frown' | 'grin';
export type HairTileId =
  | 'shortLeft' | 'shortRight' | 'shortReceding'
  | 'floppy' | 'bun' | 'curly' | 'receding' | 'spiky'
  | 'messy' | 'framed' | 'framedLong' | 'bald' | 'baldFringe';

export interface MeRecipe {
  skin: SkinToneId;
  build: BuildId;
  hair: HairTileId;
  hairColor: string;
  glasses: boolean;
  facial: FacialId;
  garment: GarmentId;
  garmentColor: string;
  brow: BrowId;
  mouth: MouthId;
  blush: boolean;
  lashes: boolean;
}

export interface Option<T extends string> { id: T; label: string; }

// ─── colour ──────────────────────────────────────────────────────────────────
const HEX = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX.test(v);
}

export function hexToRgb(hex: string): RGB {
  const h = hex.slice(1);
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16)
  ];
}

export function rgbToHex(rgb: RGB): string {
  return `#${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`;
}

// ─── skin + build ────────────────────────────────────────────────────────────
// The four tones are the painter's whole `SKIN` table. It is four HAND-AUTHORED
// four-tone palettes, not a ramp we can extend from one colour, so there is no
// "custom skin" chip here and there cannot be one without an artist.
export const SKIN_TONES: Option<SkinToneId>[] = [
  { id: 'light', label: 'Light' },
  { id: 'tan', label: 'Tan' },
  { id: 'brown', label: 'Brown' },
  { id: 'dark', label: 'Dark' }
];

// "Build", never the engine's field name: this is a two-state body shape and
// `heavy` reads badly as a user-facing label.
export const BUILDS: Option<BuildId>[] = [
  { id: 'regular', label: 'Regular' },
  { id: 'broad', label: 'Broad' }
];

// ─── hair ────────────────────────────────────────────────────────────────────
/**
 * Pre-composed tiles, NOT "9 styles + shape sliders".
 *
 * Five of the nine painter styles read no `hairargs` at all, so a slider that
 * appears for Short and vanishes for Curly reads as a bug; and the numeric args
 * have no declared range in the painter (`set()` silently clips out of bounds),
 * so a slider would need clamps invented here anyway. Every number below is one
 * we chose, which means there is nothing left to validate.
 */
export interface HairTile {
  id: HairTileId;
  label: string;
  style: string;
  args?: { part?: 'L' | 'R'; recede?: number; length?: number; vol?: number };
}

export const HAIR_TILES: HairTile[] = [
  { id: 'shortLeft', label: 'Short', style: 'styleShort', args: { part: 'L' } },
  { id: 'shortRight', label: 'Short (right part)', style: 'styleShort', args: { part: 'R' } },
  { id: 'shortReceding', label: 'Short, receding', style: 'styleShort', args: { part: 'L', recede: 1 } },
  { id: 'floppy', label: 'Floppy', style: 'styleFloppy' },
  { id: 'bun', label: 'Bun', style: 'styleBun' },
  { id: 'curly', label: 'Curly', style: 'styleCurly' },
  { id: 'receding', label: 'Receding', style: 'styleRecede' },
  { id: 'spiky', label: 'Spiky', style: 'styleSpiky' },
  // `length` is set EXPLICITLY and must stay that way. The painter defaults the
  // messy length to 8 from the front and 9 from the back, so leaving it unset
  // makes the character's hair change length when it turns around.
  { id: 'messy', label: 'Messy', style: 'styleMessy', args: { length: 15 } },
  { id: 'framed', label: 'Framed', style: 'styleFrame', args: { length: 15, vol: 1 } },
  { id: 'framedLong', label: 'Framed, long', style: 'styleFrame', args: { length: 20, vol: 2 } },
  { id: 'bald', label: 'Bald', style: 'styleBald' },
  { id: 'baldFringe', label: 'Bald with fringe', style: 'styleBald', args: { recede: 1 } }
];

/**
 * Eleven hair colours, curated to the band human hair actually occupies.
 *
 * Curated rather than free-picker-first for a reason beyond taste: from behind,
 * six of the nine painter hairstyles collapse into the same silhouette, and hair
 * COLOUR is the identity cue that survives on the office floor. A curated set
 * can guarantee its entries stay distinguishable at 18x32; two users freehanding
 * "dark brown" cannot. The custom chip is still there for everyone who wants teal.
 *
 * 'Black' is a very dark warm brown and 'White' is an off-white ON PURPOSE. The
 * painter derives highlight/shadow by multiplying by 1.22 / 0.68 and clamping,
 * so a pure #000000 has a black highlight and a pure #ffffff has a white one —
 * the three-tone ramp that makes this read as pixel art collapses at exactly the
 * two extremes a palette normally includes.
 */
export const HAIR_COLORS: Option<string>[] = [
  { id: '#2b2422', label: 'Black' },
  { id: '#3a2a1c', label: 'Dark brown' },
  { id: '#5c3c22', label: 'Brown' },
  { id: '#78542c', label: 'Light brown' },
  { id: '#9a7c46', label: 'Dark blonde' },
  { id: '#c8a55a', label: 'Blonde' },
  { id: '#ded2b4', label: 'Platinum' },
  { id: '#7a3a28', label: 'Auburn' },
  { id: '#b5613a', label: 'Ginger' },
  { id: '#8e8a84', label: 'Grey' },
  { id: '#ded9d0', label: 'White' }
];

// ─── face ────────────────────────────────────────────────────────────────────
// Facial hair draws in the HAIR colour and the painter gives it no colour of its
// own, so there is no separate swatch: pick grey hair and the beard follows.
export const FACIAL_HAIR: Array<Option<FacialId> & { facial?: string }> = [
  { id: 'none', label: 'None' },
  { id: 'stubble', label: 'Stubble', facial: 'stubble' },
  { id: 'moustache', label: 'Moustache', facial: 'mustache' },
  { id: 'moustacheSmall', label: 'Moustache, small', facial: 'mustacheSm' },
  { id: 'goatee', label: 'Goatee', facial: 'goatee' }
];

// ─── outfit ──────────────────────────────────────────────────────────────────
/**
 * `needsTie` is not a user control — it is a correctness flag.
 *
 * The painter draws a tie-less suit as a white shirt placket on the 18x28 card
 * and as plain jacket colour on the 18x32 floor sprite. Excluding the tie as a
 * CONTROL is a product decision; leaving the FIELD unset would ship a card/floor
 * mismatch inside the one feature whose whole premise is card/floor parity. So
 * the two garments that read a tie always get one.
 */
export interface Garment { id: GarmentId; label: string; cloth: string; needsTie?: boolean; }

export const GARMENTS: Garment[] = [
  { id: 'suit', label: 'Suit', cloth: 'suit', needsTie: true },
  { id: 'dressShirt', label: 'Dress shirt', cloth: 'dressshirt', needsTie: true },
  { id: 'polo', label: 'Polo', cloth: 'polo' },
  { id: 'blouse', label: 'Blouse', cloth: 'blouse' },
  { id: 'cardigan', label: 'Cardigan', cloth: 'cardigan' },
  { id: 'sweater', label: 'Sweater', cloth: 'sweater' }
];

/** Michael's own tie. Never chosen, always supplied — see `needsTie`. */
export const DEFAULT_TIE_COLOR = '#aa3a3a';

/**
 * Twelve garment colours: four office neutrals first (clothing at this scale
 * reads as wardrobe, and wardrobe is mostly neutral), then eight saturated.
 * 'Off-white' is off-white for the same ramp reason as the hair 'White' above.
 */
export const GARMENT_COLORS: Option<string>[] = [
  { id: '#e8e4da', label: 'Off-white' },
  { id: '#b9b5ad', label: 'Light grey' },
  { id: '#3a3f4a', label: 'Charcoal' },
  { id: '#3a4568', label: 'Navy' },
  { id: '#6f93c4', label: 'Sky' },
  { id: '#4f8f88', label: 'Teal' },
  { id: '#7d9668', label: 'Sage' },
  { id: '#b89b3e', label: 'Mustard' },
  { id: '#a8563f', label: 'Rust' },
  { id: '#7a3c50', label: 'Wine' },
  { id: '#6b5a8a', label: 'Plum' },
  { id: '#d08aa8', label: 'Pink' }
];

// ─── expression (behind a disclosure in the UI) ──────────────────────────────
export const BROWS: Option<BrowId>[] = [
  { id: 'flat', label: 'Flat' },
  { id: 'angry', label: 'Stern' },
  { id: 'raised', label: 'Raised' },
  { id: 'soft', label: 'Soft' }
];

export const MOUTHS: Option<MouthId>[] = [
  { id: 'neutral', label: 'Neutral' },
  { id: 'smile', label: 'Smile' },
  { id: 'frown', label: 'Frown' },
  { id: 'grin', label: 'Grin' }
];

// ─── the default ─────────────────────────────────────────────────────────────
/**
 * Michael, field for field, so the creator opens on him and a user who changes
 * nothing saves exactly what they already had. The hair and garment colours are
 * his real values and are also swatch entries, so opening the dialog shows a
 * selected swatch rather than an inexplicable "Custom".
 */
export const DEFAULT_ME_RECIPE: MeRecipe = {
  skin: 'light',
  build: 'regular',
  hair: 'shortLeft',
  hairColor: '#3a2a1c',
  glasses: false,
  facial: 'none',
  garment: 'suit',
  garmentColor: '#3a3f4a',
  brow: 'flat',
  mouth: 'smile',
  blush: false,
  lashes: false
};

// ─── validation ──────────────────────────────────────────────────────────────
function pick<T extends string>(options: ReadonlyArray<{ id: T }>, v: unknown, fallback: T): T {
  return typeof v === 'string' && options.some((o) => o.id === v) ? (v as T) : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function color(v: unknown, fallback: string): string {
  return isHexColor(v) ? v.toLowerCase() : fallback;
}

/**
 * Coerce anything at all into a renderable recipe, field by field.
 *
 * Per-field rather than all-or-nothing on purpose: a config written by a newer
 * build can carry one hair tile this build has never heard of, and dropping the
 * user's whole character over it would be a worse outcome than dropping the one
 * field. The result is always safe to hand to the painter.
 */
export function normalizeMeRecipe(input: unknown): MeRecipe {
  const v = (input ?? {}) as Partial<Record<keyof MeRecipe, unknown>>;
  const d = DEFAULT_ME_RECIPE;
  return {
    skin: pick(SKIN_TONES, v.skin, d.skin),
    build: pick(BUILDS, v.build, d.build),
    hair: pick(HAIR_TILES, v.hair, d.hair),
    hairColor: color(v.hairColor, d.hairColor),
    glasses: bool(v.glasses, d.glasses),
    facial: pick(FACIAL_HAIR, v.facial, d.facial),
    garment: pick(GARMENTS, v.garment, d.garment),
    garmentColor: color(v.garmentColor, d.garmentColor),
    brow: pick(BROWS, v.brow, d.brow),
    mouth: pick(MOUTHS, v.mouth, d.mouth),
    blush: bool(v.blush, d.blush),
    lashes: bool(v.lashes, d.lashes)
  };
}

// ─── the bridge to the painter ───────────────────────────────────────────────
/**
 * Build the painter's recipe. Runs `normalizeMeRecipe` first so this is safe on
 * unvalidated input — it is the last thing between a persisted file and a
 * `SKIN[skin].base` dereference.
 *
 * Optional fields are OMITTED rather than set to false/undefined: the painter
 * tests them with `if (r.glasses)` and `r.facial &&`, so an explicit `false`
 * behaves the same, but omitting keeps a serialised painter recipe readable in
 * a debugger and matches how the fifteen hand-written cast recipes are shaped.
 */
export function toPainterRecipe(me: unknown): PainterRecipe {
  const r = normalizeMeRecipe(me);
  const tile = HAIR_TILES.find((t) => t.id === r.hair) ?? HAIR_TILES[0];
  const garment = GARMENTS.find((g) => g.id === r.garment) ?? GARMENTS[0];
  const facial = FACIAL_HAIR.find((f) => f.id === r.facial);

  const out: PainterRecipe = {
    skin: r.skin,
    hairc: hexToRgb(r.hairColor),
    hair: tile.style,
    cloth: garment.cloth,
    c1: hexToRgb(r.garmentColor),
    brow: r.brow,
    mouth: r.mouth
  };
  if (tile.args) out.hairargs = { ...tile.args };
  if (garment.needsTie) out.tie = hexToRgb(DEFAULT_TIE_COLOR);
  if (facial?.facial) out.facial = facial.facial;
  if (r.glasses) out.glasses = true;
  if (r.blush) out.blush = true;
  if (r.lashes) out.lashes = true;
  if (r.build === 'broad') out.heavy = true;
  return out;
}

// ─── surprise me ─────────────────────────────────────────────────────────────
/**
 * The paralysis-breaker. Takes an injectable `rand` so the tests can pin it —
 * a randomiser that can only be checked by eye is a randomiser whose bias
 * nobody notices.
 *
 * Draws colours from the curated swatches rather than the full 24-bit space:
 * a uniform random RGB is overwhelmingly likely to be an unwearable mud, and
 * "Surprise me" should produce someone you might keep.
 */
export function randomMeRecipe(rand: () => number = Math.random): MeRecipe {
  const one = <T,>(xs: ReadonlyArray<T>): T => xs[Math.floor(rand() * xs.length) % xs.length];
  const chance = (p: number): boolean => rand() < p;
  return {
    skin: one(SKIN_TONES).id,
    build: one(BUILDS).id,
    hair: one(HAIR_TILES).id,
    hairColor: one(HAIR_COLORS).id,
    glasses: chance(0.3),
    facial: one(FACIAL_HAIR).id,
    garment: one(GARMENTS).id,
    garmentColor: one(GARMENT_COLORS).id,
    brow: one(BROWS).id,
    mouth: one(MOUTHS).id,
    blush: chance(0.2),
    lashes: chance(0.35)
  };
}

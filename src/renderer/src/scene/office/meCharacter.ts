/**
 * The bridge between the persisted "me" recipe and the painter.
 *
 * `src/shared/meRecipe.ts` owns the user-facing catalogue and the validation; it
 * cannot import `portraitArt.ts` (renderer-only, canvas-bound), so it mirrors the
 * painter's `Recipe` structurally as `PainterRecipe`. The one line below is what
 * keeps that mirror honest: assigning the shared module's output to the painter's
 * own exported type means tsconfig.web fails the build the moment the two drift,
 * rather than the drift surfacing as a character that renders wrong.
 */
import { Texture } from 'pixi.js';
import { toPainterRecipe as toShapedRecipe, type MeRecipe } from '@shared/meRecipe';
import { recipeSceneFrameBufs, type Recipe } from './portraitArt';
import { bufToSceneTexture, framesFromSceneBufs } from './cast';

/** Validate a persisted recipe and shape it for the painter. Never throws. */
export function toRecipe(me: MeRecipe | undefined | null): Recipe {
  // A plain checked assignment, deliberately: the cast that used to be here
  // suppressed the very error this line exists to raise.
  const r: Recipe = toShapedRecipe(me);
  return r;
}

/**
 * Scene frames for a custom recipe, cached on the recipe's own CONTENTS.
 *
 * The cast's `frameCache` is keyed by character name and never evicts — right
 * for the fifteen recipes that cannot change, wrong here twice over: a custom
 * recipe has no name to key on, and it changes every time the user moves a
 * swatch. Keying on the serialised recipe means an edit is a natural miss and a
 * revert is a natural hit.
 *
 * These are GPU textures, so the map is capped and evicts oldest-first. Without
 * that, an afternoon in the creator would leak a texture set per keystroke —
 * the same never-evict trap as `frameCache`, just moved.
 */
const MAX_RECIPE_FRAMES = 8;
const recipeFrames = new Map<string, Texture[][]>();

export function getRecipeFrames(me: MeRecipe): Texture[][] {
  const key = JSON.stringify(toRecipe(me));
  const hit = recipeFrames.get(key);
  if (hit) return hit;

  const { front, back } = recipeSceneFrameBufs(toRecipe(me));
  const frames = framesFromSceneBufs(front, back, bufToSceneTexture);
  recipeFrames.set(key, frames);

  while (recipeFrames.size > MAX_RECIPE_FRAMES) {
    const oldest = recipeFrames.keys().next();
    if (oldest.done) break;
    const evicted = recipeFrames.get(oldest.value);
    recipeFrames.delete(oldest.value);
    // Textures built from a canvas hold GPU memory that the GC cannot reclaim on
    // its own. Destroy each ONCE — the frame grid repeats the same stand texture
    // across four animation slots and reuses the front row for the side row.
    for (const tex of new Set(evicted?.flat() ?? [])) tex.destroy(true);
  }
  return frames;
}

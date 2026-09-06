import { useEffect, useRef } from 'react';
import { paintCastPortrait, type OfficeCharacterName } from '@/scene/office/cast';
import { PORTRAIT_W, PORTRAIT_H, paintRecipePortrait } from '@/scene/office/portraitArt';
import { toRecipe } from '@/scene/office/meCharacter';
import type { MeRecipe } from '@shared/meRecipe';

const FRAME_W = PORTRAIT_W;
const FRAME_H = PORTRAIT_H;

export interface SpritePortraitProps {
  character: OfficeCharacterName;
  /** A customized character ("make Michael yours"). When present it REPLACES the
   *  cast portrait for `character` — every caller keeps passing `character` as a
   *  fallback, so a surface that has not been told about the recipe still draws
   *  the right thing rather than nothing. */
  recipe?: MeRecipe | null;
  /** Pixels per source pixel. Whole numbers are exact; half-steps (1.5, 2.5)
   *  double every other row, which pixel art survives. The blit runs with
   *  smoothing off, so nothing here is ever interpolated. */
  scale?: number;
  background?: string;
}

/** Static standing portrait of an Office cast member, or of a custom recipe. */
export function SpritePortrait({
  character,
  recipe = null,
  scale = 2,
  background = 'transparent'
}: SpritePortraitProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const recipeKey = recipe ? JSON.stringify(recipe) : '';

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let cancelled = false;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (background !== 'transparent') {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    // The recipe path is synchronous — it composes into a typed array and blits,
    // with no cache to invalidate, which is what makes the creator's preview
    // repaint on every swatch click.
    if (recipe) paintRecipePortrait(ctx, toRecipe(recipe), scale);
    else paintCastPortrait(ctx, character, scale).catch(() => { /* asset load race */ });
    return () => { cancelled = true; void cancelled; };
    // Serialized rather than passed by identity: the creator rebuilds the recipe
    // object on every keystroke, and an identity dep would repaint on edits that
    // changed nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [character, recipeKey, scale, background]);

  // A fractional scale can land on a fractional pixel count; the canvas
  // attributes are integers either way, so round once and use the same number
  // for the backing store and the CSS box (a mismatch is what makes pixel art
  // blurry).
  const w = Math.round(FRAME_W * scale);
  const h = Math.round(FRAME_H * scale);

  return (
    <canvas
      ref={canvasRef}
      width={w}
      height={h}
      style={{
        width: w,
        height: h,
        imageRendering: 'pixelated'
      }}
    />
  );
}

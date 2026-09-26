import { useEffect, useRef } from 'react';
import { paintCastPortrait, type OfficeCharacterName } from '@/scene/office/cast';
import { PORTRAIT_W, PORTRAIT_H } from '@/scene/office/portraitArt';

const FRAME_W = PORTRAIT_W;
const FRAME_H = PORTRAIT_H;

export interface SpritePortraitProps {
  character: OfficeCharacterName;
  /** Logical portrait size; the backing canvas is supersampled for sharp faces. */
  scale?: number;
  background?: string;
}

/** Photographic employee portrait, shared with the floor's character artwork. */
export function SpritePortrait({
  character,
  scale = 2,
  background = 'transparent'
}: SpritePortraitProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let cancelled = false;
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (background !== 'transparent') {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    // Paint offscreen so a slower previous selection cannot overwrite the current person.
    const staging = document.createElement('canvas');
    staging.width = canvas.width;
    staging.height = canvas.height;
    const stagingCtx = staging.getContext('2d')!;
    paintCastPortrait(stagingCtx, character, scale * 2).then(() => {
      if (!cancelled) ctx.drawImage(staging, 0, 0);
    }).catch(() => { /* preserve the neutral background if an asset cannot load */ });
    return () => { cancelled = true; };
  }, [character, scale, background]);

  // Keep the CSS box stable; use twice as many backing pixels for fine detail.
  const w = Math.round(FRAME_W * scale);
  const h = Math.round(FRAME_H * scale);

  return (
    <canvas
      ref={canvasRef}
      width={w * 2}
      height={h * 2}
      role="img"
      aria-label={character}
      style={{
        width: w,
        height: h,
        imageRendering: 'auto'
      }}
    />
  );
}

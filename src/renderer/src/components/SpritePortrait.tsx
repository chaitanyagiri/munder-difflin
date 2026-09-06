import { useEffect, useRef } from 'react';
import { paintCastPortrait, type OfficeCharacterName } from '@/scene/office/cast';
import { PORTRAIT_W, PORTRAIT_H } from '@/scene/office/portraitArt';

const FRAME_W = PORTRAIT_W;
const FRAME_H = PORTRAIT_H;

export interface SpritePortraitProps {
  character: OfficeCharacterName;
  /** 每源像素的像素数。整数是精确的；半步（1.5、2.5）会让每隔一行翻倍，
   *  像素画能承受这种。blit 关闭平滑运行，所以这里永远不会被插值。 */
  scale?: number;
  background?: string;
}

/** Office 剧组角色（重着色的 LimeZu sprite）的静态站立肖像。 */
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
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (background !== 'transparent') {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    paintCastPortrait(ctx, character, scale).catch(() => { /* 资源加载竞态 */ });
    return () => { cancelled = true; void cancelled; };
  }, [character, scale, background]);

  // 分数缩放可能落在分数的像素数上；画布属性反正都是整数，所以只取一次整，
  // 后端存储和 CSS 盒都用同一个数（不一致正是像素画发糊的原因）。
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

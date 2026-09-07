import { ImageSource, Texture } from 'pixi.js';
import frontUrl from '@/assets/realistic-office/employees-front.png?url';
import backUrl from '@/assets/realistic-office/employees-back.png?url';
import sideUrl from '@/assets/realistic-office/employees-side.png?url';
import seatedUrl from '@/assets/realistic-office/employees-seated.png?url';
import { removePreviewMatte } from './spriteMatte';

/** Logical dimensions stay compatible with seats, masks and interaction hit areas.
 * Eight texels per world pixel keep faces and fabric sharp while zooming. */
const SCALE = 8;
const WIDTH = 18 * SCALE;
const HEIGHT = 32 * SCALE;
const COLUMNS = 5;
const ROWS = 3;
interface Cutout { canvas: HTMLCanvasElement; x: number; y: number; width: number; height: number; }
const atlasCache = new Map<string, Promise<Cutout[]>>();
const frameCache = new Map<number, Promise<Texture[][]>>();

function loadAtlas(url: string): Promise<Cutout[]> {
  const cached = atlasCache.get(url);
  if (cached) return cached;
  const pending = new Promise<Cutout[]>((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error('Could not load employee artwork'));
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(image, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const pixels = imageData.data;
        removePreviewMatte(pixels, canvas.width, canvas.height);
        ctx.putImageData(imageData, 0, 0);
        const cutouts: Cutout[] = [];
        for (let index = 0; index < COLUMNS * ROWS; index++) {
          const left = Math.round((index % COLUMNS) * canvas.width / COLUMNS);
          const right = Math.round(((index % COLUMNS) + 1) * canvas.width / COLUMNS);
          const rowEdges = url === backUrl ? [0, 0.339, 0.655, 1] : [0, 0.337, 0.664, 1];
          const top = Math.round(rowEdges[Math.floor(index / COLUMNS)] * canvas.height);
          const bottom = Math.round(rowEdges[Math.floor(index / COLUMNS) + 1] * canvas.height);
          let x0 = right, x1 = left, y0 = bottom, y1 = top;
          for (let y = top; y < bottom; y++) {
            for (let x = left; x < right; x++) {
              if (pixels[(y * canvas.width + x) * 4 + 3] < 24) continue;
              x0 = Math.min(x0, x); x1 = Math.max(x1, x);
              y0 = Math.min(y0, y); y1 = Math.max(y1, y);
            }
          }
          if (x1 < x0 || y1 < y0) throw new Error('Employee atlas contains an empty cell');
          cutouts.push({ canvas, x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 });
        }
        resolve(cutouts);
      } catch (error) { reject(error); }
    };
    image.src = url;
  });
  atlasCache.set(url, pending);
  pending.catch(() => atlasCache.delete(url));
  return pending;
}

/** Atlas slicing and articulation happen once per employee, never in the ticker. */
function makeFrame(cutout: Cutout, step: number, activity: 'stand' | 'walk' | 'type' | 'read' | 'seated'): Texture {
  const body = document.createElement('canvas');
  body.width = WIDTH; body.height = HEIGHT;
  const bodyCtx = body.getContext('2d')!;
  const h = activity === 'seated' ? SCALE * 22 : HEIGHT - SCALE * 2;
  const w = Math.min(WIDTH - SCALE * 2, h * cutout.width / cutout.height);
  bodyCtx.drawImage(cutout.canvas, cutout.x, cutout.y, cutout.width, cutout.height,
    (WIDTH - w) / 2, activity === 'seated' ? 0 : HEIGHT - h - SCALE, w, h);

  const frame = document.createElement('canvas');
  frame.width = WIDTH; frame.height = HEIGHT;
  const ctx = frame.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (activity === 'walk' && step !== 0) {
    const hip = Math.round(HEIGHT * 0.64);
    // Opposing leg swings around the hip, with a small weight transfer.
    for (let side = 0; side < 2; side++) {
      const x = side * WIDTH / 2;
      const pivot = WIDTH * (side === 0 ? 0.4 : 0.6);
      ctx.save();
      ctx.translate(pivot, hip);
      ctx.rotate(step * (side === 0 ? 0.07 : -0.07));
      ctx.drawImage(body, x, hip - 3, WIDTH / 2, HEIGHT - hip + 3,
        x - pivot, -3, WIDTH / 2, HEIGHT - hip + 3);
      ctx.restore();
    }
    ctx.drawImage(body, 0, 0, WIDTH, hip + 2, step * 1.2, -1.2, WIDTH, hip + 3);
  } else {
    const breath = activity === 'type' || activity === 'seated' ? step * 0.6 : activity === 'read' ? step * 0.3 : 0;
    ctx.drawImage(body, 0, breath);
  }
  return new Texture({ source: new ImageSource({
    resource: frame, resolution: SCALE, scaleMode: 'linear', autoGenerateMipmaps: true,
  }) });
}

export function getRealisticFrames(index: number): Promise<Texture[][]> {
  const cached = frameCache.get(index);
  if (cached) return cached;
  const pending = Promise.all([frontUrl, backUrl, sideUrl, seatedUrl].map(loadAtlas)).then((atlases) =>
    atlases.slice(0, 3).map((atlas, direction) => {
      const cutout = atlas[index] ?? atlas[1];
      const frames = [
        makeFrame(cutout, 0, 'stand'), makeFrame(cutout, -1, 'walk'), makeFrame(cutout, 1, 'walk'),
        makeFrame(cutout, -1, 'type'), makeFrame(cutout, 1, 'type'),
        makeFrame(cutout, -1, 'read'), makeFrame(cutout, 1, 'read'),
      ];
      if (direction === 1) {
        const seated = atlases[3][index] ?? atlases[3][1];
        frames.push(makeFrame(seated, -1, 'seated'), makeFrame(seated, 1, 'seated'));
      }
      return frames;
    }),
  );
  frameCache.set(index, pending);
  pending.catch(() => frameCache.delete(index));
  return pending;
}

export async function paintRealisticPortrait(ctx: CanvasRenderingContext2D, index: number, scale: number): Promise<void> {
  const atlas = await loadAtlas(frontUrl);
  const c = atlas[index] ?? atlas[1];
  const width = 18 * scale, height = 28 * scale;
  // A head-and-shoulders crop preserves useful facial detail on compact cards.
  const cropHeight = Math.min(c.height, c.width * 28 / 18);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(c.canvas, c.x, c.y, c.width, cropHeight, 0, 0, width, height);
}

if (import.meta.hot) import.meta.hot.dispose(() => {
  for (const pending of frameCache.values()) {
    void pending.then((rows) => rows.flat().forEach((texture) => texture.destroy(true)), () => {});
  }
  frameCache.clear();
  atlasCache.clear();
});

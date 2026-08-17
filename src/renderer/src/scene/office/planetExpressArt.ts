import type { PlanetExpressCharacterName } from './cast';
import { PORTRAIT_W, PORTRAIT_H, SCENE_W, SCENE_H } from './portraitArt';

type RGB = [number, number, number];
type Buf = Uint8ClampedArray;

const OUTLINE: RGB = [32, 34, 44];

interface Recipe {
  skin: RGB;
  hair: RGB;
  shirt: RGB;
  pants: RGB;
  eye?: RGB;
  mouth?: RGB;
  shape?: 'human' | 'robot' | 'zoidberg';
  hairStyle?: 'tuft' | 'ponytail' | 'short' | 'bald' | 'cap';
  glasses?: boolean;
  labCoat?: boolean;
  antenna?: boolean;
}

export interface SceneFrames { front: Buf[]; back: Buf[]; }

const RECIPES: Record<PlanetExpressCharacterName, Recipe> = {
  'professor-farnsworth': {
    skin: [239, 204, 164],
    hair: [226, 232, 224],
    shirt: [150, 202, 188],
    pants: [64, 78, 92],
    hairStyle: 'bald',
    glasses: true,
    labCoat: true,
  },
  leela: {
    skin: [232, 188, 146],
    hair: [86, 58, 122],
    shirt: [112, 85, 150],
    pants: [42, 46, 64],
    hairStyle: 'ponytail',
    eye: [245, 245, 238],
  },
  fry: {
    skin: [239, 190, 146],
    hair: [214, 112, 46],
    shirt: [214, 84, 45],
    pants: [74, 88, 158],
    hairStyle: 'tuft',
  },
  bender: {
    skin: [155, 172, 178],
    hair: [108, 124, 132],
    shirt: [155, 172, 178],
    pants: [116, 132, 140],
    shape: 'robot',
    antenna: true,
  },
  hermes: {
    skin: [126, 82, 54],
    hair: [40, 36, 34],
    shirt: [67, 150, 94],
    pants: [58, 72, 80],
    hairStyle: 'short',
    glasses: true,
  },
  amy: {
    skin: [235, 188, 138],
    hair: [24, 28, 36],
    shirt: [231, 120, 165],
    pants: [64, 76, 92],
    hairStyle: 'short',
  },
  zoidberg: {
    skin: [211, 94, 82],
    hair: [176, 62, 66],
    shirt: [232, 226, 196],
    pants: [76, 92, 92],
    shape: 'zoidberg',
  },
  scruffy: {
    skin: [186, 134, 92],
    hair: [78, 62, 46],
    shirt: [92, 112, 82],
    pants: [68, 68, 74],
    hairStyle: 'cap',
  },
};

const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const shade = (c: RGB, f: number): RGB => [clamp(c[0] * f), clamp(c[1] * f), clamp(c[2] * f)];

function set(buf: Buf, w: number, h: number, x: number, y: number, c: RGB, a = 255): void {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const i = (y * w + x) * 4;
  buf[i] = c[0];
  buf[i + 1] = c[1];
  buf[i + 2] = c[2];
  buf[i + 3] = a;
}

function alphaAt(buf: Buf, w: number, h: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= w || y >= h) return 0;
  return buf[(y * w + x) * 4 + 3];
}

function rect(buf: Buf, w: number, h: number, x0: number, y0: number, x1: number, y1: number, c: RGB): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(buf, w, h, x, y, c);
}

function outline(buf: Buf, w: number, h: number): void {
  const pts: Array<[number, number]> = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alphaAt(buf, w, h, x, y)) continue;
      if (
        alphaAt(buf, w, h, x + 1, y) ||
        alphaAt(buf, w, h, x - 1, y) ||
        alphaAt(buf, w, h, x, y + 1) ||
        alphaAt(buf, w, h, x, y - 1)
      ) pts.push([x, y]);
    }
  }
  for (const [x, y] of pts) set(buf, w, h, x, y, OUTLINE);
}

function drawHumanHead(buf: Buf, w: number, h: number, r: Recipe, back: boolean): void {
  const skinHi = shade(r.skin, 1.15);
  const skinSh = shade(r.skin, 0.74);
  rect(buf, w, h, 5, 5, 12, 15, r.skin);
  rect(buf, w, h, 6, 4, 11, 5, r.skin);
  rect(buf, w, h, 6, 15, 11, 16, skinSh);
  set(buf, w, h, 4, 9, r.skin);
  set(buf, w, h, 13, 9, skinSh);
  rect(buf, w, h, 6, 6, 7, 11, skinHi);
  rect(buf, w, h, 11, 7, 12, 13, skinSh);

  if (back) {
    drawHair(buf, w, h, r, true);
    rect(buf, w, h, 7, 16, 10, 18, skinSh);
    return;
  }

  const eye = r.eye ?? [245, 244, 236];
  const pupil: RGB = [34, 34, 40];
  if (r.eye) {
    rect(buf, w, h, 6, 8, 11, 10, eye);
    set(buf, w, h, 8, 9, pupil);
    set(buf, w, h, 9, 9, pupil);
  } else {
    set(buf, w, h, 6, 9, eye);
    set(buf, w, h, 7, 9, pupil);
    set(buf, w, h, 10, 9, eye);
    set(buf, w, h, 11, 9, pupil);
  }
  rect(buf, w, h, 7, 13, 10, 13, r.mouth ?? [132, 72, 68]);
  if (r.glasses) {
    rect(buf, w, h, 5, 8, 7, 10, OUTLINE);
    rect(buf, w, h, 10, 8, 12, 10, OUTLINE);
    set(buf, w, h, 8, 9, OUTLINE);
    set(buf, w, h, 6, 9, eye);
    set(buf, w, h, 11, 9, eye);
  }
  drawHair(buf, w, h, r, false);
  rect(buf, w, h, 7, 16, 10, 18, skinSh);
}

function drawHair(buf: Buf, w: number, h: number, r: Recipe, back: boolean): void {
  const hi = shade(r.hair, 1.25);
  const sh = shade(r.hair, 0.7);
  switch (r.hairStyle) {
    case 'tuft':
      rect(buf, w, h, 5, 3, 12, 5, r.hair);
      set(buf, w, h, 7, 2, r.hair);
      set(buf, w, h, 9, 2, hi);
      set(buf, w, h, 11, 3, hi);
      break;
    case 'ponytail':
      rect(buf, w, h, 4, 3, 13, 6, r.hair);
      rect(buf, w, h, 12, 7, 14, 17, r.hair);
      rect(buf, w, h, 13, 18, 15, 21, sh);
      set(buf, w, h, 5, 3, hi);
      break;
    case 'short':
      rect(buf, w, h, 4, 3, 13, 5, r.hair);
      rect(buf, w, h, 4, 6, 5, 8, r.hair);
      rect(buf, w, h, 12, 6, 13, 8, sh);
      break;
    case 'cap':
      rect(buf, w, h, 4, 4, 13, 6, r.hair);
      rect(buf, w, h, 3, 6, 14, 7, r.hair);
      rect(buf, w, h, 5, 3, 12, 4, shade(r.shirt, 0.75));
      break;
    case 'bald':
      rect(buf, w, h, 5, 3, 12, 4, shade(r.skin, 1.08));
      set(buf, w, h, 8, 3, [250, 240, 208]);
      set(buf, w, h, 4, 8, r.hair);
      set(buf, w, h, 13, 8, r.hair);
      break;
    default:
      if (back) rect(buf, w, h, 4, 3, 13, 12, r.hair);
      break;
  }
}

function drawRobotHead(buf: Buf, w: number, h: number, r: Recipe, back: boolean): void {
  const hi = shade(r.skin, 1.18);
  const sh = shade(r.skin, 0.68);
  rect(buf, w, h, 5, 5, 12, 15, r.skin);
  rect(buf, w, h, 6, 3, 11, 5, r.skin);
  rect(buf, w, h, 6, 6, 7, 14, hi);
  rect(buf, w, h, 11, 6, 12, 14, sh);
  if (r.antenna) {
    rect(buf, w, h, 8, 0, 9, 3, r.skin);
    set(buf, w, h, 8, 0, hi);
    set(buf, w, h, 9, 0, hi);
  }
  if (!back) {
    rect(buf, w, h, 6, 8, 11, 10, [238, 228, 160]);
    set(buf, w, h, 7, 9, [48, 52, 56]);
    set(buf, w, h, 10, 9, [48, 52, 56]);
    rect(buf, w, h, 6, 13, 11, 13, [68, 72, 78]);
  }
}

function drawZoidbergHead(buf: Buf, w: number, h: number, r: Recipe, back: boolean): void {
  const hi = shade(r.skin, 1.12);
  const sh = shade(r.skin, 0.68);
  rect(buf, w, h, 5, 5, 12, 14, r.skin);
  rect(buf, w, h, 6, 4, 11, 5, r.skin);
  rect(buf, w, h, 4, 8, 5, 13, r.skin);
  rect(buf, w, h, 12, 8, 13, 13, sh);
  if (!back) {
    set(buf, w, h, 6, 8, [245, 240, 220]);
    set(buf, w, h, 10, 8, [245, 240, 220]);
    set(buf, w, h, 7, 8, [38, 32, 36]);
    set(buf, w, h, 11, 8, [38, 32, 36]);
    for (const x of [6, 8, 10, 12]) rect(buf, w, h, x, 13, x, 17, sh);
    rect(buf, w, h, 7, 15, 11, 15, hi);
  }
}

function drawBody(buf: Buf, w: number, h: number, r: Recipe, scene: boolean, phase: number, back: boolean): void {
  const y0 = scene ? 18 : 18;
  const y1 = scene ? 24 : 27;
  const shirt = r.labCoat ? [232, 235, 224] as RGB : r.shirt;
  rect(buf, w, h, 4, y0, 13, y1, shirt);
  rect(buf, w, h, 3, y0 + 1, 14, y1 - 1, shirt);
  rect(buf, w, h, 13, y0 + 1, 14, y1, shade(shirt, 0.72));
  if (r.labCoat && !back) {
    rect(buf, w, h, 7, y0, 10, y1, r.shirt);
    rect(buf, w, h, 8, y0 + 1, 9, y1, [238, 238, 232]);
  }
  if (!scene) return;
  const pants = r.shape === 'robot' ? shade(r.skin, 0.82) : r.pants;
  rect(buf, w, h, 5, 25, 7, 30, pants);
  rect(buf, w, h, 10, 25, 12, 30, shade(pants, 0.82));
  rect(buf, w, h, 5, phase === 1 ? 30 : 31, 7, phase === 1 ? 30 : 31, [42, 42, 50]);
  rect(buf, w, h, 10, phase === 2 ? 30 : 31, 12, phase === 2 ? 30 : 31, [42, 42, 50]);
}

function compose(name: PlanetExpressCharacterName, scene: boolean, phase: number, back: boolean): Buf {
  const w = scene ? SCENE_W : PORTRAIT_W;
  const h = scene ? SCENE_H : PORTRAIT_H;
  const buf = new Uint8ClampedArray(w * h * 4);
  const r = RECIPES[name];
  drawBody(buf, w, h, r, scene, phase, back);
  if (r.shape === 'robot') drawRobotHead(buf, w, h, r, back);
  else if (r.shape === 'zoidberg') drawZoidbergHead(buf, w, h, r, back);
  else drawHumanHead(buf, w, h, r, back);
  outline(buf, w, h);
  return buf;
}

const portraitCache = new Map<PlanetExpressCharacterName, Buf>();
const sceneCache = new Map<PlanetExpressCharacterName, SceneFrames>();

function getPortraitBuf(name: PlanetExpressCharacterName): Buf {
  let buf = portraitCache.get(name);
  if (!buf) {
    buf = compose(name, false, 0, false);
    portraitCache.set(name, buf);
  }
  return buf;
}

export function planetExpressSceneFrameBufs(name: PlanetExpressCharacterName): SceneFrames {
  let frames = sceneCache.get(name);
  if (!frames) {
    frames = {
      front: [compose(name, true, 0, false), compose(name, true, 1, false), compose(name, true, 2, false)],
      back: [compose(name, true, 0, true), compose(name, true, 1, true), compose(name, true, 2, true)],
    };
    sceneCache.set(name, frames);
  }
  return frames;
}

export function paintPlanetExpressPortrait(
  ctx: CanvasRenderingContext2D,
  name: PlanetExpressCharacterName,
  scale = 2,
): void {
  const buf = getPortraitBuf(name);
  const stage = document.createElement('canvas');
  stage.width = PORTRAIT_W;
  stage.height = PORTRAIT_H;
  const sctx = stage.getContext('2d')!;
  const img = sctx.createImageData(PORTRAIT_W, PORTRAIT_H);
  img.data.set(buf);
  sctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, PORTRAIT_W * scale, PORTRAIT_H * scale);
  ctx.drawImage(stage, 0, 0, PORTRAIT_W, PORTRAIT_H, 0, 0, PORTRAIT_W * scale, PORTRAIT_H * scale);
}

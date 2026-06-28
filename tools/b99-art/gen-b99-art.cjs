#!/usr/bin/env node
/*
 * gen-b99-art.cjs — Brooklyn Nine-Nine office theme: ORIGINAL pixel art generator.
 *
 * Emits, with ZERO external deps (pure Node `zlib` PNG encoder):
 *   - 8 character sprite sheets  -> src/renderer/src/assets/sprites/brooklyn99/<key>.png
 *       108x96 each = 3 rows (down/up/right) x 6 cols (walk1,walk2,walk3,type,read1,read2),
 *       18x32 frame, transparent RGBA. Matches CharacterSprite's 3-row grid (left = flipped right).
 *   - 1 tileset atlas            -> src/renderer/src/assets/tilesets/brooklyn99-precinct.png
 *       256x96, 16x16 tiles, 16 cols, tilecount 96. Local-index GID map per ART-CONTRACT.md.
 *
 * Every pixel is authored here from scratch — no copyrighted game/show sprite is copied or
 * traced. The art EVOKES each character/room. License-clean & reproducible: re-run to rebuild.
 *
 * Run:  node tools/b99-art/gen-b99-art.cjs
 */
'use strict';
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ── PNG encoder (8-bit RGBA, filter 0) ───────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  return Buffer.concat([u32(data.length), body, u32(crc32(body))]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ── canvas helper ─────────────────────────────────────────────────────────────
function Canvas(w, h) {
  const data = Buffer.alloc(w * h * 4); // transparent
  const set = (x, y, c) => {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= w || y >= h || !c) return;
    const a = c[3] === undefined ? 255 : c[3];
    const i = (y * w + x) * 4;
    if (a >= 255) { data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255; return; }
    const sa = a / 255, da = data[i + 3] / 255, oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    data[i] = Math.round((c[0] * sa + data[i] * da * (1 - sa)) / oa);
    data[i + 1] = Math.round((c[1] * sa + data[i + 1] * da * (1 - sa)) / oa);
    data[i + 2] = Math.round((c[2] * sa + data[i + 2] * da * (1 - sa)) / oa);
    data[i + 3] = Math.round(oa * 255);
  };
  const rect = (x, y, rw, rh, c) => { for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) set(xx, yy, c); };
  const hline = (x0, x1, y, c) => { for (let x = x0; x <= x1; x++) set(x, y, c); };
  const vline = (x, y0, y1, c) => { for (let y = y0; y <= y1; y++) set(x, y, c); };
  return { w, h, data, set, rect, hline, vline };
}

// ── colour helpers ────────────────────────────────────────────────────────────
const OUTLINE = [38, 34, 46];
const lt = (c, d) => [Math.min(255, c[0] + d), Math.min(255, c[1] + d), Math.min(255, c[2] + d)];
const dk = (c, d) => [Math.max(0, c[0] - d), Math.max(0, c[1] - d), Math.max(0, c[2] - d)];

const SKIN = {
  light: { base: [233, 194, 160], sh: [205, 162, 128], line: [150, 108, 86] },
  tan:   { base: [196, 146, 104], sh: [166, 118, 82],  line: [116, 80, 54] },
  mid:   { base: [176, 128, 92],  sh: [146, 102, 72],  line: [100, 68, 46] },
  deep:  { base: [126, 86, 60],   sh: [98, 64, 44],    line: [66, 44, 30] },
};

// Character recipes — original silhouettes/palettes that EVOKE the cast.
const CHARS = {
  holt:      { skin: 'deep',  hair: [120, 120, 126], style: 'fringe',  shirt: [60, 62, 74],  accent: [78, 96, 134], glasses: true,  build: 'norm', brow: 'flat' },
  jake:      { skin: 'light', hair: [74, 50, 32],    style: 'messy',   shirt: [42, 54, 88],  jacket: [96, 62, 38],  glasses: false, build: 'norm', brow: 'soft' },
  amy:       { skin: 'tan',   hair: [46, 34, 28],    style: 'ponytail',shirt: [42, 122, 120],accent: [236, 236, 238], glasses: false, build: 'slim', brow: 'soft' },
  rosa:      { skin: 'tan',   hair: [34, 30, 38],    style: 'wavy',    shirt: [46, 44, 52],  accent: [122, 42, 42], glasses: false, build: 'norm', brow: 'flat' },
  terry:     { skin: 'deep',  hair: null,            style: 'bald',    shirt: [150, 152, 158],accent: [44, 52, 86],  glasses: false, build: 'big',  brow: 'flat' },
  charles:   { skin: 'light', hair: [96, 72, 48],    style: 'thin',    shirt: [184, 152, 104],accent: [112, 122, 80], glasses: false, build: 'norm', brow: 'raised' },
  hitchcock: { skin: 'light', hair: [150, 150, 156], style: 'side',    shirt: [188, 166, 122],glasses: false, build: 'big',  brow: 'soft' },
  scully:    { skin: 'light', hair: [142, 142, 148], style: 'balding', shirt: [150, 176, 200],accent: [120, 120, 128], glasses: true, build: 'big',  brow: 'soft' },
};

// ── character drawing ─────────────────────────────────────────────────────────
// Frame-local coords: 18 wide x 32 tall. Centre x=8.5 (head x5..12). Feet at bottom.
const F_W = 18, F_H = 32;

function drawHair(cv, ox, oy, rec, dir) {
  if (!rec.hair) { // bald: just a slight crown shade
    if (dir !== 'up') return;
    cv.rect(ox + 5, oy + 3, 8, 3, dk(SKIN[rec.skin].base, 22));
    return;
  }
  const hi = lt(rec.hair, 26), base = rec.hair, sh = dk(rec.hair, 26);
  const top = oy + 2;
  if (dir === 'up') { // back of head — hair fills most of the skull
    cv.rect(ox + 4, top, 10, 9, base);
    cv.hline(ox + 4, ox + 13, top, sh); cv.hline(ox + 5, ox + 12, top + 1, hi);
    if (rec.style === 'ponytail') cv.rect(ox + 8, oy + 11, 2, 5, base);
    if (rec.style === 'wavy') { cv.rect(ox + 3, oy + 6, 2, 7, base); cv.rect(ox + 13, oy + 6, 2, 7, base); }
    return;
  }
  // front / side: crown + sides, leave the face open
  cv.rect(ox + 4, top, 10, 3, base);
  cv.hline(ox + 5, ox + 12, top, sh);
  cv.hline(ox + 5, ox + 11, top + 1, hi);
  switch (rec.style) {
    case 'fringe':  cv.hline(ox + 5, ox + 12, oy + 5, base); break;           // tidy receding grey fringe
    case 'messy':   for (const x of [5, 7, 9, 11, 12]) cv.set(ox + x, oy + 2, hi); cv.hline(ox + 4, ox + 5, oy + 5, base); cv.hline(ox + 12, ox + 13, oy + 5, base); break;
    case 'ponytail':cv.rect(ox + 4, oy + 5, 1, 4, base); cv.rect(ox + 13, oy + 5, 1, 4, base); cv.rect(ox + (dir === 'right' ? 4 : 13), oy + 5, 2, 6, base); break;
    case 'wavy':    cv.rect(ox + 3, oy + 4, 2, 9, base); cv.rect(ox + 13, oy + 4, 2, 9, base); cv.hline(ox + 4, ox + 13, oy + 5, base); break;
    case 'thin':    cv.hline(ox + 5, ox + 8, top, base); cv.hline(ox + 4, ox + 5, oy + 5, base); cv.hline(ox + 12, ox + 13, oy + 5, base); break; // thinning
    case 'side':    cv.hline(ox + 4, ox + 9, oy + 4, base); cv.rect(ox + 4, oy + 5, 1, 3, base); break; // comb-over side fringe
    case 'balding': cv.rect(ox + 4, oy + 6, 1, 4, base); cv.rect(ox + 13, oy + 6, 1, 4, base); cv.hline(ox + 4, ox + 5, top, base); cv.hline(ox + 12, ox + 13, top, base); break;
    default: break;
  }
}

function drawHead(cv, ox, oy, rec, dir) {
  const s = SKIN[rec.skin];
  // head block
  cv.rect(ox + 5, oy + 3, 8, 11, s.base);
  // jaw/cheek shading on the shadow side
  cv.vline(ox + 12, oy + 4, oy + 12, s.sh);
  cv.hline(ox + 5, ox + 12, oy + 13, s.sh);
  // outline silhouette
  cv.hline(ox + 5, ox + 12, oy + 2, OUTLINE);
  cv.vline(ox + 4, oy + 3, oy + 13, OUTLINE);
  cv.vline(ox + 13, oy + 3, oy + 13, OUTLINE);
  if (dir === 'up') { drawHair(cv, ox, oy, rec, dir); cv.hline(ox + 7, ox + 10, oy + 13, s.line); return; }
  // ears
  cv.set(ox + 4, oy + 8, s.sh); cv.set(ox + 13, oy + 8, s.sh);
  if (dir === 'right') {
    // profile: features pushed to the right, nose bump, single eye, back-hair on left
    cv.set(ox + 13, oy + 8, s.base); cv.set(ox + 14, oy + 9, s.base); // nose
    cv.set(ox + 11, oy + 8, [250, 248, 244]); cv.set(ox + 11, oy + 8, [40, 36, 44]);
    cv.set(ox + 10, oy + 8, [40, 36, 44]);
    if (rec.brow !== 'soft') cv.hline(ox + 9, ox + 11, oy + 6, s.line);
    cv.hline(ox + 11, ox + 12, oy + 11, [150, 86, 80]); // mouth
  } else {
    // front: two eyes + brow + mouth
    cv.set(ox + 6, oy + 8, [250, 248, 244]); cv.set(ox + 7, oy + 8, [40, 36, 44]);
    cv.set(ox + 10, oy + 8, [250, 248, 244]); cv.set(ox + 11, oy + 8, [40, 36, 44]);
    const browY = rec.brow === 'raised' ? oy + 6 : oy + 7;
    if (rec.brow === 'flat') { cv.hline(ox + 6, ox + 7, browY, s.line); cv.hline(ox + 10, ox + 11, browY, s.line); }
    else if (rec.brow === 'raised') { cv.set(ox + 6, browY, s.line); cv.set(ox + 11, browY, s.line); }
    else { cv.set(ox + 6, browY, s.sh); cv.set(ox + 11, browY, s.sh); }
    cv.hline(ox + 8, ox + 9, oy + 11, [150, 86, 80]); // mouth
    cv.set(ox + 9, oy + 9, s.sh); // nose
  }
  drawHair(cv, ox, oy, rec, dir);
  if (rec.glasses && dir !== 'up') {
    const g = [44, 42, 52];
    if (dir === 'right') { cv.rect(ox + 9, oy + 7, 3, 3, null); cv.hline(ox + 9, ox + 12, oy + 7, g); cv.hline(ox + 9, ox + 11, oy + 9, g); cv.vline(ox + 9, oy + 7, oy + 9, g); }
    else { cv.hline(ox + 5, ox + 8, oy + 7, g); cv.hline(ox + 9, ox + 12, oy + 7, g); cv.set(ox + 8, oy + 8, g); cv.vline(ox + 5, oy + 7, oy + 9, g); cv.vline(ox + 12, oy + 7, oy + 9, g); cv.hline(ox + 5, ox + 6, oy + 9, g); cv.hline(ox + 11, ox + 12, oy + 9, g); }
  }
}

function drawBody(cv, ox, oy, rec, dir, pose) {
  const s = SKIN[rec.skin];
  const big = rec.build === 'big', slim = rec.build === 'slim';
  const x0 = big ? ox + 2 : slim ? ox + 5 : ox + 4;
  const x1 = big ? ox + 15 : slim ? ox + 12 : ox + 13;
  const shirt = rec.shirt, sHi = lt(shirt, 22), sSh = dk(shirt, 26);
  const jacket = rec.jacket || rec.accent;
  const TOP = oy + 14, BOT = oy + 24;
  // neck
  cv.rect(ox + 7, oy + 13, 4, 2, s.sh);
  // torso
  cv.rect(x0, TOP, x1 - x0 + 1, BOT - TOP + 1, shirt);
  cv.vline(x0, TOP, BOT, sSh); cv.vline(x1, TOP, BOT, sSh);
  cv.hline(x0, x1, TOP, sHi);
  // jacket / cardigan / leather: open panels down the sides + collar
  if (rec.jacket || (rec.accent && ['rosa', 'holt', 'charles', 'scully', 'terry'].includes(rec._key))) {
    const j = jacket, jSh = dk(j, 24);
    cv.rect(x0, TOP, 2, BOT - TOP + 1, j); cv.rect(x1 - 1, TOP, 2, BOT - TOP + 1, j);
    cv.set(x0, TOP, jSh); cv.set(x1, TOP, jSh);
    if (dir !== 'up') { cv.set(ox + 6, TOP, j); cv.set(ox + 11, TOP, j); } // lapels
  }
  // tie (Holt/Scully) or collar accent on front
  if (dir === 'down' && (rec._key === 'holt' || rec._key === 'scully')) {
    const tie = rec._key === 'holt' ? [70, 88, 128] : [120, 120, 128];
    cv.vline(ox + 8, TOP + 1, BOT - 1, tie); cv.set(ox + 9, TOP + 1, tie);
  }
  if (dir === 'down' && rec._key === 'amy') { cv.vline(ox + 8, TOP + 1, oy + 19, rec.accent); } // blouse placket
  if (dir === 'down' && rec._key === 'terry') { cv.vline(ox + 6, TOP, BOT, rec.accent); cv.vline(ox + 11, TOP, BOT, rec.accent); } // suspenders

  // arms — swing with the walk pose; forward for type/read
  const sleeve = rec.jacket ? dk(jacket, 10) : shirt;
  const armY = TOP + 1;
  const swing = pose === 'walk2' ? 1 : pose === 'walk3' ? -1 : 0;
  // left arm
  cv.rect(x0 - 1, armY + Math.max(0, swing), 2, 6, sleeve);
  cv.set(x0 - 1, armY + 6 + Math.max(0, swing), s.base);
  // right arm
  cv.rect(x1, armY + Math.max(0, -swing), 2, 6, sleeve);
  cv.set(x1 + 1, armY + 6 + Math.max(0, -swing), s.base);

  if (pose === 'type') {
    // forearms forward toward a desk (front-low)
    cv.rect(ox + 6, oy + 21, 2, 2, sleeve); cv.rect(ox + 10, oy + 21, 2, 2, sleeve);
    cv.set(ox + 6, oy + 23, s.base); cv.set(ox + 11, oy + 23, s.base);
  } else if (pose === 'read1' || pose === 'read2') {
    // hold a folder/tablet at chest; read2 raised one px
    const ry = pose === 'read2' ? oy + 16 : oy + 17;
    cv.rect(ox + 7, ry, 5, 4, [222, 210, 180]); // manila folder
    cv.hline(ox + 7, ox + 11, ry, [196, 182, 150]);
    cv.set(ox + 8, ry + 1, [120, 120, 126]); cv.set(ox + 10, ry + 2, [120, 120, 126]); // text lines
    cv.set(ox + 6, ry + 1, s.base); cv.set(ox + 12, ry + 1, s.base); // thumbs
  }

  // legs + shoes
  const pants = (rec._key === 'jake') ? [78, 96, 120] : (rec._key === 'amy') ? [40, 48, 74] : dk(shirt, 60);
  const pSh = dk(pants, 22), shoe = [42, 40, 48];
  let lL = oy + 25, lR = oy + 25; // leg top offsets per stride
  if (pose === 'walk2') { lL = oy + 25; lR = oy + 26; }
  else if (pose === 'walk3') { lL = oy + 26; lR = oy + 25; }
  const legW = big ? 3 : 2;
  const lx = ox + 6, rx = big ? ox + 9 : ox + 10;
  cv.rect(lx, lL, legW, oy + 30 - lL, pants); cv.vline(lx, lL, oy + 29, pSh);
  cv.rect(rx, lR, legW, oy + 30 - lR, pants); cv.vline(rx + legW - 1, lR, oy + 29, pSh);
  cv.rect(lx, oy + 30, legW + 1, 2, shoe);
  cv.rect(rx, oy + 30, legW + 1, 2, shoe);
}

function drawFrame(cv, ox, oy, rec, dir, pose) {
  drawBody(cv, ox, oy, rec, dir, pose);
  drawHead(cv, ox, oy, rec, dir);
}

const ROWS = ['down', 'up', 'right'];
const COLS = ['walk1', 'walk2', 'walk3', 'type', 'read1', 'read2'];

function buildCharacterSheet(key) {
  const rec = Object.assign({ _key: key }, CHARS[key]);
  const cv = Canvas(F_W * 6, F_H * 3);
  ROWS.forEach((dir, r) => COLS.forEach((pose, c) => {
    drawFrame(cv, c * F_W, r * F_H, rec, dir, pose);
  }));
  return encodePNG(cv.w, cv.h, cv.data);
}

// ── tileset drawing ───────────────────────────────────────────────────────────
const TILE = 16, ATLAS_COLS = 16, ATLAS_ROWS = 6;
const P = {
  wall: [86, 104, 108], wallSh: [66, 82, 86], wallHi: [110, 128, 132],
  wood: [150, 104, 60], woodSh: [120, 80, 44], woodHi: [176, 128, 78],
  steel: [150, 156, 166], steelSh: [112, 118, 130], steelHi: [186, 192, 202],
  navy: [40, 52, 86], glass: [150, 196, 206], glassHi: [196, 226, 232],
  cork: [176, 134, 88], corkSh: [146, 108, 68], red: [188, 56, 52],
  concrete: [120, 122, 128], concreteSh: [98, 100, 108], white: [232, 232, 230],
  black: [40, 40, 48], screen: [44, 120, 120], screenOff: [50, 54, 64], paper: [228, 220, 198],
};
function tilePos(idx) { return [(idx % ATLAS_COLS) * TILE, Math.floor(idx / ATLAS_COLS) * TILE]; }

const TILES = {
  // holding-cell bars 0..5
  0: (cv, x, y) => { for (let bx = 1; bx < 16; bx += 4) cv.rect(x + bx, y, 2, 16, P.steel), cv.vline(x + bx, y, y + 15, P.steelHi); },
  1: (cv, x, y) => { cv.rect(x, y + 1, 16, 2, P.steel); cv.hline(x, x + 15, y + 1, P.steelHi); for (let bx = 1; bx < 16; bx += 4) cv.rect(x + bx, y + 3, 2, 13, P.steel); },
  2: (cv, x, y) => { cv.rect(x + 1, y + 1, 14, 2, P.steel); cv.rect(x + 1, y + 1, 2, 14, P.steel); cv.set(x + 1, y + 1, P.steelHi); },
  3: (cv, x, y) => { cv.rect(x + 1, y + 1, 14, 2, P.steel); cv.rect(x + 13, y + 1, 2, 14, P.steel); cv.set(x + 14, y + 1, P.steelHi); },
  4: (cv, x, y) => { cv.rect(x + 1, y, 14, 16, P.steelSh); for (let bx = 3; bx < 14; bx += 3) cv.rect(x + bx, y, 2, 16, P.steel); cv.rect(x + 10, y + 7, 2, 2, P.steelHi); }, // barred door + handle
  5: (cv, x, y) => { cv.rect(x, y, 16, 16, P.concrete); for (let i = 0; i < 5; i++) cv.set(x + (i * 5 + 2) % 16, y + (i * 7 + 3) % 16, P.concreteSh); cv.hline(x, x + 15, y + 8, P.concreteSh); },
  // interrogation table + chair + one-way mirror 16..21
  16: (cv, x, y) => { cv.rect(x + 2, y + 5, 14, 6, P.steel); cv.hline(x + 2, x + 15, y + 5, P.steelHi); cv.rect(x + 3, y + 11, 2, 5, P.steelSh); },
  17: (cv, x, y) => { cv.rect(x, y + 5, 14, 6, P.steel); cv.hline(x, x + 13, y + 5, P.steelHi); cv.rect(x + 11, y + 11, 2, 5, P.steelSh); },
  18: (cv, x, y) => { cv.rect(x + 4, y + 2, 8, 2, P.steelSh); cv.rect(x + 4, y + 4, 8, 7, P.steel); cv.rect(x + 5, y + 11, 2, 5, P.steelSh); cv.rect(x + 9, y + 11, 2, 5, P.steelSh); },
  19: (cv, x, y) => { cv.rect(x + 1, y + 1, 15, 14, P.glass); cv.hline(x + 1, x + 15, y + 1, P.glassHi); cv.rect(x + 2, y + 2, 5, 5, P.glassHi); cv.vline(x + 1, y + 1, y + 14, P.steelSh); },
  20: (cv, x, y) => { cv.rect(x, y + 1, 15, 14, P.glass); cv.hline(x, x + 14, y + 1, P.glassHi); cv.rect(x + 9, y + 7, 5, 5, dk(P.glass, 20)); cv.vline(x + 14, y + 1, y + 14, P.steelSh); },
  21: (cv, x, y) => { cv.rect(x + 6, y, 4, 16, P.steelSh); cv.vline(x + 7, y, y + 15, P.steel); },
  // holt glass wall 32..36
  32: (cv, x, y) => { cv.rect(x, y + 2, 16, 13, P.glass); for (let gx = 1; gx < 16; gx += 5) cv.rect(x + gx, y + 3, 3, 4, P.glassHi); cv.hline(x, x + 15, y + 2, P.steelHi); cv.hline(x, x + 15, y + 14, P.steelSh); },
  33: (cv, x, y) => { cv.rect(x + 6, y, 4, 16, P.steel); cv.vline(x + 6, y, y + 15, P.steelHi); cv.vline(x + 9, y, y + 15, P.steelSh); },
  34: (cv, x, y) => { cv.rect(x + 1, y, 14, 16, P.steel); cv.rect(x + 2, y + 2, 11, 9, P.glass); cv.rect(x + 3, y + 3, 4, 4, P.glassHi); cv.rect(x + 11, y + 7, 2, 2, P.navy); }, // glass door + handle
  35: (cv, x, y) => { cv.rect(x, y + 2, 16, 13, P.glass); cv.rect(x, y + 2, 4, 13, P.wallSh); cv.vline(x + 4, y + 2, y + 14, P.steel); },
  36: (cv, x, y) => { cv.rect(x, y + 6, 16, 10, P.wood); cv.hline(x, x + 15, y + 6, P.woodHi); cv.rect(x + 4, y + 8, 8, 3, [196, 182, 150]); cv.hline(x + 5, x + 10, y + 9, P.navy); }, // nameplate desk front "CAPT. HOLT"
  // break room 48..53
  48: (cv, x, y) => { cv.rect(x, y + 4, 16, 6, P.wood); cv.hline(x, x + 15, y + 4, P.woodHi); cv.rect(x, y + 10, 16, 6, P.woodSh); },
  49: (cv, x, y) => { cv.rect(x + 2, y, 12, 8, P.steelHi); cv.rect(x + 2, y, 12, 8, null); cv.vline(x + 2, y, y + 7, P.steelSh); cv.vline(x + 13, y, y + 7, P.steelSh); cv.hline(x + 2, x + 13, y, P.steelSh); cv.rect(x + 11, y + 2, 1, 4, P.steel); },
  50: (cv, x, y) => { cv.rect(x + 2, y, 12, 14, P.steelHi); cv.vline(x + 2, y, y + 13, P.steelSh); cv.vline(x + 13, y, y + 13, P.steelSh); cv.rect(x + 11, y + 2, 1, 4, P.steel); cv.hline(x + 2, x + 13, y, P.steelSh); },
  51: (cv, x, y) => { cv.rect(x + 2, y + 4, 12, 8, P.black); cv.rect(x + 3, y + 5, 8, 6, P.steelSh); cv.rect(x + 12, y + 5, 1, 6, P.steel); cv.set(x + 12, y + 6, P.red); },
  52: (cv, x, y) => { cv.rect(x, y + 4, 16, 6, P.steel); cv.rect(x + 5, y + 5, 6, 4, P.steelSh); cv.rect(x + 7, y + 1, 2, 4, P.steel); },
  53: (cv, x, y) => { cv.rect(x + 3, y + 1, 10, 14, P.black); cv.rect(x + 4, y + 2, 8, 5, P.steelSh); cv.rect(x + 5, y + 9, 6, 4, [60, 44, 36]); cv.set(x + 11, y + 3, P.red); }, // coffee machine + pot
  // bullpen detective desk 64..69
  64: (cv, x, y) => { cv.rect(x, y + 6, 16, 7, P.wood); cv.hline(x, x + 15, y + 6, P.woodHi); cv.rect(x, y + 13, 16, 3, P.woodSh); cv.rect(x + 2, y + 8, 5, 4, P.paper); },
  65: (cv, x, y) => { cv.rect(x, y + 6, 16, 7, P.wood); cv.hline(x, x + 15, y + 6, P.woodHi); cv.rect(x, y + 13, 16, 3, P.woodSh); cv.rect(x + 9, y + 8, 4, 3, [120, 120, 128]); },
  66: (cv, x, y) => { cv.rect(x + 3, y + 1, 10, 8, P.black); cv.rect(x + 4, y + 2, 8, 6, P.screenOff); cv.rect(x + 7, y + 9, 2, 3, P.steelSh); cv.rect(x + 5, y + 12, 6, 2, P.steel); },
  67: (cv, x, y) => { cv.rect(x + 3, y + 1, 10, 8, P.black); cv.rect(x + 4, y + 2, 8, 6, P.screen); cv.hline(x + 5, x + 10, y + 4, P.glassHi); cv.rect(x + 7, y + 9, 2, 3, P.steelSh); cv.rect(x + 5, y + 12, 6, 2, P.steel); },
  68: (cv, x, y) => { cv.rect(x + 4, y + 2, 8, 6, P.navy); cv.hline(x + 4, x + 11, y + 2, lt(P.navy, 26)); cv.rect(x + 7, y + 8, 2, 4, P.black); cv.rect(x + 4, y + 12, 8, 2, P.black); },
  69: (cv, x, y) => { for (let i = 0; i < 4; i++) cv.rect(x + 3, y + 12 - i * 3, 10, 3, i % 2 ? P.paper : [206, 196, 172]), cv.hline(x + 3, x + 12, y + 12 - i * 3, P.woodSh); },
  // case board 80..85
  80: (cv, x, y) => { cv.rect(x + 1, y + 1, 14, 14, P.cork); cv.rect(x + 1, y + 1, 14, 14, null); for (let i = 0; i < 6; i++) cv.set(x + 2 + (i * 5) % 13, y + 2 + (i * 3) % 13, P.corkSh); cv.hline(x + 1, x + 14, y + 1, lt(P.cork, 20)); },
  81: (cv, x, y) => { cv.rect(x + 1, y + 1, 14, 14, P.cork); cv.rect(x + 2, y + 2, 4, 4, P.white); cv.rect(x + 9, y + 3, 4, 4, P.white); cv.rect(x + 5, y + 9, 4, 4, P.white); cv.set(x + 3, y + 2, P.red); cv.set(x + 10, y + 3, P.red); },
  82: (cv, x, y) => { cv.rect(x + 1, y + 1, 14, 14, P.cork); cv.rect(x + 2, y + 2, 3, 3, P.white); cv.rect(x + 10, y + 4, 3, 3, P.white); cv.rect(x + 5, y + 10, 3, 3, P.white); for (let t = 0; t < 8; t++) cv.set(x + 3 + t, y + 3 + t, P.red); cv.set(x + 11, y + 5, P.red); },
  83: (cv, x, y) => { cv.rect(x + 1, y + 1, 14, 14, P.white); cv.rect(x + 1, y + 1, 14, 14, null); cv.hline(x + 1, x + 14, y + 1, [200, 200, 200]); cv.vline(x + 1, y + 1, y + 14, [200, 200, 200]); cv.rect(x + 12, y + 13, 2, 1, P.red); },
  84: (cv, x, y) => { cv.rect(x + 1, y + 1, 14, 14, P.white); cv.hline(x + 3, x + 11, y + 4, P.navy); cv.hline(x + 3, x + 9, y + 7, [120, 120, 128]); cv.hline(x + 3, x + 12, y + 10, P.red); cv.hline(x + 3, x + 8, y + 13, [120, 120, 128]); },
  85: (cv, x, y) => { cv.rect(x + 3, y + 1, 10, 14, P.paper); cv.hline(x + 4, x + 11, y + 3, P.black); cv.rect(x + 6, y + 5, 4, 4, P.steelSh); cv.hline(x + 4, x + 11, y + 12, P.black); }, // wanted poster
};

function buildTileset() {
  const cv = Canvas(ATLAS_COLS * TILE, ATLAS_ROWS * TILE);
  for (const [idx, fn] of Object.entries(TILES)) { const [x, y] = tilePos(+idx); fn(cv, x, y); }
  return encodePNG(cv.w, cv.h, cv.data);
}

// ── emit ──────────────────────────────────────────────────────────────────────
function main() {
  const root = path.resolve(__dirname, '..', '..');
  const spriteDir = path.join(root, 'src/renderer/src/assets/sprites/brooklyn99');
  const tileDir = path.join(root, 'src/renderer/src/assets/tilesets');
  fs.mkdirSync(spriteDir, { recursive: true });
  let n = 0;
  for (const key of Object.keys(CHARS)) {
    const png = buildCharacterSheet(key);
    fs.writeFileSync(path.join(spriteDir, `${key}.png`), png);
    console.log(`  sprite  ${key}.png            ${png.length} B  (108x96)`);
    n++;
  }
  const ts = buildTileset();
  fs.writeFileSync(path.join(tileDir, 'brooklyn99-precinct.png'), ts);
  console.log(`  tileset brooklyn99-precinct.png ${ts.length} B  (256x96)`);
  console.log(`Done: ${n} sheets + 1 tileset.`);
}
main();

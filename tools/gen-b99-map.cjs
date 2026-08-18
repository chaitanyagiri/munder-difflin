#!/usr/bin/env node
/**
 * Generates the original Precinct map and its procedural pixel-art atlas.
 * No external art is read: every pixel and every map placement is authored here.
 *
 *   node tools/gen-b99-map.cjs          write generated assets
 *   node tools/gen-b99-map.cjs --check  validate and verify assets are current
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 36, H = 24, TS = 16;
const ROOT = path.join(__dirname, '..');
const MAP_OUT = path.join(ROOT, 'src', 'renderer', 'src', 'assets', 'maps', 'brooklyn99.tmj');
const ATLAS_OUT = path.join(ROOT, 'src', 'renderer', 'src', 'assets', 'tilesets', 'precinct-tileset.png');
const ATLAS_COLS = 16, ATLAS_ROWS = 8;

// Atlas gids. IDs 65-84 intentionally mirror the monitor-block spacing expected
// by DeskScreen: two adjacent 2x2 off/on variants.
const G = {
  concreteA: 1, concreteB: 2, bullpenA: 3, bullpenB: 4,
  briefing: 5, operations: 6, breakroom: 7, evidence: 8, interrogation: 9,
  wall: 17, wallDark: 18, glassV: 19, glassH: 20, door: 21,
  deskL: 33, deskM: 34, deskR: 35, chair: 36, captainDesk: 37,
  briefingTable: 38, opsConsole: 39, cafeTable: 40, interrogationTable: 41,
  shelf: 49, evidenceRack: 50, fridge: 51, vending: 52, coffee: 53, copier: 54,
  couch: 55, plant: 56, bin: 57, filing: 58, lamp: 59, water: 60,
  monitorOffTL: 65, monitorOffTR: 66, monitorOnTL: 67, monitorOnTR: 68,
  monitorOffBL: 81, monitorOffBR: 82, monitorOnBL: 83, monitorOnBR: 84,
  briefingBoard: 97, opsMap: 98, captainPlaque: 99, evidenceSeal: 100,
  interviewRecorder: 101, elevatorL: 102, elevatorR: 103, window: 104,
};

// Theme-driven action destinations. Keeping them in the generator's validation
// set prevents furniture edits from silently stranding board or errand actors.
const INTERACTION_STANDS = {
  boardPin: { x: 14, y: 9 }, boardTake: { x: 16, y: 9 }, boardArchive: { x: 18, y: 9 },
  bullpenPlantA: { x: 13, y: 10 }, bullpenPlantB: { x: 25, y: 21 },
  captainPlant: { x: 29, y: 5 }, captainWindow: { x: 33, y: 2 },
  northWindowA: { x: 14, y: 9 }, northWindowB: { x: 23, y: 9 },
  bullpenWater: { x: 25, y: 15 }, operationsWater: { x: 10, y: 14 },
  breakFridge: { x: 34, y: 16 }, breakShelf: { x: 28, y: 16 }, bullpenBin: { x: 13, y: 21 },
};

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type);
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  name.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return out;
}

function makeAtlas() {
  const width = ATLAS_COLS * TS, height = ATLAS_ROWS * TS;
  const pixels = Buffer.alloc(width * height * 4);
  const palette = {
    ink: '#17232f', navy: '#22384b', blue: '#315b78', steel: '#638093',
    pale: '#b8ccd2', white: '#e6e4d9', tan: '#b79d78', wood: '#76563c',
    darkWood: '#4c382d', green: '#47735b', red: '#a8493f', yellow: '#d0a84c',
    glass: '#79b4bd', glassHi: '#bde3df', tile: '#76858a', black: '#0d151c',
  };
  const rgba = (hex, a = 255) => {
    const n = Number.parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
  };
  const dot = (x, y, color, a = 255) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    const c = rgba(color, a);
    pixels[i] = c[0]; pixels[i + 1] = c[1]; pixels[i + 2] = c[2]; pixels[i + 3] = c[3];
  };
  const tileOrigin = (gid) => [((gid - 1) % ATLAS_COLS) * TS, Math.floor((gid - 1) / ATLAS_COLS) * TS];
  const rect = (gid, x, y, w, h, color, a = 255) => {
    const [ox, oy] = tileOrigin(gid);
    for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) dot(ox + px, oy + py, color, a);
  };
  const line = (gid, x1, y1, x2, y2, color) => {
    let dx = Math.abs(x2 - x1), sx = x1 < x2 ? 1 : -1;
    let dy = -Math.abs(y2 - y1), sy = y1 < y2 ? 1 : -1, err = dx + dy;
    while (true) {
      rect(gid, x1, y1, 1, 1, color);
      if (x1 === x2 && y1 === y2) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x1 += sx; }
      if (e2 <= dx) { err += dx; y1 += sy; }
    }
  };
  const floor = (gid, base, fleck) => {
    rect(gid, 0, 0, 16, 16, base);
    for (let y = 1; y < 16; y += 4) for (let x = (y % 3) + 1; x < 16; x += 6) rect(gid, x, y, 1, 1, fleck);
    rect(gid, 0, 15, 16, 1, fleck, 80);
  };

  floor(G.concreteA, '#657278', '#839096'); floor(G.concreteB, '#6b777b', '#515e63');
  floor(G.bullpenA, '#516d77', '#68848b'); floor(G.bullpenB, '#4c6872', '#38555f');
  floor(G.briefing, '#655f58', '#80776c'); floor(G.operations, '#374f61', '#45677d');
  floor(G.breakroom, '#8a806f', '#a69a84'); floor(G.evidence, '#5e695f', '#778176');
  floor(G.interrogation, '#514f52', '#68656a');

  for (const gid of [G.wall, G.wallDark]) {
    rect(gid, 0, 0, 16, 16, gid === G.wall ? palette.navy : palette.ink);
    rect(gid, 0, 0, 16, 3, palette.steel); rect(gid, 0, 3, 16, 1, palette.pale);
    rect(gid, 0, 14, 16, 2, palette.black);
    rect(gid, 2, 7, 5, 1, palette.blue); rect(gid, 10, 10, 4, 1, palette.blue);
  }
  rect(G.glassV, 0, 0, 16, 16, palette.navy); rect(G.glassV, 5, 0, 7, 16, palette.glass, 190);
  rect(G.glassV, 6, 1, 1, 13, palette.glassHi); rect(G.glassV, 11, 0, 2, 16, palette.ink);
  rect(G.glassH, 0, 0, 16, 16, palette.navy); rect(G.glassH, 0, 5, 16, 7, palette.glass, 190);
  rect(G.glassH, 1, 6, 13, 1, palette.glassHi); rect(G.glassH, 0, 11, 16, 2, palette.ink);
  rect(G.door, 0, 0, 16, 16, palette.navy); rect(G.door, 3, 1, 10, 15, palette.tan); rect(G.door, 11, 8, 2, 2, palette.yellow);

  const desk = (gid, accent = palette.blue) => {
    rect(gid, 0, 2, 16, 10, palette.darkWood); rect(gid, 0, 2, 16, 3, palette.tan);
    rect(gid, 1, 5, 14, 6, palette.wood); rect(gid, 2, 11, 3, 5, palette.darkWood); rect(gid, 11, 11, 3, 5, palette.darkWood);
    rect(gid, 2, 6, 5, 1, accent);
  };
  desk(G.deskL); desk(G.deskM); desk(G.deskR); desk(G.captainDesk, palette.red);
  rect(G.chair, 3, 1, 10, 10, palette.ink); rect(G.chair, 5, 3, 6, 6, palette.blue); rect(G.chair, 7, 11, 2, 5, palette.black);
  for (const [gid, color] of [[G.briefingTable, palette.wood], [G.cafeTable, palette.tan], [G.interrogationTable, palette.steel]]) {
    rect(gid, 1, 3, 14, 9, palette.darkWood); rect(gid, 2, 2, 12, 8, color); rect(gid, 3, 11, 3, 5, palette.ink); rect(gid, 10, 11, 3, 5, palette.ink);
  }
  rect(G.opsConsole, 0, 4, 16, 12, palette.ink); rect(G.opsConsole, 2, 1, 12, 9, palette.steel);
  rect(G.opsConsole, 3, 2, 4, 4, '#77b9c8'); rect(G.opsConsole, 9, 2, 4, 4, '#d29d51'); rect(G.opsConsole, 4, 12, 8, 2, palette.blue);

  const cabinet = (gid, body, trim) => { rect(gid, 2, 0, 12, 16, palette.ink); rect(gid, 3, 1, 10, 14, body); rect(gid, 4, 4, 8, 1, trim); rect(gid, 4, 9, 8, 1, trim); };
  cabinet(G.shelf, palette.wood, palette.tan); cabinet(G.evidenceRack, palette.green, palette.yellow);
  cabinet(G.fridge, '#d5d3c8', palette.steel); rect(G.fridge, 10, 7, 1, 3, palette.ink);
  cabinet(G.vending, palette.blue, palette.glassHi); rect(G.vending, 5, 2, 6, 7, palette.black); rect(G.vending, 6, 3, 2, 2, palette.red); rect(G.vending, 9, 3, 2, 2, palette.yellow);
  rect(G.coffee, 2, 3, 12, 13, palette.ink); rect(G.coffee, 4, 1, 8, 9, palette.steel); rect(G.coffee, 6, 10, 5, 3, palette.white); rect(G.coffee, 5, 4, 6, 2, palette.black);
  cabinet(G.copier, palette.pale, palette.steel); rect(G.copier, 4, 1, 8, 3, palette.white);
  rect(G.couch, 0, 5, 16, 11, palette.ink); rect(G.couch, 1, 3, 14, 9, palette.red); rect(G.couch, 7, 4, 2, 8, palette.darkWood);
  rect(G.plant, 5, 10, 7, 6, palette.wood); rect(G.plant, 7, 3, 3, 9, palette.green); rect(G.plant, 3, 5, 5, 4, '#5f8d62'); rect(G.plant, 9, 1, 5, 5, '#6b9a67');
  rect(G.bin, 4, 5, 8, 11, palette.ink); rect(G.bin, 5, 6, 6, 9, palette.steel); rect(G.bin, 3, 4, 10, 2, palette.pale);
  cabinet(G.filing, palette.steel, palette.ink); rect(G.lamp, 7, 1, 2, 10, palette.yellow); rect(G.lamp, 4, 0, 8, 4, palette.white); rect(G.lamp, 4, 12, 8, 2, palette.ink);
  rect(G.water, 4, 7, 8, 9, palette.pale); rect(G.water, 5, 0, 6, 9, '#8bc5ce'); rect(G.water, 7, 10, 2, 2, palette.blue);

  const monitor = (tl, tr, bl, br, on) => {
    for (const gid of [tl, tr, bl, br]) rect(gid, 0, 0, 16, 16, palette.ink);
    rect(tl, 3, 4, 13, 12, on ? '#397fa2' : palette.black); rect(tr, 0, 4, 12, 12, on ? '#397fa2' : palette.black);
    rect(bl, 3, 0, 13, 3, on ? '#397fa2' : palette.black); rect(br, 0, 0, 12, 3, on ? '#397fa2' : palette.black);
    rect(tl, 5, 6, 9, 1, on ? palette.glassHi : palette.navy); rect(tr, 1, 8, 8, 1, on ? palette.white : palette.navy);
    rect(bl, 12, 4, 4, 3, palette.steel); rect(br, 0, 4, 4, 3, palette.steel);
  };
  monitor(G.monitorOffTL, G.monitorOffTR, G.monitorOffBL, G.monitorOffBR, false);
  monitor(G.monitorOnTL, G.monitorOnTR, G.monitorOnBL, G.monitorOnBR, true);

  const sign = (gid, bg, mark) => { rect(gid, 1, 2, 14, 11, palette.ink); rect(gid, 2, 3, 12, 9, bg); mark(); };
  sign(G.briefingBoard, palette.white, () => { line(G.briefingBoard, 4, 9, 7, 6, palette.blue); line(G.briefingBoard, 7, 6, 11, 8, palette.red); });
  sign(G.opsMap, palette.blue, () => { line(G.opsMap, 3, 9, 7, 5, palette.yellow); line(G.opsMap, 7, 5, 12, 9, palette.glassHi); });
  sign(G.captainPlaque, palette.darkWood, () => rect(G.captainPlaque, 5, 6, 6, 3, palette.yellow));
  sign(G.evidenceSeal, palette.green, () => { rect(G.evidenceSeal, 6, 5, 4, 5, palette.white); rect(G.evidenceSeal, 4, 7, 8, 1, palette.white); });
  sign(G.interviewRecorder, palette.interrogation ?? '#514f52', () => { rect(G.interviewRecorder, 5, 5, 6, 5, palette.black); rect(G.interviewRecorder, 7, 6, 2, 2, palette.red); });
  rect(G.elevatorL, 0, 0, 16, 16, palette.ink); rect(G.elevatorL, 3, 1, 13, 15, palette.steel); rect(G.elevatorL, 14, 1, 2, 15, palette.black); rect(G.elevatorL, 8, 4, 2, 6, palette.pale);
  rect(G.elevatorR, 0, 0, 16, 16, palette.ink); rect(G.elevatorR, 0, 1, 13, 15, palette.steel); rect(G.elevatorR, 0, 1, 2, 15, palette.black); rect(G.elevatorR, 6, 4, 2, 6, palette.pale);
  rect(G.window, 0, 0, 16, 16, palette.ink); rect(G.window, 2, 2, 12, 11, palette.glass); rect(G.window, 3, 3, 3, 8, palette.glassHi); rect(G.window, 0, 13, 16, 3, palette.steel);

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const mk = () => new Array(W * H).fill(0);
const idx = (x, y) => y * W + x;
const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;

function buildMap() {
  const L = { floor: mk(), walls: mk(), below: mk(), above: mk(), coll: mk() };
  const set = (layer, x, y, gid) => { if (inb(x, y)) L[layer][idx(x, y)] = gid; };
  const block = (x, y, gid = G.wall) => { set('walls', x, y, gid); set('coll', x, y, 1); };
  const open = (x, y) => { set('walls', x, y, 0); set('coll', x, y, 0); };
  const prop = (x, y, gid, solid = true, layer = 'above') => { set(layer, x, y, gid); if (solid) set('coll', x, y, 1); };

  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    let gid = (x + y) % 2 ? G.concreteA : G.concreteB;
    if (x <= 10 && y <= 7) gid = G.briefing;
    else if (x <= 10 && y >= 9 && y <= 15) gid = G.operations;
    else if (x <= 10 && y >= 17) gid = G.interrogation;
    else if (x >= 12 && x <= 26 && y >= 9) gid = (x + y) % 2 ? G.bullpenA : G.bullpenB;
    else if (x >= 28 && y >= 9 && y <= 16) gid = G.breakroom;
    else if (x >= 28 && y >= 18) gid = G.evidence;
    set('floor', x, y, gid);
  }

  for (let x = 0; x < W; x++) { block(x, 0); block(x, H - 1, G.wallDark); }
  for (let y = 0; y < H; y++) { block(0, y); block(W - 1, y); }
  const ENTRANCE = { x: 17, y: 22 };
  open(17, 23); open(18, 23); set('walls', 17, 23, G.elevatorL); set('walls', 18, 23, G.elevatorR);
  set('floor', 17, 23, G.concreteA); set('floor', 18, 23, G.concreteB);

  // Briefing, operations and interrogation rooms on the west side.
  for (let y = 1; y <= 7; y++) block(11, y);
  for (let x = 1; x <= 11; x++) block(x, 8);
  open(5, 8); open(6, 8);
  for (let y = 9; y <= 15; y++) block(11, y);
  open(11, 12); open(11, 13);
  for (let x = 1; x <= 11; x++) block(x, 16);
  open(8, 16); open(9, 16);
  for (let y = 17; y <= 22; y++) block(11, y);
  open(11, 20); open(11, 21);

  // Captain's office uses glass partitions; break/evidence rooms sit below it.
  for (let y = 1; y <= 8; y++) block(27, y, G.glassV);
  for (let x = 27; x <= 34; x++) block(x, 8, G.glassH);
  open(30, 8); open(31, 8);
  for (let y = 9; y <= 22; y++) block(27, y);
  open(27, 12); open(27, 13); open(27, 20); open(27, 21);
  for (let x = 28; x <= 34; x++) block(x, 17);
  open(31, 17); open(32, 17);

  const SEATS = {
    'desk-ceo': { x: 31, y: 5 },
    'pc-1': { x: 13, y: 13 }, 'pc-2': { x: 17, y: 13 }, 'pc-3': { x: 21, y: 13 }, 'pc-4': { x: 25, y: 13 },
    'pc-5': { x: 13, y: 19 }, 'pc-6': { x: 17, y: 19 }, 'pc-7': { x: 21, y: 19 }, 'pc-8': { x: 25, y: 19 },
  };
  const deskStamp = (s, captain = false) => {
    prop(s.x - 1, s.y - 1, G.deskL); prop(s.x, s.y - 1, captain ? G.captainDesk : G.deskM); prop(s.x + 1, s.y - 1, G.deskR);
    set('above', s.x, s.y - 2, G.monitorOffTL); set('above', s.x + 1, s.y - 2, G.monitorOffTR);
    set('above', s.x, s.y - 1, G.monitorOffBL); set('above', s.x + 1, s.y - 1, G.monitorOffBR);
    set('below', s.x, s.y, G.chair); set('coll', s.x, s.y, 0);
  };
  for (const [name, seat] of Object.entries(SEATS)) deskStamp(seat, name === 'desk-ceo');

  // Briefing room: long case table, wall board, files and presentation lamp.
  prop(4, 4, G.briefingTable); prop(5, 4, G.briefingTable); prop(6, 4, G.briefingTable); prop(7, 4, G.briefingTable);
  prop(2, 2, G.filing); prop(9, 2, G.lamp); set('above', 5, 1, G.briefingBoard);
  // Distinct operations area: blue floor, map wall, radio/dispatch console and copier bank.
  set('above', 4, 9, G.opsMap); prop(3, 12, G.opsConsole); prop(4, 12, G.opsConsole); prop(5, 12, G.opsConsole);
  prop(2, 14, G.copier); prop(7, 14, G.filing); prop(9, 14, G.water);
  // Interrogation: sparse steel table, recorder, observation glass and waiting couch.
  prop(4, 19, G.interrogationTable); prop(5, 19, G.interrogationTable); prop(6, 19, G.interrogationTable);
  set('above', 5, 17, G.interviewRecorder); prop(2, 21, G.couch); set('walls', 11, 18, G.glassV); set('walls', 11, 19, G.glassV);

  // Furnished break room and evidence lockup.
  prop(29, 10, G.coffee); prop(31, 10, G.copier); prop(33, 10, G.shelf);
  prop(34, 12, G.vending); prop(34, 15, G.fridge); prop(28, 15, G.shelf);
  prop(29, 14, G.cafeTable); prop(32, 14, G.cafeTable);
  set('above', 29, 18, G.evidenceSeal); prop(29, 19, G.evidenceRack); prop(30, 19, G.evidenceRack);
  prop(33, 19, G.evidenceRack); prop(34, 19, G.evidenceRack); prop(29, 22, G.filing); prop(34, 22, G.filing);
  // Captain office and bullpen texture: windows, guest chair, plants, filing and water cooler.
  set('above', 31, 1, G.captainPlaque); set('above', 29, 1, G.window); set('above', 33, 1, G.window);
  prop(29, 6, G.plant); prop(34, 6, G.filing); prop(32, 7, G.chair, false, 'below');
  prop(12, 10, G.plant); prop(26, 15, G.water); prop(12, 21, G.bin); prop(26, 21, G.plant);

  const CAFE = {
    'cafe-seat-1': { x: 29, y: 13 }, 'cafe-seat-2': { x: 29, y: 15 },
    'cafe-seat-3': { x: 32, y: 13 }, 'cafe-seat-4': { x: 32, y: 15 },
    'cafe-stand-coffee': { x: 29, y: 11 }, 'cafe-stand-vending': { x: 33, y: 12 },
  };
  const COFFEE = {
    trayTile: { x: 33, y: 10 }, trayStand: { x: 33, y: 11 },
    machineTile: { x: 29, y: 10 }, machineStand: { x: 29, y: 11 },
    sinkTile: { x: 31, y: 10 }, sinkStand: { x: 31, y: 11 },
  };
  for (const t of Object.values(CAFE)) set('coll', t.x, t.y, 0);

  const spawnObjs = []; let oid = 1;
  const addSpawn = (name, t) => spawnObjs.push({ id: oid++, name, point: true, x: t.x * TS, y: t.y * TS, width: 0, height: 0, rotation: 0, type: '', visible: true });
  for (const [name, t] of Object.entries(SEATS)) addSpawn(name, t);
  for (const [name, t] of Object.entries(CAFE)) addSpawn(name, t);
  addSpawn('entrance', ENTRANCE);

  const zoneObjs = [];
  const addZone = (name, x, y, w, h) => zoneObjs.push({ id: oid++, name, x: x * TS, y: y * TS, width: w * TS, height: h * TS, rotation: 0, type: '', visible: true });
  addZone('boardroom', 2, 2, 8, 5); addZone('operations', 1, 9, 10, 7);
  addZone('interrogation', 1, 17, 10, 6); addZone('cafeteria', 28, 9, 7, 8);
  addZone('evidence', 28, 18, 7, 5); addZone('captain-office', 28, 1, 7, 7);
  addZone('bullpen', 12, 9, 15, 14); addZone('entrance', 15, 20, 6, 3);

  const tileLayer = (name, data, id) => ({ id, name, type: 'tilelayer', data, width: W, height: H, x: 0, y: 0, opacity: 1, visible: true });
  const map = {
    compressionlevel: -1, infinite: false, orientation: 'orthogonal', renderorder: 'right-down',
    width: W, height: H, tilewidth: TS, tileheight: TS, nextlayerid: 99, nextobjectid: oid,
    version: '1.10', tiledversion: '1.10.2', type: 'map',
    properties: [{ name: 'art', type: 'string', value: 'Original procedural Precinct pixel art; generated in-repo.' }],
    tilesets: [{ firstgid: 1, columns: ATLAS_COLS, image: '../tilesets/precinct-tileset.png', imageheight: ATLAS_ROWS * TS, imagewidth: ATLAS_COLS * TS, margin: 0, name: 'precinct-original', spacing: 0, tilecount: ATLAS_COLS * ATLAS_ROWS, tileheight: TS, tilewidth: TS }],
    layers: [
      tileLayer('floor', L.floor, 1), tileLayer('walls', L.walls, 2),
      tileLayer('furniture-below', L.below, 3), tileLayer('furniture-above', L.above, 4),
      tileLayer('collision', L.coll, 5),
      { id: 6, name: 'spawn-points', type: 'objectgroup', objects: spawnObjs, draworder: 'topdown', opacity: 1, visible: true, x: 0, y: 0 },
      { id: 7, name: 'zones', type: 'objectgroup', objects: zoneObjs, draworder: 'topdown', opacity: 1, visible: true, x: 0, y: 0 },
    ],
  };
  return { map, L, SEATS, CAFE, COFFEE, ENTRANCE };
}

function validate(built) {
  const { map, L, SEATS, CAFE, COFFEE, ENTRANCE } = built;
  const walk = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => L.coll[idx(x, y)] === 0));
  const forceWalk = (t) => { if (inb(t.x, t.y)) walk[t.y][t.x] = true; };
  Object.values(SEATS).forEach(forceWalk); Object.values(CAFE).forEach(forceWalk); forceWalk(ENTRANCE);
  const seen = Array.from({ length: H }, () => Array(W).fill(false));
  const q = [[ENTRANCE.x, ENTRANCE.y]]; seen[ENTRANCE.y][ENTRANCE.x] = true;
  for (let qi = 0; qi < q.length; qi++) {
    const [x, y] = q[qi];
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (inb(nx, ny) && !seen[ny][nx] && walk[ny][nx]) { seen[ny][nx] = true; q.push([nx, ny]); }
    }
  }
  const targets = [
    ...Object.entries(SEATS), ...Object.entries(CAFE),
    ...Object.entries(COFFEE).filter(([name]) => name.endsWith('Stand')).map(([n, t]) => [`coffee:${n}`, t]),
    ...Object.entries(INTERACTION_STANDS).map(([n, t]) => [`action:${n}`, t]),
    ['entrance', ENTRANCE],
  ];
  const unreachable = targets.filter(([, t]) => !seen[t.y]?.[t.x]).map(([name]) => name);
  const noApproach = Object.entries(SEATS).filter(([, s]) => ![[s.x + 1, s.y], [s.x - 1, s.y], [s.x, s.y + 1], [s.x, s.y - 1]].some(([x, y]) => seen[y]?.[x] && walk[y][x])).map(([name]) => name);
  const requiredZones = ['bullpen', 'captain-office', 'operations', 'cafeteria', 'entrance', 'boardroom', 'interrogation', 'evidence'];
  const zones = new Set(map.layers.find((l) => l.name === 'zones').objects.map((o) => o.name));
  const missingZones = requiredZones.filter((name) => !zones.has(name));
  if (unreachable.length || noApproach.length || missingZones.length) {
    throw new Error(`map validation failed: unreachable=[${unreachable}] noApproach=[${noApproach}] missingZones=[${missingZones}]`);
  }
  return { targets: targets.length, zones: requiredZones.length };
}

function generatedAssets() {
  const built = buildMap();
  const result = validate(built);
  return { map: Buffer.from(JSON.stringify(built.map)), atlas: makeAtlas(), result };
}

function main() {
  const generated = generatedAssets();
  if (process.argv.includes('--check')) {
    for (const [name, file, expected] of [['map', MAP_OUT, generated.map], ['atlas', ATLAS_OUT, generated.atlas]]) {
      if (!fs.existsSync(file) || !fs.readFileSync(file).equals(expected)) throw new Error(`${name} asset is stale; run node tools/gen-b99-map.cjs`);
    }
    console.log(`OK precinct assets current; ${generated.result.targets} reachable targets, ${generated.result.zones} authored zones`);
    return;
  }
  fs.writeFileSync(MAP_OUT, generated.map); fs.writeFileSync(ATLAS_OUT, generated.atlas);
  console.log(`OK wrote original Precinct map + atlas; ${generated.result.targets} reachable targets, ${generated.result.zones} authored zones`);
}

if (require.main === module) main();
module.exports = { G, INTERACTION_STANDS, buildMap, generatedAssets, makeAtlas, validate };

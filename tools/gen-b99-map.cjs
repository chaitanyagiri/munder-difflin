#!/usr/bin/env node
/**
 * Brooklyn-99 office map generator (TV-show offices Phase 2 — engine/structure).
 *
 * Authors src/renderer/src/assets/maps/brooklyn99.tmj — a precinct bullpen:
 * an open floor of detective desks, Captain Holt's glass office in the back
 * corner (desk-ceo), a briefing room (boardroom zone), and a break room
 * (cafeteria zone) with the coffee economy. PLACEHOLDER ART: it reuses the
 * office tileset gids (floor/wall/desk/monitor) so the STRUCTURE + switch flow
 * are provable; Pam's license-clean B99 tileset + cast likenesses drop into the
 * theme.tilesets / theme.cast seams later. Re-run after a layout tweak:
 *   node tools/gen-b99-map.cjs
 *
 * The desk "stamp" (monitor block + surface + collision, seat forced walkable)
 * is copied verbatim from the office map's pc-desk so DeskScreen lights up and
 * the cup spot lands exactly as in the office. A flood-fill validator asserts
 * every seat / coffee stand / spawn is reachable from the entrance before write.
 */
const fs = require('fs');
const path = require('path');

const W = 36, H = 24, TS = 16;
const OUT = path.join(__dirname, '..', 'src', 'renderer', 'src', 'assets', 'maps', 'brooklyn99.tmj');

// ── placeholder gids (office-tileset) ────────────────────────────────────────
const WALL_GID = 570;            // generic wall body (placeholder)
const floorGid = (x, y) =>
  (y % 2 === 0) ? (x % 2 === 0 ? 800 : 799) : (x % 2 === 0 ? 784 : 783);

// Desk stamp relative to the seat (sx,sy): [layer, dx, dy, gid].
// Copied from office.tmj pc-1 pod so the monitor (365 @ sy-2) + cup spot match.
const DESK_STAMP = [
  ['below', -1, -1, 2], ['below', 0, -1, 3], ['below', 1, -1, 4],
  ['below', 0, 0, 289], ['below', 0, 1, 305],
  ['above', 0, -2, 365], ['above', 1, -2, 366],
  ['above', 0, -1, 381], ['above', 1, -1, 382],
  ['above', -1, 0, 18], ['above', 0, 0, 19], ['above', 1, 0, 20],
  ['coll', 0, -2, 1], ['coll', 1, -2, 1],
  ['coll', -1, -1, 1], ['coll', 0, -1, 1], ['coll', 1, -1, 1],
  ['coll', -1, 0, 1], ['coll', 1, 0, 1],
];

// ── layer buffers ────────────────────────────────────────────────────────────
const mk = () => new Array(W * H).fill(0);
const L = { floor: mk(), walls: mk(), below: mk(), above: mk(), coll: mk() };
const idx = (x, y) => y * W + x;
const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
const set = (layer, x, y, gid) => { if (inb(x, y)) L[layer][idx(x, y)] = gid; };
const wall = (x, y) => { set('walls', x, y, WALL_GID); set('coll', x, y, 1); };
const door = (x, y) => { set('walls', x, y, 0); set('coll', x, y, 0); }; // carve an opening

// ── 1. floor fill (interior) ─────────────────────────────────────────────────
for (let y = 1; y < H - 1; y++)
  for (let x = 1; x < W - 1; x++) set('floor', x, y, floorGid(x, y));

// ── 2. perimeter walls + entrance gap ────────────────────────────────────────
for (let x = 0; x < W; x++) { wall(x, 0); wall(x, H - 1); }
for (let y = 0; y < H; y++) { wall(0, y); wall(W - 1, y); }
const ENTRANCE = { x: 17, y: 22 };
door(17, H - 1); door(18, H - 1);            // bottom door
set('floor', 17, H - 1, floorGid(17, H - 1));
set('floor', 18, H - 1, floorGid(18, H - 1));

// ── 3. rooms (partition walls with a door each) ──────────────────────────────
// Briefing room (top-left): box x[1..10] y[1..8], right wall x=11, bottom wall y=8.
for (let y = 1; y <= 8; y++) wall(11, y);
for (let x = 1; x <= 11; x++) wall(x, 8);
door(5, 8); door(6, 8);
// Holt's glass office (top-right): left wall x=27 y[1..8], bottom wall y=8 x[27..34].
for (let y = 1; y <= 8; y++) wall(27, y);
for (let x = 27; x <= 34; x++) wall(x, 8);
door(30, 8); door(31, 8);
// Break room (right): left wall x=27 y[9..22] (below Holt), door into it.
for (let y = 9; y <= 22; y++) wall(27, y);
door(27, 11); door(27, 12);

// ── 4. desks (desk-ceo = Holt + pc-1..8 detective bullpen) ───────────────────
const SEATS = {
  'desk-ceo': { x: 31, y: 5 },
  'pc-1': { x: 5, y: 13 }, 'pc-2': { x: 10, y: 13 }, 'pc-3': { x: 15, y: 13 }, 'pc-4': { x: 20, y: 13 },
  'pc-5': { x: 5, y: 19 }, 'pc-6': { x: 10, y: 19 }, 'pc-7': { x: 15, y: 19 }, 'pc-8': { x: 20, y: 19 },
};
for (const s of Object.values(SEATS)) {
  for (const [layer, dx, dy, gid] of DESK_STAMP) set(layer, s.x + dx, s.y + dy, gid);
  set('coll', s.x, s.y, 0); // seat always walkable (also forced at runtime)
}

// ── 5. café / coffee economy (break room, open floor) ────────────────────────
const CAFE = {
  'cafe-seat-1': { x: 29, y: 14 }, 'cafe-seat-2': { x: 29, y: 16 }, // paired (same col, 2 apart)
  'cafe-seat-3': { x: 32, y: 14 }, 'cafe-seat-4': { x: 32, y: 16 },
  'cafe-stand-coffee': { x: 30, y: 20 }, 'cafe-stand-vending': { x: 33, y: 12 },
};
// Coffee-economy tiles (Graphics draw cups/sink here; stands must stay walkable).
const COFFEE = {
  trayTile: { x: 33, y: 18 }, trayStand: { x: 33, y: 19 },
  machineStand: { x: 30, y: 21 }, sinkTile: { x: 31, y: 18 }, sinkStand: { x: 31, y: 19 },
};

// ── 6. spawn-points + zones ──────────────────────────────────────────────────
const spawnObjs = [];
let oid = 1;
const addSpawn = (name, t) => spawnObjs.push({ id: oid++, name, point: true, x: t.x * TS, y: t.y * TS, width: 0, height: 0, rotation: 0, type: '', visible: true });
for (const [name, t] of Object.entries(SEATS)) addSpawn(name, t);
for (const [name, t] of Object.entries(CAFE)) addSpawn(name, t);
addSpawn('entrance', ENTRANCE);

const zoneObjs = [];
const addZone = (name, x, y, w, h) => zoneObjs.push({ id: oid++, name, x: x * TS, y: y * TS, width: w * TS, height: h * TS, rotation: 0, type: '', visible: true });
addZone('boardroom', 2, 2, 8, 5);     // briefing room → overflow seating
addZone('cafeteria', 28, 10, 7, 12);  // break room → breaks + overflow
addZone('holding', 1, 18, 4, 4);      // flavor (decorative; not consumed by engine)

// ── 7. validate: every seat / stand / spawn reachable from the entrance ───────
// Walkability = collision 0; seats + spawns are force-walkable (runtime does this
// for desk-/pc-/entrance prefixes; café stands are stood-at, treat as walkable).
const walk = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => L.coll[idx(x, y)] === 0));
const forceWalk = (t) => { if (inb(t.x, t.y)) walk[t.y][t.x] = true; };
Object.values(SEATS).forEach(forceWalk);
Object.values(CAFE).forEach(forceWalk);
Object.values(COFFEE).forEach(forceWalk);
forceWalk(ENTRANCE);

const seen = Array.from({ length: H }, () => Array(W).fill(false));
const q = [[ENTRANCE.x, ENTRANCE.y]]; seen[ENTRANCE.y][ENTRANCE.x] = true;
while (q.length) {
  const [x, y] = q.shift();
  for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
    if (inb(nx, ny) && !seen[ny][nx] && walk[ny][nx]) { seen[ny][nx] = true; q.push([nx, ny]); }
  }
}
const targets = [
  ...Object.entries(SEATS).map(([n, t]) => [n, t]),
  ...Object.entries(CAFE).map(([n, t]) => [n, t]),
  ...Object.entries(COFFEE).map(([n, t]) => [`coffee:${n}`, t]),
  ['entrance', ENTRANCE],
];
const unreachable = targets.filter(([, t]) => !(inb(t.x, t.y) && seen[t.y][t.x]));
// Each desk seat must also have a walkable approach tile (so an agent can step on).
const noApproach = Object.entries(SEATS).filter(([, s]) =>
  ![[s.x, s.y + 1], [s.x, s.y - 1], [s.x + 1, s.y], [s.x - 1, s.y]]
    .some(([ax, ay]) => inb(ax, ay) && walk[ay][ax] && seen[ay] && seen[ay][ax]));

if (unreachable.length || noApproach.length) {
  console.error('VALIDATION FAILED');
  if (unreachable.length) console.error('  unreachable:', unreachable.map(([n]) => n).join(', '));
  if (noApproach.length) console.error('  no walkable approach:', noApproach.map(([n]) => n).join(', '));
  process.exit(1);
}

// ── 8. write the .tmj ────────────────────────────────────────────────────────
const tileLayer = (name, data, id) => ({ id, name, type: 'tilelayer', data, width: W, height: H, x: 0, y: 0, opacity: 1, visible: true });
const map = {
  compressionlevel: -1, infinite: false, orientation: 'orthogonal', renderorder: 'right-down',
  width: W, height: H, tilewidth: TS, tileheight: TS, nextlayerid: 99, nextobjectid: oid, version: '1.10', tiledversion: '1.10.2', type: 'map',
  // Same tileset refs as office.tmj — the theme loader patches a5/interiors with
  // inline metadata; index order must match theme.tilesets (texture[i] ↔ tilesets[i]).
  tilesets: [
    { firstgid: 1, columns: 16, image: '../tilesets/office-tileset.png', imageheight: 512, imagewidth: 256, margin: 0, name: 'office-tileset', spacing: 0, tilecount: 512, tileheight: 16, tilewidth: 16 },
    { firstgid: 513, source: 'A5 Office Floors & Walls.tsx' },
    { firstgid: 1025, source: 'interiors.tsx' },
  ],
  layers: [
    tileLayer('floor', L.floor, 1),
    tileLayer('walls', L.walls, 2),
    tileLayer('furniture-below', L.below, 3),
    tileLayer('furniture-above', L.above, 4),
    tileLayer('collision', L.coll, 5),
    { id: 6, name: 'spawn-points', type: 'objectgroup', objects: spawnObjs, draworder: 'topdown', opacity: 1, visible: true, x: 0, y: 0 },
    { id: 7, name: 'zones', type: 'objectgroup', objects: zoneObjs, draworder: 'topdown', opacity: 1, visible: true, x: 0, y: 0 },
  ],
};
fs.writeFileSync(OUT, JSON.stringify(map));
const seats = Object.keys(SEATS).length, cafe = Object.keys(CAFE).length;
console.log(`OK wrote ${path.relative(path.join(__dirname, '..'), OUT)} — ${W}x${H}, ${seats} desks, ${cafe} café spawns, zones: boardroom/cafeteria/holding`);
console.log('   validation: all seats/stands/spawns reachable from entrance ✓');

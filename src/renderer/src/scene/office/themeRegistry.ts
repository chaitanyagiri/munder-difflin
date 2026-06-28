// Theme registry — the pluggable "office theme" contract.
//
// Phase 0 of the TV-show-offices feature (card tvshow-phase0-abstraction):
// extract the ~40% of constants that were hard-coded inside OfficeFloor.tsx
// (errand spots, coffee-economy tile coords, prop anchors, seat names, tileset
// URLs, palette, monitor gids) into a ThemeConfig so the scene becomes
// swappable per show. This phase ships the EXISTING office unchanged as
// `theme: 'office'`: every value below is copied byte-for-byte from the old
// in-file literals, so the office renders and behaves identically.
//
// The engine (TiledMapRenderer / BFS pathfinding / Camera / sprite animation)
// is already fully generic and needs no change. cast.ts is read-only here
// (uncommitted human WIP) — the office theme references its existing exports.

import type { Texture } from 'pixi.js';
import { colors } from '@/design/tokens';
import {
  CAST_BY_NAME,
  getCastFrames,
  DEFAULT_CHARACTER,
  type CastMember,
  type OfficeCharacterName,
} from './cast';
import {
  B99_CAST_BY_NAME,
  getB99CastFrames,
  B99_DEFAULT_CHARACTER,
} from './castBrooklyn99';
import { B99_FLOOR_FLAVOR } from './cafeteriaLinesBrooklyn99';
import type { BreakSpot } from './cafeteriaLines';

import officeTilesetUrl from '@/assets/tilesets/office-tileset.png?url';
import a5FloorsWallsUrl from '@/assets/tilesets/a5-office-floors-walls.png?url';
import interiorsUrl from '@/assets/tilesets/interiors.png?url';
import brooklyn99PrecinctUrl from '@/assets/tilesets/brooklyn99-precinct.png?url';
// .tmj is Tiled JSON; imported as raw text and parsed by the loader.
import officeMapRaw from '@/assets/maps/office.tmj?raw';
import brooklyn99MapRaw from '@/assets/maps/brooklyn99.tmj?raw';

/** Theme identifiers. Only `office` exists in Phase 0; the five TV-show themes
 *  (friends, brooklyn99, siliconvalley, got, hogwarts) land in later phases. */
export type ThemeId =
  | 'office'
  | 'friends'
  | 'brooklyn99'
  | 'siliconvalley'
  | 'got'
  | 'hogwarts';

export interface Tile { x: number; y: number; }
export type Facing = 'up' | 'down' | 'left' | 'right';

/** Kinds of small idle errands around the office (incl. plant watering).
 *  'smoke' is the boss special: cigar at the open window, god only. */
export type ErrandKind =
  | 'water' | 'window' | 'dispenser' | 'fridge' | 'shelf' | 'bin' | 'smoke';

/** One idle-errand anchor: a stand tile + facing, an `fx` tile for the ambient
 *  animation, a duration, and an optional god-only restriction. */
export interface ErrandSpot {
  kind: ErrandKind;
  stand: Tile;
  facing: Facing;
  fx: Tile;
  duration: number;
  godOnly?: boolean;
}

/** One tileset atlas + its placement in the global gid space. `embedded` marks
 *  the atlas whose metadata already lives inline in the map's own `tilesets[0]`
 *  (the loader keeps the map's copy and only patches the appended atlases). */
export interface TilesetEntry {
  url: string;
  embedded?: boolean;
  firstgid?: number;
  image?: string;
  imagewidth?: number;
  imageheight?: number;
  tilewidth?: number;
  tileheight?: number;
  columns?: number;
  tilecount?: number;
}

/** Desk-monitor overlay gids. The map paints an OFF monitor block; DeskScreen
 *  overlays the matching ON tiles while the desk's agent is seated. */
export interface MonitorConfig {
  /** gid of the OFF monitor block's top-left tile, as painted in the map. */
  offTopLeftGid: number;
  /** Matching ON tiles as [gid, dx, dy] relative to the block's top-left. */
  onGids: ReadonlyArray<readonly [number, number, number]>;
}

/** The coffee economy's fixed tiles: sideboard (mug rack) → counter machine →
 *  sink → back to the sideboard. `maxCups` caps the clean-mug stock. */
export interface CoffeeConfig {
  trayTile: Tile;
  trayStand: Tile;
  machineStand: Tile;
  sinkTile: Tile;
  sinkStand: Tile;
  maxCups: number;
}

/** Clickable prop anchors (tile coords). calendar → SCHEDULES, boards → TASKS,
 *  clock → CLOSING TIME. */
export interface AnchorConfig {
  calendar: Tile;
  boards: Tile;
  clock: Tile;
}

/** Theme palette. `background` is the canvas clear color; `noteColors` are the
 *  kanban note colors keyed by task status. */
export interface PaletteConfig {
  background: number;
  noteColors: Record<string, number>;
}

/** Per-theme cast loader — the indirection point so a future show can swap its
 *  own roster + sprite frames. The office theme points at cast.ts's exports. */
export interface ThemeCast {
  byName: Record<string, CastMember>;
  getFrames: (name: string) => Promise<Texture[][]>;
  defaultCharacter: string;
}

/** Per-theme floor-text flavour: the muttered lines the scene shows around the
 *  floor (errand mutters, boss gossip/suck-up, done cheers, café quips). A theme
 *  may omit this entirely — the office scene then falls back to its own in-file
 *  constants, so the office renders byte-identically. Functions are keyed by the
 *  same OfficeCharacterName the engine assigns (a show theme's cast layer reskins
 *  the likeness; the line pools stay keyed off the office key). */
export interface FloorFlavor {
  /** Mutter while running each idle errand (keyed by ErrandKind). */
  errandThoughts: Record<ErrandKind, readonly string[]>;
  /** What workers say once the boss is out of earshot. */
  gossipLines: readonly string[];
  /** Performative excellence in the boss's presence. Indices 0–1 may carry the
   *  `{done}` token (used only when the worker has shipped tasks); 2+ generic. */
  suckUpLines: readonly string[];
  /** Thrown over the shoulder right after finishing a task. */
  cheerLines: readonly string[];
  /** A solo café line (mirrors cafeteriaLines.pickSoloLine). */
  pickSoloLine: (character: string, spot: BreakSpot, seed: number) => string;
  /** A multi-beat table exchange (mirrors cafeteriaLines.pickExchange). */
  pickExchange: (speaker: string, seed: number) => readonly string[];
}

/** The full contract a theme must supply. See report §A (theme contract). */
export interface ThemeConfig {
  id: ThemeId;
  /** Raw Tiled JSON text; parsed + tileset-patched by themeLoader. */
  mapRaw: string;
  /** Ordered atlases — order matches both the texture load order and the map's
   *  tileset array (texture[i] ↔ tilesets[i]). */
  tilesets: TilesetEntry[];
  /** Desk-claim order, by spawn-point name (seat 0 = god / desk-ceo). */
  primarySeatNames: string[];
  /** Paired café table seats, in order. */
  cafeSeatNames: string[];
  /** Café standing spots: [spawn-point name, kind]. */
  cafeStands: ReadonlyArray<readonly [string, 'coffee' | 'vending']>;
  coffee: CoffeeConfig;
  anchors: AnchorConfig;
  errandSpots: ErrandSpot[];
  monitor: MonitorConfig;
  palette: PaletteConfig;
  cast: ThemeCast;
  /** Optional floor-text flavour. Omit for the office (it uses its in-file
   *  constants); a show theme supplies its own reskinned line pools. */
  flavor?: FloorFlavor;
}

/** The existing office, expressed as a theme. Values are copied verbatim from
 *  the former in-file constants in OfficeFloor.tsx / DeskScreen.ts. */
export const OFFICE_THEME: ThemeConfig = {
  id: 'office',
  mapRaw: officeMapRaw,
  tilesets: [
    // office-tileset.png — embedded in the map (firstgid 1); keep the map's copy.
    { url: officeTilesetUrl, embedded: true },
    { url: a5FloorsWallsUrl, firstgid: 513, image: 'a5', imagewidth: 256, imageheight: 512, tilewidth: 16, tileheight: 16, columns: 16, tilecount: 512 },
    { url: interiorsUrl, firstgid: 1025, image: 'interiors', imagewidth: 256, imageheight: 1424, tilewidth: 16, tileheight: 16, columns: 16, tilecount: 1424 },
  ],
  primarySeatNames: [
    'desk-ceo',
    'pc-1', 'pc-2', 'pc-3', 'pc-4', 'pc-5', 'pc-6',
    'desk-chief-architect', 'desk-product-manager', 'desk-team-lead',
    'desk-backend-engineer', 'desk-ui-ux-expert', 'desk-data-engineer',
    'desk-project-manager', 'desk-market-researcher', 'desk-agent-organizer',
  ],
  cafeSeatNames: ['cafe-seat-1', 'cafe-seat-2', 'cafe-seat-3', 'cafe-seat-4'],
  cafeStands: [
    ['cafe-stand-coffee', 'coffee'],
    ['cafe-stand-vending', 'vending'],
  ],
  coffee: {
    trayTile: { x: 29, y: 15 },     // the sideboard (counter piece)
    trayStand: { x: 29, y: 16 },
    machineStand: { x: 26, y: 20 }, // below the counter machine
    sinkTile: { x: 28, y: 18 },     // free counter top, right end
    sinkStand: { x: 28, y: 20 },
    maxCups: 4,
  },
  anchors: {
    calendar: { x: 4, y: 1 },
    boards: { x: 6, y: 10 },
    clock: { x: 1, y: 1 },
  },
  errandSpots: [
    // plants (droplets ride on the character via startWatering)
    { kind: 'water', stand: { x: 2, y: 20 }, facing: 'left', fx: { x: 1, y: 20 }, duration: 4.5 },
    { kind: 'water', stand: { x: 22, y: 20 }, facing: 'right', fx: { x: 23, y: 20 }, duration: 4.5 },
    { kind: 'water', stand: { x: 30, y: 20 }, facing: 'right', fx: { x: 31, y: 20 }, duration: 4.5 },
    // the CEO office is the god's domain: its plant, window, cigar. Workers
    // never set foot in there for errands.
    { kind: 'water', stand: { x: 6, y: 4 }, facing: 'up', fx: { x: 6, y: 3 }, duration: 4.5, godOnly: true },
    { kind: 'smoke', stand: { x: 2, y: 3 }, facing: 'up', fx: { x: 2, y: 1 }, duration: 18, godOnly: true },
    { kind: 'water', stand: { x: 17, y: 4 }, facing: 'up', fx: { x: 17, y: 3 }, duration: 4.5 },
    // the two public wall windows — wind streaks drift into the room
    { kind: 'window', stand: { x: 10, y: 3 }, facing: 'up', fx: { x: 10, y: 1 }, duration: 5 },
    { kind: 'window', stand: { x: 15, y: 3 }, facing: 'up', fx: { x: 14, y: 1 }, duration: 5 },
    // water dispensers (hallway + the top-right corner one)
    { kind: 'dispenser', stand: { x: 16, y: 3 }, facing: 'down', fx: { x: 16, y: 4 }, duration: 3.5 },
    { kind: 'dispenser', stand: { x: 32, y: 4 }, facing: 'up', fx: { x: 32, y: 3 }, duration: 3.5 },
    // the café fridge (door light spills out) + the shelf beside it
    { kind: 'fridge', stand: { x: 29, y: 20 }, facing: 'up', fx: { x: 29, y: 19 }, duration: 3.2 },
    { kind: 'shelf', stand: { x: 30, y: 20 }, facing: 'up', fx: { x: 30, y: 18 }, duration: 4 },
    // garbage bins (entrance + café) — a paper ball arcs in
    { kind: 'bin', stand: { x: 18, y: 20 }, facing: 'left', fx: { x: 17, y: 20 }, duration: 2.6 },
    { kind: 'bin', stand: { x: 31, y: 16 }, facing: 'right', fx: { x: 32, y: 16 }, duration: 2.6 },
  ],
  monitor: {
    offTopLeftGid: 365,
    onGids: [
      [367, 0, 0], [368, 1, 0],
      [383, 0, 1], [384, 1, 1],
    ],
  },
  palette: {
    background: colors.ink[900],
    noteColors: { todo: 0xf2df8a, doing: 0x9ecbf0, blocked: 0xf0a3a3, done: 0xa8e0b0 },
  },
  cast: {
    byName: CAST_BY_NAME as Record<string, CastMember>,
    getFrames: (name: string) => getCastFrames(name as OfficeCharacterName),
    defaultCharacter: DEFAULT_CHARACTER,
  },
};

/** Brooklyn Nine-Nine — the 99th precinct (TV-show offices Phase 2, structure).
 *  The map (brooklyn99.tmj) is a precinct bullpen: Captain Holt's glass office
 *  in the back corner (`desk-ceo`), an 8-desk detective bullpen (`pc-1..8`), a
 *  briefing room (boardroom zone) + break room (cafeteria zone) with the coffee
 *  economy. CAST + FLAVOUR WIRED: `cast` resolves to the B99 reskin
 *  (castBrooklyn99.ts) over Pam's real 108×96 sheets, and `flavor` to the
 *  precinct floor-text. PENDING OSCAR'S MAP: `tilesets`/`monitor`/`palette`
 *  still reuse the office atlas+gids because the current brooklyn99.tmj paints
 *  the office gid space. When Oscar re-authors the .tmj against Pam's
 *  brooklyn99-precinct.png (ART-CONTRACT §2), append ONE TilesetEntry —
 *  { url: brooklyn99PrecinctUrl, firstgid: 2449, image:'b99', imagewidth:256,
 *  imageheight:96, tilewidth:16, tileheight:16, columns:16, tilecount:96 }.
 *  FULLY BOUND: Oscar's brooklyn99.tmj (integrated) gid-binds the precinct
 *  tileset at firstgid 2449 (= interiors 1025 + 1424), and the fields below are
 *  authored to his real room coords — bullpen desks, Holt's glass office,
 *  interrogation, holding cell, break room. Only `palette` deliberately reuses
 *  the office tokens (Pam shipped no separate B99 palette; the precinct look
 *  comes from her tileset). */
export const BROOKLYN99_THEME: ThemeConfig = {
  id: 'brooklyn99',
  mapRaw: brooklyn99MapRaw,
  // BOUND: office atlases (office-tileset embedded @1, a5 @513, interiors @1025)
  // resolve the floor/generic walls; Pam's precinct atlas @2449 resolves every
  // B99 element (Oscar paints gids as 2449 + localIndex). themeLoader builds the
  // map's tileset array from THIS list (texture[i] ↔ tilesets[i]), so the b99
  // entry here is what makes the 2449 gids render — keep it last, index 3.
  tilesets: [
    ...OFFICE_THEME.tilesets,
    {
      url: brooklyn99PrecinctUrl,
      firstgid: 2449,
      image: 'b99',
      imagewidth: 256,
      imageheight: 96,
      tilewidth: 16,
      tileheight: 16,
      columns: 16,
      tilecount: 96,
    },
  ],
  primarySeatNames: [
    'desk-ceo',                                            // Captain Holt's glass office
    'pc-1', 'pc-2', 'pc-3', 'pc-4',                        // bullpen — front row
    'pc-5', 'pc-6', 'pc-7', 'pc-8',                        // bullpen — back row
  ],
  cafeSeatNames: ['cafe-seat-1', 'cafe-seat-2', 'cafe-seat-3', 'cafe-seat-4'],
  cafeStands: [
    ['cafe-stand-coffee', 'coffee'],
    ['cafe-stand-vending', 'vending'],
  ],
  // BOUND to Oscar's break-room counter run (props along y=20): coffee machine
  // (16,20), sink (20,20), counter/mug sideboard (24,20); stands on the walkable
  // aisle at y=19. trayTile→machine→sink loop, all stands collision-verified.
  coffee: {
    trayTile: { x: 24, y: 20 },     // counter sideboard (mug rack)
    trayStand: { x: 24, y: 19 },
    machineStand: { x: 16, y: 19 }, // in front of the coffee machine (16,20)
    sinkTile: { x: 20, y: 20 },
    sinkStand: { x: 20, y: 19 },
    maxCups: 4,
  },
  // Clickable wall hotspots on the bullpen north wall (y=7). boards = Oscar's
  // case-board (li81/82/84/85 @ x12–19); calendar/clock flank it on the same wall.
  anchors: {
    calendar: { x: 8, y: 7 },   // bullpen north wall → SCHEDULES
    boards: { x: 13, y: 7 },    // the case-board → TASKS
    clock: { x: 26, y: 7 },     // bullpen north-east wall → CLOSING TIME
  },
  // Errand anchors authored to brooklyn99.tmj's open floor — every `stand` tile
  // verified walkable against the integrated collision layer; godOnly spots sit
  // inside Holt's glass office (zone 28,14,5,7).
  errandSpots: [
    // public plants around the bullpen / corridor
    { kind: 'water', stand: { x: 7, y: 18 }, facing: 'down', fx: { x: 7, y: 19 }, duration: 4.5 },
    { kind: 'water', stand: { x: 25, y: 15 }, facing: 'right', fx: { x: 26, y: 15 }, duration: 4.5 },
    // Captain Holt's glass office — god's domain (plant + cigar/brood)
    { kind: 'water', stand: { x: 28, y: 18 }, facing: 'up', fx: { x: 28, y: 17 }, duration: 4.5, godOnly: true },
    { kind: 'smoke', stand: { x: 31, y: 19 }, facing: 'up', fx: { x: 31, y: 17 }, duration: 18, godOnly: true },
    // windows — casing the street
    { kind: 'window', stand: { x: 20, y: 8 }, facing: 'up', fx: { x: 20, y: 7 }, duration: 5 },
    { kind: 'window', stand: { x: 31, y: 8 }, facing: 'up', fx: { x: 31, y: 7 }, duration: 5 },
    // water coolers — interrogation hydration
    { kind: 'dispenser', stand: { x: 7, y: 15 }, facing: 'up', fx: { x: 7, y: 14 }, duration: 3.5 },
    { kind: 'dispenser', stand: { x: 24, y: 11 }, facing: 'right', fx: { x: 25, y: 11 }, duration: 3.5 },
    // break-room fridge (Terry's yogurt) + evidence shelf (file-evidence)
    { kind: 'fridge', stand: { x: 22, y: 19 }, facing: 'down', fx: { x: 22, y: 20 }, duration: 3.2 },
    { kind: 'shelf', stand: { x: 25, y: 18 }, facing: 'right', fx: { x: 26, y: 18 }, duration: 4 },
    // evidence / perp-walk bins
    { kind: 'bin', stand: { x: 9, y: 18 }, facing: 'left', fx: { x: 8, y: 18 }, duration: 2.6 },
    { kind: 'bin', stand: { x: 8, y: 11 }, facing: 'down', fx: { x: 8, y: 12 }, duration: 2.6 },
  ],
  // BOUND: detective-desk monitor stamp — off-block top-left gid 2515 (2449+66),
  // single ON tile 2516 (2449+67). The B99 monitor is 1 tile, not the office 2×2.
  monitor: { offTopLeftGid: 2515, onGids: [[2516, 0, 0]] },
  // Office palette reused intentionally (Pam shipped no separate B99 palette; the
  // precinct look comes from her tileset). Case-board notes keep status colors.
  palette: OFFICE_THEME.palette,
  // WIRED: the B99 cast reskin. byName is keyed by the same OfficeCharacterName
  // the engine assigns; getFrames slices Pam's sheets (procedural fallback until
  // they land). Casting (god=Holt, Jim=Jake, Pam=Amy, Oscar=Rosa, Kevin=Charles)
  // lives entirely in castBrooklyn99.ts — no change to agent→character assignment.
  cast: {
    byName: B99_CAST_BY_NAME as Record<string, CastMember>,
    getFrames: (name: string) => getB99CastFrames(name),
    defaultCharacter: B99_DEFAULT_CHARACTER,
  },
  // WIRED: full B99 floor flavour — errand mutters (interrogate / file-evidence /
  // Terry-yogurt / perp-walk), Holt-edition gossip + suck-up, Jake-ism cheers,
  // and Jake↔Amy / Holt-deadpan café banter. The office theme omits `flavor`.
  flavor: B99_FLOOR_FLAVOR,
};

/** All registered themes. Phase 0 ships only the office; show themes register
 *  here as their content lands (Phase 2). */
export const THEMES: Partial<Record<ThemeId, ThemeConfig>> = {
  office: OFFICE_THEME,
  brooklyn99: BROOKLYN99_THEME,
};

/** Look up a theme by id, falling back to the office theme if unknown/missing
 *  (a bad/absent show bundle must never break the floor — see report §E). */
export function getTheme(id: ThemeId): ThemeConfig {
  return THEMES[id] ?? OFFICE_THEME;
}

import { useEffect, useRef } from 'react';
import { Application, Container, Graphics, Ticker, Texture } from 'pixi.js';
// PixiJS uses new Function() internally, blocked by Electron CSP — this patches it.
import 'pixi.js/unsafe-eval';
import { useStore, type Agent } from '@/store/store';
import { TiledMapRenderer, type TiledMap } from './TiledMapRenderer';
import { Camera } from './Camera';
import { Character, paintCup } from './Character';
import { DeskScreen, MONITOR_OFF_TOPLEFT_GID } from './DeskScreen';
import { MessageEnvelope, type MessageAct } from './MessageEnvelope';
import { getCastFrames, CAST_BY_NAME, hexToNumber, DEFAULT_CHARACTER } from './cast';
import { pickSoloLine, pickExchange, type BreakSpot } from './cafeteriaLines';
import { colors } from '@/design/tokens';

import officeTilesetUrl from '@/assets/tilesets/office-tileset.png?url';
import a5FloorsWallsUrl from '@/assets/tilesets/a5-office-floors-walls.png?url';
import interiorsUrl from '@/assets/tilesets/interiors.png?url';
// .tmj is Tiled JSON; import as raw text (typed by vite/client) and parse.
import officeMapRaw from '@/assets/maps/office.tmj?raw';

const officeMapData = JSON.parse(officeMapRaw) as TiledMap;

// Preferred desks, in claim order. The very first agent always takes the
// private office on the left (the CEO room), then the open-plan PC desks, then
// the remaining named desks. Overflow (conference room, then open floor) is
// computed from map zones at runtime. Matches Tiled spawn-point names.
const PRIMARY_SEAT_NAMES = [
  'desk-ceo',
  'pc-1', 'pc-2', 'pc-3', 'pc-4', 'pc-5', 'pc-6',
  'desk-chief-architect', 'desk-product-manager', 'desk-team-lead',
  'desk-backend-engineer', 'desk-ui-ux-expert', 'desk-data-engineer',
  'desk-project-manager', 'desk-market-researcher', 'desk-agent-organizer',
];

interface Tile { x: number; y: number; }
type Facing = 'up' | 'down' | 'left' | 'right';

/** A cafeteria break in progress for one agent — set by the coffee-break
 *  director, cleared when the agent leaves or gets pulled back to work. */
interface CafeChat {
  lines: readonly string[];        // alternating beats: even = initiator, odd = partner
  partnerId: string;
  idx: number;                     // next beat to speak
  beat: number;                    // seconds until the next beat
}

interface CafeBreak {
  spotIdx: number;                 // index into cafeSpots
  phase: 'walking' | 'lingering';
  timer: number;                   // walking → elapsed watchdog; lingering → countdown
  quipTimer: number;               // until the next solo quip swap
  chat?: CafeChat;                 // set on the conversation's initiator
  chattingWith?: string;           // set on the partner: stays put & stays quiet
}

/** A plant-watering errand in progress for one agent. */
interface WateringRun {
  phase: 'walking' | 'watering';
  timer: number;
  plantIdx: number;
}

/** One leg of the coffee economy: fetch a clean mug from the sideboard, brew
 *  at the counter machine, (later) wash at the sink and rack the mug again. */
interface CoffeeRun {
  phase: 'toTray' | 'taking' | 'toMachine' | 'brewing' | 'toSink' | 'washing' | 'toTrayBack' | 'placing';
  timer: number;
}

interface Runtime {
  character: Character;
  seatIndex: number | null;
  waitTile: Tile;
  charName: string;
  prevStatus?: string;
  prevAction?: string;
  prevCarrying?: string;
  prevPrompt?: string;
  brk?: CafeBreak;
  /** This desk's monitor overlay — lit while its agent is seated. */
  screen?: DeskScreen;
  /** Walking a fresh coffee from the break room home to the desk. */
  cupCarryHome?: boolean;
  wtr?: WateringRun;
  run?: CoffeeRun;
}

/** Lines an avatar throws over its shoulder right after finishing a task. */
const CHEER_LINES = [
  'done! ✔', 'nailed it', "that's a wrap", 'ship it 🚀', 'another one done',
  'crushed it', 'in the books'
] as const;

/** Patch the map's external (.tsx) tileset refs with the inline metadata the
 *  renderer needs — mirrors the reference repo's OfficeScene.init(). */
function resolveMap(): TiledMap {
  const m = officeMapData;
  return {
    ...m,
    tilesets: [
      m.tilesets[0], // office-tileset.png (embedded, firstgid 1)
      { firstgid: 513, image: 'a5', imagewidth: 256, imageheight: 512, tilewidth: 16, tileheight: 16, columns: 16, tilecount: 512 } as any,
      { firstgid: 1025, image: 'interiors', imagewidth: 256, imageheight: 1424, tilewidth: 16, tileheight: 16, columns: 16, tilecount: 1424 } as any,
    ],
  };
}

/** Load a texture via an <img> element. Unlike Pixi's Assets.load(), this
 *  handles extension-less data: URLs (Vite inlines small assets like the a5
 *  tileset as base64), which the Assets resolver fails to type-detect. */
function loadTexture(url: string): Promise<Texture> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const tex = Texture.from(img);
      tex.source.scaleMode = 'nearest';
      resolve(tex);
    };
    img.onerror = () => reject(new Error('failed to load ' + url.slice(0, 40)));
    img.src = url;
  });
}

/** What the agent is doing right now, for the thought cloud. Prefer the live
 *  `action` (e.g. "edit App.tsx", "bash npm test"), fall back to the prompt we
 *  gave it, then to a caller-supplied generic. Returns '' for the working state
 *  with nothing concrete yet — the bubble renders an animated "…" for that. */
function liveActivity(agent: Agent, fallback = ''): string {
  const action = (agent.action || '').trim();
  if (action) return action;
  return firstWords(agent.lastPrompt) || fallback;
}

/** First few words of the last user prompt, for the desk card. */
function firstWords(prompt: string | undefined, maxWords = 6, maxChars = 42): string {
  if (!prompt) return '';
  const words = prompt.trim().split(/\s+/);
  let out = words.slice(0, maxWords).join(' ');
  const truncatedWords = words.length > maxWords;
  if (out.length > maxChars) out = out.slice(0, maxChars).trimEnd();
  else if (truncatedWords) out += '…';
  return out;
}

export function OfficeFloor() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<Application | null>(null);
  const mountIdRef = useRef(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);

    const mountId = ++mountIdRef.current;
    const app = new Application();
    appRef.current = app;

    const runtimes = new Map<string, Runtime>();
    const seatClaims = new Set<number>();
    // In-flight message envelopes (sender desk → recipient desk). Capped so a
    // broadcast doesn't bury the floor in paper.
    const envelopes: MessageEnvelope[] = [];
    const MAX_ENVELOPES = 16;

    const init = async () => {
      await app.init({
        background: hexNum(colors.ink[900]),
        antialias: false,
        roundPixels: true,
        // resolution: 1 let the OS/browser upscale the canvas on scaled and
        // HiDPI displays (125–150% is the Windows laptop default), blurring
        // everything — worst of all the bubble text, which is small to begin
        // with. Render at the real device pixel density instead, floored at 2
        // so the half-scale-supersampled bubble text stays legible even at
        // 100% scaling. autoDensity keeps the canvas CSS size in logical px.
        resolution: Math.max(window.devicePixelRatio || 1, 2),
        autoDensity: true,
        width: host.clientWidth || 800,
        height: host.clientHeight || 600,
      });
      if (mountIdRef.current !== mountId) { safeDestroy(app); return; }
      while (host.firstChild) host.removeChild(host.firstChild);
      host.appendChild(app.canvas);

      // Load tilesets (order must match resolveMap()'s tileset array)
      const [officeTex, a5Tex, interiorsTex] = await Promise.all(
        [officeTilesetUrl, a5FloorsWallsUrl, interiorsUrl].map(loadTexture),
      );
      if (mountIdRef.current !== mountId) { safeDestroy(app); return; }

      const world = new Container();
      app.stage.addChild(world);

      const mapRenderer = new TiledMapRenderer(resolveMap(), [officeTex, a5Tex, interiorsTex]);
      world.addChild(mapRenderer.getContainer());
      const charLayer = mapRenderer.getCharacterContainer();
      const tileCount = mapRenderer.getContainer().children.reduce(
        (n, c) => n + ((c as Container).children?.length ?? 0), 0);
      console.log(`[OfficeFloor] map ${mapRenderer.width}x${mapRenderer.height}, ${tileCount} tile sprites rendered`);

      const camera = new Camera(world);
      camera.setMapSize(mapRenderer.width * mapRenderer.tileSize, mapRenderer.height * mapRenderer.tileSize);
      camera.setViewSize(app.screen.width, app.screen.height);
      camera.fitToScreen();

      // Build the ordered seat list once: PC desks + named desks first, then
      // conference-room chairs as overflow. Each agent claims one and stays there;
      // they never wander off it (except when blocked, or on a coffee break).
      const seatTiles: Tile[] = [];
      const seatSeen = new Set<string>();
      const addSeat = (t?: Tile) => {
        if (!t) return;
        const k = `${t.x},${t.y}`;
        if (seatSeen.has(k)) return;
        seatSeen.add(k);
        seatTiles.push({ x: t.x, y: t.y });
      };
      for (const name of PRIMARY_SEAT_NAMES) addSeat(mapRenderer.getSpawnPoint(name));
      const addZoneSeats = (zone: string) => {
        const z = mapRenderer.getZone(zone);
        if (!z) return;
        for (let y = z.y; y < z.y + z.height; y++) {
          for (let x = z.x; x < z.x + z.width; x++) {
            if (mapRenderer.isWalkable(x, y)) addSeat({ x, y });
          }
        }
      };
      addZoneSeats('boardroom');       // conference room overflow
      // The bottom-right open area is the cafeteria (break room) — see the
      // coffee-break director below. It is deliberately NOT added as overflow
      // desk seating, so the café tables stay free for breaks.

      // Waiting spots near the entrance — where a blocked agent walks to signal
      // it needs the user. Collected as walkable tiles in rings around the door.
      const entrance = mapRenderer.getSpawnPoint('entrance')
        ?? { x: Math.floor(mapRenderer.width / 2), y: mapRenderer.height - 2 };
      const waitTiles: Tile[] = [];
      const waitSeen = new Set<string>();
      for (let radius = 0; radius <= 6 && waitTiles.length < 16; radius++) {
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
            const x = entrance.x + dx, y = entrance.y + dy;
            const k = `${x},${y}`;
            if (waitSeen.has(k)) continue;
            if (mapRenderer.isWalkable(x, y)) { waitSeen.add(k); waitTiles.push({ x, y }); }
          }
        }
      }
      if (waitTiles.length === 0) waitTiles.push(entrance);

      // Seat 0 is desk-ceo — "Michael's room" — reserved for the god agent.
      // Seat 1 is reserved for his prep assistant ("Dwight") so it always sits in
      // the desk next to him. Everyone else claims from seat 2 onward.
      const GOD_SEAT = 0;
      const ASSISTANT_SEAT = 1;
      const claimSeat = (agent: Agent): number | null => {
        if (agent.isGod) { seatClaims.add(GOD_SEAT); return GOD_SEAT; }
        if (agent.isAssistant && seatTiles.length > ASSISTANT_SEAT) {
          seatClaims.add(ASSISTANT_SEAT); return ASSISTANT_SEAT;
        }
        for (let i = 2; i < seatTiles.length; i++) {
          if (!seatClaims.has(i)) { seatClaims.add(i); return i; }
        }
        return null;
      };

      // Face a seated agent toward their desk (the adjacent non-walkable
      // furniture). Standard desks put the monitor to the north and the chair to
      // the south, so the agent faces 'up' and we see their back — like a real
      // worker. Only a desk directly to the SOUTH (face 'down') puts furniture in
      // front of them, which is the one case the leg-crop tucks legs under.
      const facingForSeat = (t: Tile): 'up' | 'down' | 'left' | 'right' => {
        if (!mapRenderer.isWalkable(t.x, t.y - 1)) return 'up';
        if (!mapRenderer.isWalkable(t.x, t.y + 1)) return 'down';
        if (!mapRenderer.isWalkable(t.x - 1, t.y)) return 'left';
        if (!mapRenderer.isWalkable(t.x + 1, t.y)) return 'right';
        return 'up'; // open-floor overflow seat — no desk, just face away
      };

      // ─── Cafeteria: purposeful coffee breaks ───────────────────────────────
      // Idle / finished agents occasionally stroll to the break area, sit at a
      // café table (or stand at the coffee machine / vending machine), emit an
      // in-character one-liner, then head back. Two agents at the same table
      // trade a two-beat quip. This is what makes "lingering" feel purposeful.
      interface CafeSpot { tile: Tile; facing: Facing; spot: BreakSpot; seated: boolean; partner: number; }
      const cafeSpots: CafeSpot[] = [];

      // Stand spots face the first adjacent non-walkable tile (the appliance).
      const faceFurniture = (t: Tile): Facing => {
        if (!mapRenderer.isWalkable(t.x + 1, t.y)) return 'right';
        if (!mapRenderer.isWalkable(t.x - 1, t.y)) return 'left';
        if (!mapRenderer.isWalkable(t.x, t.y - 1)) return 'up';
        return 'down';
      };

      // Seats first (so partner indices are stable), then the standing spots.
      for (const name of ['cafe-seat-1', 'cafe-seat-2', 'cafe-seat-3', 'cafe-seat-4']) {
        const p = mapRenderer.getSpawnPoint(name);
        if (p) cafeSpots.push({ tile: p, facing: facingForSeat(p), spot: 'table', seated: true, partner: -1 });
      }
      // Pair the two seats that share a table (same column, two tiles apart).
      for (let i = 0; i < cafeSpots.length; i++) {
        for (let j = i + 1; j < cafeSpots.length; j++) {
          const a = cafeSpots[i].tile, b = cafeSpots[j].tile;
          if (a.x === b.x && Math.abs(a.y - b.y) === 2) { cafeSpots[i].partner = j; cafeSpots[j].partner = i; }
        }
      }
      for (const [name, spot] of [['cafe-stand-coffee', 'coffee'], ['cafe-stand-vending', 'vending']] as const) {
        const p = mapRenderer.getSpawnPoint(name);
        if (p) cafeSpots.push({ tile: p, facing: faceFurniture(p), spot, seated: false, partner: -1 });
      }
      const cafeTaken: (string | null)[] = new Array(cafeSpots.length).fill(null);

      const agentById = (id: string): Agent | undefined =>
        useStore.getState().agents.find((a) => a.id === id);

      // ─── The coffee economy: sideboard → machine → desk → sink → sideboard ─
      // A finite stock of mugs lives on a sideboard next to the kitchen counter.
      // Brewing requires a mug in hand (a clean one off the rack, or your own
      // brought back from the desk for a lazy refill); washing at the counter
      // sink puts a mug back into the clean stock. If every mug is parked on a
      // desk somewhere, the rack runs dry — and the floor feels it.
      const TRAY_TILE: Tile = { x: 29, y: 15 };     // the sideboard (counter piece)
      const TRAY_STAND: Tile = { x: 29, y: 16 };
      const MACHINE_STAND: Tile = { x: 26, y: 20 }; // below the counter machine
      const SINK_TILE: Tile = { x: 28, y: 18 };     // free counter top, right end
      const SINK_STAND: Tile = { x: 28, y: 20 };
      const MAX_CUPS = 4;
      let cleanCups = MAX_CUPS;

      const ts0 = mapRenderer.tileSize;
      const trayG = new Graphics();
      trayG.eventMode = 'none';
      trayG.position.set(TRAY_TILE.x * ts0, TRAY_TILE.y * ts0);
      trayG.zIndex = (TRAY_TILE.y + 1) * ts0;
      charLayer.addChild(trayG);
      const drawTray = (): void => {
        trayG.clear();
        const slots: Array<[number, number]> = [[2, 10], [9, 10], [2, 15], [9, 15]];
        for (let i = 0; i < cleanCups && i < slots.length; i++) {
          paintCup(trayG, slots[i][0], slots[i][1]);
        }
      };
      drawTray();

      const sinkG = new Graphics();
      sinkG.eventMode = 'none';
      sinkG.position.set(SINK_TILE.x * ts0, SINK_TILE.y * ts0);
      sinkG.zIndex = (SINK_TILE.y + 1) * ts0;
      charLayer.addChild(sinkG);
      let sinkBusy = 0; // seconds of wash animation left
      const drawSink = (t: number): void => {
        sinkG.clear();
        // steel basin set into the white counter top + a small faucet
        sinkG.rect(2, 6, 12, 8).fill(0xb9c2c9);
        sinkG.rect(3, 7, 10, 6).fill(0x87939d);
        sinkG.rect(7, 9, 2, 2).fill(0x5d676f);          // drain
        sinkG.rect(7, 2, 2, 4).fill(0x6b7680);          // faucet riser
        sinkG.rect(6, 2, 4, 1).fill(0x6b7680);
        if (sinkBusy > 0) {
          // running water + a couple of suds while someone scrubs
          sinkG.rect(7, 6, 2, 4).fill({ color: 0x9fd6f0, alpha: 0.9 });
          for (let i = 0; i < 3; i++) {
            const ph = (t * 1.2 + i / 3) % 1;
            sinkG.circle(4 + i * 4, 7 - ph * 4, 1).fill({ color: 0xffffff, alpha: 0.7 * (1 - ph) });
          }
        }
      };
      drawSink(0);

      const machineG = new Graphics(); // steam over the counter machine while brewing
      machineG.eventMode = 'none';
      machineG.position.set(26 * ts0, 17 * ts0);
      machineG.zIndex = 19 * ts0;
      charLayer.addChild(machineG);
      let machineBusy = 0;
      const drawMachine = (t: number): void => {
        machineG.clear();
        if (machineBusy <= 0) return;
        for (let i = 0; i < 2; i++) {
          const ph = (t * 0.9 + i * 0.5) % 1;
          machineG.rect(6 + i * 3, 2 - Math.round(ph * 5), 1, 1)
            .fill({ color: 0xffffff, alpha: 0.6 * (1 - ph) });
        }
      };

      // One coffee-run leg: walk somewhere, then act. Drives rt.run through its
      // phases; the per-tick engine below advances the timed (acting) phases.
      const finishRun = (rt: Runtime): void => {
        rt.run = undefined;
        const c = rt.character;
        if (c.isCarryingCup()) {
          rt.cupCarryHome = true;   // whatever happened, a held cup goes home
          c.hideThought();
          c.sitAtDesk(false);
        } else {
          c.hideThought();
          c.startWandering();
        }
      };

      const startRunLeg = (rt: Runtime, phase: 'toTray' | 'toMachine' | 'toSink' | 'toTrayBack'): void => {
        rt.run = { phase, timer: 0 };
        const c = rt.character;
        const dest = phase === 'toMachine' ? MACHINE_STAND
          : phase === 'toSink' ? SINK_STAND
          : TRAY_STAND;
        c.walkToAndThen(dest, () => {
          if (!rt.run || rt.run.phase !== phase) return;
          c.faceDirection('up'); // every station faces its counter to the north
          if (phase === 'toTray') {
            if (cleanCups <= 0) {
              // Rack ran dry — every mug is parked on someone's desk.
              c.showThought('no clean mugs left…');
              rt.run = { phase: 'placing', timer: -1 }; // brief sulk, then move on
              return;
            }
            cleanCups--;
            drawTray();
            c.setCarryingCup(true);
            rt.run = { phase: 'taking', timer: 0 };
          } else if (phase === 'toMachine') {
            c.showThought('brewing a fresh one ☕');
            machineBusy = 2.6;
            rt.run = { phase: 'brewing', timer: 0 };
          } else if (phase === 'toSink') {
            c.showThought('washing the mug');
            sinkBusy = 2.4;
            rt.run = { phase: 'washing', timer: 0 };
          } else {
            c.setCarryingCup(false);
            cleanCups = Math.min(MAX_CUPS, cleanCups + 1);
            drawTray();
            rt.run = { phase: 'placing', timer: 0 };
          }
        });
      };

      /** Cancel a coffee run (real work / teardown). A held mug rides along to
       *  the desk via cupCarryHome; the floor fixtures just stop animating. */
      const releaseRun = (rt: Runtime): void => {
        if (!rt.run) return;
        rt.run = undefined;
        if (rt.character.isCarryingCup()) rt.cupCarryHome = true;
      };

      let fxClock = 0;
      const updateCoffeeRuns = (dt: number): void => {
        fxClock += dt;
        if (sinkBusy > 0) { sinkBusy -= dt; drawSink(fxClock); }
        if (machineBusy > 0) { machineBusy -= dt; drawMachine(fxClock); }
        for (const [, rt] of runtimes) {
          const run = rt.run;
          if (!run) continue;
          run.timer += dt;
          const c = rt.character;
          switch (run.phase) {
            case 'toTray':
            case 'toMachine':
            case 'toSink':
            case 'toTrayBack':
              if (run.timer > 20) finishRun(rt); // never arrived — give up
              break;
            case 'taking':
              if (run.timer >= 0.8) startRunLeg(rt, 'toMachine');
              break;
            case 'brewing':
              if (run.timer >= 2.6) finishRun(rt); // cup in hand → heads home
              break;
            case 'washing':
              if (run.timer >= 2.4) startRunLeg(rt, 'toTrayBack');
              break;
            case 'placing':
              if (run.timer >= 0.6) finishRun(rt);
              break;
          }
        }
      };

      const emitQuip = (id: string, rt: Runtime, spotIdx: number): void => {
        const spot = cafeSpots[spotIdx];
        const character = agentById(id)?.character ?? DEFAULT_CHARACTER;
        const seed = Math.floor(Math.random() * 1e6);
        rt.character.showThought(pickSoloLine(character, spot.spot, seed));
      };

      // If the newcomer's table-mate is already lingering (and neither is mid-
      // conversation), start a multi-beat exchange. The newcomer is the
      // initiator and owns the script; the partner just gets marked engaged.
      // Returns true if a chat was started.
      const maybePairChat = (id: string, rt: Runtime, spotIdx: number): boolean => {
        const spot = cafeSpots[spotIdx];
        if (spot.partner < 0 || !rt.brk) return false;
        const partnerId = cafeTaken[spot.partner];
        if (!partnerId) return false;
        const prt = runtimes.get(partnerId);
        if (!prt?.brk || prt.brk.phase !== 'lingering') return false;
        if (rt.brk.chat || rt.brk.chattingWith || prt.brk.chat || prt.brk.chattingWith) return false;
        const character = agentById(id)?.character ?? DEFAULT_CHARACTER;
        const lines = pickExchange(character, Math.floor(Math.random() * 1e6));
        rt.brk.chat = { lines, partnerId, idx: 0, beat: 0 };
        prt.brk.chattingWith = id;
        return true;
      };

      // Free a café seat and tidy up any conversation links so neither agent is
      // left mid-chat. Called when a break ends OR is interrupted by real work.
      const releaseBreak = (rt: Runtime): void => {
        if (!rt.brk) return;
        if (rt.brk.chat) {
          const p = runtimes.get(rt.brk.chat.partnerId);
          if (p?.brk) p.brk.chattingWith = undefined;
        }
        if (rt.brk.chattingWith) {
          const o = runtimes.get(rt.brk.chattingWith);
          if (o?.brk) o.brk.chat = undefined;
        }
        cafeTaken[rt.brk.spotIdx] = null;
        rt.brk = undefined;
      };

      // End a break gracefully: free the seat, drop the bubble — and settle the
      // coffee question. An agent that brought its used desk mug along either
      // just REFILLS it at the machine (the lazy path) or properly WASHES it at
      // the sink and racks it back on the sideboard. An agent without a mug
      // fetches a clean one off the rack first — no mug, no coffee: if the rack
      // ran dry the run ends in a sulk instead of a brew.
      const endBreak = (id: string, rt: Runtime): void => {
        const arrived = rt.brk?.phase === 'lingering';
        releaseBreak(rt);
        rt.character.hideThought();
        const agent = agentById(id);
        if (agent?.isGod) { rt.character.sitAtDesk(true); return; }
        const c = rt.character;
        if (!arrived) {
          // Never made it to the café (watchdog) — a held mug still goes home.
          if (c.isCarryingCup()) { rt.cupCarryHome = true; c.sitAtDesk(false); }
          else c.startWandering();
          return;
        }
        if (c.isCarryingCup()) {
          // Brought the used desk mug along: 60% lazy refill, 40% proper wash.
          if (Math.random() < 0.6) startRunLeg(rt, 'toMachine');
          else startRunLeg(rt, 'toSink');
        } else if (!c.hasCupOnDesk() && Math.random() < 0.75) {
          startRunLeg(rt, 'toTray'); // fetch a clean mug, then brew
        } else {
          c.startWandering();
        }
      };

      const startBreak = (id: string, rt: Runtime): void => {
        // Prefer (≈half the time) a seat whose table-mate is already there, so
        // pairs form and chat; otherwise any free spot.
        const free: number[] = [];
        const social: number[] = [];
        for (let i = 0; i < cafeSpots.length; i++) {
          if (cafeTaken[i]) continue;
          free.push(i);
          const p = cafeSpots[i].partner;
          if (p >= 0 && cafeTaken[p]) social.push(i);
        }
        if (free.length === 0) return;
        const pool = (social.length && Math.random() < 0.55) ? social : free;
        const idx = pool[Math.floor(Math.random() * pool.length)];
        const spot = cafeSpots[idx];
        cafeTaken[idx] = id;
        rt.brk = { spotIdx: idx, phase: 'walking', timer: 0, quipTimer: 0 };
        const c = rt.character;
        // A mug still parked on the desk comes along to the break — it stays
        // in hand through the lingering (sipping at the table) and gets either
        // refilled or washed when the break ends (see endBreak).
        if (c.hasCupOnDesk()) {
          c.setCupOnDesk(false);
          c.setCarryingCup(true);
        }
        c.walkToAndThen(spot.tile, () => {
          // Bail if the break was cancelled or reassigned while walking.
          if (!rt.brk || rt.brk.spotIdx !== idx) return;
          if (spot.seated) c.sitInPlace(spot.facing);
          else { c.setIdle(); c.faceDirection(spot.facing); }
          rt.brk.phase = 'lingering';
          rt.brk.timer = 8 + Math.random() * 8;   // 8–16s of lingering
          rt.brk.quipTimer = 4 + Math.random() * 4;
          // Start a conversation if the table-mate is here; otherwise a solo quip.
          if (!maybePairChat(id, rt, idx)) emitQuip(id, rt, idx);
        });
      };

      const breakEligible = (agent: Agent, rt: Runtime): boolean => {
        if (agent.isGod || rt.brk || rt.wtr || rt.run || rt.cupCarryHome) return false;
        if (agent.status !== 'idle' && agent.status !== 'success') return false;
        return !rt.character.isSitting();   // already parked at a desk → leave it
      };

      let cafeCooldown = 5;
      const updateCafeteria = (dt: number): void => {
        // Advance every in-progress break.
        for (const [id, rt] of runtimes) {
          const b = rt.brk;
          if (!b) continue;
          if (b.phase === 'walking') {
            b.timer += dt;
            if (b.timer > 20) endBreak(id, rt);   // never arrived — give up
            continue;
          }
          // lingering
          if (b.chat) {
            // Play the conversation one beat at a time, alternating speakers.
            b.chat.beat -= dt;
            if (b.chat.beat <= 0) {
              if (b.chat.idx < b.chat.lines.length) {
                const speaker = (b.chat.idx % 2 === 0) ? rt : runtimes.get(b.chat.partnerId);
                speaker?.character.showThought(b.chat.lines[b.chat.idx]);
                b.chat.idx++;
                b.chat.beat = 2.4;                // seconds per line
                b.timer = Math.max(b.timer, 3.5); // keep both around to finish
                const prt = runtimes.get(b.chat.partnerId);
                if (prt?.brk) prt.brk.timer = Math.max(prt.brk.timer, 3.5);
              } else {
                // Conversation over — release the partner and resume solo quips.
                const prt = runtimes.get(b.chat.partnerId);
                if (prt?.brk) prt.brk.chattingWith = undefined;
                b.chat = undefined;
              }
            }
          } else if (!b.chattingWith) {
            // Not in a conversation (and not being spoken to) — swap a solo quip.
            b.quipTimer -= dt;
            if (b.quipTimer <= 0) {
              b.quipTimer = 4 + Math.random() * 4;
              emitQuip(id, rt, b.spotIdx);
            }
            // Occasionally strike up a chat with a table-mate who arrived too.
            else if (Math.random() < 0.004) maybePairChat(id, rt, b.spotIdx);
          }
          b.timer -= dt;
          if (b.timer <= 0) endBreak(id, rt);
        }

        // Periodically send one idle agent on a break — but cap the room at 4.
        cafeCooldown -= dt;
        if (cafeCooldown > 0) return;
        cafeCooldown = 6 + Math.random() * 6;
        if (cafeTaken.filter(Boolean).length >= 4) return;
        if (Math.random() >= 0.7) return;          // not every window — keep it casual
        const candidates: Array<[Agent, Runtime]> = [];
        for (const agent of useStore.getState().agents) {
          const rt = runtimes.get(agent.id);
          if (rt && breakEligible(agent, rt)) candidates.push([agent, rt]);
        }
        if (candidates.length === 0) return;
        const [agent, rt] = candidates[Math.floor(Math.random() * candidates.length)];
        startBreak(agent.id, rt);
      };

      // ─── Plants: watering errands for the truly idle ───────────────────────
      // The office plants (painted into the map) each have a stand tile next to
      // them. Every so often one idle agent strolls over, faces the plant, and
      // gives it a drink — small, purposeful busywork for a quiet floor.
      const PLANTS: Array<{ stand: Tile; facing: Facing }> = [
        { stand: { x: 2, y: 20 }, facing: 'left' },   // tall plant, bottom-left corner
        { stand: { x: 22, y: 20 }, facing: 'right' }, // tall plant, end of the desk rows
        { stand: { x: 30, y: 20 }, facing: 'right' }, // tall plant, right room
        { stand: { x: 6, y: 4 }, facing: 'up' },      // potted plant, the CEO office
        { stand: { x: 17, y: 4 }, facing: 'up' }      // potted plant, the corridor
      ];
      const plantTaken: (string | null)[] = new Array(PLANTS.length).fill(null);

      const releaseWatering = (id: string, rt: Runtime): void => {
        if (!rt.wtr) return;
        plantTaken[rt.wtr.plantIdx] = null;
        rt.wtr = undefined;
        rt.character.stopWatering();
      };

      let wtrCooldown = 20;
      const updateWatering = (dt: number): void => {
        // Watchdog walking errands that never arrive; everything else is event-driven.
        for (const [id, rt] of runtimes) {
          if (!rt.wtr) continue;
          rt.wtr.timer += dt;
          if (rt.wtr.phase === 'walking' && rt.wtr.timer > 20) {
            releaseWatering(id, rt);
            rt.character.startWandering();
          }
        }
        wtrCooldown -= dt;
        if (wtrCooldown > 0) return;
        wtrCooldown = 16 + Math.random() * 22;
        if (Math.random() >= 0.6) return;          // keep it occasional
        const freePlants = PLANTS.map((_, i) => i).filter((i) => !plantTaken[i]);
        if (freePlants.length === 0) return;
        const candidates: Array<[Agent, Runtime]> = [];
        for (const agent of useStore.getState().agents) {
          const rt = runtimes.get(agent.id);
          if (rt && breakEligible(agent, rt)) candidates.push([agent, rt]);
        }
        if (candidates.length === 0) return;
        const [agent, rt] = candidates[Math.floor(Math.random() * candidates.length)];
        const plantIdx = freePlants[Math.floor(Math.random() * freePlants.length)];
        const plant = PLANTS[plantIdx];
        const c = rt.character;
        plantTaken[plantIdx] = agent.id;
        rt.wtr = { phase: 'walking', timer: 0, plantIdx };
        c.walkToAndThen(plant.stand, () => {
          if (!rt.wtr || rt.wtr.plantIdx !== plantIdx) return;
          rt.wtr.phase = 'watering';
          rt.wtr.timer = 0;
          c.faceDirection(plant.facing);
          c.showThought('watering the plants 🌿');
          c.startWatering(4.5, () => {
            releaseWatering(agent.id, rt);
            c.hideThought();
            c.startWandering();
          });
        });
      };

      // ─── Coffee delivery + desk screens, every frame ───────────────────────
      const updateDeskLife = (dt: number): void => {
        for (const [id, rt] of runtimes) {
          // Park the carried coffee the moment its courier is seated at home —
          // then, if there's still nothing to do, get up and wander off (the
          // cup stays, steaming, beside the monitor).
          if (rt.cupCarryHome && rt.character.isSittingAtDesk()) {
            rt.cupCarryHome = false;
            rt.character.setCarryingCup(false);
            rt.character.setCupOnDesk(true);
            const agent = agentById(id);
            if (agent && !agent.isGod && (agent.status === 'idle' || agent.status === 'success')) {
              rt.character.startWandering();
            }
          }
          // The monitor lights up whenever its owner is in the chair.
          if (rt.screen) {
            rt.screen.setOn(rt.character.isSittingAtDesk());
            rt.screen.update(dt);
          }
        }
      };

      const addCharacter = async (agent: Agent) => {
        const charName = CAST_BY_NAME[agent.character] ? agent.character : DEFAULT_CHARACTER;
        const member = CAST_BY_NAME[charName];
        const seatIndex = claimSeat(agent);
        const seatTile: Tile = (seatIndex != null ? seatTiles[seatIndex] : undefined)
          ?? mapRenderer.getSpawnPoint('entrance')
          ?? { x: 2, y: 2 };
        const waitTile = waitTiles[(seatIndex ?? 0) % waitTiles.length];
        const frames = await getCastFrames(charName);
        // Bail if the agent was removed (or scene torn down) while loading.
        if (mountIdRef.current !== mountId) return;
        if (!useStore.getState().agents.some((a) => a.id === agent.id)) {
          if (seatIndex != null) seatClaims.delete(seatIndex);
          return;
        }
        const character = new Character({
          agentId: agent.id,
          mapRenderer,
          frames,
          seatTile,
          seatDirection: facingForSeat(seatTile),
          spawnTile: entrance, // walk in from the office door
          glowColor: hexNum(colors.accent[agent.accent]) ?? hexToNumber(member.shirt),
          onClick: (id) => useStore.getState().select(id),
        });
        character.show(charLayer);
        const rt: Runtime = { character, seatIndex, waitTile, charName };
        // Standard desks paint the 2×2 PC monitor two rows above the seat —
        // give those a DeskScreen (lights up while seated) and a cup spot
        // beside the monitor, exactly where the tileset's baked-in mug used
        // to sit before we cleared it (desks start clean now; cups only exist
        // where an agent actually carried one).
        if (mapRenderer.gidAt('furniture-above', seatTile.x, seatTile.y - 2) === MONITOR_OFF_TOPLEFT_GID) {
          const top = { x: seatTile.x, y: seatTile.y - 2 };
          rt.screen = new DeskScreen(mapRenderer, top);
          charLayer.addChild(rt.screen.container);
          const ts2 = mapRenderer.tileSize;
          character.setCupSpot({ x: top.x * ts2 + 18, y: top.y * ts2 + 23 });
        }
        runtimes.set(agent.id, rt);
        applyState(agent, rt, true);
      };

      const removeCharacter = (id: string) => {
        const rt = runtimes.get(id);
        if (!rt) return;
        releaseBreak(rt);                // free any café seat it was holding
        releaseWatering(id, rt);         // and any plant it was tending
        releaseRun(rt);                  // and any coffee run in progress
        // Facilities collects an abandoned mug (carried or parked on the desk)
        // back onto the sideboard, so the finite cup stock can never leak away.
        if (rt.character.isCarryingCup() || rt.character.hasCupOnDesk()) {
          cleanCups = Math.min(MAX_CUPS, cleanCups + 1);
          drawTray();
        }
        if (rt.seatIndex != null) seatClaims.delete(rt.seatIndex);
        rt.screen?.destroy();
        rt.character.hide(0);
        // give the fade-out a moment, then destroy
        setTimeout(() => rt.character.destroy(), 700);
        runtimes.delete(id);
      };

      // Map an agent's store state onto its on-floor character.
      const applyState = (agent: Agent, rt: Runtime, force = false) => {
        const changed = force
          || rt.prevStatus !== agent.status
          || rt.prevAction !== agent.action
          || rt.prevCarrying !== agent.carrying
          || rt.prevPrompt !== agent.lastPrompt;
        if (!changed) return;
        // Finishing real work (working/thinking/compacting → done) earns a
        // little celebration before the avatar goes back to roaming.
        const finishedWork = !force && !agent.isGod
          && (rt.prevStatus === 'working' || rt.prevStatus === 'thinking' || rt.prevStatus === 'compacting')
          && (agent.status === 'idle' || agent.status === 'success');
        rt.prevStatus = agent.status;
        rt.prevAction = agent.action;
        rt.prevCarrying = agent.carrying;
        rt.prevPrompt = agent.lastPrompt;

        const c = rt.character;
        c.setBaseAlpha(agent.status === 'ghost' ? 0.5 : 1);

        // While an agent is on a coffee break the director owns its avatar — a
        // mere idle/success refresh must not yank it back to wandering. Any
        // other live status (work, blocked, …) cancels the break and falls
        // through to normal handling, sending it back to its desk / the door.
        if (rt.brk) {
          if (agent.status === 'idle' || agent.status === 'success') {
            c.setStatusGlyph(agent.status === 'success' ? 'success' : 'none');
            return;
          }
          releaseBreak(rt);
        }
        // Same for a watering errand: idle refreshes leave it alone, real work
        // cancels it (the can disappears, the agent heads to its desk).
        if (rt.wtr) {
          if (agent.status === 'idle' || agent.status === 'success') {
            c.setStatusGlyph(agent.status === 'success' ? 'success' : 'none');
            return;
          }
          releaseWatering(agent.id, rt);
        }
        // And for a coffee run: real work cancels it mid-stride — a mug already
        // in hand simply rides along to the desk (cupCarryHome parks it there).
        if (rt.run) {
          if (agent.status === 'idle' || agent.status === 'success') {
            c.setStatusGlyph(agent.status === 'success' ? 'success' : 'none');
            return;
          }
          releaseRun(rt);
        }

        // A thought cloud above the head shows what the agent is doing RIGHT NOW
        // (its live `action`, e.g. "edit App.tsx"). Working → sit at the desk;
        // blocked → walk to the door and flash "!"; done/idle → wander.
        switch (agent.status) {
          case 'working':
          case 'thinking':
            c.setStatusGlyph('none');
            c.sitAtDesk(true);
            c.showThought(liveActivity(agent), agent.carrying);
            break;
          case 'waiting':
            // Parked at the desk awaiting god / another agent — not actively
            // working (no focus glow) and NOT at the door (that's reserved for
            // agents that need the human).
            c.setStatusGlyph('none');
            c.sitAtDesk(false);
            c.showThought(liveActivity(agent, 'waiting'), agent.carrying);
            break;
          case 'blocked':
            c.setStatusGlyph('blocked');
            c.showThought(liveActivity(agent, 'needs you'));
            c.walkToTile(rt.waitTile);
            break;
          case 'compacting':
            // #5C — mid-/compact: stay put at the desk, "boxing up" glyph + thought,
            // so an agent compacting context reads as busy rather than frozen.
            c.setStatusGlyph('compacting');
            c.sitAtDesk(true);
            c.showThought(liveActivity(agent, 'compacting context'));
            break;
          case 'looping':
            // #5C — circuit-breaker armed (#6): hold position with the spinning
            // warning glyph so a runaway agent is visible on the floor.
            c.setStatusGlyph('looping');
            c.sitAtDesk(false);
            c.showThought(liveActivity(agent, 'looping — breaker armed'));
            break;
          case 'success':
            c.setStatusGlyph('success');
            if (agent.isGod) { c.hideThought(); c.sitAtDesk(true); break; }
            c.startWandering();
            if (finishedWork) {
              c.cheer();
              c.showThought(CHEER_LINES[Math.floor(Math.random() * CHEER_LINES.length)]);
            } else {
              c.hideThought();
            }
            break;
          case 'ghost':
            c.setStatusGlyph('none');
            c.hideThought();
            c.setIdle();
            break;
          case 'idle':
          default:
            c.setStatusGlyph('none');
            // The god runs the floor from its desk; everyone else wanders when idle.
            if (agent.isGod) { c.sitAtDesk(true); c.showThought(liveActivity(agent, 'running the floor')); }
            else if (finishedWork) {
              // Task done → a quick cheer on the spot, then back to roaming.
              c.startWandering();
              c.cheer();
              c.showThought(CHEER_LINES[Math.floor(Math.random() * CHEER_LINES.length)]);
            }
            else { c.startWandering(); c.showThought(liveActivity(agent, 'idle')); }
            break;
        }
      };

      const syncAgents = () => {
        const { agents } = useStore.getState();
        const present = new Set(agents.map((a) => a.id));
        for (const id of Array.from(runtimes.keys())) {
          if (!present.has(id)) removeCharacter(id);
        }
        for (const agent of agents) {
          const rt = runtimes.get(agent.id);
          if (!rt) void addCharacter(agent);
          else applyState(agent, rt);
        }
      };

      syncAgents();

      let lastSelected: string | null = useStore.getState().selectedId;
      const unsubscribe = useStore.subscribe((s, prev) => {
        if (s.agents !== prev.agents) syncAgents();
        if (s.selectedId !== lastSelected) {
          lastSelected = s.selectedId;
          const rt = s.selectedId ? runtimes.get(s.selectedId) : undefined;
          if (rt) {
            const p = rt.character.getPixelPosition();
            camera.nudgeToward(p.x, p.y);
          }
        }
      });
      (app as any).__unsub = unsubscribe;

      // Fly an envelope from a sender's desk to each recipient when the hive
      // routes a message. Endpoints are snapshotted at spawn, so the paper flies
      // a clean arc even if the avatars wander mid-flight. 'human' recipients
      // (escalations) fly to the office door.
      const ts = mapRenderer.tileSize;
      const humanPos = { x: entrance.x * ts + ts / 2, y: entrance.y * ts + ts };
      const posFor = (id: string): { x: number; y: number } | null => {
        if (id === 'human') return humanPos;
        const rt = runtimes.get(id);
        return rt ? rt.character.getPixelPosition() : null;
      };
      const spawnHandoff = (fromId: string, toId: string, act: MessageAct, needsHuman: boolean) => {
        if (envelopes.length >= MAX_ENVELOPES) return;
        if (toId === fromId) return; // never mail yourself
        const from = posFor(fromId);
        const to = posFor(toId);
        if (!from || !to) return; // sender or recipient not on the floor
        const env = new MessageEnvelope(from, to, act, needsHuman);
        charLayer.addChild(env.container);
        envelopes.push(env);
      };

      // Real path: the main-process router emits one event per routed message.
      // Guarded so a stale preload bridge (e.g. before a dev-server restart adds
      // this method) degrades to "no envelopes" rather than crashing the floor.
      const offMessage = window.cth.onHiveMessage
        ? window.cth.onHiveMessage((e) => {
            for (const target of e.targets) spawnHandoff(e.from, target, e.act, e.needsHuman);
          })
        : () => { /* onHiveMessage unavailable — real handoffs disabled this session */ };
      // Demo path: with no live hive, the mock loop dispatches synthetic handoffs
      // so the animation is still visible. Clearly demo-only, fed by mockEvents.ts.
      const onDemoHandoff = (ev: Event) => {
        const d = (ev as CustomEvent<{ from: string; to: string; act: MessageAct }>).detail;
        if (d) spawnHandoff(d.from, d.to, d.act, false);
      };
      window.addEventListener('cth:demo-handoff', onDemoHandoff);
      (app as any).__offMessage = () => {
        offMessage();
        window.removeEventListener('cth:demo-handoff', onDemoHandoff);
      };

      // Keep two nearby thought clouds from covering each other: stack the
      // overlapping ones upward. Computed from each bubble's BASE rect (ignoring
      // the lift already applied) so the result is stable frame-to-frame.
      const resolveBubbleOverlaps = () => {
        const items: Array<{ rt: Runtime; x: number; y: number; w: number; h: number }> = [];
        for (const rt of runtimes.values()) {
          const lay = rt.character.getThoughtLayout();
          if (lay) items.push({ rt, ...lay });
        }
        if (items.length < 2) {
          for (const it of items) it.rt.character.setThoughtLift(0);
          return;
        }
        // Lower bubbles (greater bottom edge) and left-most ones hold their spot;
        // the rest get pushed above them. Deterministic ordering → no flicker.
        items.sort((a, b) => (b.y + b.h) - (a.y + a.h) || a.x - b.x);
        const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
        const pad = 2;
        for (const it of items) {
          let y = it.y;
          let moved = true, guard = 0;
          while (moved && guard++ < 12) {
            moved = false;
            for (const p of placed) {
              const overlapX = it.x < p.x + p.w + pad && it.x + it.w + pad > p.x;
              const overlapY = y < p.y + p.h + pad && y + it.h + pad > p.y;
              if (overlapX && overlapY) { y = p.y - it.h - pad; moved = true; }
            }
          }
          placed.push({ x: it.x, y, w: it.w, h: it.h });
          it.rt.character.setThoughtLift(it.y - y);   // positive → shift up
        }
      };

      const onTick = (ticker: Ticker) => {
        const dt = ticker.deltaMS / 1000;
        camera.update(dt);
        // Thought clouds counter-scale against the camera so their text never
        // renders below 1:1 screen size when the window/world shrinks.
        const zoom = world.scale.x;
        for (const rt of runtimes.values()) {
          rt.character.setBubbleZoom(zoom);
          rt.character.update(dt);
        }
        updateCafeteria(dt);
        updateCoffeeRuns(dt);
        updateWatering(dt);
        updateDeskLife(dt);
        resolveBubbleOverlaps();
        for (let i = envelopes.length - 1; i >= 0; i--) {
          if (envelopes[i].update(dt)) {
            envelopes[i].destroy();
            envelopes.splice(i, 1);
          }
        }
      };
      app.ticker.add(onTick);

      const resize = new ResizeObserver((entries) => {
        for (const e of entries) {
          const { width, height } = e.contentRect;
          if (width === 0 || height === 0) continue;
          app.renderer?.resize(width, height);
          camera.setViewSize(width, height);
        }
      });
      resize.observe(host);
      (app as any).__resize = resize;
    };

    init().catch((err) => {
      if (mountIdRef.current !== mountId) return;
      console.error('[OfficeFloor] init failed:', err);
      const banner = document.createElement('div');
      banner.style.cssText =
        'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
        'padding:24px;color:#ffd0b5;font-family:monospace;font-size:13px;text-align:center;white-space:pre-wrap;';
      banner.textContent = 'OfficeFloor failed to start:\n' + (err?.stack || err?.message || String(err));
      host.appendChild(banner);
    });

    return () => {
      mountIdRef.current++;
      const a = appRef.current;
      if (a) {
        (a as any).__resize?.disconnect?.();
        try { (a as any).__unsub?.(); } catch { /* noop */ }
        try { (a as any).__offMessage?.(); } catch { /* noop */ }
        safeDestroy(a);
      }
      appRef.current = null;
      while (host.firstChild) host.removeChild(host.firstChild);
    };
  }, []);

  return (
    <div
      ref={hostRef}
      style={{
        width: '100%', height: '100%',
        boxShadow: 'var(--cth-panel-border)',
        overflow: 'hidden',
        imageRendering: 'pixelated',
        background: hex(colors.ink[900]),
      }}
    />
  );
}

function hexNum(n: number): number { return n; }
function hex(n: number): string { return '#' + n.toString(16).padStart(6, '0'); }
function safeDestroy(app: Application) {
  try { app.ticker?.stop(); } catch { /* noop */ }
  try { app.destroy(true, { children: true }); } catch { /* noop */ }
}

import { Container, Sprite, Texture, Rectangle } from 'pixi.js';

// Trimmed port of shahar061/the-office (office/engine/TiledMapRenderer.ts):
// renders floor/walls/furniture tile layers and parses collision, spawn-points
// and zones. Interactive-object / war-room / monitor-glow extraction is dropped
// (we render every tile statically), so no tiles ever go missing.

const FLIPPED_H_FLAG = 0x80000000;
const FLIPPED_V_FLAG = 0x40000000;
const FLIPPED_D_FLAG = 0x20000000;
const TILE_ID_MASK = 0x1fffffff;

export interface TiledMap {
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  layers: TiledLayer[];
  tilesets: TiledTilesetRef[];
}

export interface TiledLayer {
  name: string;
  type: 'tilelayer' | 'objectgroup';
  data?: number[];
  objects?: TiledObject[];
}

export interface TiledObject {
  name: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface TiledTilesetRef {
  firstgid: number;
  source?: string;
  image?: string;
  columns?: number;
  tilewidth?: number;
  tileheight?: number;
  tilecount?: number;
}

export interface ZoneRect { x: number; y: number; width: number; height: number; }
export interface Point { x: number; y: number; }

const TILE_LAYERS = ['floor', 'walls', 'furniture-below', 'furniture-above'] as const;
const COLLISION_LAYER = 'collision';
const SPAWN_POINTS_LAYER = 'spawn-points';
const ZONES_LAYER = 'zones';

export class TiledMapRenderer {
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;

  private walkabilityGrid: boolean[][] = [];
  private spawnPoints: Map<string, Point> = new Map();
  private zones: Map<string, ZoneRect> = new Map();
  private characterContainer: Container;
  private rootContainer: Container;

  private static readonly WALKABLE_SPAWN_PREFIXES = ['desk-', 'pc-', 'warroom-', 'entrance'];

  constructor(private mapData: TiledMap, private tilesetTextures: Texture[]) {
    this.width = mapData.width;
    this.height = mapData.height;
    this.tileSize = mapData.tilewidth;
    this.rootContainer = new Container();
    this.characterContainer = new Container();
    this.characterContainer.sortableChildren = true;

    this.parseCollisionLayer();
    this.parseSpawnPoints();
    this.markWalkableSpawnPoints();
    this.parseZones();
    this.buildTileLayers();
  }

  getContainer(): Container { return this.rootContainer; }
  getCharacterContainer(): Container { return this.characterContainer; }

  isWalkable(tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return false;
    return this.walkabilityGrid[ty][tx];
  }

  tileToPixel(tx: number, ty: number): Point {
    return { x: tx * this.tileSize, y: ty * this.tileSize };
  }

  pixelToTile(px: number, py: number): Point {
    return { x: Math.floor(px / this.tileSize), y: Math.floor(py / this.tileSize) };
  }

  getSpawnPoint(name: string): Point | undefined { return this.spawnPoints.get(name); }
  getAllSpawnPoints(): Map<string, Point> { return this.spawnPoints; }
  getZone(name: string): ZoneRect | undefined { return this.zones.get(name); }
  getAllZones(): Map<string, ZoneRect> { return this.zones; }

  /** The (flip-stripped) gid painted at a tile of a layer, 0 when empty.
   *  Lets the scene locate furniture by art — e.g. each desk's monitor block. */
  gidAt(layerName: string, tx: number, ty: number): number {
    const layer = this.findLayer(layerName, 'tilelayer');
    if (!layer?.data || tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return 0;
    return (layer.data[ty * this.width + tx] ?? 0) & TILE_ID_MASK;
  }

  /** A sub-texture for one tileset tile, addressed by gid — for dynamic props
   *  that reuse map art (e.g. the lit monitor variant overlaid when an agent
   *  sits down). Returns undefined for gid 0 / out-of-range.
   *  NOTE: allocates a fresh Texture per call and the CALLER owns its lifetime
   *  (fine for constructor-time use, kept alive by sprites; do NOT call this
   *  per frame or the textures leak). */
  textureForGid(gid: number): Texture | undefined {
    const tileId = gid & TILE_ID_MASK;
    if (tileId === 0) return undefined;
    const resolved = this.resolveTileset(tileId);
    if (!resolved) return undefined;
    const { tileset, texture } = resolved;
    const cols = tileset.columns ?? 16;
    const tw = tileset.tilewidth ?? this.tileSize;
    const th = tileset.tileheight ?? this.tileSize;
    const localId = tileId - tileset.firstgid;
    const frame = new Rectangle((localId % cols) * tw, Math.floor(localId / cols) * th, tw, th);
    return new Texture({ source: texture.source, frame });
  }

  private parseCollisionLayer(): void {
    const layer = this.findLayer(COLLISION_LAYER, 'tilelayer');
    this.walkabilityGrid = Array.from({ length: this.height }, () => Array(this.width).fill(true));
    if (!layer?.data) return;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const rawId = layer.data[y * this.width + x];
        if ((rawId & TILE_ID_MASK) !== 0) this.walkabilityGrid[y][x] = false;
      }
    }
  }

  private parseSpawnPoints(): void {
    const layer = this.findLayer(SPAWN_POINTS_LAYER, 'objectgroup');
    if (!layer?.objects) return;
    for (const obj of layer.objects) {
      this.spawnPoints.set(obj.name, {
        x: Math.floor(obj.x / this.tileSize),
        y: Math.floor(obj.y / this.tileSize),
      });
    }
  }

  /** Force seat/desk tiles walkable so agents can path onto them even though
   *  the underlying chair/desk tile is non-walkable in the collision layer. */
  private markWalkableSpawnPoints(): void {
    for (const [name, point] of this.spawnPoints) {
      if (!TiledMapRenderer.WALKABLE_SPAWN_PREFIXES.some((p) => name.startsWith(p))) continue;
      if (point.y >= 0 && point.y < this.height && point.x >= 0 && point.x < this.width) {
        this.walkabilityGrid[point.y][point.x] = true;
      }
    }
  }

  private parseZones(): void {
    const layer = this.findLayer(ZONES_LAYER, 'objectgroup');
    if (!layer?.objects) return;
    for (const obj of layer.objects) {
      this.zones.set(obj.name, {
        x: Math.floor(obj.x / this.tileSize),
        y: Math.floor(obj.y / this.tileSize),
        width: Math.floor((obj.width ?? 0) / this.tileSize),
        height: Math.floor((obj.height ?? 0) / this.tileSize),
      });
    }
  }

  private resolveTileset(tileId: number): { tileset: TiledTilesetRef; texture: Texture } | undefined {
    for (let i = this.mapData.tilesets.length - 1; i >= 0; i--) {
      if (tileId >= this.mapData.tilesets[i].firstgid) {
        return { tileset: this.mapData.tilesets[i], texture: this.tilesetTextures[i] };
      }
    }
    return undefined;
  }

  private buildTileLayers(): void {
    if (this.mapData.tilesets.length === 0) return;

    for (const layerName of TILE_LAYERS) {
      const layer = this.findLayer(layerName, 'tilelayer');
      const container = new Container();
      container.label = layerName;

      if (layer?.data) {
        for (let y = 0; y < this.height; y++) {
          for (let x = 0; x < this.width; x++) {
            const raw = layer.data[y * this.width + x];
            if (raw === 0) continue;

            const flippedH = (raw & FLIPPED_H_FLAG) !== 0;
            const flippedV = (raw & FLIPPED_V_FLAG) !== 0;
            const flippedD = (raw & FLIPPED_D_FLAG) !== 0;
            const tileId = raw & TILE_ID_MASK;

            const resolved = this.resolveTileset(tileId);
            if (!resolved) continue;

            const { tileset, texture } = resolved;
            const cols = tileset.columns ?? 16;
            const tw = tileset.tilewidth ?? this.tileSize;
            const th = tileset.tileheight ?? this.tileSize;
            const localId = tileId - tileset.firstgid;
            const srcX = (localId % cols) * tw;
            const srcY = Math.floor(localId / cols) * th;

            const frame = new Rectangle(srcX, srcY, tw, th);
            const sprite = new Sprite(new Texture({ source: texture.source, frame }));

            if (flippedH || flippedV || flippedD) {
              sprite.anchor.set(0.5, 0.5);
              sprite.x = x * this.tileSize + this.tileSize / 2;
              sprite.y = y * this.tileSize + this.tileSize / 2;
              if (flippedD) {
                if (flippedH && !flippedV) {
                  sprite.rotation = Math.PI / 2;
                } else if (!flippedH && flippedV) {
                  sprite.rotation = -Math.PI / 2;
                } else if (flippedH && flippedV) {
                  sprite.rotation = Math.PI / 2;
                  sprite.scale.y = -1;
                } else {
                  sprite.rotation = Math.PI / 2;
                  sprite.scale.x = -1;
                }
              } else {
                if (flippedH) sprite.scale.x = -1;
                if (flippedV) sprite.scale.y = -1;
              }
            } else {
              sprite.x = x * this.tileSize;
              sprite.y = y * this.tileSize;
            }

            container.addChild(sprite);
          }
        }
      }

      this.rootContainer.addChild(container);
    }

    // Characters render above every tile layer.
    this.rootContainer.addChild(this.characterContainer);
  }

  private findLayer(name: string, type: 'tilelayer' | 'objectgroup'): TiledLayer | undefined {
    return this.mapData.layers.find((l) => l.name === name && l.type === type);
  }
}

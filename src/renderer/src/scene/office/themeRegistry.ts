// 主题注册表——可插拔的“办公室主题”契约。
//
// 电视剧办公室功能的 Phase 0（卡片 tvshow-phase0-abstraction）：把原来硬编码
// 在 OfficeFloor.tsx 里约 40% 的常量（跑腿点、咖啡经济瓦片坐标、道具锚点、
// 座位名、tileset URL、调色板、显示器 gid）抽成 ThemeConfig，让场景可按剧集
// 替换。本阶段按原样发布现有办公室为 `theme: 'office'`：下面每个值都是从旧
// 文件内字面量逐字复制来的，所以办公室渲染与行为完全一致。
//
// 引擎（TiledMapRenderer / BFS 寻路 / Camera / 精灵动画）已经完全通用，无需
// 改动。cast.ts 在这里是只读的（未提交的人类 WIP）——office 主题引用它已有
// 的导出。

import type { Texture } from 'pixi.js';
import { colors } from '@/design/tokens';
import {
  CAST_BY_NAME,
  getCastFrames,
  DEFAULT_CHARACTER,
  type CastMember,
  type OfficeCharacterName,
} from './cast';

import officeTilesetUrl from '@/assets/tilesets/office-tileset.png?url';
import a5FloorsWallsUrl from '@/assets/tilesets/a5-office-floors-walls.png?url';
import interiorsUrl from '@/assets/tilesets/interiors.png?url';
// .tmj 是 Tiled JSON；作为原始文本导入，由加载器解析。
import officeMapRaw from '@/assets/maps/office.tmj?raw';
import brooklyn99MapRaw from '@/assets/maps/brooklyn99.tmj?raw';

/** 主题标识符。Phase 0 只有 `office`；五个电视剧主题（friends、
 *  brooklyn99、siliconvalley、got、hogwarts）在后续阶段落地。 */
export type ThemeId =
  | 'office'
  | 'friends'
  | 'brooklyn99'
  | 'siliconvalley'
  | 'got'
  | 'hogwarts';

export interface Tile { x: number; y: number; }
export type Facing = 'up' | 'down' | 'left' | 'right';

/** 办公室周围的小型空闲跑腿种类（含浇花）。'smoke' 是老板特供：在开着的
 *  窗边抽雪茄，只有 god。 */
export type ErrandKind =
  | 'water' | 'window' | 'dispenser' | 'fridge' | 'shelf' | 'bin' | 'smoke';

/** 一个空闲跑腿锚点：一个站立瓦片 + 朝向、一个用于氛围动画的 `fx` 瓦片、
 *  一段时长，以及可选的神明专属限制。 */
export interface ErrandSpot {
  kind: ErrandKind;
  stand: Tile;
  facing: Facing;
  fx: Tile;
  duration: number;
  godOnly?: boolean;
}

/** 一个 tileset 图集及其在全局 gid 空间里的位置。`embedded` 标记元数据已
 *  行内存在于地图自身 `tilesets[0]` 的图集（加载器保留地图的副本，只修补
 *  追加的图集）。 */
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

/** 桌面显示器覆盖 gid。地图画一块 OFF 显示器；DeskScreen 在桌子的 agent
 *  坐下时把匹配的 ON 瓦片叠上去。 */
export interface MonitorConfig {
  /** OFF 显示器块左上瓦片的 gid，按地图所画。 */
  offTopLeftGid: number;
  /** 匹配的 ON 瓦片，为相对块左上角的 [gid, dx, dy]。 */
  onGids: ReadonlyArray<readonly [number, number, number]>;
}

/** 咖啡经济的固定瓦片：餐边柜（马克杯架）→ 柜台咖啡机 → 水槽 → 回到
 *  餐边柜。`maxCups` 限制干净马克杯的库存。 */
export interface CoffeeConfig {
  trayTile: Tile;
  trayStand: Tile;
  machineStand: Tile;
  sinkTile: Tile;
  sinkStand: Tile;
  maxCups: number;
}

/** 可点击道具锚点（瓦片坐标）。calendar → TRIGGERS，boards → TASKS，
 *  clock → CLOSING TIME。 */
export interface AnchorConfig {
  calendar: Tile;
  boards: Tile;
  clock: Tile;
}

/** 主题调色板。`background` 是画布清除色；`noteColors` 是按任务状态索引的
 *  kanban 便签颜色。 */
export interface PaletteConfig {
  background: number;
  noteColors: Record<string, number>;
}

/** 每主题角色群加载器——未来的剧集可以借此替换自己的名册 + 精灵帧。
 *  office 主题指向 cast.ts 的导出。 */
export interface ThemeCast {
  byName: Record<string, CastMember>;
  getFrames: (name: string) => Promise<Texture[][]>;
  defaultCharacter: string;
}

/** 主题必须提供的完整契约。见报告 §A（主题契约）。 */
export interface ThemeConfig {
  id: ThemeId;
  /** 原始 Tiled JSON 文本；由 themeLoader 解析并修补 tileset。 */
  mapRaw: string;
  /** 有序图集——顺序同时匹配纹理加载顺序与地图的 tileset 数组
   *  （texture[i] ↔ tilesets[i]）。 */
  tilesets: TilesetEntry[];
  /** 桌面认领顺序，按生成点名（座位 0 = god / desk-ceo）。 */
  primarySeatNames: string[];
  /** 成对的咖啡桌座位，按顺序。 */
  cafeSeatNames: string[];
  /** 咖啡厅站立点：[生成点名, kind]。 */
  cafeStands: ReadonlyArray<readonly [string, 'coffee' | 'vending']>;
  coffee: CoffeeConfig;
  anchors: AnchorConfig;
  errandSpots: ErrandSpot[];
  monitor: MonitorConfig;
  palette: PaletteConfig;
  cast: ThemeCast;
}

/** 现有办公室，表达为一个主题。值逐字复制自 OfficeFloor.tsx / DeskScreen.ts
 *  里此前的文件内常量。 */
export const OFFICE_THEME: ThemeConfig = {
  id: 'office',
  mapRaw: officeMapRaw,
  tilesets: [
    // office-tileset.png — 嵌入在地图中（firstgid 1）；保留地图的副本。
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
    trayTile: { x: 29, y: 15 },     // 餐边柜（柜台件）
    trayStand: { x: 29, y: 16 },
    machineStand: { x: 26, y: 20 }, // 柜台咖啡机下方
    sinkTile: { x: 28, y: 18 },     // 空柜台顶，右端
    sinkStand: { x: 28, y: 20 },
    maxCups: 4,
  },
  anchors: {
    calendar: { x: 4, y: 1 },
    boards: { x: 6, y: 10 },
    clock: { x: 1, y: 1 },
  },
  errandSpots: [
    // 植物（水滴经 startWatering 骑在角色上）
    { kind: 'water', stand: { x: 2, y: 20 }, facing: 'left', fx: { x: 1, y: 20 }, duration: 4.5 },
    { kind: 'water', stand: { x: 22, y: 20 }, facing: 'right', fx: { x: 23, y: 20 }, duration: 4.5 },
    { kind: 'water', stand: { x: 30, y: 20 }, facing: 'right', fx: { x: 31, y: 20 }, duration: 4.5 },
    // CEO 办公室是 god 的地盘：它的植物、窗户、雪茄。普通员工绝不会为跑腿
    // 踏进那里。
    { kind: 'water', stand: { x: 6, y: 4 }, facing: 'up', fx: { x: 6, y: 3 }, duration: 4.5, godOnly: true },
    { kind: 'smoke', stand: { x: 2, y: 3 }, facing: 'up', fx: { x: 2, y: 1 }, duration: 18, godOnly: true },
    { kind: 'water', stand: { x: 17, y: 4 }, facing: 'up', fx: { x: 17, y: 3 }, duration: 4.5 },
    // 两扇公共墙窗——风痕飘进房间
    { kind: 'window', stand: { x: 10, y: 3 }, facing: 'up', fx: { x: 10, y: 1 }, duration: 5 },
    { kind: 'window', stand: { x: 15, y: 3 }, facing: 'up', fx: { x: 14, y: 1 }, duration: 5 },
    // 饮水机（走廊 + 右上角那台）
    { kind: 'dispenser', stand: { x: 16, y: 3 }, facing: 'down', fx: { x: 16, y: 4 }, duration: 3.5 },
    { kind: 'dispenser', stand: { x: 32, y: 4 }, facing: 'up', fx: { x: 32, y: 3 }, duration: 3.5 },
    // 咖啡厅冰箱（门缝灯泄出）+ 它旁边的架子
    { kind: 'fridge', stand: { x: 29, y: 20 }, facing: 'up', fx: { x: 29, y: 19 }, duration: 3.2 },
    { kind: 'shelf', stand: { x: 30, y: 20 }, facing: 'up', fx: { x: 30, y: 18 }, duration: 4 },
    // 垃圾桶（入口 + 咖啡厅）——纸团弧线飞入
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

/** Brooklyn Nine-Nine —— 99 分局（电视剧办公室功能 Phase 2，结构）。
 *  地图（brooklyn99.tmj）是一个分局大厅：后角是 Holt 警监的玻璃办公室
 *  （`desk-ceo`），8 桌探员大厅（`pc-1..8`），一个案情简报室（boardroom
 *  区域）+ 带咖啡经济的休息室（cafeteria 区域）。占位美术：地图复用办公室
 *  tileset 的 gid，所以下面的 tilesets / monitor / palette / cast 逐字复用
 *  office 主题——Pam 的许可干净 B99 tileset + 角色形象（§C/§D）稍后落入
 *  同样的接缝。只有布局绑定的锚点（座位、咖啡厅、咖啡、道具、跑腿）按
 *  brooklyn99.tmj 自己的坐标编写。 */
export const BROOKLYN99_THEME: ThemeConfig = {
  id: 'brooklyn99',
  mapRaw: brooklyn99MapRaw,
  // 占位：brooklyn99.tmj 使用办公室 gid 空间，所以同一批图集
  // （office-tileset 嵌入 @1、a5 @513、interiors @1025）解析所有瓦片。
  tilesets: OFFICE_THEME.tilesets,
  primarySeatNames: [
    'desk-ceo',                                            // Holt 警监的玻璃办公室
    'pc-1', 'pc-2', 'pc-3', 'pc-4',                        // 大厅——前排
    'pc-5', 'pc-6', 'pc-7', 'pc-8',                        // 大厅——后排
  ],
  cafeSeatNames: ['cafe-seat-1', 'cafe-seat-2', 'cafe-seat-3', 'cafe-seat-4'],
  cafeStands: [
    ['cafe-stand-coffee', 'coffee'],
    ['cafe-stand-vending', 'vending'],
  ],
  coffee: {
    trayTile: { x: 33, y: 18 },
    trayStand: { x: 33, y: 19 },
    machineStand: { x: 30, y: 21 },
    sinkTile: { x: 31, y: 18 },
    sinkStand: { x: 31, y: 19 },
    maxCups: 4,
  },
  anchors: {
    calendar: { x: 4, y: 1 },   // 简报室顶墙 → TRIGGERS
    boards: { x: 14, y: 1 },    // 大厅上方 → TASKS
    clock: { x: 1, y: 1 },      // 左上角 → CLOSING TIME
  },
  // 占位跑腿锚点，按 brooklyn99.tmj 的开阔地板编写（已对照地图碰撞层 +
  // 桌子印章验证可行走）。godOnly 点位于 Holt 的玻璃办公室内。
  errandSpots: [
    // 大厅周围的公共植物
    { kind: 'water', stand: { x: 2, y: 13 }, facing: 'left', fx: { x: 1, y: 13 }, duration: 4.5 },
    { kind: 'water', stand: { x: 24, y: 15 }, facing: 'right', fx: { x: 25, y: 15 }, duration: 4.5 },
    { kind: 'water', stand: { x: 13, y: 15 }, facing: 'down', fx: { x: 13, y: 16 }, duration: 4.5 },
    // Holt 警监的玻璃办公室——god 的地盘（植物 + 窗边雪茄）
    { kind: 'water', stand: { x: 28, y: 6 }, facing: 'up', fx: { x: 28, y: 5 }, duration: 4.5, godOnly: true },
    { kind: 'smoke', stand: { x: 34, y: 2 }, facing: 'up', fx: { x: 34, y: 0 }, duration: 18, godOnly: true },
    // 北墙的公共窗户——风痕飘入
    { kind: 'window', stand: { x: 14, y: 1 }, facing: 'up', fx: { x: 14, y: 0 }, duration: 5 },
    { kind: 'window', stand: { x: 22, y: 1 }, facing: 'up', fx: { x: 22, y: 0 }, duration: 5 },
    // 饮水机（大厅 + 入口走廊）
    { kind: 'dispenser', stand: { x: 8, y: 15 }, facing: 'down', fx: { x: 8, y: 16 }, duration: 3.5 },
    { kind: 'dispenser', stand: { x: 17, y: 20 }, facing: 'down', fx: { x: 17, y: 21 }, duration: 3.5 },
    // 休息室冰箱 + 架子（挨着咖啡经济）
    { kind: 'fridge', stand: { x: 29, y: 21 }, facing: 'up', fx: { x: 29, y: 20 }, duration: 3.2 },
    { kind: 'shelf', stand: { x: 34, y: 18 }, facing: 'up', fx: { x: 34, y: 17 }, duration: 4 },
    // 垃圾桶（入口 + 休息室）
    { kind: 'bin', stand: { x: 19, y: 20 }, facing: 'left', fx: { x: 18, y: 20 }, duration: 2.6 },
    { kind: 'bin', stand: { x: 34, y: 15 }, facing: 'up', fx: { x: 34, y: 14 }, duration: 2.6 },
  ],
  // 占位：brooklyn99.tmj 画的是办公室桌面印章（显示器 gid 365）。
  monitor: OFFICE_THEME.monitor,
  // 占位：在 Pam 的 B99 美术（§C/§D）落地前用 office 调色板 + 角色群。
  palette: OFFICE_THEME.palette,
  cast: OFFICE_THEME.cast,
};

/** 所有已注册主题。Phase 0 只发布 office；剧集主题随内容落地（Phase 2）
 *  在此注册。 */
export const THEMES: Partial<Record<ThemeId, ThemeConfig>> = {
  office: OFFICE_THEME,
  brooklyn99: BROOKLYN99_THEME,
};

/** 按 id 查主题，未知/缺失时回退到 office 主题（坏/缺失的剧集包绝不能弄坏
 *  楼层——见报告 §E）。 */
export function getTheme(id: ThemeId): ThemeConfig {
  return THEMES[id] ?? OFFICE_THEME;
}

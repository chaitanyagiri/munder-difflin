import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Application, Container, Graphics, Ticker, Texture } from 'pixi.js';
// PixiJS 内部使用 new Function()，被 Electron CSP 阻止——此补丁修复它。
import 'pixi.js/unsafe-eval';
import { useStore, type Agent } from '@/store/store';
import { TiledMapRenderer } from './TiledMapRenderer';
import { Camera } from './Camera';
import { Character, paintCup } from './Character';
import { DeskScreen } from './DeskScreen';
import { MessageEnvelope, type MessageAct } from './MessageEnvelope';
import { hexToNumber, DEFAULT_CHARACTER } from './cast';
import { pickSoloLine, pickExchange, type BreakSpot } from './cafeteriaLines';
import { colors } from '@/design/tokens';
import { loadTheme, resolveThemeMap, themeTilesetUrls } from './themeLoader';
import {
  installContextLossRecovery, planInitFailure, DEFAULT_MAX_INIT_RETRIES
} from './glRecovery';
import type { Tile, Facing, ErrandKind, ErrandSpot } from './themeRegistry';

// 地图、图块集图集、工位认领顺序、跑腿点、咖啡经济
// 图块、道具锚点、显示器 gid 和调色板均来自活跃
// ThemeConfig 现在（见 themeRegistry.ts / themeLoader.ts）。Phase 0 以
// 现有的办公室原样发货，`theme: 'office'`。

/** 一位代理正在进行的咖啡休息——由咖啡休息
 * 导演设置，代理离开或拉回工作时清除。 */
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

/** 一位代理正在进行的空闲跑腿。 */
interface ErrandRun {
  phase: 'walking' | 'doing';
  timer: number;
  idx: number; // into ERRAND_SPOTS
}

/** 咖啡经济的一个 leg：从边柜取一个干净杯子，在
 * 柜台机器处冲泡，（之后）在水槽清洗并将杯子放回架子。 */
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
   /** 此桌的显示器覆盖层——代理就座时点亮。 */
  screen?: DeskScreen;
   /** 从休息室步行回家喝咖啡。 */
  cupCarryHome?: boolean;
  err?: ErrandRun;
  run?: CoffeeRun;
   /** 当前忙碌时段（工作/思考/压缩）开始的时间。 */
  busySince?: number;
}

/** 只有持续时间至少这么长的忙碌时段值得在结束时欢呼。短暂
 * 任务（收件箱提示、心跳回复）安静结束——否则空闲
 * 代理会"庆祝"每几分钟无事可做，"完成！"气泡
 * 读起来像真实完成的工作但实际上没有。 */
const CHEER_MIN_BUSY_MS = 60_000;

/** 代理每次跑腿随机嘟囔的话。i18n 键指向
 * `office.errand.*`。 */
const ERRAND_THOUGHTS: Record<ErrandKind, readonly string[]> = {
  water:     ['office.errand.water.0', 'office.errand.water.1', 'office.errand.water.2'],
  window:    ['office.errand.window.0', 'office.errand.window.1', 'office.errand.window.2'],
  dispenser: ['office.errand.dispenser.0', 'office.errand.dispenser.1', 'office.errand.dispenser.2'],
  fridge:    ['office.errand.fridge.0', 'office.errand.fridge.1', 'office.errand.fridge.2'],
  shelf:     ['office.errand.shelf.0', 'office.errand.shelf.1', 'office.errand.shelf.2'],
  bin:       ['office.errand.bin.0', 'office.errand.bin.1', 'office.errand.bin.2'],
  smoke:     ['office.errand.smoke.0', 'office.errand.smoke.1', 'office.errand.smoke.2', 'office.errand.smoke.3']
};

/** 老板走过时 workers 脱口而出的话——表演性卓越。
 *  `{{done}}` 插值该 worker 的真实完成任务数。 */
const SUCK_UP_KEYS = [
  'office.suckUp.0',
  'office.suckUp.1',
  'office.suckUp.2',
  'office.suckUp.3',
  'office.suckUp.4',
  'office.suckUp.5',
  'office.suckUp.6'
] as const;

/** 他离开可听范围后他们实际说的话。 */
const GOSSIP_KEYS = [
  'office.gossip.0',
  'office.gossip.1',
  'office.gossip.2',
  'office.gossip.3',
  'office.gossip.4',
  'office.gossip.5',
  'office.gossip.6'
] as const;

/** 代理完成任务后立即抛出的话。 */
const CHEER_KEYS = [
  'office.cheer.0',
  'office.cheer.1',
  'office.cheer.2',
  'office.cheer.3',
  'office.cheer.4',
  'office.cheer.5',
  'office.cheer.6'
] as const;

/** 通过 <img> 元素加载纹理。与 Pixi 的 Assets.load() 不同，此
 * 处理无扩展名的数据：URL（Vite 将小资产如 a5
 * 图块集内联为 base64），Assets 解析器无法类型检测。 */
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

/** 代理当前正在做的事情，用于思想云。优先使用实时
 * `action`（如"编辑 App.tsx"、"bash npm test"），回退到我们给它的
 * 提示，然后到调用方提供的通用提示。对于尚未有具体内容的工作状态返回 ''--气泡会渲染一个动画的 "..."。 */
function liveActivity(agent: Agent, fallback = ''): string {
  const action = (agent.action || '').trim();
  if (action) return action;
  return firstWords(agent.lastPrompt) || fallback;
}

/** 用户最后提示的前几个字，用于桌面卡片。 */
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
  const { t, i18n } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<Application | null>(null);
  const mountIdRef = useRef(0);
  // 当 WebGL 上下文被驱逐时递增；下面效果的依赖，因此
  // 整个场景通过现有的安装路径拆除并重建，而不是
  // 通过第二个并行恢复例程。
  const [glGeneration, setGlGeneration] = useState(0);
  // 无法获取上下文的初始化重试次数（见 glRecovery.ts）。
  // 一个 ref，不是 state：预算必须存活它安排的重新构建，这些
  // 重新运行下面的效果并会重置任何作用域其中的内容。
  const initRetriesRef = useRef(0);
  // 活跃的办公室主题（config.officeTheme 的存储镜像）。更改它
  // 会在新的 map/cast 上拆除并重建整个场景（见下方依赖）。
  const officeTheme = useStore((s) => s.officeTheme);

  // 地板实际上在屏幕上吗？全屏终端或文件编辑器完全覆盖
  // 它，隐藏窗口显示无任何内容——但 Pixi ticker
  // 无论是否可见都持续运行整个场景：每个角色、思想云、
  // 咖啡行程和信封动画，渲染器每帧绘制到
  // 无人可见的像素。在二十个代理的地板上，这是应用的最大
  // 持续成本，而在全屏终端中生活的用户（与一个
  // 代理协作的正常方式）支付了 100% 的时间。
  //
  // 停止 ticker 而不是卸载：WebGL 上下文、纹理和整个
  // 场景图保持存活，因此从全屏退出是即时的
  // 而不是完整的主题重新加载。
  //
  // 暂停的地板从它离开的地方恢复。两件事使这成为可能，并且精确地
  // 指出很重要因为显而易见的主张——"这里没有读取墙钟
  // 时间"——是错误的：Date.now() 用于 aura/咖啡计时器和 busy/
  // cheer 阈值。第一个在 onTick 内部，所以停止的 ticker 冻结
  // 它与所有其他内容。第二个在 applyState 中运行，这是一个
  // 订阅在暂停时保持触发——但它只变异精灵状态
  // 在恢复时重绘，所以最坏的情况是 cosmetic cheer 反映
  // 真正经过的繁忙时间，在隐藏时不可见。
  //
  // 帧增量是安全构建的：Pixi 在 start() 上将 elapsedMS 钳制到 minFPS，
  // 所以暂停一小时的地板在恢复时前进几帧而不是
  // 让每个角色穿越地图传送。
  const fullscreenAgentId = useStore((s) => s.fullscreenAgentId);
  const ideOpen = useStore((s) => s.ideOpen);
  const [docHidden, setDocHidden] = useState(() => document.hidden);
  useEffect(() => {
    const onVis = () => setDocHidden(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  const paused = !!fullscreenAgentId || ideOpen || docHidden;
  // 在 init() 内部读取，它异步完成否则会启动一个
  // 下面的效果已被要求停止的 ticker。
  const pausedRef = useRef(paused);
  useEffect(() => {
    pausedRef.current = paused;
    const ticker = appRef.current?.ticker;
    if (!ticker) return; // app.init() hasn't created it yet — init() applies it
    if (paused) ticker.stop(); else ticker.start();
  }, [paused]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);

    const mountId = ++mountIdRef.current;
    const app = new Application();
    appRef.current = app;

    const runtimes = new Map<string, Runtime>();
    const seatClaims = new Set<number>();
    // 飞行中的消息信封（发送者桌面 → 接收者桌面）。限制数量以便
    // 广播不会将地板埋在纸张中。
    const envelopes: MessageEnvelope[] = [];
    const MAX_ENVELOPES = 16;

    const init = async () => {
      // 加载活跃主题包（在坏/缺失包时回退到 'office'）。
      const theme = await loadTheme(officeTheme);
      await app.init({
        background: hexNum(theme.palette.background),
        antialias: false,
        roundPixels: true,
        // resolution: 1 让操作系统/浏览器在缩放和
        // HiDPI 显示器上放大画布（125–150% 是 Windows 笔记本电脑默认），模糊
        // 一切——最糟糕的是气泡文本，它一开始就很小。
        // 改为在真实设备像素密度下渲染，下限为 2
        // 这样半比例超采样的气泡文本即使在
        // 100% 缩放下仍可辨认。autoDensity 保持画布 CSS 尺寸为逻辑 px。
        resolution: Math.max(window.devicePixelRatio || 1, 2),
        autoDensity: true,
        width: host.clientWidth || 800,
        height: host.clientHeight || 600,
      });
      if (mountIdRef.current !== mountId) { safeDestroy(app); return; }
      while (host.firstChild) host.removeChild(host.firstChild);
      host.appendChild(app.canvas);

      // 此画布持有进程中最新的 WebGL 上下文（它在
      // 启动时构建），因此它是 Chromium 驱逐的那个一旦足够多的 xterm 终端——
      // 每个都通过 @xterm/addon-webgl 获取上下文——打开后。Pixi
      // 在此发生时报告 nothing：地板永远变空白。
      // 重新构建。见 glRecovery.ts。
      (app as any).__glRecovery = installContextLossRecovery(app.canvas, {
        onRebuild: () => { if (mountIdRef.current === mountId) setGlGeneration((n) => n + 1); },
        onGiveUp: () => {
          if (mountIdRef.current !== mountId) return;
          host.appendChild(floorNote(t('office.gpuError')));
        }
      });

      // 按主题顺序加载图块集（texture[i] 与 map tilesets[i] 对齐）。
      const tilesetTextures = await Promise.all(
        themeTilesetUrls(theme).map(loadTexture),
      );
      if (mountIdRef.current !== mountId) { safeDestroy(app); return; }

      const world = new Container();
      app.stage.addChild(world);

      const mapRenderer = new TiledMapRenderer(resolveThemeMap(theme), tilesetTextures);
      world.addChild(mapRenderer.getContainer());
      const charLayer = mapRenderer.getCharacterContainer();
      const tileCount = mapRenderer.getContainer().children.reduce(
        (n, c) => n + ((c as Container).children?.length ?? 0), 0);
      console.log(`[OfficeFloor] map ${mapRenderer.width}x${mapRenderer.height}, ${tileCount} tile sprites rendered`);

      const camera = new Camera(world);
      camera.setMapSize(mapRenderer.width * mapRenderer.tileSize, mapRenderer.height * mapRenderer.tileSize);
      camera.setViewSize(app.screen.width, app.screen.height);
      camera.fitToScreen();

      // ─── 老板的墙历 → TRIGGERS ───────────────────────────────
      // 一个小撕页月历挂在 CEO 办公室墙上。点击它
      // 选择迈克尔（神）并打开指挥中心的 TRIGGERS 标签页——
      // 一切唤醒蜂巢而没有你的东西，调度排第一。
      const calTs = mapRenderer.tileSize;
      const calG = new Graphics();
      calG.eventMode = 'static';
      calG.cursor = 'pointer';
      calG.position.set(theme.anchors.calendar.x * calTs + 8, theme.anchors.calendar.y * calTs + 5);
      calG.zIndex = 3 * calTs;
      calG.on('pointertap', (ev) => {
        ev.stopPropagation();
        const st = useStore.getState();
        const god = st.agents.find((a) => a.isGod);
        if (god) st.select(god.id);
        st.requestCommandCenterTab('triggers');
      });
      // 钉子 + 环绑定在带有红色月份标题的白色页面上方
      calG.rect(7, -2, 2, 2).fill(0x4a3b52);                  // nail
      calG.rect(0, 0, 16, 20).fill(0x4a3b52);                 // frame/shadow
      calG.rect(1, 1, 14, 18).fill(0xf2ead8);                 // the page
      calG.rect(1, 1, 14, 4).fill(0xc94f4f);                  // month banner
      calG.rect(4, 0, 1, 2).fill(0xd8d3c4);                   // binding rings
      calG.rect(11, 0, 1, 2).fill(0xd8d3c4);
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 5; c++) {
          calG.rect(2 + c * 3, 7 + r * 4, 2, 2).fill(0xb8ab90); // day grid
        }
      }
      calG.rect(8, 11, 2, 2).fill(0xc94f4f);                  // today, circled red
      charLayer.addChild(calG);

      // 一次性构建有序座位列表：PC 桌面 + 命名桌面优先，然后
      // 会议室椅子作为溢出。每个代理认领一个并保持在那里；
      // 他们从不离开它（除非被阻塞，或在咖啡休息时）。
      const seatTiles: Tile[] = [];
      const seatSeen = new Set<string>();
      const addSeat = (t?: Tile) => {
        if (!t) return;
        const k = `${t.x},${t.y}`;
        if (seatSeen.has(k)) return;
        seatSeen.add(k);
        seatTiles.push({ x: t.x, y: t.y });
      };
      for (const name of theme.primarySeatNames) addSeat(mapRenderer.getSpawnPoint(name));
      const addZoneSeats = (zone: string) => {
        const z = mapRenderer.getZone(zone);
        if (!z) return;
        for (let y = z.y; y < z.y + z.height; y++) {
          for (let x = z.x; x < z.x + z.width; x++) {
            if (mapRenderer.isWalkable(x, y)) addSeat({ x, y });
          }
        }
      };
      addZoneSeats('boardroom');       // 会议室溢出
      // 右下角开放区域是咖啡间（休息室）——见下面的
      // 咖啡休息导演。故意不作为溢出
      // 工位座位添加，这样咖啡馆桌子保持用于休息。

      // 入口附近的等待点——被阻塞的代理走到那里发出信号
      // 它需要用户。作为门周围的环中的可步行图块收集。
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

      // 座位 0 是 desk-ceo——"迈克尔的房间"——为神代理预留。
      // 所有其他 workers 从 1 开始认领座位。
      const GOD_SEAT = 0;
      const claimSeat = (agent: Agent): number | null => {
        if (agent.isGod) { seatClaims.add(GOD_SEAT); return GOD_SEAT; }
        for (let i = 1; i < seatTiles.length; i++) {
          if (!seatClaims.has(i)) { seatClaims.add(i); return i; }
        }
        return null;
      };

      // 让就座代理面向他们的桌面（相邻不可步行
      // 家具）。标准桌子把显示器放在北边，椅子放在
      // 南边，所以代理面向"上"我们看到他们的背部——像真实的
      // 工人。只有直接在南方（面向"下"）的桌子才会把家具放在
      // 他们前面，这是腿部裁剪将腿 tucked 下的唯一情况。
      const facingForSeat = (t: Tile): 'up' | 'down' | 'left' | 'right' => {
        if (!mapRenderer.isWalkable(t.x, t.y - 1)) return 'up';
        if (!mapRenderer.isWalkable(t.x, t.y + 1)) return 'down';
        if (!mapRenderer.isWalkable(t.x - 1, t.y)) return 'left';
        if (!mapRenderer.isWalkable(t.x + 1, t.y)) return 'right';
        return 'up'; // 开放地板溢出座位——没有桌子，只是面向远离
      };

      // ─── 咖啡间：有目的的咖啡休息 ───────────────────────────────
      // 空闲/完成的代理偶尔漫步到休息区，坐在
      // 咖啡馆桌子（或站在咖啡机/自动售货机旁），发出一个
      // 角色内的一行台词，然后返回。同一桌子的两个代理
      // 交换一个双拍俏皮话。这就是让"停留"感觉有目的的原因。
      interface CafeSpot { tile: Tile; facing: Facing; spot: BreakSpot; seated: boolean; partner: number; }
      const cafeSpots: CafeSpot[] = [];

      // 站立点面向第一个相邻不可步行图块（电器）。
      const faceFurniture = (t: Tile): Facing => {
        if (!mapRenderer.isWalkable(t.x + 1, t.y)) return 'right';
        if (!mapRenderer.isWalkable(t.x - 1, t.y)) return 'left';
        if (!mapRenderer.isWalkable(t.x, t.y - 1)) return 'up';
        return 'down';
      };

      // 先座位（所以搭档索引稳定），然后站立点。
      for (const name of theme.cafeSeatNames) {
        const p = mapRenderer.getSpawnPoint(name);
        if (p) cafeSpots.push({ tile: p, facing: facingForSeat(p), spot: 'table', seated: true, partner: -1 });
      }
      // 配对共享同一张桌子的两个座位（同一列，相隔两个图块）。
      for (let i = 0; i < cafeSpots.length; i++) {
        for (let j = i + 1; j < cafeSpots.length; j++) {
          const a = cafeSpots[i].tile, b = cafeSpots[j].tile;
          if (a.x === b.x && Math.abs(a.y - b.y) === 2) { cafeSpots[i].partner = j; cafeSpots[j].partner = i; }
        }
      }
      for (const [name, spot] of theme.cafeStands) {
        const p = mapRenderer.getSpawnPoint(name);
        if (p) cafeSpots.push({ tile: p, facing: faceFurniture(p), spot, seated: false, partner: -1 });
      }
      const cafeTaken: (string | null)[] = new Array(cafeSpots.length).fill(null);

      const agentById = (id: string): Agent | undefined =>
        useStore.getState().agents.find((a) => a.id === id);

      // ─── 咖啡经济：边柜 → 机器 → 桌面 → 水槽 → 边柜 ─
      // 有限数量的杯子存放在厨房柜台旁的边柜上。
      // 冲泡需要手中有一个杯子（架子上的干净杯子，或你自己的
      // 从桌面带回用于懒加载的杯子）；在柜台
      // 水槽清洗后将杯子放回干净库存。如果每个杯子都停在
      // 某个地方的桌面上，架子会变空——地板会感受到这一点。
      const TRAY_TILE: Tile = theme.coffee.trayTile;        // 边柜（柜台组件）
      const TRAY_STAND: Tile = theme.coffee.trayStand;
      const MACHINE_STAND: Tile = theme.coffee.machineStand; // 柜台机器下方
      const SINK_TILE: Tile = theme.coffee.sinkTile;        // 空闲柜台顶，右端
      const SINK_STAND: Tile = theme.coffee.sinkStand;
      const MAX_CUPS = theme.coffee.maxCups;
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
      let sinkBusy = 0; // 清洗动画剩余的秒数
      const drawSink = (t: number): void => {
        sinkG.clear();
        // 白色柜台顶嵌入的钢盆 + 一个小水龙头
        sinkG.rect(2, 6, 12, 8).fill(0xb9c2c9);
        sinkG.rect(3, 7, 10, 6).fill(0x87939d);
        sinkG.rect(7, 9, 2, 2).fill(0x5d676f);          // drain
        sinkG.rect(7, 2, 2, 4).fill(0x6b7680);          // faucet riser
        sinkG.rect(6, 2, 4, 1).fill(0x6b7680);
        if (sinkBusy > 0) {
          // 流动的水 + 几个人在擦洗时的几个泡沫
          sinkG.rect(7, 6, 2, 4).fill({ color: 0x9fd6f0, alpha: 0.9 });
          for (let i = 0; i < 3; i++) {
            const ph = (t * 1.2 + i / 3) % 1;
            sinkG.circle(4 + i * 4, 7 - ph * 4, 1).fill({ color: 0xffffff, alpha: 0.7 * (1 - ph) });
          }
        }
      };
      drawSink(0);

      const machineG = new Graphics(); // 冲泡期间柜台机器上方的蒸汽
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

      // 一个咖啡行程 leg：走到某处然后执行动作。驱动 rt.run 通过其
      // 阶段；每秒引擎推进定时（执行）阶段。
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
          c.faceDirection('up'); // 每个站都面向其北边柜台
          if (phase === 'toTray') {
            if (cleanCups <= 0) {
              // 架子用完了——每个杯子都停在某人的桌面上。
              c.showThought(t('office.mugs.empty'));
              rt.run = { phase: 'placing', timer: -1 }; // brief sulk, then move on
              return;
            }
            cleanCups--;
            drawTray();
            c.setCarryingCup(true);
            rt.run = { phase: 'taking', timer: 0 };
          } else if (phase === 'toMachine') {
            c.showThought(t('office.mugs.brewing'));
            machineBusy = 2.6;
            rt.run = { phase: 'brewing', timer: 0 };
          } else if (phase === 'toSink') {
            c.showThought(t('office.mugs.washing'));
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

      /** 取消咖啡行程（真实工作/拆除）。手持的杯子随
       * cupCarryHome 到达桌面；地板设施只是停止动画。 */
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

      /** 距离神的化身 px 数，或他缺席时为 Infinity。 */
      const godDistance = (px: number, py: number): number => {
        const god = useStore.getState().agents.find((a) => a.isGod);
        const grt = god ? runtimes.get(god.id) : undefined;
        if (!grt) return Infinity;
        const p = grt.character.getPixelPosition();
        return Math.hypot(p.x - px, p.y - py);
      };

      const emitQuip = (id: string, rt: Runtime, spotIdx: number): void => {
        const spot = cafeSpots[spotIdx];
        const character = agentById(id)?.character ?? DEFAULT_CHARACTER;
        const seed = Math.floor(Math.random() * 1e6);
        // 在老板的耳边外，咖啡馆谈话转向……老板。在他
        // 在场时是通常无害的俏皮话（讨好行为通过
        // 下面的接近性导演完成）。
        const p = rt.character.getPixelPosition();
        if (godDistance(p.x, p.y) > 96 && Math.random() < 0.35) {
          rt.character.showThought(t(GOSSIP_KEYS[Math.floor(Math.random() * GOSSIP_KEYS.length)]));
          return;
        }
        rt.character.showThought(pickSoloLine(character, spot.spot, seed));
      };

      // 如果新来者的桌子搭档已经在停留（且双方都不是在
      // 对话中），开始多拍交换。新来者是
      // 发起者并拥有脚本；搭档只被标记为参与。
      // 如果启动了对话则返回 true。
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

      // 释放咖啡馆座位并整理任何对话链接以便两个代理都不会
      // 留在对话中间。在休息结束 OR 被真实工作打断时调用。
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

      // 优雅结束休息：释放座位，丢弃气泡——并解决
      // 咖啡问题。携带其用过的桌面杯子的代理要么
      // 仅在机器处 REFILL（懒路径）或正确地在
      // 水槽 WASH 并将其放回边柜。没有杯子的代理
      // 首先从架子上取一个干净的——没有杯子，没有咖啡：如果架子
      // 用完了行程以沮丧结束而不是冲泡。
      const endBreak = (id: string, rt: Runtime): void => {
        const arrived = rt.brk?.phase === 'lingering';
        releaseBreak(rt);
        rt.character.hideThought();
        const agent = agentById(id);
        if (agent?.isGod) { rt.character.sitAtDesk(true); return; }
        const c = rt.character;
        if (!arrived) {
           // 从未到达咖啡店（看门狗）——拿着的杯子还是要回家。
          if (c.isCarryingCup()) { rt.cupCarryHome = true; c.sitAtDesk(false); }
          else c.startWandering();
          return;
        }
        if (c.isCarryingCup()) {
           // 把用过的办公桌杯子带回来了：60% 懒补给，40% 正确清洗。
          if (Math.random() < 0.6) startRunLeg(rt, 'toMachine');
          else startRunLeg(rt, 'toSink');
        } else if (!c.hasCupOnDesk() && Math.random() < 0.75) {
          startRunLeg(rt, 'toTray'); // fetch a clean mug, then brew
        } else {
          c.startWandering();
        }
      };

      const startBreak = (id: string, rt: Runtime): void => {
        // 优先（≈一半时间）一个桌子搭档已经在那里的座位，所以
        // 形成配对并聊天；否则任何空闲点。
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
        // 仍然停在桌面上的杯子会带到休息——它保持
        // 在手通过停留（在桌子旁啜饮）并在休息结束时
        // 重新填充或清洗（见 endBreak）。
        if (c.hasCupOnDesk()) {
          c.setCupOnDesk(false);
          c.setCarryingCup(true);
        }
        c.walkToAndThen(spot.tile, () => {
          // 如果在行走时休息被取消或重新分配则返回
          if (!rt.brk || rt.brk.spotIdx !== idx) return;
          if (spot.seated) c.sitInPlace(spot.facing);
          else { c.setIdle(); c.faceDirection(spot.facing); }
          rt.brk.phase = 'lingering';
          rt.brk.timer = 8 + Math.random() * 8;   // 8–16s of lingering
          rt.brk.quipTimer = 4 + Math.random() * 4;
           // 如果桌伴在这里就开始对话；否则自言自语。
          if (!maybePairChat(id, rt, idx)) emitQuip(id, rt, idx);
        });
      };

      const breakEligible = (agent: Agent, rt: Runtime): boolean => {
        if (agent.isGod || rt.brk || rt.err || rt.run || rt.cupCarryHome) return false;
        if (agent.status !== 'idle' && agent.status !== 'success') return false;
        return !rt.character.isSitting();   // already parked at a desk → leave it
      };

      let cafeCooldown = 5;
      const updateCafeteria = (dt: number): void => {
         // 推进每个进行中的休息。
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
            // 一次一个节拍播放对话，交替说话者。
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
                // 对话结束——释放搭档并恢复单人俏皮话。
                const prt = runtimes.get(b.chat.partnerId);
                if (prt?.brk) prt.brk.chattingWith = undefined;
                b.chat = undefined;
              }
            }
          } else if (!b.chattingWith) {
            // 不在对话中（且不被说话）——切换单人俏皮话。
            b.quipTimer -= dt;
            if (b.quipTimer <= 0) {
              b.quipTimer = 4 + Math.random() * 4;
              emitQuip(id, rt, b.spotIdx);
            }
            // 偶尔与也到达的桌子搭档开始对话。
            else if (Math.random() < 0.004) maybePairChat(id, rt, b.spotIdx);
          }
          b.timer -= dt;
          if (b.timer <= 0) endBreak(id, rt);
        }

        // 定期发送一个空闲代理去休息——但将房间限制为 4 个。
        cafeCooldown -= dt;
        if (cafeCooldown > 0) return;
        cafeCooldown = 6 + Math.random() * 6;
        if (cafeTaken.filter(Boolean).length >= 4) return;
        if (Math.random() >= 0.7) return;          // 不是每个窗口——保持随意
        const candidates: Array<[Agent, Runtime]> = [];
        for (const agent of useStore.getState().agents) {
          const rt = runtimes.get(agent.id);
          if (rt && breakEligible(agent, rt)) candidates.push([agent, rt]);
        }
        if (candidates.length === 0) return;
        const [agent, rt] = candidates[Math.floor(Math.random() * candidates.length)];
        startBreak(agent.id, rt);
      };

      // ─── 空闲跑腿：安静地板的小有目的繁忙工作 ─────────
      // 给植物浇水，打开窗户通风，倒出分配器，
      // 检查冰箱，浏览架子，将废纸扔进垃圾桶。每个点
      // 有一个站立图块 + 方向；`fx` 锚定一点环境动画。
      const ERRAND_SPOTS: ErrandSpot[] = theme.errandSpots;
      const errandTaken: (string | null)[] = new Array(ERRAND_SPOTS.length).fill(null);
      // 每个活跃跑腿点懒创建的环境 fx 层。
      const errandFx = new Map<number, Graphics>();

      const fxFor = (idx: number): Graphics => {
        let g = errandFx.get(idx);
        if (!g) {
          const spot = ERRAND_SPOTS[idx];
          g = new Graphics();
          g.eventMode = 'none';
          g.position.set(spot.fx.x * ts0, spot.fx.y * ts0);
          g.zIndex = (spot.fx.y + 1) * ts0;
          charLayer.addChild(g);
          errandFx.set(idx, g);
        }
        return g;
      };

      /** 绘制一个跑腿的环境动画帧（在其 fx 图块上的本地坐标）。 */
      const drawErrandFx = (kind: ErrandKind, g: Graphics, t: number): void => {
        g.clear();
        if (kind === 'window' || kind === 'smoke') {
          // 风条纹从窗框下溜进并漂向房间——
          // 对于 'smoke' 老板打开了他的窗户抽雪茄。
          for (let i = 0; i < 3; i++) {
            const ph = (t * 0.7 + i / 3) % 1;
            g.rect(2 + i * 9 - ph * 5, 26 + ph * 16, 7, 1)
              .fill({ color: 0xd8f1f7, alpha: 0.55 * (1 - ph) });
          }
        } else if (kind === 'dispenser') {
          // 咕噜瓶子：滴线 + 气泡在罐中上升
          const ph = (t * 1.6) % 1;
          g.rect(7, 18 + ph * 6, 1, 3).fill({ color: 0x9fd6f0, alpha: 0.9 * (1 - ph) });
          const bp = (t * 0.9) % 1;
          g.circle(8, 12 - bp * 6, 1).fill({ color: 0xffffff, alpha: 0.6 * (1 - bp) });
        } else if (kind === 'fridge') {
          // 开门光束洒在地板上，轻轻闪烁
          const a = 0.16 + 0.05 * Math.sin(t * 5);
          g.poly([3, 12, 13, 12, 16, 30, 0, 30]).fill({ color: 0xfff2b8, alpha: a });
        } else if (kind === 'shelf') {
          // 一个小闪烁在架子间游走
          const ph = (t * 0.5) % 1;
          g.rect(2 + ph * 24, 4 + (Math.floor(t * 0.5) % 3) * 9, 2, 2)
            .fill({ color: 0xfff7c8, alpha: 0.8 * Math.sin(ph * Math.PI) });
        } else if (kind === 'bin') {
          // 一个纸球从代理一侧抛入，每秒一次
          const ph = (t * 1.0) % 1;
          if (ph < 0.45) {
            const p = ph / 0.45;
            const fromX = 18, toX = 8;
            const x = fromX + (toX - fromX) * p;
            const y = 2 - Math.sin(p * Math.PI) * 9;
            g.rect(Math.round(x), Math.round(y), 2, 2).fill({ color: 0xf5f1e6, alpha: 0.95 });
          }
        }
         // 'water' 在这里不绘制任何东西——水滴随角色本身
      };

      const releaseErrand = (rt: Runtime): void => {
        if (!rt.err) return;
        errandTaken[rt.err.idx] = null;
        errandFx.get(rt.err.idx)?.clear();
        rt.err = undefined;
        rt.character.stopWatering();
        rt.character.stopSmoking();
      };

      let errCooldown = 18;
      const updateErrands = (dt: number): void => {
        for (const [, rt] of runtimes) {
          const err = rt.err;
          if (!err) continue;
          err.timer += dt;
          const spot = ERRAND_SPOTS[err.idx];
          if (err.phase === 'walking') {
            if (err.timer > 20) { releaseErrand(rt); rt.character.startWandering(); }
            continue;
          }
           // 执行：动画这个点；浇水 + 吸烟通过各自的
           // Character 回调完成，其余由这个计时器处理
          drawErrandFx(spot.kind, fxFor(err.idx), err.timer);
          if (spot.kind !== 'water' && spot.kind !== 'smoke' && err.timer >= spot.duration) {
            releaseErrand(rt);
            rt.character.hideThought();
            rt.character.startWandering();
          }
        }
        errCooldown -= dt;
        if (errCooldown > 0) return;
        errCooldown = 14 + Math.random() * 18;
        if (Math.random() >= 0.65) return;          // keep it occasional
        const free = ERRAND_SPOTS.map((_, i) => i).filter((i) => !errandTaken[i]);
        if (free.length === 0) return;
        const idx = free[Math.floor(Math.random() * free.length)];
        const spot = ERRAND_SPOTS[idx];
         // 选择表演者。CEO 办公室的位点仅属于 Michael——
         // 与 workers 不同，他从自己的办公桌执行跑腿（他坐着
         // 空闲时，所以坐着检查不适用于他）。
        let agent: Agent | undefined;
        let rt: Runtime | undefined;
        if (spot.godOnly) {
          const god = useStore.getState().agents.find((a) => a.isGod);
          const grt = god ? runtimes.get(god.id) : undefined;
          if (!god || !grt || grt.err || grt.brk
            || (god.status !== 'idle' && god.status !== 'success')
            || Math.random() >= 0.5) return;        // 老板不慌不忙
          agent = god; rt = grt;
        } else {
          const candidates: Array<[Agent, Runtime]> = [];
          for (const a of useStore.getState().agents) {
            const r = runtimes.get(a.id);
            if (r && breakEligible(a, r)) candidates.push([a, r]);
          }
          if (candidates.length === 0) return;
          [agent, rt] = candidates[Math.floor(Math.random() * candidates.length)];
        }
        const c = rt.character;
        errandTaken[idx] = agent.id;
        rt.err = { phase: 'walking', timer: 0, idx };
        c.walkToAndThen(spot.stand, () => {
          if (!rt!.err || rt!.err.idx !== idx) return;
          rt!.err.phase = 'doing';
          rt!.err.timer = 0;
          c.faceDirection(spot.facing);
          const lines = ERRAND_THOUGHTS[spot.kind];
          c.showThought(t(lines[Math.floor(Math.random() * lines.length)]));
          const finish = (): void => {
            const wasGod = !!agent!.isGod;
            releaseErrand(rt!);
            c.hideThought();
            if (wasGod) c.sitAtDesk(true);  // the boss returns to his throne
            else c.startWandering();
          };
          if (spot.kind === 'water') c.startWatering(spot.duration, finish);
          else if (spot.kind === 'smoke') c.startSmoking(spot.duration, finish);
        });
      };

      // ─── 老板 aura：迈克尔在场时的表演性卓越 ──────
      // 当神的化身漫游接近 worker 时，worker 爆发
      // 进入讨好模式——包括真实统计（"已经交付 N 个任务，
      // 迈克尔。加薪？" 带有来自实际账簿的 N）。一旦他
      // 离开可听范围他们会说什么则是另一回事（见 emitQuip 的 gossip）。
      const lastSuckUp = new Map<string, number>();
      let doneByAssignee = new Map<string, number>();
      let statsAge = 999;
      let auraCooldown = 1.5;
      const updateBossAura = (dt: number): void => {
        // 以轻松的节奏从账簿刷新完成计数
        statsAge += dt;
        if (statsAge > 30) {
          statsAge = 0;
          void window.cth.hiveTasks().then((raw) => {
            const arr = (raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks))
              ? (raw as { tasks: Array<{ status?: string; assignee?: string }> }).tasks
              : [];
            const m = new Map<string, number>();
            for (const t of arr) {
              if (t?.status === 'done' && typeof t.assignee === 'string' && t.assignee) {
                m.set(t.assignee, (m.get(t.assignee) ?? 0) + 1);
              }
            }
            doneByAssignee = m;
          }).catch(() => { /* 保持最后计数 */ });        }
        auraCooldown -= dt;
        if (auraCooldown > 0) return;
        auraCooldown = 1.5;
        const god = useStore.getState().agents.find((a) => a.isGod);
        const grt = god ? runtimes.get(god.id) : undefined;
        if (!grt) return;
        const gp = grt.character.getPixelPosition();
        const now = Date.now();
        for (const [id, rt] of runtimes) {
          if (id === god!.id) continue;
          const a = agentById(id);
          if (!a) continue;
          // 只有 relaxed workers 表演——不是正在思考真实工作中的某人
          if (a.status !== 'idle' && a.status !== 'success') continue;
          if (rt.brk?.chat || rt.brk?.chattingWith) continue;
          const p = rt.character.getPixelPosition();
          if (Math.hypot(p.x - gp.x, p.y - gp.y) > 44) continue;
          if (now - (lastSuckUp.get(id) ?? 0) < 25_000) continue;
          if (Math.random() >= 0.6) continue;
          lastSuckUp.set(id, now);
          const done = doneByAssignee.get(id) ?? 0;
          const pool = done > 0 ? SUCK_UP_KEYS : SUCK_UP_KEYS.slice(2);
          const line = pool[Math.floor(Math.random() * pool.length)];
          rt.character.showThought(t(line, { done: String(done) }));
          rt.character.hideThought(); // linger briefly, then fade
        }
      };

       // ─── 咖啡配送 + 桌面屏幕，每帧 ───────────────────────
      const updateDeskLife = (dt: number): void => {
        for (const [id, rt] of runtimes) {
           // 当送杯者在家就座时立即放下咖啡——
           // 然后，如果仍无事可做，起身走开（杯子
           // 留在显示器旁，冒着热气）。
          if (rt.cupCarryHome && rt.character.isSittingAtDesk()) {
            rt.cupCarryHome = false;
            rt.character.setCarryingCup(false);
            rt.character.setCupOnDesk(true);
            const agent = agentById(id);
            if (agent && !agent.isGod && (agent.status === 'idle' || agent.status === 'success')) {
              rt.character.startWandering();
            }
          }
          // 只要其所有者坐在椅子上显示器就点亮。
          if (rt.screen) {
            rt.screen.setOn(rt.character.isSittingAtDesk());
            rt.screen.update(dt);
          }
        }
      };
      // ─── 办公室任务板：hive/tasks.json 钉在墙上 ────────
      // 两块软木板并排挂在开放式计划
      // 桌面上方的墙带上：BLOCKERS（红色）在左侧，TODO（黄色）在右侧——各
      // 带有一条彩色标题条。认领任务的 worker（doing +
      // assignee）字面上 TAKE THE NOTE ALONG：它离开板子
      // 粘到该 worker 的桌面上。完成的任务以绿色
      // 堆叠归档在尽头的小桌子上。点击任何内容选择
      // 迈克尔并打开指挥中心的任务标签页。
      const BOARD_TILE: Tile = theme.anchors.boards;
      // 整个组合（两块板 + 归档桌子）82px 宽；两个门之间的墙
      // 跨越图块 6..12（112px）——居中。
      const BOARD_CENTER_PAD = 15;
      const NOTE_COLORS: Record<string, number> = theme.palette.noteColors;
      interface BoardTask { status: string; assignee?: string }
      const tsB = mapRenderer.tileSize;
      const boardG = new Graphics();
      boardG.eventMode = 'static';
      boardG.cursor = 'pointer';
      boardG.position.set(BOARD_TILE.x * tsB + BOARD_CENTER_PAD, BOARD_TILE.y * tsB);
      boardG.zIndex = (BOARD_TILE.y + 1) * tsB;
      boardG.on('pointertap', (ev) => {
        ev.stopPropagation();
        const st = useStore.getState();
        const god = st.agents.find((a) => a.isGod);
        if (god) st.select(god.id);
        st.requestCommandCenterTab('tasks');
      });
      charLayer.addChild(boardG);
      // 每个当前持有取走便条的桌面一个小的 Graphics。
      const deskNoteG = new Map<string, Graphics>();
      const clearDeskNotes = (): void => {
        for (const g of deskNoteG.values()) { g.parent?.removeChild(g); g.destroy(); }
        deskNoteG.clear();
      };

      /** 一个带有本地 x `ox` 处彩色标题的软木板；绘制最多 12
       * 个 `notes`，溢出作为角落堆。 */
      const drawCork = (ox: number, header: number, notes: string[]): void => {
        boardG.rect(ox, -8, 30, 22).fill(0x6e5639);        // frame
        boardG.rect(ox + 1, -7, 28, 3).fill(header);       // header strip
        boardG.rect(ox + 1, -4, 28, 17).fill(0xc9b083);    // cork
        const n = Math.min(notes.length, 12);
        for (let i = 0; i < n; i++) {
          const x = ox + 3 + (i % 4) * 7;
          const y = -2 + Math.floor(i / 4) * 5;
          boardG.rect(x, y, 5, 4).fill(NOTE_COLORS[notes[i]] ?? 0xf2eddc);
          boardG.rect(x + 2, y, 1, 1).fill(0x4a3b52);      // pin
        }
        if (notes.length > 12) {
          boardG.rect(ox + 22, 8, 5, 4).fill(0xe8e0c8);
          boardG.rect(ox + 23, 7, 5, 4).fill(0xf2eddc);
        }
      };

      const drawTaskBoard = (tasks: BoardTask[]): void => {
        boardG.clear();
        clearDeskNotes();
        const blocked = tasks.filter((t) => t.status === 'blocked').map(() => 'blocked');
        const todoNotes: string[] = tasks.filter((t) => t.status === 'todo').map(() => 'todo');
        let done = 0;
        // doing → 从墙上取下：钉到 assignee 的桌面上。没有
        // 可解析的桌面（无 assignee / 不在地板上）时回退到
        // TODO 板上作为蓝色便条，这样 nothing 永远不会无声消失。
        for (const t of tasks) {
          if (t.status === 'done') { done++; continue; }
          if (t.status !== 'doing') continue;
          const rt = t.assignee ? runtimes.get(t.assignee) : undefined;
          if (!rt) { todoNotes.push('doing'); continue; }
          const desk = rt.character.getDeskTile();
          let g = deskNoteG.get(t.assignee!);
          if (!g) {
            g = new Graphics();
            g.eventMode = 'none';
            g.position.set((desk.x - 1) * tsB + 3, (desk.y - 1) * tsB + 8);
            g.zIndex = desk.y * tsB - 1;
            charLayer.addChild(g);
            deskNoteG.set(t.assignee!, g);
          }
          // 在同一桌面上并排堆放多个取走的便条
          const idx = (g as any).__count ?? 0;
          (g as any).__count = idx + 1;
          g.rect(idx * 7, -(idx % 2), 5, 4).fill(NOTE_COLORS.doing);
          g.rect(idx * 7 + 2, -(idx % 2), 1, 1).fill(0x4a3b52);
        }
        drawCork(0, NOTE_COLORS.blocked, blocked);   // 左边：正在燃烧的
        drawCork(34, NOTE_COLORS.todo, todoNotes);   // 右边：排队的
        // 归档桌子：每个完成的任务向堆添加一张绿色纸
        // （可见堆限制为 6——超过它就只是突出）。
        boardG.rect(68, 6, 14, 4).fill(0xb08d5e);    // table top
        boardG.rect(68, 10, 14, 4).fill(0x8a6f4d);   // table front
        boardG.rect(69, 14, 2, 2).fill(0x6e5639);    // legs
        boardG.rect(79, 14, 2, 2).fill(0x6e5639);
        const stack = Math.min(done, 6);
        for (let i = 0; i < stack; i++) {
          boardG.rect(71 + (i % 2), 4 - i * 2, 8, 2)
            .fill({ color: NOTE_COLORS.done, alpha: 1 })
            .stroke({ color: 0x6e8f6e, width: 0.5 });
        }
      };
      drawTaskBoard([]);

      // ─── 办公室时钟：点击它是下班时间 ─────────────────────
      // 迈克尔窗户旁边的墙钟兼作退出入口：
      // 一次点击运行真实的关闭流程（window.close() → 主进程
      // 拦截而代理运行时 → "正在退出？"对话框及其
      // 关闭时间选项）。办公室时钟字面上打开关闭时间。
      const clockG = new Graphics();
      clockG.eventMode = 'static';
      clockG.cursor = 'pointer';
      clockG.position.set(theme.anchors.clock.x * ts0, theme.anchors.clock.y * ts0);
      clockG.hitArea = { contains: (x: number, y: number) => x >= 0 && x <= 16 && y >= 0 && y <= 32 };
      clockG.zIndex = 3 * ts0;
      clockG.on('pointertap', (ev) => {
        ev.stopPropagation();
        window.close(); // intercepted by the main process while PTYs are alive
      });
      charLayer.addChild(clockG);

      // ─── ASK ME 板：等待 HUMAN 的任务，一等公民 ─────────
      // 挂在右侧墙带（第二个门和战争室之间）：一个
      // 神为 human 停放的一个薰衣草便条每个开放问题。
      // 它在有等待时脉冲——点击它打开指挥中心的
      // ASK ME 标签页，human 在其中读取问题，回答，和
      // 答案流回神（在卡片本身记录）。
      const askG = new Graphics();
      askG.eventMode = 'static';
      askG.cursor = 'pointer';
      askG.position.set(14 * tsB + 25, 10 * tsB);
      askG.zIndex = 11 * tsB;
      askG.on('pointertap', (ev) => {
        ev.stopPropagation();
        const st = useStore.getState();
        const god = st.agents.find((a) => a.isGod);
        if (god) st.select(god.id);
        st.requestCommandCenterTab('human');
      });
      charLayer.addChild(askG);
      let askCount = 0;
      let askPulse = 0;
      const drawAskBoard = (pulse: number): void => {
        askG.clear();
        // 薰衣草框架板带有大的 "?" 标识
        askG.rect(0, -8, 30, 22).fill(0x5b4a6b);
        askG.rect(1, -7, 28, 3).fill(0xcdb4e8);
        askG.rect(1, -4, 28, 17).fill(0xc9b083);
        if (askCount === 0) {
          // 安静：一个微弱的 "?" 水印
          askG.rect(13, -1, 4, 2).fill({ color: 0x8a755f, alpha: 0.8 });
          askG.rect(15, 1, 2, 4).fill({ color: 0x8a755f, alpha: 0.8 });
          askG.rect(15, 7, 2, 2).fill({ color: 0x8a755f, alpha: 0.8 });
        } else {
          const n = Math.min(askCount, 8);
          for (let i = 0; i < n; i++) {
            const x = 3 + (i % 4) * 7;
            const y = -2 + Math.floor(i / 4) * 6;
            askG.rect(x, y, 5, 4).fill(0xcdb4e8);
            askG.rect(x + 2, y, 1, 1).fill(0x4a3b52);
          }
          // 在问题等待时框架周围的注意力脉冲
          const a = 0.35 + 0.3 * Math.sin(pulse * 4);
          askG.rect(-2, -10, 34, 26).stroke({ color: 0xcdb4e8, width: 2, alpha: a });
        }
      };
      drawAskBoard(0);

      // ─── 板编排：每次账簿移动都在地板上表演 ───────
      // 迈克尔走上来钉新鲜的卡片；分配的 worker 走到
      // TODO 板，取下它的便条并带回家；完成携带
      // 便条到归档桌子；一个被阻塞的卡片被走到
      // 红色板。在移动进行时，板继续显示 OLD
      // 该卡片的状态——重绘恰好落在演员行动时。
      // 无法编排的差异（地板上没有演员，批量编辑，重启）
      // 只需重绘——动画是糖，账簿保持真理。
      interface LedgerTask extends BoardTask { id: string }
      interface BoardMove {
        kind: 'pin' | 'take' | 'archive';
        taskId: string;
        actorId: string;
        /** 此卡片在移动落地后在 visualTasks 中应该是什么样。 */
        after: BoardTask;
        carryColor: number;
        stand: Tile;
        thought: string;
      }
      const PIN_STAND: Tile = { x: 8, y: 11 };      // 在 blockers 板下方
      const TAKE_STAND: Tile = { x: 9, y: 11 };     // 在 todo 板下方
      const ARCHIVE_STAND: Tile = { x: 12, y: 11 }; // 在归档桌子旁边
      /** 板当前显示的（在移动播放时落后于账簿）。 */
      let visualTasks = new Map<string, BoardTask>();
      const moveQueue: BoardMove[] = [];
      const busyActors = new Set<string>();
      // 演员手中携带的便条，地板侧所以它不需要 Character
      // 支持：每个活跃移动一个小的 Graphics，每秒重新定位。
      const carriedNotes = new Map<string, Graphics>();

      const redrawVisual = (): void => drawTaskBoard([...visualTasks.values()]);

      const finishMove = (mv: BoardMove, rt: Runtime | undefined): void => {
        visualTasks.set(mv.taskId, mv.after);
        redrawVisual();
        busyActors.delete(mv.actorId);
        const g = carriedNotes.get(mv.actorId);
        if (g) { g.parent?.removeChild(g); g.destroy(); carriedNotes.delete(mv.actorId); }
        if (rt) {
          rt.character.hideThought();
          const agent = agentById(mv.actorId);
          if (agent) applyState(agent, rt, true); // land in the right pose
        }
      };

      const attachCarriedNote = (actorId: string, color: number): void => {
        if (carriedNotes.has(actorId)) return;
        const g = new Graphics();
        g.eventMode = 'none';
        g.rect(0, 0, 5, 4).fill(color);
        g.rect(2, 0, 1, 1).fill(0x4a3b52);
        charLayer.addChild(g);
        carriedNotes.set(actorId, g);
      };

      const startMove = (mv: BoardMove): void => {
        const rt = runtimes.get(mv.actorId);
        if (!rt) { finishMove(mv, undefined); return; }
        busyActors.add(mv.actorId);
        const c = rt.character;
        if (mv.kind === 'archive') {
          // 在行走前从桌面捡起便条——手中，离开桌面
          attachCarriedNote(mv.actorId, mv.carryColor);
          visualTasks.set(mv.taskId, { status: '__carried__' });
          redrawVisual();
        }
        c.showThought(mv.thought);
        c.walkToAndThen(mv.stand, () => {
          c.faceDirection('up');
          if (mv.kind === 'take') attachCarriedNote(mv.actorId, mv.carryColor);
          // 短暂的表演节拍，然后板在它们的手下方更新
          setTimeout(() => {
            if (mv.kind === 'take') {
              // 带回家：桌面便条在到达时通过 finishMove 出现
              const rt2 = runtimes.get(mv.actorId);
              if (!rt2) { finishMove(mv, undefined); return; }
              visualTasks.set(mv.taskId, { ...mv.after, status: '__carried__' });
              redrawVisual();
              rt2.character.walkToAndThen(rt2.character.getDeskTile(), () => finishMove(mv, rt2));
              // 下面的看门狗也覆盖这个 leg
            } else {
              finishMove(mv, runtimes.get(mv.actorId));
            }
          }, 900);
        });
      };

      let moveWatchdog = 0;
      const updateBoardMoves = (dt: number): void => {
        // 携带的便条骑在演员的手上
        for (const [id, g] of carriedNotes) {
          const rt = runtimes.get(id);
          if (!rt) continue;
          const p = rt.character.getPixelPosition();
          g.position.set(p.x + 5, p.y - 10);
          g.zIndex = p.y + 1;
        }
        // 开始演员空闲的排队移动
        for (let i = moveQueue.length - 1; i >= 0; i--) {
          if (!busyActors.has(moveQueue[i].actorId)) {
            const mv = moveQueue.splice(i, 1)[0];
            startMove(mv);
          }
        }
        // ASK ME 板在问题等待时脉冲获取注意力
        askPulse += dt;
        if (askCount > 0) drawAskBoard(askPulse);
        // 全局看门狗：如果任何东西在空中太久，硬同步
        moveWatchdog += dt;
        if (moveWatchdog > 30 && busyActors.size > 0) {
          moveWatchdog = 0;
          for (const id of [...busyActors]) {
            busyActors.delete(id);
            const g = carriedNotes.get(id);
            if (g) { g.parent?.removeChild(g); g.destroy(); carriedNotes.delete(id); }
          }
          visualTasks = new Map(lastLedger.map((t) => [t.id, { status: t.status, assignee: t.assignee }]));
          redrawVisual();
        }
      };

      /** 选择执行账簿变更的人：如果在地板上的 assignee，
       * 神用于新鲜钉入/孤立卡片。返回 undefined → 即时重绘。 */
      const actorFor = (assignee: string | undefined, preferGod: boolean): string | undefined => {
        if (!preferGod && assignee && runtimes.has(assignee)) return assignee;
        const god = useStore.getState().agents.find((a) => a.isGod);
        return god && runtimes.has(god.id) ? god.id : undefined;
      };

      let lastLedger: LedgerTask[] = [];
      let firstPoll = true;
      const pollTaskBoard = async (): Promise<void> => {
        try {
          const raw = await window.cth.hiveTasks() as { tasks?: Array<{ id?: string; status?: string; assignee?: string; humanQA?: Array<{ q?: string; a?: string }> }> } | null;
          const arr = (raw && Array.isArray(raw.tasks)) ? raw.tasks : [];
          const ledger: LedgerTask[] = arr.map((t, i) => ({
            id: typeof t?.id === 'string' && t.id ? t.id : `idx-${i}`,
            status: String(t?.status ?? 'todo'),
            assignee: typeof t?.assignee === 'string' && t.assignee ? t.assignee : undefined
          }));
          // 等待 HUMAN 的任务喂养 ASK ME 板的便条计数
          const newAsk = arr.filter((t) =>
            String(t?.status) === 'blocked'
            && Array.isArray(t?.humanQA)
            && t!.humanQA!.some((e) => e && typeof e.q === 'string' && !e.a)
          ).length;
          if (newAsk !== askCount) {
            askCount = newAsk;
            drawAskBoard(askPulse);
          }
          if (firstPoll) {
            // 冷启动：没有剧院，只显示真相
            firstPoll = false;
            visualTasks = new Map(ledger.map((t) => [t.id, { status: t.status, assignee: t.assignee }]));
            redrawVisual();
            lastLedger = ledger;
            return;
          }
          const prev = new Map(lastLedger.map((t) => [t.id, t]));
          let instant = false;
          for (const t of ledger) {
            const old = prev.get(t.id);
            const oldS = old?.status;
            if (oldS === t.status && old?.assignee === t.assignee) continue;
            const after: BoardTask = { status: t.status, assignee: t.assignee };
            let mv: BoardMove | null = null;
            if (!old && (t.status === 'todo' || t.status === 'blocked')) {
              const actor = actorFor(undefined, true);
              if (actor) mv = { kind: 'pin', taskId: t.id, actorId: actor, after, carryColor: NOTE_COLORS[t.status], stand: t.status === 'blocked' ? PIN_STAND : TAKE_STAND, thought: 'pinning a new task 📌' };
            } else if (oldS !== 'doing' && t.status === 'doing') {
              const actor = actorFor(t.assignee, false);
              if (actor && actor === t.assignee) mv = { kind: 'take', taskId: t.id, actorId: actor, after, carryColor: NOTE_COLORS.doing, stand: TAKE_STAND, thought: '去接我的任务' };
            } else if (t.status === 'done' && oldS !== 'done') {
              const actor = actorFor(old?.assignee ?? t.assignee, false);
              if (actor) mv = { kind: 'archive', taskId: t.id, actorId: actor, after, carryColor: NOTE_COLORS.done, stand: ARCHIVE_STAND, thought: 'filing it as done ✔' };
            } else if (t.status === 'blocked' && oldS !== 'blocked') {
              const actor = actorFor(old?.assignee ?? t.assignee, false);
              if (actor) mv = { kind: 'pin', taskId: t.id, actorId: actor, after, carryColor: NOTE_COLORS.blocked, stand: PIN_STAND, thought: 'this one is stuck 😤' };
            }
            if (mv && !busyActors.has(mv.actorId) && !moveQueue.some((q) => q.actorId === mv!.actorId)) {
              if (!visualTasks.has(t.id) && mv.kind !== 'pin') visualTasks.set(t.id, { status: oldS ?? 'todo', assignee: old?.assignee });
              moveQueue.push(mv);
            } else {
              visualTasks.set(t.id, after);
              instant = true;
            }
          }
          // 移除的卡片无声消失
          for (const id of [...visualTasks.keys()]) {
            if (!ledger.some((t) => t.id === id)) { visualTasks.delete(id); instant = true; }
          }
          if (instant) redrawVisual();
          lastLedger = ledger;
        } catch { /* 保持最后绘图 */ }      };
      void pollTaskBoard();
      const taskBoardPoll = setInterval(() => { void pollTaskBoard(); }, 5000);
      (app as any).__taskBoardPoll = taskBoardPoll;

      const addCharacter = async (agent: Agent) => {
        const charName = theme.cast.byName[agent.character] ? agent.character : theme.cast.defaultCharacter;
        const member = theme.cast.byName[charName];
        const seatIndex = claimSeat(agent);
        const seatTile: Tile = (seatIndex != null ? seatTiles[seatIndex] : undefined)
          ?? mapRenderer.getSpawnPoint('entrance')
          ?? { x: 2, y: 2 };
        const waitTile = waitTiles[(seatIndex ?? 0) % waitTiles.length];
        const frames = await theme.cast.getFrames(charName);
        // 如果代理被移除（或场景拆除）则在加载时返回
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
          spawnTile: entrance, // 从办公室门走进来
          glowColor: hexNum(colors.accent[agent.accent]) ?? hexToNumber(member.shirt),
          onClick: (id) => useStore.getState().select(id),
        });
        character.show(charLayer);
        const rt: Runtime = { character, seatIndex, waitTile, charName };
        // 标准桌子将 2×2 PC 显示器绘制在座位上两行上方——
        // 给这些 DeskScreen（就座时点亮）和杯子位置
        // 在显示器旁边，恰好是图块集烘焙的杯子曾经坐的位置
        // 我们在清除它之前（桌子现在开始干净；杯子只存在于
        // 一个代理实际携带一个的地方）。
        if (mapRenderer.gidAt('furniture-above', seatTile.x, seatTile.y - 2) === theme.monitor.offTopLeftGid) {
          const top = { x: seatTile.x, y: seatTile.y - 2 };
          rt.screen = new DeskScreen(mapRenderer, top, theme.monitor);
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
        releaseBreak(rt);                // 释放它持有的任何咖啡馆座位
        releaseErrand(rt);               // 以及它运行的任何空闲跑腿
        releaseRun(rt);                  // 以及任何进行中的咖啡行程
        // 设施收集一个被遗弃的杯子（携带或停在桌面上）
        // 回到边柜，这样有限杯库存永远不会泄漏。
        if (rt.character.isCarryingCup() || rt.character.hasCupOnDesk()) {
          // 夹紧保证"永不泄漏"，但实际触发的夹紧
          // 意味着账目在某处重复计数——显示它而不是
          // 无声地将库存固定在上限。
          if (cleanCups >= MAX_CUPS) console.warn('[office] mug reclaim over cap — cup accounting drifted');
          cleanCups = Math.min(MAX_CUPS, cleanCups + 1);
          drawTray();
        }
        if (rt.seatIndex != null) seatClaims.delete(rt.seatIndex);
        rt.screen?.destroy();
        rt.character.hide(0);
         // 给淡出一点时间，然后销毁
        setTimeout(() => rt.character.destroy(), 700);
        runtimes.delete(id);
      };

      // 将代理的存储状态映射到其地板上的角色。
      const applyState = (agent: Agent, rt: Runtime, force = false) => {
        const changed = force
          || rt.prevStatus !== agent.status
          || rt.prevAction !== agent.action
          || rt.prevCarrying !== agent.carrying
          || rt.prevPrompt !== agent.lastPrompt;
        if (!changed) return;
        // 完成真实工作（working/thinking/compacting → done）赢得一个
        // 小庆祝在角色回到漫游之前——但只在
        // 实质性忙碌时段之后（见 CHEER_MIN_BUSY_MS）：一个收件箱
        // 提示或心跳回复翻转繁忙几秒后安静结束
        // 而不是"庆祝"每几分钟无事可做。
        const wasBusy = rt.prevStatus === 'working' || rt.prevStatus === 'thinking' || rt.prevStatus === 'compacting';
        const isBusy = agent.status === 'working' || agent.status === 'thinking' || agent.status === 'compacting';
        if (isBusy && !wasBusy) rt.busySince = Date.now();
        const finishedWork = !force && !agent.isGod
          && wasBusy && (agent.status === 'idle' || agent.status === 'success')
          && rt.busySince !== undefined && Date.now() - rt.busySince >= CHEER_MIN_BUSY_MS;
        if (!isBusy) rt.busySince = undefined;
        rt.prevStatus = agent.status;
        rt.prevAction = agent.action;
        rt.prevCarrying = agent.carrying;
        rt.prevPrompt = agent.lastPrompt;

        const c = rt.character;
        c.setBaseAlpha(agent.status === 'ghost' ? 0.5 : 1);

         // 当代理在咖啡休息时，导演拥有其头像——一个
         // 简单的空闲/成功刷新不能把它拉回漫游。任何
         // 其他实时状态（工作、阻塞、...）取消休息并转
         // 为正常处理，将其发送回其办公桌/门口。
        if (rt.brk) {
          if (agent.status === 'idle' || agent.status === 'success') {
            c.setStatusGlyph(agent.status === 'success' ? 'success' : 'none');
            return;
          }
          releaseBreak(rt);
        }
        // 空闲跑腿（浇水，窗户，冰箱…）也是一样：空闲刷新
        // 让它 alone，真实工作取消它代理 heading 到桌面。
        if (rt.err) {
          if (agent.status === 'idle' || agent.status === 'success') {
            c.setStatusGlyph(agent.status === 'success' ? 'success' : 'none');
            return;
          }
          releaseErrand(rt);
        }
        // 和咖啡行程一样：真实工作在中途取消它——一个杯子已经
        // 在手只是骑到桌面（cupCarryHome 停放它在那里）。
        if (rt.run) {
          if (agent.status === 'idle' || agent.status === 'success') {
            c.setStatusGlyph(agent.status === 'success' ? 'success' : 'none');
            return;
          }
          releaseRun(rt);
        }

        // 头顶上方的思想云显示代理正在做什么 RIGHT NOW
        // （其实时 `action`，如"编辑 App.tsx"）。工作 → 坐在桌面；
        // 阻塞 → 走到门并闪烁 "!"；完成/空闲 → 漫游。
        switch (agent.status) {
          case 'working':
          case 'thinking':
            c.setStatusGlyph('none');
            c.sitAtDesk(true);
            c.showThought(liveActivity(agent), agent.carrying);
            break;
          case 'waiting':
            // 停在桌面等待神/另一个代理——不是活动
            // 工作（无焦点光晕）且不在门口（那是预留的
            // 需要 human 的代理）。
            c.setStatusGlyph('none');
            c.sitAtDesk(false);
            c.showThought(liveActivity(agent, t('office.activity.waiting')), agent.carrying);
            break;
          case 'blocked':
            c.setStatusGlyph('blocked');
            c.showThought(liveActivity(agent, t('office.activity.needsYou')));
            c.walkToTile(rt.waitTile);
            break;
          case 'compacting':
            // #5C —— 中/紧凑：待在桌面，"打包" 图标 + 思想，
            // 所以紧凑上下文的代理读起来像忙碌而不是冻结。
            c.setStatusGlyph('compacting');
            c.sitAtDesk(true);
            c.showThought(liveActivity(agent, t('office.activity.compacting')));
            break;
          case 'looping':
            // #5C —— 熔断器已武装（#6）：保持位置带旋转
            // 警告图标让失控的代理在地板上可见。
            c.setStatusGlyph('looping');
            c.sitAtDesk(false);
            c.showThought(liveActivity(agent, t('office.activity.looping')));
            break;
          case 'success':
            c.setStatusGlyph('success');
            if (agent.isGod) { c.hideThought(); c.sitAtDesk(true); break; }
            c.startWandering();
            if (finishedWork) {
              c.cheer();
              c.showThought(t(CHEER_KEYS[Math.floor(Math.random() * CHEER_KEYS.length)]));
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
            // 神从桌面运行地板；其他人在空闲时漫游。
            if (agent.isGod) { c.sitAtDesk(true); c.showThought(liveActivity(agent, t('office.activity.runningFloor'))); }
            else if (finishedWork) {
              // 任务完成 → 快速的就地欢呼，然后回到漫游。
              c.startWandering();
              c.cheer();
              c.showThought(t(CHEER_KEYS[Math.floor(Math.random() * CHEER_KEYS.length)]));
            }
            else { c.startWandering(); c.showThought(liveActivity(agent, t('office.activity.idle'))); }
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

      // 当蜂巢路由消息时将信封从发送者桌面飞到每个接收者
      // 端点在生成时快照，所以纸张飞行
      // 一个干净的弧线即使化身在半空中漫游。'human' 接收者
      // （升级）飞到办公室门。
      const ts = mapRenderer.tileSize;
      const humanPos = { x: entrance.x * ts + ts / 2, y: entrance.y * ts + ts };
      const posFor = (id: string): { x: number; y: number } | null => {
        if (id === 'human') return humanPos;
        const rt = runtimes.get(id);
        return rt ? rt.character.getPixelPosition() : null;
      };
      const spawnHandoff = (fromId: string, toId: string, act: MessageAct, needsHuman: boolean) => {
        if (envelopes.length >= MAX_ENVELOPES) return;
        if (toId === fromId) return; // 从不给自己发邮件
        const from = posFor(fromId);
        const to = posFor(toId);
        if (!from || !to) return; // 发送者或接收者不在地板上
        const env = new MessageEnvelope(from, to, act, needsHuman);
        charLayer.addChild(env.container);
        envelopes.push(env);
      };

      // 真实路径：主进程路由器为每个路由消息发出一个事件。
      // 守卫所以陈旧预加载桥（例如在 dev-server 重启添加
      // 此方法之前）退化为"无信封"而不是崩溃地板。
      const offMessage = window.cth.onHiveMessage
        ? window.cth.onHiveMessage((e) => {
            for (const target of e.targets) spawnHandoff(e.from, target, e.act, e.needsHuman);
          })
        : () => { /* onHiveMessage unavailable — real handoffs disabled this session */ };
      // 演示路径：无活动蜂巢时，模拟循环调度合成交接
      // 这样动画仍然可见。明显仅限演示，由 mockEvents.ts 提供。
      const onDemoHandoff = (ev: Event) => {
        const d = (ev as CustomEvent<{ from: string; to: string; act: MessageAct }>).detail;
        if (d) spawnHandoff(d.from, d.to, d.act, false);
      };
      window.addEventListener('cth:demo-handoff', onDemoHandoff);
      (app as any).__offMessage = () => {
        offMessage();
        window.removeEventListener('cth:demo-handoff', onDemoHandoff);
      };

      // 让两个附近的思想云不互相覆盖：堆叠重叠的
      // 向上。从每个气泡的 BASE 矩形计算（忽略
      // 已经应用的提升）所以结果帧到帧稳定。
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
        // 较低的气泡（更大的底部边缘）和最左边的保持其位置；
        // 其余的被推上去。确定性排序 → 无闪烁。
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
        // 思想云根据相机反向缩放以便其文本从不
        // 当窗口/世界缩小到低于 1:1 屏幕尺寸时渲染。
        const zoom = world.scale.x;
        for (const rt of runtimes.values()) {
          rt.character.setBubbleZoom(zoom);
          rt.character.update(dt);
        }
        updateCafeteria(dt);
        updateCoffeeRuns(dt);
        updateErrands(dt);
        updateBossAura(dt);
        updateDeskLife(dt);
        updateBoardMoves(dt);
        resolveBubbleOverlaps();
        for (let i = envelopes.length - 1; i >= 0; i--) {
          if (envelopes[i].update(dt)) {
            envelopes[i].destroy();
            envelopes.splice(i, 1);
          }
        }
      };
      app.ticker.add(onTick);
      // init() 是异步的：当我们到达时地板可能已经在
      // 全屏终端后面，app.init() 自己启动 ticker。
      if (pausedRef.current) app.ticker.stop();

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
      // 地板已启动：给下一次拥挤启动完整预算。
      initRetriesRef.current = 0;
    };

    init().catch((err) => {
      if (mountIdRef.current !== mountId) return;
      const plan = planInitFailure(err, initRetriesRef.current);

      // Pixi 无法获取上下文——通常 GPU 进程在我们
      // 之下重启——并报告为"此浏览器不支持 WebGL"。重试
      // 通过驱逐使用的相同重建路径；半构建的 app 是
      // 此效果的清理拆除当 generation 递增重新运行它。
      if (plan.action === 'retry') {
        initRetriesRef.current = plan.attempt;
        console.warn(`[OfficeFloor] could not get a WebGL context (the GPU process may be restarting) — retrying, attempt ${plan.attempt}/${DEFAULT_MAX_INIT_RETRIES}`);
        setTimeout(() => {
          if (mountIdRef.current === mountId) setGlGeneration((n) => n + 1);
        }, plan.delayMs);
        return;
      }

      // 超出预算。堆栈会说"不支持 WebGL"，这是
      // 既不真实也不可操作；说实际有帮助的话。
      if (plan.action === 'give-up') {
        console.error(`[OfficeFloor] still no WebGL context after ${DEFAULT_MAX_INIT_RETRIES} retries:`, err);
        host.appendChild(floorNote(
          '办公室地板无法获取 GPU 上下文。\n\n' +
          'GPU 可能仍在重启，或太多终端正在\n' +
          '使用它。关闭几个代理终端，或重启\n' +
          'the app, to bring the floor back.'));
        return;
      }

      console.error('[OfficeFloor] init failed:', err);
      host.appendChild(floorNote(
        'OfficeFloor failed to start:\n' + (err?.stack || err?.message || String(err))));
    });

    return () => {
      mountIdRef.current++;
      const a = appRef.current;
      if (a) {
        (a as any).__glRecovery?.();
        (a as any).__resize?.disconnect?.();
        try { (a as any).__unsub?.(); } catch { /* noop */ }
        try { (a as any).__offMessage?.(); } catch { /* noop */ }
        try { clearInterval((a as any).__taskBoardPoll); } catch { /* noop */ }
        safeDestroy(a);
      }
      appRef.current = null;
      while (host.firstChild) host.removeChild(host.firstChild);
    };
  }, [officeTheme, glGeneration, i18n.language]);

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

/** 地板应该出现的地方的一条消息——当
 * 场景无法运行时用户看到的唯一东西，所以三个失败路径共享一个外观。 */
function floorNote(text: string): HTMLDivElement {
  const note = document.createElement('div');
  note.style.cssText =
    'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
    'padding:24px;color:#ffd0b5;font-family:monospace;font-size:13px;text-align:center;white-space:pre-wrap;';
  note.textContent = text;
  return note;
}
function hexNum(n: number): number { return n; }
function hex(n: number): string { return '#' + n.toString(16).padStart(6, '0'); }
function safeDestroy(app: Application) {
  try { app.ticker?.stop(); } catch { /* noop */ }
  try { app.destroy(true, { children: true }); } catch { /* noop */ }
}

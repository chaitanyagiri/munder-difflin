/**
 * 挺过丢失的 WebGL 上下文。
 *
 * Chromium 限制一个渲染进程能持有的 WebGL 上下文数量（约 16 个），当新的
 * 一个越过上限时，它会驱逐最旧的那个——只记录一句
 * "WARNING: Too many active WebGL contexts. Oldest context will be lost."
 *
 * 办公室楼层的上下文在应用启动时创建，所以它总是活着的最旧的那个。每个
 * 终端 xterm 打开都会再占一个上下文（@xterm/addon-webgl），所以在繁忙的
 * 楼层上——足够的 agent，或第二个窗口——办公室就是最先被驱逐的。Pixi
 * 不会察觉：没有异常、没有拒绝的 promise、没有失败横幅。画布只是停止绘制，
 * 办公室变空白直到应用重启。这就是空白办公室 bug。
 *
 * xterm 已经通过回退到它的 DOM 渲染器处理了这个问题。Pixi 没有这种回退，
 * 所以场景必须重建。这个模块只是事件接线，与 OfficeFloor 分开，让恢复策略
 * ——取消事件、防抖、限制重试次数、响亮地放弃——可以针对一个不带浏览器、
 * 不带 GPU、不带 Pixi 的普通 EventTarget 做测试。
 */

export interface GlRecoveryOptions {
  /** 在停止争夺上下文前的重建尝试次数。 */
  maxRebuilds?: number;
  /** 重建前等待：驱逐是在一阵风暴中到来的（通常会同时创建好几个上下文），
   *  立刻抢回一个只是在跟顶替我们的终端赛跑。 */
  delayMs?: number;
  /** 重建场景（OfficeFloor：bump 效果的 generation 依赖）。 */
  onRebuild: () => void;
  /** 重试预算耗尽时调用一次——调用方应该说点什么可见的东西，而不是留下
   *  一个静默空白的画布。 */
  onGiveUp?: () => void;
  /** 可注入，供测试用。 */
  schedule?: (fn: () => void, ms: number) => unknown;
  log?: (msg: string) => void;
}

export const DEFAULT_MAX_REBUILDS = 3;
export const DEFAULT_REBUILD_DELAY_MS = 1500;

/** 监听 `canvas` 上的上下文丢失并重建。返回卸载函数；在 effect 清理时调用
 *  它，让已拆除的场景停止响应。 */
export function installContextLossRecovery(
  canvas: EventTarget,
  opts: GlRecoveryOptions
): () => void {
  const max = opts.maxRebuilds ?? DEFAULT_MAX_REBUILDS;
  const delay = opts.delayMs ?? DEFAULT_REBUILD_DELAY_MS;
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const log = opts.log ?? ((m: string) => console.warn(m));

  let rebuilds = 0;
  let live = true;

  const onLost = (e: Event) => {
    // 不 preventDefault 浏览器就绝不会把上下文交还——画布就此永久作废。
    // 这一行是可恢复场景与永久空白之间的分水岭。
    e.preventDefault();
    if (!live) return;
    if (rebuilds >= max) {
      log(`[OfficeFloor] WebGL context lost again after ${max} rebuilds — too many live contexts on this floor; giving up until restart`);
      opts.onGiveUp?.();
      live = false;
      return;
    }
    rebuilds += 1;
    log(`[OfficeFloor] WebGL context lost (Chromium evicted the oldest context) — rebuilding the scene, attempt ${rebuilds}/${max}`);
    schedule(() => { if (live) opts.onRebuild(); }, delay);
  };

  canvas.addEventListener('webglcontextlost', onLost as EventListener, false);
  return () => {
    live = false;
    canvas.removeEventListener('webglcontextlost', onLost as EventListener, false);
  };
}

/* ─── 一开始就 FAILED 去 GET 上下文 ────────────────────────────────────
 *
 * 上面的恢复只在 `app.init()` resolve 之后才开始监听，所以当它安排的 REBUILD
 * 也拿不到上下文时，它帮不上忙。这正是 GPU 进程死亡（而不是上下文被驱逐）
 * 时发生的事：楼层失去上下文，重建在 1500ms 后触发，而 Chromium 还在把 GPU
 * 进程拉回来。getContext() 返回 null，Pixi 把它变成
 *
 *   Error: This browser does not support WebGL. Try using the canvas renderer
 *
 * 然后 OfficeFloor 把它画到地板上，变成一墙压缩过的帧。这条消息对原因的
 * 描述是骗人的——浏览器支持 WebGL 得很，只是 GPU 进程还没就位——所以把它
 * 当致命错误，会让楼层死到整个应用重启为止，而那个条件一两秒内就会自行
 * 清除。
 *
 * 已在 v0.4.5（Windows、Intel UHD、Electron 32）上复现：从活跃楼层的脚下
 * 杀掉应用的 --type=gpu-process：驱逐路径记录它的重建，重建的 init() 抛出
 * 上面那个错误。
 *
 * 注意两者不是同一种失败。单靠驱逐压力到不了这里：一个推过 Chromium 约
 * 16 个上下文上限的 getContext() 调用会驱逐别人并 SUCCEED，所以楼层的重建
 * 总能赢回自己的槽位。只有 GPU 进程缺位，才会让请求本身失败。
 *
 * 保持为纯分类器 + 规划器，让策略可以在无浏览器、无 GPU、无 Pixi 的情况下
 * 测试——与丢失路径相同。
 */

/** 在承认楼层现在拿不到上下文前的重试次数。三次 1500ms 覆盖一次 GPU 进程
 *  重启还有富余。 */
export const DEFAULT_MAX_INIT_RETRIES = 3;

/** 表示“没有给你的上下文”的消息，涵盖 Pixi 与 Chromium 的说法。
 *  刻意收窄：这里没识别到的任何东西都被当作它很可能就是的 bug 上报，
 *  而不是藏在几秒重试后面。 */
const CONTEXT_UNAVAILABLE = [
  /does not support webgl/i,                              // Pixi 8，原话
  /web(gl|gpu)\d?\s*(is\s+)?(not\s+(supported|available)|unsupported|unavailable)/i,
  /(unable|failed) to (create|get|obtain)[^.]*context/i,
  /no (webgl|gpu|rendering) context/i,
];

/** 当 `err` 表示无法获得渲染上下文时为 true——进程繁忙，而不是一个没有
 *  WebGL 的浏览器。顺着 `cause` 链走，让用自己 Error 包装了失败的上层
 *  调用方仍能正确分类。 */
export function isContextUnavailableError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    const msg = typeof e === 'string' ? e : (e as { message?: unknown })?.message;
    if (typeof msg === 'string' && CONTEXT_UNAVAILABLE.some((re) => re.test(msg))) return true;
    e = (e as { cause?: unknown })?.cause;
  }
  return false;
}

export type InitFailurePlan =
  /** 等 `delayMs`，然后从头重建场景。 */
  | { action: 'retry'; delayMs: number; attempt: number }
  /** 预算耗尽：用语言告诉用户，GPU 已超订。 */
  | { action: 'give-up' }
  /** 不是上下文问题——显示错误，这是一个真实失败。 */
  | { action: 'report' };

/** 判断一次被拒绝的 `app.init()` 意味着什么。`attemptsUsed` 是本次挂载已经
 *  花掉的重试次数，所以预算能跨重建存续。 */
export function planInitFailure(
  err: unknown,
  attemptsUsed: number,
  opts: { maxRetries?: number; delayMs?: number } = {}
): InitFailurePlan {
  if (!isContextUnavailableError(err)) return { action: 'report' };
  const max = opts.maxRetries ?? DEFAULT_MAX_INIT_RETRIES;
  if (attemptsUsed >= max) return { action: 'give-up' };
  // 与重建相同的延迟：GPU 进程要花一会儿才能回来，立刻再问只会得到同一个 null。
  return { action: 'retry', delayMs: opts.delayMs ?? DEFAULT_REBUILD_DELAY_MS, attempt: attemptsUsed + 1 };
}

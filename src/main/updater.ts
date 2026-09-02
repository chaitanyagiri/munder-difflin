import { app, ipcMain, shell } from 'electron';
import type { WebContents } from 'electron';
import { request as httpsRequest } from 'node:https';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig } from './config';
import { DEFAULT_DROP_HTML } from '../shared/releaseDrop';
import { reduceStatus, clampPercent, isNewer, installerUrl, shouldShowReleaseDrop, type UpdateStatus } from '../shared/updateState';

/**
 * 从 GitHub releases 自动更新。
 *
 * 主路径：electron-updater 对接 electron-builder.yml 中的 `publish` 块——
 * 发布工作流会上传 latest*.yml + zip + blockmaps，macOS 构建经过 Developer ID
 * 签名 + 公证 + 钉章，因此 Squirrel.Mac (zip)、NSIS 和 AppImage 都能原生更新。
 * 下载在后台进行；安装始终由用户发起（"restart to update" →
 * `update:restartAndInstall`）。应用绝不会自行重启。
 *
 * 回退路径（win-portable exe，或真正的更新器错误）：纯 `releases/latest`
 * 轮询——与运行版本做 semver 比较，并展示一个仅通知、链接到发布页的状态。
 *
 * 一切都受 `autoUpdate` HarnessConfig 开关（默认开，Settings → General）和
 * `app.isPackaged` 限制——开发环境从不轮询。
 *
 * ─── v0.3.7：为什么原生更新从未真正运行过 ──────────────────────────────────
 * electron-updater 是 CommonJS，并通过惰性 `Object.defineProperty` getter 暴露
 * `autoUpdater`。Node 的 cjs-module-lexer 无法看穿它，因此
 * `await import('electron-updater')` 产生的 ESM 命名空间里没有 `autoUpdater`
 * 命名导出——只有 `.default.autoUpdater`。旧代码写的是
 * `const { autoUpdater } = await import('electron-updater')`，得到 `undefined`，
 * 并在 setup 第一行就抛出 `TypeError: Cannot set properties of undefined
 * (setting 'autoDownload')`。该异常落入一个 catch，静默锁定了仅通知模式，
 * 因此从 v0.3.4 到 v0.3.6 每个打包构建都只提供 "open the releases page"。
 * 在开发环境从不显示，因为整个块在 `app.isPackaged` 之后。
 *
 * 由此得出两条规则，且都承载关键负载：
 *   1. 通过下面的 `loadAutoUpdater()` 解析模块，它处理
 *      命名空间/default 互操作，若导出缺失则抛出带名字的错误；
 *   2. 绝不吞掉更新器错误——每次失败都上报给渲染进程，并追加到 userData 的
 *      `updater.log`，且仅通知降级是按次检查的，不是永久锁定。
 */

const REPO = 'chaitanyagiri/munder-difflin';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const FALLBACK_CACHE_MS = 60 * 60 * 1000;     // 两次 releases/latest 轮询间隔 1h

export type { UpdateStatus };

let sendTo: (() => WebContents | null) | null = null;
let started = false;
let lastFallbackCheck = 0;
/** 记住状态，以便渲染进程重载后状态仍在并可重新提供。 */
let lastStatus: UpdateStatus | null = null;
/**
 * 在重启即安装被 CALLED OFF（取消）时 resolve。
 *
 * `quitAndInstall()` 不报告结果。它请求应用退出，而应用可能拒绝：有 agent
 * 在运行时，退出警告会弹出，用户可以取消它。旧处理器在发出该请求的瞬间就
 * 返回 `{ ok: true }`，于是渲染进程被告知重启成功，而应用仍停留在原地。
 * 每个为等待一个永远不会死的进程而禁用按钮的界面随后便失去了可等待的对象，
 * 按钮卡在 "restarting…" 无法返回。
 *
 * 因此处理器现在改为等待这个。只会发生两件事之一：应用真的退出，此承诺
 * 永不 settle（进程已消失，没有东西可告知），或用户取消后
 * `abortPendingRestart()` 使其 settle，处理器如实上报。
 */
let pendingRestart: ((outcome: { ok: boolean; error?: string }) => void) | null = null;

/**
 * 用户从重启即安装所要求的退出中反悔退出。
 *
 * 由退出警告的取消路径调用，那是唯一知道某次请求的退出被拒绝的地方。
 * 在没有待处理的重启时调用是安全的——用户取消一次普通退出与我们无关。
 */
export function abortPendingRestart(): void {
  if (!pendingRestart) return;
  const resolve = pendingRestart;
  pendingRestart = null;
  logLine('quitAndInstall cancelled by the user at the quit warning');
  resolve({ ok: false, error: 'cancelled' });
}

/**
 * 原生更新器 REFUSED（Squirrel 发出 "The command is disabled and cannot be
 * executed" 而不是抛错）的重启即安装，通过 autoUpdater 错误事件上报，而不是
 * 通过处理器的 try/catch。没有它，处理器的 `await` 会永远挂起，按钮一直
 * 转圈，用户再次点击，而反复的 quitAndInstall 正是让 Squirrel 卡死的元凶。
 * 在这里 settle 会把失败反馈回去，让 UI 展示它并阻止用户反复点击。
 * 没有待处理项时调用是安全的（普通检查错误与我们无关）。
 */
function failPendingRestart(error: string): void {
  if (!pendingRestart) return;
  const resolve = pendingRestart;
  pendingRestart = null;
  resolve({ ok: false, error });
}

/** userData 中只追加的面包屑轨迹。本文件存在的全部意义就在于上一次失败
 *  没有在别处留下任何痕迹。 */
function logLine(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  console.log('[updater]', msg);
  try {
    const dir = app.getPath('userData');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'updater.log'), line);
  } catch { /* 日志绝不能拖垮应用 */ }
}

function emit(status: UpdateStatus): void {
  lastStatus = reduceStatus(lastStatus, status);
  try { sendTo?.()?.send('update:status', lastStatus); } catch { /* 窗口已拆除 */ }
}

function autoUpdateEnabled(): boolean {
  try {
    return readConfig().autoUpdate !== false; // 默认开
  } catch {
    return true;
  }
}

type AutoUpdater = import('electron-updater').AppUpdater;

let autoUpdaterPromise: Promise<AutoUpdater> | null = null;

/**
 * 在 CJS/ESM 互操作接缝上解析 electron-updater 的 `autoUpdater`。
 *
 * 见文件头注释：命名导出对 ESM 词法分析器不可见，因此命名空间对象只在
 * `.default` 上携带它。两种形状都会检查，这样若未来某版 electron-updater
 * 提供真正的命名导出也能继续工作；缺失导出时会抛出我们能在日志里读懂的
 * 错误。
 */
async function loadAutoUpdater(): Promise<AutoUpdater> {
  autoUpdaterPromise ??= (async () => {
    const ns = (await import('electron-updater')) as unknown as {
      autoUpdater?: AutoUpdater;
      default?: { autoUpdater?: AutoUpdater };
    };
    const found = ns.autoUpdater ?? ns.default?.autoUpdater;
    if (!found) throw new Error('electron-updater loaded but exposes no `autoUpdater` export');
    return found;
  })();
  try {
    return await autoUpdaterPromise;
  } catch (e) {
    autoUpdaterPromise = null; // 让稍后的尝试能重试，而不是锁定
    throw e;
  }
}

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 300 ? `${m.slice(0, 300)}…` : m;
}

/** 发布中可在 THIS 机器上安装的那一个资源，按 electron-builder.yml 生成的
 *  名称匹配：mac-{arch}.dmg、win-x64-setup.exe、linux-x86_64.AppImage。
 *  发布中没有匹配资源时返回 null，调用方回退到发布页。下载 URL 位于
 *  github.com/REPO/releases/download/ 之下，因此 openRelease 前缀守卫已经
 *  放行它们。 */
export function pickDownloadAsset(
  assets: ReadonlyArray<{ name?: string; browser_download_url?: string }> | undefined,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string | null {
  if (!Array.isArray(assets)) return null;
  const want = platform === 'darwin' ? new RegExp(`-mac-${arch}\\.dmg$`)
    : platform === 'win32' ? /-win-x64-setup\.exe$/
    : platform === 'linux' ? /-linux-x86_64\.AppImage$/
    : null;
  if (!want) return null;
  const hit = assets.find((a) => typeof a.name === 'string' && want.test(a.name) && typeof a.browser_download_url === 'string');
  return hit?.browser_download_url ?? null;
}

/** 标签为 v{version} 的发布正文，或 undefined。绝不抛错。 */
function fetchReleaseBody(version: string, done: (notes: string | undefined) => void): void {
  try {
    const req = httpsRequest(
      {
        hostname: 'api.github.com',
        path: `/repos/${REPO}/releases/tags/v${version}`,
        method: 'GET',
        headers: { 'User-Agent': 'munder-difflin-updater', Accept: 'application/vnd.github+json' },
        timeout: 10_000
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; if (body.length > 262_144) req.destroy(); });
        res.on('end', () => {
          try {
            const rel = JSON.parse(body) as { body?: string };
            done(typeof rel.body === 'string' ? rel.body : undefined);
          } catch { done(undefined); }
        });
      }
    );
    req.on('error', () => done(undefined));
    req.on('timeout', () => { req.destroy(); done(undefined); });
    req.end();
  } catch { done(undefined); }
}

/** 针对 releases/latest 的仅通知检查（不下载）。绝不抛错。 */
function fallbackCheck(reason: string | undefined, force = false): void {
  const now = Date.now();
  if (!force && now - lastFallbackCheck < FALLBACK_CACHE_MS) return;
  lastFallbackCheck = now;
  try {
    const req = httpsRequest(
      {
        hostname: 'api.github.com',
        path: `/repos/${REPO}/releases/latest`,
        method: 'GET',
        headers: { 'User-Agent': 'munder-difflin-updater', Accept: 'application/vnd.github+json' },
        timeout: 10_000
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; if (body.length > 262_144) req.destroy(); });
        res.on('end', () => {
          try {
            const rel = JSON.parse(body) as { tag_name?: string; html_url?: string; body?: string; assets?: Array<{ name?: string; browser_download_url?: string }> };
            const tag = rel.tag_name ?? '';
            if (tag && isNewer(tag, app.getVersion())) {
              emit({
                state: 'available-manual',
                version: tag.replace(/^v/, ''),
                url: rel.html_url ?? `https://github.com/${REPO}/releases/latest`,
                reason,
                downloadUrl: pickDownloadAsset(rel.assets) ?? undefined,
                // 已经在刚解析的响应里了——带着它零成本，还能让仅通知的
                // toast 也显示 "What's new"。不是新请求：见 TELEMETRY.md，
                // 本应用从不额外发请求。
                notes: typeof rel.body === 'string' ? rel.body : undefined
              });
            }
          } catch { /* 畸形正文——下个周期再试 */ }
        });
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => { /* 离线——下个周期再试 */ });
    req.end();
  } catch { /* 绝不让回退拖垮应用 */ }
}

/** electron-updater 的 checkForUpdates 没有自己的超时。如果 feed 请求打开
 *  但从不响应（连接卡死、强制门户、机器睡眠后半开 socket），promise 永不
 *  settle，于是 runCheck 永远停在 'checking'，徽章一直转圈，且什么都不记录。
 *  而且 electron-updater 会缓存进行中的检查 promise，因此一旦一次检查挂起，
 *  之后每次检查都返回同一个挂起 promise。硬性上限才能保证检查总是到达终止
 *  状态，这也是为什么卡死的更新器每个周期都显示明确错误而不是永久转圈。
 *  设得宽松，因为 feed 载荷（几百字节的 YAML）很小，超过它只能是挂了，而
 *  不是单纯的慢。 */
const CHECK_TIMEOUT_MS = 30_000;

/** 若 `ms` 内 `p` 尚未 settle 则 reject；无论哪种情况都清定时器，这样
 *  慢但成功的检查不会留下悬挂的句柄。 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

/**
 * 一次检查。先走原生；失败时上报真实错误，并仅对本次检查降级为仅通知轮询
 * ——下一个周期再试原生，因此一次小故障不再让本次会话失去自我更新能力。
 */
async function runCheck(): Promise<{ ok: boolean; error?: string }> {
  emit({ state: 'checking' });
  try {
    // 硬性设限，使卡死的 feed 请求无法把徽章永久停在 'checking'
    // （见上面的 withTimeout）；超时会落入 catch，后者记录它、显示错误
    // 状态，并运行仅通知回退。
    const result = await withTimeout(
      loadAutoUpdater().then((autoUpdater) => autoUpdater.checkForUpdates()),
      CHECK_TIMEOUT_MS,
      'update check'
    );
    if (!result || !isNewer(result.updateInfo.version, app.getVersion())) {
      emit({ state: 'not-available' });
    }
    // `update-available` / `download-progress` / `update-downloaded` 处理器
    // （在 initAutoUpdater 中接线）从这里接续。
    return { ok: true };
  } catch (e) {
    const message = errText(e);
    logLine(`native check failed: ${message}`);
    emit({ state: 'error', message });
    fallbackCheck(message);
    return { ok: false, error: message };
  }
}

/** 显式启动（或重启）下载。可安全调用两次。 */
async function runDownload(): Promise<{ ok: boolean; error?: string }> {
  try {
    const autoUpdater = await loadAutoUpdater();
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (e) {
    const message = errText(e);
    logLine(`download failed: ${message}`);
    emit({ state: 'error', message });
    fallbackCheck(message);
    return { ok: false, error: message };
  }
}

/**
 * 启动更新器。在 app.whenReady 中调用一次，并传入主窗口 webContents 的
 * 访问器。开发环境可安全调用（注册 IPC，不轮询）。
 */
/** 仅开发环境——为 `update:simulate` 提供一份贴近真实的发布正文。
 *
 *  结构上是真实 v0.4.4 发布正文的副本，而不是 CHANGELOG.md 的；这个区别
 *  承载关键负载：summarizeReleaseNotes 会消化第一个产出列表项的段落，因此
 *  它必须先跳过标题、营销段落、分隔线和 `> [!IMPORTANT]` 块，才能到达列表
 *  项。若换成 CHANGELOG 的形态（加粗引导段，然后是 `### Fixed`）只会返回
 *  一个列表项——引导段，被从句子中间截断。已对照已发布的 v0.4.4-rc.1 正文
 *  验证：这种形态会产生与真实 toast 相同的 3 个列表项。 */
const SIMULATED_NOTES = `# Munder Difflin v9.9.9

**A local hive of Claude Code, Antigravity, Codex, Grok & Copilot agents that run themselves** —
messaging, routing, and remembering, coordinated by your clone, Michael, who you talk to.

---

## What's new in 9.9.9 — *simulated release*

**On Windows, agents were never told they could message each other.** They started, rendered, and
looked perfectly healthy — but a multi-line prompt handed to a CLI through \`cmd.exe\` is cut off at
its first newline.

- **Agent-to-agent messaging works on Windows.** Prompt-carrying spawns now run the CLI's real
  interpreter directly instead of routing through \`cmd.exe\`, so the whole protocol survives.
- **Setup can finish again.** Accepting the suggested \`~/HarnessAgents\` folder wrote a literal
  \`~\`, and the wizard then died on \`ENOENT: mkdir '~/HarnessAgents'\`.
- **Copying from a terminal is clean.** The Edit menu was intercepting ⌘C before the terminal saw it.
- **Agent terminals are UTF-8.** They ran with no locale at all.`;

export function initAutoUpdater(getWebContents: () => WebContents | null): void {
  sendTo = getWebContents;

  // IPC 接口无条件注册，渲染进程始终可以调用。
  ipcMain.handle('update:restartAndInstall', async () => {
    // 重入守卫：已有一次重启在途。第二次触发 quitAndInstall 会命中 Squirrel
    // 已经禁用的原生命令并抛出 "The command is disabled and cannot be
    // executed"——这正是六次点击才能安装的报告背后反复出现的卡死。拒绝重复
    // 调用，让调用方等待已在进行的那一次，而不是另起一个。
    if (pendingRestart) return { ok: false, error: 'a restart is already in progress' };
    try {
      const autoUpdater = await loadAutoUpdater();
      logLine('quitAndInstall requested by the user');
      const cancelled = new Promise<{ ok: boolean; error?: string }>((resolve) => { pendingRestart = resolve; });
      autoUpdater.quitAndInstall();
      // 仅当退出被取消（abortPendingRestart）或原生更新器报告失败
      // （failPendingRestart，来自错误事件）时才 settle。若应用真的要退出，
      // 进程在这里结束，渲染进程的 promise 随窗口一起消亡。
      return await cancelled;
    } catch (e) {
      pendingRestart = null;
      const error = errText(e);
      logLine(`quitAndInstall failed: ${error}`);
      emit({ state: 'error', message: error });
      return { ok: false, error };
    }
  });
  ipcMain.handle('update:checkNow', async () => {
    if (!app.isPackaged) return { ok: false, error: 'dev build — updates are only checked in packaged apps' };
    return runCheck();
  });
  ipcMain.handle('update:download', async () => {
    if (!app.isPackaged) return { ok: false, error: 'dev build — updates are only downloaded in packaged apps' };
    return runDownload();
  });
  /** 向刚加载的窗口重新提供最后已知状态。 */
  ipcMain.handle('update:current', () => lastStatus ?? { state: 'idle' });
  /**
   * 仅开发环境——推送一条合成的状态，让更新 toast 无需真实发布即可查看。
   * toast 只为两个状态渲染（'downloaded' 与 'available-manual'），而开发构建
   * 两个都到不了：下面的整个轮询块都在 `app.isPackaged` 之后，且 checkNow/
   * download 在上面拒绝了。于是唯一只在发布时出现的 UI，成了构建它时谁都
   * 看不到的那一个。
   *
   * 硬性受 `!app.isPackaged` 限制——在发布构建里此处理器回答 `{ok:false}`，
   * 绝不可能为真实用户伪造更新。
   */
  ipcMain.handle('update:simulate', (_evt, opts: unknown) => {
    if (app.isPackaged) return { ok: false, error: 'simulate is dev-only' };
    const o = (opts ?? {}) as { state?: string; version?: string; notes?: string; drop?: boolean };
    const version = typeof o.version === 'string' && o.version ? o.version : '9.9.9';
    // `drop: true` 预览由默认模板构建的居中发布页；不带它则得到角落里的摘要
    // toast。两条路径都会发布，因此都需要可预览——只默认其一会让另一个永远
    // 只有用户才看得到。
    const notes = typeof o.notes === 'string'
      ? o.notes
      : o.drop === true
        ? `<!-- drop -->\n${DEFAULT_DROP_HTML}\n<!-- /drop -->`
        : SIMULATED_NOTES;
    emit(o.state === 'downloaded'
      ? { state: 'downloaded', version, notes }
      : { state: 'available-manual', version, notes, url: `https://github.com/${REPO}/releases/tag/v${version}`, downloadUrl: installerUrl(version, process.platform, process.arch) });
    logLine(`SIMULATED ${o.state === 'downloaded' ? 'downloaded' : 'available-manual'} ${version} (dev only)`);
    return { ok: true };
  });
  // 仅开发环境——`MD_DROP_PREVIEW=<某份发布正文 .md 的路径>`（见
  // `npm run dev:drop`）会在启动时把该文件喂进 simulate 路径，因此创作中的
  // drop 会在窗口一出现时就居中打开，无需 DevTools 粘贴。渲染进程在挂载时
  // 拉取 `update:current`，所以在窗口存在之前发出也完全没问题。与
  // `update:simulate` 同一道硬性闸门。
  const previewPath = process.env.MD_DROP_PREVIEW;
  if (!app.isPackaged && previewPath) {
    try {
      const notes = readFileSync(previewPath, 'utf8');
      const m = notes.match(/what[’']?s\s+new\s+in\s+v?(\d+\.\d+\.\d+)/i) ?? notes.match(/\bv(\d+\.\d+\.\d+)\b/);
      const version = m?.[1] ?? '9.9.9';
      emit({ state: 'available-manual', version, notes, url: `https://github.com/${REPO}/releases/tag/v${version}`, downloadUrl: installerUrl(version, process.platform, process.arch) });
      logLine(`SIMULATED available-manual ${version} from MD_DROP_PREVIEW=${previewPath} (dev only)`);
    } catch (e) {
      logLine(`MD_DROP_PREVIEW unreadable: ${errText(e)}`);
    }
  }
  // 版本变化后的首次启动：展示 THIS 版本的发布页。印记是更新器自己的
  // （analytics 另有一个独立的，只在遥测初始化后才存在）。在有预览被强制
  // 注入时跳过，且取数失败最多只是没有页面，绝不会破坏启动。
  if (!previewPath) {
    try {
      const stampFile = join(app.getPath('userData'), 'last-run-version');
      let previous: string | null = null;
      try { previous = readFileSync(stampFile, 'utf8').trim() || null; } catch { /* 首次运行 */ }
      const current = app.getVersion();
      // 印记写入在版本变化时保持无条件（即使 `previous` 为 null 时也已
      // 运行），这正是让每个安装只要启动过本版本就被武装的机制。自带
      // try/catch，这样不可写的 userData 也不会通过抛给外层 catch 而跳过
      // 下面的决策。
      let stamped = false;
      if (previous !== current) {
        try {
          mkdirSync(app.getPath('userData'), { recursive: true });
          writeFileSync(stampFile, current + '\n', 'utf8');
          stamped = true;
        } catch (e) {
          logLine(`last-run-version stamp failed: ${errText(e)}`);
        }
      }
      // 以印记真的落地为准，而不只是尝试过：若印记写不进去，`previous` 在
      // 之后的每次启动都保持 null，那么在这里触发会在每次启动都重新打开
      // drop，永远如此。在不可写的 userData 上显示零次才是较小的失败。
      if (stamped && shouldShowReleaseDrop(previous, current)) {
        logLine(`first run of ${current} (previous ${previous ?? 'none'}); fetching its release page`);
        fetchReleaseBody(current, (notes) => {
          emit({ state: 'just-updated', version: current, notes });
          logLine(`just-updated ${current} ${notes ? 'with' : 'without'} release notes`);
        });
      }
    } catch (e) {
      logLine(`post-update check failed: ${errText(e)}`);
    }
  }
  ipcMain.handle('update:openRelease', (_evt, url: unknown) => {
    const href = typeof url === 'string' ? url : `https://github.com/${REPO}/releases/latest`;
    // 只打开项目的 releases 页面——这不是通用 opener。
    if (!href.startsWith(`https://github.com/${REPO}/`)) return { ok: false };
    // 资源 URL 意味着徽章的下载点击，而不是说明链接。它是手动路径留下的唯一
    // 正面痕迹，而且必须由被 REPLACED 的构建来写，因此读到它的版本是下一个
    // ——analytics.ts（update_applied.via）从 0.4.6 开始拾取它，在那之前这行
    // 纯粹是为了有东西可拾取。没有别的东西依赖它，且 openExternal 在上面
    // 已经决定了。
    const asset = /\/releases\/download\/v([0-9][^/]*)\//.exec(href);
    if (asset) logLine(`manual download opened: ${asset[1]}`);
    void shell.openExternal(href);
    return { ok: true };
  });

  if (!app.isPackaged) return;
  if (started) return;
  started = true;

  void (async () => {
    try {
      const autoUpdater = await loadAutoUpdater();
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = false; // 仅在明确重启时安装
      autoUpdater.on('update-available', (info) => {
        logLine(`update available: ${info.version}`);
        emit({ state: 'available', version: info.version, notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined });
      });
      autoUpdater.on('download-progress', (p) => {
        const version = lastStatus && 'version' in lastStatus ? lastStatus.version : app.getVersion();
        emit({ state: 'downloading', version, percent: clampPercent(p.percent) });
      });
      autoUpdater.on('update-downloaded', (info) => {
        logLine(`update downloaded: ${info.version} — waiting for the user to restart`);
        emit({ state: 'downloaded', version: info.version, notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined });
      });
      autoUpdater.on('error', (err) => {
        const message = errText(err);
        logLine(`native updater error: ${message}`);
        emit({ state: 'error', message });
        // 失败的「重启即安装」从这里上报，而不是作为异常抛出。settle 待处理的
        // 重启（没有则为 no-op），让处理器停止等待、UI 显示错误而不是转圈，
        // 也让用户不再重复点击——那正是反复 quitAndInstall 卡死 Squirrel 的
        // 原因。
        failPendingRestart(message);
        // 仅对本次失败做仅通知；下一个周期仍会尝试原生。
        fallbackCheck(message);
      });
      logLine(`native updater ready (current v${app.getVersion()})`);
    } catch (e) {
      // 走到这里意味着模块本身不可用——正是从 v0.3.4 到 v0.3.6 一直藏匿的
      // 那类 bug。在日志和 UI 里大声说出来。
      const message = errText(e);
      logLine(`electron-updater unavailable; notify-only mode: ${message}`);
      emit({ state: 'error', message });
    }

    const tick = (): void => { if (autoUpdateEnabled()) void runCheck(); };
    // 启动后不久先检查一次（不与派生/启动 I/O 争抢），之后每隔
    // CHECK_INTERVAL_MS 检查一次。
    setTimeout(tick, 30_000);
    setInterval(tick, CHECK_INTERVAL_MS);
  })();
}

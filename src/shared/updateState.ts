/**
 * 自动更新状态模型 + 呈现映射。
 *
 * 刻意与 electron 无关：主进程（src/main/updater.ts）从 electron-updater 事件
 * 产出这些状态，工具栏徽章（src/renderer/src/components/UpdateBadge.tsx）渲染
 * 它们，而关键规则——两个状态乱序到达时哪一个胜出、按钮说什么做什么——都在
 * 这里，无需启动 Electron 即可单元测试。
 */

export type UpdateStatus =
  /** 尚无所知（新窗口，或从不检查的开发构建）。 */
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'not-available' }
  | { state: 'available'; version: string; notes?: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'downloaded'; version: string; notes?: string }
  /** 此安装无法自我更新（win-portable，或原生路径失败）：仅通知，链接到发布
   *  页。`reason` 是底层错误。`notes` 是发布正文——仅通知轮询已经读取同一份
   *  携带它的 `releases/latest` JSON，因此 toast 在这里无需第二次请求也能
   *  显示 "what's new"。 */
  | { state: 'available-manual'; version: string; url: string; reason?: string; notes?: string;
      /** 本平台/架构的直接资源（发布存在时）。模态框主按钮下载它；没有它
       *  按钮回退到发布页。 */
      downloadUrl?: string }
  /** 版本变更后的首次启动：`version` 是当前正在 RUNNING 的版本，`notes` 是
   *  它的发布正文，渲染进程可以展示该版本的发布页。 */
  | { state: 'just-updated'; version: string; notes?: string }
  | { state: 'error'; message: string };

export type UpdateAction = 'none' | 'check' | 'download' | 'restart' | 'open-release' | 'manual';

export const REPO = 'chaitanyagiri/munder-difflin';

/** 发布中针对 THIS 机器的安装包，按 electron-builder.yml 生成的名称。当
 *  状态本身不携带 `downloadUrl` 时使用（原生更新器路径从不携带）。 */
export function installerUrl(version: string, platform: string, arch: string): string {
  const v = version.replace(/^v/, '');
  const file = platform === 'darwin' ? `Munder-Difflin-${v}-mac-${arch}.dmg`
    : platform === 'win32' ? `Munder-Difflin-${v}-win-x64-setup.exe`
    : `Munder-Difflin-${v}-linux-x86_64.AppImage`;
  return `https://github.com/${REPO}/releases/download/v${v}/${file}`;
}

/** 状态已知的较新发布，或 null。任何提及比运行版本新的状态的版本都算，
 *  无论更新器正在对它做什么：手动路径始终可用。 */
export function pendingVersion(status: UpdateStatus | null, current: string): string | null {
  if (!status || !('version' in status)) return null;
  if (status.state === 'just-updated') return null;
  return isNewer(status.version, current) ? status.version : null;
}

/** `status` 的发布的手动下载指向哪里：发布本身命名了资源时用它，否则用
 *  约定俗成的安装包 URL。 */
export function manualDownloadUrl(status: UpdateStatus, platform: string, arch: string): string | null {
  if (!('version' in status) || status.state === 'just-updated') return null;
  if (status.state === 'available-manual' && status.downloadUrl) return status.downloadUrl;
  return installerUrl(status.version, platform, arch);
}

export interface UpdateBadgeView {
  /** 版本旁附加的文字，或 null 表示只显示版本。 */
  label: string | null;
  /** 点击做什么。'none' 使徽章不可交互。 */
  action: UpdateAction;
  tone: 'idle' | 'busy' | 'ready' | 'warn';
  /** 悬停提示——底层错误唯一被逐字呈现的地方。 */
  title: string;
  busy: boolean;
}

/** `1.2.3` / `v1.2.3` -> [1,2,3]；任何不是类 semver 的返回 null。 */
export function parseVersion(v: string): [number, number, number] | null {
  const m = String(v ?? '').trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/**
 * 本次启动是否应打开 "what's new" 发布页？
 *
 * `previous` 是 `last-run-version` 印记（文件不存在时为 null），`current` 是
 * 运行版本。
 *
 * 过去该页要求印记已经存在，这意味着它对几乎没人触发：印记和它的读取器在
 * 同一个发布中上线，因此升级进该发布时更早的安装没有这个文件，`previous`
 * 读到 null，而真正的新装也什么都没有。
 *
 *   - 同版本重启        -> false。看过一次就是看过。
 *   - 从未运行过        -> true。  曾经缺失的新装场景。
 *   - 版本向前移动      -> true。  普通升级。
 *   - 版本向后移动      -> false。降级没有新东西可宣布。
 *
 * 注意前向测试是"不是降级"，而非 `isNewer(current, previous)`。`isNewer`
 * 只比较 major.minor.patch 并丢弃 `-rc.N`，因此同一版本的第二 RC
 * （0.4.7-rc.1 -> 0.4.7-rc.2）既非更新也非更旧；问"这是降级吗？"刻意放行
 * 该情形（新构建确实有新说明），同时仍拒绝真正的降级。在这里实现而不是教
 * `isNewer` 认识预发布版本，使徽章/待处理状态机保持不变，因为它为其他决策
 * 读取 `isNewer`。
 */
export function shouldShowReleaseDrop(previous: string | null, current: string): boolean {
  if (previous === current) return false;
  if (previous === null) return true;
  return !isNewer(previous, current);
}

/** 下载百分比以浮点数到达，并在恢复/差异下载时偶尔越界。钳制，让 UI 无法
 *  渲染 `-0%` 或 `104%`。 */
export function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** 状态在更新管线中走到多远。对同一版本，更晚的阶段绝不会被更早的取代
 *  —— 见 `reduceStatus`。 */
function rank(s: UpdateStatus): number {
  switch (s.state) {
    case 'idle': return 0;
    case 'checking': return 1;
    case 'not-available': return 1;
    case 'error': return 1;
    case 'just-updated': return 1;
    case 'available-manual': return 2;
    case 'available': return 3;
    case 'downloading': return 4;
    case 'downloaded': return 5;
  }
}

function versionOf(s: UpdateStatus): string | null {
  return 'version' in s ? s.version : null;
}

/**
 * 把新状态折进当前状态。
 *
 * 关键规则：一旦更新已就绪，6 小时一次的复查（或手动 "check now"）绝不能把
 * "重启即可更新"的提示从用户眼前抹掉——`checking` / `not-available` / 一次
 * 性 `error` 的等级都更低，会输。新的版本总是胜出，因此一个运行了很久、在
 * 0.3.6 就绪时看到 0.3.7 的应用会向前推进，而不是卡住。
 */
export function reduceStatus(prev: UpdateStatus | null, next: UpdateStatus): UpdateStatus {
  if (!prev) return next;
  const pv = versionOf(prev);
  const nv = versionOf(next);
  if (pv && nv && isNewer(nv, pv)) return next;   // 更新的版本取代
  if (pv && nv && pv !== nv) return next;         // 不同（如回滚）的版本
  return rank(next) >= rank(prev) ? next : prev;
}

/**
 * 给定状态时工具栏徽章显示什么、做什么。
 *
 * `currentVersion` 是运行中应用的版本——它总是显示在 logo 旁边，因此这里的
 * 每个视图都是 "v0.3.6" 加至多一个额外标签。
 */
export function describeUpdate(status: UpdateStatus | null, currentVersion: string): UpdateBadgeView {
  const v = currentVersion;
  // 标题栏徽章始终是 MANUAL 路径：点击下载安装包并由用户自行替换应用。
  // 自动更新（下载、重启）位于 Settings -> Updates。因此任何提及较新版本的
  // 状态在这里读取方式相同，无论后台更新器正在对它做什么。
  if (status?.state === 'downloading') {
    // Settings 启动了自动下载；标签只报告进度，别无其他，两条路径互不竞争。
    return {
      label: `downloading ${clampPercent(status.percent)}%`, action: 'none', tone: 'busy', busy: true,
      title: `Downloading v${status.version}… ${clampPercent(status.percent)}%`
    };
  }
  const pending = pendingVersion(status, v);
  if (pending) {
    // 当原生更新器已就绪更新时，徽章驱动与 Settings 窗格相同的自动更新：
    // 下载完成后重启安装，或在 'available' 时启动下载。手动下载保留给
    // 'available-manual'——原生更新器无法取回的仅通知回退——此时用户手工
    // 替换应用。
    if (status?.state === 'downloaded') {
      return {
        label: `v${pending} · restart`, action: 'restart', tone: 'ready', busy: false,
        title: `Click to restart and install v${pending}`
      };
    }
    if (status?.state === 'available') {
      return {
        label: `v${pending} · update`, action: 'download', tone: 'ready', busy: false,
        title: `Downloading v${pending} in the background; click to start it if it has not begun`
      };
    }
    const why = status?.state === 'available-manual' && status.reason
      ? ` (this install could not update itself: ${status.reason})` : '';
    return {
      label: `v${pending} · download`, action: 'manual', tone: 'ready', busy: false,
      title: `Click to download v${pending}, then replace the app you have${why}`
    };
  }
  switch (status?.state) {
    case 'checking':
      return { label: 'checking…', action: 'none', tone: 'busy', busy: true, title: `Checking for updates (you're on v${v})` };
    case 'error':
      return {
        label: 'update check failed', action: 'check', tone: 'warn', busy: false,
        title: `${status.message} — click to try again`
      };
    case 'not-available':
    case 'just-updated':
      // 检查已确认，如实说明。Idle（尚未检查）保持空白。
      return { label: 'latest', action: 'check', tone: 'idle', busy: false, title: `v${v} is the latest version — click to check again` };
    case 'idle':
    default:
      return { label: null, action: 'check', tone: 'idle', busy: false, title: `v${v} — click to check for updates` };
  }
}

export interface UpdateSettingsView {
  /** 标题：此刻重要的版本——你的，或等待中的那个。 */
  headline: string;
  /** 一句话说明。有错误时逐字携带该错误。 */
  detail: string;
  /** 主按钮标签，更新器进行中且没有可点的东西时为 null。 */
  button: string | null;
  action: UpdateAction;
  busy: boolean;
  tone: 'idle' | 'busy' | 'ready' | 'warn';
}

/**
 * 给定状态时 Settings → General 的 "Updates" 块显示什么、做什么。
 *
 * 有意与 `describeUpdate` 分开。工具栏标签只有两个词的空间，无事发生时必须
 * 保持安静，因此它的空闲态什么都不说；Settings 是*主动询问*的去处，因此每个
 * 状态都有完整句子，并且在两个进行中状态之外都有按钮。状态及其之间的转移是
 * 共享的——那是必须保持同步的部分。
 */
export function describeUpdateSettings(
  status: UpdateStatus | null,
  currentVersion: string
): UpdateSettingsView {
  const v = currentVersion;
  switch (status?.state) {
    case 'checking':
      return {
        headline: `You're on v${v}`,
        detail: 'Checking for a newer release…',
        button: null, action: 'none', busy: true, tone: 'busy'
      };
    case 'available':
      return {
        headline: `v${status.version} is available`,
        detail: `You're on v${v}. Download it now — you'll be asked to restart once it's ready.`,
        button: `Download v${status.version}`, action: 'download', busy: false, tone: 'ready'
      };
    case 'downloading':
      return {
        headline: `Downloading v${status.version}`,
        detail: `${clampPercent(status.percent)}% done. You can keep working; the restart is yours to trigger.`,
        button: null, action: 'none', busy: true, tone: 'busy'
      };
    case 'downloaded':
      return {
        headline: `v${status.version} is ready to install`,
        detail: `Restart Munder Difflin to finish updating from v${v}.`,
        button: 'Restart to update', action: 'restart', busy: false, tone: 'ready'
      };
    case 'available-manual':
      return {
        headline: `v${status.version} is available`,
        detail: status.reason
          ? `This install can't update itself (${status.reason}) — download it from the release page.`
          : `This install can't update itself — download it from the release page.`,
        button: status.downloadUrl ? `Download v${status.version}` : 'Open release page',
        action: 'open-release', busy: false, tone: 'warn'
      };
    case 'just-updated':
      return {
        headline: `You're on v${v}`,
        detail: 'Freshly updated. This is the latest release.',
        button: 'Check for updates', action: 'check', busy: false, tone: 'idle'
      };
    case 'error':
      return {
        headline: 'Update check failed',
        detail: `${status.message} (you're on v${v}).`,
        button: 'Try again', action: 'check', busy: false, tone: 'warn'
      };
    case 'not-available':
      return {
        headline: `v${v} is the latest version`,
        detail: "You're already up to date — nothing to install.",
        button: 'Check again', action: 'check', busy: false, tone: 'idle'
      };
    case 'idle':
    default:
      return {
        headline: `You're on v${v}`,
        detail: 'Updates are checked automatically every 6 hours. Check now if you want to be sure.',
        button: 'Check for updates', action: 'check', busy: false, tone: 'idle'
      };
  }
}

/** 安装包下载后按平台该怎么做。显示在标题栏徽章的悬停卡片以及点击后的提示里。 */
export function manualInstallSteps(platform: string): { os: string; steps: string[] } {
  if (platform === 'darwin') {
    return {
      os: 'macOS',
      steps: [
        'Open the .dmg and drag Munder Difflin onto Applications. Choose Replace when asked.',
        'Quit this app, open the new one from Applications, and pick the same project.'
      ]
    };
  }
  if (platform === 'win32') {
    return {
      os: 'Windows',
      steps: [
        'Quit this app, then run the downloaded setup .exe. It replaces the installed version.',
        'Open Munder Difflin again and pick the same project.'
      ]
    };
  }
  return {
    os: 'Linux',
    steps: [
      'Make the downloaded .AppImage executable (chmod +x) and move it over the one you run now.',
      'Quit this app, launch the new AppImage, and pick the same project.'
    ]
  };
}

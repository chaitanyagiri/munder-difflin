import i18n, { isRtlLanguage } from '@/i18n';

/**
 * RTL 脚本终端支持的渲染器开关：ON 保持 xterm 使用其
 * DOM 渲染器，注册阿拉伯语字符连接符，并让 design/global.css 中的
 * bidi CSS 发挥作用 —— 这些共同渲染阿拉伯语（和其他
 * RTL 脚本的中性运行）正确排列，这是 WebGL
 * 单元格绘制器结构上无法做到的（xterm.js 无双向支持：xtermjs/xterm.js#701）。
 * OFF 使用 WebGL 渲染器：更快，且与之前行为完全一致。
 *
 * 语言设置默认值；切换是覆盖。
 *
 * 这在 59d721ed 中作为手动开关交付，默认对所有用户关闭，
 * 因为当时阿拉伯语根本无法选为 UI 语言 ——
 * 手动开关是唯一的途径。现在它可以了，选择
 * 阿拉伯语的用户已经回答了此切换的问题，再次询问
 * 正是创始人报告的混淆来源。因此选择 RTL 应用语言会自动开启它。
 *
 * 它是默认值而非派生值，因为权衡在两个方向都是真实的，且
 * 任何一方都不罕见到可以锁定：
 *   - 同事写阿拉伯语或其日志携带阿拉伯语的英文用户，
 *     有正当理由在不更改 UI 语言的情况下开启此功能。
 *   - 阿拉伯语用户可能希望恢复 GPU 渲染器的速度。这是他们的机器。
 * 因此状态是三值的，而非两值：未设置（跟随语言）、强制开启、
 * 强制关闭。明确选择在任何方向的切换中都保留 ——
 * 刻意开启的用户不会因移开阿拉伯语而丢失它。
 *
 * 它刻意不去嗅探 OS 区域设置，这与语言选择器拒绝的
 * 自动检测相同：`navigator.languages` 不是用户在此应用中
 * 做出的选择，对其做出反应会在升级时使现有用户
 * 脱离 GPU 渲染器而无需他们同意。这里只读取
 * 他们选择的语言和设定的覆盖。
 */
const KEY = 'cth.arabicTerminal';

/** 用户的显式选择，或 `null` 表示"跟随应用语言"。 */
type Override = boolean | null;

let override: Override = readOverride();

function readOverride(): Override {
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored === '1') return true;
    if (stored === '0') return false;
  } catch { /* private mode — no override, so the language decides */ }
  return null;
}

/** 无覆盖时，当前应用语言所要求的值。 */
function languageDefault(): boolean {
  // 实时读取而非缓存：语言在运行时可能变更，且此函数在
  // 终端挂载时调用，可能在模块初始化之后很长时间的。
  try { return isRtlLanguage(i18n.language); } catch { return false; }
}

/** 热路径 —— 在终端挂载和每次 renderer 租约时调用。 */
export function isArabicTerminalEnabled(): boolean {
  return override ?? languageDefault();
}

/** 当上方的值来自语言而非存储的选择时为 true。
 *  Settings 用它来表明，而不是把一个默认值当作决策呈现。 */
export function isArabicTerminalFollowingLanguage(): boolean {
  return override === null;
}

/** 记录显式选择。始终写入 —— 今日与语言一致的覆盖，
 *  明日语言切换后也必须保留。 */
export function setArabicTerminalEnabled(next: boolean): void {
  override = next;
  try { window.localStorage.setItem(KEY, next ? '1' : '0'); } catch { /* private mode */ }
}
/** 移除覆盖，重新跟随应用语言。 */
export function clearArabicTerminalOverride(): void {
  override = null;
  try { window.localStorage.removeItem(KEY); } catch { /* private mode */ }
}

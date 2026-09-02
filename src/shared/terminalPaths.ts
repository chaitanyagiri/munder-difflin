/**
 * 终端输出中 ⌘-点击的路径令牌应该做什么（DO）。
 *
 * v0.3.4 只为 markdown 实现了这一点：agent 输出里的 `*.md` 变成了链接，
 * 点击会打开渲染后的预览。同一行的其他内容仍是死文本，
 * 所以打印出来的 `src/main/updater.ts` 得靠你手动
 * 重新输入到文件树里。
 *
 * 三种结果，划分标准是我们能诚实地（HONESTLY）对文件做什么：
 *
 *   preview → markdown。它有渲染器，而阅读正是其意义所在。
 *   edit    → 可以放进 Monaco 且不撒谎的源码和配置。
 *   reveal  → 其余一切：图片、归档、二进制、PDF、未知
 *             扩展名、目录。我们在文件的父目录打开 OS 文件浏览器，
 *             而不是假装理解这些字节。
 *
 * 为什么 REVEAL 而不 OPEN。令牌来自 AGENT OUTPUT，这是
 * 不可信输入。把任意路径交给 OS 的"用默认应用打开"
 * 调用，会让一行终端文本变成一次执行：打印出来的
 * `installer.dmg`、`payload.app` 或 `.desktop` 文件距离真正运行
 * 只差一次 ⌘-点击。Reveal 只会打开文件浏览器，所以 agent
 * 打印路径所能造成的最坏后果，是给你看一个你自己本来就能访问的文件夹。
 * 这正是本模块对未知类型绝不返回"open"判定（verdict）的原因。
 *
 * 难点在于匹配（MATCHING），而不是分类。锚定已知扩展名
 * （markdown 版的做法）看不到 `report.pdf`——而 `report.pdf`
 * 恰恰是需要 reveal 的情况。把匹配放开到任意扩展名，
 * 反而会把行里的每个版本号和十进制数都拖进来：`v0.4.5`、
 * `1.5`、`electron 43.0`。区分它们的规则见下方。
 */

import { isImagePath } from './imageTypes';

/** 在 markdown 预览中打开的扩展名。 */
const PREVIEW_EXTS = new Set(['md', 'markdown']);

/**
 * 我们愿意放进编辑器的扩展名。刻意用列表而非
 * "任何非二进制的东西"：在这里猜错会把字体或
 * sqlite 文件当作乱码打开，而对任何我们没有把握的东西，
 * reveal 回退都是严格更优的答案。
 */
const EDIT_EXTS = new Set([
  // 源码
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp',
  'hpp', 'cs', 'php', 'lua', 'pl', 'r', 'scala', 'clj', 'ex', 'exs', 'erl',
  'dart', 'zig', 'hs', 'ml', 'vue', 'svelte', 'astro',
  // shell 脚本
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  // 标记与样式
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'xml', 'xsl',
  // 数据与配置
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'env', 'properties', 'lock', 'gradle', 'tf', 'tfvars', 'graphql', 'gql',
  'proto', 'sql', 'csv', 'tsv',
  // 纯文本
  'txt', 'text', 'log', 'diff', 'patch', 'gitignore', 'dockerignore',
  'editorconfig', 'npmrc', 'nvmrc'
]);

export type PathAction = 'preview' | 'edit' | 'reveal';

/**
 * 最后一个路径段的小写扩展名，没有则返回 ''。
 * 在这里本地实现而不是从 imageTypes 导入，这样 `?query` 后缀就不会
 * 触及文件系统调用：终端令牌是文件系统路径，而文件名中字面的 `?`
 * 在我们发布的每个平台上都是合法的。
 */
function extOf(token: string): string {
  const base = token.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/**
 * 一行终端输出里的候选路径令牌。
 *
 * 扩展名必须以字母开头（START WITH A LETTER），后面再跟 1-8 个字母数字。
 * 正是这一条约束把 `v0.4.5`、`1.5` 和 `0.92` 挡在外面：它们的
 * "扩展名"是数字。`node_modules/.bin` 没有扩展名，改由
 * `isPathToken` 里的分隔符规则捕获。
 *
 * 开头的 `X:\` 分组存在是因为 `:` 不能出现在主体字符类里（否则会
 * 吞掉 `:line` 后缀）。没有这个分组时，`C:\Users\x\a.ts` 的匹配会从
 * 反斜杠开始，而无盘符的 `\Users\x\a.ts` 看起来就变成"相对路径"，
 * 会被拼接到 agent 的 cwd 上。
 */
const PATH_TOKEN_RE = /(?:[A-Za-z]:[\\/])?[A-Za-z0-9_@.~/\\+-]*[A-Za-z0-9_@~/\\+-]\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+)?/g;

/** 返回一个全新的匹配器。该正则是有状态的（`g`），所以调用方绝不能共享一个。 */
export function pathTokenMatcher(): RegExp {
  return new RegExp(PATH_TOKEN_RE.source, 'g');
}

/** 从原始匹配中剥掉 shell/散文包裹以及末尾的 `:line`。 */
export function stripPathToken(raw: string): string {
  return raw
    .replace(/^["'`([<]+/, '')
    .replace(/["'`)\]>,.;:]+$/, '')
    .replace(/:(\d+)$/, '');
}

/**
 * 这个令牌是否值得加下划线？
 *
 * 令牌在携带我们认识的扩展名、或包含路径分隔符时才算合格。
 * 分隔符条款让 `docs/report.pdf` 和 `/tmp/dump.bin` 能进入 reveal
 * 分支，而散文行里光秃秃的 `electron.43` 仍保持死文本。
 * 这是启发式，而且本应如此：误报的代价只是一条统计到空、
 * 什么都不做的下划线。
 */
export function isPathToken(token: string): boolean {
  const ext = extOf(token);
  if (!ext) return false;
  if (PREVIEW_EXTS.has(ext) || EDIT_EXTS.has(ext) || isImagePath(token)) return true;
  return /[/\\]/.test(token);
}

/**
 * ⌘-点击应该对 `token` 做什么。
 *
 * 图片刻意解析为 `reveal`。应用确实有图片查看器(IDE 会路由过去),
 * 但终端点击是一种导航手势:你点击路径是因为你想到达那个文件,
 * 而 Finder 里你可以随后拖动、重命名或用你真正想要的工具打开它。
 * 如果这个解读被证明是错的,把它改成 'preview' 即可;
 * 分类器是唯一决定
 * 它去向的地方。
 */
export function classifyPathToken(token: string): PathAction {
  const ext = extOf(token);
  if (PREVIEW_EXTS.has(ext)) return 'preview';
  if (isImagePath(token)) return 'reveal';
  if (EDIT_EXTS.has(ext)) return 'edit';
  return 'reveal';
}

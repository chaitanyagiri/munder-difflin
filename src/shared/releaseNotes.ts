/**
 * 发布说明摘要——把 GitHub 发布正文提炼成 3-5 行短句。
 *
 * 更新器一直在 `available` / `downloaded` / `available-manual` 状态上携带
 * `notes`（electron-updater 的 `info.releaseNotes`，即发布正文），而 UI 一直
 * 把它扔掉。更新 toast 是本应用唯一升起的通知，因此我们仅有的吸引注意力的
 * 时刻，过去却只用来显示版本号。
 *
 * 为什么不能只是 `body.slice(0, 280)`：
 *
 *   1. 正文是 RELEASE.md（见 .github/workflows/release.yml → `body_path`），
 *      约 200 行：一句口号、一个链接、三个平台的下载表、从源码构建的说明、
 *      一份"Previously"列表。真正的新闻位于三分之一处
 *      `## What's new in <version>` 标题之下。取正文的"前几行"只会得到产品
 *      口号——用户早已读过的文字。因此当正文有 "what's new" 标题时我们从
 *      那里开始，并在下一个标题或水平分隔线处停下，以免渗进
 *      "Still new in 0.4.2"。
 *
 *   2. 它是 markdown，而 toast 渲染纯文本。链接必须坍缩为其标签（裸的
 *      `https://github.com/...` 会吃掉整个预算），图片和徽章必须整体消失，
 *      强调标记也必须去掉——但 ONLY 当它们是强调时。`DO_NOT_TRACK` 和
 *      `first_run` 是本项目发布说明中的真实字符串，必须存活。
 *
 *   3. 发布列表项跨越源码行换行。按 `\n` 切分再裁剪会在作者换行处切断句子，
 *      那是任意的，因此续行在裁剪前被折回其列表项。
 *
 * 刻意保持纯净且与 electron 无关（与 updateState.ts 契约相同）：无 DOM、
 * 无 `window`、无导入。toast 和 Settings 块都会调用它，
 * test/release-notes.test.cjs 在不启动任何东西的情况下钉住行为。
 */

/** 摘要中至多这么多行——是 toast，不是更新日志。 */
export const RELEASE_NOTES_MAX_BULLETS = 5;
/** 所有行共享的总字符预算。按让 340px 的 toast 大约保持六行高来定，即便在
 *  块自身的滚动钳制之前。 */
export const RELEASE_NOTES_MAX_CHARS = 280;
/** 任何单行都不得独占整个预算。针对本项目自己的发布说明调校——其列表项以
 *  加粗的句子开头，然后再用两行展开解释：110 能保住引导句加一个从句，并为
 *  其后的两三个列表项留出空间。 */
export const RELEASE_NOTES_MAX_BULLET_CHARS = 110;
/** 低于此值时，被裁剪的尾部不可读（"Icons are nat…"）——改为不裁。 */
const MIN_PARTIAL_CHARS = 40;

export interface ReleaseNotesOptions {
  maxBullets?: number;
  maxChars?: number;
  maxBulletChars?: number;
}

const FENCE_RE = /^\s{0,3}(?:```|~~~)/;
const HEADING_RE = /^\s{0,3}#{1,6}\s+/;
/** `---`、`***`、`___`（及带空格变体）。在列表项测试之前检查，因为
 *  `- - -` 是分隔线而 `- x` 是列表项。 */
const RULE_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET_RE = /^\s*(?:[-*+]|\d{1,2}[.)])\s+/;
const TABLE_ROW_RE = /^\s*\|/;
/** Setext 下划线（标题下的 `====`）——是结构，绝非内容。 */
const SETEXT_RE = /^\s{0,3}=+\s*$/;
const WHATS_NEW_RE = /^\s{0,3}#{1,6}\s+.*what[’']?s\s+new/i;
/** GitHub 会把它追加到自动生成的正文；它是 URL，不是新闻。 */
const FULL_CHANGELOG_RE = /^\s*\**\s*full\s+changelog\s*\**\s*:/i;
const BARE_URL_RE = /^\s*<?https?:\/\/\S+>?\s*$/i;

/**
 * GitHub 的 releases.atom feed 以 RENDERED HTML（而非生成它的 markdown）携带
 * 发布正文，且只要频道 yml 没有 releaseNotes，electron-updater 就会回退到该
 * feed。因此这个解析器即便其每个测试喂的都是 markdown，也得能对付 HTML。
 *
 * 不做处理时，渲染出的 HTML 没有 `##` 标题，因此 what's-new 段落永远找不到，
 * 列表项扫描接过控制权。在我们的正文里唯一看起来像 markdown 列表项的
 * 是 <style> 块里的 `* { box-sizing: border-box; }`，因为 `*` 后跟空格就是
 * 列表项语法。当时发布的 toast 展示的正是它，别无其他。
 *
 * 只是双保险：真正的修复是 electron-builder.yml 里的
 * releaseInfo.releaseNotesFile，它把 markdown 放进 yml，因此 feed 永远不会被
 * 读取。这里只是让未来某次忘记该 yml 的发布降级成正确内容，而不是降级成 CSS。
 */
const STYLE_SCRIPT_RE = /<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi;
const HTML_HEADING_RE = /^\s*<h[1-6]\b[^>]*>/i;
const HTML_LI_RE = /^\s*<li\b[^>]*>/i;
/** 只处理撇号形式，提前解码以便 WHATS_NEW_RE 仍能匹配
 *  `<h2>What&#39;s new</h2>`。刻意不处理 &lt;/&gt;，那会把转义文本制成标签。 */
const APOS_ENTITY_RE = /&(?:#0*39|#x0*27|apos|rsquo|lsquo);/gi;

/** 两种语法之一中的标题。 */
function isHeadingLine(line: string): boolean {
  return HEADING_RE.test(line) || HTML_HEADING_RE.test(line);
}

/** 两种语法之一中的 what's-new 标题。 */
function isWhatsNewLine(line: string): boolean {
  if (WHATS_NEW_RE.test(line)) return true;
  return HTML_HEADING_RE.test(line) && /what[’']?s\s+new/i.test(line);
}

/** 该行以哪种列表项标记开头（两种语法之一），或 null。 */
function bulletPrefix(line: string): string | null {
  if (RULE_RE.test(line)) return null;
  const md = line.match(BULLET_RE);
  if (md) return md[0];
  const li = line.match(HTML_LI_RE);
  return li ? li[0] : null;
}

/**
 * 为一行已连接的行做 markdown → 纯文本。
 *
 * 为测试导出：所有"toast 显示了裸 URL"类 bug 都在这里，在此钉住比经由摘要
 * 钉住容易得多。
 */
export function stripMarkdown(md: string): string {
  return String(md ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')            // 图片/徽章：整体消失
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')         // 行内链接 → 其标签
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')        // 引用链接 → 其标签
    .replace(/<https?:\/\/[^>]*>/g, '')              // 自动链接：这里的 URL 是噪音
    .replace(/<[^>\s][^>]*>/g, '')                   // 游离的行内 HTML
    .replace(/`([^`]*)`/g, '$1')                     // 行内代码，仅反引号
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    // 删除线文本是收回，不是强调——"on ~~Windows~~ macOS" 绝不能变成
    // "on Windows macOS"。
    .replace(/~~[^~]+~~/g, '')
    // 单标记强调需要词边界守卫，否则 `DO_NOT_TRACK` 和 `agent_spawned`
    // 会被弄乱。
    .replace(/(?<![\w*])\*([^*\n]+)\*(?!\w)/g, '$1')
    .replace(/(?<![\w_])__([^_\n]+)__(?!\w)/g, '$1')
    .replace(/(?<![\w_])_([^_\n]+)_(?!\w)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/, '')                // 漏网的标题标记
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s—–:.,;·-]+/, '')         // 剥离链接后遗留的行首孤标点
    .trim();
}

/** 至少含一个单词字符、且足够构成一句话的内容。 */
function isMeaningful(text: string): boolean {
  return text.length >= 3 && /[A-Za-z0-9]/.test(text);
}

/**
 * 丢弃一切属于标记而非散文的东西：围栏代码、HTML 注释、下载/校验和表、
 * 块引用包装和 GitHub 的 `[!NOTE]` 标记。块引用是解包而非丢弃——本项目的
 * 发布说明把真实的注意事项（"Appearance only. No functional change"）放在
 * 块引用内。
 */
function usableLines(body: string): string[] {
  const out: string[] = [];
  let inFence = false;
  // 在任何按行切分之前先处理整块：<style> body 的每一行都是 CSS，而其中
  // 有一行会被解析成 markdown 列表项。
  const cleaned = body
    .replace(/\r\n?/g, '\n')
    .replace(STYLE_SCRIPT_RE, '')
    .replace(APOS_ENTITY_RE, "'");
  for (const raw of cleaned.split('\n')) {
    if (FENCE_RE.test(raw)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const line = raw
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^\s{0,3}>\s?/, '')
      .replace(/^\s*\[![A-Za-z]+\]\s*/, '');
    if (TABLE_ROW_RE.test(line)) continue;
    if (SETEXT_RE.test(line)) continue;
    if (FULL_CHANGELOG_RE.test(line)) continue;
    if (BARE_URL_RE.test(line)) continue;
    out.push(line);
  }
  return out;
}

/**
 * 正文中真正属于 "what's new" 的那一段。
 *
 * 存在 `what's new` 标题时从其后开始，否则从顶部开始；无论哪种情况，还在
 * 前言的阶段会跳过标题和分隔线，一旦收集到内容，标题和分隔线就结束该段。
 */
function firstSection(lines: string[]): string[] {
  const marker = lines.findIndex(isWhatsNewLine);
  const start = marker >= 0 ? marker + 1 : 0;
  const out: string[] = [];
  let seenContent = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (isHeadingLine(line) || RULE_RE.test(line)) {
      if (seenContent) break;
      continue;
    }
    if (!seenContent && isMeaningful(stripMarkdown(line))) seenContent = true;
    out.push(line);
  }
  return out;
}

/**
 * 把该段折成摘要项。
 *
 * 段落里有列表项时列表项优先：更新日志的列表项本身就是摘要，其上的段落通常
 * 只是铺垫，会吃掉五个槽位中的两个。完全没有列表项的发布回退到其段落，因此
 * 一行 "Fixes the crash on launch." 正文也仍能说点东西。
 */
function collectItems(section: string[]): string[] {
  const bullets: string[] = [];
  const prose: string[] = [];
  let current: string[] = [];
  let currentIsBullet = false;

  const flush = (): void => {
    if (current.length === 0) return;
    const text = stripMarkdown(current.join(' '));
    if (isMeaningful(text)) (currentIsBullet ? bullets : prose).push(text);
    current = [];
  };

  for (const line of section) {
    if (line.trim() === '') { flush(); continue; }
    const bullet = bulletPrefix(line);
    if (bullet) {
      flush();
      current = [line.slice(bullet.length)];
      currentIsBullet = true;
    } else if (current.length > 0) {
      current.push(line.trim());   // 上面一项的折行续句
    } else {
      current = [line.trim()];
      currentIsBullet = false;
    }
  }
  flush();

  return bullets.length > 0 ? bullets : prose;
}

/** 按词边界裁剪到 `max` 字符，省略号计入字数。 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  const head = space > max * 0.5 ? cut.slice(0, space) : cut;
  return `${head.replace(/[\s,;:.—–-]+$/, '')}…`;
}

/**
 * 把 GitHub 发布正文解析成简短 "What's new" 摘要。
 *
 * 对缺失、空或仅结构的正文返回 `[]`——绝不返回占位符——因此调用方可渲染
 * 空内容，而不是一个空标题。野生的大多数发布都没有可用正文。
 */
export function summarizeReleaseNotes(
  body: string | null | undefined,
  opts: ReleaseNotesOptions = {}
): string[] {
  const maxBullets = opts.maxBullets ?? RELEASE_NOTES_MAX_BULLETS;
  const maxChars = opts.maxChars ?? RELEASE_NOTES_MAX_CHARS;
  const maxBulletChars = opts.maxBulletChars ?? RELEASE_NOTES_MAX_BULLET_CHARS;
  if (typeof body !== 'string' || body.trim() === '') return [];

  const items = collectItems(firstSection(usableLines(body)));

  const out: string[] = [];
  let used = 0;
  for (const item of items) {
    if (out.length >= maxBullets) break;
    const room = Math.min(maxBulletChars, maxChars - used);
    // 第一行总是渲染（必要时裁剪）；此后，太短而无法阅读的残条还不如少一条
    // 列表项。
    if (out.length > 0 && room < MIN_PARTIAL_CHARS) break;
    const text = clip(item, Math.max(room, 1));
    out.push(text);
    used += text.length;
  }
  return out;
}

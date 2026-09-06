/**
 * markdown 预览的纯链接/路径逻辑。
 *
 * 从 MarkdownPreview.tsx 中提取，以便可以进行单元测试：
 * 这些函数决定渲染后的文档可以触及什么，而
 * `.tsx` 文件无法被 `node --test` 加载。组件仅保留
 * 渲染部分。
 */
import { isImagePath } from '@shared/imageTypes';

/** 以 `baseRel` 的目录为基准解析 `href`（未知时为 ''）。
 *
 *  注意 `..` 只能弹出本函数自己推入的段 ——
 *  `parts` 为空后 `..` 会被丢弃 —— 因此结果始终是工作区根目录
 *  下的路径，而非其兄弟。这是一个便利，并非
 *  安全边界：真实的安全边界是 main
 *  进程中的 `safeJoin`，所有读取都经过它。 */
export function resolveRel(baseRel: string | undefined, href: string): string {
  const baseDir = (baseRel ?? '').split('/').slice(0, -1);
  const parts = [...baseDir];
  for (const seg of href.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

export function isExternal(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href);
}

/** 当 `href` 带有 URI 协议（http:、data:、file:、javascript:…）时为 true。 */
function hasScheme(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

export function isRelativeMd(href: string): boolean {
  return !hasScheme(href) && /\.(md|markdown)(#.*)?$/i.test(href);
}

/**
 * markdown `<img src>` 的工作区相对路径，或当源不是
 * 我们可以加载的本地图片时为 null。
 *
 * 为什么需要这个：预览之前会将每张图片替换为占位符
 * 芯片，因此包含截图的 agent 报告渲染为一行
 * "🖼 screenshot" 药丸 —— 报告的证据在应用中
 * 任何地方都不可见。现在可以通过与一切相同的
 * 限制到根目录的 IPC 解析和读取本地图片。
 *
 * 拒绝什么，以及原因：
 *  - 带协议的（http:、https:、data:、file:、javascript:）。远程
 *    URL 在 CSP（`img-src 'self' data: blob:`）下已失效，且
 *    静默通过 main 进程代理它们会使渲染文档变成网络信标，
 *    向 markdown 的作者泄漏 "这个用户打开了这个文件"。
 *    Agent 生成的 markdown 不可信。
 *  - 扩展名不是已知图片类型的 —— <img> 没有理由将任意文件的
 *    字节拉入渲染器。
 *
 * 前导 `/` 被读为工作区根相对而非文件系统
 * 绝对路径；前导斜杠被剥离，其余从根目录解析，
 * 因此 `/etc/passwd` 变为工作区内的（无害、不存在的）`etc/passwd`
 * 而非逃逸到真实的。
 */
export function resolveLocalImageRel(baseRel: string | undefined, src: string | undefined): string | null {
  if (typeof src !== 'string') return null;
  const raw = src.trim();
  if (!raw) return null;
  if (hasScheme(raw)) return null;
  if (!isImagePath(raw)) return null;
  // 解析前剥离查询/哈希 —— 它们是缓存破坏器，不是路径。
  const clean = raw.split('#')[0].split('?')[0];
  const rooted = clean.startsWith('/');
  const rel = resolveRel(rooted ? undefined : baseRel, clean);
  return rel || null;
}

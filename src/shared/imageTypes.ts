/**
 * 图片文件检测——回答“这个路径是不是图片、携带什么 mime”的唯一切入点。
 *
 * 刻意共享。三个调用点需要同一个答案，且它们分处 IPC 边界的两侧：
 * 主进程为其读取的字节打上 mime 标记（`fs.readFileBinary`），
 * IDE 决定点击打开 Monaco 还是图片预览，
 * markdown 渲染器决定某个 `<img src>` 是否值得解析。
 * 如果这三处产生分歧，失败是静默而令人困惑的——
 * 文件作为预览打开却报 “unknown image”，
 * 或作为乱码在 Monaco 中打开。把表放在这里使分歧变得不可能。
 *
 * 检测按扩展名，而非魔数。这是刻意的：
 * 渲染器必须在拿到任何字节*之前*就决定如何打开文件，
 * 因此在做决定的时刻无法进行内容嗅探。
 * mime 只用于给 `blob:` URL 打上标签
 * 供平台自己的图片解码器使用——
 * 打错标签的文件只是无法解码并显示预览的错误状态，
 * 它永远不会变成脚本或导航。
 *
 */

/** 扩展名（小写、无点）→ mime 类型。 */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml'
};

/**
 * `p` 去掉点后的小写扩展名，没有时返回 ''。
 *
 * 先去掉 `?query` / `#hash`：代理编写的 markdown 经常携带防缓存的
 * 后缀（`./shot.png?v=2`），把 `png?v=2` 当作扩展名会静默丢弃
 * 恰恰是我们想渲染的截图。
 * 只考虑最后一个路径段，因此带点的目录名（`v1.2/report`）
 * 永远不会冒充扩展名。
 */
export function extensionOf(p: string): string {
  if (typeof p !== 'string') return '';
  const clean = p.split('#')[0].split('?')[0];
  const base = clean.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot < 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** `p` 的图片 mime，当扩展名不是已知图片类型时为 null。 */
export function imageMimeForPath(p: string): string | null {
  return MIME_BY_EXT[extensionOf(p)] ?? null;
}

/** 当 `p` 指向我们可以渲染的位图或矢量图时为 true。 */
export function isImagePath(p: string): boolean {
  return imageMimeForPath(p) !== null;
}

/**
 * SVG 是唯一一种同时也是人们手工编辑的源代码的图片格式。
 * 调用方用它保留一个“查看源代码”的逃生口：.svg 作为图片打开
 * （95% 的情况下这正是你想要的），但绝不能变成不可编辑——
 * 而把所有图片直接路由到只读预览恰恰会造成这种后果。
 *
 */
export function isSvgPath(p: string): boolean {
  return extensionOf(p) === 'svg';
}

/** 用于状态行的人类可读字节大小：“864 B”、“1.4 MB”。 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

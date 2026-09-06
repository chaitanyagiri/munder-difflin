import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { imageMimeForPath } from '../shared/imageTypes';

/**
 * 把 `path` 限制在 `root` 之内，防止路径穿越（path-traversal）逃逸。
 * 成功时返回解析后的绝对路径，违规时返回 null。
 *
 * 导出它，是为了让其他主进程模块（例如 git.ts）能用“同一个”守卫来校验
 * 调用方提供的相对路径是否位于工作区根目录内——应用里只有一条路径逃逸
 * 策略，而且就在这里。
 */
export function safeJoin(root: string, rel: string): string | null {
  const absRoot = resolve(root);
  const absPath = isAbsolute(rel) ? normalize(rel) : resolve(absRoot, rel);
  const rel2 = relative(absRoot, absPath);
  if (rel2.startsWith('..') || isAbsolute(rel2)) return null;
  return absPath;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

export async function listDir(root: string, rel: string): Promise<{
  ok: true; entries: DirEntry[]; path: string;
} | { ok: false; error: string }> {
  const abs = safeJoin(root, rel);
  if (!abs) return { ok: false, error: '路径超出根目录' };
  try {
    const names = await readdir(abs);
    const entries = await Promise.all(names.map(async (name): Promise<DirEntry> => {
      try {
        const s = await stat(join(abs, name));
        return { name, isDir: s.isDirectory(), size: s.size, mtime: s.mtimeMs };
      } catch {
        return { name, isDir: false, size: 0, mtime: 0 };
      }
    }));
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { ok: true, entries, path: abs };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const MAX_READ_BYTES = 2 * 1024 * 1024; // 2 MB

export async function readFileText(root: string, rel: string): Promise<{
  ok: true; content: string; path: string; size: number;
} | { ok: false; error: string }> {
  const abs = safeJoin(root, rel);
  if (!abs) return { ok: false, error: '路径超出根目录' };
  try {
    const s = await stat(abs);
    if (s.size > MAX_READ_BYTES) {
      return { ok: false, error: `文件过大（${(s.size / 1024 / 1024).toFixed(1)} MB）` };
    }
    const buf = await readFile(abs);
    // 通过空字节嗅探拒绝明显的二进制文件
    if (buf.includes(0)) return { ok: false, error: '二进制文件（无法显示）' };
    return { ok: true, content: buf.toString('utf8'), path: abs, size: s.size };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 二进制读取的上限。刻意大于 MAX_READ_BYTES（2 MB）：那个上限是为了防止
 * Monaco 被巨大的文本缓冲卡死；把它套到图片上会拒绝掉人们正想看的文件——
 * 整块 5K 显示器的视网膜截图通常就有 3–6 MB。10 MB 既能覆盖真实截图和
 * 设计素材，又仍然拒绝通过 structured clone 把视频大小的负载交给渲染进程。
 */
const MAX_BINARY_READ_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * 以原始字节读取文件，并用与这里其他 fs 入口相同的 `safeJoin` 守卫把读取
 * 限制在 `root` 内。
 *
 * 它的存在是因为文本路径刻意拒绝二进制内容（readFileText 里的空字节嗅探），
 * 这意味着 agent 工作区里的 PNG 在应用内完全无法查看——IDE 打开一个写着
 * "binary file (not displayable)" 的标签页就止步了。渲染进程自己也够不到
 * 这个文件：CSP 是 `default-src 'self'`，没有 `file:` 源，也没有注册任何
 * file 协议，所以 `<img src="file://…">` 会静默失败。因此字节必须走 IPC
 * 传输，渲染进程再把它们变成 `blob:` URL（`img-src` 已经允许）。
 *
 * 绝不做无界读取：打开前先从 stat 检查大小，再与实际读到的字节数复核，
 * 这样两次调用之间变大的文件也不可能溜过上限。
 */
export async function readFileBinary(root: string, rel: string, maxBytes = MAX_BINARY_READ_BYTES): Promise<{
  ok: true; bytes: Uint8Array<ArrayBuffer>; mime: string; path: string; size: number;
} | { ok: false; error: string }> {
  const abs = safeJoin(root, rel);
  if (!abs) return { ok: false, error: '路径超出根目录' };
  try {
    const s = await stat(abs);
    // 目录和 FIFO 是这里的陷阱：对目录 readFile 会抛错
    //（没问题），但对 FIFO 会永久阻塞，且没有大小可核对，这会
    // 挂住 IPC 调用，连带挂住渲染进程的加载状态。
    if (!s.isFile()) return { ok: false, error: '不是常规文件' };
    if (s.size > maxBytes) {
      return { ok: false, error: `文件过大（${(s.size / 1024 / 1024).toFixed(1)} MB）` };
    }
    const buf = await readFile(abs);
    if (buf.byteLength > maxBytes) {
      // 文件在 stat 与 read 之间变大了。罕见，但上限是给渲染进程的
      // 内存保证，不是建议。
      return { ok: false, error: '读取时文件超过大小限制' };
    }
    // 拷贝进一个全新分配的 Uint8Array，而不是直接转发 Buffer。
    // Node 的小读取来自共享的 8 KB Buffer 池，因此池化的
    // Buffer 是内存的一块“视图”，里面还装着无关的最近读到的
    // 字节；structured-clone 会跨 IPC 边界搬运整个底层 ArrayBuffer，
    // 而不仅是视图。拷贝能让渲染进程的负载
    // 恰好是文件本身，不多不少。
    const bytes = new Uint8Array(buf.byteLength);
    bytes.set(buf);
    return {
      ok: true,
      bytes,
      mime: imageMimeForPath(abs) ?? 'application/octet-stream',
      path: abs,
      size: s.size
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function writeFileText(root: string, rel: string, content: string): Promise<{
  ok: true; path: string;
} | { ok: false; error: string }> {
  const abs = safeJoin(root, rel);
  if (!abs) return { ok: false, error: '路径超出根目录' };
  try {
    await writeFile(abs, content, 'utf8');
    return { ok: true, path: abs };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 把开头的 `~` 展开为用户主目录，并返回绝对、规范化的路径。刻意用同步
 * 实现——每个消费方（spawn 守卫、cwd 校验、config 写入）都是同步的。
 *
 * 只有 SHELL 才会展开 `~`；Node 的 `fs`/`child_process` 把它当作字面量
 * 目录名，所以用户输入的 `~/dev/foo` 会失败于每一个 existsSync/statSync，
 * 并以 `cwd does not exist` 告终。它在“摄入”时（项目添加、`pty:spawn`）
 * 就被应用，因此注册表只会存储绝对 cwd，消费方再做纵深防御。
 *
 * 非波浪号的绝对路径会被解析/规范化后返回。展开后仍然是相对路径的内容
 * 会原样（trim 后）返回，让调用方保留自己的“非绝对路径”错误，而不是被
 * 悄悄相对 Electron 进程的 cwd 解析。空输入直接通过。Windows 路径
 * （`C:\…`、UNC）不受影响——它们永远不会以 `~` 开头。
 */
export function expandTilde(p: string): string {
  if (typeof p !== 'string') return p;
  const t = p.trim();
  if (!t) return p;
  let out = t;
  if (t === '~') out = homedir();
  else if (t.startsWith('~/') || t.startsWith('~\\')) out = join(homedir(), t.slice(2));
  if (!isAbsolute(out)) return t;
  return resolve(out);
}

/**
 * 在一处规范化 hive 主目录及其最近列表（#140）。
 *
 * 新手指引在自由文本字段里默认提示 `~/HarnessAgents`，因此最常见的安装
 * 路径——接受默认值、点完成——过去会持久化一个字面量 `~`。点完成会立即
 * 创建该目录，而 Node 的 mkdir 没有 `~` 的概念：它试图创建一个字面名叫
 * "~" 的文件夹，然后以 `ENOENT: no such file or directory, mkdir
 * '~/HarnessAgents'` 告终，把向导卡在最后一步。在 config 写入边界展开，
 * 意味着每一个下游读取者——mkdir、hive 根、启动选择器——看到的都是
 * 同一条绝对路径。
 *
 * `prior` 也会被规范化：否则在此功能出现之前写入的条目，会让启动选择器
 * 把过期的 `~/…` 字符串原样递回去，重新引入同样的失败。与新的主目录
 * 去重，新的在前，并设上限。
 */
export function normalizeHiveHome(
  home: string,
  prior: readonly string[] = [],
  cap = 8
): { home: string; recentHives: string[] } {
  const abs = expandTilde(home);
  const seen = new Set<string>([abs]);
  const recentHives = [abs];
  for (const h of prior) {
    if (typeof h !== 'string' || !h.trim()) continue;
    const e = expandTilde(h);
    if (seen.has(e)) continue;
    seen.add(e);
    recentHives.push(e);
  }
  return { home: abs, recentHives: recentHives.slice(0, cap) };
}

/** 对绝对路径的存在性/元数据检查（v0.3.4——支撑终端 ⌘-点击 markdown 流程）。
 *  这里会展开 `~/`（渲染进程不知道主目录）。只读元数据：返回普通文件
 *  是否存在以及规范化后的绝对路径；绝不返回文件内容。 */
export async function statAbs(p: string): Promise<{ exists: boolean; isFile: boolean; path: string }> {
  const abs = expandTilde(p);
  if (!isAbsolute(abs)) return { exists: false, isFile: false, path: p };
  try {
    const s = await stat(abs);
    return { exists: true, isFile: s.isFile(), path: abs };
  } catch {
    return { exists: false, isFile: false, path: abs };
  }
}

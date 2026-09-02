/**
 * 要删除哪些被隔离的 MemPalace 段。
 *
 * MemPalace 从可疑的 ChromaDB HNSW 段恢复的方式是：把整个段目录改名挪开——
 * mtime 漂移叫 `<uuid>.drift-<stamp>`，元数据不可读叫 `<uuid>.corrupt-<stamp>`
 * ——然后让 Chroma 重建一个干净的段。恢复逻辑本身没问题。但它在我们读过的
 * 任何版本（3.3.5 到当前的 3.7.1）都绝不会删除改名挪开的那份拷贝。
 *
 * 一次性场景没问题；在这里不行，因为这座宫殿的隔离不是一次性的：drawers
 * 段是单个 100 向量的批次（384 维、167,600 字节），永远达不到 Chroma 1000
 * 的同步阈值，所以持久化永远不会触发，`index_metadata.pickle` 永远不会写入，
 * 健康门因此失败并再次隔离它。字节完全相同，每隔几分钟一次，永远循环。
 * Discord 上有用户因此 8 小时内攒了 100GB。
 *
 * 药方在上游——MemPalace 的“有真实数据”下限是 1024 字节，是为微型测试集合
 * 设置的，普通向量批次超出它 163 倍。我们无法发布他们的修复，也无法强迫
 * 任何人升级。所以我们遏制它：扫掉这些拷贝，磁盘在任意版本下都不再增长，
 * 用户无需注意到任何事或做任何事。
 *
 * 纯逻辑、不依赖浏览器全局，因此规则可以在没有磁盘上的宫殿时做单元测试。
 * 与 `store/focusMode.ts` 相同的拆分：决策在这里，`rm` 在 `memory.ts`。
 */

/** 就这些规则关心的范围而言，一个宫殿目录条目。 */
export interface PalaceEntry {
  name: string;
}

/**
 * 只匹配 MemPalace 自己的隔离后缀。
 *
 * 刻意锚定并完全限定——来自 `backends/chroma.py` 的 `%Y%m%d-%H%M%S`，
 * 即恰好 8 位数字、一个短横线、6 位数字、然后是名称结尾。宽松的
 * “包含 .corrupt”测试总有一天会匹配到在线集合，删掉某人的索引。
 * 在线段是没有任何后缀的裸 UUID，因此没有这种精确形状的
 * 条目永远不会成为候选。
 */
const QUARANTINE = /\.(?:drift|corrupt)-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;

/** 隔离时间戳（本地 epoch 毫秒），若不是隔离目录则返回 null。
 *
 *  看时间戳，而不是目录的 mtime：重命名目录不会改变它自身的 mtime
 *  （只会改父目录的），所以 mtime 仍然报告段最后一次被“写入”的时间，
 *  而不是被隔离的时间。时间戳由 MemPalace 在同一台机器上调用
 *  `datetime.now()` 写入，因此本地时间才是它的正确读法。 */
export function quarantineStampMs(name: string): number | null {
  const m = QUARANTINE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const t = new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
  return Number.isNaN(t) ? null : t;
}

export interface ReapOptions {
  /** 保留最新 N 个用于诊断。总得留下一些，让别人能查看
   *  被隔离的是什么、为什么被隔离。 */
  keep?: number;
  /** 绝不碰比这个更年轻的隔离目录。重命名和重建对我们来说不是原子的，
   *  因此宁可不碰最新的那些，也不要与恢复中的 MemPalace 进程竞争。 */
  minAgeMs?: number;
}

const DEFAULTS = { keep: 2, minAgeMs: 10 * 60_000 };

/**
 * 给定宫殿目录当前的全部内容，返回要删除的名字。
 *
 * 按时间戳从新到旧排序，跳过最新的 `keep` 个，然后丢弃其余
 * 比 `minAgeMs` 更老的。返回名字而非路径——调用方拥有
 * 宫殿路径和文件系统。
 */
export function quarantineDirsToReap(
  entries: PalaceEntry[],
  nowMs: number,
  opts: ReapOptions = {}
): string[] {
  const keep = opts.keep ?? DEFAULTS.keep;
  const minAgeMs = opts.minAgeMs ?? DEFAULTS.minAgeMs;

  const stamped: { name: string; ts: number }[] = [];
  for (const e of entries) {
    const ts = quarantineStampMs(e.name);
    if (ts !== null) stamped.push({ name: e.name, ts });
  }
  // 新的在前。同一秒内两个隔离目录用名字破平，这样能产生
  // 稳定可复现的排序，而不是依赖 readdir 的顺序。
  stamped.sort((a, b) => (b.ts - a.ts) || b.name.localeCompare(a.name));

  return stamped
    .slice(Math.max(0, keep))
    .filter((q) => nowMs - q.ts >= minAgeMs)
    .map((q) => q.name);
}

/**
 * 下一次挖掘之前要等待多久。
 *
 * 刚被隔离的宫殿立刻去挖没有任何收益：它重建的段正是下一次 open
 * 会再次隔离的那一个，所以快速节奏的唯一产物是又一份让
 * `quarantineDirsToReap` 清理的拷贝。因此每次遇到新鲜隔离目录的
 * 挖掘都会把等待时间翻倍，而第一次干净的挖掘会直接回落到基础间隔。
 *
 * 刻意设置了上限，而且不高。陷在循环里的宫殿若不设上限，退避会无限
 * 爬升；而等待的代价是真实的：记忆在挖掘之前不可被搜索。收割器已经
 * 清除了 100% 的磁盘增长，所以这里只是在削减 CPU 和 IO——不值得为了
 * 省这点而让 recall 数据旧上一小时。
 */
export function nextMineDelayMs(
  currentMs: number,
  baseMs: number,
  maxMs: number,
  quarantinedThisPass: boolean
): number {
  if (!quarantinedThisPass) return baseMs;
  return Math.min(Math.max(currentMs, baseMs) * 2, maxMs);
}

import { closeSync, cpSync, existsSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateCostUsd, normalizeModel } from './pricing';

/** Claude Code 的项目键：绝对 cwd 中 EVERY 非字母数字
 *  字符全部转成短横线——前导斜杠和任何点都包括在内。
 *  /Users/me/app → -Users-me-app, /Users/me/MDv0.3.0 → -Users-me-MDv0-3-0,
 *  C:\Users\me\app → C--Users-me-app.
 *
 *  每个平台只有一条规则。Windows 分支一直用它；POSIX 有自己的
 *  更窄拼写，正是这种分歧坏了事——见 projectDir。 */
function projectKey(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** 2026 之前的 POSIX 键：去掉前导斜杠，只把斜杠变成短横线，因此点
 *  得以保留（/Users/me/MDv0.3.0 → Users-me-MDv0.3.0）。仅保留以使
 *  变更之前写入的转录仍可读。 */
function legacyProjectKey(cwd: string): string {
  return process.platform === 'win32'
    ? projectKey(cwd)
    : cwd.replace(/^\//, '').replaceAll('/', '-');
}

/** 解析给定工作目录对应的 Claude Code 转录目录：
 *  ~/.claude/projects 以 cwd 为键。
 *
 *  我们过去在 POSIX 上无条件地输出旧键，一旦 Claude Code 改为把所有
 *  非字母数字字符加短横线，这个键就静默地不再匹配了。什么都不会报错——
 *  每个调用方都把缺失目录读作「还没有转录」——因此这次错失耗掉了数月
 *  无效的记忆冷凝（一长串 `condense-abort`，零成功）以及一个用量对账器
 *  一直在安静地读空。
 *
 *  优先使用 CURRENT（当前）拼写；仅当旧拼写存在而当前拼写不存在时
 *  才回退到旧拼写，这样变更前的安装仍可读。这个顺序不是装饰：本 harness
 *  自己就曾把转录复制进旧命名目录，因此一个「先回退」的解析器会永远
 *  继续读我们自己过时的副本。当两者都不存在时返回 CURRENT 拼写，
 *  因为继续创建目录的调用方必须创建 Claude Code 真正会读的那一个。 */
export function projectDir(cwd: string): string {
  const root = path.join(os.homedir(), '.claude/projects');
  const current = path.join(root, projectKey(cwd));
  if (existsSync(current)) return current;
  // 对 cwd '/' 而言，旧键是空字符串，而 path.join(root, '')
  // 会折叠成 projects 的 ROOT——它总是存在，因此回退会交出一个装有
  // 所有项目的目录而非某一个，调用方会读/种下
  // `~/.claude/projects/<session>.jsonl`。空键不是项目名；
  // 把它当作根本没有旧候选。
  const legacyKey = legacyProjectKey(cwd);
  if (!legacyKey) return current;
  const legacy = path.join(root, legacyKey);
  return existsSync(legacy) ? legacy : current;
}

/** 确保会话 `<sessionId>.jsonl` 存在于 `cwd` 的 Claude 项目目录中，
 *  这样该 cwd 下 `claude --resume <sessionId>` 生成才能找到它。Claude
 *  按 cwd 键控转录，因此一个别处启动的会话在它的 `.jsonl` 跨目录种下
 *  之前是不可见的。
 *
 *  - 已存在于目标项目目录 → 无操作，返回 true。
 *  - 在 DIFFERENT（不同）项目目录下找到（从另一个 cwd 恢复——Add
 *    Agent 的「恢复会话」流程，#2）→ 复制过来，返回 true。
 *  - 任何地方都找不到 → 返回 false，这样调用方可回退到全新会话，
 *    而不是启动一个坏掉的 `--resume`。
 *
 *  尽力而为：任何 fs 错误都返回 false，而不是把异常抛进生成流程。 */
/** Claude 会话 id 是一个 UUID。渲染进程提供的 id 会流入 `path.join`，
 *  因此在把 id 用作路径组件之前，要拒绝该字符集之外的任何内容
 *  （精心构造的 `../../x` 之类 id 否则会穿越出项目目录）。 */
const VALID_SESSION_ID = /^[A-Za-z0-9_-]+$/;

export function seedSessionTranscript(cwd: string, sessionId: string): boolean {
  try {
    if (!sessionId || !VALID_SESSION_ID.test(sessionId)) return false;
    const target = path.join(projectDir(cwd), `${sessionId}.jsonl`);
    if (existsSync(target)) return true;
    const projectsRoot = path.join(os.homedir(), '.claude/projects');
    if (!existsSync(projectsRoot)) return false;
    for (const dir of readdirSync(projectsRoot)) {
      const candidate = path.join(projectsRoot, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) {
        mkdirSync(path.dirname(target), { recursive: true });
        cpSync(candidate, target);
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** 把会话 id 解析回它运行的 ORIGINAL（原始）工作目录，用于 Add
 *  Agent 的「恢复会话」自动填充。cwd 从转录 RECORD（每条记录都携带
 *  `cwd` 字段）中读取——刻意 NOT 通过去短横线还原项目目录名，
 *  后者在路径本身含短横线时会有损。搜索每个
 *  `~/.claude/projects/<dir>/<sessionId>.jsonl`；若有多个匹配
 *  （不应出现——会话 id 是唯一 UUID）则最近修改者胜出。
 *  返回 cwd 字符串；找不到/不可读/无 cwd 记录时返回 null。 */
export function resolveSessionCwd(sessionId: string): string | null {
  try {
    if (!sessionId || !VALID_SESSION_ID.test(sessionId)) return null;
    const projectsRoot = path.join(os.homedir(), '.claude/projects');
    if (!existsSync(projectsRoot)) return null;
    let best: { file: string; mtime: number } | null = null;
    for (const dir of readdirSync(projectsRoot)) {
      const candidate = path.join(projectsRoot, dir, `${sessionId}.jsonl`);
      try {
        const st = statSync(candidate);
        if (!best || st.mtimeMs > best.mtime) best = { file: candidate, mtime: st.mtimeMs };
      } catch { /* 该项目目录中不存在 */ }
    }
    if (!best) return null;
    const text = readFileSync(best.file, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed) as { cwd?: unknown };
        if (typeof rec.cwd === 'string' && rec.cwd) return rec.cwd;
      } catch { /* 跳过畸形行 */ }
    }
    return null;
  } catch {
    return null;
  }
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
  /** 最近一次看到的模型 id（已规范化，如 `claude-opus-4-8`），或
   *  没有找到已计价的记录时为 undefined。让 UI 给该行贴标签。 */
  model?: string;
}

function zero(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0 };
}

export interface ReadUsageOptions {
  /** 设置后，只对记录携带此 `sessionId` 的转录求和。
   *  这正是避免同驻代理重复计数（bug #2）的方式：两个共享 cwd 的代理
   *  各自过滤到自己的会话，而不是对共享项目目录下每个 `.jsonl` 求和。
   *  未设置时全部求和（旧行为，用于代理的会话 id 尚不可知的情况）。 */
  sessionId?: string;
}

/** 用量缓存的按文件增量解析状态。转录是只增的 JSONL，
 *  因此已解析字节区间的总计绝不会变——重复读取只会 stat 文件并解析
 *  追加的尾部。以 dir|file|sessionFilter 为键，因为过滤器会改变
 *  一个区间求和的结果。 */
interface FileUsageEntry {
  size: number;
  mtimeMs: number;
  /** 目前已解析的字节数——总是停在新行边界上，因此被截断的
   *  尾部行只会在写入方写完它之后才被重新读取。 */
  offset: number;
  totals: AgentUsage;
}

const usageCache = new Map<string, FileUsageEntry>();
/** 软上限；越过时丢弃最早插入的一半（条目按需重建）。
 *  真实群组只有几十份转录，不是几千份。 */
const USAGE_CACHE_MAX = 2048;

/** 把完整的 JSONL 行解析进 `acc`（共享的逐记录逻辑）。 */
function parseUsageLines(text: string, sessionId: string | undefined, acc: AgentUsage): void {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: {
      type?: unknown;
      sessionId?: unknown;
      message?: { model?: unknown; usage?: Record<string, unknown> };
    };
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (rec.type !== 'assistant') continue;
    // 会话过滤：跳过不属于该代理会话的记录。
    if (sessionId && rec.sessionId !== sessionId) continue;
    const u = rec.message?.usage;
    if (!u) continue;
    const model = typeof rec.message?.model === 'string' ? normalizeModel(rec.message.model) : undefined;
    if (model) acc.model = model;
    const rIn = num(u.input_tokens);
    const rOut = num(u.output_tokens);
    const rCacheWrite = num(u.cache_creation_input_tokens);
    const rCacheRead = num(u.cache_read_input_tokens);
    acc.inputTokens += rIn;
    acc.outputTokens += rOut;
    acc.cacheWriteTokens += rCacheWrite;
    acc.cacheReadTokens += rCacheRead;
    // 按该记录自己的模型计价，然后累加——这样混合模型的代理（罕见）
    // 仍能被正确计费，而不是按一个统一费率估算。
    acc.estimatedCostUsd += estimateCostUsd(model, {
      inputTokens: rIn,
      outputTokens: rOut,
      cacheReadTokens: rCacheRead,
      cacheWriteTokens: rCacheWrite
    });
  }
}

/** 单个转录文件的缓存总计，增量刷新：size+mtime 未变 → 缓存命中
 *  （完全不读）；变大 → 只解析追加的尾部；变小（被重写）→ 完整重解析。
 *  文件消失时返回 Null。 */
function readFileUsage(dir: string, file: string, sessionId: string | undefined): FileUsageEntry | null {
  const key = `${dir}|${file}|${sessionId ?? '*'}`;
  const full = path.join(dir, file);
  let st: { size: number; mtimeMs: number };
  try { st = statSync(full); } catch { usageCache.delete(key); return null; }
  const cached = usageCache.get(key);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached;
  const fromScratch = !cached || st.size < cached.offset;
  const entry: FileUsageEntry = fromScratch
    ? { size: st.size, mtimeMs: st.mtimeMs, offset: 0, totals: zero() }
    : { size: st.size, mtimeMs: st.mtimeMs, offset: cached!.offset, totals: { ...cached!.totals } };
  try {
    const fd = openSync(full, 'r');
    try {
      const len = st.size - entry.offset;
      if (len > 0) {
        const buf = Buffer.alloc(len);
        const read = readSync(fd, buf, 0, len, entry.offset);
        const text = buf.subarray(0, read).toString('utf8');
        // 只消费到最后一个完整行为止；被截断的尾部行保持未解析
        // （offset 停在新行处），直到写入方把它写完——它随后恰好被计数一次。
        const lastNl = text.lastIndexOf('\n');
        if (lastNl !== -1) {
          const complete = text.slice(0, lastNl + 1);
          parseUsageLines(complete, sessionId, entry.totals);
          entry.offset += Buffer.byteLength(complete, 'utf8');
        }
      }
    } finally { closeSync(fd); }
  } catch {
    // 此刻不可读——保留已解析的部分；总计在下一次调用时刷新。
  }
  usageCache.set(key, entry);
  if (usageCache.size > USAGE_CACHE_MAX) {
    let drop = usageCache.size - USAGE_CACHE_MAX / 2;
    for (const k of usageCache.keys()) { if (drop-- <= 0) break; usageCache.delete(k); }
  }
  return entry;
}

/** 对 `cwd` 的 Claude Code 转录做真实 token 用量求和，按每个 assistant
 *  记录 ITS OWN（它自己的）模型计价（修复成本 bug #1——不再人人都是
 *  Sonnet）经由回退价格表。可选地过滤到单个会话（修复 bug #2）。
 *  设计上就健壮：任何不可读文件或畸形行都会被跳过，任何意外失败都返回
 *  归零结果，而不是把异常抛进 IPC 处理器。这是 OFFLINE（离线）对账 /
 *  回退——实时来源是 OTel 采集器（`telemetry.ts`）。
 *
 *  在每个没有实时 OTel 的代理上由 ~30s 熔断/成本节拍调用，因此它必须在
 *  多 MB 的转录目录上保持廉价：上面的按文件增量缓存意味着稳态调用只是
 *  一次 readdir 加每个文件一次 stat。 */
export function readAgentUsage(cwd: string, opts: ReadUsageOptions = {}): AgentUsage {
  const usage = zero();
  try {
    const dir = projectDir(cwd);
    if (!existsSync(dir)) return usage;
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    let lastModel: string | undefined;
    for (const file of files) {
      const entry = readFileUsage(dir, file, opts.sessionId);
      if (!entry) continue;
      usage.inputTokens += entry.totals.inputTokens;
      usage.outputTokens += entry.totals.outputTokens;
      usage.cacheWriteTokens += entry.totals.cacheWriteTokens;
      usage.cacheReadTokens += entry.totals.cacheReadTokens;
      usage.estimatedCostUsd += entry.totals.estimatedCostUsd;
      if (entry.totals.model) lastModel = entry.totals.model;
    }
    if (lastModel) usage.model = lastModel;
    return usage;
  } catch {
    return zero();
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** 活动会话的当前上下文大小（token 数）：其转录中 LAST（最后一条）
 *  assistant 消息的 token 记账——输入 + 缓存读/写正是模型刚作为上下文
 *  消耗的量，再加上它的输出，后者会加入下一轮的上下文。尾部读取文件
 *  （转录会长到数 MB），因此轮询保持廉价。当转录缺失/不可读或
 *  还没有 assistant 消息时返回 null。 */
const CONTEXT_TAIL_BYTES = 256 * 1024;

export function readContextTokens(transcriptPath: string): number | null {
  try {
    if (!existsSync(transcriptPath)) return null;
    const fd = openSync(transcriptPath, 'r');
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, CONTEXT_TAIL_BYTES);
      if (len === 0) return null;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      // 从末尾向前扫；最开头的块行可能被从记录中间切断，
      // 解析失败即可，这没关系。
      for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        let rec: { type?: unknown; message?: { usage?: Record<string, unknown> } };
        try {
          rec = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (rec.type !== 'assistant') continue;
        const u = rec.message?.usage;
        if (!u) continue;
        return num(u.input_tokens) + num(u.output_tokens)
          + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
      }
      return null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

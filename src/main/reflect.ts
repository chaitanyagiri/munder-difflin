/**
 * MemoryReflector —— 清理程序缺失的“压缩”那一半。
 *
 * 清理程序会标记一个过大的 `agents/<id>/memory.md`（“需要压缩。”），
 * 但从不去缩小它。本服务完成这个工作：在一个进程内定时器上，它找出
 * 越过大小/小节阈值的记忆文件，把它们重写成有界的三段式形状——
 * 固定的持久事实（绝不触碰）、一份滚动递归摘要、以及最新的 K 个原样
 * 小节——对被逐出的尾部用一次廉价的无头 `claude -p`（Haiku）做摘要。
 *
 * 为什么在进程内（Electron 主进程）而不是 launchd：launchd 拉起的 shell
 * 会被 macOS TCC 挡住，无法访问 `~/Documents`；只有本进程拥有文件夹
 * 授权。所以循环与 `memory.start()` 并肩而居——绝不是 cron。
 *
 * 安全性分层，让一次糟糕的 LLM 扫描绝不会丢数据：
 *   先备份（无损冷拷贝）→ 验证而非信任的门 → 原子替换。
 * 任何检查失败时，原文件一个字节不动地留在原地，唯一副作用是一行
 * `condense-abort` 日志。因为 mtime 变了，矿工在下一个滴答会自动给
 * 新文件重新建索引（memory.ts）。
 *
 * 运行在 Electron 主进程。
 */
import {
  existsSync, statSync, readdirSync, readFileSync, writeFileSync,
  mkdirSync, copyFileSync, renameSync, openSync, fsyncSync, closeSync
} from 'node:fs';
import { join, dirname } from 'node:path';
import { runHiddenClaude } from './hiddenClaude';

/** memory.md 的总预算——镜像清理程序的 CONTEXT_BUDGET_BYTES（128 KB）。 */
const BUDGET_BYTES = 131_072;
/** 廉价尾部摘要器（由 god 裁定）。验证门负责质量。 */
const CONDENSE_MODEL = 'claude-haiku-4-5';
/** 硬上限，让卡死的无头运行无法拖住 reflect 循环。 */
const DEFAULT_TIMEOUT_MS = 180_000;

/** 有界记忆形状的固定区域标题（稳定契约）。 */
const PINNED_HEADING = '## 📌 Durable facts (pinned — never condensed)';
const CONDENSED_HEADING = '## 🗜 Condensed history';
const RECENT_HEADING = '## Recent';

/** 指令前缀——跨调用保持字节一致（不拼入日期/id），让 Claude Code
 *  能对它做 prompt 缓存；动态内容放在尾部。 */
const CONDENSE_SYSTEM = [
  "You are compacting one AI agent's long-term memory file. You will receive:",
  '(A) the current CONDENSED summary, (B) older RECENT sections being evicted,',
  '(C) the PINNED durable-facts block (for context only — do not rewrite it).',
  'Produce STRICT JSON: {"condensed": "<text>", "hoist": ["<line>", ...]}.',
  'RULES:',
  '- "condensed" = a single bounded summary of (A)+(B). Re-summarize (A) together',
  '  with (B) so the result does not grow unbounded. Target <= 1500 words. Preserve',
  '  every decision, root cause, protocol, file path, commit SHA, and numeric result.',
  '  Drop routine standup chatter, resolved blockers, and superseded plans.',
  '- "hoist" = any NEW high-importance durable fact found in (B) that belongs in the',
  '  pinned block and is not already in (C). Lines only; may be empty.',
  '- Output ONLY the JSON object. No prose, no code fence.'
].join('\n');

export interface ReflectSettings {
  enabled: boolean;
  /** 多久扫描一次过大的记忆文件。 */
  intervalMs: number;
  /** 当字节数超过 BUDGET_BYTES 的这个百分比时压缩。 */
  byteTriggerPct: number;
  /** ...或者当 `## ` 小节数超过此数时（AND 字节 > minBytes）。 */
  sectionTrigger: number;
  /** 最新的 K 个原样 `## ` 小节总是原封不动地保留。 */
  recentKeep: number;
  /** 绝不压缩小于此值的文件——既是“别浪费一次 LLM 调用”的守卫，
   *  也是小节数触发器的字节下限。 */
  minBytes: number;
}

/** 一个 `## ` 小节：它的标题行及其下方的正文。 */
interface Section { heading: string; body: string }

/** 解析成三段的 memory.md。`pinned`/`condensed` 对遗留（非结构化）
 *  文件为 null——它们在首次压缩时创建。 */
interface Parsed {
  header: string;            // `# Memory …` H1 + 第一个 `##` 之前的任何前言
  pinned: string | null;     // pinned 标题下的正文（不含标题行）
  condensed: string | null;  // condensed 标题下的正文
  recent: Section[];         // 其余每个 `## ` 小节，按文件顺序（旧→新）
}

/** 一次对某个 agent 的 reflect 尝试的结果——呈现给手动 IPC 和测试。 */
export interface ReflectResult {
  id: string;
  condensed: boolean;        // 我们真的重写了文件吗?
  reason: string;            // 原因（skipped/aborted/done），供日志和 UI 使用
  oldBytes?: number;
  newBytes?: number;
}

export class MemoryReflector {
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  /** 当一次 reflectNow() 正在执行时为 true——串行化循环（慢速 LLM 扫描
   *  不得与下一个间隔滴答重叠），镜像 MemoryManager。 */
  private reflecting = false;

  /**
   * @param getHome      懒解析 harnessHome，让 reflect 跟随配置。
   * @param getCommand   基础 `claude` 命令（只用它的二进制名）。
   * @param getMemoryEnv 合并进调用的额外 env（共享 MemPalace 路径）。
   * @param getSettings  Reflect 可调项（间隔 + 阈值），每个滴答读取。
   * @param appendLog    `condense`/`condense-abort` 事件的汇（hive log.jsonl）。
   */
  constructor(
    private getHome: () => string | null,
    private getCommand: () => string,
    private getMemoryEnv: () => Record<string, string>,
    private getSettings: () => ReflectSettings,
    private appendLog: (event: Record<string, unknown>) => void
  ) {}

  // —— 生命周期（镜像 MemoryManager）——

  start(): void {
    if (this.started) return;
    if (!this.getSettings().enabled) return;
    if (!this.getHome()) return;
    this.started = true;
    // 第一次扫描放在一个间隔之后，而不是启动时，让启动不与
    // LLM 调用争抢（而且刚恢复的家目录也不会在被挖掘前就被压缩）。
    const ms = Math.max(60_000, this.getSettings().intervalMs);
    this.timer = setInterval(() => { void this.reflectNow(); }, ms);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.started = false;
  }

  // —— 扫描 ——

  /** 逐个 reflect 每个记忆越过阈值（或仅 `onlyId`）的 agent。
   *  通过 `reflecting` 串行化，让慢扫描无法与下一个滴答重叠。
   *  返回每个 agent 的结果（供手动 IPC + 测试使用）。 */
  async reflectNow(onlyId?: string): Promise<ReflectResult[]> {
    const home = this.getHome();
    if (!home) return [];
    if (this.reflecting) return [];
    const agentsDir = join(home, 'hive', 'agents');
    if (!existsSync(agentsDir)) return [];
    const settings = this.getSettings();
    let ids: string[];
    try { ids = readdirSync(agentsDir); } catch { return []; }
    if (onlyId) ids = ids.filter((id) => id === onlyId);

    this.reflecting = true;
    const results: ReflectResult[] = [];
    try {
      for (const id of ids) {
        const mem = join(agentsDir, id, 'memory.md');
        if (!existsSync(mem)) continue;
        let bytes = 0;
        let text = '';
        try {
          bytes = statSync(mem).size;
          // 手动单 agent 调用按需压缩（跳过触发器）；
          // 自主循环遵循阈值。
          if (!onlyId && !this.shouldCondense(bytes, mem, settings)) continue;
          text = readFileSync(mem, 'utf8');
        } catch { continue; }
        results.push(await this.condense(home, id, mem, text, settings));
      }
    } finally {
      this.reflecting = false;
    }
    return results;
  }

  /** 双重触发器（已裁定）：字节 > 预算的 pct%，或字节下限以上的
   *  多小节蔓延。字节下限同时充当“绝不为小文件烧 LLM 调用”的守卫，
   *  因此它同时门控两条路径。 */
  private shouldCondense(bytes: number, mem: string, s: ReflectSettings): boolean {
    if (bytes < s.minBytes) return false;
    if (bytes > (BUDGET_BYTES * s.byteTriggerPct) / 100) return true;
    let sections = 0;
    try { sections = countSections(readFileSync(mem, 'utf8')); } catch { return false; }
    return sections > s.sectionTrigger;
  }

  // —— 压缩一个文件 ——

  private async condense(
    home: string, id: string, mem: string, text: string, s: ReflectSettings
  ): Promise<ReflectResult> {
    const oldBytes = Buffer.byteLength(text, 'utf8');
    const parsed = parseMemory(text);
    // 把 recent 拆成 KEEP（最新的 K 个，原样）和 EVICT（更旧的——被摘要）。
    const keepCount = Math.max(1, s.recentKeep);
    const keep = parsed.recent.slice(-keepCount);
    const evict = parsed.recent.slice(0, Math.max(0, parsed.recent.length - keepCount));
    if (evict.length === 0) {
      return { id, condensed: false, reason: 'nothing-to-evict', oldBytes };
    }

    // 1) 先备份——无损冷拷贝让之后每一步都可恢复。
    const stamp = utcStamp();
    const backup = join(home, 'hive', 'backups', stamp, id, 'memory.md');
    try {
      mkdirSync(dirname(backup), { recursive: true });
      copyFileSync(mem, backup);
    } catch (e) {
      this.logAbort(id, 'backup-failed', String(e));
      return { id, condensed: false, reason: 'backup-failed', oldBytes };
    }

    // 2) 用无头 Haiku 摘要（condensed + evicted）尾部。
    let summary: { condensed: string; hoist: string[] };
    try {
      summary = await this.summarize(home, parsed.condensed, evict, parsed.pinned);
    } catch (e) {
      this.logAbort(id, 'summarize-failed', String(e));
      return { id, condensed: false, reason: 'summarize-failed', oldBytes };
    }

    // 3) 重建为三段式形状。
    const oldPinnedLines = pinnedLines(parsed.pinned);
    const mergedPinned = mergePinned(oldPinnedLines, summary.hoist);
    const rebuilt = rebuild(parsed.header, mergedPinned, summary.condensed, keep);
    const newBytes = Buffer.byteLength(rebuilt, 'utf8');

    // 4) 验证而非信任——所有检查通过才接受这次重写。
    const verdict = verify({
      rebuilt, newBytes, oldBytes, oldPinnedLines, mergedPinned,
      condensed: summary.condensed, keep
    });
    if (!verdict.ok) {
      this.logAbort(id, verdict.reason, undefined, { oldBytes, newBytes });
      return { id, condensed: false, reason: verdict.reason, oldBytes, newBytes };
    }

    // 5) 原子替换——写临时同名兄弟文件、fsync、rename 覆盖原文件。
    try {
      atomicWrite(mem, rebuilt);
    } catch (e) {
      this.logAbort(id, 'swap-failed', String(e), { oldBytes, newBytes });
      return { id, condensed: false, reason: 'swap-failed', oldBytes, newBytes };
    }

    try {
      this.appendLog({
        kind: 'condense', agentId: id, oldBytes, newBytes,
        evicted: evict.length, kept: keep.length, hoisted: summary.hoist.length, backup
      });
    } catch { /* 日志是尽力而为 */ }
    // 矿工在下一个周期内重新建索引——mtime 变了，无需额外接线。
    return { id, condensed: true, reason: 'condensed', oldBytes, newBytes };
  }

  private logAbort(id: string, reason: string, detail?: string, extra?: Record<string, unknown>): void {
    try { this.appendLog({ kind: 'condense-abort', agentId: id, reason, ...(detail ? { detail } : {}), ...extra }); }
    catch { /* 尽力而为 */ }
  }

  // —— 无头 LLM 调用（唯一非确定性的步骤）——

  private async summarize(
    home: string, condensed: string | null, evict: Section[], pinned: string | null
  ): Promise<{ condensed: string; hoist: string[] }> {
    const evictText = evict.map((s) => `${s.heading}\n${s.body}`).join('\n\n').trim();
    const prompt = [
      CONDENSE_SYSTEM,
      '',
      '--- INPUT ---',
      '(A) CURRENT CONDENSED SUMMARY:',
      condensed?.trim() || '(none yet)',
      '',
      '(B) OLDER SECTIONS BEING EVICTED:',
      evictText || '(none)',
      '',
      '(C) PINNED DURABLE FACTS (context only — do not rewrite):',
      pinned?.trim() || '(none)'
    ].join('\n');

    const result = await runHiddenClaude(prompt, {
      model: CONDENSE_MODEL,
      cwd: home,
      command: this.getCommand(),
      // 纯文本变换——绝不能碰仓库或 shell 出去。
      disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'Bash'],
      env: this.getMemoryEnv(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });

    if (!result.ok || !result.text) {
      throw new Error(result.error ?? 'condense: hidden session returned no text');
    }
    const parsed = parseSummary(result.text);
    if (!parsed) throw new Error('condense: response contained no parseable JSON');
    return parsed;
  }
}

// ─── 纯辅助（确定性、可单测的那一半）────────────────────

/** 数二级（`## `）标题——排除 `# ` H1 和 `### ` 更深标题。 */
export function countSections(text: string): number {
  return (text.match(/^##\s/gm) ?? []).length;
}

/** 把 memory.md 拆成头部 + 三段。遗留扁平文件（无 pinned/condensed
 *  标题）解析时这两段为 null、每个 `## ` 小节都在 `recent`；
 *  结构化块在首次压缩时创建。 */
export function parseMemory(text: string): Parsed {
  const lines = text.split('\n');
  let firstSection = lines.findIndex((l) => /^##\s/.test(l));
  if (firstSection === -1) firstSection = lines.length;
  const header = lines.slice(0, firstSection).join('\n').replace(/\s+$/, '');

  // 把剩余行切成 `## ` 小节（标题 + 到下一个 `##` 为止的正文）。
  const sections: Section[] = [];
  let cur: Section | null = null;
  for (let i = firstSection; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) {
      if (cur) sections.push(cur);
      cur = { heading: line, body: '' };
    } else if (cur) {
      cur.body += (cur.body ? '\n' : '') + line;
    }
  }
  if (cur) sections.push(cur);

  let pinned: string | null = null;
  let condensed: string | null = null;
  const recent: Section[] = [];
  for (const s of sections) {
    const h = s.heading.trim();
    if (h.startsWith('## 📌')) pinned = s.body.replace(/\s+$/, '');
    else if (h.startsWith('## 🗜')) condensed = s.body.replace(/\s+$/, '');
    else if (h === RECENT_HEADING) { /* 分隔线——它的兄弟才是 recent 列表 */ }
    else recent.push(s);
  }
  return { header, pinned, condensed, recent };
}

/** pinned 块中非空、修剪过的行（我们绝不能丢的那组）。 */
export function pinnedLines(pinned: string | null): string[] {
  if (!pinned) return [];
  return pinned.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** 把提升出来的持久事实追加进 pinned 集合，跳过已存在的。 */
export function mergePinned(oldLines: string[], hoist: string[]): string[] {
  const have = new Set(oldLines);
  const out = [...oldLines];
  for (const raw of hoist) {
    const line = (raw ?? '').trim();
    if (line && !have.has(line)) { have.add(line); out.push(line); }
  }
  return out;
}

/** 重新组装成规范的 3 段式文件。 */
export function rebuild(header: string, pinned: string[], condensed: string, keep: Section[]): string {
  const parts: string[] = [];
  if (header.trim()) parts.push(header.trim());
  parts.push(PINNED_HEADING);
  parts.push(pinned.length ? pinned.join('\n') : '_(none yet)_');
  parts.push(CONDENSED_HEADING);
  parts.push(condensed.trim());
  parts.push(RECENT_HEADING);
  for (const s of keep) parts.push(`${s.heading}\n${s.body}`.replace(/\s+$/, ''));
  return parts.join('\n\n') + '\n';
}

/** 验证而非信任的门。除非所有检查都通过，否则重写被拒绝——
 *  原文件原样保留。无损备份让一次拒绝成为纯空操作。 */
export function verify(args: {
  rebuilt: string; newBytes: number; oldBytes: number;
  oldPinnedLines: string[]; mergedPinned: string[];
  condensed: string; keep: Section[];
}): { ok: true } | { ok: false; reason: string } {
  const { rebuilt, newBytes, oldBytes, oldPinnedLines, mergedPinned, condensed, keep } = args;
  // 6) 有效的摘要 JSON 已在更上游强制（parseSummary）。这里是：结构。
  // 1) 能解析回 3 段式结构。
  const re = parseMemory(rebuilt);
  if (re.pinned === null || re.condensed === null) return { ok: false, reason: 'structure-missing-region' };
  // 4) 非空且合理。
  if (newBytes <= 200) return { ok: false, reason: 'too-small' };
  if (!condensed.trim()) return { ok: false, reason: 'empty-condensed' };
  // 3) 确实更小（空操作式的压缩是失败）。
  if (!(newBytes < oldBytes * 0.95)) return { ok: false, reason: 'not-smaller' };
  // 2) pinned 保留：旧的每行 pinned 都存活（hoist 只增不减）。
  const newPinned = new Set(pinnedLines(re.pinned));
  for (const line of oldPinnedLines) if (!newPinned.has(line)) return { ok: false, reason: 'pinned-line-dropped' };
  for (const line of mergedPinned) if (!newPinned.has(line)) return { ok: false, reason: 'pinned-merge-mismatch' };
  // 5) recent 完整性：保留的最新小节逐字节往返一致。
  if (re.recent.length !== keep.length) return { ok: false, reason: 'recent-count-mismatch' };
  for (let i = 0; i < keep.length; i++) {
    const a = `${keep[i].heading}\n${keep[i].body}`.replace(/\s+$/, '');
    const b = `${re.recent[i].heading}\n${re.recent[i].body}`.replace(/\s+$/, '');
    if (a !== b) return { ok: false, reason: 'recent-section-altered' };
  }
  return { ok: true };
}

/** 从 `claude -p --output-format json` 输出中取出 `{condensed, hoist}`。
 *  两层：CLI 信封 `{result: "<text>"}`，然后是模型的严格 JSON
 *  （容忍意外的 ```json 围栏）。任何失败返回 null。 */
export function parseSummary(stdout: string): { condensed: string; hoist: string[] } | null {
  const raw = stdout.trim();
  if (!raw) return null;
  let inner = raw;
  try {
    const env = JSON.parse(raw) as { result?: unknown; text?: unknown };
    if (typeof env.result === 'string') inner = env.result;
    else if (typeof env.text === 'string') inner = env.text;
  } catch { /* 不是 CLI 信封——把 stdout 本身当作模型输出 */ }
  inner = inner.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    const obj = JSON.parse(inner) as { condensed?: unknown; hoist?: unknown };
    if (typeof obj.condensed !== 'string' || !obj.condensed.trim()) return null;
    const hoist = Array.isArray(obj.hoist) ? obj.hoist.filter((x): x is string => typeof x === 'string') : [];
    return { condensed: obj.condensed, hoist };
  } catch { return null; }
}

/** `20260606T110912Z` —— 与清理程序备份目录的时间戳格式一致。 */
function utcStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** 把 `text` 原子地写入 `path`：临时同名兄弟 → fsync → rename 覆盖目标。 */
function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp-${Math.random().toString(36).slice(2, 10)}`;
  writeFileSync(tmp, text, 'utf8');
  try {
    const fd = openSync(tmp, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* fsync 尽力而为；rename 才是持久性保证 */ }
  renameSync(tmp, path);
}

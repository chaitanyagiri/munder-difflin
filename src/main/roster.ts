/**
 * 磁盘上的花名册——代理、它们的笔记、工作树路径、已归档和可恢复的条目，
 * 以及停放的邮件队列，以单个 JSON 文件存储在与 hive 相邻的位置。
 *
 * 它为何存在。这是 UI 面板（卡片、笔记、队列、工作树）。
 * hive 身份——id、role、cwd、session——位于 `<harnessHome>/hive/registry.json`，
 * 是代理读取的内容。两者绝不能漂移：这里的 `description` 与注册表的
 * `role` 是同一个持久任务字符串，绝不是实时状态（pause/idle）。
 *
 * 所有这些东西过去只存在于渲染进程的 localStorage 中，
 * 而 localStorage 是按 ORIGIN 分区的。开发运行从
 * `http://localhost:5173` 加载渲染进程，打包构建则从 `file://` 加载，
 * 因此两者永远看不到彼此的存储：在它们之间切换会显示一个空面板、
 * 没有任何笔记，尽管磁盘上的 hive（会话、记忆、收件箱、
 * 任务）明明就在那里且完好无损。以 `harnessHome` 为键的文件对两者
 * 是共享的，因为它按路径而非页面来源寻址。
 *
 * localStorage 仍然完全按原样写入。这个文件是 ADDITION（新增），而不是
 * 对它的迁移——如果这里任何东西失败，渲染进程会回退到它一直使用的
 * 存储，什么都不会丢失。
 *
 * 持久化规则，按重要程度排列：
 *   1. 绝不丢失花名册。每次写入都先把之前的文件复制到
 *      `roster-backups/`，该目录只增不减——里面的内容从不被清理、
 *      覆盖或删除。
 *   2. 绝不写截断的文件。写入先落到临时文件再重命名就位，
 *      因此写入中途崩溃会保留之前的文件原封不动。
 *   3. 绝不让空的渲染进程抹掉完整的花名册。参见 `write`。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 渲染进程镜像到磁盘的内容。内部代理形态在这里刻意保持不透明——渲染进程
 *  的 store 拥有它，重复它意味着每次代理增加字段都要编辑这个文件。
 *  主进程只计数。 */
export interface RosterSnapshot {
  version: 1;
  savedAt: string;
  agents: unknown[];
  archived: unknown[];
  restorable: unknown[];
  queues: Record<string, unknown[]>;
  selectedId: string | null;
}

export interface RosterWriteResult {
  ok: boolean;
  /** 当写入被刻意拒绝时设置；文件未改动。 */
  skipped?: 'empty-first-write';
  error?: string;
}

export function rosterPath(home: string): string {
  return join(home, 'roster.json');
}

export function rosterBackupDir(home: string): string {
  return join(home, 'roster-backups');
}

function isSnapshot(v: unknown): v is RosterSnapshot {
  if (!v || typeof v !== 'object') return false;
  const s = v as Partial<RosterSnapshot>;
  return Array.isArray(s.agents) && Array.isArray(s.archived) && Array.isArray(s.restorable);
}

function entryCount(s: RosterSnapshot): number {
  return s.agents.length + s.archived.length + s.restorable.length;
}

/**
 * 读取和写入一个 home 文件夹的花名册。
 *
 * 用类而非自由函数，是因为空守卫需要知道本次运行是否已写入过，
 * 而模块级标志将是任何测试都无法重置的不可见共享状态。在 `index.ts` 中
 * 每个进程一个实例；测试各自创建。实例存活在 MAIN 中，因此渲染进程
 * 重载会复用它：守卫的状态跨重载存活（2026-08-16 事故是同一运行内
 * 相隔数分钟的两次本应拒绝的写入）并且只在全新启动应用时才重新武装。
 */
export class RosterStore {
  /** 一旦本 store 成功写入即置位。空守卫只在其之前生效：见 `write`。 */
  private wrote = false;
  /** 区分同一毫秒内产生的备份。同一时刻的两次写入过去会产生同名文件，
   *  第二次会静默替换第一次——一个会悄悄丢备份的备份文件夹比没有更糟。 */
  private backupSeq = 0;

  constructor(private readonly getHome: () => string | null) {}

  private home(): string | null {
    try { return this.getHome(); } catch { return null; }
  }

  /** 存储的花名册，或不存在时返回 null（或无法解析）。
   *  null 表示「没有意见」——渲染进程随后继续使用 localStorage，因此
   *  损坏的文件会降级为旧行为，而不是变成空面板。 */
  read(): RosterSnapshot | null {
    const home = this.home();
    if (!home) return null;
    try {
      const p = rosterPath(home);
      if (!existsSync(p)) return null;
      const parsed = JSON.parse(readFileSync(p, 'utf8'));
      return isSnapshot(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * 写入花名册，保留之前的内容作为备份。
   *
   * THE EMPTY-GUARD（空守卫）。危险序列是：第一次打开打包构建，其
   * localStorage 为空（不同来源），store 以零代理启动，第一次镜像写入
   * 就压平了一个存有真实花名册的文件。因此在本次运行落地一次 NON-empty
   * （非空）写入之前，空写入会被拒绝——只有到那时渲染进程才证明它确实
   * 持有一份花名册，而之后的空写入意味着用户真的删除了他们的代理
   * （拒绝这些会让删除变得不可能）。守卫必须扛住一次拒绝：渲染进程重载
   * 过去会重新发送同一份空快照，而因为第一次拒绝解除了守卫，第二次空写入
   * 就通过了并压平了文件（2026-08-16 20:40:03 现场目击）。无论哪种情况，
   * 之前的文件都会被备份，所以即使这里判断错了也是可恢复的。
   */
  write(snap: unknown): RosterWriteResult {
    const home = this.home();
    if (!home) return { ok: false, error: 'no harnessHome' };
    if (!isSnapshot(snap)) return { ok: false, error: 'invalid snapshot' };
    const p = rosterPath(home);
    try {
      mkdirSync(home, { recursive: true });
      const existing = this.read();

      if (!this.wrote && existing && entryCount(existing) > 0 && entryCount(snap) === 0) {
        // 无论如何都备份：磁盘上此刻的内容正是我们要保护的，
        // 复制它不花什么成本。`wrote` 保持 false：守卫只在非空写入
        // 落地时解除，绝不在一次拒绝时解除。
        this.backup(home, p, 'declined');
        console.warn('[roster] refused to overwrite a non-empty roster with an empty one');
        return { ok: false, skipped: 'empty-first-write' };
      }

      this.backup(home, p, this.wrote ? 'write' : 'run-start');

      const body: RosterSnapshot = {
        version: 1,
        savedAt: new Date().toISOString(),
        agents: snap.agents,
        archived: snap.archived,
        restorable: snap.restorable,
        queues: snap.queues && typeof snap.queues === 'object' ? snap.queues : {},
        selectedId: typeof snap.selectedId === 'string' ? snap.selectedId : null
      };
      // 临时文件 + 重命名：`rename` 在同一文件系统内是原子的，因此崩溃
      // 只会留下旧文件或新文件，绝不会留下两者各一半。
      const tmp = `${p}.tmp`;
      writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8');
      renameSync(tmp, p);
      this.wrote = true;
      return { ok: true };
    } catch (e) {
      try { rmSync(`${p}.tmp`, { force: true }); } catch { /* 无操作 */ }
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * 在完全重置期间退役活动花名册：先复制进 `roster-backups/`，
   * 然后删除活动文件。
   *
   * 重置会清空 hive，花名册绝不能留下成为唯一幸存者——否则之后把 home
   * 文件夹指回这里，会显示一屏代理，而它们的会话、记忆和收件箱都已
   * 不存在。归档而非删除，因为花名册永远不会被销毁，只会被取代。
   */
  archive(): void {
    const home = this.home();
    if (!home) return;
    const p = rosterPath(home);
    try {
      if (!existsSync(p)) return;
      this.backup(home, p, 'reset');
      rmSync(p, { force: true });
    } catch { /* 重置绝不能因此失败 */ }
  }

  /** 把当前花名册复制进只增不减的备份文件夹。从不清理：
   *  这些文件是最后一道防线，每次写入几 KB 的价格完全值得。 */
  private backup(home: string, p: string, reason: string): void {
    try {
      if (!existsSync(p)) return;
      const dir = rosterBackupDir(home);
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      this.backupSeq += 1;
      copyFileSync(p, join(dir, `roster-${stamp}-${this.backupSeq}-${reason}.json`));
    } catch { /* 失败的备份绝不能阻塞写入 */ }
  }
}

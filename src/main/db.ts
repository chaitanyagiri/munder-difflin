/**
 * PersistStore —— 基于 SQLite 的持久化 harness 状态（better-sqlite3，同步）。
 *
 * Phase A 范围（其余渲染进程状态暂时仍放在 localStorage）：
 *   - kv:               标量应用状态。目前：主窗口的 bounds。
 *   - command_history:  全新——用户向 agent 提交的每一条提示词。
 *
 * 位于 Electron 主进程（better-sqlite3 是原生 + 同步的）；渲染进程通过 IPC
 * 访问。DB 文件与 config.json 相邻，位于 app.getPath('userData') 下。使用
 * WAL 模式，读取不阻塞唯一的写入者。
 *
 * Schema 通过 PRAGMA user_version 迁移演进：一个有序数组，当 user_version
 * < N+1 时运行迁移 N，然后递增版本。绝不要修改已发布的迁移——只能追加。
 * Phase B/C（agents + message_queue 镜像）以及跨通道 cost_ledger 保留为
 * 未来的增量迁移（见下）；它们刻意不在 v1 中构建。
 */
import Database from 'better-sqlite3';
import { app } from 'electron';
import { join } from 'node:path';

/** 一条捕获的用户提示词，按返回给渲染进程的形式（camelCase 列）。 */
export interface CommandHistoryRow {
  id: number;
  agentId: string;
  cwd: string | null;
  text: string;
  ts: number;
}

/**
 * 有序、只追加的迁移。索引 N 把 DB 从 user_version N 带到 N+1。要演进 schema，
 * 请追加新函数——绝不修改已存在的函数（已发布的 DB 已经运行过它）。
 *
 * FUTURE（不要在 v1 中构建——预留出来，免得这个数组被逼进死角）：
 *   - Phase B：渲染进程 roster/队列的 `agents` + `message_queue` 镜像
 *     （双写），为最终摆脱 localStorage 的权威翻转做准备。
 *   - 跨通道（Lane A #6）：把 Jim 的成本账本迁移到本 DB，让他的熔断器可以
 *     不再轮询 transcript。列名与他 <harnessHome>/hive/cost-ledger.jsonl 的
 *     key 一一对应，便于直接 INSERT…SELECT（与 jim-mq290qkn 于 2026-06-06
 *     协调）：
 *       cost_ledger(id, agent_id, session_id TEXT, ts, input, output,
 *                   cache_read, cache_creation, model TEXT, usd REAL)
 *     行是累计快照（每个 agent 每次心跳一行）——用相邻行做差得到速率；
 *     索引 (agent_id, session_id, ts)。加法迁移，作为后续迁移落地。
 */
const MIGRATIONS: Array<(db: Database.Database) => void> = [
  // → user_version 1（Phase A）：标量 kv + 全新的命令历史。
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,     -- JSON-encoded
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS command_history (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        cwd      TEXT,
        text     TEXT NOT NULL,
        ts       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ch_agent_ts ON command_history(agent_id, ts DESC);
    `);
  }
];

export class PersistStore {
  private db: Database.Database | null = null;

  /** @param dbPath  覆盖 DB 位置（测试用）。默认为 userData/harness.db。 */
  constructor(private dbPath?: string) {}

  /** 打开（必要时创建）并迁移 DB。幂等——第二次调用是空操作。若原生模块
   *  加载失败或文件不可用则抛错；调用方应加防护，避免 DB 故障导致应用
   *  启动崩溃。 */
  open(): void {
    if (this.db) return;
    const path = this.dbPath ?? join(app.getPath('userData'), 'harness.db');
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    this.migrate(db);
    this.db = db;
  }

  private migrate(db: Database.Database): void {
    const version = db.pragma('user_version', { simple: true }) as number;
    for (let i = version; i < MIGRATIONS.length; i++) {
      // 每个迁移及其版本递增都在同一事务中执行，这样迁移中途崩溃
      // 绝不会在错误的版本上留下只应用了一半的 schema。
      const run = db.transaction(() => {
        MIGRATIONS[i](db);
        db.pragma(`user_version = ${i + 1}`);
      });
      run();
    }
  }

  /** 关闭句柄（对 WAL 做 checkpoint）。已关闭时调用也安全。 */
  close(): void {
    try { this.db?.close(); } catch { /* 关闭时尽力而为 */ }
    this.db = null;
  }

  get isOpen(): boolean { return this.db !== null; }

  // ─── kv（标量应用状态）─────────────────────────────────────────────────────

  /** 读取一个 JSON 解码的标量；不存在或无法解析时返回 undefined。 */
  getKv<T = unknown>(key: string): T | undefined {
    if (!this.db) return undefined;
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return undefined;
    try { return JSON.parse(row.value) as T; } catch { return undefined; }
  }

  /** 写入（upsert）一个 JSON 编码的标量。 */
  setKv(key: string, value: unknown): void {
    if (!this.db) return;
    this.db.prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, JSON.stringify(value), Date.now());
  }

  // ─── 命令历史（全新）───────────────────────────────────────────────────────

  /** 记录一条已提交的提示词。空文本或缺少 agent id 会被忽略。 */
  addHistory(entry: { agentId: string; cwd?: string | null; text: string }): void {
    if (!this.db) return;
    const text = (entry.text ?? '').trim();
    if (!text || !entry.agentId) return;
    this.db.prepare('INSERT INTO command_history (agent_id, cwd, text, ts) VALUES (?, ?, ?, ?)')
      .run(entry.agentId, entry.cwd ?? null, text, Date.now());
  }

  /** 最近优先的历史，可选地限定到某个 agent。 */
  listHistory(agentId?: string, limit = 100): CommandHistoryRow[] {
    if (!this.db) return [];
    const lim = clampLimit(limit, 100);
    const rows = agentId
      ? this.db.prepare(
          'SELECT id, agent_id AS agentId, cwd, text, ts FROM command_history WHERE agent_id = ? ORDER BY ts DESC, id DESC LIMIT ?'
        ).all(agentId, lim)
      : this.db.prepare(
          'SELECT id, agent_id AS agentId, cwd, text, ts FROM command_history ORDER BY ts DESC, id DESC LIMIT ?'
        ).all(lim);
    return rows as CommandHistoryRow[];
  }

  /** 对提示词文本做子串搜索，最近优先。 */
  searchHistory(query: string, limit = 50): CommandHistoryRow[] {
    if (!this.db) return [];
    const q = (query ?? '').trim();
    if (!q) return [];
    const lim = clampLimit(limit, 50);
    // 转义 LIKE 通配符，让查询中的字面量 % 或 _ 不再是元字符。
    const needle = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    return this.db.prepare(
      "SELECT id, agent_id AS agentId, cwd, text, ts FROM command_history WHERE text LIKE ? ESCAPE '\\' ORDER BY ts DESC, id DESC LIMIT ?"
    ).all(needle, lim) as CommandHistoryRow[];
  }
}

/** 把不可信的 limit 收敛到 [1, 1000]，带合理的回退。 */
function clampLimit(n: number, fallback: number): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(1000, v);
}

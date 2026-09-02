/**
 * KnowledgeManager —— 文件后端企业知识图谱存储的 Electron 主进程门面。
 * 负责摄取（应用内、经 IPC），并暴露 agent CLI 所用的同一套关键字搜索；
 * agent 自身则经 `resources/kg.cjs` 在进程外查询（见
 * docs/design/knowledge-graph.md）。
 *
 * 所有重活都在纯 JS 的 `kg-core.cjs` sidecar 里（无原生依赖），像
 * `slack.ts` require `slack-trigger.cjs` 那样引入。镜像 MemoryManager 的
 * 表面（`active()` / `env()` / `status()`），以便嵌入现有的
 * spawn 注入流程。
 */
import { app } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig } from './config';

// 纯 JS 核心，构建时复制到 out/main（与 slack-trigger.cjs 相同），并随
// process.resourcesPath 交付给 agent CLI（electron-builder extraResources）。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('./kg-core.cjs') as KgCore;

interface KgMeta {
  id: string; title: string; source: string; modality: string; mime: string | null;
  origExt: string; bytes: number; tags: string[]; caption: string | null;
  chunkCount: number; addedAt: string; extractor: string; truncated: boolean;
}
interface KgHit {
  docId: string; title: string; source: string; modality: string;
  chunkIdx: number; score: number; snippet: string;
}
interface KgIngestInput {
  srcPath?: string; text?: string; title?: string; tags?: string[];
  caption?: string; modality?: string; source?: string;
}
interface KgCore {
  ingest(root: string, input: KgIngestInput): { docId: string; chunkCount: number; meta: KgMeta };
  search(root: string, query: string, opts?: { limit?: number }): KgHit[];
  list(root: string): KgMeta[];
  getDoc(root: string, docId: string): { meta: KgMeta; text: string } | null;
  removeDoc(root: string, docId: string): boolean;
  stats(root: string): { docCount: number; chunkCount: number; byModality: Record<string, number> };
}

export interface KnowledgeStatus {
  enabled: boolean;
  root: string;
  docCount: number;
  chunkCount: number;
  byModality: Record<string, number>;
}

export class KnowledgeManager {
  /** 功能开关是否开启。 */
  active(): boolean {
    return readConfig().knowledgeGraph?.enabled === true;
  }

  /** 存储目录（config 覆盖值或 <userData>/knowledge）。 */
  root(): string {
    const override = readConfig().knowledgeGraph?.rootPath;
    if (override && override.trim()) return override;
    return join(app.getPath('userData'), 'knowledge');
  }

  /** agent CLI 的绝对路径（开发：仓库 resources/；打包后：resourcesPath）。 */
  private cliPath(): string {
    return app.isPackaged
      ? join(process.resourcesPath, 'kg.cjs')
      : join(app.getAppPath(), 'resources', 'kg.cjs');
  }

  /** 供进程外 CLI require 的纯 JS 核心的绝对路径。 */
  private corePath(): string {
    return app.isPackaged
      ? join(process.resourcesPath, 'kg-core.cjs')
      : join(app.getAppPath(), 'src', 'main', 'kg-core.cjs');
  }

  /** 并入每个 agent spawn 的 env，让它的 `kg` CLI 命中本存储。关闭时为空——
   *  因此默认安装不注入任何东西（零行为变化）。 */
  env(): Record<string, string> {
    if (!this.active()) return {};
    return { KG_ROOT: this.root(), KG_CLI: this.cliPath(), KG_CORE: this.corePath() };
  }

  status(): KnowledgeStatus {
    const enabled = this.active();
    const root = this.root();
    const s = enabled && existsSync(root)
      ? core.stats(root)
      : { docCount: 0, chunkCount: 0, byModality: {} };
    return { enabled, root, docCount: s.docCount, chunkCount: s.chunkCount, byModality: s.byModality };
  }

  /** 从磁盘摄取一个文件。关闭时安全地空操作（调用方按 status 把关）。 */
  ingestFile(srcPath: string, opts: { title?: string; tags?: string[]; caption?: string } = {}) {
    return core.ingest(this.root(), { srcPath, ...opts });
  }

  /** 摄取内联文本（例如粘贴的内容）。 */
  ingestText(text: string, opts: { title?: string; tags?: string[] } = {}) {
    return core.ingest(this.root(), { text, ...opts });
  }

  search(query: string, limit?: number): KgHit[] {
    if (!existsSync(this.root())) return [];
    return core.search(this.root(), query, { limit });
  }

  list(): KgMeta[] {
    if (!existsSync(this.root())) return [];
    return core.list(this.root());
  }

  get(docId: string): { meta: KgMeta; text: string } | null {
    return core.getDoc(this.root(), docId);
  }

  remove(docId: string): boolean {
    return core.removeDoc(this.root(), docId);
  }
}

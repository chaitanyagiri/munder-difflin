/**
 * 磁盘上的触发台账——webhook 或对等节点的克隆节点推给我们的每一条入站
 * 消息，以及我们发回的每一条回复。
 *
 * 它住在自己的文件里而不是 config.json，原因有二：它高度追加
 * （config.json 每次 `writeConfig` 都会整块重写，里面的数组越长，
 * 每次无关的设置写入就越贵）；而且它是可丢弃的——丢历史绝不能
 * 连累用户的设置。结构上跟随 config.ts：同步 fs、写时 mkdirSync、
 * 以及围绕每次磁盘触碰的 try/catch，失败时降级为空台账。
 * 这里不会向调用方抛异常，因为调用方总在请求路径上，
 * “记录事件”的失败绝不能拖垮事件本身。
 *
 * 安全——绝不要把机密、API key 或 token 写进条目。台账是 userData 里的
 * 明文 JSON，并在 UI 中原样呈现，所以 webhook 密钥或 org apiKey 落到这里
 * 就是对活凭据的持久泄漏。因此下面的条目是逐字段构建的，
 * 而不是展开调用方的对象：即使调用方递给我们一个完整的
 * `WebhookTrigger`（携带着 `secret`），也只有台账字段被持久化。
 */
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  TRIGGER_HISTORY_LIMIT,
  type InboundKind,
  type TriggerHistoryEntry
} from '../shared/triggers';

/** 调用方必须提供的内容；`id` 和 `at` 会替它们盖章，除非调用方
 *  自带（重放/重建的条目保留其身份）。 */
export type TriggerHistoryInput =
  Omit<TriggerHistoryEntry, 'id' | 'at'> & { id?: string; at?: number };

/** 事后只有这些可以被修改。台账精神上是只追加的：条目的来源、方向
 *  和正文是对已发生之事的记录，不可重写——可变的部分是操作员对它的
 *  裁决。 */
export type TriggerHistoryPatch = Partial<
  Pick<TriggerHistoryEntry, 'decision' | 'taskId' | 'correlationId' | 'title'>
>;

function historyPath(): string {
  return join(app.getPath('userData'), 'trigger-history.json');
}

/** 磁盘上和内存里都是最新在前。`listTriggerHistory` 是热路径（UI 每次
 *  渲染 Triggers 标签页都会重读），上限在每次追加时强制，所以让文件
 *  保持显示顺序，使两者都是切片而不是排序。 */
function readAll(): TriggerHistoryEntry[] {
  const p = historyPath();
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry);
  } catch {
    return [];
  }
}

function writeAll(entries: TriggerHistoryEntry[]): void {
  try {
    const p = historyPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(entries, null, 2), 'utf8');
  } catch { /* 尽力而为；台账写入绝不能拖垮它所记录的事件 */ }
}

/** 对单条持久化行的结构守卫。手改过或写了一半的文件只丢弃坏行，
 *  而不是整本台账。 */
function isEntry(v: unknown): v is TriggerHistoryEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Partial<TriggerHistoryEntry>;
  return typeof e.id === 'string'
    && (e.source === 'webhook' || e.source === 'org')
    && (e.direction === 'inbound' || e.direction === 'outbound')
    && typeof e.body === 'string'
    && typeof e.at === 'number';
}

function normaliseKind(kind: unknown): InboundKind {
  return kind === 'communication' ? 'communication' : 'directive';
}

/**
 * 记录一个事件并返回持久化后的行（调用方通常需要生成的 `id`，
 * 以便稍后翻转某个 `pending` 裁决）。
 *
 * 返回的条目就是落盘的条目，所以调用方永远不用猜
 * 自己的输入是如何被归一化的。
 */
export function appendTriggerHistory(input: TriggerHistoryInput): TriggerHistoryEntry {
  // 显式字段列表——见本文件顶部的安全说明。
  const entry: TriggerHistoryEntry = {
    id: input.id ?? randomBytes(8).toString('hex'),
    source: input.source,
    sourceId: input.sourceId,
    sourceName: input.sourceName,
    direction: input.direction,
    peer: input.peer,
    title: input.title,
    body: input.body,
    kind: normaliseKind(input.kind),
    decision: input.decision,
    correlationId: input.correlationId,
    taskId: input.taskId,
    at: input.at ?? Date.now()
  };
  writeAll([entry, ...readAll()].slice(0, TRIGGER_HISTORY_LIMIT));
  return entry;
}

/** 整本台账，最新在前。 */
export function listTriggerHistory(): TriggerHistoryEntry[] {
  return readAll();
}

/**
 * 修改一个条目的裁决——操作员答复严格模式消息时的
 * `pending` → `approved`/`rejected` 转换，外加批准所派生的东西的 `taskId`。
 * id 已消失时返回 null，这是正常结果：条目可能在操作员决策期间
 * 已经老过 TRIGGER_HISTORY_LIMIT，那不值得为一个错误抛异常。
 */
export function updateTriggerHistory(
  id: string,
  patch: TriggerHistoryPatch
): TriggerHistoryEntry | null {
  const all = readAll();
  const i = all.findIndex((e) => e.id === id);
  if (i < 0) return null;
  const next: TriggerHistoryEntry = { ...all[i] };
  if (patch.decision !== undefined) next.decision = patch.decision;
  if (patch.taskId !== undefined) next.taskId = patch.taskId;
  if (patch.correlationId !== undefined) next.correlationId = patch.correlationId;
  if (patch.title !== undefined) next.title = patch.title;
  all[i] = next;
  writeAll(all);
  return next;
}

/** 清空台账，或只清某个来源的那一半（清 webhook 噪音不应丢掉
 *  org 对话，反之亦然）。全清时直接删文件，
 *  避免一个过期却不可读的文件留存。 */
export function clearTriggerHistory(source?: 'webhook' | 'org'): void {
  if (!source) {
    try { rmSync(historyPath(), { force: true }); } catch { /* 尽力而为 */ }
    return;
  }
  writeAll(readAll().filter((e) => e.source !== source));
}

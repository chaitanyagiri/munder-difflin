/**
 * 对任务台账（`hive/tasks.json`）的非破坏性编辑。
 *
 * 台账是手工编写的文件：god 会追加一张卡片需要的任何字段——
 * `result`（原样发回给用户的 Slack 回复）、`repo`、`scope`、`origin`、
 * `deliverable`、`commit`、`blockedOn`、`notes`——renderer 的显示模型
 * 对这些一无所知。多个 UI 面在小型编辑后会把台账写回（回答问题、
 * 移动卡片、关闭一张），而 `hive:writeTasks` 会整体替换该文件。因此
 * 任何持有卡片部分模型的写入者，在用户触碰其中一张卡片的瞬间，
 * 都会静默地删掉它不知道的每一个字段——
 * 而且是在看板上每一张卡片上。
 *
 * 两条规则解决这个问题，且都写在这里，让 main 与 renderer 共享：
 *
 *   - `mergeTaskLedger` —— 持久化侧的兜底。写入者未完整描述的卡片
 *     会保留磁盘上已有的字段。
 *   - `patchTaskInLedger` —— 调用侧规则。编辑台账的 RAW 条目，
 *     而不是重新序列化显示模型，这样规范化解析器就无法覆盖它强转过的字段
 *     （字符串 `priority` 被重新输出为数字）。
 *
 * 删除仍然刻意生效：入站列表中缺失的卡片即被移除。
 * 合并保护的是字段，绝不是卡片的成员资格。
 */

/** 一条磁盘上原始台账条目的样子——一个未知字段的对象。 */
type RawTask = Record<string, unknown>;

function isRawTask(value: unknown): value is RawTask {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function idOf(value: unknown): string | null {
  if (!isRawTask(value)) return null;
  return typeof value.id === 'string' && value.id ? value.id : null;
}

/**
 * 把 `incoming` 折叠到 `existing` 上，按 `id` 匹配卡片。
 *
 * 结果是 `incoming`——它的顺序、它的成员资格，因此从列表中移除一张
 * 卡片仍然会删除它。在折叠中存活下来的是匹配的磁盘卡片上
 * `incoming` 未提及的字段。
 *
 * 调用方确实发送的字段获胜，包括显式的 `null`——
 * 那是清空某个字段的方式。浅合并无法表达"删除这个键"，也不应该：
 * 这里的写入者是部分模型，因此缺失的键意味着"我不知道这个"，
 * 绝不是"删掉它"。
 *
 * 没有字符串 `id` 的条目（god 手写出的畸形卡片）原样通过——
 * 没有键可供合并，丢弃它们会丢失
 * 本函数要防止的同一类数据。
 */
export function mergeTaskLedger(existing: unknown, incoming: unknown): unknown[] {
  const incomingList = Array.isArray(incoming) ? incoming : [];
  const existingList = Array.isArray(existing) ? existing : [];
  const byId = new Map<string, RawTask>();
  for (const entry of existingList) {
    const id = idOf(entry);
    if (id && !byId.has(id)) byId.set(id, entry as RawTask);
  }
  return incomingList.map((entry) => {
    const id = idOf(entry);
    if (!id) return entry;
    const prior = byId.get(id);
    return prior ? { ...prior, ...(entry as RawTask) } : entry;
  });
}

/**
 * 把 `patch` 应用到 RAW 台账数组中的一张卡片上，让其他每张卡片——
 * 以及被打补丁卡片的其他每个字段——都保持逐字节不变。
 *
 * 这才是 UI 编辑应该写入的东西。改为重新序列化显示模型，会喂给台账
 * 一张规范化卡片：`parseTasks` 会把手工写的 `priority: "high"` 强转为
 * 数字 `3`，并对拼写为 `deps` 键的卡片重新输出 `dependsOn: []`，而这些
 * 强转是真实的值，所以它们能压过 `mergeTaskLedger` 并落到磁盘。补丁
 * 原始条目则从一开始就不会产生它们。
 */
export function patchTaskInLedger(
  rawTasks: unknown,
  id: string,
  patch: Record<string, unknown>
): unknown[] {
  const list = Array.isArray(rawTasks) ? rawTasks : [];
  return list.map((entry) => (idOf(entry) === id ? { ...(entry as RawTask), ...patch } : entry));
}

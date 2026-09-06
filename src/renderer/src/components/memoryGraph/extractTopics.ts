// 记忆图的主题提取——纯函数、无依赖、客户端本地完成。
//
// 代理的 memory.md 文件是结构化的 markdown：带日期的 `## <date> — <title>`
// 小节标题、`**bold**` 关键词、无序列表。我们从标题 + 加粗片段中抽取候选主题
// 短语，进行规范化，只保留被 >= 2 个不同代理提到的那些（共享知识才是有趣的
// 信号；某个代理的私人笔记不是 hive 级别的「主题」）。参见 MEMORY_GRAPH_SPEC.md §5。
//
// 这刻意是启发式的，不是语义式的——MemPalace（searchMemory）负责语义侧，
// 并且按查询返回排名的片段，而不是一个可枚举的集合。

export interface Topic {
  /** 稳定的节点 id，例如 "topic:landing page redesign" */
  id: string;
  /** 面向人类显示的标签（首次出现时的原始大小写） */
  label: string;
  /** 记忆里提到过这个主题的代理的 id */
  agentIds: string[];
  /** = agentIds.length；有多少代理共享它 */
  weight: number;
}

export interface TopicResult {
  /** 主题按 weight 降序、再按 label 排序——已按 `max` 封顶 */
  topics: Topic[];
  /** 达到上限之前符合条件的主题总数（weight >= 2） */
  total: number;
}

// 会作为标题或加粗出现、但并非真正主题的通用词/短语。
const STOP = new Set([
  'update', 'updates', 'done', 'note', 'notes', 'next', 'open', 'todo', 'todos',
  'fixed', 'resolved', 'wip', 'status', 'context', 'memory', 'summary', 'decision',
  'decisions', 'plan', 'plans', 'task', 'tasks', 'phase 1', 'phase 2', 'phase',
  'why', 'how', 'what', 'gap', 'gaps', 'needed', 'open / next', 'important', 'fact', 'facts'
]);

/** 去掉标题尾部开头的 `YYYY-MM-DD —`/`-`/`:` 日期前缀。 */
function stripDatePrefix(s: string): string {
  return s.replace(/^\s*\d{4}-\d{2}-\d{2}\s*[—\-:·]*\s*/, '');
}

/** 转小写、压缩空白、去掉周围的标记/标点。 */
function normalise(raw: string): string {
  return raw
    .replace(/[`*_~]/g, '')           // 去掉内联 md 标记
    .replace(/\(.*?\)/g, '')          // 去掉括号内容
    .replace(/[#:.,;!?]+$/g, '')      // 尾部标点
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 从一个记忆文件的 markdown 中抽取原始候选短语。 */
function candidatesFrom(markdown: string): string[] {
  const out: string[] = [];
  for (const line of markdown.split('\n')) {
    const heading = line.match(/^#{2,4}\s+(.+?)\s*$/);
    if (heading) out.push(stripDatePrefix(heading[1]));
    for (const m of line.matchAll(/\*\*(.+?)\*\*/g)) out.push(stripDatePrefix(m[1]));
  }
  return out;
}

function isUsable(norm: string): boolean {
  if (norm.length < 3 || norm.length > 40) return false;
  if (STOP.has(norm)) return false;
  if (/^[\d\s\-—.]+$/.test(norm)) return false;   // 纯数字/日期
  if (!/[a-z]/.test(norm)) return false;          // 必须包含字母
  return true;
}

/**
 * 构建所有代理记忆文件中的共享主题集合。
 * @param memories agentId -> 原始 memory.md 文本
 * @param max      返回主题的上限（默认 24，按规范）
 */
export function extractTopics(memories: Record<string, string>, max = 24): TopicResult {
  // 规范化主题 -> { 显示标签, 代理 id 集合 }
  const acc = new Map<string, { label: string; agents: Set<string> }>();

  for (const [agentId, text] of Object.entries(memories)) {
    if (!text) continue;
    const seenThisAgent = new Set<string>();
    for (const cand of candidatesFrom(text)) {
      const norm = normalise(cand);
      if (!isUsable(norm) || seenThisAgent.has(norm)) continue;
      seenThisAgent.add(norm);
      const entry = acc.get(norm);
      if (entry) entry.agents.add(agentId);
      else acc.set(norm, { label: cand.replace(/[`*_]/g, '').trim(), agents: new Set([agentId]) });
    }
  }

  const all: Topic[] = [];
  for (const [norm, { label, agents }] of acc) {
    if (agents.size < 2) continue;
    all.push({ id: `topic:${norm}`, label, agentIds: [...agents], weight: agents.size });
  }
  all.sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label));

  return { topics: all.slice(0, max), total: all.length };
}

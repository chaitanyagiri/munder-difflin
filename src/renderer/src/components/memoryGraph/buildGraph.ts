// 从现有 hive 数据构建记忆图模型——无需新的 IPC。
// 输入直接来自 preload 桥 / store：
//   - agents:   useStore(s => s.agents)
//   - log:      window.cth.hiveLog(200)   （我们读取 kind:'message' 条目）
//   - memories: window.cth.hiveMemory(id) 每个代理各一次（仅当主题开启时）
// 参见 MEMORY_GRAPH_SPEC.md §3–§5。

import type { AccentColorName } from '@/design/tokens';
import type { StatusKind } from '@/components/PixelBadge';
import type { MessageAct } from '@/scene/office/MessageEnvelope';
import { extractTopics } from './extractTopics';

export interface AgentNode {
  kind: 'agent';
  id: string;
  label: string;
  accent: AccentColorName;
  status: StatusKind;
  isGod: boolean;
  /** 触及该代理的消息边数量（驱动节点大小） */
  degree: number;
}
export interface TopicNode {
  kind: 'topic';
  id: string;
  label: string;
  /** 有多少代理共享这个主题 */
  weight: number;
}
export interface PseudoNode {
  kind: 'pseudo';
  id: 'broadcast' | 'human';
  label: string;
}
export type GraphNode = AgentNode | TopicNode | PseudoNode;

export interface GraphEdge {
  id: string;
  kind: 'message' | 'topic';
  source: string;
  target: string;
  /** message：该对之间的消息数；topic：1 */
  weight: number;
  /** 仅 message 边——该对之间流量的方向 */
  dir?: 'fwd' | 'bwd' | 'both';
  lastAct?: MessageAct;
  lastSubject?: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** 实际显示的主题 */
  topicShown: number;
  /** 符合条件的主题总数（用于「显示 N / 共 M」的上限提示） */
  topicTotal: number;
}

/** 我们所依赖的最小形态（保持宽松——hiveLog 是弱类型）。 */
export interface MinimalAgent {
  id: string;
  name: string;
  accent: AccentColorName;
  status: StatusKind;
  isGod?: boolean;
}
export interface MessageLogEntry {
  ts?: number;
  kind?: string;
  from?: string;
  to?: string;
  act?: MessageAct;
  subject?: string;
  [k: string]: unknown;
}

export interface BuildOpts {
  showTopics?: boolean;
  memories?: Record<string, string>;
  maxTopics?: number;
}

function sortedPairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/**
 * 组装节点 + 边。代理 + 消息层总是构建；只有当 `showTopics` 开启且提供了
 * `memories` 时才添加主题层。
 */
export function buildGraph(
  agents: MinimalAgent[],
  log: MessageLogEntry[],
  opts: BuildOpts = {}
): GraphData {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const degree = new Map<string, number>();

  // ── 消息边：按无序对聚合，记住方向 + 最新一条 ─
  interface PairAcc {
    a: string; b: string;            // a < b
    fwd: number; bwd: number;        // a->b、b->a 计数
    lastTs: number; lastAct?: MessageAct; lastSubject?: string;
  }
  const pairs = new Map<string, PairAcc>();
  const pseudoUsed = new Set<'broadcast' | 'human'>();

  const resolve = (ep?: string): string | null => {
    if (!ep) return null;
    if (byId.has(ep)) return ep;
    if (ep === 'broadcast') { pseudoUsed.add('broadcast'); return 'broadcast'; }
    if (ep === 'human') { pseudoUsed.add('human'); return 'human'; }
    return null; // 未知 id——防御性跳过
  };

  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    if (e.kind !== 'message') continue;
    const from = resolve(e.from);
    const to = resolve(e.to);
    if (!from || !to || from === to) continue;

    const key = sortedPairKey(from, to);
    const ts = typeof e.ts === 'number' ? e.ts : i; // 回退到日志顺序
    let p = pairs.get(key);
    if (!p) {
      const [a, b] = from < to ? [from, to] : [to, from];
      p = { a, b, fwd: 0, bwd: 0, lastTs: -1 };
      pairs.set(key, p);
    }
    if (from === p.a) p.fwd++; else p.bwd++;
    if (ts >= p.lastTs) { p.lastTs = ts; p.lastAct = e.act; p.lastSubject = e.subject; }

    // degree 只统计代理（伪节点不参与大小计算）
    if (byId.has(from)) degree.set(from, (degree.get(from) ?? 0) + 1);
    if (byId.has(to)) degree.set(to, (degree.get(to) ?? 0) + 1);
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // 代理节点——只包含实际出现的，外加 god，以免出现孤立的小圆点。
  // 我们包含名册中的每个代理，让地面被完整呈现。
  for (const a of agents) {
    nodes.push({
      kind: 'agent',
      id: a.id,
      label: a.name,
      accent: a.accent,
      status: a.status,
      isGod: !!a.isGod,
      degree: degree.get(a.id) ?? 0
    });
  }
  if (pseudoUsed.has('broadcast')) nodes.push({ kind: 'pseudo', id: 'broadcast', label: 'broadcast' });
  if (pseudoUsed.has('human')) nodes.push({ kind: 'pseudo', id: 'human', label: 'human' });

  for (const p of pairs.values()) {
    const dir: GraphEdge['dir'] = p.fwd && p.bwd ? 'both' : p.fwd ? 'fwd' : 'bwd';
    edges.push({
      id: `message:${p.a}\u0000${p.b}`,
      kind: 'message',
      source: p.a,
      target: p.b,
      weight: p.fwd + p.bwd,
      dir,
      lastAct: p.lastAct,
      lastSubject: p.lastSubject
    });
  }

  // ── 主题层（可选）────────────────────────────────────────────────────
  let topicShown = 0;
  let topicTotal = 0;
  if (opts.showTopics && opts.memories) {
    const { topics, total } = extractTopics(opts.memories, opts.maxTopics ?? 24);
    topicTotal = total;
    topicShown = topics.length;
    for (const t of topics) {
      nodes.push({ kind: 'topic', id: t.id, label: t.label, weight: t.weight });
      for (const agentId of t.agentIds) {
        if (!byId.has(agentId)) continue;
        edges.push({ id: `topic:${agentId}\u0000${t.id}`, kind: 'topic', source: agentId, target: t.id, weight: 1 });
      }
    }
  }

  return { nodes, edges, topicShown, topicTotal };
}

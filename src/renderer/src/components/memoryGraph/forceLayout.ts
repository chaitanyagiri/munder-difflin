// 微型确定性力导向布局——带轻微向心引力的 Fruchterman–Reingold。
// 无依赖（d3-force 不在 node_modules 中，项目保持依赖精简）；对于 < 100 个节点，
// 固定迭代次的积分器绰绰有余。参见 MEMORY_GRAPH_SPEC.md §6。
//
// 确定性：节点按索引布置在向日葵（phyllotaxis）螺旋上（无 Math.random），
// 因此图不会在两次轮询之间重新洗牌。被钉住的节点（拖动过）保持固定，
// 其余节点围绕它们松弛下来。

export interface LayoutNode {
  id: string;
  /** 额外的向心拉力倍数（god 被当作枢纽） */
  gravityBias?: number;
}
export interface LayoutEdge {
  source: string;
  target: string;
  /** 弹簧强度倍数（topic 边拉得更弱） */
  strength?: number;
}
export interface LayoutOpts {
  width: number;
  height: number;
  /** 被拖动/钉住的节点的固定位置 */
  pinned?: Record<string, { x: number; y: number }>;
  iterations?: number;
  padding?: number;
}

export type Positions = Map<string, { x: number; y: number }>;

const GOLDEN_ANGLE = 2.399963229728653; // 弧度

/** 确定性种子：以帧为中心的向日葵螺旋。 */
function seed(ids: string[], cx: number, cy: number, radius: number): Positions {
  const pos: Positions = new Map();
  const n = Math.max(1, ids.length);
  ids.forEach((id, i) => {
    const r = radius * Math.sqrt((i + 0.5) / n);
    const a = i * GOLDEN_ANGLE;
    pos.set(id, { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  });
  return pos;
}

export function forceLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  opts: LayoutOpts
): Positions {
  const { width, height } = opts;
  const padding = opts.padding ?? 28;
  const iterations = opts.iterations ?? 320;
  const pinned = opts.pinned ?? {};

  const ids = nodes.map((n) => n.id);
  const cx = width / 2;
  const cy = height / 2;
  const usableR = Math.max(40, Math.min(width, height) / 2 - padding);
  const pos = seed(ids, cx, cy, usableR);

  // 从一开始就尊重钉住的位置
  for (const id of ids) if (pinned[id]) pos.set(id, { ...pinned[id] });

  if (ids.length <= 1) return pos;

  // Fruchterman–Reingold 理想边长，缩小一些以便给标签留空间。
  const area = width * height;
  const k = Math.sqrt(area / ids.length) * 0.55;
  const k2 = k * k;
  const gravity = 0.045;

  const biasById = new Map(nodes.map((n) => [n.id, n.gravityBias ?? 1]));
  const disp = new Map<string, { x: number; y: number }>(ids.map((id) => [id, { x: 0, y: 0 }]));

  let temp = Math.min(width, height) * 0.12;
  const cool = Math.pow(0.02, 1 / iterations); // 结束时温度 → 约为起始的 2%

  for (let it = 0; it < iterations; it++) {
    for (const id of ids) { const d = disp.get(id)!; d.x = 0; d.y = 0; }

    // 斥力——每对都相互推开（O(n²)，这个规模下没问题）
    for (let i = 0; i < ids.length; i++) {
      const pi = pos.get(ids[i])!;
      const di = disp.get(ids[i])!;
      for (let j = i + 1; j < ids.length; j++) {
        const pj = pos.get(ids[j])!;
        let dx = pi.x - pj.x;
        let dy = pi.y - pj.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) { dx = (i - j) * 0.01 + 0.01; dy = 0.01; dist = Math.hypot(dx, dy); }
        const force = k2 / dist;
        const ux = dx / dist;
        const uy = dy / dist;
        di.x += ux * force; di.y += uy * force;
        const dj = disp.get(ids[j])!;
        dj.x -= ux * force; dj.y -= uy * force;
      }
    }

    // 引力——边把两端拉到一起
    for (const e of edges) {
      const ps = pos.get(e.source);
      const pt = pos.get(e.target);
      if (!ps || !pt) continue;
      const dx = ps.x - pt.x;
      const dy = ps.y - pt.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const force = (dist * dist) / k * (e.strength ?? 1);
      const ux = dx / dist;
      const uy = dy / dist;
      const ds = disp.get(e.source)!;
      const dt = disp.get(e.target)!;
      ds.x -= ux * force; ds.y -= uy * force;
      dt.x += ux * force; dt.y += uy * force;
    }

    // 轻微的向心引力让断开的节点保持在屏幕内
    for (const id of ids) {
      const p = pos.get(id)!;
      const d = disp.get(id)!;
      const g = gravity * (biasById.get(id) ?? 1);
      d.x += (cx - p.x) * g;
      d.y += (cy - p.y) * g;
    }

    // 积分（跳过钉住的），按温度钳制位移，保持在帧内
    for (const id of ids) {
      if (pinned[id]) { pos.set(id, { ...pinned[id] }); continue; }
      const p = pos.get(id)!;
      const d = disp.get(id)!;
      const len = Math.hypot(d.x, d.y) || 0.01;
      const step = Math.min(len, temp);
      p.x += (d.x / len) * step;
      p.y += (d.y / len) * step;
      p.x = Math.max(padding, Math.min(width - padding, p.x));
      p.y = Math.max(padding, Math.min(height - padding, p.y));
    }

    temp *= cool;
  }

  return pos;
}

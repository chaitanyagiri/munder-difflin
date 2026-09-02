// 把提交列表排布成泳道，供左侧图形轨道使用。
// 我们不打算精确复刻 `git log --graph`——而是自上而下遍历提交，把每个提交
// 分配到最靠左的空闲泳道，并画上到其父提交（位于它们各自泳道）的连接。

export interface CommitInput {
  sha: string;
  parents: string[];
}

export interface CommitLayout {
  sha: string;
  /** 该提交的小圆点所在的泳道 */
  lane: number;
  /** 父提交及其所在的泳道（若不在窗口内则为 -1） */
  parents: Array<{ sha: string; lane: number }>;
}

export interface GraphLayout {
  rows: CommitLayout[];
  /** 用到的最大泳道索引 */
  maxLane: number;
}

export function layoutGraph(commits: CommitInput[]): GraphLayout {
  // `lanes[i]` = 泳道 i 目前「期待」作为下一个提交的 sha，或 undefined
  const lanes: (string | undefined)[] = [];
  const rows: CommitLayout[] = [];
  let maxLane = 0;

  // 一开始没有任何期待；提交引入父提交时泳道才会被填充。
  for (const c of commits) {
    // 为这个提交挑选泳道
    let lane = lanes.findIndex(s => s === c.sha);
    if (lane === -1) {
      // 没有后代；在忙碌区域的右侧分配一条新泳道
      lane = lanes.findIndex(s => s === undefined);
      if (lane === -1) { lane = lanes.length; lanes.push(c.sha); }
      else lanes[lane] = c.sha;
    }
    // 提交占据 `lane`；它的父提交会继续留在泳道中。
    // 第一个父提交留在我们的泳道；其余父提交去往新泳道。
    const parents: CommitLayout['parents'] = [];
    if (c.parents.length === 0) {
      lanes[lane] = undefined;
    } else {
      for (let i = 0; i < c.parents.length; i++) {
        const p = c.parents[i];
        if (i === 0) {
          lanes[lane] = p;
          parents.push({ sha: p, lane });
        } else {
          // 放到新泳道（最靠左的空闲泳道）
          let pl = lanes.findIndex(s => s === undefined);
          if (pl === -1) { pl = lanes.length; lanes.push(p); }
          else lanes[pl] = p;
          parents.push({ sha: p, lane: pl });
        }
      }
    }
    // 压缩：去掉尾部的 undefined 泳道
    while (lanes.length > 0 && lanes[lanes.length - 1] === undefined) lanes.pop();

    rows.push({ sha: c.sha, lane, parents });
    if (lane > maxLane) maxLane = lane;
    for (const p of parents) if (p.lane > maxLane) maxLane = p.lane;
  }
  return { rows, maxLane };
}

// 轨道每条泳道的颜色循环
export const LANE_COLORS = [
  'var(--cth-sky)',
  'var(--cth-lemon)',
  'var(--cth-mint)',
  'var(--cth-coral)',
  'var(--cth-lilac)',
  'var(--cth-peach)'
];

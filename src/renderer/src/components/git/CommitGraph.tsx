import { useMemo } from 'react';
import { layoutGraph, LANE_COLORS } from './graph';

/**
 * 提交历史——泳道轨道 + 每个提交一行。
 *
 * 为什么是手写的。过去通过 `commit-graph` npm 包渲染，但那个包无法塞进可
 * 调整大小的侧栏：
 *
 *   - 它把每个提交行 ABSOLUTE 定位在硬编码的 `height: 4rem` 上，与它用来
 *     布局图的 `commitSpacing` 无关，所以任何紧凑间距都会让相邻行重叠；
 *   - 无论实际空间有多少，它都给图形 SVG 预留固定的 `max-width: 500px`，
 *     所以在窄面板里文本被挤进剩余空间、换行、再次碰撞；
 *   - 它的类名带构建哈希，所以修正这些问题所需的 CSS 只能子串匹配，
 *     版本一升就坏；
 *   - 而且它从不显示提交的 SUBJECT——这是任何人看历史时真正会读的那个字段。
 *
 * ./graph.ts 中的泳道算法本来就是为这个写的，一直闲置着。这里的行固定高度、
 * 单行文本，轨道根据实际使用的泳道确定尺寸，轨道之外都是普通 flex——
 * 所以它从 240px 侧栏到全宽面板都能保持可读。
 */

interface CommitLite {
  sha: string;
  shortSha: string;
  parents: string[];
  subject: string;
  author: string;
  time: number;
  refs: string[];
}

export interface CommitGraphProps {
  commits: CommitLite[];
  /** 当前检出的分支名，用于高亮。 */
  currentBranch?: string | null;
  /** v0.3.4：点击提交 → 在 IDE HISTORY 面板中显示每个提交的文件列表 / diff。 */
  onCommitClick?: (sha: string) => void;
}

/** 一行 12px 文本加上呼吸空间。 */
const ROW_H = 24;
/** 泳道之间的水平间距。 */
const LANE_W = 13;
/** 超过这个数量的泳道会被钳制到最后一格：轨道是寻路辅助，让 12 路合并把主题
 *  挤出屏幕，是用装饰品换掉正在读的东西。 */
const MAX_LANES = 6;
const DOT_R = 3.5;
/** 线条跨泳道时的圆角半径。 */
const BEND = 8;

function relTime(ms: number): string {
  const delta = Math.max(0, Date.now() / 1000 - ms / 1000);
  if (delta < 60) return `${Math.round(delta)}s`;
  if (delta < 3600) return `${Math.round(delta / 60)}m`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h`;
  if (delta < 86400 * 30) return `${Math.round(delta / 86400)}d`;
  return `${Math.round(delta / (86400 * 30))}mo`;
}

/** 把 git 的装饰噪音裁成适合芯片展示的样子。 */
function cleanRefs(refs: string[]): string[] {
  const out: string[] = [];
  for (const raw of refs) {
    const name = raw.replace('HEAD ->', '').replace('tag:', '').trim();
    if (!name || name === 'HEAD') continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

export function CommitGraph({ commits, currentBranch, onCommitClick }: CommitGraphProps) {
  const { rows, railW, rowIndex } = useMemo(() => {
    const layout = layoutGraph(commits.map((c) => ({ sha: c.sha, parents: c.parents })));
    const idx = new Map<string, number>();
    commits.forEach((c, i) => idx.set(c.sha, i));
    const lanes = Math.min(layout.maxLane, MAX_LANES - 1) + 1;
    return {
      rows: layout.rows,
      railW: lanes * LANE_W + 8,
      rowIndex: idx
    };
  }, [commits]);

  if (commits.length === 0) return null;

  const laneX = (lane: number): number => Math.min(lane, MAX_LANES - 1) * LANE_W + LANE_W / 2 + 4;
  const rowY = (i: number): number => i * ROW_H + ROW_H / 2;
  const height = commits.length * ROW_H;

  return (
    <div className="cth-commit-graph" style={{ position: 'relative', minWidth: 0 }}>
      {/* 轨道只是装饰：绝对定位且对指针透明，因此
          它永远不会拦截行点击，也不会贡献布局宽度。 */}
      <svg
        width={railW}
        height={height}
        style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}
        aria-hidden
      >
        {rows.map((r, i) => {
          const x1 = laneX(r.lane);
          const y1 = rowY(i);
          return r.parents.map((p) => {
            const j = rowIndex.get(p.sha);
            const color = LANE_COLORS[Math.min(p.lane, MAX_LANES - 1) % LANE_COLORS.length];
            // 父提交在已拉取的窗口之外：把线一直画到底边，而不是丢掉它，
            // 这样泳道不会凭空断在半空中。
            if (j === undefined) {
              return (
                <path
                  key={`${r.sha}-${p.sha}`}
                  d={`M ${x1} ${y1} L ${x1} ${height}`}
                  stroke={color} strokeWidth={1.5} fill="none" opacity={0.5}
                />
              );
            }
            const x2 = laneX(p.lane);
            const y2 = rowY(j);
            const d = x1 === x2
              ? `M ${x1} ${y1} L ${x2} ${y2}`
              // 沿子提交的泳道笔直向下，然后四分之一转向进入父提交——
              // 这是 git 图形应有的形状。
              : `M ${x1} ${y1} L ${x1} ${y2 - BEND} Q ${x1} ${y2} ${x2} ${y2}`;
            return (
              <path
                key={`${r.sha}-${p.sha}`}
                d={d}
                stroke={color} strokeWidth={1.5} fill="none"
              />
            );
          });
        })}
        {rows.map((r, i) => (
          <circle
            key={r.sha}
            cx={laneX(r.lane)}
            cy={rowY(i)}
            r={DOT_R}
            fill={LANE_COLORS[Math.min(r.lane, MAX_LANES - 1) % LANE_COLORS.length]}
            stroke="var(--cth-paper-100)"
            strokeWidth={1.5}
          />
        ))}
      </svg>

      {commits.map((c, i) => {
        const refs = cleanRefs(c.refs);
        const head = refs[0];
        const isCurrent = !!head && !!currentBranch && head.endsWith(currentBranch);
        return (
          <div
            key={c.sha}
            onClick={onCommitClick ? () => onCommitClick(c.sha) : undefined}
            title={`${c.shortSha} · ${c.subject}\n${c.author} · ${relTime(c.time * 1000)} ago`}
            style={{
              height: ROW_H,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              paddingLeft: railW + 4,
              paddingRight: 8,
              minWidth: 0,
              cursor: onCommitClick ? 'pointer' : 'default',
              fontSize: 12,
              lineHeight: `${ROW_H}px`,
              whiteSpace: 'nowrap'
            }}
          >
            <span style={{
              fontFamily: 'var(--cth-font-mono)', color: 'var(--cth-ink-500)', flexShrink: 0
            }}>{c.shortSha}</span>

            {/* 主题（subject）是列表的重点，因此它是唯一获得
                剩余宽度的东西 —— 也是唯一允许省略号截断的。 */}
            <span style={{
              flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
              color: 'var(--cth-ink-900)'
            }}>{c.subject}</span>

            {head && (
              <span style={{
                flexShrink: 1, minWidth: 0, maxWidth: '38%',
                overflow: 'hidden', textOverflow: 'ellipsis',
                padding: '0 5px', fontSize: 11,
                fontFamily: 'var(--cth-font-mono)',
                color: isCurrent ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)',
                background: isCurrent ? 'var(--cth-lemon-light)' : 'transparent',
                boxShadow: `inset 0 0 0 1px ${isCurrent ? 'var(--cth-lemon)' : 'var(--cth-ink-300)'}`
              }}>{head}</span>
            )}
            {refs.length > 1 && (
              <span style={{ flexShrink: 0, fontSize: 11, color: 'var(--cth-ink-500)' }}>
                +{refs.length - 1}
              </span>
            )}

            <span style={{
              flexShrink: 0, fontFamily: 'var(--cth-font-mono)',
              fontSize: 11, color: 'var(--cth-ink-500)'
            }}>{relTime(c.time * 1000)}</span>
          </div>
        );
      })}
    </div>
  );
}

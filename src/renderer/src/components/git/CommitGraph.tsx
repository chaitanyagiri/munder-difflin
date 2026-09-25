import { useMemo } from 'react';
import { layoutGraph, LANE_COLORS } from './graph';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

/**
 * Commit history — lane rail + one line per commit.
 *
 * WHY THIS IS HAND-ROLLED. This used to render through the `commit-graph` npm
 * package, which cannot be made to fit a resizable sidebar:
 *
 *   - it positions every commit row ABSOLUTELY at a hardcoded `height: 4rem`,
 *     independent of the `commitSpacing` it lays the graph out with, so any
 *     compact spacing makes consecutive rows overlap;
 *   - it reserves a fixed `max-width: 500px` for the graph SVG regardless of how
 *     much room there actually is, so in a narrow panel the text is squeezed into
 *     whatever is left over, wraps, and collides again;
 *   - its class names carry a build hash, so the CSS needed to correct any of
 *     that is substring-matched and breaks on a version bump;
 *   - and it never showed the commit SUBJECT at all — the one field anyone
 *     actually reads a history for.
 *
 * The lane algorithm in ./graph.ts was already written for this and sitting
 * unused. Rows here are a fixed height with single-line text, the rail is sized
 * from the lanes actually in use, and everything past the rail is normal flex —
 * so it stays readable from a 240px sidebar to a full-width panel.
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
  /** Name of the currently checked-out branch, for highlighting. */
  currentBranch?: string | null;
  /** v0.3.4: commit click → per-commit file list / diff in the IDE HISTORY pane. */
  onCommitClick?: (sha: string) => void;
}

/** One line of 12px text plus breathing room. */
const ROW_H = 24;
/** Horizontal pitch between lanes. */
const LANE_W = 13;
/** Lanes past this are clamped into the last one: the rail is a wayfinding aid,
 *  and letting a 12-way merge push the subject off-screen trades the thing being
 *  read for the decoration beside it. */
const MAX_LANES = 6;
const DOT_R = 3.5;
/** Corner radius where a line crosses lanes. */
const BEND = 8;

function relTime(ms: number, t: TFunction): string {
  const delta = Math.max(0, Date.now() / 1000 - ms / 1000);
  if (delta < 60) return t('gitPanes.relative.seconds', { count: Math.round(delta) });
  if (delta < 3600) return t('gitPanes.relative.minutes', { count: Math.round(delta / 60) });
  if (delta < 86400) return t('gitPanes.relative.hours', { count: Math.round(delta / 3600) });
  if (delta < 86400 * 30) return t('gitPanes.relative.days', { count: Math.round(delta / 86400) });
  return t('gitPanes.relative.months', { count: Math.round(delta / (86400 * 30)) });
}

/** Strip git's decoration noise down to something chip-sized. */
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
  const { t } = useTranslation();
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
      {/* The rail is decoration: absolutely positioned and pointer-transparent so
          it can never intercept a row click or contribute to layout width. */}
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
            // Parent outside the fetched window: run the line to the bottom edge
            // rather than dropping it, so the lane doesn't just stop mid-air.
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
              // Straight down the child's lane, then a quarter-turn into the
              // parent — the shape a git graph is expected to make.
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
            title={`${c.shortSha} · ${c.subject}\n${c.author} · ${t('schedulesSection.ago', { unit: relTime(c.time * 1000, t) })}`}
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

            {/* The subject is the point of the list, so it is the one thing that
                gets the leftover width — and the only one allowed to ellipse. */}
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
            }}>{relTime(c.time * 1000, t)}</span>
          </div>
        );
      })}
    </div>
  );
}

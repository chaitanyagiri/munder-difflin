import { useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelBadge, StatusKind } from './PixelBadge';
import { SpritePortrait } from './SpritePortrait';
import { RealtimeMichaelToggle } from './RealtimeMichaelToggle';
import { CostHud } from '@/realtime/CostHud';
import { AccentColorName } from '@/design/tokens';
import { OfficeCharacterName } from '@/scene/office/cast';

export interface AgentCardProps {
  name: string;
  character: OfficeCharacterName;
  accent: AccentColorName;
  status: StatusKind;
  project: string;
  action?: string;
  /** Context gauge: 0..8 segments filled (session context ÷ context limit). */
  progress?: number;
  /** Live context size (tokens) — shown in the gauge tooltip. */
  contextTokens?: number;
  /** Context-window limit (tokens) assumed for the agent's model. */
  contextLimit?: number;
  selected?: boolean;
  /** The orchestrator — gets a persistent accent frame + GOD tag so it stands out. */
  isGod?: boolean;
  onClick?: () => void;
  /** Number of ledger tasks this agent is actively DOING — rendered as a blue
   *  sticky note stuck to the card. Clicking it opens the first task's detail. */
  doingCount?: number;
  onTaskNoteClick?: () => void;
}

const fmtK = (n: number): string => `${Math.round(n / 1000)}k`;

export function AgentCard({
  name, character, accent, status, project, action, progress = 0,
  contextTokens, contextLimit, selected, isGod, onClick,
  doingCount = 0, onTaskNoteClick
}: AgentCardProps) {
  const [hover, setHover] = useState(false);
  // The god is always framed (stands out from the row); others only when selected.
  const framed = isGod || selected;

  // Context gauge as ONE clean fill (0..8 → 0..100%) instead of eight bordered
  // chunks — easier to scan at a glance. Colour escalates as the window fills:
  // accent while comfortable, lemon from 6/8 (~75%), coral from 7/8 (compaction imminent).
  const pct = Math.min(8, Math.max(0, progress)) / 8 * 100;
  const gaugeColor = progress >= 7 ? 'var(--cth-coral)'
    : progress >= 6 ? 'var(--cth-lemon)'
      : `var(--cth-${accent})`;
  const gaugeTitle = contextTokens !== undefined && contextLimit
    ? `Context: ${fmtK(contextTokens)} / ${fmtK(contextLimit)} tokens (${Math.round((contextTokens / contextLimit) * 100)}%)`
    : 'Context gauge — fills once the agent reports activity';

  // The orchestrator stands a little taller + wider and rides a hard drop shadow
  // so it visibly pops UP off the worker row; workers are a compact, uniform size.
  // Both rise a touch on hover — a clear "this is clickable" affordance.
  const width = isGod ? 236 : 212;
  const height = isGod ? 98 : 90;
  const lift = (isGod ? -2 : 0) - (hover ? 2 : 0);
  const dropShadow = isGod
    ? `3px 4px 0 0 rgba(26,19,32,${hover ? 0.30 : 0.22})`
    : (hover ? '2px 3px 0 0 rgba(26,19,32,0.16)' : 'none');

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="cth-titlebar-nodrag"
      style={{
        width, minWidth: width, height,
        padding: 0, border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left',
        position: 'relative',
        transform: lift ? `translateY(${lift}px)` : 'none',
        boxShadow: dropShadow,
        transition: 'transform 90ms steps(2, end), box-shadow 90ms steps(2, end)'
      }}
    >
      {/* The taken note, stuck to the card like on the desk: this worker is
          actively DOING a ledger task. Click → the task's detail overlay. */}
      {doingCount > 0 && (
        <span
          title={`actively working ${doingCount} task${doingCount === 1 ? '' : 's'} — click to open`}
          onClick={(e) => { e.stopPropagation(); onTaskNoteClick?.(); }}
          style={{
            position: 'absolute', right: -4, bottom: -5, zIndex: 2,
            width: 22, height: 20,
            background: 'var(--cth-sky)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-900), 2px 2px 0 rgba(26,19,32,0.25)',
            transform: 'rotate(4deg)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-900)',
            cursor: 'pointer'
          }}
        >
          {doingCount > 1 ? doingCount : '✎'}
        </span>
      )}
      <PixelPanel
        variant={framed ? 'active' : 'default'}
        accent={framed ? accent : undefined}
        style={{ height: '100%', padding: 8 }}
        noPadding
      >
        <div style={{ display: 'flex', gap: 8, height: '100%' }}>
          {/* Portrait tile — vertically centred so the card reads calm and even. */}
          <div style={{
            width: 44, height: isGod ? 60 : 56, alignSelf: 'center',
            background: `var(--cth-${accent}-light)`,
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
            display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden',
            flexShrink: 0
          }}>
            <SpritePortrait character={character} scale={2} />
          </div>

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
            {/* Name + status. The god's name rides an accent chip so its header
                pops in colour — instantly distinct from the plain worker cards. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
              <span style={isGod ? {
                fontFamily: 'var(--cth-font-display)',
                fontSize: 'var(--cth-text-display-sm)',
                lineHeight: 'var(--cth-lh-display-sm)',
                color: 'var(--cth-ink-900)',
                background: `var(--cth-${accent})`,
                padding: '3px 6px 2px',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1
              } : {
                fontFamily: 'var(--cth-font-display)',
                fontSize: 'var(--cth-text-display-sm)',
                lineHeight: 'var(--cth-lh-display-sm)',
                color: 'var(--cth-ink-900)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
              }}>{name.toUpperCase()}</span>
              <PixelBadge status={status} />
            </div>

            {isGod ? (
              <>
                {/* Identity line — the GOD tag + which workspace it orchestrates. */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  fontSize: 'var(--cth-text-body-sm)', lineHeight: '16px',
                  color: 'var(--cth-ink-500)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                }}>
                  <span style={{
                    fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                    background: `var(--cth-${accent})`, color: 'var(--cth-ink-900)',
                    padding: '1px 5px 0', boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)', flexShrink: 0
                  }}>GOD</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{project}</span>
                </div>

                {/* Voice control gets its OWN line — a clear, labelled "talk" button
                    (not the cramped icon-only form) with the live cost meter beside
                    it. Stops its click so the mic never selects the card. */}
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <RealtimeMichaelToggle />
                  <CostHud compact />
                </div>
              </>
            ) : (
              <>
                {/* Project the worker is checked out into. */}
                <div style={{
                  fontSize: 'var(--cth-text-body-sm)', lineHeight: '16px',
                  color: 'var(--cth-ink-500)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                }}>{project}</div>

                {/* What it's doing right now. Reserve the line even when idle (the
                    "idle" badge already says so) so the gauge below never jumps. */}
                <div style={{
                  fontSize: 'var(--cth-text-body-sm)', lineHeight: '16px', minHeight: 16,
                  color: 'var(--cth-ink-900)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                }}>{(status === 'idle' ? '' : action) || ' '}</div>
              </>
            )}

            {/* Context gauge — one clean fill bar pinned to the card's bottom edge
                so it never moves, whatever the lines above do. */}
            <div style={{ marginTop: 'auto' }} title={gaugeTitle}>
              <div style={{
                height: 6, width: '100%',
                background: 'var(--cth-cream-200)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
                overflow: 'hidden'
              }}>
                <div style={{ width: `${pct}%`, height: '100%', background: gaugeColor }} />
              </div>
            </div>
          </div>
        </div>
      </PixelPanel>
    </button>
  );
}

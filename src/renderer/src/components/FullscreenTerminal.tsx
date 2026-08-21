import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PixelBadge } from './PixelBadge';
import { PixelButton } from './PixelButton';
import { PtyTerminalView } from './PtyTerminalView';
import { terminalInstanceKey } from './terminalRecovery';
import { MessageQueueComposer } from './MessageQueueComposer';
import { AgentControlStrip } from './AgentControlStrip';
import { CommandCenterPanel } from './CommandCenterPanel';
import { Icon } from './Icon';
import { SpritePortrait } from './SpritePortrait';
import { PORTRAIT_W } from '@/scene/office/portraitArt';
import { RealtimeMichaelToggle } from './RealtimeMichaelToggle';
import { CostHud } from '@/realtime/CostHud';
import { useStore, type Agent } from '@/store/store';
import { usePtyParser } from '@/hooks/usePtyParser';
import { useRestoreTeam } from '@/hooks/useRestoreTeam';
import { useTerminalFontSize } from './terminalFontSize';
import { useHasTerminalDraft, disposeTerminal } from './terminalPool';
import { useAppTheme, toggleAppTheme } from '@/design/theme';
import type { HarnessConfig } from '@/store/config';

/** Roster rail width. A fixed 232px is right on a 14" laptop but reads as a
 *  sliver on a 27" display, where names truncate for no reason — so it tracks
 *  the viewport between those two ends. */
const SIDEBAR_WIDTH = 'clamp(232px, 14vw, 340px)';
/** Remembers the roster collapse across fullscreen sessions and app restarts. */
const ROSTER_COLLAPSED_KEY = 'cth.fullscreen.rosterCollapsed';

/** Roster type scale, derived from the shared terminal zoom so Cmd +/- resizes
 *  the whole roster along with the terminal — one knob for the whole view
 *  instead of a size that only looked right on the display it was tuned on.
 *  Each is clamped: names are a pixel display face that turns to mush when it
 *  strays too far from its native size, and the bullets have to stay subordinate
 *  to the name however far the terminal is zoomed. */
function rosterScale(zoom: number) {
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));
  // The portrait is sized in SPRITE steps, not free pixels. The art is an 18×28
  // pixel stamp: widening the tile alone just pads it (which is what the old
  // `clamp(zoom * 1.2, 18, 40)` did past 18px — a bigger frame around the same
  // small figure), and a scale like 1.37× renders some pixel rows one device
  // pixel tall and others two. Half-steps double every other row cleanly, so
  // that is the grid the size moves on. Floor is 1.5× — 1× was too small to
  // tell two hires apart at a glance, which is the tile's whole job.
  const portraitScale = Math.min(2.5, Math.max(1.5, Math.round(zoom * 0.11 * 2) / 2));
  return {
    name: clamp(zoom * 0.48, 7, 14),
    group: clamp(zoom * 0.45, 7, 13),
    note: clamp(zoom * 0.68, 10, 20),
    portraitScale,
    portrait: Math.round(PORTRAIT_W * portraitScale)
  };
}

function basename(path: string): string {
  // Split on BOTH separators: `git:mainRepo` hands back whatever the platform
  // uses, and a Windows `C:\work\repo` contains no '/' at all — so a '/'-only
  // split returned the whole absolute path as the group's "name".
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** cwd → main-repo basename, resolved once per path and shared by every mount.
 *  An isolated agent's cwd is its own git worktree (`…/worktrees/<agent-id>`),
 *  so naming the group after that path buckets each such agent under its own id
 *  instead of the repository the user actually picked. `git:mainRepo` follows a
 *  linked worktree back to its main checkout. */
const repoRootByCwd = new Map<string, string | null>();
/** cwds with a lookup in flight, so a re-render can't start a second one. */
const repoLookupsInFlight = new Set<string>();

/** Which repository an agent belongs to — the ABSOLUTE root, so it is a real
 *  identity. Two unrelated checkouts can share a basename (`~/client-a/app` and
 *  `~/client-b/app`); keying groups on the name merged them into one section and
 *  let agents be dragged between two different repositories.
 *
 *  Falls back to the cwd itself until the async resolution lands, and for
 *  directories that aren't git repos at all. */
function repoKeyOf(agent: Agent): string {
  return repoRootByCwd.get(agent.cwd) || agent.cwd || 'unknown';
}

/** What that group is CALLED — the basename, or the project the user picked. */
function repoLabelOf(agent: Agent): string {
  const root = repoRootByCwd.get(agent.cwd);
  if (root) return basename(root);
  const project = agent.project?.trim();
  if (project) return project;
  return basename(agent.cwd) || 'unknown';
}

/** Resolve every distinct cwd's repository root, then re-render. Exactly one git
 *  call per distinct path, ever. */
function useResolvedRepoNames(agents: Agent[]): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const pending = [...new Set(agents.map(a => a.cwd).filter(Boolean))]
      // `has` (not a truthiness check) so a resolved-to-null path — a cwd that
      // is not a git repo — counts as answered. Caching only successes meant
      // every agent outside a repo re-asked on each pass, and this effect
      // depends on `agents`, which the pty parser replaces on every chunk of
      // terminal output: one such agent spawned `git rev-parse` continuously
      // for as long as it was talking. In-flight paths are skipped too, so a
      // re-render mid-lookup doesn't stack a second round of subprocesses.
      .filter(cwd => !repoRootByCwd.has(cwd) && !repoLookupsInFlight.has(cwd));
    if (pending.length === 0) return;
    pending.forEach(cwd => repoLookupsInFlight.add(cwd));
    void Promise.all(pending.map(async (cwd) => {
      try {
        repoRootByCwd.set(cwd, (await window.cth.gitMainRepo(cwd)) || null);
      } catch {
        // Record the failure as answered as well — retrying a path that throws
        // is what the unbounded-subprocess bug was made of.
        repoRootByCwd.set(cwd, null);
      } finally {
        repoLookupsInFlight.delete(cwd);
      }
    })).then(() => { if (!cancelled) setVersion(v => v + 1); });
    return () => { cancelled = true; };
  }, [agents]);
  return version;
}

/** The roster section an agent lives in — god agents share one ungrouped
 *  section, everyone else groups by repository. */
function groupKey(agent: Agent): string {
  return agent.isGod ? '__god__' : repoKeyOf(agent);
}

/** Drag-reorder wiring handed down to each row. */
interface RowDrag {
  dragId: string | null;
  overId: string | null;
  start: (id: string) => void;
  over: (id: string) => void;
  leave: (id: string) => void;
  drop: (id: string) => void;
  end: () => void;
}

export interface FullscreenTerminalProps {
  /** Only needed to rebuild a spawn command for a restorable agent saved before
   *  the `command` field existed — same role as in AgentStrip. */
  config?: HarnessConfig | null;
}

export function FullscreenTerminal({ config }: FullscreenTerminalProps) {
  const agents = useStore(s => s.agents);
  const restorableAgents = useStore(s => s.restorableAgents);
  const fullscreenAgentId = useStore(s => s.fullscreenAgentId);
  const setFullscreen = useStore(s => s.setFullscreen);
  const select = useStore(s => s.select);
  const setAddAgentOpen = useStore(s => s.setAddAgentOpen);
  const addAgentOpen = useStore(s => s.addAgentOpen);
  const setAgentNote = useStore(s => s.setAgentNote);
  const updateAgent = useStore(s => s.updateAgent);
  // The floor strip (and with it the restore button) is hidden behind the
  // overlay, so the roster carries restore too.
  const { restoring, autoRestoring, restoreTeam } = useRestoreTeam(config);
  const appThemeNow = useAppTheme();

  const agent = agents.find(a => a.id === fullscreenAgentId);
  const parser = usePtyParser(agent?.id ?? '__none__');

  const repoVersion = useResolvedRepoNames(agents);
  const scale = rosterScale(useTerminalFontSize());

  // Drag-to-reorder, same as the floor strip (native HTML5 DnD, no dep). A plain
  // click still selects — a drag only starts on movement. Drops are confined to
  // the dragged agent's OWN group: the repo header comes from its cwd, so a
  // cross-group drop would reorder the array and then snap the row straight back
  // under its own header, which just reads as "reordering is broken".
  const reorderAgents = useStore(s => s.reorderAgents);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // Roster collapse. Persisted because it is a working preference, not a mode:
  // someone who hides the rail to read wide terminal output wants it still hidden
  // the next time they go fullscreen, not to re-hide it every single time.
  const [rosterCollapsed, setRosterCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(ROSTER_COLLAPSED_KEY) === '1'; } catch { return false; }
  });
  const toggleRoster = (): void => {
    setRosterCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem(ROSTER_COLLAPSED_KEY, next ? '1' : '0'); } catch { /* private mode */ }
      return next;
    });
  };
  const drag: RowDrag = {
    dragId,
    overId,
    start: (id) => setDragId(id),
    over: (id) => setOverId((prev) => (prev === id ? prev : id)),
    leave: (id) => setOverId((prev) => (prev === id ? null : prev)),
    drop: (id) => {
      if (dragId && dragId !== id) {
        const from = agents.find(a => a.id === dragId);
        const to = agents.find(a => a.id === id);
        if (from && to && groupKey(from) === groupKey(to)) reorderAgents(dragId, id);
      }
      setDragId(null);
      setOverId(null);
    },
    end: () => { setDragId(null); setOverId(null); }
  };

  // Roster: god agents first and ungrouped, everyone else bucketed by repo.
  // Insertion order is preserved inside each bucket (it's the user's own
  // drag-reorder from the floor strip) and buckets appear in first-seen order,
  // so the list doesn't reshuffle as statuses change.
  const { gods, groups } = useMemo(() => {
    const godList: Agent[] = [];
    // Keyed by absolute repo root (identity); the label is carried alongside so
    // two same-named repos stay two groups but still read by name.
    const byRepo = new Map<string, { label: string; members: Agent[] }>();
    for (const a of agents) {
      if (a.isGod) { godList.push(a); continue; }
      const key = repoKeyOf(a);
      const bucket = byRepo.get(key);
      if (bucket) bucket.members.push(a);
      else byRepo.set(key, { label: repoLabelOf(a), members: [a] });
    }
    return { gods: godList, groups: [...byRepo.entries()] };
    // repoVersion: rebucket once the async main-repo lookups land.
  }, [agents, repoVersion]);

  // Esc exits fullscreen
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // A modal above fullscreen owns the interaction until it closes. Without
        // this guard, Esc from the Add Agent form unexpectedly exits fullscreen.
        if (addAgentOpen) return;
        e.preventDefault();
        setFullscreen(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addAgentOpen, setFullscreen]);

  if (!agent || !agent.ptyId) {
    // Bail out — no real agent to show
    setFullscreen(null);
    return null;
  }

  // No kill button here on purpose. Killing an agent is a destructive action
  // that belongs with the rest of its lifecycle controls in the docked panel;
  // sitting inches from the tab you click to switch agents, it was only ever a
  // mis-click waiting to happen. Exiting fullscreen is likewise already covered
  // twice over (Esc, and the terminal toolbar's own fullscreen toggle).
  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'var(--cth-cream-100)',
      zIndex: 250,
      display: 'flex',
      flexDirection: 'column',
      paddingTop: 36  // leave room for macOS traffic lights / drag region
    }}>
      {/* Title bar drag region (so the user can still move the window) */}
      <div
        className="cth-titlebar-drag"
        style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 36,
          background: 'linear-gradient(180deg, var(--cth-cream-100) 0%, var(--cth-cream-200) 100%)',
          borderBottom: '1px solid var(--cth-ink-300)',
          display: 'flex', alignItems: 'center',
          paddingLeft: 96, paddingRight: 12, gap: 12,
          userSelect: 'none'
        }}
      >
        <span style={{
          fontFamily: 'var(--cth-font-display)', fontSize: 12, lineHeight: '20px',
          color: 'var(--cth-ink-900)'
        }}>MUNDER DIFFLIN · FULLSCREEN</span>
        {/* Same top-right controls as the main title bar — fullscreen covers
            it, so theme / exit-fullscreen / IDE must live here too. */}
        <div className="cth-titlebar-nodrag" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={toggleRoster}
            title={rosterCollapsed ? 'Show the agent list' : 'Hide the agent list — full-width terminal'}
            aria-label={rosterCollapsed ? 'Show the agent list' : 'Hide the agent list'}
            aria-pressed={rosterCollapsed}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, padding: 0,
              // Pressed-in when collapsed, so the rail's absence reads as a state
              // this button is holding rather than something that broke.
              background: rosterCollapsed ? 'var(--cth-lemon)' : 'var(--cth-paper-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              border: 'none', borderRadius: 2, cursor: 'pointer',
              color: rosterCollapsed ? 'var(--cth-ink-900)' : 'var(--cth-ink-900)'
            }}
          >
            <Icon name="sidebar" size={1} style={{ width: 16, height: 16 }} />
          </button>
          <button
            onClick={() => {
              const next = toggleAppTheme();
              void window.cth.updateConfig({ terminalTheme: next });
            }}
            title={appThemeNow === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
            aria-label="Toggle dark mode"
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, padding: 0,
              background: 'var(--cth-paper-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              border: 'none', borderRadius: 2, cursor: 'pointer',
              color: 'var(--cth-ink-900)', fontSize: 13, lineHeight: 1
            }}
          >
            {appThemeNow === 'dark' ? '☀' : '☾'}
          </button>
          {/* Settings — the main title bar has it, so fullscreen must too:
              anything reachable in one mode and not the other is a trap. Uses
              App's existing `cth:open-settings` event rather than a new store
              action, because this overlay is not a child of App. */}
          <button
            className="cth-settings-btn"
            onClick={() => window.dispatchEvent(new CustomEvent('cth:open-settings'))}
            title="Settings"
            aria-label="Settings"
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, padding: 0,
              background: 'var(--cth-paper-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              border: 'none', borderRadius: 2, cursor: 'pointer',
              color: 'var(--cth-ink-900)'
            }}
          >
            <svg
              width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth={2}
              strokeLinecap="round" strokeLinejoin="round"
              aria-hidden="true" focusable="false"
            >
              <path d="M15.5 3.5a5 5 0 0 0-6.1 6.1l-5.6 5.6a2.3 2.3 0 1 0 3.2 3.2l5.6-5.6a5 5 0 0 0 6.1-6.1l-3 3-2.2-.6-.6-2.2z" />
            </svg>
          </button>
          <button
            onClick={() => setFullscreen(null)}
            title="Exit fullscreen (Esc)"
            aria-label="Exit fullscreen"
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, padding: 0,
              background: 'var(--cth-paper-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              border: 'none', borderRadius: 2, cursor: 'pointer',
              color: 'var(--cth-ink-900)'
            }}
          >
            <Icon name="minimize" size={1} style={{ width: 16, height: 16 }} />
          </button>
          {/* v0.3.4: IDE moved to agent level — it lives in each agent's
              header (see Header below), not in this global bar. */}
        </div>
      </div>

      {/* Body — roster on the left, the focused agent's terminal on the right.
          A vertical list scales past the handful of agents a horizontal tab bar
          could show, and grouping by repository is how the user actually thinks
          about the fleet. */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {/* Unmounted rather than width:0 when collapsed — the roster renders a row
            per agent with live status, and keeping a hidden copy mounted would go
            on doing that work for a rail nobody can see. Remounting is cheap; the
            terminals live in the pool and are untouched by this. */}
        {!rosterCollapsed && (
        <aside style={{
          width: SIDEBAR_WIDTH, flexShrink: 0,
          display: 'flex', flexDirection: 'column',
          background: 'var(--cth-cream-200)',
          borderRight: '1px solid var(--cth-ink-300)'
        }}>
          <div style={{ padding: 8, borderBottom: '1px solid var(--cth-ink-300)' }}>
            <button
              onClick={() => setAddAgentOpen(true)}
              title="Add agent"
              style={{
                width: '100%', height: 32,
                background: 'var(--cth-cream-100)',
                border: 'none',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                fontFamily: 'var(--cth-font-ui)',
                fontSize: 'clamp(14px, 0.7vw, 15px)',
                color: 'var(--cth-ink-900)',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                cursor: 'pointer'
              }}
            >
              <Icon name="plus" /> agent
            </button>
          </div>

          <div className="cth-scroll-hidden" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 0' }}>
            {/* The god agent runs the floor rather than a checkout, so it gets no
                repository header — it sits alone at the top of the roster. */}
            {gods.map(a => (
              <SidebarRow
                key={a.id}
                agent={a}
                active={a.id === agent.id}
                onClick={() => { select(a.id); setFullscreen(a.id); }}
                onNoteChange={(note) => setAgentNote(a.id, note)}
                drag={drag}
                scale={scale}
              />
            ))}
            {groups.map(([repoKey, { label, members }]) => (
              // Repos are the roster's real structure, so they get real
              // separation — a hairline plus air above, not just a label.
              <div key={repoKey} style={{ marginTop: 16, paddingTop: 10, borderTop: '1px solid var(--cth-ink-300)' }}>
                <div
                  title={repoKey}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '0 10px 6px',
                    fontFamily: 'var(--cth-font-display)',
                    fontSize: scale.group, lineHeight: 1.5,
                    color: 'var(--cth-ink-500)'
                  }}
                >
                  {/* Native 16px, never a fraction of it: this is pixel art on
                      a 16-unit grid, so squeezing it to match a 7px label
                      merged the outline into mush. Dimmed instead of shrunk. */}
                  <span style={{ flexShrink: 0, display: 'inline-flex', opacity: 0.7 }}>
                    <Icon name="folder" size={scale.group >= 13 ? 2 : 1} />
                  </span>
                  <span style={{
                    minWidth: 0,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                  }}>{label.toUpperCase()}</span>
                </div>
                {members.map(a => (
                  <SidebarRow
                    key={a.id}
                    agent={a}
                    active={a.id === agent.id}
                    onClick={() => { select(a.id); setFullscreen(a.id); }}
                    onNoteChange={(note) => setAgentNote(a.id, note)}
                    drag={drag}
                    scale={scale}
                  />
                ))}
              </div>
            ))}
          </div>

          {/* Last session's team, same as the floor strip — pinned to the bottom
              so it can't be scrolled out of reach behind a long roster. */}
          {(restorableAgents.length > 0 || autoRestoring) && (
            <div style={{
              flexShrink: 0, padding: 8, display: 'flex', flexDirection: 'column', gap: 6,
              borderTop: '1px solid var(--cth-ink-300)'
            }}>
              {autoRestoring && (
                // Same banner as the floor strip: terminals that open by
                // themselves need to say why.
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '4px 8px',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 11,
                  color: 'var(--cth-ink-900)',
                  background: 'var(--cth-status-working)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                }}>
                  <Icon name="play" /> restoring your team…
                </div>
              )}
              {!autoRestoring && restorableAgents.length > 0 && (
                <PixelButton
                  variant="primary"
                  size="sm"
                  onClick={restoreTeam}
                  disabled={restoring}
                  style={{ width: '100%' }}
                  title={`Respawn from last session: ${restorableAgents.map((a: Agent) => a.name).join(', ')} — same ids, memory and inboxes reattach automatically`}
                >
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <Icon name="play" /> {restoring ? 'restoring…' : `restore team (${restorableAgents.length})`}
                  </span>
                </PixelButton>
              )}
              {!autoRestoring && restorableAgents.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {restorableAgents.map((a: Agent) => (
                    <span
                      key={a.id}
                      title={`${a.name} — restorable from last session`}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 2,
                        height: 20, padding: '0 2px 0 6px',
                        fontFamily: 'var(--cth-font-ui)', fontSize: 11,
                        color: 'var(--cth-ink-700)', background: 'var(--cth-paper-100)',
                        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                      }}
                    >
                      {a.name}
                      <button
                        onClick={() => useStore.getState().removeRestorableAgent(a.id)}
                        title={`Dismiss ${a.name} — remove permanently from the restore list`}
                        aria-label={`Dismiss ${a.name}`}
                        style={{
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          width: 14, height: 14, padding: 0, lineHeight: 1,
                          fontFamily: 'var(--cth-font-ui)', fontSize: 11,
                          color: 'var(--cth-ink-500)', background: 'transparent',
                          border: 'none', cursor: 'pointer'
                        }}
                      >✕</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </aside>
        )}

        <div style={{
          flex: 1, minWidth: 0, minHeight: 0,
          display: 'flex', flexDirection: 'column',
          padding: 12, gap: 10
        }}>
          {agent.isGod ? (
            // Michael runs the floor from the command center — its tabs (tasks,
            // ask me, triggers, memory, graph…) are the whole point of selecting
            // him, and fullscreen used to drop them for a bare terminal.
            // Column so the panel's `height: 100%` resolves against a definite
            // height and `align-items: stretch` gives it the full width.
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <CommandCenterPanel agent={agent} fullscreen />
            </div>
          ) : (
            <>
              <Header agent={agent} />

              {/* #7C — pause / halt / steer. These only existed in the docked
                  sidebar, so going fullscreen took the operator controls away. */}
              <AgentControlStrip key={agent.id} agentId={agent.id} />

              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                  <PtyTerminalView
                    key={terminalInstanceKey(agent.ptyId, agent.terminalGeneration)}
                    ptyId={agent.ptyId}
                    onStreamData={parser}
                    onUserPrompt={(t) => {
                      updateAgent(agent.id, { lastPrompt: t });
                      if (t.trim().toLowerCase() === '/clear') {
                        updateAgent(agent.id, { contextTokens: 0, contextLimit: undefined, progress: 0 });
                      }
                      void window.cth.historyAdd({ agentId: agent.id, cwd: agent.cwd, text: t });
                    }}
                    onToggleFullscreen={() => setFullscreen(null)}
                    fullscreen
                  />
                </div>
                <MessageQueueComposer agent={agent} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Model ids are long and mostly boilerplate ("claude-opus-4-8[1m]",
 *  "anthropic/claude-sonnet-4-5"). The roster has ~120px, so show the part that
 *  distinguishes one agent from another and keep the full id in the tooltip. */
function shortModel(model?: string): string | null {
  if (!model || !model.trim()) return null;
  const tail = model.split('/').pop() ?? model;
  return tail
    .replace(/^claude-/i, '')
    .replace(/-\d{8}$/, '')          // trailing date stamps
    .replace(/\[(\d+)m\]/i, ' $1m') // [1m] → 1m
    .replace(/-/g, ' ')
    .trim();
}

/** Context fullness as a 3px rail. Colour tracks pressure rather than identity —
 *  an agent at 85% is about to compact, and that matters more than its accent. */
function ContextBar({ tokens, limit, accent }: { tokens?: number; limit?: number; accent: string }) {
  if (tokens === undefined || !limit) return null;
  const pct = Math.max(0, Math.min(100, Math.round((tokens / limit) * 100)));
  const color = pct >= 85 ? 'var(--cth-coral)' : pct >= 65 ? 'var(--cth-lemon)' : `var(--cth-${accent})`;
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  return (
    <div
      title={`Context: ${k(tokens)} / ${k(limit)} tokens (${pct}%)`}
      style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}
    >
      <span style={{
        flex: 1, minWidth: 0, height: 3,
        background: 'var(--cth-ink-100)', overflow: 'hidden'
      }}>
        <span style={{ display: 'block', width: `${pct}%`, height: '100%', background: color }} />
      </span>
      <span style={{ flexShrink: 0, fontSize: 9, color: 'var(--cth-ink-500)' }}>{pct}%</span>
    </div>
  );
}

function SidebarRow({
  agent,
  active,
  onClick,
  onNoteChange,
  drag,
  scale
}: {
  agent: Agent;
  active: boolean;
  onClick: () => void;
  onNoteChange: (note: string) => void;
  drag: RowDrag;
  scale: ReturnType<typeof rosterScale>;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLDivElement>(null);
  const [notePosition, setNotePosition] = useState<{ left: number; top: number } | null>(null);

  // The editor rides the terminal's zoom, capped — it's a short note, not a
  // reading pane, and following the terminal all the way up turned it into a
  // banner wider than the roster itself.
  const noteFontSize = Math.min(useTerminalFontSize(), 14);
  const noteLabelSize = Math.max(8, Math.round(noteFontSize * 0.6));
  const noteWidth = Math.min(300, Math.round(noteFontSize * 20));
  const noteHeight = Math.round(noteFontSize * 9);
  // Total popover height, used only to keep it on screen near the bottom edge:
  // the note textarea plus its label, the hint and the padding.
  const popoverHeight = noteHeight + noteLabelSize * 2 + 40;

  // One line of the note = one bullet on the row.
  const bullets = (agent.note ?? '').split('\n').map(s => s.trim()).filter(Boolean);

  const typing = useHasTerminalDraft(agent.ptyId);

  /** The ✎ button opens the editor beside the row — the bullets on the row are
   *  the summary, this is where you write them. EXPLICIT open only (v0.3.4):
   *  hovering the roster no longer pops editors under the pointer. */
  const toggleEditor = () => {
    if (notePosition) { setNotePosition(null); return; }
    // An editor popping up mid-drag just gets in the way.
    if (drag.dragId) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    // The roster is a left rail, so the editor opens to the RIGHT of its row.
    // Clamp so rows near an edge stay fully on screen.
    setNotePosition({
      left: Math.min(rect.right + 6, window.innerWidth - noteWidth - 8),
      top: Math.max(8, Math.min(rect.top, window.innerHeight - popoverHeight - 8))
    });
  };

  return (
    <>
      <button
        ref={buttonRef}
        draggable
        onDragStart={(e) => { drag.start(agent.id); e.dataTransfer.effectAllowed = 'move'; }}
        onDragOver={(e) => {
          if (!drag.dragId || drag.dragId === agent.id) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          drag.over(agent.id);
        }}
        onDragLeave={() => drag.leave(agent.id)}
        onDrop={(e) => { e.preventDefault(); drag.drop(agent.id); }}
        onDragEnd={drag.end}
        onClick={onClick}
        aria-label={`${agent.name} · ${agent.project}`}
        aria-current={active ? 'true' : undefined}
        style={{
          width: '100%',
          padding: '6px 8px',
          background: active ? 'var(--cth-cream-100)' : 'transparent',
          border: 'none',
          boxShadow: active
            ? 'inset 3px 0 0 var(--cth-ink-900), inset 0 0 0 1px var(--cth-ink-100)'
            // Insertion cue on the hovered drop target.
            : drag.overId === agent.id && drag.dragId && drag.dragId !== agent.id
            ? 'inset 0 2px 0 var(--cth-ink-900)'
            : 'none',
          opacity: drag.dragId === agent.id ? 0.4 : 1,
          display: 'flex', alignItems: 'flex-start', gap: 8,
          cursor: drag.dragId ? 'grabbing' : 'grab',
          position: 'relative',
          textAlign: 'left',
          fontFamily: 'var(--cth-font-ui)', fontSize: 13,
          color: 'var(--cth-ink-900)',
          transition: 'opacity 120ms ease'
        }}
      >
        <div style={{
          width: scale.portrait, height: Math.round(scale.portrait * 1.3), flexShrink: 0,
          background: `var(--cth-${agent.accent}-light)`,
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
          // Anchor the sprite's TOP: the portrait is taller than this tile, and
          // bottom-anchoring cropped the head — crop feet, not face (v0.3.4).
          display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
          overflow: 'hidden'
        }}>
          {/* The sprite is drawn at exactly the tile's width, so the figure
              grows with the tile instead of floating in it. */}
          <SpritePortrait character={agent.character} scale={scale.portraitScale} />
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <span style={{
              flex: 1, minWidth: 0,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              fontFamily: 'var(--cth-font-display)',
              fontSize: scale.name, lineHeight: 1.5
            }}>{agent.name.toUpperCase()}</span>
            {/* Your unsent text outranks the agent's own state here: an idle
                agent with a draft on its prompt is not idle-and-free, it is
                idle-and-held, and nothing else on screen said so. */}
            <PixelBadge status={typing ? 'typing' : agent.status} />
            {/* Explicit note edit — a real control instead of a hover surprise.
                A span, not a <button>: we're inside the row's button element. */}
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); toggleEditor(); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); toggleEditor(); }
              }}
              title={agent.note ? 'Edit private note' : 'Add private note'}
              aria-label={`Edit note for ${agent.name}`}
              style={{
                flexShrink: 0, width: 20, height: 20,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 12, lineHeight: 1, color: 'var(--cth-ink-500)',
                background: notePosition ? 'var(--cth-cream-200)' : 'var(--cth-paper-100)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                cursor: 'pointer'
              }}
            >✎</span>
          </div>
          {/* WHAT this agent is, at a glance. The roster used to carry only a
              name, a portrait and a status dot — enough to tell rows apart, not
              enough to answer "which model is this on, where is it working, and
              how full is its context", which is exactly what you need when the
              terminal is the whole screen and the sidebar is your only index. */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, minWidth: 0,
            fontSize: Math.max(9, scale.name - 3), lineHeight: 1.4,
            color: 'var(--cth-ink-500)'
          }}>
            <span style={{
              flexShrink: 0, maxWidth: '52%',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
            }} title={agent.model ? `Model: ${agent.model}` : 'Runs the CLI default model'}>
              {shortModel(agent.model) ?? 'CLI default'}
            </span>
            <span style={{ flexShrink: 0, opacity: 0.5 }}>·</span>
            <span style={{
              flex: 1, minWidth: 0,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
            }} title={agent.worktreePath || agent.cwd}>
              {basename(agent.worktreePath || agent.cwd) || agent.project}
            </span>
          </div>
          <ContextBar tokens={agent.contextTokens} limit={agent.contextLimit} accent={agent.accent} />
          {/* Every line of every agent, always on screen — the roster's job is
              to answer "who is on what" without a single interaction. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {bullets.map((line) => (
              <span
                key={line}
                title={line}
                style={{
                  display: 'flex', gap: 5, alignItems: 'baseline',
                  fontSize: scale.note, lineHeight: 1.35,
                  color: 'var(--cth-ink-500)'
                }}
              >
                <span style={{ flexShrink: 0, color: 'var(--cth-ink-300)' }}>•</span>
                {/* Exactly one line per bullet — a wrapping row would make the
                    roster's height jump around as notes are typed. The full
                    text is on hover (title, and the editor beside it). */}
                <span style={{
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                }}>{line}</span>
              </span>
            ))}
            {bullets.length === 0 && (
              <span style={{
                fontSize: scale.note, lineHeight: 1.35,
                color: 'var(--cth-ink-300)', fontStyle: 'italic'
              }}>no note</span>
            )}
          </div>
        </div>
      </button>
      {notePosition && createPortal(
        <>
        {/* click-away backdrop — the editor stays until dismissed on purpose */}
        <div
          onClick={() => setNotePosition(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 449, background: 'transparent' }}
        />
        <div
          ref={noteRef}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: notePosition.left,
            top: notePosition.top,
            width: noteWidth,
            zIndex: 450,
            padding: 8,
            background: 'var(--cth-paper-100)',
            boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500), 4px 4px 0 rgba(26,19,32,0.25)',
            boxSizing: 'border-box'
          }}
        >
          <div style={{
            marginBottom: 6,
            fontFamily: 'var(--cth-font-display)',
            fontSize: noteLabelSize,
            lineHeight: `${Math.round(noteLabelSize * 1.5)}px`,
            color: 'var(--cth-ink-700)'
          }}>PRIVATE NOTE</div>
          {/* A textarea, not an input: the note is a bullet list, so Enter has
              to make a new line rather than doing nothing. autoFocus is safe
              now that opening is an explicit click, not a pointer fly-by. */}
          <textarea
            autoFocus
            value={agent.note ?? ''}
            onChange={(e) => onNoteChange(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation(); // don't let Esc/typing reach the fullscreen handler
              if (e.key === 'Escape') {
                setNotePosition(null);
                buttonRef.current?.focus();
              }
            }}
            placeholder="one line per bullet…"
            aria-label={`Note for ${agent.name}`}
            style={{
              width: '100%',
              height: noteHeight,
              padding: '5px 7px',
              border: 'none',
              outline: 'none',
              resize: 'vertical',
              boxSizing: 'border-box',
              background: 'var(--cth-cream-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
              fontFamily: 'var(--cth-font-mono)',
              fontSize: noteFontSize,
              lineHeight: `${Math.round(noteFontSize * 1.6)}px`,
              color: 'var(--cth-ink-900)'
            }}
          />
          <div style={{
            marginTop: 5, fontSize: 10, color: 'var(--cth-ink-500)'
          }}>one line = one bullet · esc to close</div>
        </div>
        </>,
        document.body
      )}
    </>
  );
}

function Header({ agent }: { agent: Agent }) {
  const typing = useHasTerminalDraft(agent.ptyId);
  const archiveAgent = useStore((st) => st.archiveAgent);
  const [openState, setOpenState] = useState<'idle' | 'opening' | 'ok' | 'error'>('idle');

  /** Same action as the docked panel: open the OS terminal in this agent's
   *  working directory. Fullscreen had no way to do it, which is backwards —
   *  this is the mode where you are most likely to want a shell beside it. */
  const openTerminal = async () => {
    setOpenState('opening');
    try {
      const res = await window.cth.openTerminalAt(agent.worktreePath || agent.cwd);
      setOpenState(res.ok ? 'ok' : 'error');
    } catch { setOpenState('error'); }
    setTimeout(() => setOpenState('idle'), 1500);
  };

  /** Kill + archive, mirroring AgentDetailPanel. Confirmed, because it ends a
   *  running process. God is exempt: the floor respawns it immediately, so the
   *  button would read as "restart Michael" while looking like "close". */
  const onKill = async () => {
    if (!agent.ptyId) return;
    if (!confirm(`Close ${agent.name}? The PTY process will terminate and the agent is archived (kept in history, off the floor).`)) return;
    await window.cth.killPty(agent.ptyId);
    disposeTerminal(agent.ptyId);
    archiveAgent(agent.id);
    useStore.getState().setFullscreen(null);
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '6px 10px',
      background: 'var(--cth-cream-50)',
      boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
    }}>
      <span style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '16px',
        color: 'var(--cth-ink-900)'
      }}>{agent.name.toUpperCase()}</span>
      <span style={{
        fontSize: 12, color: 'var(--cth-ink-500)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        maxWidth: 300
      }}>{agent.cwd}</span>
      <span style={{
        fontSize: 12, color: 'var(--cth-ink-700)',
        fontStyle: 'italic'
      }}>“{agent.description}”</span>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
        {/* v0.3.4: the IDE opens from agent level — full Monaco editor + git
            diff over this agent's workspace. The id is passed EXPLICITLY:
            fullscreen does not change the selection, so leaving the IDE to infer
            its agent would open whichever agent happens to be selected in the
            sidebar rather than the one filling the screen. */}
        <PixelButton variant="secondary" size="sm" onClick={() => useStore.getState().setIdeOpen(true, agent.id)}>
          <span title="Open the IDE — file editor + git diff" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Icon name="code" /> IDE
          </span>
        </PixelButton>
        {/* Voice toggle is ALWAYS reachable in fullscreen — it controls Michael (the
            god orchestrator) globally, not the agent in view, so users can start a
            voice session even while a worker's terminal fills the screen. The cost
            HUD stays Michael-only (it belongs to his card). */}
        <RealtimeMichaelToggle />
        {agent.isGod && <CostHud compact />}
        <PixelButton variant="secondary" size="sm" onClick={openTerminal} disabled={openState === 'opening'}>
          <span
            title={`Open your terminal app at ${agent.worktreePath || agent.cwd}`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <Icon name="terminal" />
            {openState === 'opening' ? '...' : openState === 'ok' ? 'ok' : openState === 'error' ? 'err' : 'open'}
          </span>
        </PixelButton>
        {/* The badge is a STATUS, not a button, but it sits in a row of them.
            Its own box is 20px (lineHeight 18 + 2px padding) against the 24px
            every size="sm" PixelButton is fixed at, so the row read as ragged.
            Sized through the badge's own style prop rather than a wrapper: a
            wrapper only centres the 20px box inside 24px, it does not make the
            visible border match. */}
        <PixelBadge
          status={typing ? 'typing' : agent.status}
          style={{ height: 24, padding: '0 8px', lineHeight: '24px' }}
        />
        {!agent.isGod && (
          <PixelButton variant="destructive" size="sm" onClick={onKill}>
            {/* inline-flex + center: the other buttons hold TEXT, whose line box
                the button centres for free. A bare <Icon> is replaced-content
                sitting on the text baseline, so it rode low and overhung the
                24px box — the button measured the same as its neighbours while
                reading taller than them. */}
            <span
              title={`Close ${agent.name} — ends the process and archives the agent`}
              style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 0 }}
            >
              <Icon name="x" />
            </span>
          </PixelButton>
        )}
      </div>
    </div>
  );
}

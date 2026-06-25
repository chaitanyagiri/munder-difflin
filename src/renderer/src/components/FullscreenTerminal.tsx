import { useEffect } from 'react';
import { PixelBadge } from './PixelBadge';
import { PixelButton } from './PixelButton';
import { PtyTerminalView } from './PtyTerminalView';
import { MessageQueueComposer } from './MessageQueueComposer';
import { disposeTerminal } from './terminalPool';
import { Icon } from './Icon';
import { SpritePortrait } from './SpritePortrait';
import { RealtimeMichaelToggle } from './RealtimeMichaelToggle';
import { CostHud } from '@/realtime/CostHud';
import { useStore, type Agent } from '@/store/store';
import { usePtyParser } from '@/hooks/usePtyParser';

export function FullscreenTerminal() {
  const agents = useStore(s => s.agents);
  const fullscreenAgentId = useStore(s => s.fullscreenAgentId);
  const setFullscreen = useStore(s => s.setFullscreen);
  const select = useStore(s => s.select);
  const setAddAgentOpen = useStore(s => s.setAddAgentOpen);
  const archiveAgent = useStore(s => s.archiveAgent);
  const updateAgent = useStore(s => s.updateAgent);

  const agent = agents.find(a => a.id === fullscreenAgentId);
  const parser = usePtyParser(agent?.id ?? '__none__');

  // Esc exits fullscreen
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setFullscreen(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setFullscreen]);

  if (!agent || !agent.ptyId) {
    // Bail out — no real agent to show
    setFullscreen(null);
    return null;
  }

  const onKill = async () => {
    if (!agent.ptyId) return;
    if (!confirm(`Close ${agent.name}? The PTY process will terminate and the agent is archived (kept in history, off the floor).`)) return;
    await window.cth.killPty(agent.ptyId);
    disposeTerminal(agent.ptyId);
    archiveAgent(agent.id);
    setFullscreen(null);
  };

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
          borderBottom: '2px solid var(--cth-ink-900)',
          display: 'flex', alignItems: 'center',
          paddingLeft: 96, paddingRight: 12, gap: 12,
          userSelect: 'none'
        }}
      >
        <span style={{
          fontFamily: 'var(--cth-font-display)', fontSize: 12, lineHeight: '20px',
          color: 'var(--cth-ink-900)'
        }}>MUNDER DIFFLIN · FULLSCREEN</span>
      </div>

      {/* Tabs row — the agent tabs scroll in their own track (scrollbar hidden
          via .cth-tabbar) so the kill / exit controls stay pinned and aligned at
          the right edge instead of being crowded off when many agents are open. */}
      <div style={{
        display: 'flex', alignItems: 'flex-end', gap: 8,
        padding: '8px 12px 0',
        background: 'var(--cth-cream-200)',
        borderBottom: '2px solid var(--cth-ink-900)'
      }}>
        <div className="cth-tabbar" style={{
          flex: 1, minWidth: 0, display: 'flex', alignItems: 'flex-end', gap: 4, overflowX: 'auto'
        }}>
          {agents.map(a => (
            <Tab
              key={a.id}
              agent={a}
              active={a.id === agent.id}
              onClick={() => { select(a.id); setFullscreen(a.id); }}
            />
          ))}
          <button
            onClick={() => setAddAgentOpen(true)}
            title="Add agent"
            style={{
              height: 32, padding: '0 10px', marginBottom: 4, flexShrink: 0,
              background: 'var(--cth-cream-100)',
              border: 'none',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
              fontFamily: 'var(--cth-font-ui)', fontSize: 14,
              color: 'var(--cth-ink-900)',
              display: 'inline-flex', alignItems: 'center', gap: 4,
              cursor: 'pointer'
            }}
          >
            <Icon name="plus" /> agent
          </button>
        </div>
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, paddingBottom: 6 }}>
          {/* Voice toggle relocates here when Michael (the god) is fullscreen, so the
              mic stays reachable while the card behind the overlay is hidden. */}
          {agent.isGod && <RealtimeMichaelToggle />}
          {/* rt-9 cost HUD (spend cap + live $ meter) sits by the voice toggle in the
              roomy fullscreen header — the primary voice UX surface. */}
          {agent.isGod && <CostHud />}
          {agent.isGod && <CostHud compact />}
          <PixelButton variant="destructive" size="sm" onClick={onKill}>
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              <Icon name="x" /> kill
            </span>
          </PixelButton>
          <PixelButton variant="secondary" size="sm" onClick={() => setFullscreen(null)}>
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              <Icon name="minimize" /> exit (esc)
            </span>
          </PixelButton>
        </div>
      </div>

      {/* Body */}
      <div style={{
        flex: 1, minHeight: 0,
        display: 'flex', flexDirection: 'column',
        padding: 12, gap: 10
      }}>
        <Header agent={agent} />

        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            <PtyTerminalView
              key={agent.ptyId}
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
      </div>
    </div>
  );
}

function Tab({ agent, active, onClick }: { agent: Agent; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={`${agent.name} · ${agent.project}`}
      style={{
        height: active ? 38 : 32,
        padding: '0 10px',
        marginBottom: active ? 0 : 4,
        background: active ? 'var(--cth-cream-100)' : 'var(--cth-cream-300)',
        border: 'none',
        boxShadow: active
          ? 'inset 0 0 0 2px var(--cth-ink-900), inset 0 -3px 0 var(--cth-cream-100)'
          : 'inset 0 0 0 1px var(--cth-ink-700)',
        display: 'inline-flex', alignItems: 'center', gap: 8,
        cursor: 'pointer',
        position: 'relative',
        fontFamily: 'var(--cth-font-ui)', fontSize: 14,
        color: 'var(--cth-ink-900)',
        maxWidth: 240,
        whiteSpace: 'nowrap'
      }}
    >
      <div style={{
        width: 20, height: 32,
        background: `var(--cth-${agent.accent}-light)`,
        boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        overflow: 'hidden'
      }}>
        <SpritePortrait character={agent.character} scale={1} />
      </div>
      <span style={{
        overflow: 'hidden', textOverflow: 'ellipsis',
        fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px'
      }}>{agent.name.toUpperCase()}</span>
      <PixelBadge status={agent.status} />
    </button>
  );
}

function Header({ agent }: { agent: Agent }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '6px 10px',
      background: 'var(--cth-cream-50)',
      boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)'
    }}>
      <span style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '16px',
        color: 'var(--cth-ink-900)'
      }}>{agent.name.toUpperCase()}</span>
      <span style={{
        fontSize: 13, color: 'var(--cth-ink-500)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        maxWidth: 300
      }}>{agent.cwd}</span>
      <span style={{
        fontSize: 13, color: 'var(--cth-ink-700)',
        fontStyle: 'italic'
      }}>“{agent.description}”</span>
      <div style={{ marginLeft: 'auto' }}>
        <PixelBadge status={agent.status} />
      </div>
    </div>
  );
}

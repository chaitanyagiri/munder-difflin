import { AgentCard } from './AgentCard';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useStore } from '@/store/store';

export function AgentStrip() {
  const agents = useStore(s => s.agents);
  const selectedId = useStore(s => s.selectedId);
  const select = useStore(s => s.select);
  const setAddAgentOpen = useStore(s => s.setAddAgentOpen);

  return (
    <div style={{
      display: 'flex',
      gap: 12,
      padding: '12px 16px',
      overflowX: 'auto',
      overflowY: 'hidden',
      borderTop: '2px solid var(--cth-ink-900)',
      background: 'var(--cth-cream-200)',
      height: 124,
      minHeight: 124,
      alignItems: 'center'
    }}>
      {agents.map(a => (
        <AgentCard
          key={a.id}
          name={a.name}
          character={a.character}
          accent={a.accent}
          status={a.status}
          project={a.project}
          action={a.action}
          progress={a.progress}
          contextTokens={a.contextTokens}
          contextLimit={a.contextLimit}
          selected={a.id === selectedId}
          isGod={a.isGod}
          isAssistant={a.isAssistant}
          onClick={() => select(a.id)}
        />
      ))}
      <PixelButton
        variant="secondary"
        size="lg"
        style={{ alignSelf: 'center' }}
        onClick={() => setAddAgentOpen(true)}
      >
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <Icon name="plus" /> add agent
        </span>
      </PixelButton>
    </div>
  );
}

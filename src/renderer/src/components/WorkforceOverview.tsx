import { useStore } from '@/store/store';
import { AgentBadge } from './AgentBadge';
import { StatusBadge } from './StatusBadge';

/** A DOM-only workforce overview that keeps live worker state visible without a scene renderer. */
export function WorkforceOverview() {
  const agents = useStore((s) => s.agents);
  const selectAgent = useStore((s) => s.select);

  return (
    <section aria-label="Workforce overview" style={{ height: '100%', overflow: 'auto', padding: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
        {agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            onClick={() => selectAgent(agent.id)}
            style={{
              border: '1px solid var(--cth-ink-300)', background: 'var(--cth-cream-50)',
              padding: 12, textAlign: 'left', cursor: 'pointer', display: 'flex', gap: 10,
            }}
          >
            <AgentBadge name={agent.name} accent={agent.accent} size={36} />
            <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent.name}</strong>
                <StatusBadge status={agent.status} />
              </span>
              <span style={{ fontSize: 12, color: 'var(--cth-ink-700)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {agent.action || agent.description}
              </span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

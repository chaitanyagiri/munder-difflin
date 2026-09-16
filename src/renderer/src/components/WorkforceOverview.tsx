import { useStore } from '@/store/store';
import { AgentBadge } from './AgentBadge';
import { StatusBadge } from './StatusBadge';
import { CompanyChat } from './CompanyChat';
import { TradingOverview } from './TradingOverview';

const surface = {
  background: 'var(--cth-paper-100)',
  border: '1px solid var(--cth-ink-300)',
  borderRadius: 10,
};

/** Main dashboard: the trading desk — live Kalshi signals, the market
 *  leaderboard, the company's actual chat pipeline, and the workforce roster. */
export function WorkforceOverview() {
  const agents = useStore((s) => s.agents);
  const selectedId = useStore((s) => s.selectedId);
  const selectAgent = useStore((s) => s.select);

  return (
    <main aria-label="Company dashboard" className="md-dashboard">
      <div className="md-dashboard-inner">
        <header className="md-dashboard-heading">
          <div><span className="md-eyebrow">Munder Difflin</span><h1>Trading desk</h1></div>
          <span className="md-dashboard-caption">Research, capital, and company conversation</span>
        </header>

        <TradingOverview />

        <section aria-label="Company workspace" className="md-workspace">
          <section aria-label="Workforce" style={{ ...surface, minWidth: 0, minHeight: 0, padding: 6, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '6px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0, fontSize: 12, fontWeight: 700, color: 'var(--cth-ink-900)' }}>Workforce</h2>
              <span style={{ fontSize: 11, color: 'var(--cth-ink-500)', fontVariantNumeric: 'tabular-nums' }}>{agents.length}</span>
            </div>
            <div className="md-workforce-list">
              {agents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => selectAgent(agent.id)}
                  aria-pressed={agent.id === selectedId}
                  title={`Select ${agent.name} for terminal focus mode`}
                  style={{
                    border: 'none', borderRadius: 7, padding: '6px 7px', cursor: 'pointer', textAlign: 'left',
                    background: agent.id === selectedId ? 'var(--cth-sky-light)' : 'transparent',
                    display: 'grid', gridTemplateColumns: '24px minmax(0, 1fr) auto',
                    alignItems: 'center', gap: 7,
                    transition: 'background 140ms ease',
                  }}
                >
                  <AgentBadge name={agent.name} accent={agent.accent} size={20} />
                  <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                    <strong style={{ fontSize: 11, lineHeight: '14px', color: 'var(--cth-ink-900)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{agent.name}</strong>
                    <span style={{ fontSize: 10, lineHeight: '13px', color: 'var(--cth-ink-500)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{agent.action || agent.description}</span>
                  </span>
                  <StatusBadge status={agent.status} />
                </button>
              ))}
            </div>
          </section>

          <section aria-label="Company chat" style={{ ...surface, minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{
              padding: '8px 12px', borderBottom: '1px solid var(--cth-ink-100)',
              display: 'flex', alignItems: 'baseline', gap: 8,
            }}>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--cth-ink-900)' }}>Company chat</h2>
              <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>One conversation for the whole team</span>
            </div>
            <CompanyChat />
          </section>
        </section>
      </div>
    </main>
  );
}

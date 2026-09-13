import { useMemo } from 'react';
import { useStore } from '@/store/store';
import { AgentBadge } from './AgentBadge';
import { MessageQueueComposer } from './MessageQueueComposer';
import { StatusBadge } from './StatusBadge';

const surface = {
  background: 'color-mix(in srgb, var(--cth-paper-100) 94%, white)',
  border: '1px solid color-mix(in srgb, var(--cth-ink-300) 72%, transparent)',
  borderRadius: 12,
  boxShadow: '0 12px 30px color-mix(in srgb, var(--cth-ink-900) 10%, transparent)',
};

/** Main SaaS dashboard: operating signals, workforce routing, and the live message queue. */
export function WorkforceOverview() {
  const agents = useStore((s) => s.agents);
  const selectedId = useStore((s) => s.selectedId);
  const selectAgent = useStore((s) => s.select);
  const queues = useStore((s) => s.messageQueues);
  const activeAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? agents.find((agent) => agent.isGod) ?? agents[0],
    [agents, selectedId],
  );
  const activeCount = agents.filter((agent) => !['idle', 'success', 'error'].includes(agent.status)).length;
  const queuedCount = Object.values(queues).reduce((total, queue) => total + queue.length, 0);

  return (
    <main aria-label="Company dashboard" style={{ height: '100%', overflow: 'auto', padding: '24px clamp(16px, 3vw, 36px)' }}>
      <div style={{ maxWidth: 1440, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'end', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <p style={{ margin: 0, color: 'var(--cth-ink-500)', fontSize: 13, fontWeight: 600, letterSpacing: '.02em' }}>Munder Difflin · operations</p>
            <h1 style={{ margin: '5px 0 0', color: 'var(--cth-ink-900)', fontSize: 'clamp(24px, 3vw, 36px)', lineHeight: 1.08, letterSpacing: '-.045em', fontWeight: 700 }}>The work, without the theatre.</h1>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--cth-ink-700)', fontSize: 13 }}>
            <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: activeCount ? 'var(--cth-mint)' : 'var(--cth-ink-300)', boxShadow: activeCount ? '0 0 0 4px color-mix(in srgb, var(--cth-mint) 18%, transparent)' : undefined }} />
            {activeCount ? `${activeCount} working now` : 'No active work'}
          </div>
        </header>

        <section aria-label="Operating metrics" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
          <Metric label="Workforce" value={agents.length} detail="connected agents" />
          <Metric label="In progress" value={activeCount} detail="active tasks" accent="var(--cth-mint)" />
          <Metric label="Queued chat" value={queuedCount} detail="messages waiting" accent="var(--cth-sky)" />
          <Metric label="Attention" value={agents.filter((agent) => agent.status === 'blocked').length} detail="blocked agents" accent="var(--cth-coral)" />
        </section>

        <section aria-label="Operations workspace" style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, .72fr) minmax(0, 1.28fr)', gap: 16, minHeight: 480 }}>
          <section aria-label="Workforce" style={{ ...surface, minWidth: 0, padding: 8, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '12px 12px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 14, color: 'var(--cth-ink-900)', fontWeight: 700 }}>Workforce</h2>
                <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--cth-ink-500)' }}>Choose a teammate to open their channel.</p>
              </div>
              <span style={{ fontSize: 12, color: 'var(--cth-ink-500)', fontVariantNumeric: 'tabular-nums' }}>{agents.length}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto', padding: 4 }}>
              {agents.map((agent) => {
                const selected = agent.id === activeAgent?.id;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => selectAgent(agent.id)}
                    aria-pressed={selected}
                    style={{
                      border: 'none', borderRadius: 9, padding: 10, cursor: 'pointer', textAlign: 'left',
                      background: selected ? 'color-mix(in srgb, var(--cth-sky-light) 74%, white)' : 'transparent',
                      boxShadow: selected ? 'inset 0 0 0 1px color-mix(in srgb, var(--cth-sky) 45%, transparent)' : undefined,
                      display: 'grid', gridTemplateColumns: '32px minmax(0, 1fr) auto', alignItems: 'center', gap: 9,
                      transition: 'background 180ms ease, transform 180ms ease',
                    }}
                  >
                    <AgentBadge name={agent.name} accent={agent.accent} size={30} />
                    <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <strong style={{ fontSize: 13, color: 'var(--cth-ink-900)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{agent.name}</strong>
                      <span style={{ fontSize: 11, color: 'var(--cth-ink-500)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{agent.action || agent.description}</span>
                    </span>
                    <StatusBadge status={agent.status} />
                  </button>
                );
              })}
            </div>
          </section>

          <section aria-label="Team chat" style={{ ...surface, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {activeAgent ? (
              <>
                <div style={{ padding: '16px 18px', borderBottom: '1px solid color-mix(in srgb, var(--cth-ink-300) 65%, transparent)', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <AgentBadge name={activeAgent.name} accent={activeAgent.accent} size={36} />
                  <div style={{ minWidth: 0 }}>
                    <h2 style={{ margin: 0, fontSize: 15, color: 'var(--cth-ink-900)', fontWeight: 700 }}>Chat with {activeAgent.name}</h2>
                    <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--cth-ink-500)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{activeAgent.action || 'Ready for direction'}</p>
                  </div>
                  <span style={{ marginLeft: 'auto' }}><StatusBadge status={activeAgent.status} /></span>
                </div>
                <div style={{ flex: 1, minHeight: 160, padding: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--cth-ink-500)', fontSize: 13, textAlign: 'center' }}>
                  Use the message box below to queue work, ask for an update, or attach a file. Delivery follows the agent’s terminal state.
                </div>
                <MessageQueueComposer agent={activeAgent} />
              </>
            ) : (
              <div style={{ height: '100%', display: 'grid', placeItems: 'center', padding: 24, color: 'var(--cth-ink-500)', textAlign: 'center' }}>Hire an agent to open a team channel.</div>
            )}
          </section>
        </section>
      </div>
    </main>
  );
}

function Metric({ label, value, detail, accent }: { label: string; value: number; detail: string; accent?: string }) {
  return (
    <article style={{ ...surface, padding: '15px 16px', position: 'relative', overflow: 'hidden' }}>
      {accent && <span aria-hidden="true" style={{ position: 'absolute', inset: '0 auto 0 0', width: 3, background: accent }} />}
      <p style={{ margin: 0, fontSize: 12, color: 'var(--cth-ink-500)', fontWeight: 600 }}>{label}</p>
      <strong style={{ display: 'block', marginTop: 6, fontSize: 27, lineHeight: 1, letterSpacing: '-.04em', color: 'var(--cth-ink-900)', fontVariantNumeric: 'tabular-nums' }}>{value}</strong>
      <span style={{ display: 'block', marginTop: 5, fontSize: 12, color: 'var(--cth-ink-500)' }}>{detail}</span>
    </article>
  );
}

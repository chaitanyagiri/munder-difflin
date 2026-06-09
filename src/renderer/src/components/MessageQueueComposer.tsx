import { KeyboardEvent, useState } from 'react';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useStore, type Agent, type QueuedMessage } from '@/store/store';

const EMPTY_QUEUE: QueuedMessage[] = [];

// Prepended (only to the enqueued value, never the visible draft) when the
// god/Michael agent has the "Delegate to agents" toggle ON.
const DELEGATE_PREFIX =
  "Delegate to other available agents as mentioned if no agents available do it yourself one by one the user's message starts now: ";

export interface MessageQueueComposerProps {
  agent: Agent;
}

/**
 * Lets the user keep messaging an agent whose terminal is mid-run. Typed
 * messages park in a per-agent queue and are submitted to the agent's Claude
 * TUI one-by-one as soon as it goes idle (see useHive's flush loop).
 */
export function MessageQueueComposer({ agent }: MessageQueueComposerProps) {
  const queue = useStore((s) => s.messageQueues[agent.id]) ?? EMPTY_QUEUE;
  const enqueueMessage = useStore((s) => s.enqueueMessage);
  const removeQueuedMessage = useStore((s) => s.removeQueuedMessage);
  const clearQueue = useStore((s) => s.clearQueue);

  // Draft lives in the store, keyed by agent — switching agents remounts this
  // component, and component-local state would silently eat the typed text.
  const text = useStore((s) => s.drafts[agent.id] ?? '');
  const setDraft = useStore((s) => s.setDraft);
  const setText = (t: string) => setDraft(agent.id, t);

  const idle = agent.status === 'idle';

  // Only the god/Michael agent gets the delegation toggle. Default OFF.
  const [delegate, setDelegate] = useState(false);

  const queueIt = () => {
    if (!text.trim()) return;
    const out = delegate ? DELEGATE_PREFIX + text : text;
    enqueueMessage(agent.id, out);
    setText('');
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      queueIt();
    }
  };

  const statusHint = queue.length === 0
    ? null
    : idle
    ? `sending to ${agent.name} one-by-one…`
    : `${agent.name} is busy — ${queue.length} queued`;

  return (
    <div style={{
      flexShrink: 0,
      borderTop: '1px solid var(--cth-ink-700)',
      background: 'var(--cth-cream-100)',
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      padding: 8
    }}>
      {/* Header: label, count, status, clear-all */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          fontFamily: 'var(--cth-font-display)',
          fontSize: 9, lineHeight: '12px',
          color: 'var(--cth-ink-700)'
        }}>QUEUE</span>
        {queue.length > 0 && (
          <span style={{
            fontSize: 11, padding: '1px 6px 0',
            background: 'var(--cth-cream-200)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
            fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-900)'
          }}>{queue.length}</span>
        )}
        {statusHint && (
          <span style={{
            fontSize: 12,
            color: idle ? 'var(--cth-ink-700)' : 'var(--cth-ink-500)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
          }}>{statusHint}</span>
        )}
        {queue.length > 1 && (
          <button
            onClick={() => clearQueue(agent.id)}
            title="Clear all queued messages"
            style={{
              marginLeft: 'auto',
              border: 'none', background: 'transparent', cursor: 'pointer',
              fontFamily: 'var(--cth-font-ui)', fontSize: 12,
              color: 'var(--cth-ink-500)'
            }}
          >clear all</button>
        )}
      </div>

      {/* Pending list */}
      {queue.length > 0 && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 4,
          maxHeight: 132, overflowY: 'auto'
        }}>
          {queue.map((m, i) => (
            <div key={m.id} style={{
              display: 'flex', alignItems: 'flex-start', gap: 6,
              padding: '4px 6px',
              background: 'var(--cth-paper-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
            }}>
              <span style={{
                fontFamily: 'var(--cth-font-mono)', fontSize: 12,
                color: 'var(--cth-ink-500)', lineHeight: '18px', flexShrink: 0
              }}>{`${i + 1}.`}</span>
              <div
                title={m.text}
                style={{
                  flex: 1, minWidth: 0,
                  fontSize: 13, lineHeight: '18px',
                  color: 'var(--cth-ink-900)',
                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                  overflow: 'hidden', whiteSpace: 'pre-wrap', wordBreak: 'break-word'
                }}
              >{m.text}</div>
              <button
                onClick={() => removeQueuedMessage(agent.id, m.id)}
                title="Remove from queue"
                style={{
                  flexShrink: 0, border: 'none', background: 'transparent',
                  cursor: 'pointer',
                  color: 'var(--cth-ink-500)', padding: 0,
                  display: 'inline-flex', alignItems: 'center'
                }}
              >
                <Icon name="x" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Composer */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          rows={2}
          placeholder={idle ? `Message ${agent.name}` : `${agent.name} is busy — queue a message`}
          style={{
            flex: 1,
            resize: 'none',
            padding: '6px 8px',
            background: 'var(--cth-paper-100)',
            border: 'none',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
            fontFamily: 'var(--cth-font-mono)',
            fontSize: 14, lineHeight: '18px',
            color: 'var(--cth-ink-900)',
            outline: 'none'
          }}
        />
        {agent.isGod && (
          <PixelButton
            variant={delegate ? 'primary' : 'secondary'}
            size="md"
            onClick={() => setDelegate((d) => !d)}
            title="Prepend a delegation instruction so Michael hands the task to other available agents (or does it himself one-by-one if none are free)."
          >
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              {delegate && <Icon name="check" />} Delegate
            </span>
          </PixelButton>
        )}
        <PixelButton variant="primary" size="md" onClick={queueIt} disabled={!text.trim()}>
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            send <Icon name="arrow-right" />
          </span>
        </PixelButton>
      </div>
    </div>
  );
}

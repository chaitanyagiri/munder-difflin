import { KeyboardEvent, useState } from 'react';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useStore, type Agent, type QueuedMessage } from '@/store/store';
import { freeflowRecorder, useFreeflow } from '@/freeflow/recorder';

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

  // Free Flow voice dictation (entry point A). The mic button shows only when the
  // feature is enabled in Settings; a transcript is appended to this draft for
  // review before sending (never auto-sent).
  const freeflowEnabled = useStore((s) => s.freeflowEnabled);
  const ff = useFreeflow();
  const ffMine = ff.targetAgentId === agent.id;
  const ffHint = !freeflowEnabled
    ? null
    : ffMine && ff.status === 'recording'
    ? '● recording — click stop to transcribe'
    : ffMine && ff.status === 'transcribing'
    ? 'transcribing…'
    : ff.error && (ffMine || ff.targetAgentId === null)
    ? `voice: ${ff.error}`
    : null;

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

      {/* Free Flow recording / transcription status (entry point A) */}
      {ffHint && (
        <span style={{
          fontSize: 12, lineHeight: '16px',
          color: ff.error && !(ffMine && ff.status !== 'idle') ? 'var(--cth-coral)' : 'var(--cth-ink-500)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
        }}>{ffHint}</span>
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
        {/* Right column: Delegate toggle (god only) + Free Flow mic stacked ABOVE Send. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'stretch' }}>
          {agent.isGod && (
            <DelegateSwitch on={delegate} onToggle={() => setDelegate((d) => !d)} />
          )}
          {freeflowEnabled && <FreeFlowButton agentId={agent.id} />}
          <PixelButton variant="primary" size="md" onClick={queueIt} disabled={!text.trim()}>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              send <Icon name="arrow-right" />
            </span>
          </PixelButton>
        </div>
      </div>
    </div>
  );
}

/**
 * A pixel-style toggle switch for the god/Michael delegation flag. ON prepends
 * DELEGATE_PREFIX to the enqueued message so Michael fans the task out to other
 * available agents (or does it himself one-by-one if none are free).
 */
function DelegateSwitch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      title="When ON, Michael hands the task to other available agents (or does it himself one-by-one if none are free)."
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        padding: '3px 6px', border: 'none', cursor: 'pointer', background: 'transparent',
        fontFamily: 'var(--cth-font-ui)', fontSize: 12,
        color: on ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)'
      }}
    >
      <span>Delegate</span>
      {/* track */}
      <span style={{
        position: 'relative', flexShrink: 0, width: 28, height: 14,
        background: on ? 'var(--cth-lilac)' : 'var(--cth-cream-200)',
        boxShadow: `inset 0 0 0 1px ${on ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)'}`,
        transition: 'background 120ms ease'
      }}>
        {/* knob */}
        <span style={{
          position: 'absolute', top: 2, left: on ? 16 : 2, width: 10, height: 10,
          background: 'var(--cth-paper-100)',
          boxShadow: '0 0 0 1px var(--cth-ink-900)',
          transition: 'left 120ms ease'
        }} />
      </span>
    </button>
  );
}

/**
 * Push-to-talk button for the queue composer. Click to start recording, click
 * again to stop → transcribe → the text is appended to this agent's draft. While
 * another agent is mid-dictation it's disabled (one shared recorder). The actual
 * capture + Groq call live in the freeflow recorder singleton.
 */
function FreeFlowButton({ agentId }: { agentId: string }) {
  const ff = useFreeflow();
  const mine = ff.targetAgentId === agentId;
  const recording = ff.status === 'recording' && mine;
  const transcribing = ff.status === 'transcribing' && mine;
  // Block while another agent's clip is recording/uploading (single recorder).
  const busyElsewhere = ff.status !== 'idle' && !mine;
  return (
    <PixelButton
      variant={recording ? 'destructive' : 'secondary'}
      size="md"
      onClick={() => freeflowRecorder.toggle(agentId)}
      disabled={transcribing || busyElsewhere}
    >
      <span
        title={
          recording ? 'Stop & transcribe'
          : transcribing ? 'Transcribing…'
          : 'Free Flow — dictate into the queue (push to talk)'
        }
        style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}
      >
        <Icon name="mic" />
        {transcribing ? '…' : recording ? 'stop' : 'voice'}
      </span>
    </PixelButton>
  );
}

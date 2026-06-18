import { ClipboardEvent, DragEvent, KeyboardEvent, useState } from 'react';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useStore, type Agent, type QueuedMessage } from '@/store/store';
import { freeflowRecorder, useFreeflow } from '@/freeflow/recorder';

const EMPTY_QUEUE: QueuedMessage[] = [];

/** A file/image attached to the draft. Travels to the agent as a PATH it Reads. */
interface Attachment {
  path: string;
  name: string;
}

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
  // review before sending (never auto-sent). When enabled but no Groq key is set,
  // the button stays VISIBLE but DISABLED with a tooltip pointing to Settings
  // (hasGroqKey is boolean presence only — the key value never reaches the store).
  const freeflowEnabled = useStore((s) => s.freeflowEnabled);
  const hasGroqKey = useStore((s) => s.hasGroqKey);
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

  // Files/images staged for the next message. Component-local: switching agents
  // remounts this component, so attachments are cleared on tab switch (drafts
  // persist in the store, attachments deliberately don't carry over).
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const addAttachments = (incoming: Attachment[]) =>
    setAttachments((prev) => {
      const seen = new Set(prev.map((a) => a.path));
      const fresh = incoming.filter((a) => a.path && !seen.has(a.path));
      return fresh.length ? [...prev, ...fresh] : prev;
    });

  const removeAttachment = (path: string) =>
    setAttachments((prev) => prev.filter((a) => a.path !== path));

  // '+' button → OS picker (images group + all files).
  const pickFiles = async () => {
    const res = await window.cth.attachFiles();
    if (res.ok) addAttachments(res.files);
  };

  // Drop files onto the composer → resolve each to its absolute path.
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = Array.from(e.dataTransfer?.files ?? []);
    if (!dropped.length) return;
    const atts = dropped
      .map((f) => ({ path: window.cth.pathForFile(f), name: f.name }))
      .filter((a) => a.path);
    if (atts.length) addAttachments(atts);
  };

  // Paste a screenshot (no path → persist the native clipboard image to a temp
  // file) or paste files copied from the OS file manager (carry a real path).
  const onPaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const hasImage = items.some((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (hasImage) {
      e.preventDefault();
      const res = await window.cth.saveClipboardImage();
      if (res.ok) addAttachments([res.file]);
      return;
    }
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length) {
      const atts = files
        .map((f) => ({ path: window.cth.pathForFile(f), name: f.name }))
        .filter((a) => a.path);
      if (atts.length) {
        e.preventDefault();
        addAttachments(atts);
      }
    }
  };

  const canSend = !!text.trim() || attachments.length > 0;

  const queueIt = () => {
    if (!canSend) return;
    // Prepend an "Attached files:" block using the same path-based convention as
    // the Slack inbound path (useHive.ts) so agents Read the files directly.
    const body = attachments.length
      ? (text.trim()
          ? `${text}\n\nAttached files:\n`
          : 'Attached files:\n') + attachments.map((a) => `- ${a.path} (${a.name})`).join('\n')
      : text;
    const out = delegate ? DELEGATE_PREFIX + body : body;
    enqueueMessage(agent.id, out);
    setText('');
    setAttachments([]);
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
    <div
      onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
      onDragLeave={(e) => {
        // Only clear when the cursor actually leaves the composer, not on child enter.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragOver(false);
      }}
      onDrop={onDrop}
      style={{
        flexShrink: 0,
        borderTop: '1px solid var(--cth-ink-700)',
        background: 'var(--cth-cream-100)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: 8,
        boxShadow: dragOver ? 'inset 0 0 0 2px var(--cth-lilac)' : undefined
      }}>
      {dragOver && (
        <span style={{
          fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '12px',
          color: 'var(--cth-ink-700)', textAlign: 'center'
        }}>DROP TO ATTACH</span>
      )}
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
          maxHeight: 280, overflowY: 'auto'
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

      {/* Attached files/images — chips with a remove 'x', above the textarea. */}
      {attachments.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {attachments.map((a) => (
            <span
              key={a.path}
              title={a.path}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                maxWidth: '100%',
                padding: '2px 4px 2px 6px',
                background: 'var(--cth-cream-200)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
                fontFamily: 'var(--cth-font-mono)', fontSize: 12, lineHeight: '16px',
                color: 'var(--cth-ink-900)'
              }}
            >
              <Icon name="folder" />
              <span style={{
                overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', maxWidth: 180
              }}>{a.name}</span>
              <button
                onClick={() => removeAttachment(a.path)}
                title="Remove attachment"
                style={{
                  flexShrink: 0, border: 'none', background: 'transparent', cursor: 'pointer',
                  color: 'var(--cth-ink-500)', padding: 0,
                  display: 'inline-flex', alignItems: 'center'
                }}
              >
                <Icon name="x" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Composer — full-width input above a single tidy control bar (cc-ui-polish),
          with file/image attachment chips + paste-to-attach (rich-composer). */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          rows={5}
          placeholder={idle ? `Message ${agent.name}` : `${agent.name} is busy — queue a message`}
          style={{
            width: '100%',
            resize: 'vertical',
            minHeight: 96, maxHeight: 320,
            padding: '6px 8px',
            background: 'var(--cth-paper-100)',
            border: 'none',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
            fontFamily: 'var(--cth-font-mono)',
            fontSize: 13, lineHeight: '18px',
            color: 'var(--cth-ink-900)',
            outline: 'none',
            boxSizing: 'border-box'
          }}
        />
        {/* Control bar: Delegate (god only) left; Attach + voice + Send aligned right. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {agent.isGod && (
            <DelegateSwitch on={delegate} onToggle={() => setDelegate((d) => !d)} />
          )}
          <span style={{ flex: 1 }} />
          <PixelButton variant="secondary" size="sm" onClick={pickFiles}>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <Icon name="plus" /> files
            </span>
          </PixelButton>
          {freeflowEnabled && <FreeFlowButton agentId={agent.id} hasGroqKey={hasGroqKey} />}
          <PixelButton variant="primary" size="sm" onClick={queueIt} disabled={!canSend}>
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
 *
 * When no Groq key is configured the button stays visible but disabled, with a
 * tooltip pointing to Settings — it never starts a recording, so getUserMedia and
 * the Groq STT call are never reached (preserving the zero-call-when-unavailable
 * guarantee). `hasGroqKey` is boolean presence only; the key value never gets here.
 */
function FreeFlowButton({ agentId, hasGroqKey }: { agentId: string; hasGroqKey: boolean }) {
  const ff = useFreeflow();
  const mine = ff.targetAgentId === agentId;
  const recording = ff.status === 'recording' && mine;
  const transcribing = ff.status === 'transcribing' && mine;
  // Block while another agent's clip is recording/uploading (single recorder).
  const busyElsewhere = ff.status !== 'idle' && !mine;
  const noKey = !hasGroqKey;
  const title = noKey
    ? 'Add a Groq API key in Settings → Free Flow to use voice mode.'
    : recording ? 'Stop & transcribe'
    : transcribing ? 'Transcribing…'
    : 'Free Flow — dictate into the queue (push to talk)';
  // Wrap in a (non-disabled) span so the native title tooltip still shows on hover
  // even when the inner button is disabled — Chromium suppresses tooltips on a
  // disabled <button> itself.
  return (
    <span title={title} style={{ display: 'inline-flex' }}>
      <PixelButton
        variant={recording ? 'destructive' : 'secondary'}
        size="sm"
        onClick={() => { if (noKey) return; freeflowRecorder.toggle(agentId); }}
        disabled={noKey || transcribing || busyElsewhere}
      >
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <Icon name="mic" />
          {transcribing ? '…' : recording ? 'stop' : 'voice'}
        </span>
      </PixelButton>
    </span>
  );
}

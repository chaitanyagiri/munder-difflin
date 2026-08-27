import { ClipboardEvent, DragEvent, KeyboardEvent, type MouseEvent as ReactMouseEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useStore, type Agent, type QueuedMessage } from '@/store/store';
import { clearTerminalDraft, dismissTerminalPicker, terminalAutomationBlockFor } from './terminalPool';
import type { TerminalAutomationBlock } from './terminalAutomation';
import { freeflowRecorder, useFreeflow } from '@/freeflow/recorder';
import { useTerminalFontSize } from './terminalFontSize';
import { isComposingKey } from '@shared/imeGuard';
import { useRtl } from '@/i18n/useDirection';

const EMPTY_QUEUE: QueuedMessage[] = [];

/** A file/image attached to the draft. Travels to the agent as a PATH it Reads. */
interface Attachment {
  path: string;
  name: string;
}

// Prepended (only to the enqueued value, never the visible draft) when the

export interface MessageQueueComposerProps {
  agent: Agent;
}

/**
 * Lets the user keep messaging an agent whose terminal is mid-run. Typed
 * messages park in a per-agent queue and are submitted to the agent's Claude
 * TUI one-by-one as soon as it goes idle (see useHive's flush loop).
 */
export function MessageQueueComposer({ agent }: MessageQueueComposerProps) {
  const { t } = useTranslation();
  const rtl = useRtl();
  const queue = useStore((s) => s.messageQueues[agent.id]) ?? EMPTY_QUEUE;
  const enqueueMessage = useStore((s) => s.enqueueMessage);
  const removeQueuedMessage = useStore((s) => s.removeQueuedMessage);
  const releaseQueuedMessage = useStore((s) => s.releaseQueuedMessage);
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
    ? t('queueComposer.recording')
    : ffMine && ff.status === 'transcribing'
    ? t('queueComposer.transcribing')
    : ff.error && (ffMine || ff.targetAgentId === null)
    ? `${t('queueComposer.voice')}: ${ff.error}`
    : null;

  // The draft box is the terminal's twin — it should read at the same size the
  // agent's output does, at every zoom level.
  const composerFontSize = useTerminalFontSize();
  const composerLineHeight = Math.round(composerFontSize * 1.4);

  const idle = agent.status === 'idle';

  // Only the god/Michael agent gets the delegation toggle. Default OFF.

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
    enqueueMessage(agent.id, body);
    // Counted HERE, at the composer's submit, and NOT inside enqueueMessage:
    // that store action is also how work orders, Slack inbound, nudges and
    // compact commands reach an agent, and none of those is a person sending a
    // message. Past the isComposingKey guard in onKey, so an IME candidate
    // Enter never counts. (TELEMETRY.md → message_sent)
    void window.cth.trackMessageSent('composer');
    setText('');
    setAttachments([]);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposingKey(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      queueIt();
    }
  };

  // Delivery can be held back by the agent's own terminal (a half-typed draft or
  // an open slash-command picker owns the prompt). That used to be invisible —
  // the hint claimed it was sending while nothing moved — so poll it and say so.
  const block = useTerminalBlock(agent.ptyId, queue.length > 0 && idle);

  // Floor-wide auto-delivery pause (Command Center switch) also holds the queue.
  // Without saying so — and without the per-row "send now" override — messages
  // look permanently stuck with no explanation and no escape hatch.
  const deliveryPaused = useDeliveryPaused(agent.id, queue.length > 0);

  const statusHint = queue.length === 0
    ? null
    : !idle
    ? t('queueComposer.busyQueued', { name: agent.name, count: queue.length })
    : deliveryPaused && !queue[0]?.manual
    ? t('queueComposer.heldFloor')
    : block === 'draft'
    ? t('queueComposer.heldDraft', { name: agent.name })
    : block === 'picker'
    ? t('queueComposer.heldPicker', { name: agent.name })
    : block === 'exited'
    ? t('queueComposer.heldExited', { name: agent.name })
    : t('queueComposer.sendingOneByOne', { name: agent.name });

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
        }}>{t('queueComposer.dropToAttach')}</span>
      )}
      {/* Header: label, count, status, clear-all */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          fontFamily: 'var(--cth-font-display)',
          fontSize: 9, lineHeight: '12px',
          color: 'var(--cth-ink-700)'
        }}>{t('queueComposer.queue')}</span>
        {queue.length > 0 && (
          <span style={{
            fontSize: 11, padding: '1px 6px 0',
            background: 'var(--cth-cream-200)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
            fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-900)'
          }}>{queue.length}</span>
        )}
        {statusHint && (
          <span
            title={deliveryPaused && !queue[0]?.manual
              ? t('queueComposer.pausedTitle')
              : statusHint}
            style={{
              fontSize: 12,
              color: idle ? 'var(--cth-ink-700)' : 'var(--cth-ink-500)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
            }}
          >{statusHint}</span>
        )}
        {(block === 'draft' || block === 'picker') && agent.ptyId && (
          <button
            onClick={() => {
              // A picker and a draft are unblocked by different keys: Escape
              // closes the picker, Ctrl-U kills the input line. Sending Ctrl-U
              // at a picker leaves it open while telling automation the prompt
              // is free, which is how a queued message ends up typed into a
              // menu and marked delivered.
              if (block === 'picker') { dismissTerminalPicker(agent.ptyId!); return; }
              // Keep whatever was on the prompt — it lands in this composer so
              // the user can send it properly instead of losing it to Ctrl-U.
              const discarded = clearTerminalDraft(agent.ptyId!);
              if (discarded.trim()) setText(text ? `${text}\n${discarded}` : discarded);
            }}
            title={block === 'picker'
              ? "Close the picker this agent has open so queued messages can be delivered"
              : "Move the leftover text on this agent's prompt into this box so queued messages can be delivered"}
            style={{
              border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
              fontFamily: 'var(--cth-font-ui)', fontSize: 12,
              color: 'var(--cth-ink-900)', textDecoration: 'underline'
            }}
          >{block === 'picker' ? t('queueComposer.closePicker') : t('queueComposer.recoverPrompt')}</button>
        )}
        {queue.length > 1 && (
          <button
            onClick={() => clearQueue(agent.id)}
            title={t('queueComposer.clearAllTitle')}
            style={{
              marginLeft: 'auto', flexShrink: 0, whiteSpace: 'nowrap',
              border: 'none', background: 'transparent', cursor: 'pointer',
              fontFamily: 'var(--cth-font-ui)', fontSize: 12,
              color: 'var(--cth-ink-500)'
            }}
          >{t('queueComposer.clearAll')}</button>
        )}
      </div>

      {/* Pending list */}
      {queue.length > 0 && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 4,
          maxHeight: 280, overflowY: 'auto'
        }}>
          {queue.map((m, i) => (
            <QueuedMessageRow
              key={m.id}
              index={i}
              message={m}
              paused={deliveryPaused}
              onSendNow={() => releaseQueuedMessage(agent.id, m.id)}
              onRemove={() => removeQueuedMessage(agent.id, m.id)}
            />
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
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
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
                title={t('queueComposer.removeAttachment')}
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
          dir={rtl ? 'auto' : undefined}
          className="cth-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          rows={5}
          placeholder={idle ? t('queueComposer.messagePlaceholder', { name: agent.name }) : t('queueComposer.busyPlaceholder', { name: agent.name })}
          style={{
            width: '100%',
            resize: 'vertical',
            // Track the terminal's zoom (Cmd +/- or the terminal's own zoom
            // buttons) instead of a hardcoded 13px. On a large display the
            // terminal text scaled up while this box stayed tiny; box height is
            // derived from the same size so the visible line count is stable.
            minHeight: composerLineHeight * 5 + 14,
            maxHeight: composerLineHeight * 18,
            padding: '6px 8px',
            background: 'var(--cth-paper-100)',
            border: 'none',
            // Border lives in .cth-input so :focus can change it — an inline
            // boxShadow here would outrank the stylesheet and the focus state
            // would silently never apply.
            fontFamily: 'var(--cth-font-mono)',
            fontSize: composerFontSize, lineHeight: `${composerLineHeight}px`,
            color: 'var(--cth-ink-900)',
            outline: 'none',
            boxSizing: 'border-box'
          }}
        />
        {/* Control bar: Attach + voice + Send aligned right. flexWrap so a
            narrow sidebar wraps the buttons onto a second row instead of
            pushing Send off-screen. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, rowGap: 6, flexWrap: 'wrap', minWidth: 0 }}>
          <span style={{ flex: 1 }} />
          <PixelButton variant="secondary" size="sm" onClick={pickFiles}>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <Icon name="plus" /> {t('queueComposer.files')}
            </span>
          </PixelButton>
          {freeflowEnabled && <FreeFlowButton agentId={agent.id} hasGroqKey={hasGroqKey} />}
          <PixelButton variant="primary" size="sm" onClick={queueIt} disabled={!canSend}>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              {t('commandBar.send')} <Icon name="arrow-right" />
            </span>
          </PixelButton>
        </div>
      </div>
    </div>
  );
}

/** Poll the pty's automation block while there is something waiting on it. The
 * flag lives in the terminal pool (a plain module map, not the store), so there
 * is nothing to subscribe to — a 1s tick while the queue is pending is enough. */
function useTerminalBlock(ptyId: string | undefined, active: boolean): TerminalAutomationBlock {
  const [block, setBlock] = useState<TerminalAutomationBlock>(null);
  useEffect(() => {
    if (!ptyId || !active) { setBlock(null); return; }
    const read = () => setBlock(terminalAutomationBlockFor(ptyId));
    read();
    const iv = setInterval(read, 1000);
    return () => clearInterval(iv);
  }, [ptyId, active]);
  // 'settling' is a sub-second gap between writes — not worth telling anyone.
  return block === 'settling' ? null : block;
}

/** Poll the floor-wide auto-delivery pause (main-process control state) while
 * this agent has messages waiting. 2s is plenty — the pause flips on human
 * timescales, and the drain re-reads the live snapshot before every send. */
function useDeliveryPaused(agentId: string, active: boolean): boolean {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!active) { setPaused(false); return; }
    let alive = true;
    const read = () => {
      window.cth.controlSnapshot(agentId)
        .then((s) => { if (alive) setPaused(!!s?.autoDeliveryPaused); })
        .catch(() => { /* main not ready — assume not paused */ });
    };
    read();
    const iv = setInterval(read, 2000);
    return () => { alive = false; clearInterval(iv); };
  }, [agentId, active]);
  return paused;
}

/**
 * One pending queue row. Collapsed it clamps to 2 lines; "see more" expands it
 * in place so a long message can be read without hovering for the tooltip. The
 * toggle only renders when the text actually clips, so short messages stay tidy.
 */
function QueuedMessageRow(
  { index, message, paused, onSendNow, onRemove }: {
    index: number;
    message: QueuedMessage;
    /** Floor-wide auto-delivery is paused — offer the per-message override. */
    paused: boolean;
    onSendNow: () => void;
    onRemove: () => void;
  }
) {
  const { t } = useTranslation();
  const rtl = useRtl();
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Measure against the CLAMPED box, so the toggle survives being expanded (the
  // expanded box never overflows and would otherwise report clipped = false).
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => {
      if (expanded) return;
      setClipped(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    // The panel is resizable — re-measure on width changes, not just text ones.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [message.text, expanded]);

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 6,
      padding: '4px 6px',
      background: 'var(--cth-paper-100)',
      boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
    }}>
      <span style={{
        fontFamily: 'var(--cth-font-mono)', fontSize: 12,
        color: 'var(--cth-ink-500)', lineHeight: '18px', flexShrink: 0
      }}>{`${index + 1}.`}</span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div
          ref={bodyRef}
          dir={rtl ? 'auto' : undefined}
          title={expanded ? undefined : message.text}
          style={{
            fontSize: 12, lineHeight: '18px',
            color: 'var(--cth-ink-900)',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            ...(expanded
              // Cap the expanded body so one long message can't push the rest of
              // the queue out of the list's own 280px scroll area.
              ? { maxHeight: 220, overflowY: 'auto' as const }
              : {
                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                  overflow: 'hidden'
                })
          }}
        >{message.text}</div>
        {(clipped || expanded || paused) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {(clipped || expanded) && (
              <button
                onClick={() => setExpanded((e) => !e)}
                title={expanded ? t('queueComposer.collapse') : t('queueComposer.showFull')}
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
                  fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '16px',
                  color: 'var(--cth-ink-500)', textDecoration: 'underline'
                }}
              >{expanded ? t('queueComposer.seeLess') : t('queueComposer.seeMore')}</button>
            )}
            {paused && !message.manual && (
              <button
                onClick={onSendNow}
                title={t('queueComposer.sendNowTitle')}
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
                  fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '16px',
                  color: 'var(--cth-ink-900)', textDecoration: 'underline'
                }}
              >{t('queueComposer.sendNow')}</button>
            )}
            {paused && message.manual && (
              <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                {t('queueComposer.sendingWhenFree')}
              </span>
            )}
          </div>
        )}
      </div>
      <button
        onClick={onRemove}
        title={t('queueComposer.removeFromQueue')}
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
  const { t } = useTranslation();
  const ff = useFreeflow();
  const mine = ff.targetAgentId === agentId;
  const recording = ff.status === 'recording' && mine;
  const transcribing = ff.status === 'transcribing' && mine;
  // Block while another agent's clip is recording/uploading (single recorder).
  const busyElsewhere = ff.status !== 'idle' && !mine;
  const noKey = !hasGroqKey;

  const hintRef = useRef<HTMLSpanElement | null>(null);
  const iconRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [hint, setHint] = useState<{ left: number; top: number } | null>(null);
  const hintOpen = hint !== null;

  const HINT_W = 244;
  const HINT_GAP = 8;
  const EST_H = 188;

  const title = noKey
    ? t('queueComposer.ffNoKeyTitle')
    : recording ? t('queueComposer.ffStopTranscribe')
    : transcribing ? t('queueComposer.transcribing')
    : t('queueComposer.ffTitle');

  /** Same placement rule as RealtimeMichaelToggle's hint: prefer above (the
   *  composer sits low in the panel), flip below only when there is no room, and
   *  clamp both axes so it can never hang off an edge. */
  const toggleHint = (e: ReactMouseEvent): void => {
    e.stopPropagation();
    if (hint) { setHint(null); return; }
    const r = iconRef.current?.getBoundingClientRect();
    if (!r) return;
    const above = r.top - HINT_GAP - EST_H;
    const top = above >= 8 ? above : Math.min(r.bottom + HINT_GAP, window.innerHeight - EST_H - 8);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - HINT_W - 8));
    setHint({ left, top: Math.max(8, top) });
  };

  useEffect(() => {
    if (!hintOpen) return;
    const onDown = (ev: globalThis.MouseEvent): void => {
      const t = ev.target as Node;
      // Portalled, so an inside-click has to be tested against BOTH nodes.
      if (hintRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setHint(null);
    };
    const onKey = (ev: globalThis.KeyboardEvent): void => { if (ev.key === 'Escape') setHint(null); };
    const onReflow = (): void => setHint(null);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onReflow);
      window.removeEventListener('scroll', onReflow, true);
    };
  }, [hintOpen]);

  const openKeySettings = (e: ReactMouseEvent): void => {
    e.stopPropagation();
    setHint(null);
    window.dispatchEvent(new CustomEvent('cth:open-settings', { detail: { section: 'Voice' } }));
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: noKey ? 4 : 0, minWidth: 0 }}>
      {/* Wrap in a (non-disabled) span so the native tooltip still shows on hover
          even when the inner button is disabled — Chromium suppresses tooltips on
          a disabled <button> itself. */}
      <span title={title} style={{ display: 'inline-flex' }}>
        <PixelButton
          variant={recording ? 'destructive' : 'secondary'}
          size="sm"
          onClick={() => { if (noKey) return; freeflowRecorder.toggle(agentId); }}
          disabled={noKey || transcribing || busyElsewhere}
        >
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <Icon name="mic" />
            {transcribing ? '…' : recording ? t('queueComposer.stop') : t('queueComposer.voice')}
          </span>
        </PixelButton>
      </span>

      {/* A missing key is a SETUP STATE, not a failure — the same treatment Talk
          already gets. Without this the button is simply dead on click, and the
          two facts that would make someone act (it is FREE, and there is a
          hold-to-talk shortcut) were written down nowhere in the UI. */}
      {noKey && (
        <span ref={hintRef} style={{ display: 'inline-flex', flexShrink: 0 }}>
          <button
            ref={iconRef}
            type="button"
            aria-label={t('queueComposer.ffHowEnable')}
            aria-expanded={hintOpen}
            onClick={toggleHint}
            style={{
              border: 'none', background: 'none', padding: 0, cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center',
              color: 'var(--cth-ink-500)',
              opacity: hintOpen ? 1 : 0.75
            }}
          >
            <Icon name="info" />
          </button>

          {hint && createPortal(
            <div
              ref={panelRef}
              role="dialog"
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'fixed', left: hint.left, top: hint.top, zIndex: 460,
                width: HINT_W, padding: '10px 12px', boxSizing: 'border-box',
                display: 'flex', flexDirection: 'column', gap: 7,
                background: 'var(--cth-paper-100)',
                boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500), 4px 4px 0 rgba(26,19,32,0.25)',
                fontFamily: 'var(--cth-font-ui)', fontSize: 11, lineHeight: '15px',
                color: 'var(--cth-ink-900)', textAlign: 'left', whiteSpace: 'normal'
              }}
            >
              <span style={{
                fontFamily: 'var(--cth-font-display)', fontSize: 9, letterSpacing: 0.5,
                textTransform: 'uppercase', color: 'var(--cth-ink-500)'
              }}>{t('queueComposer.ffSetupTitle')}</span>

              {/* Lead with the cost, because "add an API key" reads as "this will
                  bill me" and that assumption is what stops people here. */}
              <span>
                {t('queueComposer.ffSetupIntro')}
              </span>

              <ol style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 3 }}>
                <li>
                  {t('queueComposer.ffCreateKey')}{' '}
                  <a
                    href="https://console.groq.com/keys"
                    onClick={(e) => { e.preventDefault(); void window.cth.openExternal('https://console.groq.com/keys'); }}
                    style={{ color: 'var(--cth-ink-900)' }}
                  >console.groq.com/keys</a>
                </li>
                <li>{t('queueComposer.ffPasteKey')}</li>
                <li>{t('queueComposer.ffClickOrHold')}</li>
              </ol>

              <span style={{ color: 'var(--cth-ink-500)' }}>
                {t('queueComposer.ffHoldHint')}
              </span>

              <button
                type="button"
                onClick={openKeySettings}
                style={{
                  border: 'none', background: 'none', padding: 0, cursor: 'pointer',
                  alignSelf: 'flex-start',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 11, lineHeight: '15px',
                  color: 'var(--cth-ink-900)', textDecoration: 'underline'
                }}
              >				{t('realtimeToggle.setItUpNow')}</button>
            </div>,
            document.body
          )}
        </span>
      )}
    </span>
  );
}

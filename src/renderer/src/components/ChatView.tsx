/**
 * CHAT — the "desktop app" view of an agent: just its replies, not the raw
 * scrolling TUI the Terminal tab shows (spinners, tool-call lines, box
 * drawing). Reads main/chatTranscript.ts's parsed user/assistant turns via
 * `window.cth.agentChat`, which strips every tool_use/tool_result block out
 * before it ever reaches the renderer.
 *
 * Polling, not a push channel: chat turns land at human pace (seconds, not the
 * byte-by-byte rate a pty streams at), and the transcript tailer in main is
 * already cheap on repeat reads (offset-cached, like the usage reconciler).
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';
import { useRtl } from '@/i18n/useDirection';
import { MessageQueueComposer } from './MessageQueueComposer';
import type { Agent } from '@/store/store';

const POLL_MS = 1500;

/** Mirrors ChatMessage in main/chatTranscript.ts and preload/index.ts — kept as
 * its own copy because renderer, preload and main compile as separate
 * programs (tsconfig.web.json / tsconfig.node.json). */
interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

export function ChatView({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const rtl = useRtl();
  // null = this provider keeps no readable conversation (see chatSourceOf);
  // [] = there is a source and it has nothing in it yet. Undefined only until
  // the first poll answers, so the tab never flashes an empty state at load.
  const [messages, setMessages] = useState<ChatMessage[] | null | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Only auto-follow new turns while the reader is already at the bottom —
  // scrolling up to reread history must not get yanked back down.
  const atBottomRef = useRef(true);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await window.cth.agentChat(agent.id);
        if (!cancelled) setMessages(next);
      } catch { /* keep last good */ }
    };
    void poll();
    const id = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [agent.id]);

  useEffect(() => {
    if (!atBottomRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
        }}
        style={{
          flex: 1, minHeight: 0, overflowY: 'auto', background: 'var(--cth-paper-200)',
          padding: 10, display: 'flex', flexDirection: 'column', gap: 8,
          fontFamily: 'var(--cth-font-mono)'
        }}
      >
        {messages && messages.length === 0 && (
          <div style={{ textAlign: 'center', padding: '24px 12px', color: 'var(--cth-ink-500)', fontSize: 12 }}>
            {t('commandCenter.noChat')}
          </div>
        )}
        {messages === null && (
          <div style={{ textAlign: 'center', padding: '24px 12px', color: 'var(--cth-ink-500)', fontSize: 12 }}>
            {t('commandCenter.noChatSource', { name: agent.name })}
          </div>
        )}
        {(messages ?? []).map((m, i) => {
          const mine = m.role === 'assistant';
          return (
            <div
              key={`${m.ts}-${i}`}
              dir={rtl ? 'auto' : undefined}
              style={{
                alignSelf: mine ? 'flex-start' : 'flex-end',
                maxWidth: '85%',
                background: mine ? 'var(--cth-paper-100)' : `var(--cth-${agent.accent})`,
                color: mine ? 'var(--cth-ink-900)' : 'var(--cth-on-accent)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                padding: '6px 10px', fontSize: 14, lineHeight: '19px'
              }}
            >
              <MarkdownPreview source={m.text} variant="card" />
            </div>
          );
        })}
      </div>
      {/* Same queue the Terminal tab uses: typed here lands in the pty exactly
          like a Terminal-tab message, just via a form instead of a raw prompt. */}
      <MessageQueueComposer agent={agent} />
    </div>
  );
}

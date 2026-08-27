import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { useRtl } from '@/i18n/useDirection';

// Derive the message shape from the preload-exposed API so the renderer never
// reaches across project boundaries for a type (window.cth is globally typed).
type HiveMessage = Awaited<ReturnType<Window['cth']['hiveInbox']>>[number];

/**
 * Human-readable threaded view of an agent's hive inbox. Groups messages by
 * `conversation`, renders each as a collapsible thread, and lets the human reply
 * inline (sent as the "human" sender via window.cth.hiveSend).
 */
export interface ThreadsPanelProps {
  agentId: string;
}

interface Thread {
  conversation: string;
  subject: string;
  messages: HiveMessage[];
}

const ACT_COLOR: Record<string, string> = {
  request: 'var(--cth-peach)', inform: 'var(--cth-sky)', propose: 'var(--cth-lilac)',
  query: 'var(--cth-lemon)', agree: 'var(--cth-mint)', refuse: 'var(--cth-coral)', done: 'var(--cth-mint)'
};

function groupThreads(msgs: HiveMessage[], noSubject: string): Thread[] {
  const by = new Map<string, HiveMessage[]>();
  for (const m of msgs) {
    const arr = by.get(m.conversation) ?? [];
    arr.push(m);
    by.set(m.conversation, arr);
  }
  return [...by.entries()]
    .map(([conversation, list]) => {
      const sorted = [...list].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
      return { conversation, subject: sorted[0]?.subject || noSubject, messages: sorted };
    })
    .sort((a, b) => {
      const la = a.messages[a.messages.length - 1].created_at;
      const lb = b.messages[b.messages.length - 1].created_at;
      return la < lb ? 1 : -1; // newest activity first
    });
}

export function ThreadsPanel({ agentId }: ThreadsPanelProps) {
  const { t } = useTranslation();
  const rtl = useRtl();
  const [messages, setMessages] = useState<HiveMessage[]>([]);
  const [openThreads, setOpenThreads] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const inbox = await window.cth.hiveInbox(agentId);
        if (alive) setMessages(inbox);
      } catch { /* keep last good state */ }
    };
    load();
    const timer = setInterval(load, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [agentId]);

  const threads = useMemo(() => groupThreads(messages, t('threads.noSubject')), [messages, t]);

  const sendReply = async (last: HiveMessage) => {
    const body = (drafts[last.conversation] ?? '').trim();
    if (!body) return;
    await window.cth.hiveSend({
      to: last.from, act: 'inform', conversation: last.conversation,
      in_reply_to: last.id, subject: 'Re: ' + last.subject, body
    }, 'human');
    setDrafts(d => ({ ...d, [last.conversation]: '' }));
  };

  if (threads.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: 'var(--cth-paper-200)' }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--cth-ink-700)', textAlign: 'center', maxWidth: 280 }}>
          {t('threads.empty')}
        </p>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 'var(--cth-space-3)', background: 'var(--cth-paper-200)', display: 'flex', flexDirection: 'column', gap: 'var(--cth-space-3)' }}>
      {threads.map(thread => {
        const open = openThreads[thread.conversation] ?? true;
        const last = thread.messages[thread.messages.length - 1];
        return (
          <PixelPanel key={thread.conversation} variant="default" noPadding>
            <button
              onClick={() => setOpenThreads(s => ({ ...s, [thread.conversation]: !open }))}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                padding: '6px 10px', border: 'none', cursor: 'pointer', background: 'var(--cth-cream-200)',
                fontFamily: 'var(--cth-font-display)', fontSize: 'var(--cth-text-display-sm)',
                lineHeight: '14px', color: 'var(--cth-ink-900)', boxShadow: 'inset 0 -1px 0 var(--cth-ink-900)'
              }}
            >
              <span style={{ width: 12, flexShrink: 0 }}>{open ? '▾' : '▸'}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {thread.subject.toUpperCase()}
              </span>
              <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{thread.messages.length}</span>
            </button>

            {open && (
              <div style={{ padding: '8px 10px 10px 18px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {thread.messages.map(m => {
                  const isExp = expanded[m.id];
                  const long = m.body.length > 120;
                  const shown = isExp || !long ? m.body : m.body.slice(0, 120) + '…';
                  return (
                    <div key={m.id} style={{ borderLeft: '2px solid var(--cth-ink-100)', paddingLeft: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, fontWeight: 700, color: 'var(--cth-ink-900)' }}>{m.from}</span>
                        <span style={{
                          fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '16px', padding: '0 6px',
                          background: 'var(--cth-cream-100)', boxShadow: `inset 0 0 0 1px ${ACT_COLOR[m.act] ?? 'var(--cth-ink-300)'}`,
                          color: 'var(--cth-ink-900)'
                        }}>{m.act}</span>
                        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--cth-ink-500)' }}>
                          {new Date(m.created_at).toLocaleString()}
                        </span>
                      </div>
                      <div dir={rtl ? 'auto' : undefined} style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, lineHeight: '18px', color: 'var(--cth-ink-700)', marginTop: 2, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {shown}
                        {long && (
                          <button
                            onClick={() => setExpanded(s => ({ ...s, [m.id]: !isExp }))}
                            style={{ marginLeft: 6, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--cth-sky)', fontFamily: 'var(--cth-font-ui)', fontSize: 12, padding: 0 }}
                          >{isExp ? t('threads.less') : t('threads.more')}</button>
                        )}
                      </div>
                    </div>
                  );
                })}

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                  <textarea
                    dir={rtl ? 'auto' : undefined}
                    value={drafts[thread.conversation] ?? ''}
                    onChange={e => setDrafts(d => ({ ...d, [thread.conversation]: e.target.value }))}
                    placeholder={t('threads.replyPlaceholder', { name: last.from })}
                    rows={2}
                    style={{
                      resize: 'vertical', width: '100%', boxSizing: 'border-box', padding: '6px 8px',
                      fontFamily: 'var(--cth-font-ui)', fontSize: 13, lineHeight: '18px',
                      color: 'var(--cth-ink-900)', background: 'var(--cth-cream-50)',
                      border: 'none', boxShadow: 'inset 0 0 0 2px var(--cth-ink-700)'
                    }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <PixelButton size="sm" onClick={() => sendReply(last)} disabled={!(drafts[thread.conversation] ?? '').trim()}>
                      {t('threads.send')}
                    </PixelButton>
                  </div>
                </div>
              </div>
            )}
          </PixelPanel>
        );
      })}
    </div>
  );
}

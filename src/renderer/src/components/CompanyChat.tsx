import { useEffect, useMemo, useRef, useState } from 'react';
import { ActionButton } from './ActionButton';

type VoiceMessage = Awaited<ReturnType<Window['cth']['hiveMessages']>>[number];

export function CompanyChat() {
  const [messages, setMessages] = useState<VoiceMessage[]>([]);
  const [draft, setDraft] = useState(() => sessionStorage.getItem('md-company-draft') ?? '');
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [feedError, setFeedError] = useState(false);
  const [sendError, setSendError] = useState('');
  const [hasNew, setHasNew] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => { sessionStorage.setItem('md-company-draft', draft); }, [draft]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const raw = await window.cth.hiveMessages({ limit: 80 });
        if (!alive) return;
        const seen = new Set<string>();
        const next = raw.filter((m) => !m.archived && (seen.has(m.id) ? false : (seen.add(m.id), true)));
        setMessages((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
        setLoaded(true);
        setFeedError(false);
      } catch {
        if (alive) setFeedError(true);
      } finally {
        if (alive) timer = setTimeout(load, 3000);
      }
    };
    void load();
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  const ordered = useMemo(() => [...messages].sort((a, b) =>
    a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)), [messages]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (pinned.current) el.scrollTop = el.scrollHeight;
    else setHasNew(true);
  }, [ordered]);

  const jumpToLatest = () => {
    pinned.current = true;
    setHasNew(false);
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  };

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setSendError('');
    try {
      await window.cth.hiveSend({ to: 'broadcast', act: 'inform', subject: body.slice(0, 80), body }, 'human');
      setDraft('');
      jumpToLatest();
    } catch {
      setSendError('Message was not sent. Your draft is saved; try again.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="md-chat">
      <div className="md-feed-status" role="status">
        <span className={`md-connection-dot${feedError ? ' is-offline' : ''}`} aria-hidden="true" />
        {feedError ? 'Feed unavailable · retrying automatically' : loaded ? 'Live company feed' : 'Connecting to the company…'}
        <span>{ordered.length > 0 ? `${ordered.length} recent messages` : ''}</span>
      </div>
      <div ref={listRef} className="md-messages" role="log" aria-label="Company messages" aria-relevant="additions"
        onScroll={() => {
          const el = listRef.current;
          if (!el) return;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          if (pinned.current) setHasNew(false);
        }}>
        {ordered.length === 0 ? (
          <div className="md-chat-empty">
            <strong>{loaded ? 'Start a conversation' : 'Your company conversation'}</strong>
            <p>{loaded ? 'Ask for research, share a decision, or request a progress update. Your message reaches the whole company.' : 'Messages will appear here when the feed connects.'}</p>
          </div>
        ) : ordered.map((m) => (
          <article key={m.id} className={`md-message${m.from === 'human' ? ' is-human' : ''}`}>
            <div className="md-message-meta">
              <strong>{m.from === 'human' ? 'You' : m.from}</strong>
              <span className="md-message-route">to {m.to === 'broadcast' ? 'everyone' : m.to}</span>
              <span className="md-message-act">{m.act}</span>
              <time dateTime={m.created_at}>{new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
            </div>
            {m.subject && m.subject !== m.body && <div className="md-message-subject">{m.subject}</div>}
            <div className="md-message-body">{m.body}</div>
          </article>
        ))}
      </div>
      {hasNew && <button type="button" className="md-latest" onClick={jumpToLatest}>New messages · jump to latest ↓</button>}
      <div className="md-composer">
        <label htmlFor="md-company-message">Message the company</label>
        <div className="md-composer-row">
          <textarea id="md-company-message" value={draft} rows={2} disabled={sending}
            onChange={(e) => { setDraft(e.target.value); setSendError(''); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault(); void send();
              }
            }}
            placeholder="Ask for research or share a decision…" aria-describedby="md-company-send-help" />
          <ActionButton size="md" onClick={() => void send()} disabled={!draft.trim() || sending}>
            {sending ? 'Sending…' : 'Send'}
          </ActionButton>
        </div>
        <div id="md-company-send-help" className="md-composer-help">Everyone receives your message. Enter to send · Shift+Enter for a new line.</div>
        {sendError && <div className="md-send-error" role="alert">{sendError}</div>}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { ActionButton } from './ActionButton';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';
import { castFor, KIND_LABEL, readMessage, type CastMember, type MessageRead } from './chat/cast';
import { TickerTape } from './chat/TickerTape';
import { useTradingData } from './trading/useTradingData';

type FeedMessage = Awaited<ReturnType<Window['cth']['hiveMessages']>>[number];

const POLL_MS = 2500;
const GROUP_WINDOW_MS = 4 * 60 * 1000;
const LIVE_WINDOW_MS = 5 * 60 * 1000;
const FLOOR_WINDOW_MS = 45 * 60 * 1000;
const COLLAPSE_AT = 720;

interface Row {
  m: FeedMessage;
  cast: CastMember;
  read: MessageRead;
  at: number;
  continuation: boolean;
  dayBreak: string | null;
}

function sameMessages(a: FeedMessage[], b: FeedMessage[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].body !== b[i].body || a[i].created_at !== b[i].created_at) return false;
  }
  return true;
}

// The office clock is Colorado time whatever machine the app runs on.
const OFFICE_TZ = 'America/Denver';
const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: OFFICE_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

function clockOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: OFFICE_TZ });
}

function dayOf(at: number, now: number): string {
  const key = dayKeyFmt.format(at);
  if (key === dayKeyFmt.format(now)) return 'Today';
  if (key === dayKeyFmt.format(now - 86_400_000)) return 'Yesterday';
  return new Date(at).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric', timeZone: OFFICE_TZ });
}

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 45) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function buildRows(messages: FeedMessage[], now: number): Row[] {
  const rows: Row[] = [];
  let lastDay = '';
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const at = Date.parse(m.created_at) || 0;
    const day = dayOf(at, now);
    const prev = rows[rows.length - 1];
    const read = readMessage(m.from, m.subject, m.body);
    const continuation = !!prev && prev.m.from === m.from && prev.read.kind === read.kind
      && at - prev.at < GROUP_WINDOW_MS && day === lastDay && read.kind === 'plain';
    rows.push({ m, cast: castFor(m.from), read, at, continuation, dayBreak: day !== lastDay ? day : null });
    lastDay = day;
  }
  return rows;
}

function Avatar({ cast, size = 30, live = false }: { cast: CastMember; size?: number; live?: boolean }) {
  return (
    <span className={`md-cast-avatar${live ? ' is-live' : ''}${cast.isHuman ? ' is-human' : ''}`}
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.36)), '--cast': `var(--cth-${cast.accent})`, '--cast-light': `var(--cth-${cast.accent}-light)` } as React.CSSProperties}
      aria-hidden="true">
      {cast.glyph}
    </span>
  );
}

function FloorStrip({ rows, now }: { rows: Row[]; now: number }) {
  const people = useMemo(() => {
    const last = new Map<string, { cast: CastMember; at: number }>();
    for (const r of rows) {
      if (r.cast.isSystem) continue;
      const key = r.cast.name;
      const seen = last.get(key);
      if (!seen || r.at > seen.at) last.set(key, { cast: r.cast, at: r.at });
    }
    return [...last.values()].filter(p => now - p.at < FLOOR_WINDOW_MS).sort((a, b) => b.at - a.at).slice(0, 12);
  }, [rows, now]);
  const live = people.filter(p => now - p.at < LIVE_WINDOW_MS).length;
  return (
    <div className="md-floor" aria-label="Who is on the floor">
      <span className="md-floor-title">
        <span className={`md-floor-dot${live ? ' is-live' : ''}`} aria-hidden="true" />
        {live ? `${live} talking` : people.length ? 'Quiet floor' : 'Empty floor'}
      </span>
      <div className="md-floor-people">
        {people.map(p => (
          <span key={p.cast.name} className="md-floor-person" title={`${p.cast.name} · ${p.cast.role} · ${ago(p.at, now)} ago`}>
            <Avatar cast={p.cast} size={26} live={now - p.at < LIVE_WINDOW_MS} />
            <span className="md-floor-name">{p.cast.name}</span>
            <span className="md-floor-ago">{ago(p.at, now)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Body({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > COLLAPSE_AT;
  const shown = long && !open ? `${text.slice(0, COLLAPSE_AT).trimEnd()}…` : text;
  return (
    <div className="md-msg-body">
      <MarkdownPreview source={shown} variant="card" />
      {long && (
        <button type="button" className="md-msg-more" onClick={() => setOpen(v => !v)}>
          {open ? 'Show less' : 'Read the rest'}
        </button>
      )}
    </div>
  );
}

function Message({ row, latest, now }: { row: Row; latest: boolean; now: number }) {
  const { m, cast, read } = row;
  const label = KIND_LABEL[read.kind];
  const cls = [
    'md-msg',
    `is-${read.kind}`,
    cast.isHuman ? 'is-human' : '',
    row.continuation ? 'is-continuation' : '',
    latest ? 'is-latest' : '',
    read.outcome ? `is-${read.outcome}` : '',
  ].filter(Boolean).join(' ');
  const style = { '--cast': `var(--cth-${cast.accent})`, '--cast-light': `var(--cth-${cast.accent}-light)` } as React.CSSProperties;

  if (read.kind === 'standup') {
    return (
      <div className="md-msg-system" style={style}>
        <span className="md-msg-system-tag">PA</span>
        <span className="md-msg-system-text">{m.subject || m.body.slice(0, 120)}</span>
        <time dateTime={m.created_at}>{clockOf(row.at)}</time>
      </div>
    );
  }

  return (
    <article className={cls} style={style}>
      {!row.continuation && (
        <header className="md-msg-head">
          <Avatar cast={cast} live={latest && now - row.at < LIVE_WINDOW_MS} />
          <span className="md-msg-name">{cast.name}</span>
          <span className="md-msg-role">{cast.role}</span>
          {label && <span className={`md-msg-kind is-${read.kind}`}>{label}</span>}
          {m.to !== 'broadcast' && <span className="md-msg-to">→ {castFor(m.to).name}</span>}
          <time dateTime={m.created_at} title={new Date(row.at).toLocaleString([], { timeZone: OFFICE_TZ })}>{clockOf(row.at)}</time>
        </header>
      )}
      <div className="md-msg-card">
        {read.headline && <div className="md-msg-headline">{read.headline}</div>}
        {m.subject && m.subject !== m.body && read.kind === 'plain' && <div className="md-msg-subject">{m.subject}</div>}
        <Body text={m.body} />
      </div>
    </article>
  );
}

export function CompanyChat() {
  const trading = useTradingData();
  const [messages, setMessages] = useState<FeedMessage[]>([]);
  const [draft, setDraft] = useState(() => sessionStorage.getItem('md-company-draft') ?? '');
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [feedError, setFeedError] = useState(false);
  const [sendError, setSendError] = useState('');
  const [hasNew, setHasNew] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const listRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => { sessionStorage.setItem('md-company-draft', draft); }, [draft]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const raw = await window.cth.hiveMessages({ limit: 140 });
        if (!alive) return;
        const seen = new Set<string>();
        const next = raw
          .filter(m => !m.archived && m.created_at && (seen.has(m.id) ? false : (seen.add(m.id), true)))
          .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
        setMessages(prev => (sameMessages(prev, next) ? prev : next));
        setLoaded(true);
        setFeedError(false);
        setNow(Date.now());
      } catch {
        if (alive) setFeedError(true);
      } finally {
        if (alive) timer = setTimeout(load, POLL_MS);
      }
    };
    void load();
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  const rows = useMemo(() => buildRows(messages, now), [messages, now]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (pinned.current) el.scrollTop = el.scrollHeight;
    else setHasNew(true);
  }, [messages]);

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

  const latestId = rows.length ? rows[rows.length - 1].m.id : null;

  return (
    <div className="md-chat">
      <TickerTape d={trading} />
      <FloorStrip rows={rows} now={now} />
      <div className="md-feed-status" role="status">
        <span className={`md-connection-dot${feedError ? ' is-offline' : ''}`} aria-hidden="true" />
        {feedError ? 'Feed unavailable · retrying' : loaded ? 'Live' : 'Connecting…'}
        <span className="md-feed-count">{rows.length ? `${rows.length} messages` : ''}</span>
      </div>
      <div ref={listRef} className="md-messages" role="log" aria-label="Company messages" aria-relevant="additions"
        onScroll={() => {
          const el = listRef.current;
          if (!el) return;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          if (pinned.current) setHasNew(false);
        }}>
        {rows.length === 0 ? (
          <div className="md-chat-empty">
            <strong>{loaded ? 'The floor is quiet' : 'Opening the office'}</strong>
            <p>{loaded ? 'Nothing has been said yet. Say something and the whole company hears it.' : 'Messages will appear here when the feed connects.'}</p>
          </div>
        ) : rows.map(row => (
          <div key={row.m.id} className="md-row">
            {row.dayBreak && <div className="md-daybreak"><span>{row.dayBreak}</span></div>}
            <Message row={row} latest={row.m.id === latestId} now={now} />
          </div>
        ))}
      </div>
      {hasNew && <button type="button" className="md-latest" onClick={jumpToLatest}>New messages · jump to latest ↓</button>}
      <div className="md-composer">
        <div className="md-composer-row">
          <textarea id="md-company-message" value={draft} rows={2} disabled={sending}
            onChange={(e) => { setDraft(e.target.value); setSendError(''); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault(); void send();
              }
            }}
            placeholder="Say something to the whole company…" aria-label="Message the company" aria-describedby="md-company-send-help" />
          <ActionButton size="md" onClick={() => void send()} disabled={!draft.trim() || sending}>
            {sending ? 'Sending…' : 'Send'}
          </ActionButton>
        </div>
        <div id="md-company-send-help" className="md-composer-help">Enter to send · Shift+Enter for a new line</div>
        {sendError && <div className="md-send-error" role="alert">{sendError}</div>}
      </div>
    </div>
  );
}

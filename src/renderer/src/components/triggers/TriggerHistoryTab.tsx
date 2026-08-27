import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { PixelButton } from '../PixelButton';
import { useStore } from '@/store/store';
import type { TriggerHistoryEntry } from '@shared/triggers';
import { useRtl } from '@/i18n/useDirection';

/**
 * TRIGGER HISTORY — the ledger of everything an outside party said to this hive
 * and everything we said back, read as conversations rather than log lines.
 *
 * The ledger is flat (one row per message, newest first). The operator's actual
 * question is never "what rows exist" but "what did they ask, and what did we
 * answer" — so rows are folded into EXCHANGES by `correlationId` here, in the
 * renderer, and drawn as one card per exchange with both bodies in full.
 *
 * Two sources share the ledger (webhook, org) and they are switched, not
 * stacked: this lives in a ~360px sidebar, so two full lists on one scroll
 * would bury whichever one you came for.
 *
 * The only actionable rows are inbound messages a `strict` /
 * `communication-only` trigger mode held back (`decision: 'pending'`). Those
 * float to the top of their section, because approving one dispatches real
 * work into the hive and a held message that scrolls out of sight is a message
 * that never gets answered.
 */

/* ─────────────────────────────── ipc surface ─────────────────────────────── */

/**
 * The trigger-history IPC lands with the main-process change that owns preload;
 * the typed `window.cth` members arrive with it. Until then this narrow local
 * surface + one cast keeps the tab compiling without touching preload — and
 * needs no edit once the real types show up, since the shapes match.
 */
interface TriggerHistoryApi {
  listTriggerHistory?: () => Promise<TriggerHistoryEntry[]>;
  onTriggerHistoryUpdated?: (cb: () => void) => () => void;
  decideTriggerHistory?: (input: {
    id: string;
    decision: 'approved' | 'rejected';
  }) => Promise<{ ok?: boolean; error?: string } | undefined>;
  clearTriggerHistory?: (source?: 'webhook' | 'org') => Promise<unknown>;
}

/** Read lazily: `window.cth` is installed by preload, not by module load order. */
function api(): TriggerHistoryApi {
  return (window.cth ?? {}) as unknown as TriggerHistoryApi;
}

/* ─────────────────────────────── exchanges ───────────────────────────────── */

type Source = 'webhook' | 'org';

interface Exchange {
  key: string;
  /** Oldest first — an exchange reads downward, the way the conversation happened. */
  msgs: TriggerHistoryEntry[];
  /** Whose name and peer label the card: the inbound that started it, else the lone outbound. */
  head: TriggerHistoryEntry;
  /** The inbound still held for the operator, if any. */
  pending: TriggerHistoryEntry | null;
  answered: boolean;
  latestAt: number;
}

/**
 * Fold the flat ledger into exchanges.
 *
 * `correlationId` is the pairing key. Rows without one cannot be paired with
 * anything, so each becomes its own one-sided exchange keyed by its id — an
 * un-correlated inbound still deserves a card (it may be pending), and an
 * un-correlated outbound is a message we sent that simply has no recorded
 * prompt. A correlation group may also hold more than two rows (a follow-up, a
 * second reply); those render in time order rather than being dropped.
 *
 * Pending exchanges sort to the top; everything else stays newest-first.
 */
function buildExchanges(rows: TriggerHistoryEntry[]): Exchange[] {
  const buckets = new Map<string, TriggerHistoryEntry[]>();
  const order: string[] = [];
  for (const e of rows) {
    const key = e.correlationId ? `c:${e.correlationId}` : `e:${e.id}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(e);
    else { buckets.set(key, [e]); order.push(key); }
  }
  const list = order.map<Exchange>((key) => {
    const msgs = (buckets.get(key) ?? []).slice().sort((a, b) => a.at - b.at);
    const inbound = msgs.find((m) => m.direction === 'inbound');
    return {
      key,
      msgs,
      head: inbound ?? msgs[0],
      pending: msgs.find((m) => m.direction === 'inbound' && m.decision === 'pending') ?? null,
      answered: msgs.some((m) => m.direction === 'outbound'),
      latestAt: msgs.reduce((max, m) => Math.max(max, m.at), 0)
    };
  });
  return list.sort((a, b) => {
    if (!!a.pending !== !!b.pending) return a.pending ? -1 : 1;
    return b.latestAt - a.latestAt;
  });
}

/* ──────────────────────────────── helpers ────────────────────────────────── */

// Copied, not imported: SchedulesTab.tsx is being deleted.
function relTime(ms: number, t: TFunction): string {
  const past = ms >= 0;
  const a = Math.abs(ms);
  if (a < 45_000) return t('triggerHistory.justNow');
  const mins = Math.round(a / 60_000);
  const unit = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  return past ? t('triggerHistory.ago', { unit }) : t('triggerHistory.in', { unit });
}

const CLAMP_CHARS = 320;
const CLAMP_LINES = 8;

/** Collapse a long body for the resting state. Expanding always shows all of it. */
function clampBody(body: string): { text: string; clipped: boolean } {
  const lines = body.split('\n');
  if (body.length <= CLAMP_CHARS && lines.length <= CLAMP_LINES) return { text: body, clipped: false };
  const head = lines.slice(0, CLAMP_LINES).join('\n');
  const cut = head.length > CLAMP_CHARS ? head.slice(0, CLAMP_CHARS).replace(/\s+\S*$/, '') : head;
  return { text: `${cut.trimEnd()}…`, clipped: true };
}

/* ───────────────────────────────── styles ────────────────────────────────── */

const tinyCaps: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '12px',
  color: 'var(--cth-ink-500)'
};
const uiText: CSSProperties = {
  fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '17px',
  color: 'var(--cth-ink-900)'
};
const muted: CSSProperties = { ...uiText, color: 'var(--cth-ink-500)' };
const ellipsis: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

const cardStyle: CSSProperties = {
  background: 'var(--cth-paper-100)',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  padding: 8, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0
};
const pendingCardStyle: CSSProperties = {
  ...cardStyle,
  background: 'var(--cth-cream-100)',
  boxShadow: 'inset 0 0 0 2px var(--cth-lemon)'
};
const bodyBox: CSSProperties = {
  background: 'var(--cth-cream-200)',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  padding: '6px 8px',
  fontFamily: 'var(--cth-font-mono)', fontSize: 12, lineHeight: '17px',
  color: 'var(--cth-ink-900)',
  whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word'
};
const linkButton: CSSProperties = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  fontFamily: 'var(--cth-font-ui)', fontSize: 11, lineHeight: '16px',
  color: 'var(--cth-ink-700)', textDecoration: 'underline', textAlign: 'left'
};

function badgeStyle(fill: string, line: string): CSSProperties {
  return {
    fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '12px',
    padding: '3px 5px 2px', background: fill, boxShadow: `inset 0 0 0 1px ${line}`,
    color: 'var(--cth-ink-900)', flexShrink: 0
  };
}

function Badge({ fill, line, children }: { fill: string; line: string; children: string }) {
  return <span style={badgeStyle(fill, line)}>{children}</span>;
}

function KindBadge({ kind }: { kind: TriggerHistoryEntry['kind'] }) {
  const { t } = useTranslation();
  return kind === 'directive'
    ? <Badge fill="var(--cth-lemon-light)" line="var(--cth-lemon)">{t('triggerHistory.kindDirective')}</Badge>
    : <Badge fill="var(--cth-sky-light)" line="var(--cth-sky)">{t('triggerHistory.kindCommunication')}</Badge>;
}

function DecisionBadge({ decision }: { decision: NonNullable<TriggerHistoryEntry['decision']> }) {
  const { t } = useTranslation();
  switch (decision) {
    case 'pending':
      return <Badge fill="var(--cth-lemon-light)" line="var(--cth-lemon)">{t('triggerHistory.decisionPending')}</Badge>;
    case 'approved':
      return <Badge fill="var(--cth-mint-light)" line="var(--cth-mint)">{t('triggerHistory.decisionApproved')}</Badge>;
    case 'rejected':
      return <Badge fill="var(--cth-coral-light)" line="var(--cth-coral)">{t('triggerHistory.decisionRejected')}</Badge>;
    default:
      return <Badge fill="var(--cth-cream-200)" line="var(--cth-ink-300)">{t('triggerHistory.decisionAuto')}</Badge>;
  }
}

/* ─────────────────────────────── one message ─────────────────────────────── */

function MessageBlock({
  msg,
  label,
  expanded,
  onToggle
}: {
  msg: TriggerHistoryEntry;
  label: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const rtl = useRtl();
  const body = msg.body ?? '';
  const { text, clipped } = useMemo(() => clampBody(body), [body]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, justifyContent: 'space-between' }}>
        <span style={tinyCaps}>{label}</span>
        <span style={{ ...tinyCaps, flexShrink: 0 }}>{relTime(Date.now() - msg.at, t)}</span>
      </div>
      <div style={bodyBox} dir={rtl ? 'auto' : undefined}>{body.trim() ? (expanded ? body : text) : t('triggerHistory.emptyMessage')}</div>
      {clipped && (
        <button type="button" onClick={onToggle} style={linkButton}>
          {expanded ? t('triggerHistory.showLess') : t('triggerHistory.showAll', { count: body.length })}
        </button>
      )}
    </div>
  );
}

/* ────────────────────────────── one exchange ─────────────────────────────── */

function ExchangeCard({
  ex,
  expanded,
  toggle,
  busy,
  onDecide
}: {
  ex: Exchange;
  expanded: Record<string, boolean>;
  toggle: (id: string) => void;
  busy: Record<string, boolean>;
  onDecide: (id: string, decision: 'approved' | 'rejected') => void;
}) {
  const { t } = useTranslation();
  const godName = useStore((s) => s.agents.find((a) => a.isGod)?.name) ?? 'the orchestrator';
  const head = ex.head;
  const hasInbound = ex.msgs.some((m) => m.direction === 'inbound');
  const decision = head.decision;
  const pending = ex.pending;
  const taskId = ex.msgs.find((m) => m.taskId)?.taskId;

  // The trailing line for an exchange with nothing sent back yet. Silence here
  // is normal — it is a message still in flight, never a failure.
  const tail = (() => {
    if (pending || ex.answered) return null;
    if (decision === 'rejected') return t('triggerHistory.tailRejected');
    return t('triggerHistory.tailNoReply', { godName });
  })();

  return (
    <div style={pending ? pendingCardStyle : cardStyle}>
      {pending && (
        <div style={{
          background: 'var(--cth-lemon-light)', boxShadow: 'inset 0 0 0 1px var(--cth-lemon)',
          padding: '4px 6px 3px', ...tinyCaps, color: 'var(--cth-ink-900)'
        }}>
          {t('triggerHistory.waitingForYou')}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, justifyContent: 'space-between' }}>
          <span style={{ ...uiText, ...ellipsis, minWidth: 0 }} title={head.sourceName}>
            {head.sourceName || t('triggerHistory.unnamedSource')}
          </span>
          <span style={{ ...tinyCaps, flexShrink: 0 }}>{relTime(Date.now() - ex.latestAt, t)}</span>
        </div>
        <div style={{ ...muted, ...ellipsis, fontSize: 11 }} title={head.peer}>
          {hasInbound ? t('triggerHistory.from') : t('triggerHistory.to')} {head.peer || t('triggerHistory.unknown')}
        </div>
        {head.title && (
          <div style={{ ...uiText, ...ellipsis, color: 'var(--cth-ink-700)' }} title={head.title}>
            {head.title}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        <KindBadge kind={head.kind} />
        {decision && <DecisionBadge decision={decision} />}
      </div>

      {ex.msgs.map((m) => (
        <MessageBlock
          key={m.id}
          msg={m}
          label={m.direction === 'inbound' ? t('triggerHistory.theySent') : hasInbound ? t('triggerHistory.weReplied') : t('triggerHistory.weSent')}
          expanded={!!expanded[m.id]}
          onToggle={() => toggle(m.id)}
        />
      ))}

      {pending && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ ...uiText, fontSize: 11, lineHeight: '16px', color: 'var(--cth-ink-700)' }}>
            {pending.kind === 'directive'
              ? t('triggerHistory.pendingDirectiveDesc', { godName })
              : t('triggerHistory.pendingDesc', { godName })}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <PixelButton
              variant="primary"
              size="sm"
              disabled={!!busy[pending.id]}
              onClick={() => onDecide(pending.id, 'approved')}
              title={t('triggerHistory.approveTitle', { godName })}
            >
              {busy[pending.id] ? t('triggerHistory.oneSec') : t('triggerHistory.approve')}
            </PixelButton>
            <PixelButton
              variant="secondary"
              size="sm"
              disabled={!!busy[pending.id]}
              onClick={() => onDecide(pending.id, 'rejected')}
              title={t('triggerHistory.rejectTitle')}
            >
              {t('triggerHistory.reject')}
            </PixelButton>
          </div>
        </div>
      )}

      {tail && <div style={{ ...muted, fontSize: 11 }}>{tail}</div>}

      {taskId && (
        <div style={{ ...tinyCaps, ...ellipsis }} title={taskId}>{t('triggerHistory.task', { id: taskId })}</div>
      )}
    </div>
  );
}

/* ───────────────────────────── empty states ──────────────────────────────── */

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ ...cardStyle, gap: 4 }}>
      <div style={uiText}>{title}</div>
      <div style={{ ...muted, fontSize: 11, lineHeight: '16px' }}>{body}</div>
    </div>
  );
}

const SECTIONS: { key: Source; labelKey: string; blurbKey: string }[] = [
  {
    key: 'webhook',
    labelKey: 'triggerHistory.sectionWebhooks',
    blurbKey: 'triggerHistory.sectionWebhooksBlurb'
  },
  {
    key: 'org',
    labelKey: 'triggerHistory.sectionOrg',
    blurbKey: 'triggerHistory.sectionOrgBlurb'
  }
];

/* ──────────────────────────────── the tab ────────────────────────────────── */

export function TriggerHistoryTab() {
  const { t } = useTranslation();
  const godName = useStore((s) => s.agents.find((a) => a.isGod)?.name) ?? 'the orchestrator';
  const [entries, setEntries] = useState<TriggerHistoryEntry[]>([]);
  const [source, setSource] = useState<Source>('webhook');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [confirmClear, setConfirmClear] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    const list = api().listTriggerHistory;
    if (!list) return;
    list()
      .then((rows) => setEntries(Array.isArray(rows) ? rows : []))
      .catch(() => { /* main not ready; the update event will bring us back */ });
  }, []);

  useEffect(() => {
    load();
    // Same shape as onMissionsUpdated: subscribe, get an unsubscribe back.
    const off = api().onTriggerHistoryUpdated?.(load);
    return () => { if (typeof off === 'function') off(); };
  }, [load]);

  const toggle = useCallback((id: string) => {
    setExpanded((e) => ({ ...e, [id]: !e[id] }));
  }, []);

  const decide = useCallback((id: string, decision: 'approved' | 'rejected') => {
    const call = api().decideTriggerHistory;
    if (!call) return;
    setBusy((b) => ({ ...b, [id]: true }));
    setError(null);
    // Optimistic: the row's verdict is the operator's own input, so it should
    // land the instant they click. The update event reconciles either way.
    setEntries((rows) => rows.map((r) => (r.id === id ? { ...r, decision } : r)));
    call({ id, decision })
      .then((res) => {
        if (res && res.ok === false) {
          setError(res.error || t('triggerHistory.decideFailed'));
          load();
        }
      })
      .catch(() => { setError(t('triggerHistory.decideFailed')); load(); })
      .finally(() => setBusy((b) => { const n = { ...b }; delete n[id]; return n; }));
  }, [load, t]);

  const clear = useCallback(() => {
    const call = api().clearTriggerHistory;
    setConfirmClear(false);
    if (!call) return;
    setEntries((rows) => rows.filter((r) => r.source !== source));
    call(source).catch(() => { setError(t('triggerHistory.clearFailed')); load(); });
  }, [source, load, t]);

  const counts = useMemo(() => {
    const c: Record<Source, { total: number; pending: number }> = {
      webhook: { total: 0, pending: 0 },
      org: { total: 0, pending: 0 }
    };
    for (const e of entries) {
      const bucket = c[e.source];
      if (!bucket) continue;
      bucket.total += 1;
      if (e.direction === 'inbound' && e.decision === 'pending') bucket.pending += 1;
    }
    return c;
  }, [entries]);

  const exchanges = useMemo(
    () => buildExchanges(entries.filter((e) => e.source === source)),
    [entries, source]
  );

  const section = SECTIONS.find((s) => s.key === source) ?? SECTIONS[0];
  const pendingCount = counts[source].pending;

  return (
    <div style={{
      flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
      background: 'var(--cth-paper-200)'
    }}>
      {/* Section switcher — the panel is too narrow to stack both lists. */}
      <div style={{
        display: 'flex', flexShrink: 0,
        background: 'var(--cth-cream-200)', boxShadow: 'inset 0 -1px 0 var(--cth-ink-300)'
      }}>
        {SECTIONS.map((s) => {
          const active = s.key === source;
          const p = counts[s.key].pending;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => { setSource(s.key); setConfirmClear(false); setError(null); }}
              style={{
                flex: 1, height: 32, padding: '0 8px', border: 'none', cursor: 'pointer',
                background: active ? 'var(--cth-paper-200)' : 'transparent',
                boxShadow: active ? 'inset 0 -2px 0 var(--cth-ink-900)' : 'none',
                fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '12px',
                color: active ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                minWidth: 0
              }}
            >
              <span style={ellipsis}>{t(s.labelKey).toUpperCase()}</span>
              {p > 0 && (
                <span style={{
                  ...badgeStyle('var(--cth-lemon-light)', 'var(--cth-lemon)'),
                  padding: '2px 4px 1px'
                }}>{p}</span>
              )}
            </button>
          );
        })}
      </div>

      <div style={{
        flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
        padding: 8, display: 'flex', flexDirection: 'column', gap: 8
      }}>
        <div style={{ ...muted, fontSize: 11, lineHeight: '16px' }}>{t(section.blurbKey, { godName })}</div>

        {pendingCount > 0 && (
          <div style={{
            background: 'var(--cth-lemon-light)', boxShadow: 'inset 0 0 0 1px var(--cth-lemon)',
            padding: '6px 8px', ...uiText, fontSize: 11, lineHeight: '16px'
          }}>
            {pendingCount === 1
              ? t('triggerHistory.heldOne')
              : t('triggerHistory.heldMany', { count: pendingCount })}
          </div>
        )}

        {error && (
          <div style={{
            background: 'var(--cth-coral-light)', boxShadow: 'inset 0 0 0 1px var(--cth-coral)',
            padding: '6px 8px', ...uiText, fontSize: 11, lineHeight: '16px'
          }}>{error}</div>
        )}

        {exchanges.length === 0 ? (
          source === 'org' ? (
            <EmptyState
              title={t('triggerHistory.emptyOrgTitle')}
              body={t('triggerHistory.emptyOrgBody')}
            />
          ) : (
            <EmptyState
              title={t('triggerHistory.emptyWebhookTitle')}
              body={t('triggerHistory.emptyWebhookBody', { godName })}
            />
          )
        ) : (
          exchanges.map((ex) => (
            <ExchangeCard
              key={ex.key}
              ex={ex}
              expanded={expanded}
              toggle={toggle}
              busy={busy}
              onDecide={decide}
            />
          ))
        )}

        {counts[source].total > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
            {confirmClear ? (
              <>
                <div style={{ ...muted, fontSize: 11, lineHeight: '16px' }}>
                  {t('triggerHistory.clearConfirm', { count: counts[source].total })}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <PixelButton variant="destructive" size="sm" onClick={clear}>{t('triggerHistory.deleteThem')}</PixelButton>
                  <PixelButton variant="ghost" size="sm" onClick={() => setConfirmClear(false)}>
                    {t('triggerHistory.keepThem')}
                  </PixelButton>
                </div>
              </>
            ) : (
              <div>
                <PixelButton
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmClear(true)}
                  title={t('triggerHistory.clearHistoryTitle')}
                >
                  {t('triggerHistory.clearHistory')}
                </PixelButton>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { PixelButton } from '../PixelButton';
import { useStore } from '@/store/store';
import type { TriggerHistoryEntry } from '@shared/triggers';
import { useRtl } from '@/i18n/useDirection';

/**
 * TRIGGER HISTORY —— 外部方对这个 hive 说过什么、我们又回答了什么的台账，
 * 当作对话而不是日志行来读。
 *
 * 台账是扁平的（每个消息一行，新的在前）。操作者真正的问题从来不是「有哪些
 * 行」，而是「他们问了什么，我们答了什么」——所以行在这里按 `correlationId`
 * 在渲染器中折叠成 EXCHANGES（往来），每条往来画成一张卡片，双方正文完整展示。
 *
 * 两个来源共享这份台账（webhook、org），它们是切换而不是堆叠：这里是一个
 * ~360px 的侧栏，两份完整列表放在同一个滚动区里会把你想看的那份埋掉。
 *
 * 唯一可操作的行是被 `strict` / `communication-only` 触发模式拦下的入站消息
 * （`decision: 'pending'`）。它们浮到所在分区顶部，因为批准一条就会向 hive
 * 派发真实工作，而一条滚出视野的滞留消息就是一条永远不会被回答的消息。
 */

/* ─────────────────────────────── ipc 界面 ─────────────────────────────── */

/**
 * trigger-history IPC 与拥有 preload 的主进程改动同时落地；类型化的 `window.cth`
 * 成员也随之而来。在那之前，这个窄小的本地界面 + 一次转换让标签页无需触碰
 * preload 就能编译——而且真实类型出现后也无需编辑，因为形态一致。
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

/** 惰性读取：`window.cth` 由 preload 安装，而不是由模块加载顺序保证。 */
function api(): TriggerHistoryApi {
  return (window.cth ?? {}) as unknown as TriggerHistoryApi;
}

/* ─────────────────────────────── 往来 ───────────────────────────────── */

type Source = 'webhook' | 'org';

interface Exchange {
  key: string;
  /** 旧的在前——往来自上而下阅读，就像对话发生时的顺序。 */
  msgs: TriggerHistoryEntry[];
  /** 决定卡片名字和对端标签的那条：发起它的入站消息，否则是孤立的出站消息。 */
  head: TriggerHistoryEntry;
  /** 仍被扣住等待操作者的入站消息（如果有）。 */
  pending: TriggerHistoryEntry | null;
  answered: boolean;
  latestAt: number;
}

/**
 * 把扁平台账折叠成往来。
 *
 * `correlationId` 是配对键。没有它的行无法与任何东西配对，所以每行都成为以
 * 自己 id 为键的单边往来——未关联的入站消息仍值得一张卡片（它可能是 pending），
 * 未关联的出站消息则是我们发出的、只是没有记录到对应提示词的回复。一个关联组
 * 也可能含有多于两行（一次追问、第二次回复）；这些按时间顺序渲染，而不是被丢弃。
 *
 * 待决（pending）的往来排在最前；其余保持新的在前。
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

/* ──────────────────────────────── 辅助 ────────────────────────────────── */

// 复制而来，不是导入：SchedulesTab.tsx 正在被删除。
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

/** 为静止状态折叠长正文。展开时总是显示全部。 */
function clampBody(body: string): { text: string; clipped: boolean } {
  const lines = body.split('\n');
  if (body.length <= CLAMP_CHARS && lines.length <= CLAMP_LINES) return { text: body, clipped: false };
  const head = lines.slice(0, CLAMP_LINES).join('\n');
  const cut = head.length > CLAMP_CHARS ? head.slice(0, CLAMP_CHARS).replace(/\s+\S*$/, '') : head;
  return { text: `${cut.trimEnd()}…`, clipped: true };
}

/* ───────────────────────────────── 样式 ────────────────────────────────── */

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

/* ─────────────────────────────── 单条消息 ─────────────────────────────── */

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

/* ────────────────────────────── 单次往来 ─────────────────────────────── */

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

  // 还没有任何回复的往来的尾行。这里的沉默是正常的——这是一条仍在途中的消息，
  // 绝不是失败。
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

/* ───────────────────────────── 空状态 ──────────────────────────────── */

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

/* ──────────────────────────────── 标签页本体 ────────────────────────────────── */

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
      .catch(() => { /* main 尚未就绪；更新事件会把我们带回来 */ });
  }, []);

  useEffect(() => {
    load();
    // 与 onMissionsUpdated 相同的形态：订阅，拿回一个退订函数。
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
    // 乐观更新：行的判定是操作者自己的输入，所以它应该在他们点击的瞬间落地。
    // 更新事件无论如何都会把它校准回来。
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
      {/* 区块切换器 —— 面板太窄，无法上下堆叠两个列表。 */}
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

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { PixelBadge } from './PixelBadge';
import { Icon } from './Icon';
import { useStore } from '@/store/store';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';
import { useRtl } from '@/i18n/useDirection';
import { normalizeDuty, type AgentDuty } from '@shared/agentDuty';
import type { ReviewStage, ReviewVerdict } from '@shared/reviewGate';

/** A card on the task kanban. Mirrors HiveTask in the main/preload process —
 *  re-declared locally so the renderer doesn't reach into the preload package
 *  (same convention as store/config.ts). */
export interface HumanQA {
  q: string;
  a?: string;
  askedAt?: string;
  answeredAt?: string;
  /** Set when the human dismisses the ask from the ASK ME board WITHOUT
   *  answering — the question stays on the card (history is preserved) but
   *  openQuestion() stops returning it, so the card leaves ASK ME. */
  dismissedAt?: string;
}

/** One entry of a card's review trail — who handed over, approved, or sent it
 *  back, and in which work round. Mirrors reviewGate.TaskReview. */
export interface TaskReviewEntry {
  by: string;
  duty: AgentDuty;
  verdict: ReviewVerdict;
  revision: number;
  at?: string;
  note?: string;
}

export interface HiveTask {
  id: string;
  title: string;
  description?: string;
  assignee?: string;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  dependsOn: string[];
  priority: number;
  createdAt: string;
  /** First-class human feedback: the god appends {q} when a card needs the
   *  human; the ASK ME view fills in {a}. Full history stays on the card. */
  humanQA?: HumanQA[];
  /** Current work round; a rejection or a re-submit bumps it. Absent = 0. */
  revision?: number;
  /** The planner's plan — what the developer builds from, on every round. */
  plan?: string;
  /** The review trail, all rounds. The gate reads only the current round. */
  reviews?: TaskReviewEntry[];
}

/** The review stage main derived for each card (`hive:tasks` returns it beside
 *  the cards, never on them, so nothing can write a derived field back onto the
 *  ledger). Empty when the hive has no reviewing duty. */
export function parseStages(raw: unknown): Record<string, ReviewStage> {
  const stages = (raw && typeof raw === 'object') ? (raw as { stages?: unknown }).stages : undefined;
  if (!stages || typeof stages !== 'object') return {};
  const out: Record<string, ReviewStage> = {};
  for (const [id, stage] of Object.entries(stages as Record<string, unknown>)) {
    if (stage === 'implementing' || stage === 'peer-review' || stage === 'final-review' || stage === 'complete') {
      out[id] = stage;
    }
  }
  return out;
}

/** A stage worth a chip: the card is waiting on somebody's verdict. `implementing`
 *  is the normal state of a doing card and `complete` is what done means. */
export function waitsOnReview(
  stage: ReviewStage | undefined
): stage is 'planning' | 'peer-review' | 'final-review' {
  return stage === 'planning' || stage === 'peer-review' || stage === 'final-review';
}

/** The card's currently open question for the human, if any. An entry the human
 *  dismissed (dismissedAt) counts as resolved, same as an answered one. */
export function openQuestion(t: HiveTask): HumanQA | undefined {
  if (!Array.isArray(t.humanQA)) return undefined;
  for (let i = t.humanQA.length - 1; i >= 0; i--) {
    const e = t.humanQA[i];
    if (e && typeof e.q === 'string' && !e.a && !e.dismissedAt) return e;
  }
  return undefined;
}

/** Waiting on the human = blocked with an unanswered question on the card. */
export function waitsOnHuman(t: HiveTask): boolean {
  return t.status === 'blocked' && !!openQuestion(t);
}

type Status = HiveTask['status'];

const COLUMNS: { key: Status; labelKey: string; accent: string }[] = [
  { key: 'todo',    labelKey: 'kanban.colTodo',    accent: 'var(--cth-sky)' },
  { key: 'doing',   labelKey: 'kanban.colDoing',   accent: 'var(--cth-lemon)' },
  { key: 'blocked', labelKey: 'kanban.colBlocked', accent: 'var(--cth-coral)' },
  { key: 'done',    labelKey: 'kanban.colDone',    accent: 'var(--cth-mint)' }
];

const POLL_MS = 5000;

/** Deterministic fallback id derived from a task's content (djb2 → base36).
 *  Used for tasks lacking a valid string id so re-parsing tasks.json on every
 *  5s poll yields the SAME id — no React key churn / card remount. Unlike
 *  shortId() (random, for brand-new tasks), this never changes across polls. */
function stableId(seed: string): string {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = (((h << 5) + h) ^ seed.charCodeAt(i)) | 0;
  return `t-${(h >>> 0).toString(36)}`;
}

/** Normalize whatever hive:tasks returns into a typed task array. The god
 *  writes this file by hand — every field except the shape itself is optional
 *  in practice, so EVERY consumer must go through this (exported for the
 *  detail overlay; a raw card without dependsOn once crashed it). */
export function parseTasks(raw: unknown): HiveTask[] {
  const list = (raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks))
    ? (raw as { tasks: unknown[] }).tasks
    : [];
  return list
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t, i) => ({
      id: typeof t.id === 'string' && t.id
        ? t.id
        : stableId(`${typeof t.title === 'string' ? t.title : ''}|${typeof t.createdAt === 'string' ? t.createdAt : ''}|${i}`),
      title: typeof t.title === 'string' ? t.title : '(untitled)',
      description: typeof t.description === 'string' ? t.description : undefined,
      assignee: typeof t.assignee === 'string' ? t.assignee : undefined,
      status: (['todo', 'doing', 'blocked', 'done'] as const).includes(t.status as Status)
        ? (t.status as Status) : 'todo',
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.filter((d): d is string => typeof d === 'string') : [],
      priority: typeof t.priority === 'number' ? t.priority : 3,
      createdAt: typeof t.createdAt === 'string' ? t.createdAt : new Date().toISOString(),
      humanQA: Array.isArray(t.humanQA)
        ? (t.humanQA as unknown[])
          .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && typeof (e as { q?: unknown }).q === 'string')
          .map((e) => ({
            q: e.q as string,
            a: typeof e.a === 'string' ? e.a : undefined,
            askedAt: typeof e.askedAt === 'string' ? e.askedAt : undefined,
            answeredAt: typeof e.answeredAt === 'string' ? e.answeredAt : undefined,
            // Preserve a dismissal across the 5s re-parse, else the card would
            // resurface on the next poll (openQuestion would see it as open).
            dismissedAt: typeof e.dismissedAt === 'string' ? e.dismissedAt : undefined
          }))
        : undefined,
      revision: typeof t.revision === 'number' && Number.isFinite(t.revision) ? t.revision : undefined,
      plan: typeof t.plan === 'string' && t.plan.trim() ? t.plan : undefined,
      reviews: Array.isArray(t.reviews)
        ? (t.reviews as unknown[])
          .filter((e): e is Record<string, unknown> =>
            !!e && typeof e === 'object' &&
            typeof (e as { by?: unknown }).by === 'string' &&
            ['planned', 'submitted', 'approved', 'changes-requested'].includes((e as { verdict?: unknown }).verdict as string))
          .map((e) => ({
            by: e.by as string,
            duty: normalizeDuty(e.duty),
            verdict: e.verdict as ReviewVerdict,
            revision: typeof e.revision === 'number' && Number.isFinite(e.revision) ? e.revision : 0,
            at: typeof e.at === 'string' ? e.at : undefined,
            note: typeof e.note === 'string' ? e.note : undefined
          }))
        : undefined
    }));
}

/**
 * Task kanban over hive/tasks.json — a READ surface. Polls every 5s; cards
 * carry just the title and open the app-wide detail overlay on click. The god
 * is the ledger's writer: new work enters via the dispatch box (mailed to the
 * god), never by the human inserting cards the orchestrator never heard about.
 */
export function TasksKanban() {
  const { t } = useTranslation();
  const agents = useStore((s) => s.agents);
  const [tasks, setTasks] = useState<HiveTask[]>([]);
  const [stages, setStages] = useState<Record<string, ReviewStage>>({});
  // Detail view: cards show just the title — clicking one opens the full
  // breakdown as an APP-WIDE overlay over the office floor (see
  // TaskDetailOverlay) — the content grows (contracts, deps, human Q&A), so it
  // gets the big stage instead of the narrow side panel.
  const openTaskDetail = useStore((s) => s.openTaskDetail);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const raw = await window.cth.hiveTasks();
      setTasks(parseTasks(raw));
      setStages(parseStages(raw));
    } catch { /* keep last good */ }
  }, []);

  // Dismiss a card off the board (human-initiated). The kanban is otherwise the
  // god's to write, but a person can clear a card they no longer want tracked.
  // Main removes the named id from its latest on-disk ledger, so a webhook or
  // god card added since this renderer's last poll cannot be lost.
  const dismissTask = useCallback(async (id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id)); // optimistic
    try {
      const result = await window.cth.hiveDeleteTask(id);
      if (!result.ok) void refresh();
    } catch { /* keep last good; the next poll re-syncs from disk */ }
  }, [refresh]);

  useEffect(() => {
    refresh();
    timer.current = setInterval(refresh, POLL_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [refresh]);

  const restorableAgents = useStore((s) => s.restorableAgents);
  /** Resolve an assignee id to a display name — falls back to the restorable
   *  roster so a done card keeps its author's name even after that worker's
   *  terminal is gone, then to the raw id. */
  const nameFor = (id?: string): string | undefined =>
    id
      ? (agents.find((a) => a.id === id)?.name
        ?? restorableAgents.find((a) => a.id === id)?.name
        ?? id)
      : undefined;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--cth-paper-200)', position: 'relative' }}>
      {/* Toolbar — read-only: the god is the ledger's writer. New work enters
          through the dispatch box (which mails the god), not by the human
          inserting cards the orchestrator never heard about. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', flexShrink: 0,
        borderBottom: '1px solid var(--cth-ink-300)'
      }}>
        <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-500)' }}>
          {t('kanban.count', { count: tasks.length })}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--cth-ink-300)' }}>
          {t('kanban.newWorkHint')}
        </span>
      </div>

      {/* Columns */}
      <div style={{
        flex: 1, minHeight: 0, display: 'flex', gap: 8, padding: 10, overflowX: 'auto'
      }}>
        {COLUMNS.map((col) => {
          const cards = tasks.filter((t) => t.status === col.key);
          return (
            <div key={col.key} style={{
              flex: '1 1 0', minWidth: 170, display: 'flex', flexDirection: 'column',
              background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px 4px',
                background: col.accent, boxShadow: 'inset 0 -1px 0 var(--cth-ink-900)',
                fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-900)'
              }}>
                {t(col.labelKey)}
                <span style={{ marginLeft: 'auto', fontSize: 11, fontFamily: 'var(--cth-font-ui)' }}>{cards.length}</span>
              </div>
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {cards.length === 0 && (
                  <div style={{ fontSize: 12, color: 'var(--cth-ink-300)', textAlign: 'center', padding: '8px 0' }}>—</div>
                )}
                {cards.map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    stage={stages[t.id]}
                    accent={col.accent}
                    assigneeName={nameFor(t.assignee)}
                    onOpen={() => openTaskDetail(t.id)}
                    onDismiss={() => dismissTask(t.id)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Card ────────────────────────────────────────────────────────────────────
// Deliberately minimal — a colored status edge, the task id, the title, a
// whisper of an assignee. Everything else (the full contract, deps, controls)
// lives in the detail view a click away: a kanban card can carry little more
// than a title.

function TaskCard({ task, stage, accent, assigneeName, onOpen, onDismiss }: {
  task: HiveTask;
  /** Review stage from main; a chip when the card is waiting on a verdict. */
  stage?: ReviewStage;
  accent: string;
  assigneeName?: string;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div style={{ position: 'relative', display: 'flex' }}>
      <button
        onClick={onOpen}
        title={t('kanban.openTaskDetails')}
        style={{
          flex: 1, minWidth: 0,
          display: 'flex', alignItems: 'stretch', gap: 0, padding: 0,
          border: 'none', cursor: 'pointer', textAlign: 'left',
          background: 'var(--cth-paper-100)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
        }}
      >
        <span style={{ width: 4, flexShrink: 0, background: accent, boxShadow: 'inset -1px 0 0 var(--cth-ink-700)' }} />
        <span style={{ flex: 1, minWidth: 0, padding: '6px 18px 6px 7px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {/* The id the god writes into tasks.json (bmt-12, or a synthetic
              t-xxxx). Cards get referred to by id in dispatches and in Slack,
              so it has to be readable without opening the detail view. Mono
              because it's an identifier you retype. Sits inside the text
              column, so the 18px right padding keeps it clear of the ✕ and
              the '?' badge. */}
          <span style={{
            fontFamily: 'var(--cth-font-mono)', fontSize: 10,
            color: 'var(--cth-ink-500)'
          }}>{task.id}</span>
          <span style={{
            fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '16px',
            color: 'var(--cth-ink-900)',
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden'
          }}>{task.title}</span>
          {assigneeName && (
            <span style={{ fontSize: 10, color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-display)' }}>
              {assigneeName.toUpperCase()}
            </span>
          )}
        </span>
        {/* A card the god closed that the gate holds open reads as an ordinary
            doing card without this — the operator would see work "still going"
            with nobody working on it. The chip says who it is actually waiting for. */}
        {task.status !== 'done' && waitsOnReview(stage) && (
          <span title={t(`kanban.stage.${stage}`)} style={{
            alignSelf: 'center', marginRight: 18, flexShrink: 0,
            fontFamily: 'var(--cth-font-display)', fontSize: 8, padding: '2px 5px 1px',
            background: stage === 'planning' ? 'var(--cth-lilac)'
              : stage === 'final-review' ? 'var(--cth-peach)' : 'var(--cth-lemon)',
            color: 'var(--cth-ink-900)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
            textTransform: 'uppercase', whiteSpace: 'nowrap'
          }}>{t(`kanban.stage.${stage}`)}</span>
        )}
        {waitsOnHuman(task) && (
          <span title={t('kanban.needsYouTitle')} style={{
            alignSelf: 'center', marginRight: 18, flexShrink: 0,
            fontFamily: 'var(--cth-font-display)', fontSize: 10, padding: '2px 5px 1px',
            background: 'var(--cth-lilac)', color: 'var(--cth-ink-900)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
          }}>?</span>
        )}
      </button>
      {/* Dismiss — sibling button (not nested) so it never triggers onOpen. */}
      <button
        onClick={(e) => { e.stopPropagation(); onDismiss(); }}
        title={t('kanban.dismissTitle')}
        aria-label={t('kanban.dismissAria')}
        style={{
          position: 'absolute', top: 0, right: 0, width: 16, height: 16, padding: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
          border: 'none', cursor: 'pointer', background: 'transparent',
          color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-ui)', fontSize: 12
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--cth-coral)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--cth-ink-500)'; }}
      >✕</button>
    </div>
  );
}

// ─── Detail view ─────────────────────────────────────────────────────────────
// The full breakdown of one task: status, assignee, priority, the complete
// description (the god writes 4-part dispatch contracts in there — preserved
// line by line), dependencies resolved to their titles, the human Q&A trail,
// and the move/assign controls that used to crowd every card. Rendered as an
// APP-WIDE overlay (over the office floor) — this content grows, so it gets
// the big stage instead of the narrow side panel. Exported for App's
// TaskDetailOverlay; opened via the store's openTaskDetail from anywhere.

export function TaskDetail({ task, all, assigneeName, stage, nameFor, onMove, onAssign, notice, onClose }: {
  task: HiveTask;
  all: HiveTask[];
  assigneeName?: string;
  /** Review stage from main, shown beside the status. */
  stage?: ReviewStage;
  /** Resolves a reviewer's agent id to a display name for the trail. */
  nameFor?: (id: string) => string | undefined;
  onMove: (s: Status) => void;
  /** A one-line explanation for a move that did not take — today, the review
   *  gate refusing Done. Rendered next to the status control that was used, so
   *  the answer is where the action was. */
  notice?: string;
  onAssign: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const rtl = useRtl();
  const col = COLUMNS.find((c) => c.key === task.status) ?? COLUMNS[0];
  // Belt + suspenders: parseTasks normalizes these, but the ledger is a
  // hand-written file — never trust a card's shape at the point of use.
  const deps = (task.dependsOn ?? [])
    .map((id) => all.find((t) => t.id === id))
    .filter((t): t is HiveTask => !!t);
  const created = new Date(task.createdAt);
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 280,
        background: 'rgba(26, 19, 32, 0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: 720, maxWidth: '94vw', maxHeight: '90vh', display: 'flex' }}>
        <PixelPanel variant="dialog" title={t('kanban.taskTitle')} noPadding style={{ display: 'flex', flexDirection: 'column', width: '100%', minHeight: 0 }}>
          <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, overflowY: 'auto' }}>
            {/* Title under a status-colored bar */}
            <div style={{ borderLeft: `4px solid ${col.accent}`, paddingLeft: 8 }}>
              <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 15, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                {task.title}
              </div>
            </div>

            {/* Fact row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {/* The id leads the row for the same reason it leads on the card:
                  it is the handle every dispatch and every message uses to name
                  this task, so it should be the first thing here too. */}
              <span style={{
                fontFamily: 'var(--cth-font-mono)', fontSize: 10, color: 'var(--cth-ink-500)'
              }}>{task.id}</span>
              <span style={{
                fontFamily: 'var(--cth-font-display)', fontSize: 8, padding: '2px 6px 1px',
                background: col.accent, color: 'var(--cth-ink-900)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
              }}>{t(col.labelKey)}</span>
              {assigneeName
                ? <PixelBadge status="working" label={assigneeName} />
                : <span style={{ fontSize: 11, color: 'var(--cth-ink-300)' }}>{t('kanban.unassigned')}</span>}
              {stage && stage !== 'implementing' && (
                <span title={t(`kanban.stage.${stage}`)} style={{
                  fontFamily: 'var(--cth-font-display)', fontSize: 8, padding: '2px 6px 1px',
                  background: stage === 'complete' ? 'var(--cth-mint)'
                    : stage === 'planning' ? 'var(--cth-lilac)'
                      : stage === 'final-review' ? 'var(--cth-peach)' : 'var(--cth-lemon)',
                  color: 'var(--cth-ink-900)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                  textTransform: 'uppercase'
                }}>{t(`kanban.stage.${stage}`)}</span>
              )}
              <PriorityDots level={Math.max(1, Math.min(5, task.priority))} />
              <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-display)' }}>
                {isNaN(created.getTime()) ? '' : created.toLocaleString()}
              </span>
            </div>

            {/* The contract — preserved line by line */}
            <div style={{
              padding: 10, background: 'var(--cth-paper-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              fontFamily: 'var(--cth-font-mono)', fontSize: 12, lineHeight: '18px',
              color: 'var(--cth-ink-900)', whiteSpace: 'pre-wrap', wordBreak: 'break-word'
            }} dir={rtl ? 'auto' : undefined}>
              {task.description?.trim() || <span style={{ color: 'var(--cth-ink-300)' }}>{t('kanban.noDescription')}</span>}
            </div>

            {/* The human Q&A trail — every decision documented on the card.
                Rendered as markdown (card variant), matching the ASK ME tab the
                "view earlier answers" link arrives from. */}
            {(task.humanQA?.length ?? 0) > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)' }}>
                  {t('kanban.humanQA')}
                </div>
                {task.humanQA!.map((e, i) => (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div style={{
                      display: 'flex', gap: 6, padding: '5px 7px',
                      background: 'var(--cth-lilac-light, #ece2f5)',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                      fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-900)'
                    }}>
                      <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, flexShrink: 0, marginTop: 2 }}>Q</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <MarkdownPreview source={e.q} variant="card" />
                      </div>
                    </div>
                    {e.a ? (
                      <div style={{
                        display: 'flex', gap: 6, padding: '5px 7px',
                        background: 'var(--cth-mint-light, #d9eed9)',
                        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                        fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-900)'
                      }}>
                        <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, flexShrink: 0, marginTop: 2 }}>A</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <MarkdownPreview source={e.a} variant="card" />
                        </div>
                      </div>
                    ) : (
                      <div style={{ fontSize: 11, color: 'var(--cth-coral)', fontFamily: 'var(--cth-font-display)' }}>
                        {t('kanban.awaitingAnswer')}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* The plan. Its own block above the trail, because it is what the
                work is measured against and it survives every rejection —
                burying it in the history would hide the brief behind the
                arguments about the brief. */}
            {task.plan && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)' }}>
                  {t('kanban.plan')}
                </div>
                <div style={{
                  padding: 10, background: 'var(--cth-lilac-light, #ece2f5)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                  fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-900)'
                }}>
                  <MarkdownPreview source={task.plan} variant="card" />
                </div>
              </div>
            )}

            {/* The review trail — every handover and verdict, all rounds. The
                gate only counts the current round, so older rounds are shown
                dimmed: they explain why the card came back, not where it stands. */}
            {(task.reviews?.length ?? 0) > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)' }}>
                  {t('kanban.reviews')}
                </div>
                {task.reviews!.map((e, i) => {
                  const current = e.revision === (task.revision ?? 0);
                  const tone = e.verdict === 'approved' ? 'var(--cth-mint-light, #d9eed9)'
                    : e.verdict === 'changes-requested' ? 'var(--cth-coral-light, #f5dcd8)'
                      : 'var(--cth-cream-200)';
                  const when = e.at ? new Date(e.at) : null;
                  return (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'baseline', gap: 8, padding: '5px 7px',
                      background: tone, boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                      fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-900)',
                      opacity: current ? 1 : 0.55
                    }}>
                      <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, flexShrink: 0, textTransform: 'uppercase' }}>
                        {t(`kanban.verdict.${e.verdict}`)}
                      </span>
                      <span style={{ flexShrink: 0, fontWeight: 600 }}>{nameFor?.(e.by) ?? e.by}</span>
                      {e.duty !== 'unassigned' && (
                        <span style={{ fontSize: 10, color: 'var(--cth-ink-500)', flexShrink: 0 }}>{t(`duty.label.${e.duty}`)}</span>
                      )}
                      {e.note && <span style={{ flex: 1, minWidth: 0, color: 'var(--cth-ink-700)' }}>{e.note}</span>}
                      <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-display)', flexShrink: 0 }}>
                        {t('kanban.round', { n: e.revision + 1 })}{when && !isNaN(when.getTime()) ? ` · ${when.toLocaleString()}` : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Dependencies, resolved to titles */}
            {deps.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)' }}>
                  {t('kanban.dependsOn')}
                </div>
                {deps.map((d) => {
                  const dc = COLUMNS.find((c) => c.key === d.status) ?? COLUMNS[0];
                  return (
                    <div key={d.id} style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px',
                      background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                      fontSize: 12, color: 'var(--cth-ink-700)'
                    }}>
                      <span style={{ width: 8, height: 8, background: dc.accent, boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', flexShrink: 0 }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
                    </div>
                  );
                })}
              </div>
            )}

            {notice && (
              <div style={{
                padding: '6px 8px 4px',
                background: 'var(--cth-lemon-light)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                fontFamily: 'var(--cth-font-ui)', fontSize: 12,
                color: 'var(--cth-ink-900)', lineHeight: '16px'
              }}>
                {notice}
              </div>
            )}

            {/* Controls */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <select
                value={task.status}
                onChange={(e) => onMove(e.target.value as Status)}
                style={{
                  flex: 1, padding: '4px 6px', background: 'var(--cth-paper-100)', border: 'none',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', fontFamily: 'var(--cth-font-ui)',
                  fontSize: 12, color: 'var(--cth-ink-900)', cursor: 'pointer'
                }}
              >
                {COLUMNS.map((c) => (<option key={c.key} value={c.key}>{t(c.labelKey).toLowerCase()}</option>))}
              </select>
              <PixelButton variant="secondary" size="sm" onClick={onAssign}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  <Icon name="arrow-right" /> {t('kanban.assign')}
                </span>
              </PixelButton>
              <PixelButton variant="ghost" size="sm" onClick={onClose}>{t('common.close')}</PixelButton>
            </div>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}

function PriorityDots({ level }: { level: number }) {
  const { t } = useTranslation();
  // 1 = lowest, 5 = highest. Warmer fill as priority climbs.
  const color = level >= 4 ? 'var(--cth-coral)' : level === 3 ? 'var(--cth-lemon)' : 'var(--cth-mint)';
  return (
    <span title={t('kanban.priority', { level })} style={{ display: 'inline-flex', gap: 1, flexShrink: 0, marginTop: 2 }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} style={{
          width: 4, height: 8,
          background: i <= level ? color : 'var(--cth-cream-200)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
        }} />
      ))}
    </span>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '6px 8px', background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontFamily: 'var(--cth-font-ui)',
  fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-900)', outline: 'none', boxSizing: 'border-box'
};

const selectStyle: React.CSSProperties = {
  padding: '3px 6px', background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontFamily: 'var(--cth-font-ui)',
  fontSize: 12, color: 'var(--cth-ink-900)', cursor: 'pointer'
};

const labelStyle: React.CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)'
};

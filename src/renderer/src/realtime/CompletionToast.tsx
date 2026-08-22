/**
 * Michael completion toast (card rt-12, Phase 2, plus task-ledger results).
 *
 * When voice-Michael dispatches work fire-and-notify, main detects completion (see
 * src/main/realtimeCompletionWatcher.ts) and — while a session is live — pushes the
 * event to the renderer over the `realtime:completion` channel. Michael SPEAKS it; this
 * component shows a brief matching TOAST so the human has a glanceable record (handy when
 * audio is missed or several finish at once). Local God-owned task results are
 * also read from tasks.json here so the human gets a persistent, glanceable
 * conclusion without scrolling the terminal.
 *
 * Self-contained + self-subscribing: it listens on `window.cth.onRealtimeCompletion`,
 * polls the task ledger, stacks recent completions, auto-dismisses voice events, keeps task
 * results until dismissed, and renders nothing when empty. It owns no realtime/session state.
 * Mount it ONCE anywhere in the renderer tree (Kevin wires the one-line mount near the
 * voice UI); positioning is a fixed bottom-right overlay so it's layout-independent.
 *
 * Branch feat/realtime-michael. See board.md "🎙 REALTIME MICHAEL".
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useStore } from '@/store/store';
import { readTaskResultNotices } from './taskResults';

/** Mirrors the `window.cth.onRealtimeCompletion` payload (preload). `summary` is the
 *  human-speakable line Michael relays; the rest is context for this toast. */
export interface RealtimeCompletionToastData {
  correlationId: string;
  kind: string;
  targetAgentId: string;
  taskId?: string;
  summary: string;
  completedAt: number;
  objective?: string;
}

interface ActiveToast extends RealtimeCompletionToastData {
  /** Stable key for React + dismissal. */
  key: string;
  source: 'voice' | 'task';
}

/** How long each toast lingers before auto-dismiss. */
const AUTO_DISMISS_MS = 9000;
/** Cap on simultaneously-visible toasts (oldest drop off). */
const MAX_VISIBLE = 4;
/** Keep the ledger poll aligned with the existing task-board cadence. */
const TASK_POLL_MS = 5000;

export function CompletionToast(): JSX.Element | null {
  const [toasts, setToasts] = useState<ActiveToast[]>([]);
  const godId = useStore((s) => s.agents.find((a) => a.isGod)?.id ?? '');
  // Stable across renders so the subscription's closures always see live timers.
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = (key: string): void => {
    setToasts((prev) => prev.filter((t) => t.key !== key));
    const tm = timers.current.get(key);
    if (tm) {
      clearTimeout(tm);
      timers.current.delete(key);
    }
  };

  useEffect(() => {
    const subscribe = window.cth?.onRealtimeCompletion;
    if (!subscribe) return;
    const timersAtMount = timers.current;

    const off = subscribe((evt) => {
      const key = `${evt.correlationId}:${evt.completedAt}`;
      setToasts((prev) => {
        const withoutLedgerCopy = evt.taskId
          ? prev.filter((t) => !(t.source === 'task' && t.taskId === evt.taskId))
          : prev;
        if (withoutLedgerCopy.some((t) => t.key === key)) return withoutLedgerCopy; // de-dupe re-delivery
        const toast: ActiveToast = { ...evt, key, source: 'voice' };
        return [...withoutLedgerCopy, toast].slice(-MAX_VISIBLE);
      });
      const tm = setTimeout(() => dismiss(key), AUTO_DISMISS_MS);
      timersAtMount.set(key, tm);
    });

    return () => {
      off?.();
      for (const tm of timersAtMount.values()) clearTimeout(tm);
      timersAtMount.clear();
    };
    // Mount-once: the subscription + dismissal use refs + functional setState, so they
    // never need to re-bind on re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!godId) return;
    let alive = true;
    let primed = false;
    const seen = new Set<string>();

    const poll = async (): Promise<void> => {
      const raw = await window.cth.hiveTasks().catch(() => null);
      if (!alive) return;
      const current = readTaskResultNotices(raw, godId);
      if (!primed) {
        current.forEach((notice) => seen.add(notice.key));
        primed = true;
        return;
      }

      const fresh = current.filter((notice) => !seen.has(notice.key));
      current.forEach((notice) => seen.add(notice.key));
      if (fresh.length === 0) return;

      setToasts((prev) => {
        let next = [...prev];
        for (const notice of fresh) {
          next = next.filter((toast) => toast.taskId !== notice.taskId);
          next.push({
            correlationId: `task:${notice.taskId}`,
            kind: 'task',
            targetAgentId: godId,
            taskId: notice.taskId,
            summary: notice.missingResult
              ? 'Task marked done without a readable result.'
              : notice.result,
            completedAt: Date.now(),
            objective: notice.title,
            key: `task:${notice.taskId}`,
            source: 'task'
          });
        }
        return next.slice(-MAX_VISIBLE);
      });
    };

    void poll();
    const timer = setInterval(() => { void poll(); }, TASK_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [godId]);

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        maxWidth: 360,
        pointerEvents: 'none'
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.key}
          role="status"
          style={{
            pointerEvents: 'auto',
            background: 'var(--cth-paper-100)',
            boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500), 4px 4px 0 0 var(--cth-ink-900)',
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 6
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontFamily: 'var(--cth-font-display)',
              fontSize: 8,
              lineHeight: '12px',
              color: 'var(--cth-ink-900)',
              textTransform: 'uppercase'
            }}
          >
            <Icon name={t.source === 'task' ? 'check' : 'bell'} /> Michael · {t.source === 'task' ? 'result' : 'completed'}
            <button
              type="button"
              onClick={() => dismiss(t.key)}
              aria-label="Dismiss"
              style={{
                marginLeft: 'auto',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                fontFamily: 'var(--cth-font-display)',
                fontSize: 10,
                lineHeight: '10px',
                color: 'var(--cth-ink-700)',
                padding: 0
              }}
            >
              ✕
            </button>
          </div>
          <div
            style={{
              fontFamily: 'var(--cth-font-ui)',
              fontSize: 15,
              lineHeight: '20px',
              color: 'var(--cth-ink-900)',
              whiteSpace: 'pre-wrap'
            }}
          >
            {t.summary}
          </div>
          {t.objective && (
            <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-700)' }}>
              {t.objective}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

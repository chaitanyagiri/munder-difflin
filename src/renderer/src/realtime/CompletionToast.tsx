/**
 * Realtime Michael — completion toast (card rt-12, Phase 2, the visual half of
 * "respond when done").
 *
 * When voice-Michael dispatches work fire-and-notify, main detects completion (see
 * src/main/realtimeCompletionWatcher.ts) and — while a session is live — pushes the
 * event to the renderer over the `realtime:completion` channel. Michael SPEAKS it; this
 * component shows a brief matching TOAST so the human has a glanceable record (handy when
 * audio is missed or several finish at once).
 *
 * Self-contained + self-subscribing: it listens on `window.cth.onRealtimeCompletion`,
 * stacks recent completions, auto-dismisses each, and renders nothing when empty. It owns
 * no realtime/session state — it's a pure consumer of Kevin's push channel (rt-12 seam).
 * Mount it ONCE anywhere in the renderer tree (Kevin wires the one-line mount near the
 * voice UI); positioning is a fixed bottom-right overlay so it's layout-independent.
 *
 * Branch feat/realtime-michael. See board.md "🎙 REALTIME MICHAEL".
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';

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
}

/** How long each toast lingers before auto-dismiss. */
const AUTO_DISMISS_MS = 9000;
/** Cap on simultaneously-visible toasts (oldest drop off). */
const MAX_VISIBLE = 4;

export function CompletionToast(): JSX.Element | null {
  const [toasts, setToasts] = useState<ActiveToast[]>([]);
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
        if (prev.some((t) => t.key === key)) return prev; // de-dupe re-delivery
        return [...prev, { ...evt, key }].slice(-MAX_VISIBLE);
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
            boxShadow: 'inset 0 0 0 2px var(--cth-ink-900), 4px 4px 0 0 var(--cth-ink-900)',
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
            <Icon name="bell" /> Michael · completed
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
              color: 'var(--cth-ink-900)'
            }}
          >
            {t.summary}
          </div>
          {t.objective && (
            <div style={{ fontSize: 13, lineHeight: '17px', color: 'var(--cth-ink-700)' }}>
              {t.objective}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

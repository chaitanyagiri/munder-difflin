/**
 * Realtime Michael —— 完成提示（卡片 rt-12，第二阶段，“完成时响应”的视觉半）。
 *
 * 当语音 Michael 派发 fire-and-notify 工作时，main 检测完成（见
 * src/main/realtimeCompletionWatcher.ts），并在会话活跃期间通过
 * `realtime:completion` 通道把事件推给渲染端。Michael 把它说出来；这个组件
 * 显示一条简短匹配的 TOAST，让人有一份可瞥见的记录（漏听音频或同时完成
 * 多条时很有用）。
 *
 * 自包含 + 自订阅：它监听 `window.cth.onRealtimeCompletion`、堆叠最近的完成
 * 事件、自动逐条消失，并在为空时不渲染任何东西。它不持有 realtime/session
 * 状态——纯粹是 Kevin 推送通道（rt-12 seam）的消费者。在渲染树里任意位置
 * 挂载一次即可（Kevin 在语音 UI 附近接上这一行挂载）；定位是固定右下角
 * 覆盖层，与布局无关。
 *
 * 分支 feat/realtime-michael。见 board.md “🎙 REALTIME MICHAEL”。
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/Icon';
import { useStore } from '@/store/store';

/** 镜像 `window.cth.onRealtimeCompletion` 载荷（preload）。`summary` 是
 *  Michael 转述的、人类可说的行；其余是这条 toast 的上下文。 */
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
  /** React 渲染 + 消失用的稳定 key。 */
  key: string;
}

/** 每条 toast 自动消失前停留多久。 */
const AUTO_DISMISS_MS = 9000;
/** 同时可见 toast 的上限（最老的先掉出）。 */
const MAX_VISIBLE = 4;

export function CompletionToast(): JSX.Element | null {
  const { t } = useTranslation();
  const godName = useStore((s) => s.agents.find((a) => a.isGod)?.name) ?? 'the orchestrator';
  const [toasts, setToasts] = useState<ActiveToast[]>([]);
  // 跨渲染稳定，让订阅的闭包总能看到实时定时器。
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
    // 只挂载一次：订阅 + 消失使用 refs + 函数式 setState，所以重渲染时
    // 永不需要重新绑定。
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
      {toasts.map((toast) => (
        <div
          key={toast.key}
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
            <Icon name="bell" /> {godName} · completed
            <button
              type="button"
              onClick={() => dismiss(toast.key)}
              aria-label={t('completionToast.dismiss')}
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
            {toast.summary}
          </div>
          {toast.objective && (
            <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-700)' }}>
              {toast.objective}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

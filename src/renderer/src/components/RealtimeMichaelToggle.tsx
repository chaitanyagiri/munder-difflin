/**
 * Realtime Michael — voice toggle + live state indicator (card rt-3, Phase 1).
 *
 * A reusable mic button for the god/orchestrator agent ("Michael"). It consumes the
 * already-built `useRealtimeMichael()` voice-loop hook (a shared module-level singleton —
 * see realtime/session.ts) and exposes a single start/stop control plus a live indicator
 * of the loop's status.
 *
 * Gating mirrors the established Free Flow / Groq precedent (FreeFlowButton in
 * MessageQueueComposer): the button stays VISIBLE but DISABLED when no BYOK OpenAI key is
 * present (`hasOpenAiKey === false`), with a tooltip pointing at Settings — so connect() /
 * getUserMedia are never reached without a key (the zero-call-when-unavailable guarantee).
 *
 * Click behaviour: status==='off' → connect(); anything else → disconnect().
 *
 * Rendered in two places (AgentCard for the god card, FullscreenTerminal header when
 * Michael is fullscreen). It is intentionally state-only / hook-only so both can mount it.
 */
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useStore } from '@/store/store';
import { useRealtimeMichael, type RealtimeStatus } from '@/realtime/session';

/** Per-status presentation: button variant, short label, dot color, and (optional)
 *  animation for the live-state indicator dot. Maps hook.status → visuals. */
const STATE_VIEW: Record<
  RealtimeStatus,
  {
    variant: 'primary' | 'secondary' | 'destructive';
    label: string;
    dot: string;
    anim?: string;
    help: string;
    /** When live, the button fill — a distinct accent so the active mic never
     *  reads as a flat black 'primary' button. (working uses the destructive
     *  coral variant, already non-black, so it needs no override.) */
    activeBg?: string;
  }
> = {
  off: {
    variant: 'secondary',
    label: 'talk',
    dot: 'var(--cth-ink-300)',
    help: 'Talk to Michael — start the voice session'
  },
  connecting: {
    variant: 'secondary',
    label: '…',
    dot: 'var(--cth-lemon)',
    anim: 'cth-blink 700ms steps(2, end) infinite',
    help: 'Connecting to Michael…'
  },
  listening: {
    variant: 'primary',
    label: 'listening',
    dot: 'var(--cth-mint)',
    anim: 'cth-pulse 1000ms steps(2, end) infinite',
    help: 'Listening — Michael is hearing you (click to stop)',
    activeBg: 'var(--cth-mint)'
  },
  responding: {
    variant: 'primary',
    label: 'speaking',
    dot: 'var(--cth-sky)',
    anim: 'cth-pulse 600ms steps(2, end) infinite',
    help: 'Michael is speaking (click to stop)',
    activeBg: 'var(--cth-sky)'
  },
  working: {
    variant: 'destructive',
    label: 'working',
    dot: 'var(--cth-coral)',
    anim: 'cth-blink 500ms steps(2, end) infinite',
    help: 'Michael is running a tool — mic muted (click to stop)'
  }
};

export interface RealtimeMichaelToggleProps {
  /** Compact form for the fullscreen header / tight rows — hides the text label. */
  compact?: boolean;
}

export function RealtimeMichaelToggle({ compact = false }: RealtimeMichaelToggleProps) {
  const hasOpenAiKey = useStore((s) => s.hasOpenAiKey);
  const { status, error, connect, disconnect } = useRealtimeMichael();

  const view = STATE_VIEW[status];
  const noKey = !hasOpenAiKey;

  // Without a BYOK OpenAI key: stay visible but disabled (matches FreeFlowButton).
  const title = noKey
    ? 'Add an OpenAI API key in Settings to talk to Michael.'
    : error
      ? `${view.help} — ${error}`
      : view.help;

  const onClick = () => {
    if (noKey) return;
    if (status === 'off') void connect();
    else disconnect();
  };

  // Wrap in a (non-disabled) span so the native title tooltip still shows on hover even
  // when the inner button is disabled — Chromium suppresses tooltips on a disabled button.
  return (
    <span
      title={title}
      className="cth-titlebar-nodrag"
      style={{ display: 'inline-flex' }}
      // Stop the click bubbling to a parent card's onClick (selecting the agent).
      onClick={(e) => e.stopPropagation()}
    >
      <PixelButton
        variant={view.variant}
        size="sm"
        onClick={onClick}
        disabled={noKey}
        // Live mic → a clear accent fill (mint listening / sky speaking) so the
        // active button never reads as a flat black primary. Skipped when disabled
        // (no key) and when off/connecting, so those states are untouched.
        style={!noKey && view.activeBg ? { background: view.activeBg, color: 'var(--cth-ink-900)' } : undefined}
      >
        <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
          {/* Live-state indicator dot — color + animation reflect the loop status. */}
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              flexShrink: 0,
              background: noKey ? 'var(--cth-ink-300)' : view.dot,
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
              animation: noKey ? 'none' : view.anim
            }}
          />
          <Icon name="mic" />
          {!compact && (
            <span style={{ fontFamily: 'var(--cth-font-ui)' }}>
              {noKey ? 'talk' : view.label}
            </span>
          )}
        </span>
      </PixelButton>
    </span>
  );
}

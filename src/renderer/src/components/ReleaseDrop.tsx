/**
 * The release drop — a centered, full-bleed "what's new" moment.
 *
 * A corner toast with three clipped bullets is a changelog notification. This is
 * the other thing: a page the release author designs, shown once, at the size the
 * work deserves. The chrome here is deliberately thin — a header, a frame, a
 * footer of actions — because everything that should carry personality lives
 * inside the authored HTML, and the app's job is to present it and get out of
 * the way.
 *
 * The authored HTML runs in an iframe with `sandbox=""` and a `default-src 'none'`
 * CSP (see shared/releaseDrop.ts for why that is not negotiable). Two consequences
 * shape this component:
 *
 *   1. Links inside the drop cannot navigate — no scripts, no popups. So every
 *      real action (read the release, star, dismiss, restart) is a chrome button
 *      OUT here, where it is ordinary app code with ordinary permissions.
 *   2. The frame's height cannot be measured (that needs a postMessage bridge,
 *      which needs allow-scripts). So the modal is a fixed viewport-relative box
 *      and the drop scrolls inside it, rather than the box growing to fit.
 */
import { useEffect, useMemo } from 'react';
import { buildDropSrcDoc } from '../../../shared/releaseDrop';

export interface ReleaseDropProps {
  version: string;
  /** Authored HTML, already extracted from the release body. */
  html: string;
  /** 'downloaded' offers a restart; 'available-manual' offers the releases page. */
  canRestart: boolean;
  busy: boolean;
  showStar: boolean;
  onRestart: () => void;
  onOpenRelease: () => void;
  onStar: () => void;
  onDismiss: () => void;
}

export function ReleaseDrop({
  version, html, canRestart, busy, showStar,
  onRestart, onOpenRelease, onStar, onDismiss
}: ReleaseDropProps) {
  const srcDoc = useMemo(() => buildDropSrcDoc(html), [html]);

  // Esc dismisses. A modal this large with no keyboard exit feels like a trap,
  // and "later" is always a legitimate answer to an update.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  // The chrome deliberately drops the app's pixel idiom. Inside this dialog the
  // drop is the subject and the surrounding UI should read as a quiet frame
  // around it — sharp 2px borders and hard drop-shadows fight a modern page.
  const INK = '#14131A';
  const INK_SOFT = '#6C6875';
  const LINE = 'rgba(20,19,26,0.10)';
  const button = (primary: boolean): React.CSSProperties => ({
    padding: '9px 18px',
    borderRadius: 999,
    background: primary ? INK : 'transparent',
    color: primary ? '#FBFAF8' : INK_SOFT,
    border: primary ? '1px solid ' + INK : `1px solid ${LINE}`,
    fontFamily: 'inherit', fontSize: 13.5, fontWeight: primary ? 600 : 500,
    cursor: busy ? 'not-allowed' : 'pointer',
    opacity: busy && primary ? 0.6 : 1
  });

  return (
    <div
      // Backdrop. Clicking it dismisses — same meaning as "later".
      onClick={onDismiss}
      style={{
        position: 'fixed', inset: 0, zIndex: 500,
        background: 'rgba(26,19,32,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
        // Same lesson as the onboarding overlay: center with auto margins on the
        // child, and let the overlay scroll, so a tall dialog is never clipped
        // at the top where it cannot be scrolled back to.
        overflowY: 'auto'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          margin: 'auto',
          // Roughly 1:1 at 80% of the viewport height. Deriving the width FROM the
          // height is what keeps it square as the window changes; `min(…, 94vw)`
          // is the escape hatch for a window too narrow to hold a square that
          // tall, where it becomes a portrait sheet rather than overflowing.
          height: '80vh',
          width: 'min(80vh, 94vw)',
          minHeight: 380,
          display: 'flex', flexDirection: 'column',
          background: '#FBFAF8',
          // Soft, modern elevation — not the app's pixel drop-shadow. The drop is
          // an authored artifact presented BY the app, not a piece of its chrome.
          borderRadius: 20,
          overflow: 'hidden', // so the frame's corners are clipped to the radius
          boxShadow: '0 24px 70px rgba(20,19,26,0.34), 0 2px 8px rgba(20,19,26,0.18)',
          // The app's own UI font is part of its pixel identity and reads as
          // retro chrome wrapped around a modern page. The dialog uses the system
          // stack instead, matching the drop inside it — one typographic voice
          // from the title bar to the buttons.
          fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif'
        }}
      >
        {/* Header — a thin, quiet bar. The drop supplies its own title. */}
        <div style={{
          flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10,
          padding: '14px 18px 12px', borderBottom: `1px solid ${LINE}`,
          background: '#FBFAF8'
        }}>
          <span style={{
            fontSize: 11.5, fontWeight: 600, letterSpacing: '.1em',
            textTransform: 'uppercase', color: INK_SOFT, flex: 1, minWidth: 0
          }}>
            The Precinct · {version}
          </span>
          <button
            onClick={onDismiss}
            aria-label="Close"
            style={{
              width: 28, height: 28, borderRadius: 999, flexShrink: 0,
              border: `1px solid ${LINE}`, background: 'transparent', cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 14, lineHeight: 1, color: INK_SOFT,
              display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}
          >✕</button>
        </div>

        {/* The drop itself — authored HTML, fully sandboxed. */}
        <iframe
          title={`What's new in ${version}`}
          srcDoc={srcDoc}
          sandbox=""
          referrerPolicy="no-referrer"
          style={{
            flex: 1, minHeight: 0, width: '100%', border: 'none',
            background: '#FBFAF8'
          }}
        />

        {/* Actions live out here: the frame cannot navigate, by design. */}
        <div style={{
          flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          padding: '14px 18px', borderTop: `1px solid ${LINE}`,
          background: '#FBFAF8'
        }}>
          {showStar && (
            <button onClick={onStar} style={{
              border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
              fontFamily: 'inherit', fontSize: 13, fontWeight: 500,
              color: INK_SOFT, textDecoration: 'underline', textUnderlineOffset: 3
            }}>⭐ Star us on GitHub</button>
          )}
          <span style={{ flex: 1 }} />
          <button onClick={onDismiss} style={button(false)}>Later</button>
          {canRestart ? (
            <button onClick={onRestart} disabled={busy} style={button(true)}>
              {busy ? 'Restarting…' : 'Restart to update'}
            </button>
          ) : (
            <button onClick={onOpenRelease} style={button(true)}>Open releases</button>
          )}
        </div>
      </div>
    </div>
  );
}

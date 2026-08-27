/**
 * The release drop: a centered, full-bleed "what's new" moment.
 *
 * A corner toast with three clipped bullets is a changelog notification. This is
 * the other thing: a page the release author designs, shown once, at the size the
 * work deserves.
 *
 * The chrome follows the landing site (docs/DESIGN.md), not the app's pixel
 * idiom and not a generic rounded sheet: warm paper, square corners, a thick
 * ink border, a hard offset shadow with no blur, and a dark mono title bar with
 * three square dots. It is the `.win` window from munderdiffl.in, so the moment
 * a user opens the drop it reads as the same product they downloaded from.
 *
 * There is NO chrome button here, on purpose. The app frames the drop and gets
 * out of the way; every action the release wants to offer (read the notes, star
 * the repo, join the Discord) is authored INSIDE the HTML as an ordinary link,
 * where the person writing the release controls the wording and the placement.
 *
 * The authored HTML runs in an iframe with a `default-src 'none'` CSP and a
 * sandbox that grants exactly one capability: `allow-popups` (see
 * shared/releaseDrop.ts for why everything else stays shut). That is what makes
 * an authored `<a target="_blank">` work: the frame cannot navigate anything
 * itself, it can only ASK for a window, and main's setWindowOpenHandler denies
 * the window and hands the URL to the OS browser if and only if it is http(s).
 * No scripts, no same-origin, no forms, no top-level navigation.
 *
 * One consequence still shapes the layout: the frame's height cannot be measured
 * (that needs a postMessage bridge, which needs allow-scripts). So the modal is a
 * fixed viewport-relative box and the drop pages itself inside it, rather than
 * the box growing to fit.
 *
 * Dismissal is Esc, the title bar's close, or a click on the backdrop. A modal
 * this large with no visible way out is a trap, so the close is a real control
 * out here even though the drop itself holds none.
 */
import { useEffect, useMemo, useState } from 'react';
import { buildDropSrcDoc } from '../../../shared/releaseDrop';

export interface ReleaseDropProps {
  version: string;
  /** Authored HTML, already extracted from the release body. */
  html: string;
  onDismiss: () => void;
}

// Landing site palette (docs/DESIGN.md §2). Restated here because the modal is
// app chrome and cannot reach the site's stylesheet; kept in one place so the
// frame's tokens in shared/releaseDrop.ts and this chrome never drift apart.
const PAPER = '#FFFDF7';
const INK = '#1B1B1B';
const INK_FAINT = '#8A867A';
const YELLOW = '#FFCA54';
const SKY = '#72C2DF';
const MAROON = '#B23A4E';
const MONO = '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';

// How long the loader may cover the frame before it is revealed regardless.
//
// The reveal signal is the iframe ELEMENT's own `onLoad` (it fires on the
// parent, needs no script rights in the sandboxed child) — but `load` WAITS for
// subresources, so a drop with slow remote images would hold the loader for the
// whole fetch. With the render-blocking font @import gone (shared/releaseDrop.ts),
// first paint is immediate and onLoad is normally well under this; the cap only
// governs the pathological case, where revealing a paper page whose images are
// still arriving beats a spinner that never ends. 2.5s is long enough not to cut
// off a normal onLoad and short enough not to read as a hang.
const REVEAL_TIMEOUT_MS = 2500;

export function ReleaseDrop({ version, html, onDismiss }: ReleaseDropProps) {
  const srcDoc = useMemo(() => buildDropSrcDoc(html), [html]);

  // The loader covers the frame until it is ready to be seen. `revealed` latches
  // true on the FIRST of two signals — the iframe's onLoad or the timeout cap —
  // and never flips back, so the reveal is monotonic and cannot flicker.
  const [revealed, setReveal] = useState(false);
  const reveal = () => setReveal(true);

  // The timeout cap. Cleared on unmount so a dismissed-early drop schedules
  // nothing, and it races onLoad rather than replacing it: whichever fires first
  // reveals, the other is a harmless no-op against the latched state.
  useEffect(() => {
    const t = setTimeout(reveal, REVEAL_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, []);

  // Esc dismisses. "Later" is always a legitimate answer to an update.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  return (
    <div
      // Backdrop. Clicking it dismisses, same meaning as "later". Warm ink over
      // the app with the site's dotted paper grid, so the window sits on paper
      // rather than floating in a grey void.
      onClick={onDismiss}
      style={{
        position: 'fixed', inset: 0, zIndex: 600,
        background:
          'radial-gradient(rgba(255,253,247,0.16) 1px, transparent 1px) 0 0 / 22px 22px, rgba(27,27,27,0.72)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 28,
        // Center with auto margins on the child and let the overlay scroll, so a
        // tall dialog is never clipped at the top where it cannot be scrolled
        // back to.
        overflowY: 'auto'
      }}
    >
      <div
        role="dialog"
        aria-label={`What's new in Munder Difflin ${version}`}
        onClick={(e) => e.stopPropagation()}
        style={{
          margin: 'auto',
          // A landscape window, like the site's hero frame, not a square card.
          // Width is derived from height so the shape holds as the window
          // resizes; `min(…, 92vw)` is the escape hatch for a narrow window.
          height: 'min(82vh, 720px)',
          width: 'min(calc(82vh * 1.28), 92vw, 920px)',
          minHeight: 420,
          display: 'flex', flexDirection: 'column',
          background: PAPER,
          // The neo-brutalist window: square, 3px ink border, hard 10px offset
          // shadow with no blur. Depth comes from the offset, not elevation.
          border: `3px solid ${INK}`,
          borderRadius: 0,
          boxShadow: `12px 12px 0 ${INK}`,
          overflow: 'hidden',
          fontFamily: MONO
        }}
      >
        {/* Title bar: the site's `.win` header. Dark band, three square dots,
            white mono title, and the only control the chrome owns: close. */}
        <div style={{
          flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12,
          padding: '10px 14px', background: INK, color: PAPER,
          borderBottom: `3px solid ${INK}`
        }}>
          <span aria-hidden style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <i style={{ width: 10, height: 10, background: YELLOW, display: 'block' }} />
            <i style={{ width: 10, height: 10, background: '#72C2DF', display: 'block' }} />
            <i style={{ width: 10, height: 10, background: '#B23A4E', display: 'block' }} />
          </span>
          <span style={{
            flex: 1, minWidth: 0, fontSize: 12, fontWeight: 700, letterSpacing: '.08em',
            textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}>
            Munder Difflin <span style={{ color: YELLOW }}>v{version.replace(/^v/, '')}</span>
            <span style={{ color: INK_FAINT, fontWeight: 500, marginLeft: 10, letterSpacing: '.12em' }}>
              / release notes
            </span>
          </span>
          <span aria-hidden style={{
            flexShrink: 0, fontSize: 11, fontWeight: 500, letterSpacing: '.12em',
            color: INK_FAINT, textTransform: 'uppercase'
          }}>
            esc
          </span>
          <button
            onClick={onDismiss}
            aria-label="Close release notes"
            title="Close (Esc)"
            style={{
              flexShrink: 0, width: 26, height: 26, padding: 0,
              background: PAPER, color: INK, border: `2px solid ${PAPER}`,
              borderRadius: 0, cursor: 'pointer',
              fontFamily: MONO, fontSize: 13, fontWeight: 700, lineHeight: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}
          >✕</button>
        </div>

        {/* The frame area. Relative so the loader can sit exactly over the drop,
            not the title bar. The iframe is always mounted at full opacity — the
            loader is a separate overlay that is REMOVED on reveal, so the failure
            mode of a broken reveal is a brief extra spinner, never a permanently
            hidden frame. */}
        <div style={{ position: 'relative', flex: 1, minHeight: 0, background: PAPER }}>
          {/* The drop itself. `allow-popups` is the ONLY grant: it is what lets an
              authored <a target="_blank"> reach the OS browser, and it carries no
              script, same-origin, form or navigation rights with it. */}
          <iframe
            title={`What's new in ${version}`}
            srcDoc={srcDoc}
            sandbox="allow-popups"
            referrerPolicy="no-referrer"
            // onLoad fires on the PARENT and needs no script rights in the child;
            // it is the honest "the frame is ready" signal. The timeout cap in the
            // effect above covers the case where it is delayed by slow subresources.
            onLoad={reveal}
            style={{
              position: 'absolute', inset: 0, width: '100%', height: '100%',
              border: 'none', background: PAPER
            }}
          />
          {!revealed && <DropLoader />}
        </div>
      </div>
    </div>
  );
}

/** The window before the frame paints. Warm paper (never a white flash) with the
 *  title bar's three square dots marching, in the landing-site palette. Pure
 *  chrome — it carries no control; dismissal stays Esc / close / backdrop. It is
 *  removed the instant the frame is revealed, so it is only ever seen briefly. */
function DropLoader() {
  return (
    <div
      // aria-hidden: the dialog's own label already announces the drop, and a
      // transient loader should not be read out. It sits ABOVE the frame and
      // lets no interaction through, but the frame under it is inert until loaded
      // anyway, so blocking pointer events here changes nothing a user could do.
      aria-hidden
      style={{
        position: 'absolute', inset: 0, zIndex: 1,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 18, background: PAPER
      }}
    >
      <style>{`
        @keyframes drop-load-pulse {
          0%, 80%, 100% { opacity: .2; transform: translateY(0); }
          40% { opacity: 1; transform: translateY(-4px); }
        }
        @media (prefers-reduced-motion: reduce) {
          .drop-load-dot { animation: none !important; opacity: .55 !important; transform: none !important; }
        }
      `}</style>
      <span aria-hidden style={{ display: 'flex', gap: 8 }}>
        {[YELLOW, SKY, MAROON].map((c, i) => (
          <i
            key={c}
            className="drop-load-dot"
            style={{
              width: 12, height: 12, background: c, display: 'block',
              animation: 'drop-load-pulse 1.1s ease-in-out infinite',
              animationDelay: `${i * 0.16}s`
            }}
          />
        ))}
      </span>
      <span style={{
        fontFamily: MONO, fontSize: 11, fontWeight: 500, letterSpacing: '.18em',
        textTransform: 'uppercase', color: INK_FAINT
      }}>
        Loading
      </span>
    </div>
  );
}

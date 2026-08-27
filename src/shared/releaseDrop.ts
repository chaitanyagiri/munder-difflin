/**
 * RELEASE DROPS — a full-bleed, authored "what's new" moment instead of a corner
 * toast with three clipped bullets.
 *
 * The author writes ordinary HTML inside a marked block in the GitHub release
 * body. Everything between the markers is the drop; the rest of the body stays
 * plain markdown for people reading the release on github.com, who should still
 * get a sensible page. A release with no drop block falls back to the existing
 * digest toast, so this is purely additive — no release has to change.
 *
 *   <!-- drop -->
 *   <section class="hero"> … any HTML/CSS, <img>, <video> … </section>
 *   <!-- /drop -->
 *
 * ── Why this file is paranoid ──────────────────────────────────────────────
 * This renders REMOTE, AUTHOR-CONTROLLED markup inside the app. The renderer it
 * would otherwise land in has `window.cth` bridged onto it — spawnPty,
 * writeFileText, updateConfig. Script execution in that context is not a bug,
 * it is arbitrary code execution on the user's machine with the app's full
 * authority, reachable by anyone who can publish a release (or MITM the fetch).
 *
 * So the drop NEVER runs in the app's renderer. It is handed to an iframe whose
 * sandbox grants exactly one thing — `allow-popups` — and, inside that, a CSP of
 * `default-src 'none'` that blocks scripts independently. Two unrelated
 * mechanisms, either sufficient alone. `allow-scripts` must NEVER be added
 * alongside `allow-same-origin`: that pair lets the frame reach out and remove
 * its own sandbox.
 *
 * Why `allow-popups` and nothing else. The modal deliberately carries no buttons
 * of its own, so the actions a release wants to offer are authored here as
 * ordinary `<a target="_blank">` links. A popup is the weakest possible way to
 * honour one: the frame cannot navigate itself or the top window, it can only
 * ASK for a new window, and main's setWindowOpenHandler denies the window and
 * hands the URL to the OS browser only when it is http(s). No script runs, on
 * either side. A same-frame `<a href>` without target="_blank" still does
 * nothing, which is correct — the drop must never be able to replace itself.
 *
 * What works, which is everything a launch page actually needs: images, video,
 * audio, web fonts, gradients, transforms, keyframe animations, grid, and
 * target="_blank" links out. What does not: scripts, forms, same-frame or
 * top-level navigation, and any URL scheme other than http and https.
 */

import { DROP_FONT_WOFF2_BASE64 } from './dropFonts';

const DROP_OPEN = '<!-- drop -->';
const DROP_CLOSE = '<!-- /drop -->';

/**
 * Pull the authored HTML out of a release body, or null when there is none.
 * Deliberately literal: an exact marker pair, first opener to the next closer.
 * Anything unbalanced returns null and the caller falls back to the digest —
 * a half-parsed drop would render as broken markup in front of every user.
 */
export function extractDropHtml(body: string | null | undefined): string | null {
  if (typeof body !== 'string') return null;
  const start = body.indexOf(DROP_OPEN);
  if (start === -1) return null;
  const from = start + DROP_OPEN.length;
  const end = body.indexOf(DROP_CLOSE, from);
  if (end === -1) return null;
  const html = body.slice(from, end).trim();
  return html.length > 0 ? html : null;
}

/**
 * Defence in depth ONLY — the sandbox and the CSP are the real controls.
 *
 * This exists because a CSP typo or a future `allow-scripts` would otherwise be
 * a single point of failure, not because a regex is a competent HTML sanitizer:
 * it is not, and nothing here should ever be relied on as one. It removes the
 * shapes that would be most damaging if the primary controls ever lapsed.
 */
function stripActiveContent(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    // on*= handlers, quoted or bare. Blocked by CSP too (inline handlers are
    // script, and script-src falls back to default-src 'none').
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // A remote `@import` is RENDER-BLOCKING: the frame paints nothing until the
    // stylesheet resolves, and on a network where fonts.googleapis.com is blocked
    // (China) that is a TCP timeout — tens of seconds of white screen. The
    // tightened CSP (style-src 'unsafe-inline', font-src data:) already fails such
    // a fetch FAST rather than letting it hang, but we also drop the rule outright
    // so the frame never even tries and no CSP-violation is logged. Only REMOTE
    // imports go — a `data:` import blocks on nothing and stays. The design fonts
    // are self-hosted in FRAME_FONT_CSS, so an author's `var(--font-sans)` /
    // `var(--font-mono)` renders correctly with zero network either way.
    //
    // Two forms, and both consume the WHOLE statement: the url may hold its own
    // `;` (a font url is `…wght@400;500;600…`), so a naive `[^;]*` would stop
    // inside the url and leave a tail of broken CSS behind.
    .replace(/@import\s+(?:url\(\s*)?(["'])https?:\/\/(?:(?!\1)[\s\S])*\1\s*\)?\s*[^;]*;?/gi, '')
    .replace(/@import\s+url\(\s*https?:\/\/[^)]*\)\s*[^;]*;?/gi, '');
}

/** The design fonts, self-hosted as `data:` URIs so the frame needs no network.
 *  Inter answers `--font-sans` (the drop's declared substitute for Geist) and
 *  JetBrains Mono answers `--font-mono` exactly; both are variable, so one face
 *  each spans weight 400–700. `font-display: swap` means text paints in the
 *  fallback immediately and reflows when the face is ready — but the face is a
 *  data: URI, so "ready" is the same tick and there is nothing to wait on. */
const FRAME_FONT_CSS = `
  @font-face {
    font-family: 'Inter';
    font-style: normal;
    font-weight: 400 700;
    font-display: swap;
    src: url(data:font/woff2;base64,${DROP_FONT_WOFF2_BASE64.inter}) format('woff2');
  }
  @font-face {
    font-family: 'JetBrains Mono';
    font-style: normal;
    font-weight: 400 700;
    font-display: swap;
    src: url(data:font/woff2;base64,${DROP_FONT_WOFF2_BASE64.jetbrainsMono}) format('woff2');
  }
`;

/** Design tokens mirrored into the frame. The drop cannot read the app's CSS
 *  variables across the origin boundary, so the ones worth having are restated
 *  here — an author writing `var(--ink)` gets the app's palette for free, while
 *  a fully bespoke drop can ignore them entirely. */
const FRAME_BASE_CSS = `
  /* The landing site palette (docs/DESIGN.md §2): warm paper, near-black ink,
     one yellow CTA, sky for a highlighted phrase, maroon for the brand. Square
     corners and hard offset shadows are the look; --radius is 0 on purpose.
     --accent and --line are kept as aliases so older drops still resolve. */
  :root {
    --paper: #FFFDF7;
    --cream: #F5F2E8;
    --cream-2: #F5ECD7;
    --white: #FFFFFF;
    --ink: #1B1B1B;
    --ink-dim: #57544C;
    --ink-faint: #8A867A;
    --ink-soft: #57544C;
    --yellow: #FFCA54;
    --sky: #72C2DF;
    --maroon: #B23A4E;
    --lilac: #E4DEFB; --peach: #FBDDBE; --mint: #D6F3E1;
    --tan: #F1E6CC; --rose: #FBE0DF; --sky-soft: #DCEFF7;
    --accent: #B23A4E;
    --line: rgba(27,27,27,0.16);
    --border: 2px solid var(--ink);
    --border-bold: 3px solid var(--ink);
    --shadow-card: 10px 10px 0 var(--ink);
    --shadow-card-sm: 6px 6px 0 var(--ink);
    --shadow-btn: 4px 4px 0 var(--ink);
    --shadow-chip: 3px 3px 0 var(--ink);
    --radius: 0px;
    --pad: clamp(24px, 4.5vw, 48px);
    --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, "PingFang SC", "Microsoft YaHei", "Noto Sans Mono CJK SC", "Geeza Pro", "Noto Naskh Arabic", monospace;
    --font-sans: "Geist", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Geeza Pro", "Noto Naskh Arabic", sans-serif;
    --font-ui: var(--font-sans);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--paper); color: var(--ink);
    font-family: var(--font-sans);
    font-size: 15px; line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    /* The frame owns scrolling: the modal chrome around it stays put while a
       tall drop scrolls, which is what makes a long launch page workable in a
       fixed-height dialog. */
    overflow-x: hidden;
  }

  /* The default layout. An author who writes nothing but semantic HTML, an
     eyebrow, an h1, a lede, a <ul class="features">, gets the designed result
     without writing a line of CSS. Everything here is overridable. */
  .drop { padding: var(--pad); max-width: 780px; margin: 0 auto; }

  .eyebrow {
    font-family: var(--font-mono);
    font-size: 11px; font-weight: 500; letter-spacing: .28em; text-transform: uppercase;
    color: var(--ink-faint); margin: 0 0 14px;
  }
  h1, h2, h3 { font-family: var(--font-mono); }
  h1 {
    font-size: clamp(1.9rem, 5vw, 2.9rem); line-height: 1.04;
    letter-spacing: -0.04em; font-weight: 600; margin: 0 0 .35em;
    text-wrap: balance;
  }
  h2 {
    font-size: clamp(1.1rem, 2.4vw, 1.4rem); line-height: 1.15;
    letter-spacing: -0.03em; font-weight: 600; margin: 0 0 .3em;
  }
  .lede {
    font-size: clamp(1rem, 1.9vw, 1.15rem); line-height: 1.5;
    color: var(--ink-dim); max-width: 58ch; margin: 0 0 2em;
    text-wrap: pretty;
  }
  p { margin: 0 0 1em; }
  a { color: var(--ink); text-decoration-thickness: 2px; text-underline-offset: 3px; }
  a:hover { color: var(--maroon); }
  hr { border: none; border-top: 2px solid var(--ink); margin: 2.2em 0; }

  /* Feature list: stacked rows, each with its own media block. */
  ul.features { list-style: none; padding: 0; margin: 0; display: grid; gap: clamp(28px, 5vw, 48px); }
  ul.features > li { display: grid; gap: 14px; }
  ul.features p { color: var(--ink-dim); margin: 0; max-width: 58ch; }

  /* Media. Images, video and the placeholder all share one silhouette so a drop
     built with placeholders looks identical once real assets land. */
  img, video, canvas, svg, .placeholder {
    display: block; width: 100%; max-width: 100%; height: auto;
    border-radius: 0; border: var(--border);
  }
  figure { margin: 0; }
  figcaption { font-family: var(--font-mono); font-size: 12px; color: var(--ink-faint); margin-top: 10px; }

  /* Drop-in placeholder: <div class="placeholder" data-label="Hero"></div>
     Pure CSS, so it needs no asset and cannot 404 in front of a user. */
  .placeholder {
    aspect-ratio: 16 / 9;
    display: flex; align-items: center; justify-content: center;
    background:
      repeating-linear-gradient(135deg,
        rgba(27,27,27,0.04) 0 10px, rgba(27,27,27,0.07) 10px 20px);
    color: var(--ink-faint); font-family: var(--font-mono); font-size: 12px; letter-spacing: .08em;
  }
  .placeholder::after { content: attr(data-label); }
  .placeholder.square { aspect-ratio: 1 / 1; }
  .placeholder.wide { aspect-ratio: 21 / 9; }

  /* Deliberately NOT theme-aware. A drop is an authored artifact, a launch page
     rather than app chrome, and it must look the same for everyone who receives
     it. An automatic dark inversion silently recolours a design the author never
     saw and wrecks any image chosen against a light ground. A drop that WANTS
     dark styles it explicitly. */
  @media (prefers-reduced-motion: reduce) {
    * { animation-duration: .01ms !important; transition-duration: .01ms !important; }
  }
`;


/**
 * The v0.4.4 release page — and the reference for what a drop can be.
 *
 * Six pages with working Back/Next, built WITHOUT a line of JavaScript, because
 * the frame runs under `sandbox=""` and nothing in it will ever execute. The deck
 * is radio inputs plus `:checked ~` sibling selectors: a <label for> is a real
 * click target, checking a radio is not scripting, and CSS does the paging.
 * Verified in a real sandboxed iframe, not assumed.
 *
 * The nav is repeated inside each page rather than shared, so each page names its
 * own neighbours and no selector has to compute "current + 1".
 *
 * Every page is sized to FIT the square modal without scrolling — a page that
 * scrolls cuts a sentence in half at the fold, which is what a launch page must
 * never do. That constraint is why the closing note is its own page rather than
 * the tail of the list.
 *
 * Kept as the simulate payload so `updateSimulate({ drop: true })` renders
 * exactly what ships in the release body.
 */
export const DEFAULT_DROP_HTML = `<style>
  html, body { height: 100%; }
  body { overflow: hidden; }
  .stage { height: 100%; }
  .pg { position: absolute; opacity: 0; pointer-events: none; }

  .page { display: none; height: 100%; flex-direction: column;
          padding: clamp(24px, 4vw, 46px); }
  #pg1:checked ~ .stage .p1,
  #pg2:checked ~ .stage .p2,
  #pg3:checked ~ .stage .p3,
  #pg4:checked ~ .stage .p4,
  #pg5:checked ~ .stage .p5,
  #pg6:checked ~ .stage .p6 { display: flex; animation: rise .34s cubic-bezier(.2,.7,.3,1) both; }
  @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }

  .content { flex: 1; min-height: 0; overflow-y: auto; }
  .center { display: flex; flex-direction: column; justify-content: center; }
  .nav { flex-shrink: 0; display: flex; align-items: center; gap: 12px;
         padding-top: 16px; margin-top: 12px; border-top: 1px solid var(--line); }
  .dots { display: flex; gap: 7px; flex: 1; }
  .dot { width: 7px; height: 7px; border-radius: 999px; background: rgba(20,19,26,.16);
         cursor: pointer; transition: background .2s, transform .2s; }
  .dot:hover { background: rgba(20,19,26,.34); }
  .dot.on { background: var(--accent); transform: scale(1.25); }
  .btn { cursor: pointer; border-radius: 999px; font-size: 13.5px; font-weight: 600;
         padding: 9px 18px; border: 1px solid var(--line); color: var(--ink-soft);
         user-select: none; transition: background .16s, color .16s; }
  .btn:hover { background: rgba(20,19,26,.04); }
  .btn.primary { background: var(--ink); border-color: var(--ink); color: #FBFAF8; }
  .btn.primary:hover { background: #2a2733; }

  .kicker { font-size: 11.5px; font-weight: 700; letter-spacing: .14em;
            text-transform: uppercase; color: var(--accent); margin: 0 0 14px; }
  h1 { font-size: clamp(1.8rem, 4.4vw, 2.7rem); }
  .lede { margin-bottom: 1.4em; }
  .big { font-size: clamp(3.2rem, 10vw, 5.4rem); line-height: .92; letter-spacing: -.045em;
         font-weight: 700; margin: 0 0 .1em;
         background: linear-gradient(135deg, #14131A 20%, #1B7F5A 115%);
         -webkit-background-clip: text; background-clip: text; color: transparent; }
  .stat { display: flex; gap: 24px; flex-wrap: wrap; margin-top: 24px;
          padding-top: 18px; border-top: 1px solid var(--line); }
  .stat b { display: block; font-size: 1.5rem; letter-spacing: -.03em; font-weight: 680; }
  .stat span { font-size: 12px; color: var(--ink-soft); }

  .tag { display: inline-block; font-size: 10.5px; font-weight: 700; letter-spacing: .1em;
         text-transform: uppercase; color: var(--accent);
         background: rgba(27,127,90,.09); padding: 4px 9px; border-radius: 999px; }
  .quote { border-left: 2px solid var(--accent); padding-left: 15px; margin: 18px 0 0;
           color: var(--ink-soft); font-size: 14.5px; }
  .rows { list-style: none; padding: 0; margin: 0; }
  .rows li { display: grid; grid-template-columns: 96px 1fr; gap: 12px; align-items: baseline;
             padding: 7px 0; border-bottom: 1px solid var(--line); font-size: 13.5px; }
  .rows i { font-style: normal; font-size: 10px; font-weight: 700; letter-spacing: .09em;
            text-transform: uppercase; color: var(--ink-soft); }
  .rows b { font-weight: 620; }
  .rows p { margin: 1px 0 0; color: var(--ink-soft); font-size: 12.5px; }
  .card { border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 18px; }
  .card h2 { margin: 10px 0 .2em; font-size: 1.15rem; }
  .card p { margin: 0; color: var(--ink-soft); font-size: 13.5px; }
  .split { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
  /* 16:10, not 4:3 — the taller ratio pushed the second row past the fold, and a
     drop page that scrolls cuts a sentence in half at the boundary. */
  .split .placeholder { aspect-ratio: 16 / 10; }
</style>

<input class="pg" type="radio" name="pg" id="pg1" checked>
<input class="pg" type="radio" name="pg" id="pg2">
<input class="pg" type="radio" name="pg" id="pg3">
<input class="pg" type="radio" name="pg" id="pg4">
<input class="pg" type="radio" name="pg" id="pg5">
<input class="pg" type="radio" name="pg" id="pg6">

<div class="stage">

  <section class="page p1">
    <div class="content center">
      <p class="kicker">Munder Difflin</p>
      <h1 class="big">0.4.4</h1>
      <p class="lede" style="font-size:clamp(1.05rem,2.1vw,1.3rem);margin-top:.5em">
        The release where Windows finally joined the floor — and the first run
        stopped quietly failing.
      </p>
      <div class="stat">
        <div><b>27</b><span>fixes</span></div>
        <div><b>4</b><span>new surfaces</span></div>
        <div><b>1</b><span>platform unbroken</span></div>
      </div>
    </div>
    <div class="nav">
      <div class="dots">
        <label class="dot on" for="pg1"></label><label class="dot" for="pg2"></label>
        <label class="dot" for="pg3"></label><label class="dot" for="pg4"></label>
        <label class="dot" for="pg5"></label><label class="dot" for="pg6"></label>
      </div>
      <label class="btn primary" for="pg2">Start &rarr;</label>
    </div>
  </section>

  <section class="page p2">
    <div class="content">
      <p class="kicker">The headline</p>
      <h1>Agents can talk to each other on Windows.</h1>
      <p class="lede">Roughly half of all downloads run on Windows, where
      agent-to-agent messaging had never worked at all.</p>
      <div class="placeholder" data-label="Two agents messaging" style="aspect-ratio:24/9"></div>
      <p class="quote">Every agent booted, rendered, and looked completely healthy.
      None of them had been told they had an inbox.</p>
      <p style="margin-top:16px;color:var(--ink-soft);font-size:14px">Any CLI that is
      not an .exe was launched through cmd.exe, which cuts a multi-line argument at
      its first newline — taking the protocol block with it. Spawns now launch the
      real interpreter with an argument array, so the whole prompt survives.</p>
    </div>
    <div class="nav">
      <div class="dots">
        <label class="dot" for="pg1"></label><label class="dot on" for="pg2"></label>
        <label class="dot" for="pg3"></label><label class="dot" for="pg4"></label>
        <label class="dot" for="pg5"></label><label class="dot" for="pg6"></label>
      </div>
      <label class="btn" for="pg1">&larr; Back</label>
      <label class="btn primary" for="pg3">Next &rarr;</label>
    </div>
  </section>

  <section class="page p3">
    <div class="content">
      <p class="kicker">The first five minutes</p>
      <h1>Setup finishes. The floor wakes up.</h1>
      <p class="lede">Four separate bugs sat on the very first thing a new user does.</p>
      <ul class="rows">
        <li><i>Wizard</i><div><b>The suggested folder works</b>
          <p>Accepting ~/HarnessAgents stored a literal tilde and died on ENOENT.
          It now resolves to a real path — and the field actually suggests it.</p></div></li>
        <li><i>Wizard</i><div><b>It tells you at step one</b>
          <p>An empty folder used to walk you through all four steps before bouncing
          you back. The panel no longer overflows a short screen either.</p></div></li>
        <li><i>Hive</i><div><b>Services start at setup, not next launch</b>
          <p>On a fresh install the message router, hooks and telemetry stayed dead
          until you restarted — so mail never moved and agents never reported.</p></div></li>
        <li><i>Agents</i><div><b>Restart &amp; Continue has something to resume</b>
          <p>The live session id is recorded from a second source, so continuing
          works even when a hook never lands.</p></div></li>
      </ul>
    </div>
    <div class="nav">
      <div class="dots">
        <label class="dot" for="pg1"></label><label class="dot" for="pg2"></label>
        <label class="dot on" for="pg3"></label><label class="dot" for="pg4"></label>
        <label class="dot" for="pg5"></label><label class="dot" for="pg6"></label>
      </div>
      <label class="btn" for="pg2">&larr; Back</label>
      <label class="btn primary" for="pg4">Next &rarr;</label>
    </div>
  </section>

  <section class="page p4">
    <div class="content">
      <p class="kicker">New</p>
      <h1>Four things that were not here before.</h1>
      <div class="split">
        <div class="card">
          <span class="tag">Skills</span>
          <h2>Every skill your agents can use</h2>
          <p>What is installed across Claude Code, OpenCode and Codex — and a
          browsable catalog of 227 more, with search, filters, install and
          uninstall.</p>
        </div>
        <div class="card">
          <span class="tag">Prerequisites</span>
          <h2>Whether you actually have the tools</h2>
          <p>MemPalace, uv, git and every agent engine, with live status and where
          each one sits on disk. One button asks Michael to fill in the gaps.</p>
        </div>
        <div class="card">
          <span class="tag">Release drops</span>
          <h2>This page</h2>
          <p>Update notes used to be three clipped bullets in the corner. A release
          can now carry its own designed page, and you are reading the first one.</p>
        </div>
        <div class="card">
          <span class="tag">Dark mode</span>
          <h2>Rebuilt for reading</h2>
          <p>Every control border measured under 2:1 against its background, so the
          edges defining them were invisible. Re-tuned and measured, not eyeballed.</p>
        </div>
      </div>
    <div class="nav">
      <div class="dots">
        <label class="dot" for="pg1"></label><label class="dot" for="pg2"></label>
        <label class="dot" for="pg3"></label><label class="dot on" for="pg4"></label>
        <label class="dot" for="pg5"></label><label class="dot" for="pg6"></label>
      </div>
      <label class="btn" for="pg3">&larr; Back</label>
      <label class="btn primary" for="pg5">Next &rarr;</label>
    </div>
  </section>

  <section class="page p5">
    <div class="content">
      <p class="kicker">Everything else</p>
      <h1>The rest of the list.</h1>
      <ul class="rows">
        <li><i>Terminal</i><div><b>Copy comes back clean</b>
          <p>The quote rail is stripped and terminals run in UTF-8, so an em dash
          survives the trip to another app.</p></div></li>
        <li><i>Terminal</i><div><b>Dictation pastes what you just said</b></div></li>
        <li><i>IDE</i><div><b>Images open as images</b>
          <p>PNG, SVG and embedded screenshots render. The title names the agent.</p></div></li>
        <li><i>Agents</i><div><b>Restart &amp; Continue revives a dead agent</b></div></li>
        <li><i>Agents</i><div><b>Grok 4.6 in the model picker</b></div></li>
        <li><i>Agents</i><div><b>OpenCode runs the model you actually have</b></div></li>
        <li><i>Board</i><div><b>Task cards stop going missing</b></div></li>
        <li><i>Hive</i><div><b>A wake nudge survives an odd message id</b></div></li>
        <li><i>Hive</i><div><b>Compact fires once, not every hour</b></div></li>
        <li><i>Hive</i><div><b>The cost ledger is out of your git history</b></div></li>
        <li><i>Office</i><div><b>The floor stops rendering when nobody is looking</b></div></li>
        <li><i>Layout</i><div><b>Michael sits first on the dock again</b></div></li>
      </ul>
    </div>
    <div class="nav">
      <div class="dots">
        <label class="dot" for="pg1"></label><label class="dot" for="pg2"></label>
        <label class="dot" for="pg3"></label><label class="dot" for="pg4"></label>
        <label class="dot on" for="pg5"></label><label class="dot" for="pg6"></label>
      </div>
      <label class="btn" for="pg4">&larr; Back</label>
      <label class="btn primary" for="pg6">Next &rarr;</label>
    </div>
  </section>

  <section class="page p6">
    <div class="content center">
      <p class="kicker">One last thing</p>
      <h1 style="font-size:clamp(1.9rem,4.6vw,2.9rem)">Thank you for running this
      on your own machine.</h1>
      <p class="lede" style="margin-top:.4em">Every agent here starts on your
      hardware, in your folders, under your keys. Nothing about that changes.</p>
      <p class="quote">If it has been useful, a star is the entire marketing budget.
      The button is just below this page.</p>
    </div>
    <div class="nav">
      <div class="dots">
        <label class="dot" for="pg1"></label><label class="dot" for="pg2"></label>
        <label class="dot" for="pg3"></label><label class="dot" for="pg4"></label>
        <label class="dot" for="pg5"></label><label class="dot on" for="pg6"></label>
      </div>
      <label class="btn" for="pg5">&larr; Back</label>
      <label class="btn" for="pg1">Start over</label>
    </div>
  </section>

</div>`;

/**
 * Wrap authored HTML into a complete, self-contained document for `srcdoc`.
 *
 * The CSP is the load-bearing line. `default-src 'none'` means an omitted
 * directive denies rather than allows, so script-src, connect-src, frame-src and
 * object-src are all closed without being named. Only the media a launch page
 * needs is opened back up, and only over https or data:.
 */
export function buildDropSrcDoc(html: string): string {
  const csp = [
    "default-src 'none'",
    'img-src https: data: blob:',
    'media-src https: data: blob:',
    // style-src drops `https:`: authored `<style>` is 'unsafe-inline', but a
    // REMOTE stylesheet or `@import url(https://…)` is denied. That is the fix
    // for the white screen — a remote font stylesheet is render-blocking, and
    // permitting it means the frame hangs on a slow or blocked
    // fonts.googleapis.com (China: a TCP timeout of white). Denied by CSP, the
    // same import FAILS FAST and the frame paints immediately in the fallback.
    "style-src 'unsafe-inline'",
    // font-src drops `https:` too: fonts are self-hosted as data: URIs
    // (FRAME_FONT_CSS), so nothing legitimate needs the network, and a remote
    // @font-face src can no longer stall a paint.
    'font-src data:'
    // No script-src, no connect-src, no form-action: default-src 'none' denies
    // them. Spelled out here so a future edit has to remove a comment to widen it.
    //
    // The CSP `sandbox` directive is deliberately NOT listed: it is ignored when
    // delivered via <meta> (header-only, per spec), so including it would read as
    // a third control while doing nothing. The iframe's own sandbox attribute is
    // the real one.
  ].join('; ');
  // No remote <link>/<preconnect> to a font CDN: the design fonts are inlined as
  // data: URIs below, so the frame reaches the network for NOTHING at load. This
  // is the drop's version of the app's own "fonts ship inside" fix — the same
  // render-blocking Google Fonts fetch, killed in the same way.
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${FRAME_FONT_CSS}${FRAME_BASE_CSS}</style>
</head>
<body>
${stripActiveContent(html)}
</body>
</html>`;
}

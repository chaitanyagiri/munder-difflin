# Munder Difflin v0.4.5

**A local hive of Claude Code, Antigravity, Codex, Gemini, Cursor, Grok & Copilot agents that run themselves.**
Messaging, routing, and remembering, coordinated by your clone, Michael, who you talk to. Local-first and open source.

### → [**munderdiffl.in**](https://munderdiffl.in/) · see it in action, then grab a build below

---

## What's new in 0.4.5

**The release that fixes the things you trusted and were quietly wrong.** Cost reporting was off
by more than half after a restart, semantic memory never worked on Apple Silicon, and agents
could not talk to each other reliably. All three are fixed. Plus weekday scheduling, clickable
paths everywhere, one editor instead of two, and 23 community pull requests.

- **Costs are reported right.** The telemetry counter reset on every app restart while the
  session id stayed the same, so the floor under reported spend by a wide margin. It is now folded
  from the ledger, with a separate session figure kept alongside.
- **Semantic memory works on Apple Silicon.** CoreML overflowed the quantized embedding graph,
  every vector came back NaN, and chroma rejected every upsert. Embeddings are pinned to CPU
  on macOS.
- **Agents talk to each other reliably.** An inbox wake watchdog, no more stale nudges, mail to
  a missing inbox is bounced and logged instead of dropped, a capped steer queue, atomic
  webhook dispatch, and PROTOCOL.md refreshes on boot.
- **Workers are reliable to hire.** Spawn, teardown, floor cards, and engine availability are
  all checked before a hire is committed.
- **The renderer runs inside Chromium's sandbox.**
- **Windows agents quit when the app does.**
- **Restart to update no longer gets stuck** when a running agent makes the app refuse to quit.
- **Triggers run on weekdays at a time of day,** not just on an interval, and they are DST safe.
- **Focus mode** survives a restart and you can edit an agent from inside it.
- **Every path in terminal output is clickable.** Markdown previews, source opens in the editor,
  images and unknown types reveal in Finder or Explorer.
- **One editor.** The fullscreen file overlay is gone, everything opens in the IDE, and the git
  rail is collapsed by default.
- **Updating is one click.** The title-bar badge downloads the build for your machine and tells
  you how to install it, it says `latest` once a check confirms you are current, and the first
  run after an update opens that release's page.
- **Settings opens with a card** carrying your version, your plan, and a way back to these notes.
- **Terminals follow the window theme,** Gemini CLI and Cursor Agent join the engine list, and
  Michael hires on his own terms with editable agent names.

### A note on Pro

v0.5.0 launches with a Pro version alongside the community version. Community stays free, stays
open, and keeps getting updates. Pro ships with new features and integrations, with more posted
throughout the year, and it stays ahead of Community, for power users who want the full potential
of coding agents and agent harnesses. The Pro roadmap also includes a mobile app. The first 100 people on the
Founders' Wall get a month of Pro free, then 50% off the annual plan.

### Thanks

23 community pull requests landed in this release. Thank you to everyone who opened one,
reviewed one, or filed the bug that led to one. The full list is in CHANGELOG.md.

<!-- drop -->
<style>
  /* Self-contained on purpose. This page is rendered by the app people already
     have (0.4.4), whose frame knows nothing about the landing site palette, so
     every token, font and shadow is declared here rather than inherited. */
  @import url("https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600;700&display=swap");
  :root {
    --paper: #FFFDF7; --cream: #F5F2E8; --cream-2: #F5ECD7; --white: #FFFFFF;
    --ink: #1B1B1B; --ink-dim: #57544C; --ink-faint: #8A867A;
    --yellow: #FFCA54; --sky: #72C2DF; --maroon: #B23A4E;
    --lilac: #E4DEFB; --peach: #FBDDBE; --mint: #D6F3E1; --sky-soft: #DCEFF7;
    --line: rgba(27,27,27,0.16);
    --mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    --sans: "Geist", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  html, body { height: 100%; margin: 0; }
  body { overflow: hidden; background: var(--paper); color: var(--ink); font-family: var(--sans);
         font-size: 14.5px; line-height: 1.5; -webkit-font-smoothing: antialiased; }
  * { box-sizing: border-box; }

  /* Two pages, no JavaScript. Radio inputs plus :checked ~ sibling selectors do
     the paging; a <label for> is a real click target inside the sandbox. */
  .pg { position: absolute; opacity: 0; pointer-events: none; }
  .stage { height: 100%; position: relative; }
  .page { display: none; height: 100%; flex-direction: column; position: relative;
          padding: clamp(20px, 3.6vw, 32px) clamp(20px, 4vw, 34px) clamp(14px, 2.2vw, 20px); }
  #pg1:checked ~ .stage .p1,
  #pg2:checked ~ .stage .p2 { display: flex; }
  @media (prefers-reduced-motion: no-preference) {
    #pg1:checked ~ .stage .p1,
    #pg2:checked ~ .stage .p2 { animation: rise .38s cubic-bezier(.2,.7,.3,1) both; }
    @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  }
  .content { flex: 1; min-height: 0; overflow-y: auto; padding: 0 12px 10px 0; }
  .content::-webkit-scrollbar { width: 8px; }
  .content::-webkit-scrollbar-thumb { background: var(--ink); }
  .content::-webkit-scrollbar-track { background: var(--cream); }
  .p1 .content { display: flex; flex-direction: column; justify-content: center; }

  /* Dotted paper grid behind the hero page, same as the site. */
  .p1 { background: radial-gradient(var(--ink-faint) 1px, transparent 1px) 0 0 / 22px 22px var(--paper); }
  .p1::before { content: ""; position: absolute; inset: 0; pointer-events: none;
                background: radial-gradient(ellipse at 50% 40%, rgba(255,253,247,0) 25%, var(--paper) 85%); }
  .p1 > * { position: relative; }

  .eyebrow { font-family: var(--mono); font-size: 11px; font-weight: 500; letter-spacing: .26em;
             text-transform: uppercase; color: var(--ink-faint); margin: 0 0 12px; }
  h1 { font-family: var(--mono); font-weight: 600; letter-spacing: -.04em; line-height: 1.06;
       font-size: clamp(1.55rem, 4.4vw, 2.25rem); margin: 0 0 .5em; text-wrap: balance; }
  h1 .hl { color: var(--sky); }
  h1 .mr { color: var(--maroon); }
  .lede { font-size: clamp(.92rem, 1.8vw, 1.02rem); line-height: 1.55; color: var(--ink-dim);
          max-width: 60ch; margin: 0 0 18px; text-wrap: pretty; }
  .lede b, .card p b, .thanks p b, .foot b { color: var(--ink); font-weight: 600; }

  /* Cards: white or pastel, bold ink border, hard offset shadow. No radius. */
  .card { background: var(--white); border: 3px solid var(--ink); box-shadow: 6px 6px 0 var(--ink);
          padding: 14px 16px 13px; border-radius: 0; }
  .card.lilac { background: var(--lilac); } .card.mint { background: var(--mint); }
  .card.peach { background: var(--peach); } .card.sky { background: var(--sky-soft); }
  .tag { display: inline-block; font-family: var(--mono); font-size: 9.5px; font-weight: 700;
         letter-spacing: .14em; text-transform: uppercase; background: var(--ink); color: var(--paper);
         padding: 4px 8px; }
  .card h2 { font-family: var(--mono); font-size: .98rem; letter-spacing: -.02em; font-weight: 600;
             margin: 9px 0 4px; line-height: 1.2; }
  .card p { font-size: 12.8px; line-height: 1.5; color: var(--ink-dim); margin: 0; }

  .two { display: grid; grid-template-columns: 1fr; gap: 16px; margin: 2px 0 0; }

  /* The wall ribbon: the site's dark band. */
  .band { display: flex; align-items: center; gap: 16px; padding: 13px 16px;
          background: var(--ink) radial-gradient(rgba(255,255,255,.14) 1px, transparent 1px) 0 0 / 14px 14px;
          color: var(--paper); border: 3px solid var(--ink); box-shadow: 6px 6px 0 var(--ink); }
  .band .yr { font-family: var(--mono); font-size: 2.6rem; font-weight: 700; letter-spacing: -.05em;
              line-height: .9; color: var(--yellow); flex-shrink: 0; text-align: center; }
  .band .yr small { display: block; font-size: 9px; letter-spacing: .2em; font-weight: 500;
                    color: var(--paper); opacity: .7; margin-top: 6px; }
  .band b { display: block; font-family: var(--mono); font-size: 13.5px; font-weight: 600; margin-bottom: 3px; }
  .band span { font-size: 12.5px; line-height: 1.45; opacity: .85; }

  /* Nav. The big next button sits centered at the bottom. */
  .nav { flex-shrink: 0; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center;
         gap: 12px; padding-top: 12px; margin-top: 12px; border-top: 2px solid var(--ink); }
  .nav .l { justify-self: start; } .nav .r { justify-self: end; }
  .btn { display: inline-flex; align-items: center; gap: 10px; cursor: pointer; user-select: none;
         font-family: var(--mono); font-weight: 700; font-size: 13px; color: var(--ink);
         background: var(--white); border: 2px solid var(--ink); box-shadow: 4px 4px 0 var(--ink);
         padding: 10px 16px; text-decoration: none; white-space: nowrap; border-radius: 0;
         transition: transform .12s, box-shadow .12s; }
  .btn:hover { transform: translate(-2px, -2px); box-shadow: 6px 6px 0 var(--ink); }
  .btn:active { transform: translate(1px, 1px); box-shadow: 2px 2px 0 var(--ink); }
  .btn.primary { background: var(--yellow); font-size: 14.5px; padding: 13px 28px; }
  .btn.sm { font-size: 12px; padding: 7px 12px; box-shadow: 3px 3px 0 var(--ink); }
  .btn.sm:hover { box-shadow: 4px 4px 0 var(--ink); }
  .step { font-family: var(--mono); font-size: 10.5px; letter-spacing: .2em; color: var(--ink-faint);
          text-transform: uppercase; }

  /* Page two: the list. */
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 2px; }
  .grid .card { box-shadow: 4px 4px 0 var(--ink); padding: 12px 14px 11px; }
  .grid .card h2 { font-size: .92rem; margin: 8px 0 3px; }
  .grid .card p { font-size: 12.3px; }
  h3 { font-family: var(--mono); font-size: 10.5px; font-weight: 500; letter-spacing: .26em;
       text-transform: uppercase; color: var(--ink-faint); margin: 20px 0 6px; }
  .rows { list-style: none; padding: 0; margin: 0; }
  .rows li { display: grid; grid-template-columns: 70px 1fr; gap: 10px; align-items: baseline;
             padding: 6px 0; border-bottom: 1px solid var(--line); font-size: 12.8px; }
  .rows i { font-style: normal; font-family: var(--mono); font-size: 9.5px; font-weight: 700;
            letter-spacing: .12em; text-transform: uppercase; color: var(--ink-faint); }
  .rows b { font-weight: 600; }
  .rows p { margin: 1px 0 0; color: var(--ink-dim); font-size: 12px; line-height: 1.45; }

  .thanks { display: grid; grid-template-columns: auto 1fr; gap: 14px; align-items: center;
            margin-top: 18px; padding: 12px 14px; background: var(--cream-2); border: 3px solid var(--ink);
            box-shadow: 4px 4px 0 var(--ink); }
  .thanks .n { font-family: var(--mono); font-size: 2.2rem; font-weight: 700; letter-spacing: -.05em;
               line-height: .9; color: var(--maroon); text-align: center; }
  .thanks .n small { display: block; font-size: 9px; letter-spacing: .2em; color: var(--ink-faint);
                     font-weight: 500; margin-top: 5px; }
  .thanks p { font-size: 12.8px; line-height: 1.5; color: var(--ink-dim); margin: 0; }

  /* Links in this frame cannot open in the app (the frame is sealed), so each
     one is written as something you can read and type, and still a real <a> for
     the github.com release page where it does open. */
  .meet { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 16px; }
  .meet .card { box-shadow: 4px 4px 0 var(--ink); padding: 12px 14px; }
  .meet .card h2 { margin-top: 7px; }
  .meet .url { display: inline-block; margin-top: 6px; font-family: var(--mono); font-size: 12px;
               font-weight: 600; color: var(--ink); text-decoration: none; background: var(--white);
               border: 2px solid var(--ink); padding: 4px 8px; box-shadow: 3px 3px 0 var(--ink);
               user-select: all; -webkit-user-select: all; cursor: text; }
  .meet .url:hover { color: var(--maroon); }
  .foot { font-size: 12px; color: var(--ink-dim); text-align: center; margin: 16px 0 0; }

  @media (max-width: 560px) {
    .grid, .meet { grid-template-columns: 1fr; }
    .nav { grid-template-columns: 1fr; justify-items: center; }
    .nav .l, .nav .r { justify-self: center; }
  }
</style>

<input class="pg" type="radio" name="pg" id="pg1" checked>
<input class="pg" type="radio" name="pg" id="pg2">

<div class="stage">

  <section class="page p1">
    <div class="content">
      <p class="eyebrow">Munder Difflin &middot; v0.4.5</p>
      <h1>Thank you <span class="hl">for being here early.</span></h1>
      <p class="lede">Every bug you filed, every PR you sent, every floor screenshot you posted
      shaped what Munder Difflin is today. <b>This release is built on that.</b> So before the
      list of fixes, a proper thank you to the people who showed up first.</p>

      <div class="two">
        <div class="card lilac">
          <span class="tag">Announcement</span>
          <h2>v0.5.0 launches with a Pro version.</h2>
          <p><b>Community stays free, stays open, and keeps getting updates.</b> Pro ships with
          new features and integrations, with more posted throughout the year, and it stays
          ahead of Community, for power users who want the full potential of coding agents and
          agent harnesses. The Pro roadmap also includes a mobile app.</p>
        </div>
        <div class="band">
          <div class="yr">50<small>% OFF</small></div>
          <div><b>On the Founders' Wall?</b>
          <span>A month of Munder Difflin Pro free, then 50% off the annual plan. For the first
          100 people on the wall.</span></div>
        </div>
      </div>
    </div>
    <div class="nav">
      <span class="l step">01 / 02</span>
      <label class="btn primary" for="pg2">See what's new in 0.4.5 &rarr;</label>
      <span class="r step">&nbsp;</span>
    </div>
  </section>

  <section class="page p2">
    <div class="content">
      <p class="eyebrow">What's new in 0.4.5</p>
      <h1>The things you trusted <span class="mr">and were quietly wrong.</span></h1>
      <p class="lede">Three fixes lead this release, and each one was under reporting, failing
      silently, or both. Then a solid list of things that are simply new.</p>

      <div class="grid">
        <div class="card mint">
          <span class="tag">Costs</span>
          <h2>Spend is reported right.</h2>
          <p>The counter reset on every app restart while the session id stayed the same, so the
          floor under reported <b>by a wide margin</b>. It is now folded from the ledger, with a
          session figure kept alongside.</p>
        </div>
        <div class="card sky">
          <span class="tag">Memory</span>
          <h2>Semantic memory on Apple Silicon.</h2>
          <p>CoreML overflowed the embedding graph, every vector came back NaN, and nothing was
          ever stored. Embeddings now run on CPU on macOS, so recall actually recalls.</p>
        </div>
        <div class="card peach">
          <span class="tag">Hive</span>
          <h2>Agents talk to each other, reliably.</h2>
          <p>A watchdog wakes idle workers with mail waiting, stale nudges stop, mail to a missing
          inbox bounces instead of vanishing, and webhook dispatch is atomic.</p>
        </div>
        <div class="card">
          <span class="tag">Security</span>
          <h2>The renderer runs in Chromium's sandbox.</h2>
          <p>Privileged work stays behind the bridge. Release pages like this one render in a
          sealed frame with no scripts at all.</p>
        </div>
      </div>

      <h3>Also new</h3>
      <ul class="rows">
        <li><i>Triggers</i><div><b>Schedule on weekdays at a time of day</b>
          <p>Not just on an interval, and DST safe by construction.</p></div></li>
        <li><i>Terminal</i><div><b>Every path in output is clickable</b>
          <p>Markdown previews, source opens in the editor, everything else reveals in Finder or Explorer.</p></div></li>
        <li><i>Editor</i><div><b>One editor, not two</b>
          <p>The fullscreen overlay is gone. Everything opens in the IDE, git rail collapsed by default.</p></div></li>
        <li><i>Focus</i><div><b>Focus mode survives a restart</b>
          <p>And you can edit an agent without leaving it.</p></div></li>
        <li><i>Workers</i><div><b>Hiring is reliable</b>
          <p>Spawn, teardown, floor cards and engine checks happen before a hire is committed.</p></div></li>
        <li><i>Updates</i><div><b>Updating is one click, and you pick how</b>
          <p>The version badge next to the logo downloads the build for your machine and walks you
          through replacing the app, step by step for your OS. Auto update lives in Settings. Once
          you are current the badge says latest, and the first launch after an update opens that
          release's page. Restart to update no longer gets stuck either.</p></div></li>
        <li><i>Windows</i><div><b>Quitting the app quits the agents</b></div></li>
        <li><i>Engines</i><div><b>Gemini CLI and Cursor Agent join the floor</b></div></li>
        <li><i>Terminal</i><div><b>TUIs follow the window theme</b></div></li>
        <li><i>Agents</i><div><b>Michael hires on his own terms, and names are editable</b></div></li>
      </ul>

      <div class="thanks">
        <div class="n">23<small>PULL REQUESTS</small></div>
        <p><b>Thank you to every contributor.</b> 23 community pull requests landed in this
        release. If you opened one, reviewed one, or filed the bug that led to one, this version
        has your fingerprints on it. The full list is in the release notes on GitHub.</p>
      </div>

      <div class="meet">
        <div class="card">
          <span class="tag">Star</span>
          <h2>If this has been useful, a star is the whole marketing budget.</h2>
          <p>The <b>&#11088; Star us on GitHub</b> button is just below this page.</p>
        </div>
        <div class="card sky">
          <span class="tag">Discord</span>
          <h2>Come hang out.</h2>
          <p>Questions, floor screenshots, and a role when your PR lands. Click the address to select it, then copy.</p>
          <a class="url" href="https://discord.gg/SEDzP5ZPk5" target="_blank" rel="noopener">discord.gg/SEDzP5ZPk5</a>
        </div>
      </div>
      <p class="foot"><b>Restart to update</b> closes the app and every running agent, so finish or
      pause what they are doing first. <b>Later</b> keeps the update waiting until you are ready.</p>
    </div>
    <div class="nav">
      <label class="btn sm l" for="pg1">&larr; Back</label>
      <span class="step">02 / 02</span>
      <span class="r step">&nbsp;</span>
    </div>
  </section>

</div>
<!-- /drop -->

## Still new in 0.4.4 · *Windows joins the floor*

**If you use Windows, 0.4.4 is the release that made the app work.** Agents could never message
each other there. They started, looked completely healthy, and quietly ignored one another
forever. It also fixed the first five minutes: setup could not be finished, and on a brand new
install the parts that carry messages between agents never started until you quit and reopened
the app.

- **Windows agents talk to each other.** The hive protocol reaches an agent as a multi-line
  command-line argument, and `cmd.exe` cut it at the first newline, taking the block that names
  `inbox/` and `outbox/` with it. Spawns now hand the real interpreter an argument array.
- **Setup finishes.** Accepting the suggested folder used to fail outright, and the folder box
  was empty even though the text above promised a suggestion.
- **A fresh install works immediately.** Messages between agents, live status on the cards, and
  Restart & Continue all stayed dead until you restarted the app, and nothing said so.
- **Skills and Prerequisites.** Every skill your agents can use, 227 more to browse and install,
  and one page in Settings that says which supporting tools you have and which you do not.
- **Release drops.** A release can carry its own designed page instead of a version number in
  the corner. You are reading one.
- **Dark mode rebuilt.** The one-pixel borders that draw every control measured under 2:1
  against their background, so the whole app read as flat grey shapes. Re-tuned and measured
  rather than picked by eye.

---

## Still new in 0.4.3 — *Michael is the logo*

**The mark is a face now.** Munder Difflin has always been an office you watch people work in,
and the icon was a pair of script initials on a gradient. It's Michael — your clone — drawn in
the app's own pixel art, on the brand yellow, looking straight back at you.

- **One mark, everywhere.** The dock icon on macOS, Windows and Linux, the site favicon and
  header, the in-app toolbar, and the README all render the same portrait. No variant is a
  redrawing of another.
- **The SVG is the source of truth.** The mark is authored as pure vector — every pixel of the
  sprite is a rect, with no fonts, no gradients and no filters — and every raster in `build/`
  and `docs/` is generated from it by [`tools/make-logo.cjs`](https://github.com/chaitanyagiri/munder-difflin/blob/main/tools/make-logo.cjs).
  The old icon depended on the Lobster webfont being installed to render correctly.
- **Icons are native at every size.** A real multi-resolution `.icns` (16→1024, with the macOS
  drop shadow) and a `.ico` carrying six sizes, plus a 32px favicon and a 180px apple-touch-icon,
  so nothing is a downscale of a 512px image any more.
- **Brighter call-to-action buttons.** The download button took its fill from the same token as
  accent *text*, which has to stay dark enough to read on a white page — so on the light theme
  it came out brown. Fills now have their own token and start at what used to be the hover colour.

> [!NOTE]
> **Appearance only.** No functional change in this release: the update carries the new icon into
> your dock, and nothing else moves.

---

## Still new in 0.4.2 — *Anonymous usage stats, done in the open*

Munder Difflin now sends a **small set of anonymous usage events** (app opened, agent spawned,
feature used) so we can tell whether features are actually used. It is built the way an
open-source project should build it:

- **[TELEMETRY.md](https://github.com/chaitanyagiri/munder-difflin/blob/main/TELEMETRY.md) is the
  complete contract.** Every event and property is listed there, and the code enforces that list
  as a hard allowlist — anything not in the table cannot be sent. No prompts, no transcripts, no
  file paths, no repo names, no identifiers. Events are PostHog *anonymous events* (no person
  profile, no identity), keyed by a random UUID you can delete.
- **Opt-out, three ways.** Uncheck it during onboarding, flip **Settings → General → Anonymous
  usage stats**, or set the standard `DO_NOT_TRACK` env var.
- **Forks send nothing.** The analytics key is injected only in release CI — building from
  source produces a build where the analytics module is a complete no-op.

---

## Still new in 0.4.1 — *The app says what the site says*

**Michael is your clone.** The website has been describing Munder Difflin as a clone of you that
works around the clock — the app still called it a "GOD agent." Now they match.

- **Your clone, not the GOD agent.** Michael is described as your clone throughout onboarding,
  and his card on the floor carries a **BOSS** tag — he's the boss of the agents, you're still
  the boss of him.
- **Onboarding was rewritten.** It opens on what you actually get ("a clone of you, working
  24/7") instead of a feature list, and the engine card no longer advertises three engines when
  ten ship — Claude Code, Codex, Grok, Kimi, Antigravity, Qwen, OpenCode, Crush, pi and Copilot
  are all named.

> [!NOTE]
> **This release changes wording only.** The `god` agent id, the hive folder layout, and message
> routing are untouched, so existing hives, memory, and running agents carry over exactly as they
> are. Nothing to migrate.

---

> [!NOTE]
> **Auto-update carries you here from v0.3.7 or later.** If you are still on v0.3.5 or v0.3.6,
> those builds shipped the broken updater and need one manual install — grab the download below,
> once.

---

## Previously

- **0.4.0** — *the brand grew up*: one yellow "MD" mark across the dock icon, in-app logo, site
  favicon, and munderdiffl.in; the landing page rebuilt around real screenshots and a live
  pixel-floor sim; pricing reframed around **Private Cloud** and **Private Network**.
- **0.3.9** — Settings → General answers "am I up to date?" directly, and removes 0.3.8's
  usage-limit guard that never released held agents.
- **0.3.8** — memory condensation works for the first time; a Triggers hub; one compaction
  schedule instead of two; a readable commit history.
- **0.3.7** — auto-update actually runs: a CommonJS/ESM import bug meant the native updater never
  fired in any packaged build since v0.3.4, and the failure was swallowed by a `catch`.
- **0.3.6** — *a machine with nothing on it can run agents*: Node and npm install themselves
  (verified against the official `SHASUMS256.txt`), hooks stopped dying with exit 127, `~/dev/foo`
  paths resolve, and the office floor rebuilds itself after losing its GPU context.
- **0.3.5** — a **send now** escape hatch for a paused message queue, and a compact Command
  Center header.
- **0.3.4** — talk mode that knows the floor, markdown previews, the IDE git time-machine
  (history + branch compare), redesigned Settings, xAI Grok and Kimi Code, and a single
  delivery gate for every automatic writer. Community work by
  [@gts-47](https://github.com/gts-47) and [@qschmick](https://github.com/qschmick).
- **0.3.3** — the built-in Monaco IDE, and GitHub Copilot CLI as the first community-contributed
  engine ([@anxkhn](https://github.com/anxkhn)).
- **0.3.2** — Realtime Michael: a voice channel to the GOD orchestrator.
- **0.3.1** — three more engines: OpenCode, Crush, and pi.dev.

Full history in the [CHANGELOG](https://github.com/chaitanyagiri/munder-difflin/blob/main/CHANGELOG.md).


---

## Thanks

This release carries community work. All 23 of these landed in v0.4.5:

| | | |
|---|---|---|
| [#157](https://github.com/chaitanyagiri/munder-difflin/pull/157) | [@gpechieu](https://github.com/gpechieu) | inherited Claude Code session markers are stripped from an agent's PTY env |
| [#158](https://github.com/chaitanyagiri/munder-difflin/pull/158) | [@gpechieu](https://github.com/gpechieu) | semantic memory works on Apple Silicon again: embeddings are pinned to CPU on macOS |
| [#159](https://github.com/chaitanyagiri/munder-difflin/pull/159) | [@gpechieu](https://github.com/gpechieu) | reliable spawn, teardown and floor cards for the workers Michael hires |
| [#165](https://github.com/chaitanyagiri/munder-difflin/pull/165) | [@rajpreetcodes](https://github.com/rajpreetcodes) | a `~` in the harness home folder resolves, so setup cannot die on ENOENT |
| [#171](https://github.com/chaitanyagiri/munder-difflin/pull/171) | [@KrushanPatel](https://github.com/KrushanPatel) | CONTRIBUTING.md matches the platforms the app actually supports |
| [#175](https://github.com/chaitanyagiri/munder-difflin/pull/175) | [@rekcilyssup](https://github.com/rekcilyssup) | a main-process watchdog wakes an idle worker sitting on an undrained inbox |
| [#176](https://github.com/chaitanyagiri/munder-difflin/pull/176) | [@FenjuFu](https://github.com/FenjuFu) | Gemini CLI joins the engine list |
| [#177](https://github.com/chaitanyagiri/munder-difflin/pull/177) | [@TTAWDTT](https://github.com/TTAWDTT) | each agent's live context-window occupancy shows in the roster |
| [#178](https://github.com/chaitanyagiri/munder-difflin/pull/178) | [@gpechieu](https://github.com/gpechieu) | a god-hired worker gets a floor card, and it archives when the worker dies |
| [#179](https://github.com/chaitanyagiri/munder-difflin/pull/179) | [@kdahal7](https://github.com/kdahal7) | `statAbs` expands `~`, so a path resolves the same way on every platform |
| [#181](https://github.com/chaitanyagiri/munder-difflin/pull/181) | [@TTAWDTT](https://github.com/TTAWDTT) | webhook dispatch goes through an atomic add, so a stale ledger cannot overwrite it |
| [#184](https://github.com/chaitanyagiri/munder-difflin/pull/184) | [@TTAWDTT](https://github.com/TTAWDTT) | the per-agent steer queue is capped, which bounds memory on a stalled agent |
| [#185](https://github.com/chaitanyagiri/munder-difflin/pull/185) | [@hyperstream-pro](https://github.com/hyperstream-pro) | mail to an id with no inbox is bounced and logged instead of dropped |
| [#186](https://github.com/chaitanyagiri/munder-difflin/pull/186) | [@BUGHUNTER-SACHIN](https://github.com/BUGHUNTER-SACHIN) | tests cover the Notifications and Stop idle-detection branches |
| [#187](https://github.com/chaitanyagiri/munder-difflin/pull/187) | [@hyperstream-pro](https://github.com/hyperstream-pro) | a stale inbox nudge no longer wakes an agent against an inbox that is already empty |
| [#190](https://github.com/chaitanyagiri/munder-difflin/pull/190) | [@swarnendu19](https://github.com/swarnendu19) | agent names can be edited after spin-up |
| [#199](https://github.com/chaitanyagiri/munder-difflin/pull/199) | [@amey-op](https://github.com/amey-op) | the Antigravity queue no longer wedges for 30 seconds |
| [#203](https://github.com/chaitanyagiri/munder-difflin/pull/203) | [@lifelmy](https://github.com/lifelmy) | the Crush config env points at the agent's own directory |
| [#210](https://github.com/chaitanyagiri/munder-difflin/pull/210) | [@chaitanyagiri](https://github.com/chaitanyagiri) | the art licence claims are true again, Modern Interiors is bought |
| [#214](https://github.com/chaitanyagiri/munder-difflin/pull/214) | [@pontusm](https://github.com/pontusm) | Windows agent processes quit when the app does |
| [#219](https://github.com/chaitanyagiri/munder-difflin/pull/219) | [@chaitanyagiri](https://github.com/chaitanyagiri) | engine availability is checked before Michael's engine is committed |
| [#226](https://github.com/chaitanyagiri/munder-difflin/pull/226) | [@chaitanyagiri](https://github.com/chaitanyagiri) | the floor reports lifetime spend, not spend since the last app restart |
| [#227](https://github.com/chaitanyagiri/munder-difflin/pull/227) | [@scy73](https://github.com/scy73) | the renderer runs inside Chromium's sandbox |

Four of the fixes above are [@gpechieu](https://github.com/gpechieu)'s and three are
[@TTAWDTT](https://github.com/TTAWDTT)'s. Thank you, and thank you to everyone who reviewed a
pull request or filed the bug that led to one.

## ⤓ Downloads

Latest builds for every platform. The macOS build is **universal**, one DMG that runs on both
Apple Silicon and Intel.

### 🍎 macOS
| Build | File |
|---|---|
| Universal (Apple Silicon + Intel) | [`Munder-Difflin-0.4.5-mac-universal.dmg`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.4.5-mac-universal.dmg) |

### 🪟 Windows
| Build | File |
|---|---|
| Installer (x64), *recommended* | [`Munder-Difflin-0.4.5-win-x64-setup.exe`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.4.5-win-x64-setup.exe) |
| Portable (x64, no install) | [`Munder-Difflin-0.4.5-win-x64-portable.exe`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.4.5-win-x64-portable.exe) |

### 🐧 Linux
| Build | File |
|---|---|
| AppImage (x86_64) | [`Munder-Difflin-0.4.5-linux-x86_64.AppImage`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.4.5-linux-x86_64.AppImage) |

### 📦 Source
[Source code (zip)](https://github.com/chaitanyagiri/munder-difflin/archive/refs/tags/v0.4.5.zip) ·
[Source code (tar.gz)](https://github.com/chaitanyagiri/munder-difflin/archive/refs/tags/v0.4.5.tar.gz)

> **Verify your download:** [`SHA256SUMS.txt`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/SHA256SUMS.txt) — then `shasum -a 256 -c SHA256SUMS.txt` (macOS/Linux) or `Get-FileHash` (Windows).

> The filenames above carry a version number, so they only resolve while this is the
> latest release. If a link 404s you are reading an old release page — grab the current
> build from the [**releases page**](https://github.com/chaitanyagiri/munder-difflin/releases/latest),
> which is always right.

---

## First launch

- **macOS** — the build is **signed with a Developer ID** (hardened runtime). If macOS
  still shows an "unidentified developer" warning on first open, right-click the app →
  **Open** → **Open** once. After that, the first time agents touch a folder you'll get a
  single macOS privacy prompt for Documents/Desktop/Downloads — allow it once and the
  grant sticks (it covers the `claude` agents the app spawns), because the grant is bound
  to the app's stable signature.
- **Windows** — not code-signed yet; SmartScreen may show "Windows protected your PC" →
  **More info** → **Run anyway**.
- **Linux** — make the AppImage executable: `chmod +x Munder-Difflin-*.AppImage`, then run it.

---

## Requirements
- macOS 12+, Windows 10/11, or a modern Linux desktop
- [Claude Code](https://claude.com/claude-code) installed and on your `PATH` (and/or the Antigravity `agy` or OpenAI `codex` CLI for those providers)
- A Claude Code subscription (Munder Difflin drives your existing `claude` CLI — it doesn't replace it)
- For **Realtime Michael** (voice): your own **OpenAI key with Realtime API access** — without it the **Talk** button stays disabled

---

## 🛠 Build from source
```bash
git clone https://github.com/chaitanyagiri/munder-difflin.git
cd munder-difflin
npm install        # rebuilds node-pty for Electron
npm run dev        # launches the app with hot reload
```
Node 18+ and a C/C++ toolchain are required (Xcode CLT on macOS, Build Tools on Windows).
To produce installers yourself: `npm run dist` (current OS), or `dist:mac` / `dist:win` / `dist:linux`.

---

## What's inside
- **The simulation** — every agent is a real `claude` (or `agy` / `codex` / local-provider) pseudo-terminal, visualized as an avatar on a watchable office floor (`node-pty` · `xterm.js` · Pixi.js).
- **Talk to Michael** — a realtime **voice channel to the GOD orchestrator** that reads the hive and acts behind spoken echo-back confirmation, BYOK and main-only.
- **Selectable engines + per-hire capabilities** — each hire (and Michael himself) runs on a pluggable engine, with its own consented skills + MCP catalog.
- **MemPalace** — a markdown-first, semantic memory layer the whole office shares; cross-session recall in ~12ms.
- **GOD orchestrator + hive** — one agent you talk to routes work to specialists and stays autonomous, escalating only critical items (spend, destructive ops, scope) to you natively, through human-in-the-loop prompts. It can also spawn an ephemeral worker straight from Slack and tear it down safely.
- **Plugs into your setup** — your subscription, settings, skills, and MCP servers, plus an integrations registry with a write-only secret broker; `/remote-control` reaches the whole floor from your phone.

Full notes in the [CHANGELOG](https://github.com/chaitanyagiri/munder-difflin/blob/main/CHANGELOG.md).

---

## Links
[Website](https://munderdiffl.in/) ·
[Repo](https://github.com/chaitanyagiri/munder-difflin) ·
[Issues](https://github.com/chaitanyagiri/munder-difflin/issues) ·
[Contribute](https://github.com/chaitanyagiri/munder-difflin/blob/main/CONTRIBUTING.md) ·
[Become a patron](https://razorpay.me/@munderdifflinfund)

MIT-licensed. An affectionate parody — not affiliated with NBC's *The Office* or Dunder Mifflin.

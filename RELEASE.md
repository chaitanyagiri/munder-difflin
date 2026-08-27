<!-- RELEASE RUNNER, REQUIRED BEFORE YOU TAG: run RELEASE-CHECKLIST.md. Rehearse the updater on 0.4.6-rc.1 -> 0.4.7-rc.1 prereleases and pass the fault-injection checks BEFORE tagging the real release. This comment is not rendered in the published notes. -->
# Munder Difflin v0.4.6

**A local hive of Claude Code, Antigravity, Codex, Gemini, Cursor, Grok & Copilot agents that run themselves.**
Messaging, routing, and remembering, coordinated by your clone, Michael, who you talk to. Local-first and open source.

### → [**munderdiffl.in**](https://munderdiffl.in/) · see it in action, then grab a build below

---

## What's new in 0.4.6

**The release that speaks your language and updates itself.** The interface now runs in Chinese and
Arabic, the auto-updater downloads and installs a new build end to end, fonts ship inside the app so
a blocked network never leaves you on a blank window, and the way agent engines are launched is
hardened. Plus the Settings rework, an IME fix for CJK typing, and 16 community pull requests.

- **The interface speaks Chinese and Arabic.** Pick zh-CN or Arabic in Settings — every string is
  translated, with nothing falling back to English, and the terminals read right to left. Some
  screens still need their padding and icons mirrored, and that is the next piece of work.
- **Updates install themselves.** The badge advances check to available to downloading to downloaded
  on its own, and the button at the end restarts into the new version. This is the release that
  proves that path end to end.
- **Fonts ship inside the app.** No Google Fonts fetch on launch, so the app opens at the same speed
  on any network, including one where Google is blocked. The release drop's fonts are bundled too,
  and it can no longer white-screen while a stylesheet loads.
- **Engine command launching is hardened.** The name of the CLI an agent launches is validated
  before it is ever resolved against your PATH, so nothing but a plain command name or an absolute
  path reaches a shell.
- **IME typing no longer sends early.** Pressing Enter to choose a Chinese or Japanese candidate
  picks the word instead of firing the message with half-typed text.
- **Settings has one Save button.** The Connections tab stops repeating itself; REST API, MCP,
  Slack and webhooks each keep their place.
- **The app counts messages you send, not what they say.** A single `message_sent` event closes the
  activation funnel: a count and nothing else, no text, no length, no content of any kind.
  [`TELEMETRY.md`](TELEMETRY.md) lists it like every other event and the same opt-out applies.
- **The ASK ME card renders markdown.** Questions with emphasis, bullets, `code`, tables and links
  now render instead of showing their raw asterisks.

### A note on Pro

v0.5.0 launches with a Pro version alongside the community version. Community stays free, stays
open, and keeps getting updates. Pro ships with new features and integrations, with more posted
throughout the year, and it stays ahead of Community, for power users who want the full potential
of coding agents and agent harnesses. The Pro roadmap also includes a mobile app. The first 100 people on the
Founders' Wall get a month of Pro free, then 50% off the annual plan.

### Thanks

16 community pull requests from 13 contributors landed in this release, one of them (#213)
re-implemented rather than merged. Thank you to [@aaroncoville](https://github.com/aaroncoville), [@abo123v-glitch](https://github.com/abo123v-glitch),
[@BUGHUNTER-SACHIN](https://github.com/BUGHUNTER-SACHIN), [@djbiz](https://github.com/djbiz),
[@gpechieu](https://github.com/gpechieu), [@HsienW](https://github.com/HsienW),
[@HundredBillion](https://github.com/HundredBillion), [@jhinzzz](https://github.com/jhinzzz),
[@L422Y](https://github.com/L422Y), [@LavaDMan](https://github.com/LavaDMan),
[@raifemre](https://github.com/raifemre), [@savvaskoualis](https://github.com/savvaskoualis) and
[@Schopenhauer-loves-Hegel](https://github.com/Schopenhauer-loves-Hegel), and to everyone who
reviewed a pull request or filed the bug that led to one.

<!-- drop -->
<div class="drop">
  <p class="eyebrow">Munder Difflin 0.4.6</p>
  <h1>Speaks your language. Updates itself.</h1>
  <p class="lede">The interface now runs in Chinese and Arabic, the updater installs a new build end
  to end, and the fonts ship inside the app so a blocked network never leaves you on a blank screen.</p>
  <ul class="features">
    <li>
      <h2>Chinese and Arabic</h2>
      <p>Pick a language in Settings. Every string is translated and the terminals read right to
      left. Some screens still need their padding and icons mirrored, and that is the next piece of
      work.</p>
    </li>
    <li>
      <h2>Updates install themselves</h2>
      <p>The badge moves from check to available to downloading to downloaded on its own, and the
      button at the end restarts you into the new version. This is the release that proves that path.</p>
    </li>
    <li>
      <h2>Fonts ship inside the app</h2>
      <p>No Google Fonts fetch on launch, so the app opens at the same speed on any network,
      including one where Google is blocked, and this page can no longer white-screen while a
      stylesheet loads.</p>
    </li>
    <li>
      <h2>Hardened command launching</h2>
      <p>The name of the CLI an agent launches is validated before it is ever resolved against your
      PATH.</p>
    </li>
    <li>
      <h2>One Save button</h2>
      <p>The Connections tab stops repeating itself. REST API, MCP, Slack and webhooks each keep
      their place.</p>
    </li>
  </ul>
</div>
<!-- /drop -->

## Still new in 0.4.5

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
| Universal (Apple Silicon + Intel) | [`Munder-Difflin-0.4.6-mac-universal.dmg`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.4.6-mac-universal.dmg) |

### 🪟 Windows
| Build | File |
|---|---|
| Installer (x64), *recommended* | [`Munder-Difflin-0.4.6-win-x64-setup.exe`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.4.6-win-x64-setup.exe) |
| Portable (x64, no install) | [`Munder-Difflin-0.4.6-win-x64-portable.exe`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.4.6-win-x64-portable.exe) |

### 🐧 Linux
| Build | File |
|---|---|
| AppImage (x86_64) | [`Munder-Difflin-0.4.6-linux-x86_64.AppImage`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.4.6-linux-x86_64.AppImage) |

### 📦 Source
[Source code (zip)](https://github.com/chaitanyagiri/munder-difflin/archive/refs/tags/v0.4.6.zip) ·
[Source code (tar.gz)](https://github.com/chaitanyagiri/munder-difflin/archive/refs/tags/v0.4.6.tar.gz)

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

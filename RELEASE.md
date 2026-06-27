# Munder Difflin v0.3.2

**A local hive of Claude Code, Antigravity & Codex agents that run themselves** — messaging,
routing, and remembering, coordinated by a GOD orchestrator you talk to. Local-first and open source.

### → [**munderdiffl.in**](https://munderdiffl.in/) — see it in action, then grab a build below

---

## What's new in 0.3.2 — *Realtime Michael: talk to the GOD orchestrator*

**Talk to Michael.** The headline is **Realtime Michael** — a low-latency **voice channel to the
GOD orchestrator**, running alongside the async terminal floor. Press **Talk**, and Michael listens,
answers, and *acts* in real time.

- **Talk to the GOD orchestrator by voice.** A new low-latency realtime channel (OpenAI Realtime API
  over WebRTC) sits next to the async terminal. A **Talk** toggle — on Michael's card and in any
  fullscreen terminal — opens a mic session with echo-cancellation, semantic-VAD turn-taking +
  barge-in, and a device picker. Michael runs his own persona and answers in a natural voice, with an
  `Off → Connecting → Listening → Responding → Working` state machine live on his card.
- **Reads the hive, acts behind echo-back confirm.** He reads the floor (tasks, board, memory,
  agents, activity, cost) and — behind a spoken **echo-back confirmation** for anything destructive —
  creates and assigns work, dispatches agents, spawns and kills workers, and steers the floor. Every
  voice action is attributed to a distinct **michael-voice** actor that pings the GOD terminal, so a
  voice-driven dispatch is auditable; there are hard refusals for killing the GOD agent or targeting
  all agents at once.
- **Voice read-layer over hive messages.** Michael can now read message *content*, not just
  metadata: a read/brief-only `get_messages` tool surfaces a **full message by id, one mailbox, or
  the latest across the floor** — with **all secret redaction done main-side** so the voice layer
  only ever receives already-redacted bodies (no provider / Slack / GitHub / AWS / Google key, JWT,
  PEM block, or `Bearer` token can leak). Read-only — it adds no new write path.
- **"Respond when done."** Voice-dispatched work reports back on its own: a completion watcher
  detects when a dispatched task finishes and **pushes the event into the live session so Michael
  speaks it unprompted**; if the session is closed, completions queue to a desktop notification and a
  warm-start on reconnect.
- **BYOK, main-only.** Bring-your-own OpenAI key: the key is decrypted **main-only**, minted into
  short-lived ephemeral session tokens, and **never reaches the renderer**. A live session cost meter
  sits by the Talk toggle, with a hard **spend cap** and an **idle auto-disconnect** so a
  forgotten-open mic can't run up a bill.
- **Slack hardening + maintenance.** Proactive Slack posting is **off by default** (no sends without
  an explicit channel + thread), auto-compaction becomes a **dedicated maintenance schedule**
  decoupled from standups (so editing standups can't silently drop it), and each agent now carries
  queryable **per-agent environment metadata** with a working-directory validity guard.

> **Live verification note.** The realtime voice loop is **human-verified end-to-end** on a real
> OpenAI key — connect → mic → Michael answers via the read tools, and the full destructive path
> (spoken echo-back confirm → spawn / kill / dispatch → worker appears on the floor → completion
> spoken back) was exercised live. It requires **your own OpenAI key with Realtime API access**;
> without one the **Talk** button stays visibly disabled with a "needs OpenAI key" cue. The new
> voice-message read-layer's redaction battery is unit-tested in lockstep with the main process; its
> end-to-end voice read is human-gated like all realtime work.

---

## What's new in 0.3.1 — *Three more engines: OpenCode · Crush · pi.dev*

The floor gained three new coding CLIs, each usable as a **worker and as Michael**, with
**bring-your-own keys + local LLMs**: **OpenCode** (`opencode`) via a native-plugin bridge,
**Crush** (`crush`, Charmbracelet's Go TUI) via a per-agent proxy bridge, and **pi.dev** (`pi`) via a
hooks bridge. A new **Settings → AI Engines** panel collects per-provider **API keys** (stored
write-only, encrypted) and **local base-URLs** (Ollama / LM Studio / vLLM). Plus two reliability
fixes: the **message router now survives system sleep** (re-arms and drains the backlog on wake), and
**Codex workers get full filesystem + auto-approval from spawn** (parity with Claude).

Everything from **v0.3.0** (selectable engines, integrations registry + loopback secret broker,
Slack-spawned ephemeral workers, Agent Gallery) and earlier — Free Flow voice dictation, the
enterprise Knowledge Graph, multi-window "floors", the rich message composer, agent session resume,
and drag-a-file path injection — is included.
See the [CHANGELOG](https://github.com/chaitanyagiri/munder-difflin/blob/main/CHANGELOG.md) for full detail.

---

## ⤓ Downloads

Latest builds for every platform. The macOS build is **universal** — one DMG that runs on both
Apple Silicon and Intel.

### 🍎 macOS
| Build | File |
|---|---|
| Universal (Apple Silicon + Intel) | [`Munder-Difflin-0.3.2-mac-universal.dmg`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.3.2-mac-universal.dmg) |

### 🪟 Windows
| Build | File |
|---|---|
| Installer (x64) — *recommended* | [`Munder-Difflin-0.3.2-win-x64-setup.exe`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.3.2-win-x64-setup.exe) |
| Portable (x64, no install) | [`Munder-Difflin-0.3.2-win-x64-portable.exe`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.3.2-win-x64-portable.exe) |

### 🐧 Linux
| Build | File |
|---|---|
| AppImage (x86_64) | [`Munder-Difflin-0.3.2-linux-x86_64.AppImage`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.3.2-linux-x86_64.AppImage) |

### 📦 Source
[Source code (zip)](https://github.com/chaitanyagiri/munder-difflin/archive/refs/tags/v0.3.2.zip) ·
[Source code (tar.gz)](https://github.com/chaitanyagiri/munder-difflin/archive/refs/tags/v0.3.2.tar.gz)

> **Verify your download:** [`SHA256SUMS.txt`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/SHA256SUMS.txt) — then `shasum -a 256 -c SHA256SUMS.txt` (macOS/Linux) or `Get-FileHash` (Windows).

> The links above always point at the **latest** release (`/releases/latest/download/…`),
> so this page stays correct across versions.

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

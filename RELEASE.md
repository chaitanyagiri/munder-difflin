# Munder Difflin v0.2.6

**A local hive of Claude Code, Antigravity & Codex agents that run themselves** — messaging,
routing, and remembering, coordinated by a GOD orchestrator you talk to. Local-first and open source.

### → [**munderdiffl.in**](https://munderdiffl.in/) — see it in action, then grab a build below

---

## What's new in 0.2.6 — *Polish & reliability*

A focused patch that fixes the first thing you see and the first thing that can break:

- **The agent terminal renders correctly the moment it opens.** It used to fit before its
  pane had a real size — and cache the character-cell metrics from before the `VT323` font
  loaded — so the welcome banner came up oversized and clipped until you manually resized.
  The view now waits for a real size, re-measures and re-rasters once the font is ready, and
  lets a `ResizeObserver` drive the first fit. It just fits.
- **`npm run dev` no longer crashes on a fresh clone (#67).** The boot-time Slack-trigger
  `.cjs` sidecar is now copied by a vite `writeBundle` plugin, so **both** `dev` and `build`
  emit it from one place (the packaged-build fix in v0.2.5 didn't cover the dev path).
- **Windows: node-pty ConPTY crash guarded (#65).** The main process no longer dies when
  ConPTY fails to attach a console — a companion hardening to the Antigravity provider work.
- **The wall clock is interactive (#64).** The office clock shows the real time, and clicking
  it opens the closing-time (graceful shutdown) flow.
- **ASK ME reads in the memory font (#63).** The ASK ME board now uses `VT323` to match the
  rest of the memory surfaces, instead of the chunky Pixelify Sans.
- **Security — Slack download host-pinned.** The Slack bot token is only ever sent to
  `*.slack.com`, a defense-in-depth guard added before the `Authorization` header is attached.

Everything from **v0.2.5** (the packaging crash fix, autonomous Slack-request protocol, the
delegate toggle) and earlier is included.
See the [CHANGELOG](https://github.com/chaitanyagiri/munder-difflin/blob/main/CHANGELOG.md) for full detail.

---

## ⤓ Downloads

Latest builds for every platform. The macOS build is **universal** — one DMG that runs on both
Apple Silicon and Intel.

### 🍎 macOS
| Build | File |
|---|---|
| Universal (Apple Silicon + Intel) | [`Munder-Difflin-0.2.6-mac-universal.dmg`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.2.6-mac-universal.dmg) |

### 🪟 Windows
| Build | File |
|---|---|
| Installer (x64) — *recommended* | [`Munder-Difflin-0.2.6-win-x64-setup.exe`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.2.6-win-x64-setup.exe) |
| Portable (x64, no install) | [`Munder-Difflin-0.2.6-win-x64-portable.exe`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.2.6-win-x64-portable.exe) |

### 🐧 Linux
| Build | File |
|---|---|
| AppImage (x86_64) | [`Munder-Difflin-0.2.6-linux-x86_64.AppImage`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.2.6-linux-x86_64.AppImage) |

### 📦 Source
[Source code (zip)](https://github.com/chaitanyagiri/munder-difflin/archive/refs/tags/v0.2.6.zip) ·
[Source code (tar.gz)](https://github.com/chaitanyagiri/munder-difflin/archive/refs/tags/v0.2.6.tar.gz)

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
- **The simulation** — every agent is a real `claude` (or `agy` / `codex`) pseudo-terminal, visualized as an avatar on a watchable office floor (`node-pty` · `xterm.js` · Pixi.js).
- **MemPalace** — a markdown-first, semantic memory layer the whole office shares; cross-session recall in ~12ms.
- **GOD orchestrator + hive** — one agent you talk to routes work to specialists and stays autonomous, escalating only critical items (spend, destructive ops, scope) to you natively, through Claude Code's human-in-the-loop prompts.
- **Plugs into your setup** — your subscription, settings, skills, and MCP servers; `/remote-control` reaches the whole floor from your phone.

Full notes in the [CHANGELOG](https://github.com/chaitanyagiri/munder-difflin/blob/main/CHANGELOG.md).

---

## Links
[Website](https://munderdiffl.in/) ·
[Repo](https://github.com/chaitanyagiri/munder-difflin) ·
[Issues](https://github.com/chaitanyagiri/munder-difflin/issues) ·
[Contribute](https://github.com/chaitanyagiri/munder-difflin/blob/main/CONTRIBUTING.md) ·
[Become a patron](https://razorpay.me/@munderdifflinfund)

MIT-licensed. An affectionate parody — not affiliated with NBC's *The Office* or Dunder Mifflin.

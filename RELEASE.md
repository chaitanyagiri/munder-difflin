# Munder Difflin v0.2.3

**A local hive of Claude Code agents that run themselves** — messaging, routing, and
remembering, coordinated by a GOD orchestrator you talk to. Local-first and open source.

### → [**munderdiffl.in**](https://munderdiffl.in/) — see it in action, then grab a build below

---

## What's new in 0.2.3 — *multi-provider*

The floor is no longer Claude-only. Antigravity (Gemini) and Codex workers become
first-class hive participants, schedules get their own tab, and the Slack / webhook
ingress moves off the flaky public tunnel:

- **First-class Antigravity (Gemini · `agy`) provider** — run an Antigravity worker as a full hive participant. Since `agy` has no Claude-style hooks, the hive identity + protocol ride in as the session's initial prompt, and a native `agy-hook` bridge maps Antigravity's lifecycle events into the existing pipeline, so a Gemini worker gets the same live status + inbox-drain as Claude — on the subscription, no API key. (#54)
- **Codex workers follow the protocol and message back** — Codex spawned without the hive protocol or any hook, so it never read its inbox or wrote its outbox. Codex is now an inbox-capable provider: the protocol is injected as its initial prompt, its outbox is drained by the router, and inbox mail reaches it via the idle inbox-wake nudge. Codex and Antigravity coexist in the provider union. (#47, #54)
- **Schedules get their own Command-Center tab** — recurring auto-dispatched missions (and the adaptive heartbeat) move out of an inline section into a dedicated tab, with a boss-room calendar shortcut. (#50)
- **Terminal work-order handoff for hookless providers** — a provider with no inbox-drain path now receives hive mail as a `WORK ORDER FROM HIVE` typed into its terminal, falling back to a god-bounce only if the renderer is unavailable. (#53)
- **Slack + webhook public URL no longer silently breaks** — the ingress used loca.lt, which now serves a browser interstitial that fails Slack's URL verification and breaks saved webhook URLs. Both now use **tunnelmole** (MIT; POSTs pass straight through), and a failed tunnel surfaces a real error instead of a silent "started."

Everything from **v0.2.0** (observability, control, the rebuilt Command Center, persistence),
**v0.2.1** (gentler scheduling), and **v0.2.2** (community polish) is included.
See the [CHANGELOG](https://github.com/chaitanyagiri/munder-difflin/blob/main/CHANGELOG.md) for full detail.

---

## ⤓ Downloads

Latest builds for every platform. The macOS build is **universal** — one DMG that runs on both
Apple Silicon and Intel.

### 🍎 macOS
| Build | File |
|---|---|
| Universal (Apple Silicon + Intel) | [`Munder-Difflin-0.2.3-mac-universal.dmg`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.2.3-mac-universal.dmg) |

### 🪟 Windows
| Build | File |
|---|---|
| Installer (x64) — *recommended* | [`Munder-Difflin-0.2.3-win-x64-setup.exe`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.2.3-win-x64-setup.exe) |
| Portable (x64, no install) | [`Munder-Difflin-0.2.3-win-x64-portable.exe`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.2.3-win-x64-portable.exe) |

### 🐧 Linux
| Build | File |
|---|---|
| AppImage (x86_64) | [`Munder-Difflin-0.2.3-linux-x86_64.AppImage`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.2.3-linux-x86_64.AppImage) |

### 📦 Source
[Source code (zip)](https://github.com/chaitanyagiri/munder-difflin/archive/refs/tags/v0.2.3.zip) ·
[Source code (tar.gz)](https://github.com/chaitanyagiri/munder-difflin/archive/refs/tags/v0.2.3.tar.gz)

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

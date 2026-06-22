# Munder Difflin v0.3.1

**A local hive of Claude Code, Antigravity & Codex agents that run themselves** — messaging,
routing, and remembering, coordinated by a GOD orchestrator you talk to. Local-first and open source.

### → [**munderdiffl.in**](https://munderdiffl.in/) — see it in action, then grab a build below

---

## What's new in 0.3.1 — *Three more engines: OpenCode · Crush · pi.dev*

The floor gets three new coding CLIs, each usable as a **worker and as Michael**, with
**bring-your-own keys + local LLMs**:

- **OpenCode** (`opencode`, the TypeScript agent) — wired via a **native plugin** bridge
  (`session.idle`): no traffic interception, provider-agnostic, works with local models.
- **Crush** (`crush`, Charmbracelet's Go TUI) — a **proxy** bridge routes its LLM traffic through a
  per-agent config so a hookless CLI still reports status and drains mail.
- **pi.dev** (`pi`, the Pi Coding Agent) — a **hooks** bridge: a bundled extension maps Pi's
  `pi.on(event)` lifecycle onto the hive, and auto-approves tools only when the floor is in auto mode.

A new **Settings → AI Engines** panel collects per-provider **API keys** (stored *write-only*,
encrypted, never shown again) and **local base-URLs** (Ollama / LM Studio / vLLM) for these engines.

> **Heads-up:** these engines are integrated and selectable as god, but **live end-to-end
> verification with real model calls is pending your BYOK keys / a local LLM** — verify on-device.
> Mail delivery doesn't wait on that: a new **provider-agnostic PTY-quiescence idle fallback** flips
> any silent-but-busy agent back to idle, so the idle wake-nudge drains a god even if a bridge's
> turn-end signal never fires.

Plus two reliability fixes: the **message router now survives system sleep** (it re-arms and drains
the backlog on wake, so god→worker and agent↔agent mail keeps flowing after the laptop's been
closed), and **Codex workers get full filesystem + auto-approval from spawn** (parity with Claude),
so a fresh Codex hive worker can do its protocol housekeeping without a permission prompt.

---

## What's new in 0.3.0 — *Selectable engines, integrations, and Slack-spawned workers*

The biggest platform release yet: the floor stops being Claude-shaped. Every hire — and Michael
himself — becomes a **pluggable engine**, each with its own consented skills + MCP catalog. A new
**integrations registry** turns "connect a service" into a write-only, registry-driven Settings
flow. And Michael can now **spawn an ephemeral worker straight from a Slack message**, reply, and
tear it down safely.

- **Selectable agent engines + per-hire capabilities.** A new engine abstraction makes the runtime
  behind each agent pluggable — Claude Code, Antigravity, Codex, or a **local provider** (a
  claw/qwen backend proxy). Each hire carries its own **manifest** of allowed skills + MCP servers
  (default-deny over a shared catalog), with **bundled skills** shipped in the app and a **consent
  UI** that surfaces every skill/MCP a hire wants before it can use it. Even **Michael's own
  engine** is swappable, with an Onboarding engine picker and a change-engine flow.
- **Integrations registry + loopback secret broker.** A declarative integrations registry plus a
  **loopback secret broker**: secrets are **write-only** (set once, never read back into the
  renderer) and reached only through the broker. A **registry-driven Settings UI** renders each
  integration's config form from the spec, with a first wave of declarative templates.
- **God-triggered ephemeral Slack worker loop.** Michael spawns an isolated worker in response to a
  Slack request, the worker posts its reply back into the thread, and it's then **torn down
  safely** — with **worktree GC**, **per-worker token caps**, and a teardown gate that never
  auto-discards unintegrated work. Live workers show up in a new **Workers tab**.
- **Temporal date-range skills + worker capability catalog.** Date-range skills (today / yesterday /
  thisWeek / lastWeek / thisMonth / thisQuarter / thisYear / lastMonth / last7Days / last30Days …)
  resolve a named window to concrete ISO dates, and each spawned worker can read a **capability
  catalog** of exactly which skills and brokered integrations it has.
- **Provider / Hive picker + Agent Gallery.** A visual `HivePicker` with real provider logos lands
  in onboarding and add-agent, *The Hiring Fair* is rebranded to the **Agent Gallery** with **six
  off-the-shelf hires**, onboarding is now feature-aware (with a permissions & reliability step),
  and the engine-CLI installer runs **visibly** when a binary is missing.
- **Wake-reliability hardening.** Wedged terminals are **auto-revived on wake**, and **missed
  schedules are caught up** when the machine wakes instead of being silently skipped.
- **Security:** the `integrations:test` probe path is **confined** so it can't be turned into a
  secret-exfiltration or SSRF primitive.

Everything from **v0.2.8** (shareable hires + the gallery) and earlier — Free Flow voice dictation,
the enterprise Knowledge Graph, multi-window "floors", the rich message composer, agent session
resume, and drag-a-file path injection — is included.
See the [CHANGELOG](https://github.com/chaitanyagiri/munder-difflin/blob/main/CHANGELOG.md) for full detail.

---

## ⤓ Downloads

Latest builds for every platform. The macOS build is **universal** — one DMG that runs on both
Apple Silicon and Intel.

### 🍎 macOS
| Build | File |
|---|---|
| Universal (Apple Silicon + Intel) | [`Munder-Difflin-0.3.0-mac-universal.dmg`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.3.0-mac-universal.dmg) |

### 🪟 Windows
| Build | File |
|---|---|
| Installer (x64) — *recommended* | [`Munder-Difflin-0.3.0-win-x64-setup.exe`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.3.0-win-x64-setup.exe) |
| Portable (x64, no install) | [`Munder-Difflin-0.3.0-win-x64-portable.exe`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.3.0-win-x64-portable.exe) |

### 🐧 Linux
| Build | File |
|---|---|
| AppImage (x86_64) | [`Munder-Difflin-0.3.0-linux-x86_64.AppImage`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.3.0-linux-x86_64.AppImage) |

### 📦 Source
[Source code (zip)](https://github.com/chaitanyagiri/munder-difflin/archive/refs/tags/v0.3.0.zip) ·
[Source code (tar.gz)](https://github.com/chaitanyagiri/munder-difflin/archive/refs/tags/v0.3.0.tar.gz)

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
- **The simulation** — every agent is a real `claude` (or `agy` / `codex` / local-provider) pseudo-terminal, visualized as an avatar on a watchable office floor (`node-pty` · `xterm.js` · Pixi.js).
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

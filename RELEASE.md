# Munder Difflin v0.2.8

**A local hive of Claude Code, Antigravity & Codex agents that run themselves** — messaging,
routing, and remembering, coordinated by a GOD orchestrator you talk to. Local-first and open source.

### → [**munderdiffl.in**](https://munderdiffl.in/) — see it in action, then grab a build below

---

## What's new in 0.2.8 — *Shareable hires*

Ready-made agent roles you can share and hire in one click. A portable **hire manifest**
describes a role-configured agent — name, sprite, provider, model, flags, goal, capabilities,
token budget — so a role can be shared as a file or hosted in a gallery, imported into anyone's
office, reviewed, and spawned with a single human click.

- **Shareable hires — one-click agent roles (#70, #71).** Import a role two ways: a
  `munderdifflin://hire?src=<https-manifest-url>` deep link (the app fetches and validates the
  manifest, then opens the Add-Agent modal pre-filled) or an *import hire…* button that reads a
  local manifest file. Either way you review every field — an "imported" banner makes it explicit —
  and **you** click spawn. Import never spawns anything on its own.
- **The Hiring Fair — a community gallery** at [munderdiffl.in/hires](https://munderdiffl.in/hires/).
  A static, build-step-free gallery of ready-made roles from the cast (Pam writes docs, Dwight
  enforces QA, Jim reviews PRs, Creed audits security, Angela audits the office's own token spend,
  Stanley does the migrations nobody wants), each with a Claude Code / Antigravity / Codex toggle
  and function filters that match the landing page.
- **An untrusted-input security model, hardened.** A manifest is treated as hostile input end to
  end: no auto-spawn and no executable field (the binary always comes from your local provider
  preset; `provider: "custom"` is rejected); a **default-deny allowlist** for embedded CLI flags
  (only a known-harmless set passes — nothing that touches system prompts or settings); `model`
  constrained to a safe charset plus a command-line quoter that neutralizes shell metacharacters on
  every spawn path; and a bounded, https-only fetch (manual-redirect with per-hop re-validation to
  kill SSRF, a streamed 64 KB byte cap, a 10s timeout). One dependency-free validator is shared by
  the app, the renderer, the gallery, and a JSON schema.

Everything from **v0.2.7** (Free Flow voice dictation, the enterprise Knowledge Graph, multi-window
"floors", the rich message composer, agent session resume with Restart & Continue, and drag-a-file
path injection) and earlier is included.
See the [CHANGELOG](https://github.com/chaitanyagiri/munder-difflin/blob/main/CHANGELOG.md) for full detail.

---

## ⤓ Downloads

Latest builds for every platform. The macOS build is **universal** — one DMG that runs on both
Apple Silicon and Intel.

### 🍎 macOS
| Build | File |
|---|---|
| Universal (Apple Silicon + Intel) | [`Munder-Difflin-0.2.8-mac-universal.dmg`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.2.8-mac-universal.dmg) |

### 🪟 Windows
| Build | File |
|---|---|
| Installer (x64) — *recommended* | [`Munder-Difflin-0.2.8-win-x64-setup.exe`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.2.8-win-x64-setup.exe) |
| Portable (x64, no install) | [`Munder-Difflin-0.2.8-win-x64-portable.exe`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.2.8-win-x64-portable.exe) |

### 🐧 Linux
| Build | File |
|---|---|
| AppImage (x86_64) | [`Munder-Difflin-0.2.8-linux-x86_64.AppImage`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.2.8-linux-x86_64.AppImage) |

### 📦 Source
[Source code (zip)](https://github.com/chaitanyagiri/munder-difflin/archive/refs/tags/v0.2.8.zip) ·
[Source code (tar.gz)](https://github.com/chaitanyagiri/munder-difflin/archive/refs/tags/v0.2.8.tar.gz)

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

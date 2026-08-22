# Contributing to Munder Difflin

Thanks for your interest! This is an early prototype, so there's a lot of surface
area and plenty of room to help. This guide covers setup, the gotchas, and the
conventions that keep the codebase coherent.

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). By
participating, you agree to uphold it.

## Development setup

### Prerequisites

- **macOS** — the app is macOS-first. Windows/Linux are untested but PRs that
  improve cross-platform support are welcome.
- **Node.js 22.22+** and npm.
- A **C/C++ toolchain** to build `node-pty`'s native addon. On macOS:
  ```bash
  xcode-select --install
  ```
- **[Claude Code](https://claude.com/claude-code)** on your `PATH` if you want
  agents to actually run `claude` (the default command). Any other command works.

### Install & run

```bash
git clone <your-fork-url> munder-difflin
cd munder-difflin
npm install        # postinstall rebuilds node-pty against Electron's ABI
npm run dev        # live-reloading Electron build
```

> [!IMPORTANT]
> **The most common setup failure is the native `node-pty` rebuild.** The
> `postinstall` script runs `electron-rebuild` so `node-pty` matches Electron's
> ABI. If you see a "wrong ELF/Mach-O" or "NODE_MODULE_VERSION" error at launch,
> re-run `npm install` (which re-triggers `postinstall`) after confirming your
> C/C++ toolchain is installed.

## Before you open a PR

1. **Keep the type-checker green:** `npm run typecheck` (runs both the node and
   web TS projects). This is the de-facto CI gate — there is no test suite yet.
2. **Confirm a production build works:** `npm run build`.
3. **Match the aesthetic.** Any new UI **must** derive from the design tokens in
   [`DESIGN.md`](./DESIGN.md) / `src/renderer/src/design/tokens.ts` — no ad-hoc
   colors, spacing, or fonts. `tokens.ts` and `tokens.css` are mirrored; if you
   change one, change both.
4. **For anything visual, include a screenshot or short clip** in the PR.

## Project layout

| Path | What lives there |
|---|---|
| `src/main/` | Electron main process — PTYs (`pty.ts`), fs/git bridges, the hive (`hive.ts`, `hooks.ts`, `memory.ts`), config. |
| `src/preload/` | Context-bridge IPC surface. |
| `src/renderer/` | React UI, Pixi.js office scene (`scene/office/`), components, design system, stores. |
| `tools/mapgen/` | Python helpers for building/rendering the Tiled office map. |

See the [Architecture](./README.md#architecture) section of the README for the
data-flow overview.

## Good first areas

- **Wiring real Claude Code hook events** — avatar behavior is currently driven
  by a mock event loop (`src/renderer/src/store/mockEvents.ts`). Replacing it
  with real tool events is the headline next milestone.
- The add-agent flow and config drawer.
- Cross-platform smoke-testing (Linux/Windows).

## Commit & PR conventions

- Branch off `main`; keep PRs focused on one change.
- Write a clear PR description of *what* changed and *why*.
- Don't commit `node_modules/`, `out/`, or built artifacts (already gitignored).

## A note on assets

The bundled pixel art is under the **LimeZu FREE VERSION license
(non-commercial only)** — see [`ATTRIBUTION.md`](./src/renderer/src/assets/ATTRIBUTION.md).
If you contribute new art, it must be either your own work or compatibly
licensed, and you must add it to `ATTRIBUTION.md`. Don't add commercial-only or
unlicensed assets.

## Questions

Open a [discussion or issue](../../issues) — happy to help you get oriented.

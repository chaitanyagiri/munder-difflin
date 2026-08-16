# Repository Guidelines

## Project Overview

Munder Difflin is a local-first Electron desktop app built with Electron, React, TypeScript, Pixi.js, xterm.js, and node-pty. It wraps terminal-agent CLIs in PTY-backed sessions, coordinates them through the on-disk hive layer, and renders the office/fleet UI in the Electron renderer.

## Important Paths

- `src/main/`: Electron main process, IPC handlers, PTY management, filesystem/git bridges, hive, hooks, telemetry, config, and persistence.
- `src/preload/`: typed `contextBridge` API exposed as `window.cth`.
- `src/renderer/src/`: React UI, Pixi office scene, components, stores, hooks, IDE, integrations, and design system.
- `src/shared/`: shared provider/config command metadata and cross-process types/helpers.
- `test/`: Node test suites using the built-in `node --test` runner.
- `docs/`, `HIVE.md`, `SPEC.md`, `DESIGN.md`: product, architecture, hive, and visual design references.
- `landing-remotion/` and `blog/`: separate content/media projects with their own package files.

## Setup And Commands

- Install dependencies with `npm install`. The postinstall step rebuilds `node-pty` against Electron's ABI.
- Start the app with `npm run dev`.
- Type-check with `npm run typecheck`.
- Run the focused test suite with `npm run test:focused`.
- Build with `npm run build`.
- Preview a production build with `npm run preview`.
- Package installers with `npm run dist`, or platform-specific `dist:mac`, `dist:win`, and `dist:linux`.

CI runs `npm ci`, `npm run typecheck`, and a non-blocking macOS build. Treat `npm run typecheck` as the main required gate, and run focused tests or `npm run build` when your change touches covered behavior, packaging, native modules, or renderer/main integration.

## Development Notes

- Keep the main/preload/renderer boundary intact. Renderer code should use the typed preload bridge rather than reaching into Node APIs directly.
- The main process owns PTYs, filesystem access, git operations, durable storage, hive routing, hooks, telemetry, and external process lifecycle.
- The renderer owns UI state, Pixi scene rendering, terminal display, panels, stores, and user interactions.
- Prefer existing provider abstractions and command metadata in `src/shared/` when adding or changing agent/provider behavior.
- `node-pty` is native and Electron ABI-sensitive. If launch fails with native module or ABI errors after dependency/Electron changes, rerun `npm install`.
- Be careful around long-running agent processes, kill paths, cost/usage accounting, and human-in-the-loop controls. Add or run targeted tests for lifecycle changes.

## UI And Design

- Follow `DESIGN.md` and the token files for all renderer UI changes.
- Design tokens are mirrored in `src/renderer/src/design/tokens.ts` and `src/renderer/src/design/tokens.css`; update both when changing tokens.
- Prefer existing components and patterns in `src/renderer/src/components/`, `src/renderer/src/design/`, and `src/renderer/src/scene/office/`.
- Do not introduce ad-hoc colors, spacing, fonts, or one-off visual styles.
- For visual changes, verify the Electron renderer manually or with screenshots when possible.

## Testing Guidance

- Use `npm run typecheck` before handing off code changes whenever practical.
- Use `npm run test:focused` for changes to provider automation, queue delivery, terminal lifecycle/recovery, roster/config, hive runtime behavior, update state, transcript project dirs, CLI install flow, or commit graph behavior.
- Run `npm run build` when touching Electron/Vite config, preload/main boundaries, packaging assets, native dependencies, or broad renderer code.
- There is no lint script in the top-level package; follow the existing TypeScript and React style in nearby files.

## Git And Artifacts

- Keep PRs focused and branch from `main`.
- Do not commit `node_modules/`, `out/`, generated installers, or other built artifacts.
- Avoid unrelated refactors while fixing a targeted issue.
- If assets are added, make sure licensing is compatible and attribution is updated where the existing asset docs require it.

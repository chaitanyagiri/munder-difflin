# Munder Difflin — working notes

An Electron + React + Pixi.js v8 desktop app. The office floor is a Tiled map rendered
with Pixi; agent terminals are xterm.js.

## Commands

```bash
npm run dev              # electron-vite dev
npm run build            # build + copy main assets
npm run typecheck        # node + web tsconfigs, both must pass
npm run test:focused     # node --test test/*.test.cjs
```

Run `typecheck` and `test:focused` before committing anything under
`src/renderer/src/scene/`. The scene code has no runtime type safety net — a bad cast
surfaces as a frozen or blank canvas, not as an exception.

## The office scene

`src/renderer/src/scene/office/` holds the floor. The pieces that matter:

- **`pathfinding.ts`** — BFS over the walkability grid, then `smoothPath` collapses the
  staircase BFS produces into straight runs using `lineOfSight`.
- **`Character.ts` / `CharacterSprite.ts`** — an agent's movement and its drawn form.

### Diagonals must check both flanks

`lineOfSight` samples at sub-tile resolution and, on any diagonal step, requires *both*
flanking tiles to be walkable. Without that second test a smoothed path slips through the
corner where two walls meet — geometrically valid for a line, visibly wrong for a person,
and something plain BFS can never do because it only moves on the four cardinals. Any
change to smoothing has to keep that check.

`test/office-pathfinding.test.cjs` pins this, including that an exhaustive search of a
large map still terminates and reports no route rather than hanging.

## Two Pixi gotchas that cost real time

1. **The ticker stops.** It stalls roughly 20s after load while still reporting
   `started: true`. Anything that must keep running uses `setInterval`, not the ticker,
   and `window.__mdTicks` is the honest liveness signal — a health check that reads
   `started` will call a dead floor healthy.
2. **Terminals must not take WebGL contexts.** Chromium caps how many exist and evicts
   the *oldest*, which is the office floor created at startup. Raising the cap makes it
   worse: with a full cast the renderer stops answering CDP entirely. xterm renders
   through its DOM renderer instead, so the floor keeps the only context it needs.

## Debugging a running instance

The app is an Electron window, so ordinary browser tooling cannot reach it. Launch with
`--remote-debugging-port=9333` and drive it over CDP — screenshot it, evaluate in it, and
read `window.__mdApp`, `__mdMap`, `__mdChars`, `__mdProps`, `__mdDoors`, `__mdTicks`.

Verifying a visual change by reading the diff does not work here. Look at the pixels.

## Scope note

This checkout is the app's source. The *installed* build is patched separately and those
patches are not part of this repo; do not try to reconcile the two by editing here.

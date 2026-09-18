/** How the app comes back up after a change that needs every service to
 *  re-bootstrap from a freshly written config — change home, reset all.
 *
 *  Packaged: `app.relaunch()` + exit is the clean re-bind, and the renderer is
 *  bundled, so the new process comes up whole.
 *
 *  `npm run dev`: the renderer is served by electron-vite's dev server, which
 *  lives in the wrapper process that watches THIS Electron and exits with it.
 *  A relaunched Electron therefore started against a dead dev server and came
 *  up with a blank window that the developer had to hunt down and kill before
 *  running `npm run dev` again. Exiting cleanly is the honest move there: the
 *  wrapper returns to the shell, and the next `npm run dev` boots against the
 *  new config. electron-vite marks dev mode with ELECTRON_RENDERER_URL — the
 *  same variable the window loader keys on. */
export type RelaunchPlan = 'relaunch' | 'exit';

export function relaunchPlan(env: { ELECTRON_RENDERER_URL?: string } = process.env): RelaunchPlan {
  return env.ELECTRON_RENDERER_URL ? 'exit' : 'relaunch';
}

/** The console line a developer sees instead of a blank window. */
export function devExitNotice(reason: string): string {
  return `[${reason}] dev mode (electron-vite): exiting instead of relaunching — the dev server dies with this process `
    + 'and a relaunched window would be blank. Run `npm run dev` again to come up on the new config.';
}

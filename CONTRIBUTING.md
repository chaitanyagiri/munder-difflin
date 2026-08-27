# Contributing to Munder Difflin

Thanks for your interest! This is an early prototype, so there's a lot of surface
area and plenty of room to help. This guide covers setup, the gotchas, and the
conventions that keep the codebase coherent.

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). By
participating, you agree to uphold it.

## Development setup

### Prerequisites

- **macOS, Windows, or Linux** — signed/notarized macOS builds, plus Windows and
  Linux builds, ship from the [releases page](https://github.com/chaitanyagiri/munder-difflin/releases/latest).
  Cross-platform smoke-testing and fixes are still very welcome (see
  [Good first areas](#good-first-areas)).
- **Node.js 18+** and npm.
- A **C/C++ toolchain** to build `better-sqlite3` for Electron (and, on Linux
  only, `node-pty` — it ships prebuilds for macOS/Windows but not Linux). On macOS:
  ```bash
  xcode-select --install
  ```
  On Windows/Linux, follow [`node-pty`'s own prerequisites](https://github.com/microsoft/node-pty#dependencies).
- **[Claude Code](https://claude.com/claude-code)** on your `PATH` if you want
  agents to actually run `claude` (the default command). Any other command works.

### Install & run

```bash
git clone <your-fork-url> munder-difflin
cd munder-difflin
npm install        # postinstall rebuilds better-sqlite3 against Electron's ABI
npm run dev        # live-reloading Electron build
```

> [!IMPORTANT]
> **The most common setup failure is a native-module rebuild.** The
> `postinstall` script runs `electron-rebuild --only better-sqlite3` so it
> matches Electron's ABI (`node-pty` is Node-API and runs from its shipped
> prebuilds — on Linux npm compiles it from source at install). If you see a
> "wrong ELF/Mach-O" or "NODE_MODULE_VERSION" error at launch, re-run
> `npm install` (which re-triggers `postinstall`) after confirming your
> C/C++ toolchain is installed.

## Evidence is mandatory

**Every pull request must show a before and an after.** Screenshots, or a screen
recording when the thing moves. They go in the PR description, under the
`### Before` and `### After` headings the template gives you.

This is enforced. The `PR evidence` check runs the moment you open a PR, and a
PR that fails it does not merge. Fix the description and the check re-runs on
save. It reads each heading separately, so two images dumped under one of them
will not pass — a reviewer has to be able to tell which is which.

**"My change has no UI" is not an exemption.** It changes the evidence, not the
requirement:

| Kind of change | What before/after looks like |
|---|---|
| Visual | The same view, twice. Same window size, same theme, same data. |
| Bug fix | The bug happening, then the same steps not producing it. |
| Terminal / CLI | A recording of the session, or the output pasted as text. |
| Performance | The measurement before and the measurement after, same machine. |
| Crash / hang | The failure, then the same path completing. |
| Test-only | The suite red, then the suite green. |

Make the two shots comparable. Different window sizes, a light shot against a
dark one, or different data means the reviewer is diffing your screenshots
instead of your change.

The only way out is the `no-visual-change` label, which a maintainer applies
for things with genuinely nothing observable: a CI tweak, a typo, a dependency
bump. You cannot add it yourself, and asking for it on a change that does
something visible will cost you more time than the screenshot would have.

## Before you open a PR

1. **Attach the before and after.** See above. This is the one that gets PRs
   closed unread, so do it first, not last.
2. **Keep the type-checker green:** `npm run typecheck` (runs both the node and
   web TS projects).
3. **Run the tests:** `npm run test:focused`. If you changed behaviour, add a
   test for it — a bug fix with no test is a bug fix that comes back.
4. **Confirm a production build works:** `npm run build`.
5. **Match the aesthetic.** Any new UI **must** derive from the design tokens in
   [`DESIGN.md`](./DESIGN.md) / `src/renderer/src/design/tokens.ts` — no ad-hoc
   colors, spacing, or fonts. `tokens.ts` and `tokens.css` are mirrored; if you
   change one, change both.
6. **Read your own diff.** Every line of it. Debug logging, commented-out code,
   and reformatting of files you didn't otherwise touch all get a PR sent back.

## What gets a PR closed

We are getting more pull requests than we can review carefully, so the bar has
gone up. These are closed rather than negotiated:

- **No before/after evidence**, and no `no-visual-change` label.
- **More than one change in one PR.** A fix plus a refactor plus a rename is
  three PRs. Split it and every one of them merges faster.
- **Wholesale reformatting** of files, or a diff where the real change is buried
  in whitespace and import reordering.
- **A rewrite nobody asked for.** Large architectural changes need an issue or a
  [discussion](https://github.com/chaitanyagiri/munder-difflin/discussions) with
  agreement **before** you write the code. We would rather say no to a paragraph
  than to a week of your work.
- **Generated or unattributed content** — art that isn't yours or compatibly
  licensed, or a description that doesn't match what the diff does.
- **Dependency additions** that aren't justified in the description. A new
  runtime dependency needs a reason a one-file helper wouldn't have solved.
- **No response for 14 days** on review feedback. Reopen whenever you're ready;
  nothing is lost.

None of this is aimed at first-timers. A small, focused, well-evidenced PR from
someone who has never contributed before gets reviewed ahead of a big one from
someone who has.

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
- Cross-platform smoke-testing — Windows and Linux builds ship, but real-world
  coverage (WSL2, various distros, uncommon shells) is thin.

## Commit & PR conventions

- Branch off `main`. One change per PR — see
  [What gets a PR closed](#what-gets-a-pr-closed).
- Write a clear description of *what* changed and *why*. We can read the diff;
  we cannot read your reasoning.
- Say how you tested it, and on which OS. "Tested locally" tells us nothing.
- Link the issue you're fixing: `Closes #123`.
- Don't commit `node_modules/`, `out/`, or built artifacts (already gitignored).
- Don't force-push after a review has started. It throws away the comparison the
  reviewer was working from.
- **Never put credentials, tokens, internal metrics, or customer data in a
  commit message.** A pushed commit message is public and permanent, and no
  later rewrite retracts it once it has been fetched.

## A note on assets

The bundled tilesets are LimeZu's *Modern Interiors*, used under the **Complete
Version licence**. See [`ATTRIBUTION.md`](./src/renderer/src/assets/ATTRIBUTION.md).
That licence requires credit to LimeZu, so don't remove the acknowledgement from
the README, the app, or the website. The Office cast is drawn procedurally in
`portraitArt.ts` and carries no third-party licence.
If you contribute new art, it must be either your own work or compatibly
licensed, and you must add it to `ATTRIBUTION.md`. Don't add unlicensed assets.

## Questions

Open a [discussion or issue](../../issues) — happy to help you get oriented.

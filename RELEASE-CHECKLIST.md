# Release checklist: verifying the updater

The auto-updater ships across a version hop, so **the code in a release is only
exercised by the NEXT release**. A build's own updater is proven by whether the
build after it lands, not by the build itself. This checklist is how a release
runner confirms it, because the paths that matter most are the ones a clean,
successful release never touches.

## Before the tag: mechanical gates (run these first)

- [ ] **`npm run check:links` passes.** Every download link in `RELEASE.md` and every advertised
  version in `docs/index.html` / `docs/llms.txt` must match `package.json`. electron-builder bakes
  the version into each artifact name, so a version left behind here turns the release page's
  download buttons into 404s the moment the tag ships. This is also enforced in CI on `release/**`,
  but run it locally before you tag. After publishing, `npm run check:links -- --live` HEADs every
  URL and requires 200.
- [ ] **`package.json` version is the real release version** (not an `-rc` string), and `RELEASE.md`,
  `build/release-notes.md` and `CHANGELOG.md` all name that same version.

## The proving hop (rehearse on prereleases, before the real release)

`0.4.6` is delivered by `0.4.5`'s updater, so `0.4.6` arriving proves the OLD
code worked. Only a hop that STARTS on our new code proves it. So rehearse on
prereleases first: publish `0.4.6-rc.1`, then a no-op `0.4.7-rc.1`, and drive
the hop `0.4.6-rc.1` -> `0.4.7-rc.1` on a test machine BEFORE the real `0.4.6`
exists. Same evidence, earlier, with any failure landing on a throwaway.

Why it is safe: a `-rc.1` tag publishes as a GitHub pre-release (release.yml,
`prerelease: contains(ref_name, '-')`), and electron-updater only offers a
pre-release to a client whose OWN version is a pre-release (allowPrerelease
defaults to that, verified in 6.8.9). So a stable `0.4.5` client sees neither
rc, on the native path or the notify-only fallback. Only a machine already on
`0.4.6-rc.1` sees `0.4.7-rc.1`.

Two things to hold: a tester must MANUALLY install `0.4.6-rc.1` first (a `0.4.5`
machine sees nothing, which is the point); and a machine left on `0.4.7-rc.1`
stays AHEAD of the real `0.4.6` (`0.4.7-rc.1 > 0.4.6` and we do not allow
downgrade), so reset rehearsal machines by reinstalling manually afterward. A
`0.4.6-rc.1` machine that does nothing self-heals to the real `0.4.6` when it
ships, because a release outranks its own pre-release.

If the rehearsal passes, the real `0.4.6` is that SAME tree with only
`package.json`'s version bumped from `0.4.6-rc.1` to `0.4.6` (the build reads
the version from package.json, not the tag), nothing else. Any CODE change
between the rehearsal and the release means re-rehearse.

**Release gate (hard): each rc (and the real release) must be a COMPLETE signed,
notarized, stapled run of the real pipeline, not a `git tag` and not a version bump.** macOS updates
through Squirrel.Mac, which needs `mac-universal.zip` + its `.blockmap` +
`latest-mac.yml` (whose `path:` must point at the zip, not the dmg). A release
missing those silently falls back to manual and proves nothing.

## What a clean 0.4.7 proves on its own (the happy path)

Install `0.4.6-rc.1`, publish a complete `0.4.7-rc.1`, then watch that client:

- [ ] the badge moves check -> available -> downloading -> downloaded on its own
- [ ] at `downloaded` the badge's primary action is **restart**, not a manual download
- [ ] clicking it quits, installs `0.4.7-rc.1`, and relaunches into the new version
- [ ] after relaunch the badge shows the "just updated" state

## What a clean release CANNOT reach (inject these by hand)

These only run when a user is already in trouble, so a healthy release never
exercises them. A skipped check here means they ship unwitnessed.

- [ ] **Timeout, fallback, and the error-state link (guards `updater.ts` + #325).**
  Cut the network, then trigger a check. Within ~30s the badge must reach an
  **error** state, never a permanent `checking` spinner, and offer a working
  download link (releases page). Restore the network; the next check recovers.
- [ ] **Restart re-entry (#324).** With an update staged at `downloaded`, click
  restart twice in quick succession. It must NOT wedge with "The command is
  disabled and cannot be executed"; a refused or failed quit reports back and
  the button recovers rather than spinning.
- [ ] **Success is visible (#326).** On the latest version, click the badge. It
  must show a positive "you are on the latest version" acknowledgement, not
  settle silently to a grey chip. (This one needs no real update: verify it on
  any build.)

## Tested vs rc-only (keep this split in every report)

- **Verified without a release** (unit tests, typecheck, and dev `update:simulate`):
  badge state-rendering and click-wiring for every state, and the no-update
  acknowledgement.
- **Only a real signed release can exercise**: `downloadUpdate`, `quitAndInstall`,
  and the Squirrel install itself. Do not let this half borrow the tested half's
  confidence: report which is which.

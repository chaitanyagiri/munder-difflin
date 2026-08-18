# The Precinct v0.1.0

The first public prerelease of **The Precinct**, a local-first multi-agent desktop command center
with an original pixel-art precinct environment.

## Highlights

- Original precinct floor with a bullpen, captain's office, Terry operations area, break room,
  elevator entrance, briefing room, interrogation room, and evidence area.
- Nine configurable character presets: Raymond Holt, Terry Jeffords, Jake Peralta, Amy Santiago,
  Rosa Diaz, Charles Boyle, Gina Linetti, Hitchcock, and Scully.
- Holt as primary coordinator with optional advisory reporting through Terry.
- OpenCode and multi-provider compatibility, real PTYs, agent mail, memory, tasks, movement,
  worktrees, and existing human approval boundaries.

## macOS

Download [`The-Precinct-0.1.0-mac-universal.dmg`](https://github.com/SparshSunilNaik/the-precinct/releases/download/v0.1.0/The-Precinct-0.1.0-mac-universal.dmg).

This initial build is unsigned and not notarized. macOS may report that Apple cannot check it for
malicious software. Move **The Precinct** to Applications, then Control-click the app, choose
**Open**, and confirm **Open**. Do not disable Gatekeeper globally.

## Attribution

The Precinct is derived from [Munder Difflin](https://github.com/chaitanyagiri/munder-difflin),
created by Chaitanya Giri. The upstream MIT copyright and license are retained, along with all
required third-party notices.

This is an unofficial fan-inspired project. It is not affiliated with or endorsed by
*Brooklyn Nine-Nine*, NBC, Universal Television, or related rights holders.

## Known limitations

- This is an early prerelease and has not been notarized by Apple.
- Legacy LimeZu assets remain bundled for the compatibility office theme and are non-commercial.
- Provider CLIs must be installed and authenticated separately.
- See [`SECURITY-AUDIT.md`](./SECURITY-AUDIT.md) for dependency audit scope and residual risks.

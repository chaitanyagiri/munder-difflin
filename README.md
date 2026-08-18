# The Precinct

The Precinct is a local-first desktop command center for running a coordinated team of coding
agents. It wraps terminal agent CLIs in real PTYs, gives each agent a role, mailbox, memory, and
optional git worktree, and shows the team working on a shared pixel-art precinct floor.

The app is derived from [Munder Difflin](https://github.com/chaitanyagiri/munder-difflin) by
[Chaitanya Giri](https://github.com/chaitanyagiri). It retains the upstream MIT notices and
third-party asset terms. See [Attribution and non-affiliation](#attribution-and-non-affiliation)
and [`NOTICE.md`](./NOTICE.md).

This fork adds substantial original work: The Precinct identity and application surfaces, an
original procedural precinct environment, nine configurable character presets, advisory
coordinator hierarchy metadata, precinct-specific tests, and release packaging. These changes do
not alter or obscure the authorship of the original Munder Difflin codebase.

> [!IMPORTANT]
> The Precinct is an unofficial, fan-inspired project. It is not affiliated with, endorsed by,
> or sponsored by *Brooklyn Nine-Nine*, NBC, Universal Television, or any of their owners,
> producers, distributors, or other rights holders. All referenced names and marks belong to
> their respective owners.

## Features

- Real terminal sessions powered by `node-pty` and rendered with xterm.js.
- Claude Code, OpenAI Codex, OpenCode, Antigravity, Grok, Kimi Code, Qwen, Crush, pi.dev,
  GitHub Copilot CLI, custom commands, bring-your-own keys, and local model endpoints.
- A local hive with per-agent mailboxes, long-term markdown memory, shared context, task state,
  and an append-only activity log.
- A nine-role operating hierarchy for delegation, review, and escalation.
- Optional per-agent git worktrees for parallel changes without branch collisions.
- A Pixi.js precinct floor with live agent state and message movement.
- Human approval gates, budgets, usage telemetry, circuit breakers, and graceful shutdown.
- Tasks, schedules, skills, files, diffs, terminals, and agent status in one command center.
- Optional Slack, webhook, voice, and local/open-model integrations.

## Nine-role hierarchy

The hierarchy is an operating model, not a permission bypass. Every role remains subject to the
same human approval gates, filesystem boundaries, budget controls, and provider permissions.

| Level | Preset | Responsibility |
| --- | --- | --- |
| 1 | Raymond Holt | Primary/global coordinator; owns priorities, delegation, and final escalation. |
| 2 | Terry Jeffords | Secondary coordinator and operations manager; decomposes larger work and coordinates detectives. |
| 3 | Jake Peralta | Implementation and creative problem solving. |
| 4 | Amy Santiago | Planning, architecture, and organization. |
| 5 | Rosa Diaz | Debugging, security, and adversarial review. |
| 6 | Charles Boyle | Research, integrations, and documentation. |
| 7 | Gina Linetti | UX/product critique and unconventional ideas. |
| 8 | Hitchcock | Low-cost and background work. |
| 9 | Scully | Low-cost and background work. |

The Captain is the primary point of contact. Work moves down to the smallest suitable scope;
results, blockers, and approval requests move back up. Roles can use different providers in the
same team, so the hierarchy describes responsibility rather than a specific model vendor.

## How it works

```text
you
 |
 v
Raymond Holt -> Terry Jeffords -> detectives and specialists
       |                              |
       +------------------------------+
                       |
             hive: mail, memory, tasks, log
```

1. The Electron main process starts each configured CLI as a real local process in a PTY.
2. The preload bridge exposes a typed, constrained IPC API to the React renderer.
3. Agents coordinate through the local hive rather than writing directly to each other's state.
4. The router delivers mailbox messages and wakes agents when work arrives.
5. The hierarchy assigns ownership and review paths; the human retains approval authority.
6. The precinct floor visualizes sessions, status, and communication without replacing the
   underlying terminal interfaces.

Detailed internals are documented in [`HIVE.md`](./HIVE.md), [`SPEC.md`](./SPEC.md), and
[`DESIGN.md`](./DESIGN.md).

## Setup

### Prerequisites

- macOS, Windows, or Linux.
- Node.js 20.19 or newer (or Node.js 22.12 or newer) and npm.
- Git and a C/C++ toolchain for the native `node-pty` dependency.
- At least one supported agent CLI installed and authenticated.

On macOS, install the compiler toolchain with:

```bash
xcode-select --install
```

Install and start the app:

```bash
git clone https://github.com/SparshSunilNaik/the-precinct.git the-precinct
cd the-precinct
npm install
npm run dev
```

`npm install` rebuilds native dependencies for Electron. Run it again after changing Electron or
Node versions if `node-pty` reports an ABI or native-module error.

### macOS prerelease installation

The initial `v0.1.0` DMG is unsigned and not notarized. Drag **The Precinct** into Applications.
If macOS blocks the first launch, Control-click **The Precinct**, choose **Open**, then confirm
**Open**. This approves only this application; do not disable Gatekeeper globally.

## OpenCode and providers

The Precinct drives provider CLIs you install; it does not replace their authentication or
subscriptions. Authenticate each CLI normally before assigning it to an agent.

For OpenCode:

1. Install OpenCode using its official instructions and confirm `opencode` is on `PATH`.
2. Configure the provider credentials or local model endpoint in OpenCode.
3. Run `opencode` once in a terminal to verify authentication.
4. In The Precinct, add an agent and select **OpenCode**, or use `opencode` as a custom command.

Other built-in commands include `claude`, `agy`, `codex`, `grok`, `kimi`, `qwen`, `crush`, `pi`,
and `copilot`. API keys can be entered through the app's write-only secret broker. Ollama, LM
Studio, and vLLM can be configured as local endpoints. Availability, billing, context limits, and
data handling remain governed by the provider you choose.

## Architecture

```text
Electron renderer (React, Pixi.js, xterm.js)
                 |
      typed contextBridge IPC
                 |
Electron main process
  |-- PTY and process lifecycle
  |-- sandboxed filesystem and git operations
  |-- hive router, memory, tasks, and hooks
  |-- telemetry, budgets, and safety controls
                 |
Agent CLIs and local project worktrees
```

The main process owns privileged operations. The renderer has no direct Node.js access. Agent
sessions remain ordinary provider CLI processes, and optional worktrees isolate concurrent edits.

## Verification

Before submitting a change, run:

```bash
npm run typecheck
npm run test:focused
npm run build
```

For packaging metadata, also validate the current configuration:

```bash
node -e "JSON.parse(require('fs').readFileSync('package.json', 'utf8')); JSON.parse(require('fs').readFileSync('package-lock.json', 'utf8'))"
npx electron-builder --dir --config electron-builder.yml
```

The packaging command creates local output and may require platform-specific native tooling. It
does not publish a release.

## Compatibility identifiers

The user-facing product name is **The Precinct**. The existing `in.munderdiffl.app` application ID
and `munderdifflin://` deep-link scheme are intentionally retained so installed copies and shared
hire links continue to work. Artifact names and updater metadata use this fork's repository; no
upstream release channel or website is represented as a The Precinct service.

## Telemetry and security

Anonymous product analytics are narrowly allowlisted and can be disabled in Settings or with
`DO_NOT_TRACK`. Source and fork builds without a PostHog key send no analytics. Full details are in
[`TELEMETRY.md`](./TELEMETRY.md). Report vulnerabilities as described in
[`SECURITY.md`](./SECURITY.md).
The dependency review for the initial release is recorded in
[`SECURITY-AUDIT.md`](./SECURITY-AUDIT.md).

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Keep changes focused, preserve compatibility unless a
migration is provided, and record the source and license of every new visual asset.

## License

The source code is available under the [MIT License](./LICENSE), including the original copyright
and permission notice from Chaitanya Giri. The MIT grant does not cover the bundled LimeZu visual
assets. Those files are under the LimeZu FREE VERSION license and are limited to non-commercial
use; see [`src/renderer/src/assets/ATTRIBUTION.md`](./src/renderer/src/assets/ATTRIBUTION.md).

## Attribution and non-affiliation

- **Upstream:** The Precinct is a derivative of
  [Munder Difflin](https://github.com/chaitanyagiri/munder-difflin), created by Chaitanya Giri.
  Upstream authorship and MIT notices are retained.
- **Visual assets:** Bundled LimeZu tilesets and character sheets remain subject to LimeZu's
  non-commercial FREE VERSION license. Portions of the floor renderer and maps were adapted from
  [`shahar061/the-office`](https://github.com/shahar061/the-office), whose project code is ISC.
- **Fan inspiration:** The Precinct is unofficial and fan-inspired. It is not affiliated with,
  endorsed by, or sponsored by *Brooklyn Nine-Nine*, NBC, Universal Television, or any rights
  holder. Character, program, company, and trademark references belong to their respective owners.

See [`NOTICE.md`](./NOTICE.md) for the consolidated notices and the asset attribution file for the
file-level visual audit.

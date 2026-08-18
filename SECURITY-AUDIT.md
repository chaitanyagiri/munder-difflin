# Dependency Security Audit

Audit date: 2026-08-19

## Scope

The release audit covers the root Electron application dependency tree. The `blog/` and
`landing-remotion/` directories are separate publishing tools and are not included in the packaged
desktop application. They must not be run against untrusted input without their own dependency
updates.

## Initial findings

`npm audit` initially reported 29 findings: 1 critical, 24 high, and 4 moderate. Nine were marked
as production dependencies, although npm classifies Electron itself as development-only even
though Electron is the runtime shipped in the application.

- The critical `tar` and several high findings came from Electron rebuild and packaging tools.
- Electron 32 carried multiple Chromium/Electron security advisories relevant to the shipped app.
- The unused `localtunnel` dependency introduced an obsolete Axios 0.x production chain.
- The active optional Tunnelmole integration introduced Axios and related networking advisories.
- OpenAI realtime dependencies included optional MCP/Hono server packages; the application uses
  the browser/WebRTC realtime path, so those server paths are not known to be reachable here.
- `electron-updater` included a YAML parser denial-of-service advisory. Update metadata is fetched
  from this fork's GitHub release channel rather than from arbitrary user input.

## Remediation

- Removed unused `localtunnel` and its type package.
- Updated Electron, Electron Builder, Electron Rebuild, Electron Vite, Vite, and related build
  dependencies to patched current releases.
- Refreshed the lockfile so compatible patched transitive packages are selected.
- Re-ran typechecking, tests, production compilation, packaging, and packaged-app smoke testing.

After remediation, both `npm audit` and `npm audit --omit=dev` report **0 known vulnerabilities**.

## Operational guidance

- Public webhook/tunnel features are optional. Treat their shared secret as a credential and do
  not expose a tunnel unless remote access is required.
- Provider CLIs and model endpoints have their own security and data-handling policies.
- The app has privileged local capabilities by design; only open trusted projects and install
  trusted agent CLIs and skills.
- Review `npm audit` before each release and test Electron major upgrades with native modules and
  packaged builds rather than using `npm audit fix --force`.

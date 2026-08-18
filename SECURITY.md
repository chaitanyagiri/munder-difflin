# Security Policy

## Scope

The Precinct is a **local-first desktop app**. It spawns local processes in PTYs and
reads/writes files under directories you register. Provider CLIs and enabled integrations may
make network requests. Local hook and telemetry services are bound for app communication;
optional Slack, webhook, tunnel, voice, analytics, and update features add the network surfaces
described in their settings and documentation. Treat an enabled public webhook or tunnel as a
remote surface and protect its secret.

## Supported versions

This is an early prototype. Security fixes target the `main` branch only.

| Version | Supported |
|---|---|
| `main` | ✅ |
| older tags | ❌ |

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

- Use GitHub's **private vulnerability reporting** for this fork: the *Security -> Report a
  vulnerability* tab at https://github.com/SparshSunilNaik/munder-difflin.
- If private reporting is unavailable, contact a current maintainer privately with a
  description, reproduction steps, and impact.

You can expect an acknowledgement within a few days. Once a fix is available we'll
credit you (unless you prefer to stay anonymous).

## Notes for reviewers

- Renderer ↔ main IPC goes through a typed `contextBridge` (`window.cth`); the renderer
  has no direct Node access (`nodeIntegration: false`, `contextIsolation: true`).
- All `fs:*` / `git:*` IPC calls are sandboxed and path-validated in the main process,
  rooted at an agent's working directory.
- The hive commits to a local git repo from a **single committer** (the main process);
  agents only write plain files.

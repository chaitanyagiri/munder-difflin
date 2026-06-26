# Per-agent environment metadata

A documented, non-sensitive way for the **orchestrator** to query each hive
agent's working directory and basic terminal/session details — and a spawn-time
guard so a bad working directory can't silently slip through.

## The problem

The roster surfaces tokens / cost / breaker / status, but not a *reliable*,
validated view of **where** each agent runs. Respawning a worker next to a peer
needs a known-good **absolute** cwd; a non-absolute fragment like
`"ClaudeTerminalHarness"` spawns into a nonexistent directory and the spawn
fails. The data existed in `registry.json`/`fleet.json` but nothing validated it
or exposed it cleanly.

## Two parts

### 1. Spawn-time instrumentation — `cwdValid` (`src/main/hive.ts`)

`ensureAgent()` now validates `meta.cwd` at registration (absolute **and** exists
as a directory) and persists the result as **`cwdValid`** on the registry entry,
so the roster reliably exposes each worker's environment validity. When a cwd is
invalid it appends a single `cwd_invalid` activity-log event (only on the rare bad
case — no per-spawn line, so no log spam). The check is best-effort and never
throws; spawn behaviour is unchanged.

### 2. Query helper — `tools/agent-env.cjs`

A dependency-free Node CLI that reads the canonical hive state and emits a clean,
non-sensitive record per agent:

```sh
node tools/agent-env.cjs                 # table of live (non-archived) agents
node tools/agent-env.cjs --all           # include archived agents
node tools/agent-env.cjs <agent-id>      # one agent, pretty JSON
node tools/agent-env.cjs --json [--all]  # JSON array to stdout
node tools/agent-env.cjs --snapshot      # also write <hive>/shared/agent-env.json
node tools/agent-env.cjs --hive <dir>    # override the hive root
```

Locates the hive via `$HIVE_ROOT` (or `--hive`). Prefers the harness-persisted
`cwdValid`; falls back to a live path check for older registries. Exit code `2`
for an unknown agent / no hive; never throws on a corrupt registry/fleet.

**Fields:** `cwd`, `cwdValid`, `cwdIssue` (`not-absolute` / `missing-dir` / …),
`provider` (the CLI/terminal engine), `sessionId` (non-secret `claude --resume`
key), `status`, `archived`, `lastSeen`, plus live telemetry (`breaker`,
`lastTool`, `lastActiveSecAgo`, `inboxBacklog`).

**Respawn recipe** — copy a peer's *valid* cwd into a new spawn:

```sh
node tools/agent-env.cjs <peer-id> | grep cwd   # -> the known-good directory
```

## Where it's stored

Reads `registry.json` + `fleet.json` (already on disk, no new hot-path writes).
`--snapshot` writes a static, regenerable artifact at `<hive>/shared/agent-env.json`
the orchestrator can read directly.

## Security

Reads **only** `registry.json` + `fleet.json`; touches no secret store, process
env, or key material, and never prints file contents / credentials / API keys.
Output is directory paths + non-secret session metadata. `sessionId` is a resume
UUID, not a credential.

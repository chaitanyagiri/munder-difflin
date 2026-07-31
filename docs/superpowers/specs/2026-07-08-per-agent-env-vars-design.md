# Per-agent environment variables (Claude Code profiles) — design

**Issue:** [#105 — Support Claude Code Profiles](https://github.com/chaitanyagiri/munder-difflin/issues/105)
**Date:** 2026-07-08
**Status:** approved

## Problem

Users who run separate Claude Code accounts (e.g. work vs personal via
`CLAUDE_CONFIG_DIR=~/.claude-personal claude`) cannot make MD spawn an agent
with that profile:

- Shell aliases (`claude-personal`) aren't visible — `resolveCommand` runs
  `which <cmd>`, which for a zsh alias prints the alias definition, not a path,
  so resolution falls through to ENOENT.
- Env-prefix syntax in the command field (`CLAUDE_CONFIG_DIR=… claude`) fails —
  the command is tokenized into `[exe, ...args]` and exec'd directly by
  node-pty with no shell, so it tries to exec a binary literally named
  `CLAUDE_CONFIG_DIR=…`.

## Decision summary

| Question | Decision |
| --- | --- |
| Feature shape | Per-agent env vars (KEY=VALUE), not shell/alias support, not named profiles |
| Coverage | Per-agent rows in Add Agent **plus** a global `defaultAgentEnv` in Settings inherited by every spawn (including Michael/GOD); per-agent overrides global |
| `CLAUDE_CONFIG_DIR` knock-ons | In scope: telemetry/transcripts, resume seeding, and permissions-acceptance follow the override |
| Hire manifests (untrusted) | May **not** carry env; env is human-entered only |

Named profiles (Approach 2) were considered and deferred — the global default +
per-agent override covers the realistic use case; profiles can be layered on
later without rework. Shell wrapping (Approach 3) was rejected: rc noise,
broken provider inference from the binary name, no Windows equivalent.

## Data model & spawn flow

New fields (all optional, `Record<string, string>`):

- `SpawnPtyOptions.env` — `src/preload/index.ts`. Main's `SpawnOptions` already
  has `env`; this exposes it through the typed bridge.
- `Agent.env` — renderer store, included in the persisted "slim" localStorage
  fields so restore-team respawns carry it.
- `AgentMeta.env` — `src/main/hive.ts`, persisted on the registry record so
  restart-and-continue / god-triggered respawns and roster views agree.
  `registry.json` stores values verbatim (local file, same trust level as
  `config.json`); values whose key matches `*KEY*` / `*TOKEN*` / `*SECRET*`
  are masked in derived surfaces — `fleet.json`, roster IPC, and
  `tools/agent-env.cjs` output, which is documented as non-sensitive.
- `HarnessConfig.defaultAgentEnv` — `src/main/config.ts`, edited from Settings.

Merge order in `spawnAgentCore` (last write wins):

```
process.env + userShellPath      (existing base, pty.ts)
→ defaultAgentEnv                (global, Settings)
→ opts.env                       (per-agent, Add Agent)
→ internal injections            (hive identity, memory/kg, BYOK, broker,
                                  non-interactive flags)
```

User env can never clobber `AGENT_ID`, `HIVE_ROOT`, broker tokens, or BYOK
keys — internal plumbing always wins.

## Validation (main-process boundary)

Applies to both `defaultAgentEnv` and `opts.env` in `spawnAgentCore`:

- Keys must match `/^[A-Za-z_][A-Za-z0-9_]*$/`.
- Denylist: `PATH`, `NODE_OPTIONS`, `ELECTRON_RUN_AS_NODE`, and any key
  starting with `DYLD_`, `LD_`, `AGENT_`, `HIVE_`, `CTH_`.
- A rejected key **fails the spawn** with a specific error (surfaced in the
  Add Agent modal) — never a silent drop.
- A leading `~/` in a user-supplied env *value* is expanded to the home
  directory (no shell in the spawn path, so `~` would reach the child
  literally).

## UI

- **Add Agent modal** (`AddAgentModal.tsx`): an "env vars" disclosure in the
  workspace/engine fields opens a compact KEY/VALUE row editor (add/remove
  rows), built from existing pixel primitives + DESIGN.md tokens. Inline
  validation mirrors the main-process rules; main remains the enforcing
  boundary. Hint text shows the headline case:
  `CLAUDE_CONFIG_DIR=~/.claude-personal`.
- **Settings modal**: an "Agent environment" group with the same row editor
  bound to `defaultAgentEnv`, noting changes apply to newly spawned agents
  only (live terminals keep their env; Michael picks it up on next restart).
- **Hire import**: the manifest schema does not gain an env field. An `env`
  key in imported JSON is ignored; the import banner notes "env not
  importable — set it in the form" only when one was present.
- No new roster/detail display surfaces in v1; `tools/agent-env.cjs` remains
  the orchestrator-facing query path.

## Shared helper module

`src/shared/agentEnv.ts` — dependency-free (main + renderer + tests):

- key validation + denylist
- merge precedence
- tilde expansion
- `claudeConfigDirFrom(env)` → tilde-expanded `CLAUDE_CONFIG_DIR` value, or
  `~/.claude` when unset

## `CLAUDE_CONFIG_DIR` follow-through

- `transcript.ts` (telemetry reads, `seedSessionTranscript`,
  `resolveSessionCwd`): replace the single hardcoded `~/.claude/projects` root
  with a deduped set of candidate roots — default `~/.claude` plus any
  `CLAUDE_CONFIG_DIR` found in `defaultAgentEnv` or registry agents' env.
  Existing behavior is the degenerate (single-root) case.
- `ensureClaudePermissionsAccepted` (`config.ts`): takes the effective config
  dir for the agent being spawned and targets that dir's `.claude.json`
  instead of the home-dir default.
- A `CLAUDE_CONFIG_DIR` pointing at a not-yet-existing directory is fine —
  Claude Code creates it (fresh-profile flow).

## Error handling

- Malformed/denylisted key → spawn fails with a clear error in the modal.
- Env vars are plain data end-to-end; no shell interpretation anywhere.

## Testing

- `test/agent-env.test.cjs` in the existing framework-free style
  (transpile `src/shared/agentEnv.ts` in-process): validation, denylist, merge
  precedence, tilde expansion, config-dir resolution.
- `npm run typecheck` stays green (the CI gate).
- Manual verification: spawn a worker with
  `CLAUDE_CONFIG_DIR=~/.claude-personal`, confirm the session runs the
  personal account and telemetry still reports tokens.

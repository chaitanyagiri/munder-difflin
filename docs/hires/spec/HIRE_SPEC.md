# Hire manifest spec — `munder-difflin/hire@1`

A **hire manifest** is a small JSON document describing a role-configured agent for the
[Munder Difflin](https://github.com/chaitanyagiri/munder-difflin) multi-agent harness:
its name, sprite, provider, model, command flags, goal, capability tags, and token budget.
Because it's just JSON, a role can be shared as a file, hosted in a community gallery,
and imported into anyone's office with one click.

## Example

```json
{
  "spec": "munder-difflin/hire@1",
  "name": "Pam",
  "description": "Documentation writer",
  "goal": "Keep the project's docs accurate. When a feature merges, update README and docs/, and flag stale pages to the orchestrator.",
  "character": "pam",
  "accent": "mint",
  "provider": "claude",
  "model": "claude-sonnet-4-6",
  "commandFlags": ["--max-turns", "80"],
  "capabilities": ["docs", "writing", "markdown"],
  "skills": ["md-audit"],
  "mcpServers": ["fetch"],
  "isolate": false,
  "tokenCap": 2000000,
  "author": "Jason Choplin",
  "homepage": "https://example.dev/hires/pam-docs"
}
```

Validate against [`hire.schema.json`](./hire.schema.json). The canonical runtime validator
lives in the app at `src/shared/hire.ts` (this schema mirrors it).

## How it reaches the app

Two transports, same pipeline (validate → pre-fill the Add-Agent modal → human reviews → human clicks spawn):

1. **Deep link** — `munderdifflin://hire?src=<https-url-of-manifest>`. A gallery site's
   "Hire" button fires this; the app fetches the manifest (https only — plain http allowed for localhost galleries during development — 10s timeout, 64 KB cap),
   validates it, and opens the pre-filled Add-Agent modal.
2. **File import** — the "import hire…" button in the Add-Agent modal opens a `.json` picker.

## Security model

A manifest is untrusted input. The format is designed so it **cannot**:

- **Auto-spawn an agent.** Import only pre-fills the form. A human reviews every field —
  the modal shows an "imported" banner — and clicks spawn.
- **Name an executable.** There is no `command` field. The spawn binary always comes from the
  user's locally configured provider preset (`claude`, `agy`, `codex`, `cursor`). `provider: "custom"`
  is rejected.
- **Select arbitrary CLI behavior.** `commandFlags` is default-deny. Only `--model`,
  `--max-turns`, `--output-format`, and `--verbose` are accepted, either as
  `--flag value` or `--flag=value`. A bare value may only immediately follow an allowed
  split-form flag. Every token must also match the conservative character set
  `^[A-Za-z0-9._/=:,@+-]{1,100}$`; quotes, whitespace, percent expansion, and shell
  metacharacters are rejected. Args are passed to node-pty as argv, never through a shell.
- **Name arbitrary skills or MCP processes.** `skills` and `mcpServers` contain ids from
  the app's bundled allowlists, never paths, package names, commands, environment variables,
  or raw MCP specs. MCP entries that need write access or secrets require explicit consent
  during import and are never auto-enabled.
- **Be oversized or off-origin.** 64 KB cap, https-only fetch, every string field length-capped.

The safe flags still influence model selection, turn limits, output shape, or verbosity, and
`goal` is prompt text the agent will act on. Review them before spawning. Permission, sandbox,
approval, provider/backend, configuration, MCP, and prompt-injection flags are intentionally
not shareable; add an exceptional flag by hand after import if you trust and need it.

## Field reference

| Field | Type | Req | Notes |
|---|---|---|---|
| `spec` | `"munder-difflin/hire@1"` | ✅ | exact string |
| `name` | string ≤ 40 | ✅ | display name + hive id seed |
| `description` | string ≤ 200 | | one-line role |
| `goal` | string ≤ 4000 | | standing mission text |
| `character` | string ≤ 24 | | office cast id; unknown → default sprite |
| `accent` | string ≤ 24 | | color name; unknown → default |
| `provider` | `claude` \| `antigravity` \| `agy` \| `codex` \| `cursor` | | `agy` = alias for `antigravity`; omit = user default |
| `model` | string ≤ 80 | | provider model id/label |
| `commandFlags` | string[] ≤ 16 | | allowlisted safe flags and their immediately following values |
| `capabilities` | string[] ≤ 12 | | hive routing tags |
| `isolate` | boolean | | spawn in own git worktree |
| `tokenCap` | int 1…1e10 | | per-agent token budget |
| `author` | string ≤ 80 | | attribution |
| `homepage` | string ≤ 300 | | https only |
| `skills` | bundled skill id[] ≤ 8 | | built-in safe skills only; no paths or arbitrary ids |
| `mcpServers` | MCP catalog id[] ≤ 8 | | built-in catalog only; write/secret tiers require consent |

## Conventions

- File names: `<slug>.hire.json` (e.g. `pam-docs.hire.json`).
- Serve manifests with `content-type: application/json` and permissive CORS if you want
  other galleries to embed them.
- Galleries should link `homepage` back to the manifest's own card page.

## Versioning

Breaking changes bump the tag (`munder-difflin/hire@2`). Consumers must reject unknown
spec tags. Adding new *optional* fields is allowed within v1; validators ignore unknown
fields at their discretion (the reference validator drops them, the JSON schema is strict).

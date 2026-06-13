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
  user's locally configured provider preset (`claude`, `agy`, `codex`). `provider: "custom"`
  is rejected.
- **Smuggle shell syntax.** `commandFlags` entries must match `^[A-Za-z0-9._/=:,@%+-]{1,100}$`
  (no quotes, whitespace, semicolons, pipes, backticks), the first entry must be flag-shaped
  (`-…`), and args are passed to node-pty as argv — never through a shell.
- **Be oversized or off-origin.** 64 KB cap, https-only fetch, every string field length-capped.

Things a manifest *can* legitimately influence that you should still eyeball before spawning:
flags like `--permission-mode` change how autonomously the agent runs, and `goal` is prompt
text the agent will act on. That's exactly why import never skips the review step.

## Field reference

| Field | Type | Req | Notes |
|---|---|---|---|
| `spec` | `"munder-difflin/hire@1"` | ✅ | exact string |
| `name` | string ≤ 40 | ✅ | display name + hive id seed |
| `description` | string ≤ 200 | | one-line role |
| `goal` | string ≤ 4000 | | standing mission text |
| `character` | string ≤ 24 | | office cast id; unknown → default sprite |
| `accent` | string ≤ 24 | | color name; unknown → default |
| `provider` | `claude` \| `antigravity` \| `agy` \| `codex` | | `agy` = alias for `antigravity`; omit = user default |
| `model` | string ≤ 80 | | provider model id/label |
| `commandFlags` | string[] ≤ 16 | | flag-shaped tokens appended to the locally-built command |
| `capabilities` | string[] ≤ 12 | | hive routing tags |
| `isolate` | boolean | | spawn in own git worktree |
| `tokenCap` | int 1…1e10 | | per-agent token budget |
| `author` | string ≤ 80 | | attribution |
| `homepage` | string ≤ 300 | | https only |

## Conventions

- File names: `<slug>.hire.json` (e.g. `pam-docs.hire.json`).
- Serve manifests with `content-type: application/json` and permissive CORS if you want
  other galleries to embed them.
- Galleries should link `homepage` back to the manifest's own card page.

## Versioning

Breaking changes bump the tag (`munder-difflin/hire@2`). Consumers must reject unknown
spec tags. Adding new *optional* fields is allowed within v1; validators ignore unknown
fields at their discretion (the reference validator drops them, the JSON schema is strict).

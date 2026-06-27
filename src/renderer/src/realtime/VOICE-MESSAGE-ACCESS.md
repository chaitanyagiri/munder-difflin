# Voice read-layer — hive activity & message content

How Realtime "Michael" (the voice agent in the renderer) reads recent hive
activity and message bodies to brief the operator, and the privacy boundary that
keeps it safe. Card: `enable-voice-agent-acces-cnzlfs`.

## The query path

The voice agent runs in the renderer; the hive data lives on disk under
`HIVE_ROOT/{log.jsonl, agents/<id>/inbox|outbox, registry.json, fleet.json}`.
Two read tools bridge the gap, each a thin wrapper over a main-process IPC
handler:

| Tool (renderer)   | IPC handler        | Source                                   | Returns |
|-------------------|--------------------|------------------------------------------|---------|
| `get_activity`    | `hive:log`         | `log.jsonl` (lifecycle events)           | event **metadata** — newest first |
| `get_messages`    | `hive:messages`    | `agents/<id>/inbox` + `outbox` (+ handled) | message **content** — redacted bodies |

`get_messages` modes: `{ id }` reads one message in full; `{ agentId }` scopes to
one mailbox; `{}` returns the latest across the floor. Both tools format their
result as short spoken prose (no markdown) — see `tools.ts`.

## Privacy / safety filtering

The OpenAI / BYOK key never crosses IPC — that boundary is unchanged here. For
message bodies, **all redaction is main-side** (`redactSecrets()` in
`src/main/hive.ts`): `voiceMessages()` runs every `subject` and `body` through it
before the result leaves the main process, so the renderer/voice layer never
receives a raw body and never a secret. The renderer holds **zero** redaction
policy.

`redactSecrets()` is deliberately conservative — it strips known credential
**shapes**, not high-entropy strings, so operator-meaningful content survives:

- Stripped → `[redacted]`: provider keys (`sk-`, `sk-ant-`), Slack (`xoxb/xoxp/…`,
  `xapp-`), GitHub (`ghp_/gho_/…`, `github_pat_`), AWS (`AKIA…`), Google (`AIza…`),
  JWTs, PEM private-key blocks, `Bearer <token>`, and sensitive
  `key=value` / `key: value` assignments (api_key, secret, token, password,
  client_secret, signing_secret, webhook_secret, bot_token, …).
- Preserved: git SHAs, agent ids, file paths, ordinary prose, token counts.

Over-redaction (e.g. a non-secret `apikey:openai` *reference*) is acceptable;
leaking a real secret is not. The exact battery is proven by
`test/voice-messages.test.cjs` (kept in lockstep with `hive.ts`).

## Sources that expose METADATA ONLY (and why)

- **`log.jsonl` (`get_activity`)** — lifecycle events only (`kind`, `agentId`,
  `ts`, actor). It never carries message bodies by design: it is high-frequency
  and append-only, so bodies belong on the dedicated, redacted `get_messages`
  path instead. This keeps the activity feed cheap and free of un-redacted text.
- **`registry.json` / `fleet.json`** (via `get_fleet_status` / `list_agents` /
  `get_agent_detail`) — agent metadata (status, cwd, tokens, breaker). No bodies.
- **`get_config`** — a hand-picked non-sensitive allowlist; never the raw config
  (which holds secrets).

## Limitations

- **Redaction is pattern-based, best-effort.** It catches known credential shapes
  and sensitive assignments. A secret pasted in an unusual, label-free,
  shape-free form (e.g. a bare random string with no prefix and no `key:`) is not
  guaranteed to be caught. It does not redact PII beyond credentials.
- **Message scope.** `get_messages` reads `inbox`/`outbox` and their handled
  subfolders (`inbox/.done`, `outbox/.sent`). Messages purged from disk are gone;
  there is no separate archive store.
- **Dedup.** A delivered message exists in both sender outbox and recipient
  inbox; results dedup by message id, so the `direction`/`owner`/`archived`
  fields reflect the first copy encountered during traversal.
- **Read-only.** This path only reads + briefs. It adds no write/mutate
  capability — voice writes still go through the separate, confirm-gated action
  spine (`realtimeActions.ts`), untouched by this card.
- **Not live-voice-verified.** Logic is unit-tested and type/build-green; an
  end-to-end voice check needs a real OpenAI Realtime key (human-gated, same as
  all realtime work).

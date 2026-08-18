# Telemetry

The Precinct can collect a small set of **anonymous** usage events so maintainers can
understand adoption (how many people launch the app, which features get used)
and make the product better. This document is the complete, authoritative
contract: **if an event or property is not listed here, the app does not send
it.** The implementation lives in [`src/main/analytics.ts`](src/main/analytics.ts)
and enforces this list as a hard allowlist — the code and this file are kept in
lockstep, and because the repo is open source you can verify that yourself.

## What is sent

Every event carries only these common properties:

| Property | Example | Notes |
| --- | --- | --- |
| `app_version` | `0.4.2` | The app's own version |
| `os` | `darwin` / `win32` / `linux` | Platform, nothing more |
| `arch` | `arm64` / `x64` | CPU architecture |

The events:

| Event | Extra properties | When |
| --- | --- | --- |
| `first_run` | — | Once, the first time the app ever starts |
| `app_launched` | — | Each app start |
| `agent_spawned` | `provider` (CLI engine name, e.g. `claude`, `codex`) | An agent terminal is spawned |
| `feature_used` | `feature` — one of `slack_trigger`, `webhook_trigger`, `hire_install`, `voice_dictation` | At most once per feature per app session |
| `session_ended` | `duration_bucket` — one of `<5m`, `5-30m`, `30m-2h`, `2-8h`, `8h+` | On quit (coarse bucket, never raw duration) |

## What is never sent

No prompts. No agent transcripts or output. No file paths, repo names, branch
names, or hostnames. No email addresses, account identifiers, machine
identifiers, or API keys. Nothing free-form — the property allowlist in
`analytics.ts` drops anything not in the tables above.

## How it stays anonymous

- Events are sent to [PostHog](https://posthog.com) (itself open source) with
  `$process_person_profile: false`, which makes them **anonymous events**: no
  person profile is created and no identity is stored.
- The only identifier is a **random UUID** minted on first run and stored in
  the app's user-data directory (`telemetry-install-id`). It is not derived
  from your machine, and deleting the app's data deletes it.
- IP-based geolocation is used only to derive a country for aggregate stats;
  PostHog does not retain the IP on the event.

## Opting out

Any one of these fully disables telemetry:

1. **Settings → General → Anonymous usage stats → off** (or uncheck "Share
   anonymous usage stats" during onboarding). Takes effect immediately.
2. Set the standard [`DO_NOT_TRACK`](https://consoledonottrack.com)
   environment variable (any value other than `0`). Respected unconditionally.
3. **Build from source without a PostHog key.** A local or forked build compiled
   without one uses a no-op analytics module and sends no events.

## Self-hosting note

PostHog is open source and self-hostable. Builds configured for analytics use a
build-time endpoint (`POSTHOG_HOST`), so a distributor can select PostHog Cloud
or a self-hosted instance without a code change.

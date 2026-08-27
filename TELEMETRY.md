# Telemetry

Munder Difflin collects a small set of **anonymous** usage events so we can
understand adoption (how many people launch the app, whether they get a first
agent running, which features get used) and make the product better. This
document is the complete, authoritative
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
| `update_applied` | `from_version`, `to_version` — version strings, or `unknown` for an install older than this event; `via` — one of `auto` (the app's own updater installed it), `manual`, `unknown` | Once, on the first start after the app's version changes |
| `agent_spawned` | `provider` (CLI engine name, e.g. `claude`, `codex`) | An agent terminal is spawned |
| `onboarding_completed` | `provider` (the CLI engine chosen in the setup wizard) | Once, when onboarding finishes |
| `agent_spawn_attempted` | `provider` | Every time an agent spawn is requested, so it can be compared against `agent_spawned` |
| `agent_spawn_failed` | `provider`; `reason` is one of `cli_missing`, `cwd_missing`, `already_running`, `spawn_error` | A requested spawn did not start an agent |
| `agent_install_started` | `provider`; `rung` is one of `npm`, `node-then-npm`, `native` | The engine CLI was missing, so the bundled auto-installer began |
| `agent_install_finished` | `provider`; `rung` as above; `outcome` is one of `agent_launched`, `install_failed` | The auto-installer exited |
| `message_sent` | `surface` — one of `terminal`, `composer`, `steer`, `hive` | Each time **you** send a message to an agent. A count of messages and nothing else: the message itself is never read, measured, or hashed |
| `feature_used` | `feature` — one of `slack_trigger`, `webhook_trigger`, `hire_install`, `voice_dictation` | At most once per feature per app session |
| `session_ended` | `duration_bucket` — one of `<5m`, `5-30m`, `30m-2h`, `2-8h`, `8h+` | On quit (coarse bucket, never raw duration) |

### About `message_sent`

This is the one event that fires while you work, so it is worth being precise
about what it does and does not do.

- It counts **one event per message you send**, at the moment you send it. It is
  counted at the *submit* — the Enter or the Send button — never per keystroke.
  The app does not report what you type as you type it.
- `surface` says only *where* you sent it from: `terminal` (typed into an
  agent's terminal), `composer` (the agent's message queue box), `steer` (the
  steer field on the agent control strip), or `hive` (a dispatch, thread reply,
  or ASK ME answer).
- Messages **agents send each other** are not counted. Only messages that came
  from a person are.
- No property carries the message. There is no text, no length, no character
  count, no first-N-characters, and no hash of the body — the event has exactly
  one property and it is the surface name above. The channel the app uses to
  report it does not accept a message argument at all, so there is no shape in
  which the content could be sent by mistake.

It exists to answer one question: after someone gets an agent running, do they
ever actually talk to it? Without it, an agent that was started and then ignored
is indistinguishable from one being used every day.

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
- The only other thing stored for telemetry is the app version this install
  last ran (`telemetry-last-version`, beside the install id) — it exists so
  `update_applied` can name the version you came from, and it is deleted with
  the app's data in the same way.
- To set `via`, the app reads its own update log (`updater.log`, kept in the
  same user-data directory) to see whether the version it is now running is the
  one its updater downloaded and you asked it to restart into, and whether that
  restart is what actually installed it: the log names each version as it
  starts, so a build other than this one starting afterwards means something
  else did the installing. Only that one-word result leaves the machine — no
  line, path or message from that log is ever sent.
- No geolocation of any kind is derived. The app sends `$ip: null` on every
  event and disables the GeoIP lookup, so no IP address, country, city, postal
  code or coordinate is derived from your connection or stored on the event.

## Opting out

Any one of these fully disables telemetry:

1. **Settings → General → Anonymous usage stats → off** (or uncheck "Share
   anonymous usage stats" during onboarding). Takes effect immediately.
2. Set the standard [`DO_NOT_TRACK`](https://consoledonottrack.com)
   environment variable (any value other than `0`). Respected unconditionally.
3. **Build from source.** The PostHog key is injected only in official release
   CI; a local or forked build compiles without one and the analytics module
   is a no-op — forks never send events anywhere.

## Self-hosting note

PostHog is open source and self-hostable. Official builds point at PostHog
Cloud (US); the endpoint is a build-time setting (`POSTHOG_HOST`), so the
project can move to a self-hosted instance without any code change.

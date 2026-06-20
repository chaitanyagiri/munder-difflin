# Feature Testing — everything added since v0.2.7

This document is a practical, hands-on test guide for every feature added to **`munder-difflin`**
(the multi-agent "office floor" of CLI coding agents; the god orchestrator is **Michael**) since
the `v0.2.7` tag. It covers the released **v0.2.8** features (shareable hires + The Hiring Fair)
**and** the unreleased work that currently lives only on local **`main`** — the dev build.

**How to run.** All of this is exercised by launching the dev build:

```bash
npm run dev          # electron-vite dev — opens the macOS desktop app
```

> This is a macOS desktop app. The features below are on local `main` (an unreleased dev build);
> there is no published release that contains them yet.

**External setup needed for a few features (called out per-section):**
- **Voice / VDE** — a **Groq API key** (Settings → General → *Free Flow*).
- **Slack-triggered worker** — a **Slack app + bot token + a public tunnel** (Settings → General → *Slack*).
- **Integrations end-to-end** — a **real API token** for the service you add (e.g. a GitHub PAT).
  Everything else (UI, validation, broker plumbing) can be exercised without one.

---

## Table of contents

- [A. Shareable hires (v0.2.8)](#a-shareable-hires-v028)
- [B. The Hiring Fair — community gallery (v0.2.8)](#b-the-hiring-fair--community-gallery-v028)
- [C. Selectable agent engines + per-hire capabilities](#c-selectable-agent-engines--per-hire-capabilities)
- [D. Agent Gallery (in-app)](#d-agent-gallery-in-app)
- [E. Onboarding — feature-aware first-run + permissions & reliability](#e-onboarding--feature-aware-first-run--permissions--reliability)
- [F. Reliability on wake](#f-reliability-on-wake)
- [G. Command Center IA + UX fixes (voice tooltip, visible installer)](#g-command-center-ia--ux-fixes-voice-tooltip-visible-installer)
- [H. Slack → god-triggered ephemeral isolated worker (Phase 1)](#h-slack--god-triggered-ephemeral-isolated-worker-phase-1)
- [I. Integrations registry + loopback secret broker (Phase 2)](#i-integrations-registry--loopback-secret-broker-phase-2)
- [J. Worker lifecycle hardening — Workers tab + GC + token-cap (Phase 4)](#j-worker-lifecycle-hardening--workers-tab--gc--token-cap-phase-4)
- [K. Temporal skills + capability catalog (Phase 3)](#k-temporal-skills--capability-catalog-phase-3)
- [L. VDE prototype + Groq AI assist (experimental)](#l-vde-prototype--groq-ai-assist-experimental)
- [Quick smoke test (15 min)](#quick-smoke-test-15-min)

---

## A. Shareable hires (v0.2.8)

**What it is.** Import a role-configured agent from a portable `munder-difflin/hire@1` JSON
manifest — either via a `munderdifflin://hire?src=<https-manifest-url>` deep link or via an
*import hire…* button that reads a local manifest file; import only **pre-fills** the Add-Agent
modal, it never auto-spawns.

**Prerequisites:** none for the local-file path. The deep-link path needs a packaged build for the
protocol to be OS-registered (`electron-builder.yml` registers the `munderdifflin` scheme); in
`npm run dev` the local-file path is the reliable one to exercise.

**Steps to test — local file import (works in dev):**
1. Grab a manifest file. Either download one from the gallery (feature B) or use a `.hire.json`
   from `docs/hires/manifests/` (e.g. `pam-designer.hire.json`).
2. In the app, click **Add agent** to open the Add-Agent modal.
3. In the modal, click **`import hire…`** and pick the `.json` file.
4. Observe the form pre-fill and the imported banner.
5. Review the pre-filled fields — **especially the `command`** — then click **`spawn`** only if you
   want it to run.

**Steps to test — deep link (packaged build, or `munderdifflin://` registered):**
1. Host a manifest at an `https://` URL (the gallery serves these as static files).
2. Open `munderdifflin://hire?src=https://munderdiffl.in/hires/manifests/<file>.json`.
3. The main process fetches + validates it (https-only, manual-redirect re-validation, 64 KB cap,
   10 s timeout, ≤5 hops) and queues it; the renderer pulls it on mount and pre-fills the modal.

**Expected result:**
- ✓ The Add-Agent modal opens **pre-filled** behind a banner: `📋 hire imported: <name>` (with
  `· by <author>` when present) and the line `review every field — especially the command — before spawning.`
- ✓ Nothing spawns on import — spawning is a separate, explicit **`spawn`** click.
- ✓ A hostile manifest is rejected before it can do harm: `provider: "custom"` is refused (provider
  must be `claude` / `antigravity` / `codex`); only flags in the **default-deny allowlist**
  `SAFE_FLAG_NAMES` (`--model`, `--max-turns`, `--output-format`, `--verbose`) survive; `model` must
  match `MODEL_RE` (no shell metacharacters); the binary always comes from your local provider preset.
- ✓ Manifest fetch is **https-only** (http allowed only for `127.0.0.1` / `localhost`), with SSRF
  blocks on private/loopback/link-local/metadata addresses.

> Validator + schema: `src/shared/hire.ts` (`HIRE_SPEC_V1` = `"munder-difflin/hire@1"`,
> `SAFE_FLAG_NAMES`, `MODEL_RE`); local-file/fetch + SSRF guard: `src/main/hire.ts`; deep-link parse:
> `parseHireDeepLink()` in `src/shared/hire.ts`; UI: `src/renderer/src/components/AddAgentModal.tsx`.

---

## B. The Hiring Fair — community gallery (v0.2.8)

**What it is.** A static community gallery of ready-made roles at
[`munderdiffl.in/hires`](https://munderdiffl.in/hires/) (source `docs/hires/`, no build step) you can
browse, toggle by engine, and download a manifest from to import back into the app.

**Prerequisites:** none (a browser). To open it locally, serve `docs/hires/`:
`cd docs/hires && python3 -m http.server 8080` then visit `http://127.0.0.1:8080`.

**Steps to test:**
1. Open `https://munderdiffl.in/hires/` (or the local server above).
2. Browse the seed roles. Use the **function filters** to narrow, and use the per-card **provider
   toggle** to switch between **Claude Code / Antigravity / Codex** (each base manifest derives a
   per-provider variant client-side).
3. Pick a role and click its **download** control (the `⤓` button) to save the variant's
   `.hire.json`.
4. Bring it into the app via feature A's **`import hire…`** path.

**Expected result:**
- ✓ The seed roles render — the gallery now ships ~20 (e.g. developer, designer, sales, feedback
  collector, customer support, social-media manager, QA, PR-reviewer, security, migrations), each
  with a Claude / Antigravity / Codex toggle.
- ✓ Model suggestions are data-driven from `docs/hires/models.json` (a one-line update adds a model).
- ✓ The downloaded `.json` validates against the same dependency-free validator the app uses
  (`docs/hires/validator.js`, mirrored from `src/shared/hire.ts`) and the schema in
  `docs/hires/spec/`.
- ✓ The gallery is static HTML/JS — importing happens by **download → re-import locally** (no
  auto-fetch from the page).

---

## C. Selectable agent engines + per-hire capabilities

**What it is.** Michael's underlying engine is selectable (Claude Code / Codex / Antigravity, plus
proxy-bridged `qwen`), pickable at onboarding and changeable later; and an imported hire
can declare bundled skills / MCP servers that surface a consent UI before anything is enabled.

**Prerequisites:** none to see the pickers. Running a non-Claude engine requires that engine's CLI
installed (see feature G — the installer now runs visibly if the binary is missing).

**Steps to test — pick Michael's engine at onboarding:**
1. On first run (or after resetting onboarding), reach **STEP 2 OF 5 · MICHAEL'S ENGINE** in the
   onboarding wizard.
2. Choose an engine from the radio list (`godProvider`). **Claude Code** carries a **`RECOMMENDED`**
   badge; only inbox-capable engines are offered.
3. Pick a model from the dropdown (seeded with each preset's `recommendedOrchestratorModel`, e.g.
   `claude-opus-4-8[1m]` for Claude) and continue.

**Steps to test — change Michael's engine later:**
1. Select **Michael** (the god orchestrator) in the floor; open the **Command Center**.
2. On Michael's agent card use the **`engine:`** dropdown (and the model dropdown next to it).
3. Click **`apply`**.
4. Confirm the prompt: *"This restarts Michael; a conversation on a different engine can't be resumed."*

**Steps to test — per-hire MCP/skills consent:**
1. Import a hire (feature A) whose manifest declares `skills` and/or `mcpServers`.
2. In the Add-Agent modal review block, observe how the capabilities are surfaced.

**Expected result:**
- ✓ Engine options come from `AGENT_PROVIDER_PRESETS` (`src/shared/agentProvider.ts`):
  `claude`, `codex`, `antigravity`,
  `qwen` (proxy → OpenAI-shaped API via `OPENAI_BASE_URL`), `custom`.
- ✓ Changing the engine restarts Michael (no cross-engine resume) after the confirm dialog.
- ✓ Hire capabilities show a graded consent UI: **safe, read-only** MCP servers are pre-enabled (blue
  badge); **write/secret** servers show an orange `⚠️ MCP (needs your consent — NOT auto-enabled)`
  badge and are **not** auto-enabled (enable later in Settings → MCP). Bundled skills shipped with the
  hire show as green badges.
- ✓ Bundled skills are shipped via `extraResources` (`resources/skills` → `<resources>/skills` in
  `electron-builder.yml`); MCP catalog lives in `src/shared/mcpCatalog.ts` (safe-readonly: e.g.
  sequential-thinking, time, fetch, context7, filesystem, git; write/secret: github-token, db,
  email-calendar, search-with-key).

> Files: `src/shared/agentProvider.ts`, `src/shared/mcpCatalog.ts`,
> `src/renderer/src/components/OnboardingWizard.tsx` (engine step),
> `src/renderer/src/components/CommandCenterPanel.tsx` (change-engine on Michael's card),
> `src/renderer/src/components/AddAgentModal.tsx` (consent UI).

---

## D. Agent Gallery (in-app)

**What it is.** A set of ready-made off-the-shelf hires (originally six, now ~20 manifests; formerly
"The Hiring Fair", rebranded **Agent Gallery**) you can grab and spawn in one click via the Add-Agent
flow.

**Prerequisites:** none.

**Steps to test:**
1. Note the **READY-MADE HIRES → Agent Gallery** tile on the onboarding welcome screen ("Grab a
   pre-configured agent from the Agent Gallery and spawn it in one click").
2. Click **Add agent** to open the Add-Agent modal.
3. Click **`import hire…`** and pick one of the six bundled manifests from `docs/hires/manifests/`
   (developer / designer / sales / feedback / support / social).
4. Review the pre-filled fields and click **`spawn`**.

**Expected result:**
- ✓ ~20 roles are available as ready-made manifests in `docs/hires/manifests/` (e.g. `ryan-developer`,
  `pam-designer`, `michael-sales`, `toby-feedback`, `erin-support`, `kelly-social`, `dwight-qa`,
  `jim-pr-reviewer`, `creed-security`, `stanley-migrations`), each with a sensible model.
- ✓ The flow is identical to feature A's local import — review-then-spawn, never auto-spawn.

> The "Agent Gallery" is the renamed Hiring Fair; the in-app entry point is the **`import hire…`**
> button in `AddAgentModal.tsx`, sourcing the six manifests in `docs/hires/manifests/`.

---

## E. Onboarding — feature-aware first-run + permissions & reliability

**What it is.** A first-run wizard that introduces the office's features and ends on a dedicated
**Permissions & Reliability** step explaining how agents keep working while you're away.

**Prerequisites:** none. To replay it after first run, reset onboarding (Settings → General, or clear
the onboarding flag) and relaunch.

**Steps to test:**
1. Launch a fresh install (or reset onboarding) and walk the wizard:
   **MEET YOUR OFFICE → STEP 1 HARNESS HOME → STEP 2 MICHAEL'S ENGINE → STEP 3 YOUR REPOS →
   STEP 4 AUTO MODE → STEP 5 PERMISSIONS & RELIABILITY → ALL SET.**
2. On the welcome screen, read the feature tiles (this is the "feature-aware" part — it advertises
   ready-made hires, the gallery, etc.).
3. On **STEP 5 OF 5 · PERMISSIONS & RELIABILITY**, toggle each row and read its description.

**Expected result:**
- ✓ The Permissions & Reliability step exposes four controls:
  - **KEEP WORKING WHILE AWAY** — strong keep-alive (`strongKeepalive`), off by default, "uses more
    battery — best on power."
  - **DESKTOP NOTIFICATIONS** — macOS asks permission the first time one fires.
  - **OPEN AT LOGIN** — relaunch after reboot so scheduled missions resume.
  - **STAY AWAKE ON POWER (MANUAL)** — instruction-only, with an **open Battery settings** button
    (`x-apple.systempreferences:com.apple.preference.battery`), because macOS won't let the app flip
    Energy settings itself.
- ✓ The copy explains that on full sleep, timers pause and **catch up on wake** (nothing lost, may
  run late) — tying directly into feature F.

> File: `src/renderer/src/components/OnboardingWizard.tsx` (step type:
> `welcome | home | orchestrator | repos | auto | permissions | done`).

---

## F. Reliability on wake

**What it is.** When the Mac sleeps/locks, schedules and terminals freeze; on wake the app **catches
up missed schedules exactly once** and **auto-revives wedged terminals** instead of leaving them
dead.

**Prerequisites:** an actual sleep/wake cycle (or close-lid). Optional: enable **KEEP WORKING WHILE
AWAY** (`strongKeepalive`) from onboarding or Settings to test the stronger blocker.

**Steps to test:**
1. With at least one agent terminal live and a recurring mission scheduled (Schedules tab), set a
   mission due in a few minutes.
2. Put the Mac to sleep (or close the lid) past that due time, for several minutes.
3. Wake the Mac and watch the floor.

**Expected result:**
- ✓ On resume, each overdue mission fires **exactly once** (coalesced catch-up — no replay burst),
  via the `onSystemResume()` / `syncMissions` path; always-on beats (heartbeat / fleet / breaker)
  re-arm.
- ✓ ~15 s after wake, a liveness probe (`kill(pid,0)`, no auto-kill) flags any **wedged** PTYs and
  emits a `power:resume` IPC.
- ✓ The renderer auto-respawns exactly those wedged terminals — same agent id, cwd/worktree, command,
  with `--resume` to reattach the CLI session — so they self-heal instead of needing a manual
  **Restart & Continue**. Healthy PTYs are untouched; a resume+unlock burst is debounced (per-PTY 8 s)
  so a terminal can't double-respawn.

> Commits: `dd9ea5f` (main: powerMonitor wiring + catch-up), `d7f09aa` (renderer: auto-revive
> listener). Files: `src/main/index.ts`, `src/main/hive.ts` (renderer-side revive).

---

## G. Command Center IA + UX fixes (voice tooltip, visible installer)

**What it is.** Three independent UX fixes: the Add-Agent modal's many config fields are grouped into
a sectioned sidebar; the Free Flow voice button now shows **disabled with a tooltip** when no Groq
key is set; and a missing engine CLI is **installed visibly** in the agent's own terminal.

**Prerequisites:** none. (Installer test is easiest if the target engine's CLI is genuinely missing.)

**Steps to test — Add-Agent IA:**
1. Click **Add agent**. Note the left sidebar index with four sections: **Identity / Workspace /
   Engine / Briefing**, one shown at a time, with the hire-import banner and footer pinned.
2. Leave a required field blank and submit — the modal **auto-jumps** to the section holding the
   offending field (it can never be trapped in an unopened section).

**Steps to test — Free Flow voice button tooltip:**
1. In Settings → General → **Free Flow**, enable Free Flow but leave the **Groq API key** empty.
2. Open an agent composer and hover the **voice** button.

**Steps to test — visible engine-CLI installer:**
1. Add an agent whose engine CLI is not installed (e.g. Codex when `codex` isn't on PATH).
2. Spawn it and watch its terminal.

**Expected result:**
- ✓ Add-Agent: sectioned IA, wide-rectangle layout, every field/validation/spawn path unchanged; the
  Monitor tab grid and an Ask Me dismiss affordance are also fixed.
- ✓ Voice button: stays **visible but disabled** with tooltip *"Add a Groq API key in Settings → Free
  Flow to use voice mode."* (With Free Flow's master toggle **off**, the button is not rendered at
  all.) It never starts a recording, so `getUserMedia` and the Groq STT call are never reached.
- ✓ Installer: instead of dying with `— process exited (code 1) —`, the terminal prints a banner and
  **runs the provider's install command visibly** (e.g. `npm i -g @anthropic-ai/claude-code` for
  Claude) so you can watch it and complete any interactive sign-in, then click **restart & continue**.

> Commits: `eaed9fb` (Add-Agent IA), `d96d651` (voice tooltip), `cc49e1e` (visible installer).
> Files: `src/renderer/src/components/AddAgentModal.tsx`,
> `src/renderer/src/components/MessageQueueComposer.tsx`, `src/shared/agentProvider.ts`
> (`installCommand`), `src/main/pty.ts`.

---

## H. Slack → god-triggered ephemeral isolated worker (Phase 1)

**What it is — the flagship.** A Slack message spins up a **fresh, isolated worker** in its own git
worktree + isolated env; it runs to completion, replies in-thread, then tears down — **preserving any
unintegrated work** rather than discarding it.

**Prerequisites (external setup required):**
- A **Slack app** with a bot token (`xoxb-…`), a signing secret, and event subscriptions, plus a
  **public tunnel** for the inbound webhook. Configure these in **Settings → General → Slack**
  (`slackEnabled`, `slackSigningSecret`, `slackBotToken`, `slackChannelId`, `slackPort` default
  `3847`). Use the **open Slack connect steps** help in that panel.
- Full walkthrough: the existing Slack setup tutorial — `blog/src/posts/run-ai-agent-hive-from-slack-setup.md`
  and `blog/src/posts/trigger-ai-agents-from-slack.md` (published at
  `docs/blog/run-ai-agent-hive-from-slack-setup` / `docs/blog/trigger-ai-agents-from-slack`).

**Steps to test (with Slack configured):**
1. In **Settings → General → Slack**, fill the fields and **start** Slack; wait for the tunnel to
   report `listening` and verify the Request URL shows Slack's green check.
2. Open the **Workers** tab in the Command Center (feature J) to watch live.
3. Post a message that mentions the bot / lands in the configured channel.
4. Observe the lifecycle and check the Slack thread for the reply.

**Local-only partial check (no Slack):** You can confirm the plumbing without Slack by reading the
spawn loop — the main process polls `HIVE_ROOT/spawn-requests/` every ~1.5 s
(`WORKER_TICK_MS = 1500`) and the worktree mount dir is `<harnessHome>/worktrees/` (the repo also
ignores `.worktrees/`). The Workers tab renders "No workers running right now." until one spawns.

**Expected result:**
- ✓ A Slack message (validated by HMAC + replay-dedup) creates a spawn request; `processSpawnRequest`
  spawns an **isolated worker** via `spawnAgentCore` in a fresh `agent/<id>` worktree
  (`addWorktree()` in `src/main/git.ts`).
- ✓ The worker does the job and **posts a substantive reply** into the originating Slack thread (via
  the loopback-only reply helper), then signals `act:"done"` to god.
- ✓ Teardown is **safe**: `finalizeWorkerWorktree()` checks `worktreeHasUnintegratedWork()` and only
  removes the worktree when there's nothing to keep; otherwise it's tracked in `preservedWorktrees`
  (surfaced under **Preserved worktrees** in the Workers tab) and reclaimed later once the work lands.
- ✓ A **stale-done guard** (`workerSignaledDone`) only releases a worker on a `done` authored **after**
  its own spawn time, so a previous worker's signal can't prematurely release a new one.

> Commits: `22fce6f` (spawn→reply→safe teardown), `13c5435` (teardown-safety gate), `a2f2e45`
> (stale-done guard). Files: `src/main/index.ts`, `src/main/slack.ts`, `src/main/git.ts`,
> `src/main/pty.ts`, `src/main/hive.ts`.

---

## I. Integrations registry + loopback secret broker (Phase 2)

**What it is.** Add an integration (from a template or a custom REST API) with a **write-only, masked**
secret; a spawned worker reaches it **credential-free** through a local loopback broker that injects
the real secret upstream — the secret never enters the worker's env or any response.

**Prerequisites:** none to add/configure/test the UI plumbing. A successful **Test connection** and a
real upstream call need a **real API token** for the chosen service.

**Steps to test — add + test an integration:**
1. Open **Settings → Integrations**.
2. Pick a template from the gallery (or **custom-rest** for any HTTP API) and click **`continue →`**.
3. Fill the label / base URL / auth header as needed, then **paste your secret** into the masked
   field (toggle **show/hide**; an existing secret shows a saved pill with **Replace key**).
4. Click **`Save integration`**.
5. Click **`Test connection`** (a live, read-only probe against the base URL with the stored secret).

**Steps to test — a worker reaches it via the broker:**
1. Spawn a worker (e.g. via Slack, feature H). The harness injects `MD_BROKER_URL` and
   `MD_BROKER_TOKEN` into that worker's env.
2. From inside the worker, call the integration credential-free:
   ```bash
   curl -H "Authorization: Bearer $MD_BROKER_TOKEN" "$MD_BROKER_URL/i/<integrationId>/<path>"
   ```
   (The header `X-MD-Broker-Token: $MD_BROKER_TOKEN` is also accepted.)

**Expected result:**
- ✓ The Integrations UI lists 9 templates from `INTEGRATION_TEMPLATES` (`src/shared/integrations.ts`):
  **github, custom-rest, linear, jira, notion, stripe, confluence, sentry, hubspot**. (Gmail, Google
  Calendar, Salesforce are **deferred to v1.1** — OAuth.)
- ✓ The secret is **write-only/masked**: it's stored encrypted, shown as a saved pill, and never
  echoed back into the form.
- ✓ Test connection returns `✓ Connected (<status>)` or `✕ <error>`; status renders per-row too.
- ✓ The broker route is `/i/<integrationId>/<path>` (regex `^/i/([^/?#]+)(?:/([^?#]*))?...` in
  `src/main/integrationBroker.ts`). The path is **origin-confined** — absolute URLs, host overrides,
  and `..` traversal are rejected (the `47e78a6` SSRF/secret-exfil fix) — so the broker is not an
  open proxy.
- ✓ **Security guarantee:** the real secret is materialized only at forward-time inside the broker
  (`getSecret(rec.secretRef)`), injected into the **upstream** request, and never logged, never
  returned to the worker, never placed in the worker's env. The worker holds only the short-lived
  broker token.

> Preload bridge (`a253bb5`) exposes `integrationsTemplates / integrationsList / integrationsUpsert /
> integrationsSetSecret / integrationsRemove / integrationsTest`. Files:
> `src/main/integrationBroker.ts`, `src/main/integrations.ts`, `src/shared/integrations.ts`,
> `src/renderer/src/components/IntegrationsRegistry.tsx`, `src/preload/index.ts`, `src/main/index.ts`
> (env injection `MD_BROKER_URL` / `MD_BROKER_TOKEN`).

---

## J. Worker lifecycle hardening — Workers tab + GC + token-cap (Phase 4)

**What it is.** A **Workers** tab in the Command Center that lists live ephemeral workers
(status/age/tokens) with a **stop** control, plus auto-GC of torn-down worktrees once their work
integrates (never GCing unintegrated work), and a per-worker token cap that **defaults to unlimited**.

**Prerequisites:** none to view the tab. To see live rows you need a worker spawning (feature H).

**Steps to test:**
1. Open the **Command Center** and select the **`workers`** tab (last tab, gear icon).
2. With no workers running, confirm the empty state.
3. Spawn a worker (feature H) and watch a row appear under **Live workers** (`N / max`).
4. Click **`stop`** on a row to tear it down by hand.
5. If a torn-down worker left unintegrated work, find it under **Preserved worktrees**; once that
   work lands in its base branch, confirm it disappears (auto-reclaimed).

**Expected result:**
- ✓ The tab is labeled **`workers`** and lives in the Command Center tab strip
  (`CommandCenterPanel.tsx`).
- ✓ Each live row shows a status badge (**working** / **stopping**), the worker name, a `slack` chip
  when it replies to a thread, the worker/PTY id, `base: <branch>`, `up <age>`, `idle <age>` (or
  `pty gone`), and `tokens <n> · uncapped` (or `/ <cap>`). A **`stop`** button reads `stopping…`
  while tearing down.
- ✓ **Preserved worktrees** lists finished workers whose worktree held un-integrated work — "kept
  (never auto-discarded) and auto-reclaimed once the work lands." GC is fail-safe
  (`gcPreservedWorktrees()` → `worktreeIsGcSafe()`): it reclaims only when the tree is clean **and**
  either 0 commits ahead or the tree is identical to base.
- ✓ Token cap defaults **off**: `defaultWorkerTokenCap: 0` (`0 = unlimited`) in `src/main/config.ts`;
  the mechanism is wired (reaped only when `tokenCap > 0`) but does nothing by default — rows show
  `· uncapped`.

> Commit: `d670856`. Files: `src/renderer/src/components/WorkersTab.tsx`,
> `src/renderer/src/components/CommandCenterPanel.tsx`, `src/main/config.ts`, `src/main/index.ts`,
> `src/main/git.ts`.

---

## K. Temporal skills + capability catalog (Phase 3)

**What it is.** Bundled, read-only worker skills that resolve named time windows to concrete ISO date
ranges relative to invoke time, plus a `/capabilities` catalog every spawned worker reads at boot.

**Prerequisites:** none — they run with plain `node` (no network, no writes).

**Named window skills bundled** (`resources/skills/`): `today`, `yesterday`, `thisWeek`, `lastWeek`,
`last7Days`, `last30Days`, `thisMonth`, `lastMonth`, `thisQuarter`, `lastQuarter`, `thisYear`,
`lastYear` — plus the umbrella `temporal` skill and the read-only `capabilities` catalog. (The
`temporal` resolver also understands `last90Days`, `last12Months`, and arbitrary
`lastNdays`/`lastNweeks`/`lastNmonths`.)

**Steps to test (locally, no app needed):**
1. From the repo root, run the resolver directly:
   ```bash
   node resources/skills/temporal/when.mjs last30Days
   node resources/skills/temporal/when.mjs --json last7Days
   node resources/skills/temporal/when.mjs --list
   ```
2. Inside a spawned worker, the same skill is at `$AGENT_DIR/.claude/skills/temporal/when.mjs`, and a
   worker invokes the named shortcut (e.g. `/last30Days`) which calls this resolver for that one
   window.

**Expected result:**
- ✓ `/last30Days` resolves a rolling 30-day window ending today and prints a human line plus a JSON
  record, e.g.:
  ```json
  {
    "window": "last30Days",
    "start": "2026-05-21",
    "end": "2026-06-19",
    "inclusive": true,
    "startUtc": "2026-05-20T18:30:00.000Z",
    "endExclusiveUtc": "2026-06-19T18:30:00.000Z",
    "days": 30,
    "timezone": "Asia/Calcutta",
    "asOf": "<resolve instant>"
  }
  ```
  (Exact dates/timezone reflect your clock and locale.)
- ✓ Convention holds: `this*` windows are **period-start → today** (to-date); `last*` named periods
  are the **full prior complete period**. Output gives both inclusive civil dates and a half-open
  `[startUtc, endExclusiveUtc)` for timestamp queries.
- ✓ Every spawned worker reads the read-only **`/capabilities`** catalog at boot, which documents its
  env (`AGENT_ID`, `AGENT_DIR`, `HIVE_ROOT`), the temporal skills, and how to reach integrations via
  the loopback broker (feature I) credential-free.

> Commit: `0791a45`. Files: `resources/skills/temporal/SKILL.md` + `when.mjs`, the per-window
> `resources/skills/<window>/SKILL.md`, and `resources/skills/capabilities/SKILL.md`.

---

## L. VDE prototype + Groq AI assist (experimental)

**What it is — EXPERIMENTAL / PROTOTYPE, not a shipped UI surface.** A standalone static prototype of
a Virtual Dev Environment under `prototypes/vde/`, plus a main-process Groq chat-completion module
(`src/main/groq.ts`) intended to back its "AI assist." Neither is imported by the app, and there is no
in-app entry point.

**Prerequisites:** a browser for the prototype. The Groq module would need a Groq API key, but it is
**not wired to any UI**, so you cannot exercise it through the app.

**Steps to test (the only available way — open the static prototype):**
1. Serve and open the prototype directly:
   ```bash
   cd prototypes/vde && python3 -m http.server 8081
   ```
   then visit `http://127.0.0.1:8081`.
2. Use the **screen switcher** (top-left chips: `A Full IDE`, `B Empty`, `C Palette`, `D AI Diff`,
   `E Daylight Split`, `F Zen`) and the Code/Vibe/Terminal/Zen layout toggles to view the static
   screens.

**Expected result:**
- ✓ The prototype renders a multi-screen static IDE mockup (no real editing, no agent wiring) — it's a
  design dump, four files, no dependencies.
- ✓ `src/main/groq.ts` exists as a self-contained module (`groqChat()`, default model
  `llama-3.1-8b-instant`, endpoint pinned to `https://api.groq.com/...`, key used only in the
  `Authorization` header, never logged/returned, suggestion-text-only with no fs/pty side effects) —
  but **no renderer/preload/`index.ts` code calls it**, so there is no shipped path to trigger it.
- ✓ Treat this as preview-only: it is intentionally not part of the app's navigable UI.

> Commits: `11bdf12` (Groq module), `db2b03d` (VDE prototype + reference doc dumps). Files:
> `prototypes/vde/{index.html,app.js,styles.css,tokens.css}`, `src/main/groq.ts`. (`docs/r/*.json`
> are reference data dumps, also not imported by app source.)

---

## Quick smoke test (15 min)

A fast confidence pass that touches the highest-value features end to end.

1. **Launch.** `npm run dev` — the app opens.
2. **Onboarding + engine pick (E, C).** Walk the wizard; at **STEP 2 · MICHAEL'S ENGINE** pick an
   engine + model; at **STEP 5 · PERMISSIONS & RELIABILITY** read the four reliability toggles.
   Finish to **ALL SET**.
3. **Add a gallery hire (D, A).** Click **Add agent → `import hire…`**, pick a manifest from
   `docs/hires/manifests/` (e.g. `pam-designer.hire.json`), confirm the **imported** banner pre-fills
   the modal, then click **`spawn`**.
4. **Add + test an integration (I).** **Settings → Integrations** → pick **github** (or
   **custom-rest**) → **`continue →`** → paste a token (a real PAT to actually pass) → **`Save
   integration`** → **`Test connection`** and read the status.
5. **Temporal skill (K).** In a terminal: `node resources/skills/temporal/when.mjs last30Days` —
   confirm a concrete ISO range comes back.
6. **Workers tab (J).** Open the **Command Center → `workers`** tab and confirm the live/preserved
   layout (empty state if no Slack worker is running).

If all six steps behave as described, the core of the v0.2.7→`main` feature set is healthy. The two
features that need external services to fully exercise are **Slack workers (H)** — needs a Slack app +
bot token + tunnel — and a fully green **integration Test (I)** — needs a real API token. The **VDE /
Groq assist (L)** is prototype-only and has no in-app surface.

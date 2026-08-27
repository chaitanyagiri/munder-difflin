/**
 * Agent providers — the CLI a worker runs on. The app is no longer Claude-only:
 * a worker can run Claude Code, the OpenAI Codex CLI (`codex`), Kimi Code
 * (`kimi`), xAI Grok (`grok`), the Antigravity CLI (`agy`, Gemini models), or
 * any custom command.
 * Each provider declares how to build its spawn command (model/auto-mode flags) and
 * whether it accepts the hive's Claude-specific identity injection
 * (`--append-system-prompt` + `--settings`).
 *
 * Shared between main and renderer; keep it dependency-free (no electron, no UI).
 * Mirrors the shape of the upstream provider-preset work (PR #47 / issue #21) so
 * the two reconcile cleanly — this build adds the `antigravity` preset alongside
 * the existing `codex` preset.
 */
import type { CmdGroup } from './claudeCommands';
import { COMMAND_GROUPS as CLAUDE_COMMAND_GROUPS } from './claudeCommands';
import { CODEX_COMMAND_GROUPS } from './codexCommands';
import { GROK_COMMAND_GROUPS } from './grokCommands';

// NOTE: 'claw' (claw-code) was removed as a selectable provider — its upstream is
// an unmaintained "museum exhibit" repo, not a production CLI. Re-add a supported
// fork here (plus its preset/models/logo) after review. The proxy-bridge tier it
// shared with qwen stays in place for qwen.
export type AgentProvider =
  | 'claude'
  | 'codex'
  | 'grok'
  | 'kimi'
  | 'gemini'
  | 'antigravity'
  | 'qwen'
  | 'opencode'
  | 'crush'
  | 'pi'
  | 'copilot'
  | 'cursor'
  | 'custom';

/** Structured descriptor for how a NON-hiveAware provider gets hive lifecycle
 *  events (live status + Stop→inbox-drain + cost), introduced alongside the legacy
 *  `hookBridge` so call sites can switch on `bridge.kind` without a big-bang
 *  rewrite. Two kinds:
 *   - 'hooks'  → a config-file hook shim is installed (agy/codex). Derived from the
 *               legacy `hookBridge` by `bridgeOf`, so agy/codex keep working with no
 *               preset change.
 *   - 'proxy'  → the CLI has NO hook surface (qwen), so a loopback reverse-proxy
 *               sidecar observes its LLM traffic and SYNTHESIZES the same HIVE_SOCK
 *               payloads the shims emit. `api` selects the usage/tool-call shape
 *               (OpenAI vs Anthropic), `baseUrlEnv` is the env var the CLI reads for
 *               its upstream base URL (the sidecar's loopback URL is injected there),
 *               and `inboxDelivery` is how mail reaches it ('terminal' work-order
 *               handoff today; 'serve' reserved for a future HTTP push path). */
export type BridgeDescriptor =
  | { kind: 'hooks'; shim: 'agy' | 'codex' | 'pi' | 'opencode' | 'grok' | 'gemini' }
  | {
      kind: 'proxy';
      api: 'openai' | 'anthropic';
      baseUrlEnv: string;
      inboxDelivery: 'terminal' | 'serve';
    };

export interface AgentProviderPreset {
  id: AgentProvider;
  label: string;
  /** The binary spawned when the user hasn't typed a custom command. */
  defaultCommand: string;
  /** Slash / CLI command reference for this provider. */
  commandGroups: CmdGroup[];
  /** Environment variable to set for non-interactive / first-run suppression. */
  nonInteractiveEnv?: Record<string, string>;
  /** Flag(s) appended to the command string when auto mode is active.
   *  Kept alongside `autoFlag` (same value) for the HEAD consumers that read
   *  `autoModeFlag` via `autoModeFlagForProvider`. */
  autoModeFlag: string;
  /** Show a model picker and splice the model into the command. */
  supportsModel: boolean;
  /** Flag that selects the session model, e.g. `--model`. */
  modelFlag?: string;
  /** Flag appended when the floor is in auto (skip-permissions) mode.
   *  PR #54 consumers read this; mirrors `autoModeFlag`. */
  autoFlag?: string;
  /** Claude Code accepts the hive identity injection (`--append-system-prompt`
   *  + hook `--settings`). Other CLIs don't — they spawn with the shared AGENT_*
   *  env only. Gates the Claude-specific spawn injection in hive.ensureAgent.
   *  NOTE: this gates the *Claude-only* flag path specifically — it is NOT the
   *  same as "participates in the hive". A non-hiveAware provider can still be a
   *  full hive citizen (live status + guarded idle delivery) via a `hookBridge`. */
  hiveAware: boolean;
  /** Which config-file lifecycle-hook bridge a NON-hiveAware provider uses to get
   *  the same live status that Claude gets from `--settings`:
   *    - 'agy'   → installAgyHooks() writes ~/.gemini/.../hooks.json (translating
   *                shim, because agy's stdin/stdout shape differs from Claude's).
   *    - 'codex' → installCodexHooks() writes a per-agent CODEX_HOME config and
   *                reuses the Claude `cth-hook` shim verbatim (Codex's hook payload
   *                + response contract are already Claude-shaped).
   *    - 'grok'  → installGrokHooks() installs an AGENT_ID-scoped adapter for
   *                Grok's camelCase lifecycle payloads.
   *  Claude leaves this undefined (it uses its native `--settings` path, gated by
   *  hiveAware); `custom` leaves it undefined (no bridge → no hooks). This is the
   *  single switch hive.ensureAgent dispatches on to wire the bridge. */
  hookBridge?: 'agy' | 'codex' | 'grok';
  /** Structured bridge descriptor (the forward-looking replacement for the legacy
   *  `hookBridge`). Set explicitly only for PROXY-tier providers (qwen) that
   *  have no hook file to install; agy/codex leave it undefined and `bridgeOf`
   *  derives `{kind:'hooks'}` from their `hookBridge`. claude/custom leave it
   *  undefined (no bridge). Prefer `bridgeOf(provider)` over reading this directly. */
  bridge?: BridgeDescriptor;
  /** The model the GOD orchestrator ("Michael") defaults to when this provider
   *  powers it — surfaced as the picker default and the advisory "give Michael a
   *  longer-context, higher-capability model". `modelForRole` resolves the GOD
   *  model as `config.godModel ?? preset.recommendedOrchestratorModel ?? MODEL_GOD`.
   *  Advisory + user-overridable. */
  recommendedOrchestratorModel?: string;
  /** Whether the router may DELIVER inbox mail to this provider (vs bouncing it
   *  to the god). Requires lifecycle status so the renderer can deliver only at a
   *  safe idle prompt: Claude natively, Antigravity/Codex/Grok via hook bridges.
   *  A hookless custom provider cannot expose safe-idle state, so mail bounces.
   *  Distinct from hiveAware: agy/codex/grok are NOT hiveAware (no Claude injection)
   *  but CAN receive inbox via their bridge. */
  canReceiveInbox: boolean;
  /** For non-hive-aware CLIs that still take an INITIAL prompt to orient the
   *  session (Antigravity's `agy -i "<prompt>"`), the flag to pass it under. The
   *  hive identity+protocol rides in as the first turn — the closest thing to
   *  Claude's `--append-system-prompt` these CLIs offer. undefined = the CLI
   *  takes its initial prompt POSITIONALLY (Codex: `codex "<prompt>"`) and the
   *  injection branch appends it as a quoted trailing arg instead of a flag. */
  initialPromptFlag?: string;
  /** How the hive protocol seed is delivered for a CLI that takes NEITHER a flag
   *  nor a positional seed. `'type-into-tui'` = the CLI is a bare interactive TUI
   *  that rejects a positional initial prompt (Crush: its first positional is read
   *  as a Cobra SUBCOMMAND → `Unknown command "You are…"`), so the harness must NOT
   *  append the protocol to argv — it spawns the bare TUI and hands the protocol
   *  back as `seedPrompt`, which the renderer types into the TUI's editor after boot
   *  (through the SAME per-pty write-chain as the inbox-wake nudge, so they can't
   *  collide). Absent/undefined = today's flag-or-positional behavior. (ondev-b) */
  seedDelivery?: 'type-into-tui';
  /** This CLI accepts the initial hive prompt as a trailing positional argument.
   *  Codex does; Kimi/custom do not, so they must spawn bare when no prompt flag
   *  exists instead of receiving an invalid positional argument. */
  positionalInitialPrompt?: boolean;
  /** Flag to resume a prior session on respawn, given the recorded session id
   *  (Claude `--resume <sid>`, Antigravity `--conversation <id>`). undefined = no
   *  resume support, spawn fresh. */
  resumeFlag?: string;
  /** Shell command that installs this provider's engine CLI when it's missing,
   *  e.g. `npm install -g @anthropic-ai/claude-code`. When set, the missing-CLI
   *  path may RUN it visibly in the agent terminal (after pre-spawn detection);
   *  when undefined, the user is shown a manual instruction only and nothing is
   *  auto-run. MUST be a trusted, hardcoded constant — never user/manifest input. */
  installCommand?: string;
  /** A SELF-CONTAINED installer that needs no Node/npm at all, per platform.
   *
   *  `installCommand` is `npm install -g …` for every provider, which silently
   *  assumes npm — i.e. node — is already on the machine. When it isn't, the
   *  missing-CLI banner prints a command that CANNOT succeed, so the user watches
   *  an installer fail instead of an app work. Where the vendor ships a native
   *  installer we run that instead (see buildMissingCliScript's ladder).
   *
   *  Trusted, hardcoded constants — never user/manifest input. MUST contain no
   *  double-quotes: the Windows form is wrapped verbatim in `cmd /d /s /c "…"`. */
  nativeInstallCommand?: { posix: string; win32: string };
  /** Optional docs URL surfaced as a manual-setup hint in the missing-CLI banner. */
  docsUrl?: string;
  resumeSubcommand?: string; // CLIs that resume via a subcommand instead of a flag (Codex: `codex resume [OPTIONS] [SESSION_ID]`)
}

export const AGENT_PROVIDER_PRESETS: AgentProviderPreset[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    defaultCommand: 'claude',
    commandGroups: CLAUDE_COMMAND_GROUPS,
    autoModeFlag: '--permission-mode bypassPermissions',
    supportsModel: true,
    modelFlag: '--model',
    autoFlag: '--permission-mode bypassPermissions',
    hiveAware: true,
    canReceiveInbox: true,
    // Longest-context Claude variant — matches the "give Michael a bigger model"
    // advisory and the Recommended tag on the orchestrator picker.
    recommendedOrchestratorModel: 'claude-opus-4-8[1m]',
    resumeFlag: '--resume',
    // Official Claude Code install (npm global). Used by the missing-CLI auto-install.
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    // Anthropic's official native installer — a standalone binary, no node/npm.
    // The only rung of the ladder that works on a machine with no Node at all.
    nativeInstallCommand: {
      posix: 'curl -fsSL https://claude.ai/install.sh | bash',
      win32: 'powershell -c irm https://claude.ai/install.ps1 ^| iex'
    },
    docsUrl: 'https://docs.claude.com/en/docs/claude-code'
  },
  {
    id: 'codex',
    label: 'Codex · GPT',
    defaultCommand: 'codex',
    commandGroups: CODEX_COMMAND_GROUPS,
    // Full claude-parity auto mode: skip ALL approval prompts AND drop the sandbox,
    // exactly like Claude's `bypassPermissions` / agy's `--dangerously-skip-permissions`.
    // The earlier `-a never -s workspace-write` confined writes to the PTY cwd
    // (the user's project), but a hive worker must also write to its agent folder
    // at <harnessHome>/hive/agents/<id>/ (inbox→.done, memory.md, outbox JSON,
    // deliverables) — a DIFFERENT path tree from cwd, which workspace-write blocked,
    // so codex workers couldn't do HIVE PROTOCOL housekeeping. The single bypass flag
    // is codex's documented equivalent of `--dangerously-skip-permissions` (no -a/-s
    // alongside it). The app already runs claude/agy in this same full-access posture.
    autoModeFlag: '--dangerously-bypass-approvals-and-sandbox',
    autoFlag: '--dangerously-bypass-approvals-and-sandbox',
    // Suppresses first-run interactive prompts (directory-trust gate, installer).
    nonInteractiveEnv: { CODEX_NON_INTERACTIVE: '1' },
    supportsModel: true,
    modelFlag: '--model',
    // Codex is NOT hiveAware in the Claude-flag sense: it has no
    // `--append-system-prompt`/`--settings`. The hive protocol is injected as
    // Codex's INITIAL prompt, which it takes POSITIONALLY (`codex "<prompt>"`) —
    // hence initialPromptFlag is undefined and hive.ts appends it as a trailing arg.
    hiveAware: false,
    // …but Codex DOES expose a Claude-style hooks system (hooks.json / config.toml
    // [hooks]; PreToolUse/PostToolUse/Stop/…), so it gets full hive parity via the
    // 'codex' bridge: a per-agent CODEX_HOME/hooks.json wired to the cth-hook shim
    // (see hive.installCodexHooks). Stop→drain works natively (Codex's Stop honors
    // {decision:'block',reason} = continue-with-prompt, exactly like Claude).
    hookBridge: 'codex',
    // Inbox drains via the codex-hook bridge's Stop→drain (the renderer's idle
    // inbox-wake nudge remains as a harmless fallback for an idle worker).
    canReceiveInbox: true,
    initialPromptFlag: undefined,
    positionalInitialPrompt: true,
    // `model/list` verified under ChatGPT login on 2026-08-25 reports this as
    // Codex's default. Keep this in lockstep with CODEX_MODELS in
    // renderer/src/store/config.ts.
    recommendedOrchestratorModel: 'gpt-5.6-sol',
    // Codex resumes via a SUBCOMMAND, not a flag: `codex resume [OPTIONS]
    // [SESSION_ID]`. A `--resume <id>` flag does not exist, which is why restarts
    // used to silently start a brand-new session instead of continuing.
    resumeFlag: undefined,
    resumeSubcommand: 'resume',
    // Official OpenAI Codex CLI install (npm global). Used by the missing-CLI auto-install.
    installCommand: 'npm install -g @openai/codex',
    docsUrl: 'https://github.com/openai/codex'
  },
  {
    id: 'grok',
    label: 'Grok · xAI',
    defaultCommand: 'grok',
    commandGroups: GROK_COMMAND_GROUPS,
    // Grok documents bypassPermissions as the CLI/config spelling of its
    // always-approve mode. Deny rules and lifecycle gates still take precedence.
    autoModeFlag: '--permission-mode bypassPermissions',
    autoFlag: '--permission-mode bypassPermissions',
    supportsModel: true,
    modelFlag: '--model',
    hiveAware: false,
    // Grok supports Claude-compatible lifecycle events but sends camelCase
    // payloads. The bridge normalizes them before forwarding to HookServer.
    hookBridge: 'grok',
    canReceiveInbox: true,
    // `grok [PROMPT]` accepts the initial hive protocol as a positional prompt.
    positionalInitialPrompt: true,
    // Grok resumes interactively with `grok --resume <session-id-or-title>`.
    resumeFlag: '--resume'
  },
  {
    id: 'kimi',
    label: 'Kimi Code',
    defaultCommand: 'kimi',
    commandGroups: [],
    // Kimi --auto handles every approval and does not stop to ask questions,
    // matching Munder Difflin's autonomous Claude/Codex default.
    autoModeFlag: '--auto',
    autoFlag: '--auto',
    supportsModel: true,
    modelFlag: '--model',
    hiveAware: false,
    // Kimi's interactive TUI has no positional initial-prompt form. It supports
    // lifecycle hooks, but Munder Difflin does not yet install a Kimi hook bridge,
    // so mail must bounce rather than being delivered with no drain path.
    canReceiveInbox: false
  },
  {
    // Google's official Gemini CLI. Unlike Antigravity (`agy`), this is the
    // open-source `@google/gemini-cli` binary and uses Gemini's native settings
    // hooks (BeforeTool/AfterTool/BeforeAgent/AfterAgent/SessionStart).
    id: 'gemini',
    label: 'Gemini CLI',
    defaultCommand: 'gemini',
    commandGroups: [],
    // `--yolo` is deprecated upstream; approval-mode is the current spelling.
    autoModeFlag: '--approval-mode=yolo',
    autoFlag: '--approval-mode=yolo',
    supportsModel: true,
    modelFlag: '--model',
    hiveAware: false,
    bridge: { kind: 'hooks', shim: 'gemini' },
    canReceiveInbox: true,
    // Keep the TUI alive after processing the hive protocol seed.
    initialPromptFlag: '-i',
    recommendedOrchestratorModel: 'pro',
    resumeFlag: '--resume',
    installCommand: 'npm install -g @google/gemini-cli',
    docsUrl: 'https://github.com/google-gemini/gemini-cli'
  },
  {
    id: 'antigravity',
    label: 'Antigravity · Gemini',
    defaultCommand: 'agy',
    commandGroups: [],
    autoModeFlag: '--dangerously-skip-permissions',
    supportsModel: true,
    modelFlag: '--model',
    autoFlag: '--dangerously-skip-permissions',
    hiveAware: false,
    hookBridge: 'agy', // installAgyHooks() → ~/.gemini/.../hooks.json (translating shim)
    canReceiveInbox: true, // via the agy-hook bridge (Stop→drain); verified agy honors hook decisions
    initialPromptFlag: '-i', // agy --prompt-interactive: orient the session, then continue
    recommendedOrchestratorModel: 'Gemini 3.1 Pro (High)', // agy takes the display-name label
    resumeFlag: '--conversation' // agy: resume a previous conversation by ID
  },
  {
    // qwen-code — the Qwen CLI (a gemini-cli fork) driving any OpenAI-compatible
    // endpoint (OPENAI_BASE_URL). It has no hook surface, so it rides a PROXY
    // bridge (bridge.kind==='proxy'), with the OpenAI usage/tool-call shape.
    id: 'qwen',
    label: 'Qwen (local available)',
    defaultCommand: 'qwen',
    commandGroups: [],
    // gemini-cli heritage: --yolo auto-approves all actions. // TODO-verify
    autoModeFlag: '--yolo',
    supportsModel: true,
    modelFlag: '--model',
    autoFlag: '--yolo',
    hiveAware: false,
    // SPIKE/TODO-verify: confirm qwen-code reads OPENAI_BASE_URL for its upstream
    // ('serve' inboxDelivery is reserved for a later qwen-serve HTTP push path).
    bridge: { kind: 'proxy', api: 'openai', baseUrlEnv: 'OPENAI_BASE_URL', inboxDelivery: 'terminal' },
    canReceiveInbox: true,
    // gemini-cli style interactive-orient flag. // TODO-verify
    initialPromptFlag: '-i',
    // Qwen's long-context coder model for the orchestrator. // TODO-verify
    recommendedOrchestratorModel: 'qwen3-coder-plus',
    resumeFlag: undefined
  },
  {
    // OpenCode — the TypeScript AI coding agent (opencode.ai / anomalyco/opencode,
    // ex sst/opencode). NOT the archived Go opencode-ai/opencode (→ Crush). Run as
    // its interactive TUI in a PTY (like codex), oriented by --prompt.
    id: 'opencode',
    label: 'OpenCode',
    defaultCommand: 'opencode',
    commandGroups: [],
    // OpenCode's TUI exposes no skip-permissions FLAG; headless auto-approve is a
    // config concern (permission:allow). To keep auto-mode gated behind the floor
    // `config.autoMode` toggle (Pam guardrail #2), the permission JSON is NOT a
    // static nonInteractiveEnv — spawnAgentCore builds OPENCODE_CONFIG_CONTENT
    // dynamically (permission:allow only when autoMode is on; + a local provider
    // block when a base-URL is set). So no auto flag is spliced onto the command.
    autoModeFlag: '',
    autoFlag: '',
    supportsModel: true,
    modelFlag: '--model', // value form: provider/model, e.g. anthropic/claude-sonnet-4-5
    hiveAware: false, // no --append-system-prompt/--settings; protocol rides in via --prompt
    // NATIVE PLUGIN bridge (god Decision 1): OpenCode has no Claude-shaped Stop hook,
    // but its plugin API DOES expose a real lifecycle event (session.idle). A bundled
    // per-agent plugin drains the inbox on idle and posts HIVE_SOCK payloads — the
    // same Stop→drain semantics as codex's hooks, provider-agnostic, no traffic
    // interception. Modeled as a `hooks` bridge with a new `opencode` shim so it
    // reuses the existing hooks dispatch arm (installOpenCodePlugin, sibling of
    // installCodexHooks). The config-injection proxy is the documented fallback only.
    bridge: { kind: 'hooks', shim: 'opencode' },
    // god-eligible. NOTE: the plugin bridge is architecturally verified (event surface
    // + payload contract) but its live runtime (auto-load + session.idle firing +
    // injection) is UNVERIFIED pending BYOK keys / a local LLM. The renderer idle
    // inbox-wake nudge (useHive.ts) is the guaranteed fallback so a god still drains.
    canReceiveInbox: true,
    initialPromptFlag: '--prompt', // opencode --prompt "<orchestrator/worker brief>"
    // NO recommended model — deliberately. This used to preselect
    // `anthropic/claude-sonnet-4-5` under the comment "OpenCode's own default",
    // which was wrong on both halves: it is not OpenCode's default, and it is a
    // BYOK slug that resolves only for a user who has authenticated Anthropic
    // inside OpenCode. Without that key OpenCode SILENTLY falls back to whatever
    // it can reach (observed live on Windows: "DeepSeek V4 Flash Free" via
    // OpenCode Zen) while every surface in this app went on reporting Claude
    // Sonnet 4.5 — the picker said one model, the agent ran another, and nothing
    // flagged the divergence. Undefined means buildSpawnCommand emits no
    // `--model` at all, so OpenCode uses the model the user actually configured;
    // every BYOK slug in OPENCODE_MODELS stays one click away for whoever has
    // the key.
    recommendedOrchestratorModel: undefined,
    // Capturing the TUI session id for resume is unverified; spawn fresh on respawn
    // (protocol re-injected as the initial prompt), matching codex.
    resumeFlag: undefined,
    installCommand: 'npm install -g opencode-ai@latest', // trusted, hardcoded
    // Node-free installers, for the rung that runs when npm is absent AND no Node
    // installer could be resolved (offline / unsupported platform) — until now
    // OpenCode had none, so that rung printed a manual hint and installed nothing.
    // Both are trusted, hardcoded constants and contain no double-quotes (the
    // win32 form is wrapped verbatim in `cmd /d /s /c "…"`).
    //
    // Unlike Claude, OpenCode ships NO standalone Windows one-liner: opencode.ai
    // serves the POSIX install script but has no `install.ps1` (verified 404), and
    // its docs list Chocolatey/Scoop as the Windows-native routes. `-y` because the
    // banner runs the command unattended in the agent terminal. Honest limitation:
    // this rung needs Chocolatey already present; when it isn't, the user sees
    // choco's own "not recognized" error plus the banner's existing "run the
    // command above manually" fallback — no worse off than the manual-only text.
    nativeInstallCommand: {
      posix: 'curl -fsSL https://opencode.ai/install | bash',
      win32: 'choco install opencode -y'
    },
    docsUrl: 'https://opencode.ai/docs'
  },
  {
    // Crush — Charmbracelet's Go TUI coding agent (charmbracelet/crush), successor to
    // the archived Go opencode-ai/opencode. Non-hiveAware. Its hook surface is
    // Claude-shaped but exposes ONLY PreToolUse today (NO Stop/SessionEnd) — so a
    // hooks bridge can't drain on turn-end. Hence a PROXY bridge (qwen tier): a
    // loopback sidecar observes its LLM traffic and SYNTHESIZES the Stop→drain.
    id: 'crush',
    label: 'Crush · Charm',
    defaultCommand: 'crush',
    commandGroups: [],
    // No CODEX_NON_INTERACTIVE analogue. First-run onboarding is suppressed by the
    // harness-written per-agent CRUSH_GLOBAL_CONFIG (provider+model+key pre-seeded),
    // set in env at spawn by installCrushConfig — NOT via this field.
    nonInteractiveEnv: undefined,
    autoModeFlag: '--yolo', // -y: accept all permissions (dangerous; unsandboxed). Gated by config.autoMode.
    autoFlag: '--yolo',
    supportsModel: true,
    modelFlag: '--model', // value format: provider/model-id, e.g. anthropic/claude-..., openai/gpt-4o
    hiveAware: false,
    // PROXY bridge. baseUrlEnv is an INTENTIONALLY INERT sentinel: Crush has NO
    // base-URL env override, so the generic proxy env-rewrite does nothing for it.
    // Real routing is via a per-agent CRUSH_GLOBAL_CONFIG whose provider base_url
    // points at the loopback (installCrushConfig, special-cased in the proxy arm).
    // Do NOT "fix" this to a real env var — it would have no effect.
    bridge: { kind: 'proxy', api: 'openai', baseUrlEnv: 'CRUSH_PROXY_BASE_URL', inboxDelivery: 'terminal' },
    // OpenAI-WIRE default so the out-of-box Crush god routes through the proxy
    // cleanly (the proxy serves one wire-shape; an anthropic/* default would route to
    // the wrong upstream — Dwight verify-crush MF1). Advisory/editable; non-OpenAI-wire
    // Crush-via-proxy is on-device live-verify. // exact long-context id humanQA
    recommendedOrchestratorModel: 'openai/gpt-4o',
    // god-eligible via the proxy bridge (terminal inbox delivery on synthesized idle).
    // Live runtime (proxy parse of Crush traffic + synthesized Stop) is UNVERIFIED
    // pending keys; the renderer idle nudge is the guaranteed drain fallback.
    canReceiveInbox: true,
    // Bare `crush` is an interactive Bubble Tea TUI on a Cobra root command: the
    // first positional is parsed as a SUBCOMMAND, so a positional seed dies with
    // `unknown command "You are…"` (ondev-b live repro / spec-crush MF3). Crush has
    // NO --prompt flag either. So neither flag nor positional works → deliver the
    // protocol by TYPING it into the TUI after boot (renderer nudge path).
    initialPromptFlag: undefined,
    seedDelivery: 'type-into-tui',
    resumeFlag: '--session', // Crush supports resume by id (also --continue for most-recent)
    installCommand: 'npm install -g @charmland/crush', // trusted, hardcoded (brew/go/winget also valid)
    docsUrl: 'https://github.com/charmbracelet/crush'
  },
  {
    // Pi (Pi Coding Agent, earendil-works; npm @earendil-works/pi-coding-agent).
    // Terminal-first, headless-driveable, 15-provider BYOK. Non-hiveAware, but has a
    // rich pi.on(event) lifecycle (tool_call→PreToolUse, agent_end→Stop, …). Bridged
    // via a bundled per-agent extension (installPiHooks) that posts HIVE_SOCK payloads
    // and auto-approves tools — a `hooks` bridge with a new `pi` shim.
    id: 'pi',
    label: 'Pi',
    defaultCommand: 'pi',
    commandGroups: [],
    // pi has NO yolo flag. `--approve` is per-run PROJECT trust (accept the cwd so pi
    // doesn't prompt to trust the folder); the actual tool auto-allow lives INSIDE the
    // bridge extension's tool_call handler, which respects the floor auto-state via
    // HIVE_AUTO_APPROVE env (Pam guardrail #5). Gated by config.autoMode like the rest.
    autoModeFlag: '--approve',
    autoFlag: '--approve',
    // Suppress first-run version-check / telemetry chatter in the PTY. // humanQA exact names
    nonInteractiveEnv: { PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' },
    supportsModel: true,
    modelFlag: '--model', // value form: provider/model, e.g. anthropic/claude-sonnet-4-5 (thinking via :high)
    hiveAware: false,
    // HOOKS bridge via the new `pi` shim (installPiHooks). NOTE: only the structured
    // `bridge` is set (NOT the legacy hookBridge) — bridgeOf returns preset.bridge
    // first, so a hookBridge:'pi' would be dead weight + force a second union widening.
    bridge: { kind: 'hooks', shim: 'pi' },
    recommendedOrchestratorModel: 'anthropic/claude-sonnet-4-5',
    // god-eligible. Live runtime (whether the extension auto-continues from agent_end,
    // or we lean on the renderer idle nudge) is UNVERIFIED pending keys. Renderer nudge
    // is the guaranteed drain fallback either way.
    canReceiveInbox: true,
    initialPromptFlag: undefined, // positional, like codex: pi "<prompt>"
    resumeFlag: '--session',
    // --ignore-scripts: don't run the package's postinstall on the user's machine.
    installCommand: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
    docsUrl: 'https://pi.dev/docs/latest'
  },
  {
    // GitHub Copilot CLI (`copilot`, npm @github/copilot). Driven in print mode:
    // `copilot -p "<prompt>" -s --allow-all-tools --no-ask-user [--model]`, the
    // documented non-interactive shape (single prompt, clean stdout, exits when
    // done). Non-hiveAware: it has no --append-system-prompt/--settings, so the
    // hive identity+protocol rides in as the initial prompt via `-p`.
    id: 'copilot',
    label: 'Copilot',
    defaultCommand: 'copilot',
    commandGroups: [],
    // Non-interactive autonomy: -s prints only the agent's final response (clean
    // stdout), --allow-all-tools never blocks on a permission prompt (env:
    // COPILOT_ALLOW_ALL), --no-ask-user disables the ask_user tool so it never
    // stops to ask. Gated by the floor `config.autoMode` toggle like the rest.
    autoModeFlag: '-s --allow-all-tools --no-ask-user',
    autoFlag: '-s --allow-all-tools --no-ask-user',
    supportsModel: true,
    modelFlag: '--model', // e.g. claude-sonnet-4.5 (default), gpt-5.4, or 'auto'
    hiveAware: false, // no --append-system-prompt/--settings; protocol rides in via -p
    initialPromptFlag: '-p', // copilot -p "<orchestrator/worker brief>" runs it non-interactively
    recommendedOrchestratorModel: 'claude-sonnet-4.5', // Copilot's default; user may pick gpt-5.4
    // Copilot supports session resume by id (`--resume=<id>`); attached only when a
    // prior session id was recorded (no hook bridge captures it yet → best-effort).
    resumeFlag: '--resume',
    // Print mode exits per turn and there is no hook bridge to drain on idle, so a
    // copilot worker can't receive routed inbox mail (it bounces to the god).
    canReceiveInbox: false,
    installCommand: 'npm install -g @github/copilot', // trusted, hardcoded
    docsUrl: 'https://docs.github.com/copilot/concepts/agents/about-copilot-cli'
  },
  {
    // Cursor Agent CLI (`cursor-agent`, https://cursor.com/docs/cli). The official
    // installer puts `cursor-agent` on PATH; `agent` is a shorter alias. Interactive
    // TUI by default (no `-p`), so the session stays alive for hive mail via the
    // renderer idle / work-order path — same class as Crush. Print mode (`-p`) is
    // available for scripts but exits per turn; this preset intentionally does
    // NOT use `-p` so Michael and workers remain god-eligible / inbox-capable.
    // Models (including cheap gpt-5.6-luna-*) bill against Cursor credits via the
    // logged-in CLI — there is no separate "plain OpenAI API" path for Luna.
    id: 'cursor',
    label: 'Cursor',
    defaultCommand: 'cursor-agent',
    commandGroups: [],
    // --force/--yolo: allow tool calls without confirmations. --trust: skip the
    // workspace trust prompt so unattended Mac Mini spawns do not stall. Gated by
    // the floor config.autoMode toggle like every other engine.
    autoModeFlag: '--force --trust',
    autoFlag: '--force --trust',
    supportsModel: true,
    modelFlag: '--model', // e.g. gpt-5.6-luna-high, auto, composer-2.5
    hiveAware: false,
    // No Cursor hook bridge yet — mail delivery uses the terminal work-order /
    // idle-nudge fallback (same honesty as Crush before its proxy is verified).
    canReceiveInbox: true,
    // `cursor-agent` parses early argv as Cobra-style commands (login, models, mcp, …).
    // A long hive protocol string must NOT ride as a positional — type it into
    // the TUI after boot instead (Crush pattern).
    initialPromptFlag: undefined,
    seedDelivery: 'type-into-tui',
    recommendedOrchestratorModel: 'gpt-5.6-luna-high',
    resumeFlag: '--resume',
    // Official install is a curl|bash script (not npm). Prefer the native rung so
    // a node-free machine can still self-heal. Trusted hardcoded constants only.
    nativeInstallCommand: {
      posix: 'curl https://cursor.com/install -fsS | bash',
      win32: 'irm https://cursor.com/install?win32=true | iex'
    },
    docsUrl: 'https://cursor.com/docs/cli/install'
  },
  {
    id: 'custom',
    label: 'Custom',
    defaultCommand: '',
    commandGroups: [],
    autoModeFlag: '',
    supportsModel: false,
    autoFlag: '',
    hiveAware: false,
    canReceiveInbox: false // no inbox-drain path → mail bounces to the god
  }
];

export function isAgentProvider(value: unknown): value is AgentProvider {
  return (
    value === 'claude' ||
    value === 'codex' ||
    value === 'grok' ||
    value === 'kimi' ||
    value === 'gemini' ||
    value === 'antigravity' ||
    value === 'qwen' ||
    value === 'opencode' ||
    value === 'crush' ||
    value === 'pi' ||
    value === 'copilot' ||
    value === 'cursor' ||
    value === 'custom'
  );
}

export function normalizeAgentProvider(value: unknown): AgentProvider | undefined {
  return isAgentProvider(value) ? value : undefined;
}

export function providerPreset(provider: AgentProvider): AgentProviderPreset {
  return AGENT_PROVIDER_PRESETS.find((p) => p.id === provider) ?? AGENT_PROVIDER_PRESETS[0];
}

export function isClaudeProvider(provider: AgentProvider | undefined): boolean {
  return provider === 'claude';
}

/** Whether this provider takes the hive's Claude-only identity injection. */
export function isHiveAwareProvider(provider: AgentProvider | undefined): boolean {
  return providerPreset(provider ?? 'claude').hiveAware;
}

/** Whether the router may deliver inbox mail to this provider (else bounce to
 *  the god). True when lifecycle status supports guarded idle delivery; false
 *  for hookless custom commands. */
export function canReceiveInbox(provider: AgentProvider | undefined): boolean {
  return providerPreset(provider ?? 'claude').canReceiveInbox;
}

/** The bare executable from a command string ('agy --model x' → 'agy'). */
function commandBinary(command: string | undefined): string {
  const first = (command ?? '').trim().split(/\s+/)[0] ?? '';
  // strip a path + extension so 'C:\...\agy.exe' and '/usr/bin/claude' both map
  const leaf = first.split(/[\\/]/).pop() ?? first;
  return leaf.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

/** Infer the provider from a command (or honor an explicit override). */
export function inferAgentProvider(command: string | undefined, explicit?: unknown): AgentProvider {
  const normalized = normalizeAgentProvider(explicit);
  if (normalized) return normalized;
  const bin = commandBinary(command);
  if (bin === 'codex') return 'codex';
  if (bin === 'grok') return 'grok';
  if (bin === 'kimi') return 'kimi';
  if (bin === 'gemini') return 'gemini';
  if (bin === 'agy' || bin === 'antigravity') return 'antigravity';
  if (bin === 'qwen') return 'qwen';
  if (bin === 'opencode') return 'opencode';
  if (bin === 'crush') return 'crush';
  if (bin === 'pi') return 'pi';
  if (bin === 'copilot') return 'copilot';
  // Cursor ships as `cursor-agent`; `agent` is a shorter alias (generic name — check last).
  if (bin === 'cursor-agent') return 'cursor';
  if (bin === 'agent') return 'cursor';
  if (bin === 'claude' || !bin) return 'claude';
  return 'custom';
}

/** The structured bridge descriptor for how a non-hiveAware provider receives hive
 *  lifecycle events. Returns the preset's explicit `bridge` when set (proxy tier:
 *  qwen); else derives `{kind:'hooks', shim}` from the legacy `hookBridge`
 *  (agy/codex), so those keep working untouched; else undefined (claude uses its
 *  native `--settings` path, custom has no bridge). The single accessor call sites
 *  switch on (`bridge.kind`). */
export function bridgeOf(provider: AgentProvider | undefined): BridgeDescriptor | undefined {
  const preset = providerPreset(provider ?? 'claude');
  if (preset.bridge) return preset.bridge;
  if (preset.hookBridge) return { kind: 'hooks', shim: preset.hookBridge };
  return undefined;
}

export function defaultCommandForProvider(provider: AgentProvider, fallback = ''): string {
  if (provider === 'custom') return fallback;
  return providerPreset(provider).defaultCommand || fallback;
}

/** Returns the preset's auto-mode CLI flag for the given provider. Empty string = no flag. */
export function autoModeFlagForProvider(provider: AgentProvider): string {
  return providerPreset(provider).autoModeFlag ?? '';
}

/** Idempotently append a provider's auto-mode flag to an args array, honoring the
 *  user's global autoMode toggle. The renderer's Add Agent flow bakes this same
 *  flag into the command STRING before a GUI hire ever reaches the shared spawn
 *  core (buildSpawnCommand → tokenizeCommand), so `args` for a GUI spawn already
 *  contains it by the time it gets here — this is a no-op for that path. A
 *  main-only spawn (an ephemeral worker, a voice hire) never passes through that
 *  renderer step, so without this it got neither the flag nor any equivalent,
 *  leaving it in an ask-first posture no one could ever answer. */
export function argsWithAutoModeFlag(args: string[], autoMode: boolean, provider: AgentProvider): string[] {
  if (!autoMode) return args;
  const flag = autoModeFlagForProvider(provider);
  if (!flag) return args;
  const tokens = flag.trim().split(/\s+/);
  if (args.includes(tokens[0])) return args;
  return [...args, ...tokens];
}

/** Returns any env vars the provider needs for non-interactive / first-run suppression. */
export function nonInteractiveEnvForProvider(provider: AgentProvider): Record<string, string> {
  return providerPreset(provider).nonInteractiveEnv ?? {};
}

/** Returns the command reference groups for the given provider. */
export function commandGroupsForProvider(provider: AgentProvider): CmdGroup[] {
  return providerPreset(provider).commandGroups ?? [];
}

/** Install metadata for a provider's engine CLI, consumed by the missing-CLI
 *  auto-install path. `command` is the (trusted, hardcoded) installer to run when
 *  present; when undefined the caller shows a manual hint and runs NOTHING. `label`
 *  is the friendly CLI name; `docsUrl` is an optional manual-setup link. */
export interface ProviderInstallInfo {
  command?: string;
  /** A node-free installer for this platform, when the vendor ships one. */
  nativeCommand?: string;
  label: string;
  docsUrl?: string;
}

export function installInfoForProvider(
  provider: AgentProvider,
  platform: string = process.platform
): ProviderInstallInfo {
  const p = providerPreset(provider);
  const native = p.nativeInstallCommand;
  return {
    command: p.installCommand,
    nativeCommand: native ? (platform === 'win32' ? native.win32 : native.posix) : undefined,
    label: p.label,
    docsUrl: p.docsUrl
  };
}

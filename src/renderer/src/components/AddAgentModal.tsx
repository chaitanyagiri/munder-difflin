import { useEffect, useLayoutEffect, useState, type CSSProperties } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { SpritePortrait } from './SpritePortrait';
import { Icon } from './Icon';
import { ProviderLogo } from './ProviderLogo';
import { useStore, type Agent } from '@/store/store';
import { OFFICE_CAST, DEFAULT_CHARACTER, type OfficeCharacterName } from '@/scene/office/cast';
import { type AccentColorName } from '@/design/tokens';
import type { HireManifest } from '@shared/hire';
import { hireQueueProgress } from '@shared/hireQueue';
import { MCP_CATALOG } from '@shared/mcpCatalog';
import {
  OSS_LOCAL_PICKS,
  OSS_PROVIDER_PICKS,
  localSlugFor,
  hasOssQuickPicks,
  OSS_BLOG_LINKS
} from '@shared/ossModels';
import {
  type AgentProvider,
  type HarnessConfig,
  AGENT_PROVIDER_PRESETS,
  buildSpawnCommand,
  tokenizeCommand,
  modelsForProvider,
  inferAgentProvider,
  providerPreset,
  isClaudeProvider
} from '@/store/config';

const ACCENTS: AccentColorName[] = ['coral', 'mint', 'sky', 'lemon', 'lilac', 'peach'];

// OSS quick-pick chip styling (ondev-c) — mirrors the model-picker chips.
const ossChip = (active: boolean, accent: AccentColorName): CSSProperties => ({
  padding: '3px 8px 1px',
  background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
  boxShadow: active ? 'inset 0 0 0 1.5px var(--cth-ink-500)' : 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)', fontSize: 12,
  color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none'
});
const ossGroupHead: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 4
};
const ossLink: CSSProperties = { color: 'var(--cth-ink-900)', textDecoration: 'underline', cursor: 'pointer' };

// One-click briefing templates — fill Description + Goal with a sharp, ready-to-run
// role so a user isn't staring at a blank field (item 7).
const DESCRIPTION_TEMPLATES: { label: string; description: string; goal: string }[] = [
  {
    label: 'Repo janitor',
    description: 'keeps the codebase tidy and healthy',
    goal: 'Continuously hunt for dead code, lint errors, flaky tests, and small safe refactors. Fix the safe ones and leave a note for anything risky. Never change behavior without flagging it.'
  },
  {
    label: 'Docs writer',
    description: 'keeps docs in sync with the code',
    goal: 'Watch for code changes that outdate the README and docs, then update them. Write for newcomers and prefer concrete examples over prose.'
  },
  {
    label: 'Bug triager',
    description: 'investigates and root-causes bugs',
    goal: 'For each reported issue: reproduce it, find the root cause, then propose a minimal fix with evidence. No fixes without a confirmed root cause.'
  },
  {
    label: 'Research assistant',
    description: 'gathers and summarizes information',
    goal: 'Research the questions you are given across multiple sources, verify the key claims, and return a concise, cited summary.'
  },
  {
    label: 'Release manager',
    description: 'prepares and ships releases',
    goal: 'Track what has shipped since the last release, update the changelog and version, and draft clear release notes.'
  }
];

// Copy-paste prompt the user hands to any AI to generate a hire manifest. It pins
// the exact JSON shape the importer accepts and ends with a fill-in section so the
// user adds their own details (item 7). Kept in sync with the HireManifest schema
// (src/shared/hire.ts) — provider allowlist is claude | codex | antigravity | cursor.
const HIRE_PROMPT = `You are designing a "hire" — a ready-to-spawn AI agent for Munder Difflin, an app that runs a team of CLI coding agents. Output ONE JSON object (a hire manifest) and nothing else.

Make the agent genuinely useful: give it a sharp role, a concrete standing goal, and a description that makes it behave like an expert operator of its CLI engine (Claude Code, Codex, or Antigravity/Gemini). It should know how to use the terminal, read and edit files, run and inspect commands, lean on available skills and MCP tools, keep notes in memory, and work autonomously toward its goal without hand-holding.

Return EXACTLY this shape (omit optional fields you don't need; keep the spec string verbatim):

{
  "spec": "munder-difflin/hire@1",
  "name": "Jim",
  "description": "one-line role — what this agent is for",
  "goal": "standing directive injected on every prompt — specific and outcome-oriented",
  "provider": "claude",
  "model": "claude-opus-4-8[1m]",
  "capabilities": ["code-review", "docs"],
  "isolate": false,
  "tokenCap": 2000000,
  "author": "your name"
}

Rules:
- "provider" MUST be one of: cursor | claude | codex | antigravity. "model" must be a real model id for that provider (e.g. gpt-5.6-luna-high, claude-opus-4-8[1m], gpt-5.6-sol, "Gemini 3.1 Pro (High)").
- Do NOT include shell commands or any flags beyond these fields.
- Make "description" + "goal" concrete enough that the agent knows exactly what to do on its first turn.

--- ADD YOUR DETAILS BELOW (the AI should use these) ---
Role / what I want this agent to do:
Preferred engine (claude / codex / antigravity), if any:
Repos, tools, style, or constraints to respect:
`;

// The Add Agent form has 11+ fields, so it's grouped into sections the user jumps
// between via a left sidebar index (one section shown at a time). Engine carries
// Command (it's the spawn command assembled from provider+model+flags); Workspace
// clusters Folder + Git isolation + Resume (all "where/how it runs"). Capabilities
// isn't a field here — it rides an imported hire manifest (the pinned banner).
type SectionKey = 'identity' | 'workspace' | 'engine' | 'briefing';
const SECTIONS: { key: SectionKey; label: string; hint: string }[] = [
  { key: 'identity',  label: 'Identity',  hint: 'name · character · color' },
  { key: 'workspace', label: 'Workspace', hint: 'folder · isolation · resume' },
  { key: 'engine',    label: 'Engine',    hint: 'provider · model · command' },
  { key: 'briefing',  label: 'Briefing',  hint: 'role · goal' }
];

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function uniqueId(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`;
}

export interface AddAgentModalProps {
  onClose: () => void;
  config: HarnessConfig;
  /** Lift config changes (e.g. a project registered from this modal) back up to
   *  App so the rest of the UI — and the next time this modal opens — sees them. */
  onConfigChange?: (config: HarnessConfig) => void;
}

export function AddAgentModal({ onClose, config, onConfigChange }: AddAgentModalProps) {
  const addAgent = useStore(s => s.addAgent);
  // Deep links and file batches share one FIFO. The head alone seeds the form;
  // every item still requires an explicit spawn or skip.
  const hireQueue = useStore(s => s.hireQueue);
  const enqueuePendingHires = useStore(s => s.enqueuePendingHires);
  const finishPendingHire = useStore(s => s.finishPendingHire);
  const pendingHire = hireQueue.pending[0];
  const reviewProgress = hireQueueProgress(hireQueue);

  const knownCharacter = (c?: string): OfficeCharacterName =>
    (OFFICE_CAST.some(m => m.name === c) ? (c as OfficeCharacterName) : DEFAULT_CHARACTER);
  const knownAccent = (a?: string): AccentColorName =>
    (ACCENTS.includes(a as AccentColorName) ? (a as AccentColorName) : 'sky');
  /** The cast member a typed name refers to, if any.
   *
   *  The character tiles already set the name (clicking Meredith names the agent
   *  Meredith), but the coupling ran ONE WAY, so typing "Meredith" left the
   *  avatar on whatever was selected, in practice the Jim default. Same missing
   *  default as issue #191 from the other direction, where a manifest that omits
   *  `character` always lands on Jim.
   *
   *  Returns null on no match, and the caller leaves the avatar alone, so a
   *  deliberate pick is never overwritten by continuing to type. */
  const characterForName = (n: string): OfficeCharacterName | null => {
    const q = n.trim().toLowerCase();
    if (!q) return null;
    const hit = OFFICE_CAST.find(c => c.displayName.toLowerCase() === q || c.name === q);
    return hit ? hit.name : null;
  };
  /** The locally-built spawn command for a manifest: provider preset + model
   *  from the LOCAL config builder, with the manifest's validated flags
   *  appended. A manifest can never name the binary itself. */
  const hireCommand = (m: HireManifest): string => {
    const prov: AgentProvider = m.provider ?? inferAgentProvider(config.defaultCommand);
    const base = buildSpawnCommand(config, m.model, prov);
    return m.commandFlags?.length ? `${base} ${m.commandFlags.join(' ')}` : base;
  };

  // Default provider follows whatever the global default command is (claude
  // unless the user reconfigured it); the model only carries over for Claude.
  const initialProvider = inferAgentProvider(config.defaultCommand);
  const initialModel = isClaudeProvider(initialProvider) ? config.defaultModel : undefined;

  const [name, setName] = useState(pendingHire?.name ?? 'Jim');
  const [character, setCharacter] = useState<OfficeCharacterName>(knownCharacter(pendingHire?.character));
  const [accent, setAccent] = useState<AccentColorName>(knownAccent(pendingHire?.accent));
  const [cwd, setCwd] = useState<string>(config.registeredRepos[0] ?? '');
  // Local mirror of the registered projects so one added from here shows as a
  // quick-pick immediately (the `config` prop is a snapshot taken at open time).
  const [repos, setRepos] = useState<string[]>(config.registeredRepos);
  const [provider, setProvider] = useState<AgentProvider>(pendingHire?.provider ?? initialProvider);
  const [model, setModel] = useState<string | undefined>(
    pendingHire ? pendingHire.model : initialModel
  );
  const [command, setCommand] = useState(
    pendingHire ? hireCommand(pendingHire) : buildSpawnCommand(config, initialModel, initialProvider)
  );
  const [description, setDescription] = useState(pendingHire?.description ?? 'a fresh harness');
  const [hireMeta, setHireMeta] = useState<HireManifest | null>(pendingHire);

  // Picking a model rebuilds the command; the command field stays editable for
  // power users (it's the source of truth for the actual spawn).
  const pickModel = (id?: string) => {
    setModel(id);
    setCommand(buildSpawnCommand(config, id, provider));
  };
  // Switching provider resets the model to that CLI's default and rebuilds the
  // command from the provider's preset binary (so Antigravity spawns `agy` and
  // Codex spawns `codex`, not the configured `claude`). For 'custom' we keep the
  // user's typed command rather than blanking it.
  const pickProvider = (id: AgentProvider) => {
    setProvider(id);
    // Seed the model: Claude from the global defaultModel; other engines from the
    // per-engine default set in Settings → AI Engines (providerDefaultModels), else
    // the CLI default. This is what makes that Settings field live (Dwight NIT-1).
    const nextModel = isClaudeProvider(id) ? config.defaultModel : config.providerDefaultModels?.[id];
    setModel(nextModel);
    const nextPreset = providerPreset(id);
    if (!isClaudeProvider(id) && !nextPreset.resumeFlag && !nextPreset.resumeSubcommand) {
      setResumeSessionId('');
      setFolderNote(undefined);
    }
    if (id === 'custom') {
      setCommand(command.trim() || config.defaultCommand || '');
      return;
    }
    setCommand(buildSpawnCommand(config, nextModel, id));
  };
  const preset = providerPreset(provider);
  const [goal, setGoal] = useState(pendingHire?.goal ?? '');
  const [isolate, setIsolate] = useState(pendingHire?.isolate ?? false);
  // #2 — optional Claude session id to continue. When set, the spawn seeds that
  // session's transcript into the cwd's project dir and launches `--resume`.
  const [resumeSessionId, setResumeSessionId] = useState('');
  const resuming = resumeSessionId.trim().length > 0;
  // Note shown when the folder was auto-filled from the pasted session id.
  const [folderNote, setFolderNote] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  // Which config section the left sidebar index is showing.
  const [section, setSection] = useState<SectionKey>('identity');
  // "Generate a hire with AI" helper — reveals a copy-paste prompt (item 7).
  const [showHirePrompt, setShowHirePrompt] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const copyHirePrompt = async () => {
    try {
      await navigator.clipboard.writeText(HIRE_PROMPT);
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 1500);
    } catch { /* clipboard blocked — the textarea below is selectable as a fallback */ }
  };

  // Close only the modal on Esc. Capture prevents the fullscreen terminal's
  // window-level handler from also closing the view underneath.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Zero-step resume: when a session id is entered, look up the cwd it originally
  // ran in (from the transcript) and pre-fill the Folder so the user doesn't have
  // to find the worktree. They can still override the folder afterwards. Runs on
  // blur so we don't hit the resolver on every keystroke.
  const resolveFolderFromSession = async () => {
    const sid = resumeSessionId.trim();
    if (!sid) { setFolderNote(undefined); return; }
    const resolved = await window.cth.resolveSessionCwd(sid);
    if (resolved) { setCwd(resolved); setFolderNote(`folder set from session: ${resolved}`); }
    else setFolderNote(undefined);
  };

  const pickFolder = async () => {
    setError(undefined);
    const res = await window.cth.chooseFolder();
    if (res.ok) setCwd(res.path);
    else if (res.error !== 'cancelled') setError(res.error);
  };

  /** Register `path` as a project (folder quick-pick) right now: dedupe-prepend,
   *  select it, persist to config, and lift the change up so it sticks. */
  const registerProject = async (path: string) => {
    const p = path.trim();
    if (!p) return;
    const next = [p, ...repos.filter((r) => r !== p)];
    setRepos(next);
    setCwd(p);
    try {
      const updated = await window.cth.updateConfig({ registeredRepos: next });
      // Main expands `~` when it persists registeredRepos, so adopt the stored
      // (absolute) list — otherwise a typed "~/dev/foo" stays literal in this
      // modal's state and rides along into the spawn.
      const stored = updated.registeredRepos ?? next;
      setRepos(stored);
      if (stored[0]) setCwd(stored[0]);
      onConfigChange?.(updated);
    } catch { /* best-effort persist */ }
  };

  /** Drop `path` from the project quick-picks.
   *
   *  Removes it from the LISTING only. The folder on disk is never touched, which
   *  is the whole point: a project you are done with should stop cluttering the
   *  picker without anything being deleted. */
  const unregisterProject = async (path: string) => {
    const next = repos.filter((r) => r !== path);
    setRepos(next);
    try {
      const updated = await window.cth.updateConfig({ registeredRepos: next });
      setRepos(updated.registeredRepos ?? next);
      onConfigChange?.(updated);
    } catch { /* best-effort persist */ }
  };

  /** Pick a brand-new folder and register it as a project in one step. */
  const addProject = async () => {
    setError(undefined);
    const res = await window.cth.chooseFolder();
    if (res.ok) await registerProject(res.path);
    else if (res.error !== 'cancelled') setError(res.error);
  };

  /** Apply an imported manifest to every form field (file import path). The
   *  command is rebuilt locally from the provider preset + validated flags — a
   *  manifest can never inject the spawn binary. Import never spawns. */
  const applyManifest = (m: HireManifest) => {
    setHireMeta(m);
    setName(m.name);
    // A manifest that names an agent but omits `character` should get the
    // matching avatar rather than the Jim default (issue #191).
    setCharacter(m.character ? knownCharacter(m.character) : (characterForName(m.name ?? '') ?? knownCharacter(undefined)));
    setAccent(knownAccent(m.accent));
    setProvider(m.provider ?? initialProvider);
    setModel(m.model);
    setCommand(hireCommand(m));
    setDescription(m.description ?? 'a fresh harness');
    setGoal(m.goal ?? '');
    setIsolate(m.isolate ?? false);
    setResumeSessionId('');
    setFolderNote(undefined);
    setSection('identity');
  };

  // Advancing a batch keeps this modal mounted. Re-seed every form field when
  // the queue head changes so edits made while reviewing one hire cannot leak
  // into the next.
  useLayoutEffect(() => {
    if (pendingHire) applyManifest(pendingHire);
  // applyManifest intentionally closes over the config snapshot used by this
  // open modal; queue advances do not replace that snapshot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingHire]);

  const advanceHireReview = () => {
    const next = hireQueue.pending[1];
    // The pendingHire effect re-seeds every form field from the new queue head.
    finishPendingHire();
    if (!next) onClose();
  };

  const importHire = async () => {
    setError(undefined);
    const res = await window.cth.importHireFiles();
    if (res.manifests.length > 0) enqueuePendingHires(res.manifests);
    if (res.errors.length > 0) {
      const noun = res.errors.length === 1 ? 'file' : 'files';
      setError(`Skipped ${res.errors.length} invalid ${noun}: ${res.errors.join(' · ')}`);
    } else if (!res.ok && res.error && res.error !== 'cancelled') {
      setError(res.error);
    }
  };

  const skipHire = () => {
    if (!pendingHire) return;
    setError(undefined);
    advanceHireReview();
  };

  const submit = async () => {
    setError(undefined);
    // A required field can live in a section the user hasn't opened, so jump to
    // the offending section as we surface the error — the field is never hidden.
    if (!name.trim()) { setError('Name is required'); setSection('identity'); return; }
    if (!cwd) { setError('Pick a folder first'); setSection('workspace'); return; }
    if (!command.trim()) { setError('Command is required'); setSection('engine'); return; }

    setBusy(true);
    const id = uniqueId(name);
    const ptyId = `pty-${id}`;
    // Split the editable command field into argv-style pieces for node-pty.
    // Quote-aware so an agy model label like "Gemini 3.1 Pro (High)" — or any
    // auto-mode flags appended to the command — stays one argument.
    const [exe, ...args] = tokenizeCommand(command.trim());
    const spawnRes = await window.cth.spawnPty({
      id: ptyId,
      cwd,
      command: exe,
      provider,
      args,
      cols: 100,
      rows: 30,
      // When set, the main process spawns this agent in its own git worktree.
      // Forced OFF when resuming a session — `--resume` needs the real cwd's
      // transcript, not a fresh worktree with a different (empty) project dir.
      isolate: resuming ? false : isolate,
      // #2 — continue an existing Claude session in this agent's cwd.
      resumeSessionId: resuming ? resumeSessionId.trim() : undefined,
      // Provision this agent in the hive (memory + mailbox + identity/protocol).
      hive: {
        id,
        name: name.trim(),
        provider,
        cwd,
        role: description.trim() || undefined,
        // A hire manifest may carry validated capability tags (routing hints).
        capabilities: hireMeta?.capabilities
      }
    });
    if (!spawnRes.ok) {
      setBusy(false);
      setError(spawnRes.error ?? 'spawn failed');
      return;
    }
    // #2 — the requested resume session id wasn't found anywhere; main fell back
    // to a fresh session. Don't block the spawn, but make it visible.
    if (resuming && spawnRes.resumeNotFound) {
      console.warn(`[add-agent] resume session "${resumeSessionId.trim()}" not found — started a fresh session`);
    }

    // Main expands `~` at ingestion and echoes back the absolute path it actually
    // spawned into — record THAT, so this agent's cwd matches the hive registry
    // (and survives a restart, where nothing re-expands it).
    const spawnedCwd = spawnRes.cwd || cwd;
    // With git isolation the agent RUNS in its own worktree, but its PROJECT is
    // still the folder the user picked. Labelling the agent with the worktree's
    // name was the visible half; the damaging half was promoting that worktree
    // into registeredRepos below, which turned the project quick-picks into a
    // list of throwaway worktrees. Mirrors the `isolate` sent to main, which is
    // forced off while resuming.
    const projectCwd = (!resuming && isolate) ? cwd.trim() : spawnedCwd;
    const agent: Agent = {
      id,
      name: name.trim(),
      character,
      accent,
      description: description.trim() || 'a fresh harness',
      project: basename(projectCwd),
      tmuxTarget: '',
      cwd: spawnedCwd,
      goal: goal.trim() || undefined,
      status: 'idle',
      action: resuming && spawnRes.resumeNotFound ? 'session not found — fresh start' : 'starting up',
      progress: 0,
      currentStation: 'desk',
      ptyId,
      command: command.trim(),
      provider,
      model,
      // Persist the resolved worktree path (set only when isolation provisioned
      // one) so a restart can re-enter this exact worktree — see restoreTeam.
      worktreePath: spawnRes.worktreePath,
      // Crush (seedDelivery:'type-into-tui') hands its hive protocol back here
      // instead of on argv; useHive types it into the TUI after boot. (ondev-b)
      seedPrompt: spawnRes.seedPrompt,
      recentTextTs: Date.now()
    };
    addAgent(agent);
    // Remember the folder for the next hire: promote it to the front of the
    // registeredRepos quick-picks (the modal's default cwd) so back-to-back
    // hires land in the same project without re-picking.
    if (projectCwd && repos[0] !== projectCwd) {
      const nextRepos = [projectCwd, ...repos.filter((r) => r !== projectCwd && r !== cwd)];
      try {
        const updated = await window.cth.updateConfig({ registeredRepos: nextRepos });
        onConfigChange?.(updated);
      } catch { /* best-effort */ }
    }
    // A hire manifest may carry a per-agent token budget — apply it to the
    // latest agentTokenCaps map in main. Await it before advancing a batch: the
    // next hire reuses this mounted modal and must not race a stale config write.
    if (hireMeta?.tokenCap) {
      try {
        const updated = await window.cth.setAgentTokenCap(id, hireMeta.tokenCap);
        onConfigChange?.(updated);
      } catch { /* best-effort */ }
    }
    setBusy(false);
    if (pendingHire) {
      advanceHireReview();
    } else {
      onClose();
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(26, 19, 32, 0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        // Must sit above fullscreen terminal/file overlays (250/280) and their
        // hover popovers. The fullscreen Add Agent button uses this same modal.
        zIndex: 500
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: 940, maxWidth: '95vw' }}>
        <PixelPanel
          variant="dialog"
          title="ADD AGENT"
          style={{ padding: 16 }}
          noPadding
        >
          {/* Sectioned config with a left sidebar index. The form has 11+ fields,
              so they're grouped into 4 sections (Identity / Workspace / Engine /
              Briefing) shown one at a time; the sidebar jumps between them. The
              hire-import review banner, the error, and the footer stay pinned
              around the section pane. maxHeight keeps the dialog within the
              viewport (title bar stays pinned). */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, maxHeight: '86vh', overflowY: 'auto' }}>
            {hireMeta && (
              <div style={{
                padding: '6px 10px',
                background: 'var(--cth-lemon-light, #fdf3cf)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                fontSize: 12,
                color: 'var(--cth-ink-900)',
                display: 'flex', flexDirection: 'column', gap: 2
              }}>
                <span>
                  📋 hire imported: <strong>{hireMeta.name}</strong>
                  {hireMeta.author ? <> · by {hireMeta.author}</> : null}
                  {reviewProgress ? <> · hire {reviewProgress.current} of {reviewProgress.total}</> : null}
                </span>
                <span>review every field — especially the command — before spawning.</span>
                {hireMeta.commandFlags && hireMeta.commandFlags.length > 0 && (
                  <span style={{ display: 'flex', gap: 4, alignItems: 'baseline', flexWrap: 'wrap', marginTop: 2 }}>
                    <span style={{ fontSize: 12 }}>⚠️ flags this hire appends to the command:</span>
                    {hireMeta.commandFlags.map((f, i) => (
                      <code
                        key={`${f}-${i}`}
                        style={{
                          fontFamily: 'var(--cth-font-mono)',
                          fontSize: 12,
                          padding: '0 4px',
                          background: 'var(--cth-paprika-light, #f6d3c4)',
                          boxShadow: 'inset 0 0 0 1px var(--cth-paprika-700, #b3502e)',
                          color: 'var(--cth-ink-900)'
                        }}
                      >
                        {f}
                      </code>
                    ))}
                  </span>
                )}
                {hireMeta.skills && hireMeta.skills.length > 0 && (
                  <span style={{ display: 'flex', gap: 4, alignItems: 'baseline', flexWrap: 'wrap', marginTop: 2 }}>
                    <span style={{ fontSize: 12 }}>skills this hire activates:</span>
                    {hireMeta.skills.map((s) => (
                      <code
                        key={s}
                        style={{
                          fontFamily: 'var(--cth-font-mono)',
                          fontSize: 12,
                          padding: '0 4px',
                          background: 'var(--cth-mint-light, #d0f0e0)',
                          boxShadow: 'inset 0 0 0 1px var(--cth-mint-700, #1f7a4d)',
                          color: 'var(--cth-ink-900)'
                        }}
                      >
                        {s}
                      </code>
                    ))}
                  </span>
                )}
                {hireMeta.mcpServers && hireMeta.mcpServers.length > 0 && (() => {
                  const safe = hireMeta.mcpServers!.filter(
                    (id) => MCP_CATALOG.find((e) => e.id === id)?.tier === 'safe-readonly'
                  );
                  const consent = hireMeta.mcpServers!.filter(
                    (id) => MCP_CATALOG.find((e) => e.id === id)?.tier !== 'safe-readonly'
                  );
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 2 }}>
                      {safe.length > 0 && (
                        <span style={{ display: 'flex', gap: 4, alignItems: 'baseline', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 12 }}>MCP servers (safe, pre-enabled):</span>
                          {safe.map((id) => (
                            <code key={id} style={{
                              fontFamily: 'var(--cth-font-mono)', fontSize: 12, padding: '0 4px',
                              background: 'var(--cth-sky-light, #d0e8f8)',
                              boxShadow: 'inset 0 0 0 1px var(--cth-sky-700, #1f5a8a)',
                              color: 'var(--cth-ink-900)'
                            }}>{id}</code>
                          ))}
                        </span>
                      )}
                      {consent.length > 0 && (
                        <span style={{ display: 'flex', gap: 4, alignItems: 'baseline', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 12 }}>⚠️ MCP (needs your consent — NOT auto-enabled):</span>
                          {consent.map((id) => (
                            <code key={id} style={{
                              fontFamily: 'var(--cth-font-mono)', fontSize: 12, padding: '0 4px',
                              background: 'var(--cth-paprika-light, #f6d3c4)',
                              boxShadow: 'inset 0 0 0 1px var(--cth-paprika-700, #b3502e)',
                              color: 'var(--cth-ink-900)'
                            }}>{id}</code>
                          ))}
                          <span style={{ fontSize: 11, color: 'var(--cth-ink-700)' }}>
                            — enable in Settings → MCP after reviewing
                          </span>
                        </span>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}

            {/* sidebar index + the active section's fields */}
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              {/* LEFT — section index. Capabilities isn't a nav item: it isn't a
                  user field, it rides the imported hire manifest (banner above). */}
              <nav style={{ width: 168, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {SECTIONS.map((s, i) => {
                  const active = section === s.key;
                  return (
                    <button
                      key={s.key}
                      onClick={() => setSection(s.key)}
                      style={{
                        textAlign: 'left', padding: '6px 9px 5px', border: 'none', cursor: 'pointer',
                        background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                        boxShadow: active
                          ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                          : 'inset 0 0 0 1px var(--cth-ink-100)',
                        display: 'flex', flexDirection: 'column', gap: 1
                      }}
                    >
                      <span style={{
                        fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '13px',
                        color: 'var(--cth-ink-900)', textTransform: 'uppercase',
                        display: 'flex', alignItems: 'baseline', gap: 6
                      }}>
                        <span style={{ color: active ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)' }}>{i + 1}</span>
                        {s.label}
                      </span>
                      <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-500)' }}>
                        {s.hint}
                      </span>
                    </button>
                  );
                })}
              </nav>

              {/* RIGHT — the active section's fields */}
              <div style={{ flex: 1, minWidth: 0, minHeight: 260, display: 'flex', flexDirection: 'column', gap: 12 }}>
                {section === 'identity' && (
                  <>
                    <Row label="Name">
                      <input
                        value={name}
                        onChange={(e) => {
                          const next = e.target.value;
                          setName(next);
                          const match = characterForName(next);
                          if (match) setCharacter(match);
                        }}
                        placeholder="Ada"
                        style={inputStyle}
                      />
                    </Row>

                    <Row label="Character">
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {OFFICE_CAST.map(c => (
                          <button
                            key={c.name}
                            onClick={() => { setCharacter(c.name); setName(c.displayName); }}
                            title={c.blurb}
                            style={{
                              padding: 4,
                              background: character === c.name ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                              boxShadow: character === c.name
                                ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                                : 'inset 0 0 0 1px var(--cth-ink-100)',
                              cursor: 'pointer',
                              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                              border: 'none', width: 56
                            }}
                          >
                            <div style={{ width: 44, height: 56, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden' }}>
                              <SpritePortrait character={c.name} scale={2} />
                            </div>
                            <span style={{ fontSize: 11, color: 'var(--cth-ink-700)' }}>{c.displayName}</span>
                          </button>
                        ))}
                      </div>
                    </Row>

                    <Row label="Color">
                      <div style={{ display: 'flex', gap: 6 }}>
                        {ACCENTS.map(a => (
                          <button
                            key={a}
                            onClick={() => setAccent(a)}
                            style={{
                              width: 32, height: 32,
                              background: `var(--cth-${a})`,
                              boxShadow: accent === a
                                ? 'inset 0 0 0 1.5px var(--cth-ink-500), 0 0 0 2px var(--cth-ink-900)'
                                : 'inset 0 0 0 1px var(--cth-ink-300)',
                              cursor: 'pointer',
                              border: 'none'
                            }}
                            aria-label={a}
                          />
                        ))}
                      </div>
                    </Row>
                  </>
                )}

                {section === 'workspace' && (
                  <>
                    <Row label="Project">
                      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                        <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                          {repos.length > 0 ? 'Pick a project, or add a new one:' : 'No projects yet — add one to get started:'}
                        </span>
                        <button
                          onClick={addProject}
                          title="Pick a folder and register it as a project"
                          style={{
                            flexShrink: 0, padding: '2px 8px 1px', border: 'none', cursor: 'pointer',
                            background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                            fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)',
                            display: 'inline-flex', alignItems: 'center', gap: 4
                          }}
                        >
                          <Icon name="plus" /> add project
                        </button>
                      </div>
                      {repos.length > 0 && (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                          {repos.map((r) => (
                            /* Two buttons per chip: pick the project, or drop it
                               from this list. Nested in a span rather than one
                               button so the remove control is not a button inside
                               a button. */
                            <span
                              key={r}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'stretch',
                                background: cwd === r ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                                boxShadow: cwd === r
                                  ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                                  : 'inset 0 0 0 1px var(--cth-ink-100)'
                              }}
                            >
                              <button
                                onClick={() => setCwd(r)}
                                title={r}
                                style={{
                                  padding: '3px 4px 1px 8px',
                                  background: 'transparent',
                                  fontFamily: 'var(--cth-font-ui)',
                                  fontSize: 12,
                                  cursor: 'pointer',
                                  border: 'none'
                                }}
                              >
                                {basename(r)}
                              </button>
                              <button
                                onClick={() => unregisterProject(r)}
                                title={`Remove ${basename(r)} from this list. The folder itself is left alone.`}
                                aria-label={`Remove ${basename(r)} from the project list`}
                                style={{
                                  padding: '3px 6px 1px 2px',
                                  background: 'transparent',
                                  fontFamily: 'var(--cth-font-ui)',
                                  fontSize: 12,
                                  lineHeight: 1,
                                  color: 'var(--cth-ink-500)',
                                  cursor: 'pointer',
                                  border: 'none'
                                }}
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input
                          value={cwd}
                          onChange={(e) => setCwd(e.target.value)}
                          placeholder="/path/to/your/project"
                          style={{ ...inputStyle, flex: 1, fontFamily: 'var(--cth-font-mono)', fontSize: 13 }}
                        />
                        <PixelButton variant="secondary" size="md" onClick={pickFolder}>
                          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                            <Icon name="folder" /> pick
                          </span>
                        </PixelButton>
                      </div>
                      {cwd.trim() && !repos.includes(cwd.trim()) && (
                        <button
                          onClick={() => registerProject(cwd)}
                          title="Save this folder to your projects so it's a one-click pick next time"
                          style={{
                            alignSelf: 'flex-start', marginTop: 2,
                            padding: '2px 8px 1px', border: 'none', cursor: 'pointer',
                            background: 'var(--cth-mint-light)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                            fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)',
                            display: 'inline-flex', alignItems: 'center', gap: 4
                          }}
                        >
                          <Icon name="plus" /> save as project
                        </button>
                      )}
                    </Row>

                    <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: resuming ? 'not-allowed' : 'pointer', opacity: resuming ? 0.5 : 1 }}>
                      <input
                        type="checkbox"
                        checked={resuming ? false : isolate}
                        disabled={resuming}
                        onChange={(e) => setIsolate(e.target.checked)}
                        style={{ width: 16, height: 16, cursor: resuming ? 'not-allowed' : 'pointer' }}
                      />
                      <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)' }}>
                        Git isolation (own worktree)
                      </span>
                    </label>

                    <Row label="Resume session ID (optional)">
                      <input
                        value={resumeSessionId}
                        onChange={(e) => { setResumeSessionId(e.target.value); setFolderNote(undefined); }}
                        onBlur={resolveFolderFromSession}
                        placeholder="paste a Claude session id to continue its conversation"
                        style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)', fontSize: 13 }}
                      />
                      {folderNote && (
                        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-mint, var(--cth-ink-700))' }}>
                          {folderNote}
                        </span>
                      )}
                      {resuming && (
                        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-700)' }}>
                          Will resume this session in the chosen folder (git isolation disabled).
                        </span>
                      )}
                    </Row>
                  </>
                )}

                {section === 'engine' && (
                  <>
                    <Row label="Provider">
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {AGENT_PROVIDER_PRESETS.map((p) => {
                          const active = provider === p.id;
                          return (
                            <button
                              key={p.id}
                              onClick={() => pickProvider(p.id)}
                              title={
                                p.id === 'antigravity'
                                  ? 'Spawn the Antigravity CLI (agy) with a Gemini model'
                                  : p.id === 'codex'
                                    ? 'Spawn the Codex CLI (codex) without Claude-only flags'
                                    : p.id === 'custom'
                                      ? 'Run any command — no Claude-only flags'
                                      : p.label
                              }
                              style={{
                                padding: '3px 8px 1px',
                                background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                                boxShadow: active
                                  ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                                  : 'inset 0 0 0 1px var(--cth-ink-100)',
                                fontFamily: 'var(--cth-font-ui)', fontSize: 12,
                                color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none',
                                display: 'inline-flex', alignItems: 'center', gap: 6
                              }}
                            >
                              <ProviderLogo provider={p.id} size={14} />
                              {p.label}
                            </button>
                          );
                        })}
                      </div>
                    </Row>

                    {preset.supportsModel && <Row label="Model">
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {(() => {
                          // An imported hire may name a model newer than this picker's
                          // hardcoded list (e.g. claude-fable-5). Surface it as a real,
                          // selected card instead of leaving the picker looking unset —
                          // the command field already carries it either way.
                          const known = modelsForProvider(provider);
                          return model && !known.some((m) => m.id === model)
                            ? [...known, { id: model, label: `${model} (from hire)` }]
                            : known;
                        })().map((m) => {
                          const active = (model ?? '') === (m.id ?? '');
                          return (
                            <button
                              key={m.label}
                              onClick={() => pickModel(m.id)}
                              title={m.id ?? 'CLI default model'}
                              style={{
                                padding: '3px 8px 1px',
                                background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                                boxShadow: active
                                  ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                                  : 'inset 0 0 0 1px var(--cth-ink-100)',
                                fontFamily: 'var(--cth-font-ui)', fontSize: 12,
                                color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none'
                              }}
                            >
                              {m.label}
                            </button>
                          );
                        })}
                      </div>
                    </Row>}

                    {/* OSS-model quick-picks (ondev-c) — local + third-party-provider
                        shortlists from the verified catalog. Clicking sets the
                        engine-correct slug (OpenCode `local/<tag>`, Crush/pi
                        `ollama/<tag>`; provider slugs are identical across engines)
                        and rebuilds the command. */}
                    {hasOssQuickPicks(provider) && (
                      <Row label="OSS models">
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <div>
                            <div style={ossGroupHead}>Local · no key (Ollama / LM Studio)</div>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              {OSS_LOCAL_PICKS.map((p) => {
                                const slug = localSlugFor(provider, p.tag);
                                const active = (model ?? '') === slug;
                                return (
                                  <button
                                    key={p.tag}
                                    onClick={() => pickModel(slug)}
                                    title={`${slug} · needs ~${p.minRam} RAM — pull with: ollama pull ${p.tag}`}
                                    style={ossChip(active, accent)}
                                  >
                                    {p.label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                          <div>
                            <div style={ossGroupHead}>Via OSS provider · BYOK</div>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              {OSS_PROVIDER_PICKS.map((p) => {
                                const active = (model ?? '') === p.slug;
                                return (
                                  <button
                                    key={p.slug}
                                    onClick={() => pickModel(p.slug)}
                                    title={`${p.slug} · set ${p.keyEnv} in Settings → AI Engines`}
                                    style={ossChip(active, accent)}
                                  >
                                    {p.label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      </Row>
                    )}

                    {(provider === 'opencode' || provider === 'crush' || provider === 'pi' || provider === 'qwen') && (
                      <div style={{ fontSize: 12, color: 'var(--cth-ink-500)', lineHeight: '16px', margin: '2px 0 6px' }}>
                        BYOK keys &amp; local endpoints for this engine live in <strong>Settings → AI Engines</strong>.
                        {' '}New to local models? Read{' '}
                        <a
                          href={OSS_BLOG_LINKS.openModels}
                          onClick={(e) => { e.preventDefault(); void window.cth.openExternal(OSS_BLOG_LINKS.openModels); }}
                          style={ossLink}
                        >run on open models</a>
                        {' '}or{' '}
                        <a
                          href={OSS_BLOG_LINKS.macMini}
                          onClick={(e) => { e.preventDefault(); void window.cth.openExternal(OSS_BLOG_LINKS.macMini); }}
                          style={ossLink}
                        >set up on a Mac Mini</a>.
                        {' '}Live end-to-end is pending real model calls (verify on-device).
                      </div>
                    )}

                    <Row label={config.autoMode && preset.autoFlag ? 'Command (auto mode on)' : 'Command'}>
                      <input
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        placeholder={
                          provider === 'antigravity'
                            ? 'agy'
                            : provider === 'codex'
                              ? 'codex'
                              : provider === 'custom'
                                ? 'your-agent-cli'
                                : 'claude'
                        }
                        style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)' }}
                      />
                    </Row>
                  </>
                )}

                {section === 'briefing' && (
                  <>
                    <Row label="Templates">
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {DESCRIPTION_TEMPLATES.map((t) => (
                          <button
                            key={t.label}
                            onClick={() => { setDescription(t.description); setGoal(t.goal); }}
                            title={t.goal}
                            style={{
                              padding: '3px 8px 1px',
                              background: 'var(--cth-cream-100)',
                              boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                              fontFamily: 'var(--cth-font-ui)', fontSize: 12,
                              color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none'
                            }}
                          >
                            {t.label}
                          </button>
                        ))}
                      </div>
                    </Row>

                    <Row label="Role">
                      <input
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder="job — what this agent is for, not live status"
                        style={inputStyle}
                      />
                    </Row>

                    <Row label="Goal (optional)">
                      <textarea
                        value={goal}
                        onChange={(e) => setGoal(e.target.value)}
                        placeholder="long-running directive injected on every prompt"
                        rows={2}
                        style={{ ...inputStyle, fontFamily: 'var(--cth-font-ui)', resize: 'none' }}
                      />
                    </Row>
                  </>
                )}
              </div>
            </div>

            {error && (
              <div style={{
                padding: '6px 10px',
                background: 'var(--cth-coral-light)',
                boxShadow: 'inset 0 0 0 1px var(--cth-coral)',
                fontSize: 13,
                color: 'var(--cth-ink-900)'
              }}>
                {error}
              </div>
            )}

            {/* Import-hire explainer + AI prompt generator (item 7) */}
            <div style={{
              padding: '8px 10px',
              background: 'var(--cth-cream-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              display: 'flex', flexDirection: 'column', gap: 6
            }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '17px' }}>
                  <strong>Import hire</strong> loads a ready-made agent from a <code style={{ fontFamily: 'var(--cth-font-mono)' }}>.json</code> manifest —
                  it fills in every field below for you to review. Nothing spawns until you hit <em>spawn</em>.
                </span>
                <button
                  onClick={() => setShowHirePrompt((v) => !v)}
                  style={{
                    flexShrink: 0,
                    padding: '2px 8px 1px', border: 'none', cursor: 'pointer',
                    background: showHirePrompt ? 'var(--cth-lemon-light)' : 'var(--cth-cream-200)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                    fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
                  }}
                >
                  {showHirePrompt ? 'hide AI prompt' : 'generate one with AI…'}
                </button>
              </div>
              {showHirePrompt && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ fontSize: 12, color: 'var(--cth-ink-500)', lineHeight: '16px' }}>
                    Copy this into Claude/ChatGPT/Gemini, fill in the details at the bottom, then save
                    its JSON reply as a <code style={{ fontFamily: 'var(--cth-font-mono)' }}>.json</code> file and import it here.
                  </span>
                  <textarea
                    readOnly
                    value={HIRE_PROMPT}
                    onFocus={(e) => e.currentTarget.select()}
                    rows={10}
                    style={{
                      ...inputStyle,
                      width: '100%',
                      fontFamily: 'var(--cth-font-mono)', fontSize: 12, lineHeight: '16px',
                      resize: 'vertical', background: 'var(--cth-paper-100)'
                    }}
                  />
                  <div>
                    <PixelButton variant="secondary" size="sm" onClick={copyHirePrompt}>
                      {copiedPrompt ? 'copied ✓' : 'copy prompt'}
                    </PixelButton>
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              <PixelButton
                variant="secondary"
                size="md"
                onClick={importHire}
                disabled={busy}
                title="Import one or more hire manifests (.json)"
              >
                import hires…
              </PixelButton>
              <div style={{ flex: 1 }} />
              {pendingHire && (
                <PixelButton variant="secondary" size="md" onClick={skipHire} disabled={busy}>skip hire</PixelButton>
              )}
              <PixelButton variant="ghost" size="md" onClick={onClose} disabled={busy}>cancel</PixelButton>
              <PixelButton variant="primary" size="md" onClick={submit} disabled={busy}>
                {busy ? 'spawning...' : 'spawn'}
              </PixelButton>
            </div>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px 4px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 16,
  color: 'var(--cth-ink-900)',
  outline: 'none'
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{
        fontFamily: 'var(--cth-font-display)',
        fontSize: 8, lineHeight: '12px',
        color: 'var(--cth-ink-700)',
        textTransform: 'uppercase'
      }}>{label}</span>
      {children}
    </label>
  );
}

import { useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { SpritePortrait } from './SpritePortrait';
import { Icon } from './Icon';
import { useStore, type Agent } from '@/store/store';
import { OFFICE_CAST, DEFAULT_CHARACTER, type OfficeCharacterName } from '@/scene/office/cast';
import { type AccentColorName } from '@/design/tokens';
import type { HireManifest } from '@shared/hire';
import { MCP_CATALOG } from '@shared/mcpCatalog';
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
  { key: 'briefing',  label: 'Briefing',  hint: 'description · goal' }
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
}

export function AddAgentModal({ onClose, config }: AddAgentModalProps) {
  const addAgent = useStore(s => s.addAgent);
  // A validated hire manifest (deep link / file import) seeds the form. Manifests
  // NEVER auto-spawn — the human reviews every field (esp. the command) first.
  const pendingHire = useStore(s => s.pendingHire);

  const knownCharacter = (c?: string): OfficeCharacterName =>
    (OFFICE_CAST.some(m => m.name === c) ? (c as OfficeCharacterName) : DEFAULT_CHARACTER);
  const knownAccent = (a?: string): AccentColorName =>
    (ACCENTS.includes(a as AccentColorName) ? (a as AccentColorName) : 'sky');
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
    const nextModel = isClaudeProvider(id) ? config.defaultModel : undefined;
    setModel(nextModel);
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

  /** Apply an imported manifest to every form field (file import path). The
   *  command is rebuilt locally from the provider preset + validated flags — a
   *  manifest can never inject the spawn binary. Import never spawns. */
  const applyManifest = (m: HireManifest) => {
    setHireMeta(m);
    setName(m.name);
    setCharacter(knownCharacter(m.character));
    setAccent(knownAccent(m.accent));
    if (m.provider) setProvider(m.provider);
    setModel(m.model);
    setCommand(hireCommand(m));
    if (m.description) setDescription(m.description);
    setGoal(m.goal ?? '');
    setIsolate(m.isolate ?? false);
  };

  const importHire = async () => {
    setError(undefined);
    const res = await window.cth.importHireFile();
    if (res.ok && res.manifest) applyManifest(res.manifest);
    else if (res.error && res.error !== 'cancelled') setError(res.error);
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

    const agent: Agent = {
      id,
      name: name.trim(),
      character,
      accent,
      description: description.trim() || 'a fresh harness',
      project: basename(cwd),
      tmuxTarget: '',
      cwd,
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
      recentTextTs: Date.now()
    };
    addAgent(agent);
    // Remember the folder for the next hire: promote it to the front of the
    // registeredRepos quick-picks (the modal's default cwd) so back-to-back
    // hires land in the same project without re-picking.
    if (cwd && config.registeredRepos[0] !== cwd) {
      const repos = [cwd, ...config.registeredRepos.filter((r) => r !== cwd)];
      void window.cth.updateConfig({ registeredRepos: repos }).catch(() => { /* best-effort */ });
    }
    // A hire manifest may carry a per-agent token budget — apply it to the
    // same agentTokenCaps map the Command Center card writes.
    if (hireMeta?.tokenCap) {
      void window.cth
        .updateConfig({ agentTokenCaps: { ...(config.agentTokenCaps ?? {}), [id]: hireMeta.tokenCap } })
        .catch(() => { /* best-effort */ });
    }
    setBusy(false);
    onClose();
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(26, 19, 32, 0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 100
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
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
                fontSize: 13,
                color: 'var(--cth-ink-900)',
                display: 'flex', flexDirection: 'column', gap: 2
              }}>
                <span>
                  📋 hire imported: <strong>{hireMeta.name}</strong>
                  {hireMeta.author ? <> · by {hireMeta.author}</> : null}
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
                          ? 'inset 0 0 0 2px var(--cth-ink-900)'
                          : 'inset 0 0 0 1px var(--cth-ink-700)',
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
                        onChange={(e) => setName(e.target.value)}
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
                                ? 'inset 0 0 0 2px var(--cth-ink-900)'
                                : 'inset 0 0 0 1px var(--cth-ink-700)',
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
                                ? 'inset 0 0 0 2px var(--cth-ink-900), 0 0 0 2px var(--cth-ink-900)'
                                : 'inset 0 0 0 1px var(--cth-ink-900)',
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
                    <Row label="Folder">
                      {config.registeredRepos.length > 0 && (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                          {config.registeredRepos.map((r) => (
                            <button
                              key={r}
                              onClick={() => setCwd(r)}
                              title={r}
                              style={{
                                padding: '3px 8px 1px',
                                background: cwd === r ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                                boxShadow: cwd === r
                                  ? 'inset 0 0 0 2px var(--cth-ink-900)'
                                  : 'inset 0 0 0 1px var(--cth-ink-700)',
                                fontFamily: 'var(--cth-font-ui)',
                                fontSize: 13,
                                cursor: 'pointer',
                                border: 'none'
                              }}
                            >
                              {basename(r)}
                            </button>
                          ))}
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input
                          value={cwd}
                          onChange={(e) => setCwd(e.target.value)}
                          placeholder="/path/to/your/project"
                          style={{ ...inputStyle, flex: 1, fontFamily: 'var(--cth-font-mono)', fontSize: 14 }}
                        />
                        <PixelButton variant="secondary" size="md" onClick={pickFolder}>
                          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                            <Icon name="folder" /> pick
                          </span>
                        </PixelButton>
                      </div>
                    </Row>

                    <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: resuming ? 'not-allowed' : 'pointer', opacity: resuming ? 0.5 : 1 }}>
                      <input
                        type="checkbox"
                        checked={resuming ? false : isolate}
                        disabled={resuming}
                        onChange={(e) => setIsolate(e.target.checked)}
                        style={{ width: 16, height: 16, cursor: resuming ? 'not-allowed' : 'pointer' }}
                      />
                      <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 14, color: 'var(--cth-ink-900)' }}>
                        Git isolation (own worktree)
                      </span>
                    </label>

                    <Row label="Resume session ID (optional)">
                      <input
                        value={resumeSessionId}
                        onChange={(e) => { setResumeSessionId(e.target.value); setFolderNote(undefined); }}
                        onBlur={resolveFolderFromSession}
                        placeholder="paste a Claude session id to continue its conversation"
                        style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)', fontSize: 14 }}
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
                                  ? 'inset 0 0 0 2px var(--cth-ink-900)'
                                  : 'inset 0 0 0 1px var(--cth-ink-700)',
                                fontFamily: 'var(--cth-font-ui)', fontSize: 13,
                                color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none'
                              }}
                            >
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
                                  ? 'inset 0 0 0 2px var(--cth-ink-900)'
                                  : 'inset 0 0 0 1px var(--cth-ink-700)',
                                fontFamily: 'var(--cth-font-ui)', fontSize: 13,
                                color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none'
                              }}
                            >
                              {m.label}
                            </button>
                          );
                        })}
                      </div>
                    </Row>}

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
                    <Row label="Description">
                      <input
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder="what is this agent for"
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
                fontSize: 14,
                color: 'var(--cth-ink-900)'
              }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              <PixelButton variant="secondary" size="md" onClick={importHire} disabled={busy} title="Import a hire manifest (.json)">
                import hire…
              </PixelButton>
              <div style={{ flex: 1 }} />
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
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
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

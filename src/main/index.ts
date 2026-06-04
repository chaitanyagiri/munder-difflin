import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import { rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { PtyManager, type SpawnOptions } from './pty';
import {
  readConfig, writeConfig, resetConfig, ensureHarnessHome,
  type HarnessConfig, type ScheduledMission
} from './config';
import { listDir, readFileText, writeFileText } from './fs';
import {
  getBranch, getStatus, getLog, getBranches, getAheadBehind, isRepo,
  addWorktree, removeWorktree
} from './git';
import { HiveManager, type AgentMeta, type HiveMessage, type HiveTask } from './hive';
import { HookServer } from './hooks';
import { MemoryManager } from './memory';
import { enrichMessage } from './assistant';
import { readAgentUsage } from './transcript';
import { listIssues, listCIRuns } from './github';

const isDev = !!process.env.ELECTRON_RENDERER_URL;
const ptyManager = new PtyManager();
/** Live PTY id → its hive agent id, recorded at spawn. The pty:kill handler only
 *  gets the PTY id, so this lets a closed tab archive the right registry agent. */
const ptyToAgent = new Map<string, string>();
const hive = new HiveManager(
  () => readConfig().harnessHome,
  (channel, payload) => { try { liveWebContents()?.send(channel, payload); } catch { /* window tore down */ } }
);
const hookServer = new HookServer(hive, () => liveWebContents(), () => readConfig());
const memory = new MemoryManager(
  () => readConfig().harnessHome,
  () => { const c = readConfig(); return { enabled: c.semanticMemory !== false, model: c.embeddingModel ?? 'minilm' }; }
);
let mainWindow: BrowserWindow | null = null;

/** When true, skip the quit interceptor (user already confirmed). */
let allowQuit = false;

/** Agents spawned with `isolate: true` get a dedicated git worktree; this maps
 *  the agent/pty id → the worktree path so we can tear it down on kill. */
const worktreePaths = new Map<string, string>();
/** id → the original repo cwd the worktree was created from (needed to run
 *  `git worktree remove` from the parent tree, not the worktree itself). */
const worktreeOrigins = new Map<string, string>();

/**
 * Tear down everything tied to a PTY id: archive its hive agent, remove its
 * isolated git worktree, and drop the bookkeeping-map entries. Runs on BOTH an
 * explicit `pty:kill` AND a natural PTY exit (the child finished, crashed, or
 * was killed externally) — without this the agent stays "active" (broadcasts
 * keep mailing a dead inbox), the worktree orphans (plus a dangling `git
 * worktree` registration in the user's real repo), and the maps leak an entry
 * per dead PTY.
 *
 * Idempotent: guarded on map presence and the already-idempotent
 * `hive.setArchived`, so the second call (kill() also makes node-pty fire
 * onExit) is a harmless no-op. Best-effort — every step is wrapped so a teardown
 * error can never crash the caller (an IPC handler or node-pty's onExit).
 */
function teardownPty(id: string): void {
  // 1) Archive the agent — retained + flagged; only live-PTY agents are active.
  const agentId = ptyToAgent.get(id);
  if (agentId) {
    ptyToAgent.delete(id);
    if (hive.enabled()) {
      try { hive.setArchived(agentId, true); } catch (e) { console.error('[hive] setArchived failed:', e); }
    }
  }
  // 2) Remove the isolated worktree, if any. Non-blocking; errors are logged.
  const wtPath = worktreePaths.get(id);
  if (wtPath) {
    const origCwd = worktreeOrigins.get(id) ?? wtPath;
    worktreePaths.delete(id);
    worktreeOrigins.delete(id);
    void removeWorktree(origCwd, wtPath)
      .then(r => { if (!r.ok) console.error('[worktree] removeWorktree failed:', r.error); })
      .catch(e => console.error('[worktree] removeWorktree threw:', e));
  }
}
// A natural PTY exit must run the same teardown as an explicit kill.
ptyManager.setExitHandler(teardownPty);

/** Active scheduler timers keyed by mission id. */
const missionTimers = new Map<string, NodeJS.Timeout>();

/** Rebuild the scheduler from persisted config: clear every existing timer,
 *  then arm a fresh interval for each enabled mission. Each tick dispatches the
 *  mission to its target agent and stamps lastFiredAt back into config. Called
 *  on boot (after the router starts) and after every missions:save. */
function syncMissions(): void {
  for (const t of missionTimers.values()) clearInterval(t);
  missionTimers.clear();
  const missions = readConfig().missions ?? [];
  for (const m of missions) {
    if (!m.enabled || !(m.intervalMs > 0)) continue;
    const timer = setInterval(() => {
      try {
        if (hive.enabled()) {
          hive.send({ to: m.to, act: 'request', subject: m.label, body: m.body }, 'scheduler');
        }
        const current = readConfig().missions ?? [];
        const next = current.map((x) =>
          x.id === m.id ? { ...x, lastFiredAt: Date.now() } : x
        );
        writeConfig({ missions: next });
      } catch (e) {
        console.error('[scheduler] mission', m.id, e);
      }
    }, m.intervalMs);
    missionTimers.set(m.id, timer);
  }
}

/** The live renderer webContents, or null if the window is gone/destroyed.
 *  Anything that emits to the renderer from a timer/socket/child callback must
 *  route through here — during quit the window can be destroyed while those
 *  callbacks are still in flight, and `.send()` on a destroyed webContents
 *  throws "Object has been destroyed" (the main-process crash dialog). */
function liveWebContents(): Electron.WebContents | null {
  const wc = mainWindow?.webContents;
  return wc && !wc.isDestroyed() ? wc : null;
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1280,
    minHeight: 800,
    title: 'Munder Difflin',
    backgroundColor: '#FFF8E7',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow = win;

  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // On macOS, the red-X "close" event by default destroys the window — and on
  // a single-window app, that effectively quits. Intercept it the same way we
  // intercept before-quit so PTY users get the warning.
  win.on('close', (e) => {
    if (allowQuit) return;
    const count = ptyManager.list().length;
    if (count === 0) return;
    e.preventDefault();
    win.focus();
    win.webContents.send('app:closeRequested', { ptyCount: count });
  });

  ptyManager.attachWebContents(win.webContents);

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
}

// ─── IPC: pty lifecycle ─────────────────────────────────────────────────────
ipcMain.handle('pty:spawn', async (_evt, opts: SpawnOptions & { hive?: AgentMeta; isolate?: boolean }) => {
  if (!opts || typeof opts.id !== 'string' || typeof opts.cwd !== 'string' || typeof opts.command !== 'string') {
    return { ok: false, error: 'invalid SpawnOptions' };
  }
  // Git isolation: when requested and the cwd is a real repo, give this agent
  // its own worktree on an `agent/<id>` branch so it can't clobber other agents'
  // (or the user's) working tree. Best-effort — a failure falls back to the
  // shared cwd rather than blocking the spawn.
  if (opts.isolate === true && await isRepo(opts.cwd)) {
    try {
      const origCwd = opts.cwd;
      const wtRoot = join(readConfig().harnessHome ?? origCwd, 'worktrees');
      // The id is renderer-supplied (validated only as a string). Slugify it so a
      // crafted id can't inject path separators, then assert the resolved path
      // stays under the worktrees root (defends against bare '..' that slugify
      // leaves intact). If it would escape, bail isolation → fall back to cwd.
      const seg = (opts.hive?.id ?? opts.id).replace(/[^A-Za-z0-9._-]/g, '-');
      const wtPath = join(wtRoot, seg);
      if (!resolve(wtPath).startsWith(resolve(wtRoot) + sep)) {
        console.error('[worktree] refusing unsafe worktree path for id:', opts.hive?.id ?? opts.id);
      } else {
        const br = await getBranch(origCwd);
        const baseBranch = 'current' in br && br.current ? br.current : 'main';
        const wt = await addWorktree(origCwd, wtPath, baseBranch);
        if (wt.ok) {
          opts.cwd = wtPath;
          worktreePaths.set(opts.id, wtPath);
          worktreeOrigins.set(opts.id, origCwd);
        } else {
          console.error('[worktree] addWorktree failed:', wt.error);
        }
      }
    } catch (e) {
      console.error('[worktree] isolation failed:', e);
    }
  }
  // If the agent carries hive metadata, provision its workspace and inject the
  // identity + protocol (extra --append-system-prompt args + AGENT_* env).
  if (opts.hive && hive.enabled()) {
    try {
      const inj = hive.ensureAgent({ ...opts.hive, cwd: opts.cwd }, { semanticMemory: memory.active() });
      opts.args = [...(opts.args ?? []), ...inj.args];
      // Point the agent's mempalace CLI at the shared palace (no-op if inactive).
      opts.env = { ...(opts.env ?? {}), ...inj.env, ...memory.env() };
    } catch (e) {
      // Hive provisioning is best-effort; never block a spawn on it.
      console.error('[hive] ensureAgent failed:', e);
    }
  }
  // Remember which agent owns this PTY so closing the tab can archive it. A
  // live terminal means active — ensureAgent above already cleared `archived`.
  if (opts.hive?.id) ptyToAgent.set(opts.id, opts.hive.id);
  return ptyManager.spawn(opts);
});
ipcMain.handle('pty:write', (_evt, id: string, data: string) => {
  if (typeof id !== 'string' || typeof data !== 'string') return { ok: false, error: 'invalid args' };
  return ptyManager.write(id, data);
});
ipcMain.handle('pty:resize', (_evt, id: string, cols: number, rows: number) => {
  if (typeof id !== 'string' || typeof cols !== 'number' || typeof rows !== 'number') return { ok: false, error: 'invalid args' };
  return ptyManager.resize(id, cols, rows);
});
ipcMain.handle('pty:kill', (_evt, id: string) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  // Kill the process, then run the shared lifecycle teardown (archive the agent,
  // remove its isolated worktree, drop the maps). teardownPty is idempotent, so
  // node-pty firing onExit once the child actually dies is a harmless no-op.
  const res = ptyManager.kill(id);
  teardownPty(id);
  return res;
});
ipcMain.handle('pty:list', () => ptyManager.list());

// ─── IPC: clipboard ─────────────────────────────────────────────────────────
ipcMain.handle('app:copyToClipboard', (_evt, text: unknown) => {
  if (typeof text !== 'string') return { ok: false, error: 'invalid text' };
  try { clipboard.writeText(text); return { ok: true }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});

// ─── IPC: folder picker ─────────────────────────────────────────────────────
ipcMain.handle('dialog:chooseFolder', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return { ok: false as const, error: 'no window' };
  const res = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Pick a folder'
  });
  if (res.canceled || res.filePaths.length === 0) return { ok: false as const, error: 'cancelled' };
  return { ok: true as const, path: res.filePaths[0] };
});

// ─── IPC: Terminal.app at a folder ──────────────────────────────────────────
ipcMain.handle('terminal:openAtFolder', async (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string' || cwd.length === 0) return { ok: false, error: 'invalid cwd' };
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const p = spawn('open', ['-a', 'Terminal', cwd]);
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => resolve({ ok: false, error: e.message }));
    p.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: err.trim() || `open exited ${code}` });
    });
  });
});

// ─── IPC: config ────────────────────────────────────────────────────────────
ipcMain.handle('config:get', (): HarnessConfig => readConfig());
ipcMain.handle('config:update', (_evt, patch: Partial<HarnessConfig>) => writeConfig(patch));
ipcMain.handle('config:ensureHome', (_evt, path: unknown) => {
  if (typeof path !== 'string' || path.length === 0) return { ok: false, error: 'invalid path' };
  return ensureHarnessHome(path);
});

// ─── IPC: filesystem (sandboxed to a root) ──────────────────────────────────
ipcMain.handle('fs:listDir', (_evt, root: unknown, rel: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
  return listDir(root, rel);
});
ipcMain.handle('fs:readFile', (_evt, root: unknown, rel: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
  return readFileText(root, rel);
});
ipcMain.handle('fs:writeFile', (_evt, root: unknown, rel: unknown, content: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string' || typeof content !== 'string') {
    return { ok: false, error: 'invalid args' };
  }
  return writeFileText(root, rel, content);
});

// ─── IPC: git ───────────────────────────────────────────────────────────────
ipcMain.handle('git:isRepo', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return false;
  return isRepo(cwd);
});
ipcMain.handle('git:branch', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getBranch(cwd);
});
ipcMain.handle('git:status', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getStatus(cwd);
});
ipcMain.handle('git:log', (_evt, cwd: unknown, n: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  const count = typeof n === 'number' ? Math.min(500, Math.max(1, n)) : 50;
  return getLog(cwd, count);
});
ipcMain.handle('git:branches', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getBranches(cwd);
});
ipcMain.handle('git:aheadBehind', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getAheadBehind(cwd);
});

// ─── IPC: hive (multi-agent coordination) ───────────────────────────────────
ipcMain.handle('hive:registry', () => hive.registry());
ipcMain.handle('hive:board', () => hive.board());
ipcMain.handle('hive:tasks', () => hive.tasks());
ipcMain.handle('hive:log', (_evt, n: unknown) => hive.logTail(typeof n === 'number' ? n : 200));
ipcMain.handle('hive:memory', (_evt, id: unknown) => (typeof id === 'string' ? hive.memory(id) : ''));
ipcMain.handle('hive:inbox', (_evt, id: unknown) => (typeof id === 'string' ? hive.inbox(id) : []));
ipcMain.handle('hive:approvals', () => hive.approvals());
ipcMain.handle('hive:resolveApproval', (_evt, id: unknown, approve: unknown, note: unknown) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  hive.resolveApproval(id, approve === true, typeof note === 'string' ? note : undefined);
  return { ok: true };
});
ipcMain.handle('hive:send', (_evt, partial: Partial<HiveMessage>, from: unknown) => {
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  const msg = hive.send(partial ?? {}, typeof from === 'string' ? from : 'system');
  return { ok: true, message: msg };
});
ipcMain.handle('hive:writeTasks', (_evt, tasks) => {
  hive.writeTasks(tasks as HiveTask[]);
  return { ok: true };
});
ipcMain.handle('hive:setArchived', (_evt, id: unknown, archived: unknown) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  hive.setArchived(id, archived === true);
  return { ok: true };
});

// ─── IPC: enrichment assistant (headless Sonnet 1M prompt prep) ─────────────
ipcMain.handle('assistant:enrich', async (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { message?: unknown; cwd?: unknown };
  if (typeof p.message !== 'string' || !p.message.trim()) {
    return { ok: false, error: 'empty message' };
  }
  const cfg = readConfig();
  const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : cfg.harnessHome;
  if (!cwd) return { ok: false, error: 'no working directory available' };
  try {
    return await enrichMessage({
      message: p.message,
      cwd,
      repos: cfg.registeredRepos ?? [],
      command: cfg.defaultCommand,
      env: memory.env()
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

// ─── IPC: semantic memory (MemPalace CLI) ───────────────────────────────────
ipcMain.handle('hive:memoryStatus', () => { memory.resetBinCache(); return memory.status(); });
ipcMain.handle('hive:searchMemory', (_evt, query: unknown, wing: unknown) => {
  if (typeof query !== 'string' || !query.trim()) return { ok: false, output: '', error: 'empty query' };
  return memory.search(query, { wing: typeof wing === 'string' ? wing : undefined });
});
ipcMain.handle('hive:memoryWakeUp', (_evt, wing: unknown) =>
  memory.wakeUp(typeof wing === 'string' ? wing : undefined));
ipcMain.handle('hive:mineNow', () => { memory.mineNow(); return { ok: true }; });

// ─── IPC: quit confirmation ─────────────────────────────────────────────────
ipcMain.handle('app:confirmClose', () => {
  allowQuit = true;
  // Each teardown step is best-effort: a throw here (e.g. a dying child or a
  // half-torn-down socket) must never abort the quit or pop a crash dialog.
  try { hive.stopRouter(); } catch (e) { console.error('[quit] stopRouter:', e); }
  try { hookServer.stop(); } catch (e) { console.error('[quit] hookServer.stop:', e); }
  try { memory.stop(); } catch (e) { console.error('[quit] memory.stop:', e); }
  try { ptyManager.killAll(); } catch (e) { console.error('[quit] killAll:', e); }
  app.quit();
});
ipcMain.handle('app:cancelClose', () => {
  // no-op — modal will close on the renderer side
});

// ─── IPC: full reset (wipe data + config, relaunch into onboarding) ──────────
ipcMain.handle('app:resetAll', () => {
  allowQuit = true;
  // Tear everything down first so nothing writes back into the dirs we wipe.
  try { hive.stopRouter(); } catch (e) { console.error('[reset] stopRouter:', e); }
  try { hookServer.stop(); } catch (e) { console.error('[reset] hookServer.stop:', e); }
  try { memory.stop(); } catch (e) { console.error('[reset] memory.stop:', e); }
  try { ptyManager.killAll(); } catch (e) { console.error('[reset] killAll:', e); }
  // Erase the hive (Michael's + every agent's memory, inboxes, tasks, board,
  // git history) and the semantic-memory palace. Only these harness-created
  // subdirs are removed — never the user's whole harnessHome folder.
  for (const dir of [hive.root(), memory.palacePath()]) {
    if (!dir) continue;
    try { rmSync(dir, { recursive: true, force: true }); }
    catch (e) { console.error('[reset] rm', dir, e); }
  }
  // Back to first-run defaults, then relaunch clean so all in-memory services
  // re-bootstrap from scratch and the renderer lands on onboarding.
  resetConfig();
  app.relaunch();
  app.exit(0);
});

// ─── IPC: token telemetry (real usage + est. cost from CC transcripts) ───────
ipcMain.handle('hive:agentUsage', (_evt, cwd: unknown) =>
  typeof cwd === 'string' ? readAgentUsage(cwd) : null);

// ─── IPC: scheduled missions (recurring auto-dispatch) ──────────────────────
ipcMain.handle('missions:list', () => readConfig().missions ?? []);
ipcMain.handle('missions:save', (_evt, missions) => {
  writeConfig({ missions: missions as ScheduledMission[] });
  syncMissions();
  return { ok: true };
});

// ─── IPC: full-text search across hive files (board, tasks, memory) ──────────
ipcMain.handle('hive:textSearch', (_evt, query: unknown) => {
  if (typeof query !== 'string' || !query.trim()) return { ok: false, results: [] };
  const root = hive.root();
  if (!root) return { ok: false, results: [] };
  const q = query.toLowerCase();
  const results: Array<{ source: string; excerpt: string }> = [];
  // Each target file is (path, readable label). agents/<id>/memory.md is expanded below.
  const targets: Array<{ path: string; source: string }> = [
    { path: join(root, 'board.md'), source: 'board.md' },
    { path: join(root, 'tasks.json'), source: 'tasks.json' }
  ];
  const agentsDir = join(root, 'agents');
  if (existsSync(agentsDir)) {
    for (const id of readdirSync(agentsDir)) {
      targets.push({ path: join(agentsDir, id, 'memory.md'), source: `${id}/memory.md` });
    }
  }
  for (const { path, source } of targets) {
    if (!existsSync(path)) continue;
    let hits = 0;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (hits >= 3) break;
      const idx = line.toLowerCase().indexOf(q);
      if (idx === -1) continue;
      // ~40 chars of context on either side of the match.
      const excerpt = line.slice(Math.max(0, idx - 40), idx + q.length + 40).trim();
      results.push({ source, excerpt });
      hits++;
    }
  }
  return { ok: true, results };
});

// ─── IPC: GitHub issue ingestion (gh CLI) ────────────────────────────────────
ipcMain.handle('github:issues', (_evt, cwd: unknown) =>
  typeof cwd === 'string' ? listIssues(cwd) : { ok: false, error: 'no cwd' }
);

// ─── IPC: GitHub CI status watcher (gh CLI) ──────────────────────────────────
ipcMain.handle('github:ciRuns', (_evt, cwd: unknown) =>
  typeof cwd === 'string' ? listCIRuns(cwd) : { ok: false, error: 'no cwd' }
);

// ─── IPC: desktop notifications toggle ──────────────────────────────────────
ipcMain.handle('app:setNotifications', (_evt, val) => writeConfig({ notifications: val === true }));

app.whenReady().then(() => {
  // Bootstrap the hive (if harnessHome is configured) and start the message router.
  if (hive.enabled()) {
    hive.ensureHive();
    hive.startRouter();
    syncMissions(); // arm recurring auto-dispatch missions now the router is live
    hookServer.start();
    memory.start(); // init shared palace + mine loop (no-op without mempalace)
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// before-quit covers Cmd-Q / dock-quit; the per-window close handler covers
// the red close button. Both routes hit the same warning UX.
app.on('before-quit', (e) => {
  if (allowQuit) return;
  const count = ptyManager.list().length;
  if (count === 0) return;
  e.preventDefault();
  if (mainWindow) {
    mainWindow.focus();
    mainWindow.webContents.send('app:closeRequested', { ptyCount: count });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    ptyManager.killAll();
    app.quit();
  }
});

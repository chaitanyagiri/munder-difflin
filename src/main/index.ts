import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { PtyManager, type SpawnOptions } from './pty';
import {
  readConfig, writeConfig, resetConfig, ensureHarnessHome,
  type HarnessConfig
} from './config';
import { listDir, readFileText, writeFileText } from './fs';
import {
  getBranch, getStatus, getLog, getBranches, getAheadBehind, isRepo
} from './git';
import { HiveManager, type AgentMeta, type HiveMessage, type HiveTask } from './hive';
import { HookServer } from './hooks';
import { MemoryManager } from './memory';
import { enrichMessage } from './assistant';

const isDev = !!process.env.ELECTRON_RENDERER_URL;
const ptyManager = new PtyManager();
const hive = new HiveManager(
  () => readConfig().harnessHome,
  (channel, payload) => { try { liveWebContents()?.send(channel, payload); } catch { /* window tore down */ } }
);
const hookServer = new HookServer(hive, () => liveWebContents());
const memory = new MemoryManager(
  () => readConfig().harnessHome,
  () => { const c = readConfig(); return { enabled: c.semanticMemory !== false, model: c.embeddingModel ?? 'minilm' }; }
);
let mainWindow: BrowserWindow | null = null;

/** When true, skip the quit interceptor (user already confirmed). */
let allowQuit = false;

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
ipcMain.handle('pty:spawn', (_evt, opts: SpawnOptions & { hive?: AgentMeta }) => {
  if (!opts || typeof opts.id !== 'string' || typeof opts.cwd !== 'string' || typeof opts.command !== 'string') {
    return { ok: false, error: 'invalid SpawnOptions' };
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
  return ptyManager.kill(id);
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

app.whenReady().then(() => {
  // Bootstrap the hive (if harnessHome is configured) and start the message router.
  if (hive.enabled()) {
    hive.ensureHive();
    hive.startRouter();
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

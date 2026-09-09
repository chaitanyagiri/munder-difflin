/**
 * MemoryManager — semantic memory for the hive, backed by the MemPalace CLI.
 *
 * CLI-only (no MCP): the harness keeps a single shared palace under harnessHome,
 * points every agent's `MEMPALACE_PALACE_PATH` at it, and mines each agent's
 * `memory.md` into its own wing so the whole team can recall by meaning via
 * `mempalace search` / `mempalace wake-up`. Degrades silently to no-op when the
 * `mempalace` CLI isn't installed — the markdown memory still works.
 *
 *   init    : mempalace init <home> --yes --no-llm        (heuristics-only, no LLM)
 *   store   : mempalace mine <agentDir> --wing <id> --agent <id>
 *   recall  : mempalace search "<q>" --results N   /   mempalace wake-up
 *
 * Runs in the Electron main process.
 */
import { existsSync, statSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ensureKilled } from './procKill';
import { quarantineDirsToReap, quarantineStampMs, nextMineDelayMs } from './palaceReap';

/** Non-memory files `mempalace mine` must not ingest: the Claude Code hooks
 *  config (a large JSON blob that swamps the wake-up digest), the cursor, raw
 *  inbox/outbox message JSON, and a Codex worker's private CODEX_HOME. `mempalace
 *  mine` honors .gitignore, so we drop one in each agent dir rather than touch the
 *  mine command.
 *
 *  MUST STAY IN SYNC with MINE_IGNORE_LINES in hive.ts — that copy is written when
 *  an agent spawns, this one on every mine cycle, and only this one reaches agents
 *  that are not currently running. See hive.ts for why `.codex/` matters beyond
 *  mempalace: it is also what stopped the hive's git repo from versioning every
 *  Codex transcript and sqlite log into a 7.5GB history. */
const MINE_IGNORE_LINES = ['settings.json', 'cursor.json', 'inbox/', 'outbox/', '.codex/'];

/** Idempotently ensure `<agentDir>/.gitignore` excludes the non-memory files.
 *  Writes only the missing lines (append-only) so it's safe to call every cycle. */
function ensureMineIgnore(agentDir: string): void {
  const path = join(agentDir, '.gitignore');
  let existing = '';
  try { if (existsSync(path)) existing = readFileSync(path, 'utf8'); } catch { return; }
  const have = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = MINE_IGNORE_LINES.filter((l) => !have.has(l));
  if (missing.length === 0) return; // already covered — don't rewrite every cycle
  const prefix = existing && !existing.endsWith('\n') ? existing + '\n' : existing;
  try { writeFileSync(path, prefix + missing.join('\n') + '\n', 'utf8'); } catch { /* best-effort */ }
}

export type EmbeddingModel = 'minilm' | 'embeddinggemma';

export interface MemorySettings {
  enabled: boolean;
  model: EmbeddingModel;
}

export interface MemoryStatus {
  available: boolean;        // mempalace CLI found on PATH
  enabled: boolean;          // user setting
  active: boolean;           // available && enabled && have a home
  initialized: boolean;      // palace directory exists
  palacePath: string | null;
  model: EmbeddingModel;
  bin: string | null;
}

// Re-mine changed memories every 10 min, up from 3.
//
// Every `mempalace mine` opens the palace, and every open runs MemPalace's
// quarantine gate — which on a palace stuck in the rename loop means another
// full-size copy of the segment left on disk. The gate is not ours to fix, but
// how often we invoke it is. Mining is already skipped for agents whose
// memory.md has not changed, so this only affects an agent editing its notes
// repeatedly: its changes are batched into one mine instead of three. A memory
// written now is searchable within ten minutes rather than three, which no one
// is waiting on. `reapPalace` handles the copies that still get made.
const MINE_INTERVAL_MS = 600_000;
// Ceiling for the quarantine backoff below. Low on purpose: a memory is not
// searchable until it has been mined, and the reaper already handles the disk,
// so there is nothing here worth making recall half an hour stale for.
const MINE_BACKOFF_MAX_MS = 1_800_000;
const MINE_TIMEOUT_MS = 10 * 60_000; // hard cap per mine (first run downloads the embedding model)
/** mempalace's device "auto" picks the CoreML execution provider on Apple
 *  Silicon, and CoreML runs the quantized embeddinggemma ONNX graph partially
 *  (330/1647 nodes) with fp16 partitions that overflow → EVERY vector comes
 *  back NaN and chroma rejects every upsert ("Embeddings must not contain NaN
 *  or Infinity values"), so no memory ever gets indexed. Reproduced + verified
 *  2026-08-16: same input is NaN under CoreMLExecutionProvider and clean under
 *  CPU. Pin cpu for BOTH the mine loop and the agents' own `mempalace search`
 *  (a query embedded to NaN breaks recall the same way).
 *
 *  Scope, deliberately macOS-WIDE rather than per-model: the pin costs the
 *  other model nothing. minilm rides chromadb's ONNXMiniLM_L6_V2, whose model
 *  build UNCONDITIONALLY removes CoreMLExecutionProvider ("not as well
 *  optimized as CPU" — chromadb's words), so minilm never runs on CoreML with
 *  or without this pin; embeddinggemma (mempalace's own ONNX class, no such
 *  pruning) is the only path that would reach CoreML, and that path is the NaN
 *  bug. Other platforms keep mempalace's own default ("auto").
 *
 *  A user's OWN device choice wins: if MEMPALACE_EMBEDDING_DEVICE is already
 *  exported we emit nothing, so the inherited value flows through untouched —
 *  which also leaves a one-command way to reproduce the NaN behaviour
 *  (`MEMPALACE_EMBEDDING_DEVICE=coreml`). Exported as a function of
 *  (platform, envOverride) so every branch is reachable from a test on any
 *  platform — same trick as `buildMissingCliScript`. */
export function mempalaceDevice(
  platform: NodeJS.Platform,
  envOverride: string | undefined
): string | undefined {
  if (envOverride) return undefined; // explicit user choice — never override
  return platform === 'darwin' ? 'cpu' : undefined;
}
const MEMPALACE_DEVICE = mempalaceDevice(process.platform, process.env.MEMPALACE_EMBEDDING_DEVICE);

export class MemoryManager {
  private binCache: string | null | undefined;
  private mineTimer: NodeJS.Timeout | null = null;
  private mineStopped = false;
  /** Current gap between mine passes. Widens while the palace is quarantining. */
  private mineDelayMs = MINE_INTERVAL_MS;
  /** Newest quarantine stamp seen so far, so a LATER one means the palace
   *  quarantined again. A count would be useless: the reaper deletes them. */
  private lastQuarantineTs = 0;
  private initStarted = false;
  /** True while a mineNow() pass is in flight — serializes palace writers. */
  private mining = false;
  /** agentId → memory.md mtimeMs at last successful mine (skip unchanged). */
  private lastMined = new Map<string, number>();

  constructor(
    private getHome: () => string | null,
    private getSettings: () => MemorySettings
  ) {}

  palacePath(): string | null {
    const h = this.getHome();
    return h ? join(h, 'palace') : null;
  }

  /** Resolve the mempalace CLI: the user's PATH + common uv/pip spots first,
   *  then the copy bundled with the packaged app (extraResources). */
  bin(): string | null {
    if (this.binCache !== undefined) return this.binCache;
    let found: string | null = null;
    const isWin = process.platform === 'win32';
    // 1) Ask the shell/PATH resolver. Windows has no POSIX shell + uses `where`
    //    and a `.exe` suffix; everything else goes through the login shell.
    try {
      if (isWin) {
        const res = spawnSync('where', ['mempalace'], { encoding: 'utf8', timeout: 3000 });
        const p = res.stdout.trim().split(/\r?\n/)[0]?.trim();
        if (p && existsSync(p)) found = p;
      } else {
        const res = spawnSync(process.env.SHELL ?? '/bin/zsh', ['-ilc', 'which mempalace'], {
          encoding: 'utf8', timeout: 3000
        });
        const p = res.stdout.trim().split('\n').pop();
        if (p && existsSync(p)) found = p;
      }
    } catch { /* fall through */ }
    // 2) Probe common install locations (uv tool / homebrew / pip).
    if (!found) {
      const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
      const candidates = isWin
        ? [
            join(home, '.local', 'bin', 'mempalace.exe'),
            join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Scripts', 'mempalace.exe')
          ]
        : [
            `${home}/.local/bin/mempalace`,
            '/opt/homebrew/bin/mempalace',
            '/usr/local/bin/mempalace'
          ];
      for (const c of candidates) if (c && existsSync(c)) { found = c; break; }
    }
    // 3) Fall back to the copy bundled with the app (electron-builder
    //    extraResources → <resourcesPath>/mempalace). Deliberately LAST: a
    //    user's own install (steps 1–2) always wins, so bundling changes
    //    nothing on machines that already have mempalace — it only makes a
    //    bare machine work out of the box. Guarded because resourcesPath is
    //    Electron-only: absent under plain node (tests), and in dev it points
    //    at Electron's own dist resources, where this candidate simply misses
    //    and resolution degrades exactly as before.
    if (!found) {
      const res = process.resourcesPath;
      if (res) {
        const bundled = join(res, 'mempalace', isWin ? 'mempalace.exe' : 'mempalace');
        if (existsSync(bundled)) found = bundled;
      }
    }
    this.binCache = found;
    return found;
  }
  /** Force re-resolution (e.g. after the user installs mempalace). */
  resetBinCache(): void { this.binCache = undefined; }

  available(): boolean { return this.bin() !== null; }
  enabled(): boolean { return this.getSettings().enabled; }
  active(): boolean { return this.available() && this.enabled() && this.getHome() !== null; }
  model(): EmbeddingModel { return this.getSettings().model === 'embeddinggemma' ? 'embeddinggemma' : 'minilm'; }

  status(): MemoryStatus {
    const palace = this.palacePath();
    return {
      available: this.available(),
      enabled: this.enabled(),
      active: this.active(),
      initialized: !!palace && existsSync(palace),
      palacePath: palace,
      model: this.model(),
      bin: this.bin()
    };
  }

  /** Env merged into each agent's spawn so its `mempalace` CLI hits the shared palace. */
  env(): Record<string, string> {
    const palace = this.palacePath();
    if (!this.active() || !palace) return {};
    return {
      MEMPALACE_PALACE_PATH: palace,
      MEMPALACE_EMBEDDING_MODEL: this.model(),
      ...(MEMPALACE_DEVICE ? { MEMPALACE_EMBEDDING_DEVICE: MEMPALACE_DEVICE } : {})
    };
  }

  private childEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      MEMPALACE_PALACE_PATH: this.palacePath() ?? '',
      MEMPALACE_EMBEDDING_MODEL: this.model(),
      ...(MEMPALACE_DEVICE ? { MEMPALACE_EMBEDDING_DEVICE: MEMPALACE_DEVICE } : {})
    };
  }

  // — lifecycle —

  /** Start the mine loop. `mempalace mine` auto-creates the palace on first run
   *  (lazily downloading the embedding model, one-time). We deliberately do NOT
   *  run `mempalace init`: it ends in an interactive "Mine now? [Y/n]" prompt
   *  that --yes doesn't cover, so a spawned child would hang forever. */
  start(): void {
    if (!this.active() || this.initStarted) return;
    if (!this.bin() || !this.getHome() || !this.palacePath()) return;
    this.initStarted = true;
    // Sweep once at boot, before the first mine. An app updating into this fix
    // arrives at a palace that has been accumulating copies for as long as it
    // has been running — 357 of them here — and waiting for the first agent to
    // edit its memory.md would leave all of that on disk for an arbitrary
    // while. This is the pass that makes the existing pile go away by itself.
    this.reapPalace();
    this.startMineLoop();
  }

  stop(): void {
    this.mineStopped = true;
    if (this.mineTimer) { clearTimeout(this.mineTimer); this.mineTimer = null; }
  }

  /**
   * Re-resolve the CLI, arm the mine loop if it is only now possible, and report.
   *
   * `start()` runs once at boot and bails when mempalace isn't on PATH yet. If the
   * user installs it AFTER that — the common case, since the settings panel is
   * where they find out they need it — nothing re-invoked `start()`, so the mine
   * loop never ran. The palace is created by the first `mempalace mine`, so it
   * never appeared either, and `initialized` (existsSync(palace)) stayed false
   * while `available` flipped true: the status pill read "On — getting ready…"
   * forever and only an app restart cleared it.
   *
   * The status poll is the one thing that reliably notices the install, so it is
   * where the re-arm belongs. `start()` is idempotent (initStarted), so repeated
   * polls never start a second loop — and it still deliberately does NOT run
   * `mempalace init`, which ends in an interactive "Mine now? [Y/n]" that `--yes`
   * doesn't cover and that hangs a spawned child.
   */
  refresh(): MemoryStatus {
    this.resetBinCache();
    this.start();
    return this.status();
  }

  /** Self-scheduling rather than `setInterval`, so the gap can widen when the
   *  palace is quarantining and snap back the moment it stops. */
  private startMineLoop(): void {
    if (this.mineTimer) return;
    const tick = () => {
      void this.mineNow().finally(() => {
        if (this.mineStopped) return;
        this.mineTimer = setTimeout(tick, this.mineDelayMs);
        this.mineTimer.unref?.();
      });
    };
    // Armed synchronously. `mineTimer` is the "is the loop running" signal that
    // `refresh()` reports on right after `start()`, and setting it only once the
    // first mine resolves would report the loop as dead for a whole pass —
    // which is exactly the re-arm-after-install case that has its own test.
    this.mineTimer = setTimeout(tick, 0);
    this.mineTimer.unref?.();
  }

  // — mining (store) —

  /** Mine every agent whose memory changed since last time, one at a time.
   *  The palace permits a single writer, so mines MUST be serialized — firing
   *  them concurrently makes all but one fail with "held by another writer".
   *  `mining` guards against a slow pass overlapping the next interval tick. */
  async mineNow(): Promise<void> {
    const home = this.getHome();
    const bin = this.bin();
    if (!this.active() || !home || !bin) return;
    if (this.mining) return; // a previous pass is still running — let it finish
    const agentsDir = join(home, 'hive', 'agents');
    if (!existsSync(agentsDir)) return;
    let ids: string[];
    try { ids = readdirSync(agentsDir); } catch { return; }
    this.mining = true;
    try {
      for (const id of ids) {
        const agentDir = join(agentsDir, id);
        const mem = join(agentDir, 'memory.md');
        if (!existsSync(mem)) continue;
        let mtime = 0;
        try { mtime = statSync(mem).mtimeMs; } catch { continue; }
        if (this.lastMined.get(id) === mtime) continue; // unchanged — skip the model load
        this.lastMined.set(id, mtime);
        await this.mineAgent(agentDir, id); // one writer at a time
      }
    } finally {
      this.mining = false;
    }
    // Every pass above may have left another copy behind, and whether it did
    // decides how long we wait before the next one.
    const quarantined = this.reapPalace();
    this.mineDelayMs = nextMineDelayMs(
      this.mineDelayMs, MINE_INTERVAL_MS, MINE_BACKOFF_MAX_MS, quarantined
    );
  }

  /**
   * Delete quarantined segment copies MemPalace renamed aside and never removed.
   *
   * Safe to delete: the rename is precisely what takes them OUT of the palace's
   * live set, and Chroma has already rebuilt by the time we see one. They are
   * diagnostic residue. `quarantineDirsToReap` keeps the newest couple so there
   * is still something to look at, and refuses to touch anything recent enough
   * to still be mid-recovery.
   *
   * Best-effort throughout. A palace we cannot read, or a directory we cannot
   * remove, must never take down the mine loop — this is disk hygiene, not a
   * correctness path.
   */
  private reapPalace(): boolean {
    const palace = this.palacePath();
    if (!palace || !existsSync(palace)) return false;
    let names: string[];
    try { names = readdirSync(palace); } catch { return false; }

    let newest = 0;
    for (const name of names) {
      const ts = quarantineStampMs(name);
      if (ts !== null && ts > newest) newest = ts;
    }
    // The boot sweep runs before the first mine precisely so it can seed this:
    // otherwise a palace that arrives with a backlog would read as "just
    // quarantined" and back the loop off before it has mined anything.
    const fresh = this.lastQuarantineTs > 0 && newest > this.lastQuarantineTs;
    if (newest > this.lastQuarantineTs) this.lastQuarantineTs = newest;

    const doomed = quarantineDirsToReap(names.map((name) => ({ name })), Date.now());
    if (!doomed.length) return fresh;
    let removed = 0;
    for (const name of doomed) {
      try { rmSync(join(palace, name), { recursive: true, force: true }); removed += 1; }
      catch { /* locked, gone, or not ours — leave it and try again next pass */ }
    }
    if (removed) console.log(`[memory] reaped ${removed} quarantined palace segment(s)`);
    return fresh;
  }

  private mineAgent(agentDir: string, id: string): Promise<void> {
    return new Promise((resolve) => {
      const bin = this.bin();
      if (!bin) { resolve(); return; }
      ensureMineIgnore(agentDir); // keep settings.json / cursor / messages out of the index
      // stdin closed (mempalace can prompt); mempalace dedups so re-mining is safe.
      const proc = spawn(bin, ['mine', agentDir, '--wing', id, '--agent', id], {
        env: this.childEnv(), stdio: ['ignore', 'ignore', 'pipe']
      });
      let err = '';
      proc.stderr?.on('data', (d) => { err += d.toString(); });
      // Hard ceiling: a wedged mine used to hold its PID forever AND leave
      // `mining` stuck true, silently stopping all future passes. Generous cap
      // because the first run may lazily download the embedding model.
      const timer = setTimeout(() => {
        console.error(`[memory] mine ${id} timed out after ${MINE_TIMEOUT_MS / 60000}min — killing`);
        try { proc.kill('SIGTERM'); } catch { /* gone */ }
        ensureKilled(proc.pid); // SIGKILL sweep if SIGTERM is ignored
      }, MINE_TIMEOUT_MS);
      timer.unref?.();
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          console.error(`[memory] mine ${id} exited ${code}: ${err.slice(-300)}`);
          this.lastMined.delete(id); // let the next tick retry
        }
        resolve();
      });
      proc.on('error', () => { clearTimeout(timer); this.lastMined.delete(id); resolve(); });
    });
  }

  // — recall (read) —

  /** Run one mempalace read command asynchronously. These used to be spawnSync
   *  with a 120s timeout — on a cold model load that BLOCKED the Electron main
   *  process (renderer IPC, timers, every window) for up to two minutes. Same
   *  contract, but the event loop keeps breathing and a wedged CLI is swept. */
  private runCli(args: string[], label: string): Promise<{ ok: boolean; output: string; error?: string }> {
    return new Promise((resolve) => {
      const bin = this.bin();
      if (!this.active() || !bin) { resolve({ ok: false, output: '', error: 'semantic memory not active' }); return; }
      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn(bin, args, { env: this.childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        resolve({ ok: false, output: '', error: e instanceof Error ? e.message : String(e) });
        return;
      }
      let out = '', err = '';
      let settled = false;
      const settle = (r: { ok: boolean; output: string; error?: string }): void => {
        if (!settled) { settled = true; clearTimeout(timer); resolve(r); }
      };
      proc.stdout?.setEncoding('utf8');
      proc.stderr?.setEncoding('utf8');
      proc.stdout?.on('data', (d: string) => { out += d; });
      proc.stderr?.on('data', (d: string) => { err += d; });
      const timer = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch { /* gone */ }
        ensureKilled(proc.pid);
        settle({ ok: false, output: out, error: `${label} timed out` });
      }, 120_000);
      timer.unref?.();
      proc.on('close', (code) => {
        if (code !== 0) settle({ ok: false, output: out, error: (err || `${label} failed`).trim() });
        else settle({ ok: true, output: out });
      });
      proc.on('error', (e) => settle({ ok: false, output: '', error: e.message }));
    });
  }

  /** Semantic search across the shared palace. Returns the CLI's text output. */
  search(query: string, opts: { wing?: string; results?: number } = {}): Promise<{ ok: boolean; output: string; error?: string }> {
    const args = ['search', query, '--results', String(opts.results ?? 5)];
    if (opts.wing) args.push('--wing', opts.wing);
    return this.runCli(args, 'search');
  }

  /** Session-start digest (~600-900 tokens). */
  wakeUp(wing?: string): Promise<{ ok: boolean; output: string; error?: string }> {
    const args = ['wake-up'];
    if (wing) args.push('--wing', wing);
    return this.runCli(args, 'wake-up');
  }
}

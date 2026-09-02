/**
 * MemoryManager —— hive 的语义记忆，由 MemPalace CLI 支撑。
 *
 * 仅 CLI（无 MCP）：harness 在 harnessHome 下维护一个共享宫殿，
 * 把每个 agent 的 `MEMPALACE_PALACE_PATH` 指向它，并把每个 agent 的
 * `memory.md` 挖掘进它自己的侧翼（wing），这样整个团队可以通过
 * `mempalace search` / `mempalace wake-up` 按语义回忆。当 `mempalace`
 * CLI 未安装时静默降级为空操作——markdown 记忆仍然可用。
 *
 *   init    : mempalace init <home> --yes --no-llm        （仅启发式，无 LLM）
 *   store   : mempalace mine <agentDir> --wing <id> --agent <id>
 *   recall  : mempalace search "<q>" --results N   /   mempalace wake-up
 *
 * 运行在 Electron 主进程。
 */
import { existsSync, statSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ensureKilled } from './procKill';
import { quarantineDirsToReap, quarantineStampMs, nextMineDelayMs } from './palaceReap';

/** `mempalace mine` 绝不能摄取的“非记忆”文件：Claude Code hooks 配置
 *  （一块会淹没 wake-up 摘要的大 JSON）、光标位置、原始 inbox/outbox
 *  消息 JSON，以及 Codex worker 私有的 CODEX_HOME。`mempalace
 *  mine` 遵守 .gitignore，所以我们在每个 agent 目录放一份，而不是去改
 *  mine 命令。
 *
 *  必须与 hive.ts 中的 MINE_IGNORE_LINES 保持同步——那份在 agent spawn
 *  时写入，这份在每次 mine 周期写入，而且只有这份能到达当前未运行的
 *  agent。关于 `.codex/` 为什么比 mempalace 更重要，见 hive.ts：它也正是
 *  阻止 hive 的 git 仓库把每一份 Codex transcript 和 sqlite 日志都纳入
 *  版本管理、变成 7.5GB 历史的原因。 */
const MINE_IGNORE_LINES = ['settings.json', 'cursor.json', 'inbox/', 'outbox/', '.codex/'];

/** 幂等地确保 `<agentDir>/.gitignore` 排除这些非记忆文件。
 *  只写入缺失的行（只追加），因此每个周期调用都安全。 */
function ensureMineIgnore(agentDir: string): void {
  const path = join(agentDir, '.gitignore');
  let existing = '';
  try { if (existsSync(path)) existing = readFileSync(path, 'utf8'); } catch { return; }
  const have = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = MINE_IGNORE_LINES.filter((l) => !have.has(l));
  if (missing.length === 0) return; // 已覆盖——不必每个周期重写
  const prefix = existing && !existing.endsWith('\n') ? existing + '\n' : existing;
  try { writeFileSync(path, prefix + missing.join('\n') + '\n', 'utf8'); } catch { /* 尽力而为 */ }
}

export type EmbeddingModel = 'minilm' | 'embeddinggemma';

export interface MemorySettings {
  enabled: boolean;
  model: EmbeddingModel;
}

export interface MemoryStatus {
  available: boolean;        // 在 PATH 上找到了 mempalace CLI
  enabled: boolean;          // 用户设置
  active: boolean;           // 可用 && 已启用 && 有 home
  initialized: boolean;      // 宫殿目录存在
  palacePath: string | null;
  model: EmbeddingModel;
  bin: string | null;
}

// 每 10 分钟重新挖掘一遍变化的记忆，由原来的 3 分钟延长而来。
//
// 每次 `mempalace mine` 都会打开宫殿，而每次打开都会运行 MemPalace 的
// 隔离门——对卡在重命名循环里的宫殿来说，这意味着磁盘上又多一份
// 完整尺寸的段拷贝。那道门不归我们修，但“多久触发一次”归我们管。
// 对于 memory.md 未变化的 agent，挖掘本来就会跳过，所以这只影响
// 反复编辑笔记的 agent：它的改动会被合并成一次挖掘而不是三次。
// 现在写入的记忆十分钟后可搜索，而不是三分钟——没有人会等这三分钟。
// `reapPalace` 负责处理仍然产生的拷贝。
const MINE_INTERVAL_MS = 600_000;
// 下面隔离退避的上限。刻意设低：记忆在挖掘之前不可被搜索，
// 而磁盘已经由收割器处理，因此这里没有任何值得让 recall
// 过期半小时来换的东西。
const MINE_BACKOFF_MAX_MS = 1_800_000;
const MINE_TIMEOUT_MS = 10 * 60_000; // 每次挖掘的硬上限（首次运行会下载嵌入模型）
/** mempalace 的设备 "auto" 在 Apple Silicon 上会选择 CoreML 执行提供方，
 *  而 CoreML 只能部分运行量化后的 embeddinggemma ONNX 图
 *  （330/1647 个节点），fp16 分区会溢出 → 每个向量都返回 NaN，
 *  chroma 拒绝每一次 upsert（“Embeddings must not contain NaN or
 *  Infinity values”），于是没有任何记忆被索引。2026-08-16 复现并验证：
 *  相同的输入在 CoreMLExecutionProvider 下是 NaN，在 CPU 下干净。
 *  把 mine 循环和 agent 自己的 `mempalace search` 都钉在 cpu 上
 *  （查询被嵌入成 NaN 会以同样的方式破坏 recall）。
 *
 *  范围刻意是“整个 macOS”而不是按模型：这个钉扎对另一个模型毫无代价。
 *  minilm 走 chromadb 的 ONNXMiniLM_L6_V2，它构建模型时无条件移除
 *  CoreMLExecutionProvider（“不如 CPU 优化得好”——chromadb 原话），
 *  因此无论有没有这个钉扎，minilm 都绝不会跑在 CoreML 上；
 *  embeddinggemma（mempalace 自己的 ONNX 类，没有这种裁剪）是唯一
 *  会触及 CoreML 的路径，而那正是 NaN bug。其他平台保留 mempalace
 *  自己的默认（"auto"）。
 *
 *  用户自己的设备选择优先：若 MEMPALACE_EMBEDDING_DEVICE 已导出，
 *  我们就不输出任何东西，让继承的值原样流过——这也留下了一条复现
 *  NaN 行为的单命令途径（`MEMPALACE_EMBEDDING_DEVICE=coreml`）。
 *  以 (platform, envOverride) 的函数形式导出，让每个分支都能从任何
 *  平台上的测试触达——与 `buildMissingCliScript` 相同的手法。 */
export function mempalaceDevice(
  platform: NodeJS.Platform,
  envOverride: string | undefined
): string | undefined {
  if (envOverride) return undefined; // 用户显式选择——绝不覆盖
  return platform === 'darwin' ? 'cpu' : undefined;
}
const MEMPALACE_DEVICE = mempalaceDevice(process.platform, process.env.MEMPALACE_EMBEDDING_DEVICE);

export class MemoryManager {
  private binCache: string | null | undefined;
  private mineTimer: NodeJS.Timeout | null = null;
  private mineStopped = false;
  /** 当前两次挖掘之间的间隔。宫殿在隔离期间会变宽。 */
  private mineDelayMs = MINE_INTERVAL_MS;
  /** 目前见过的最新隔离时间戳，因此“更晚”的一个意味着宫殿再次隔离。
   *  计数没有用：收割器会删掉它们。 */
  private lastQuarantineTs = 0;
  private initStarted = false;
  /** 当一次 mineNow() 正在执行时为 true——让宫殿写入者串行化。 */
  private mining = false;
  /** agentId → 上次成功挖掘时 memory.md 的 mtimeMs（跳过未变化的）。 */
  private lastMined = new Map<string, number>();

  constructor(
    private getHome: () => string | null,
    private getSettings: () => MemorySettings
  ) {}

  palacePath(): string | null {
    const h = this.getHome();
    return h ? join(h, 'palace') : null;
  }

  /** 按用户的 PATH + 常见的 uv/pip 安装位置解析 mempalace CLI。 */
  bin(): string | null {
    if (this.binCache !== undefined) return this.binCache;
    let found: string | null = null;
    const isWin = process.platform === 'win32';
    // 1) 询问 shell/PATH 解析器。Windows 没有 POSIX shell，用 `where`
    //    和 `.exe` 后缀；其余平台都走登录 shell。
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
    } catch { /* 继续往下 */ }
    // 2) 探测常见安装位置（uv tool / homebrew / pip）。
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
    this.binCache = found;
    return found;
  }
  /** 强制重新解析（例如在用户安装 mempalace 之后）。 */
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

  /** 并入每个 agent spawn 的 env，让它的 `mempalace` CLI 命中共享宫殿。 */
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

  // —— 生命周期 ——

  /** 启动挖掘循环。`mempalace mine` 在首次运行时自动创建宫殿
   *  （一次性懒下载嵌入模型）。我们刻意不运行 `mempalace init`：
   *  它最终会停在交互式 "Mine now? [Y/n]" 提示上，--yes 覆盖不到，
   *  于是派生的子进程会永远挂起。 */
  start(): void {
    if (!this.active() || this.initStarted) return;
    if (!this.bin() || !this.getHome() || !this.palacePath()) return;
    this.initStarted = true;
    // 启动时先清扫一次，在第一次挖掘之前。升级到这个修复的应用，
    // 面对的是一个从运行起就一直在累积拷贝的宫殿——这里有 357 个——
    // 而等着第一个 agent 去编辑它的 memory.md，会让这些拷贝在磁盘上
    // 任意逗留。正是这一趟让既有的一大堆自行消失。
    this.reapPalace();
    this.startMineLoop();
  }

  stop(): void {
    this.mineStopped = true;
    if (this.mineTimer) { clearTimeout(this.mineTimer); this.mineTimer = null; }
  }

  /**
   * 重新解析 CLI；若直到现在才可行，就武装挖掘循环，并汇报。
   *
   * `start()` 在启动时运行一次，当 mempalace 还不在 PATH 上时就退出。如果
   * 用户在那之后才安装（常见情况，因为设置面板正是他们发现自己需要它的
   * 地方）——没有任何东西会再次调用 `start()`，于是挖掘循环从未运行。
   * 宫殿由第一次 `mempalace mine` 创建，所以它也从未出现；`initialized`
   * （existsSync(palace)）保持 false，而 `available` 已翻成 true：状态胶囊
   * 永远显示 "On — getting ready…"，只有重启应用才能清除。
   *
   * 状态轮询是唯一可靠察觉安装的东西，所以重新武装应当发生在这里。
   * `start()` 是幂等的（initStarted），重复轮询绝不会启动第二个循环——
   * 而且它仍然刻意不运行 `mempalace init`，那会停在交互式
   * "Mine now? [Y/n]" 上，`--yes` 覆盖不到，还会挂住派生的子进程。
   */
  refresh(): MemoryStatus {
    this.resetBinCache();
    this.start();
    return this.status();
  }

  /** 自我调度而不是用 `setInterval`，这样宫殿隔离期间间隔可以变宽，
   *  隔离一停止就立刻弹回。 */
  private startMineLoop(): void {
    if (this.mineTimer) return;
    const tick = () => {
      void this.mineNow().finally(() => {
        if (this.mineStopped) return;
        this.mineTimer = setTimeout(tick, this.mineDelayMs);
        this.mineTimer.unref?.();
      });
    };
    // 同步武装。`mineTimer` 是“循环在跑吗”的信号，`refresh()` 在 `start()`
    // 之后紧跟着上报它；如果等到第一次挖掘完成才设置它，
    // 就会在整整一个周期内把循环报成死的——
    // 这正是“安装后重新武装”的情形，它有自己的测试。
    this.mineTimer = setTimeout(tick, 0);
    this.mineTimer.unref?.();
  }

  // —— 挖掘（store）——

  /** 逐个挖掘自上次以来记忆发生变化的每个 agent。
   *  宫殿只允许一个写入者，因此挖掘必须串行化——并发触发会让
   *  除一个之外全部以 "held by another writer" 失败。
   *  `mining` 防止慢速的一趟与下一个间隔滴答重叠。 */
  async mineNow(): Promise<void> {
    const home = this.getHome();
    const bin = this.bin();
    if (!this.active() || !home || !bin) return;
    if (this.mining) return; // 上一趟还在运行——让它完成
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
        if (this.lastMined.get(id) === mtime) continue; // 未变化——跳过模型加载
        this.lastMined.set(id, mtime);
        await this.mineAgent(agentDir, id); // 一次一个写入者
      }
    } finally {
      this.mining = false;
    }
    // 上面的每一趟都可能又留下一份拷贝，而是否留下
    // 决定了我们等多久再跑下一趟。
    const quarantined = this.reapPalace();
    this.mineDelayMs = nextMineDelayMs(
      this.mineDelayMs, MINE_INTERVAL_MS, MINE_BACKOFF_MAX_MS, quarantined
    );
  }

  /**
   * 删除 MemPalace 改名挪开、却从未移除的被隔离段拷贝。
   *
   * 可以安全删除：改名正是把它们从宫殿“在线集合”中拿出去的动作，
   * 而且我们见到一个时 Chroma 早已重建完毕。它们是诊断残渣。
   * `quarantineDirsToReap` 保留最新的几个，这样总还有东西可看，
   * 并且拒绝碰任何仍在恢复期、太新的目录。
   *
   * 全程尽力而为。一个读不了的宫殿，或一个删不掉的目录，
   * 绝不能拖垮挖掘循环——这是磁盘卫生，不是正确性路径。
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
    // 启动清扫恰好在第一次挖掘前运行，正是为了给这里播种：
    // 否则一个带着积压而来的宫殿会被读成“刚刚隔离过”，
    // 在挖掘任何东西之前就把循环退避了。
    const fresh = this.lastQuarantineTs > 0 && newest > this.lastQuarantineTs;
    if (newest > this.lastQuarantineTs) this.lastQuarantineTs = newest;

    const doomed = quarantineDirsToReap(names.map((name) => ({ name })), Date.now());
    if (!doomed.length) return fresh;
    let removed = 0;
    for (const name of doomed) {
      try { rmSync(join(palace, name), { recursive: true, force: true }); removed += 1; }
      catch { /* 被锁、已消失或不是我们的——留着它，下一趟再试 */ }
    }
    if (removed) console.log(`[memory] reaped ${removed} quarantined palace segment(s)`);
    return fresh;
  }

  private mineAgent(agentDir: string, id: string): Promise<void> {
    return new Promise((resolve) => {
      const bin = this.bin();
      if (!bin) { resolve(); return; }
      ensureMineIgnore(agentDir); // 让 settings.json / 光标 / 消息不进入索引
      // stdin 已关闭（mempalace 可能会提示）；mempalace 会去重，重挖安全。
      const proc = spawn(bin, ['mine', agentDir, '--wing', id, '--agent', id], {
        env: this.childEnv(), stdio: ['ignore', 'ignore', 'pipe']
      });
      let err = '';
      proc.stderr?.on('data', (d) => { err += d.toString(); });
      // 硬上限：卡死的挖掘过去会永远占着 PID，还把 `mining` 卡在 true，
      // 静默地停掉所有后续趟次。上限给得宽，
      // 因为首次运行可能要懒下载嵌入模型。
      const timer = setTimeout(() => {
        console.error(`[memory] mine ${id} timed out after ${MINE_TIMEOUT_MS / 60000}min — killing`);
        try { proc.kill('SIGTERM'); } catch { /* 已消失 */ }
        ensureKilled(proc.pid); // SIGTERM 被忽略时用 SIGKILL 清扫
      }, MINE_TIMEOUT_MS);
      timer.unref?.();
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          console.error(`[memory] mine ${id} exited ${code}: ${err.slice(-300)}`);
          this.lastMined.delete(id); // 让下一个滴答重试
        }
        resolve();
      });
      proc.on('error', () => { clearTimeout(timer); this.lastMined.delete(id); resolve(); });
    });
  }

  // —— 回忆（read）——

  /** 异步运行一条 mempalace 读取命令。过去它们是带 120 秒超时的 spawnSync——
 *  冷模型加载时会阻塞 Electron 主进程（渲染进程 IPC、定时器、每个窗口）
 *  长达两分钟。契约相同，但事件循环保持呼吸，卡死的 CLI 会被清扫。 */
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
        try { proc.kill('SIGTERM'); } catch { /* 已消失 */ }
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

  /** 跨共享宫殿的语义搜索。返回 CLI 的文本输出。 */
  search(query: string, opts: { wing?: string; results?: number } = {}): Promise<{ ok: boolean; output: string; error?: string }> {
    const args = ['search', query, '--results', String(opts.results ?? 5)];
    if (opts.wing) args.push('--wing', opts.wing);
    return this.runCli(args, 'search');
  }

  /** 会话开始摘要（约 600-900 token）。 */
  wakeUp(wing?: string): Promise<{ ok: boolean; output: string; error?: string }> {
    const args = ['wake-up'];
    if (wing) args.push('--wing', wing);
    return this.runCli(args, 'wake-up');
  }
}

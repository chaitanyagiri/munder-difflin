import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, powerMonitor, powerSaveBlocker, screen, shell, Notification } from 'electron';
import { l10n } from './l10n';
import { spawn } from 'node:child_process';
import {
  rmSync, existsSync, readFileSync, readdirSync, statSync, cpSync, writeFileSync,
  unlinkSync, mkdirSync, renameSync, createWriteStream, copyFileSync, lstatSync,
  readlinkSync, symlinkSync
} from 'node:fs';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { join, resolve, sep, basename, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { request as httpsRequest } from 'node:https';
import { PtyManager, type SpawnOptions } from './pty';
import { resolveCommand as resolveCliCommand, isSafeCommandName } from './shellEnv';
import { initAutoUpdater, abortPendingRestart } from './updater';
import { RealtimeFloorWatcher } from './realtimeFloorWatcher';
import {
  readConfig, writeConfig, setAgentTokenCap, resetConfig, onConfigWritten, ensureHarnessHome, ensureClaudePermissionsAccepted,
  modelForRole, OPS_STANDUP_MISSION, HEARTBEAT_MISSION, COMPACT_MAINTENANCE_MISSION, type HarnessConfig, type ScheduledMission
} from './config';
import { listDir, readFileText, readFileBinary, writeFileText, statAbs, expandTilde } from './fs';
import { normalizeWeekly, weeklyDelayMs } from '../shared/weeklySchedule';
import {
  getBranch, getStatus, getLog, getBranches, getAheadBehind, isRepo, getDiff, mainRepoRoot,
  addWorktree, removeWorktree, worktreeHasUnintegratedWork, worktreeIsGcSafe,
  getLogGraph, getCommitFiles, getFileAtRev, compareRefs, listWorktrees, checkoutRef
} from './git';
import { HiveManager, type AgentMeta, type HiveMessage, type HiveTask } from './hive';
import { HookServer } from './hooks';
import { CircuitBreaker, type BreakerInput } from './breaker';
import type { UsageProvider } from './usage';
import { MemoryManager } from './memory';
import { KnowledgeManager } from './knowledge';
import { MemoryReflector, type ReflectSettings } from './reflect';
import { PersistStore } from './db';
import { readAgentUsage, readContextTokens, seedSessionTranscript, resolveSessionCwd } from './transcript';
import { listIssues, listCIRuns } from './github';
import { SlackWebhookServer, SlackReplyServer, postSlackReply, type SlackEventFile } from './slack';
import {
  WebhookServer,
  type WebhookDispatch, type WebhookEndpointRef, type WebhookInbound, type WebhookTaskStatus
} from './webhook';
import {
  classifyInboundKind, isAutoAllowed,
  DEFAULT_CONTEXT_TRIGGER, DEFAULT_ORG_TRIGGER, DEFAULT_TRIGGER_MODE, DEFAULT_WEBHOOK_SCHEMA,
  type ContextRule, type ContextTriggerConfig, type InboundKind, type OrgTriggerConfig,
  type TriggerHistoryEntry, type TriggerMode, type WebhookTrigger
} from '../shared/triggers';
import {
  appendTriggerHistory, clearTriggerHistory, listTriggerHistory, updateTriggerHistory
} from './triggerHistory';
import { transcribeWithGroq, DEFAULT_GROQ_MODEL } from './freeflow';
import { registerRealtimeIpc } from './realtime';
import { registerRealtimeActionIpc } from './realtimeActions';
import { initCompletionWatcher } from './realtimeCompletionWatcher';
import type { TaskCard, InboxMessage } from './realtimeCompletionWatcher';
import { TelemetryCollector } from './telemetry';
import { CostLedgerTotals } from './costLifetime';
import { analytics, isRendererMessageSurface } from './analytics';
import type { SpawnFailReason } from './analytics';
import { IntegrationBroker } from './integrationBroker';
import * as integrations from './integrations';
import { validateBaseUrl, buildAuthHeaders, resolveUpstreamUrl, secretRefFor, INTEGRATION_TEMPLATES } from '../shared/integrations';
import { RosterStore } from './roster';
import { buildWorkerLaunch } from './workerLaunch';
import { ControlRegistry } from './control';
import { WorkerWakeWatchdog, type WorkerWakeFacts } from './workerWake';
import { inboxNudgeText } from '../shared/hiveNudge';
import { resolveGodName } from '../shared/godIdentity';
import { fetchHireManifest, readHireManifestFiles } from './hire';
import { parseHireDeepLink, type HireManifest } from '../shared/hire';
import { ClosingTimeController } from './closingTime';
import {
  argsWithAutoModeFlag,
  inferAgentProvider,
  isClaudeProvider,
  nonInteractiveEnvForProvider,
  providerPreset,
  installInfoForProvider,
  type AgentProvider
} from '../shared/agentProvider';
import { buildMissingCliScript, chooseInstallRung } from './cliInstall';
import { detectNodeVersion, nodeIsUsable, resolveNodeInstaller } from './nodeInstall';
import { toolCatalog, type ToolStatus } from '../shared/toolCatalog';
import { listLocalSkills, loadCatalog, installSkill, uninstallSkill, type LocalSkill } from './skills';
import { loadHero } from './hero';
import {
  CODEX_REMOTE_SOCKET_RELATIVE,
  codexRemoteAliasPath,
  codexRemoteEndpoint,
  codexRemoteSocketFits,
  withCodexRemoteArgs
} from '../shared/codexRemote';

const isDev = !!process.env.ELECTRON_RENDERER_URL;

// 让主进程在意外 throw/rejection 时保持存活。harness 是一个多 agent 的
// 监督者——任何一次孤立的异常（例如 node-pty 的 ConPTY 控制台助手在快速退出的
// agent CLI 控制台已消失时卡死）都绝不能把整个应用和所有运行中的 agent 一起拖垮。
// 记录日志并继续运行，而不是让默认处理器退出进程。
// （在 #71 合并期间恢复——该 PR 的 rebase 把这两个处理器弄丢了。）
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException (kept alive):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection (kept alive):', reason);
});

const ptyManager = new PtyManager();

function runCodexDaemonCommand(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 20_000
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolveResult) => {
    let settled = false;
    let stderr = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, args, {
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true
      });
    } catch (e) {
      resolveResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    let timer: NodeJS.Timeout;
    const finish = (result: { ok: boolean; error?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 8_000) stderr += String(chunk);
    });
    child.once('error', (e) => finish({ ok: false, error: e.message }));
    child.once('exit', (code) => {
      finish(code === 0
        ? { ok: true }
        : { ok: false, error: stderr.trim() || `Codex exited with code ${code ?? 'unknown'}` });
    });
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      finish({ ok: false, error: `Codex daemon command timed out after ${timeoutMs}ms` });
    }, timeoutMs);
  });
}

/** 为这个隔离的 Codex home 启动/启用一个受管的远程控制守护进程，
 * 然后把 TUI 指向它的 app-server socket。失败不致命：worker 仍会
 * 以普通本地 Codex 会话的方式启动。 */
async function enableCodexRemoteForSpawn(
  opts: SpawnOptions & { hive?: AgentMeta },
  agentId: string
): Promise<boolean> {
  if (process.platform === 'win32') return false;
  const realHome = opts.env?.CODEX_HOME;
  if (!realHome) return false;
  try {
    const alias = codexRemoteAliasPath(realHome, agentId);
    // 在触碰文件系统之前先退出：即使短别名也会超过 sun_path——守护进程
    // 会启动后因 bind 失败而死，而下面的告警会点出真实原因，而不是一个
    // 笼统的 readiness 超时。
    if (!codexRemoteSocketFits(alias)) {
      console.warn('[codex-remote] socket path exceeds sun_path; starting local TUI:', alias);
      return false;
    }
    const aliasRoot = dirname(alias);
    mkdirSync(aliasRoot, { recursive: true });
    if (existsSync(alias)) {
      const st = lstatSync(alias);
      if (!st.isSymbolicLink() || resolve(dirname(alias), readlinkSync(alias)) !== resolve(realHome)) {
        console.warn('[codex-remote] short home alias is occupied; starting local TUI:', alias);
        return false;
      }
    } else {
      symlinkSync(realHome, alias, 'dir');
    }

    const socket = join(alias, CODEX_REMOTE_SOCKET_RELATIVE);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(opts.env ?? {}),
      CODEX_HOME: alias
    };
    // shellEnv 的解析器镜像了 PtyManager 的解析方式（后者是私有的，返回
    // {path, found}）；守护进程只需要拿到最佳可执行文件路径即可。
    const executable = resolveCliCommand(opts.command);
    const started = await runCodexDaemonCommand(
      executable,
      ['app-server', 'daemon', 'start'],
      env
    );
    if (!started.ok) {
      console.warn('[codex-remote] daemon start failed; starting local TUI:', started.error);
      return false;
    }
    const enabled = await runCodexDaemonCommand(
      executable,
      ['app-server', 'daemon', 'enable-remote-control'],
      env
    );
    if (!enabled.ok) {
      console.warn('[codex-remote] enable failed; starting local TUI:', enabled.error);
      return false;
    }
    if (!existsSync(socket)) {
      console.warn('[codex-remote] daemon returned without a control socket; starting local TUI');
      return false;
    }
    opts.env = { ...(opts.env ?? {}), CODEX_HOME: alias };
    opts.args = withCodexRemoteArgs(opts.args ?? [], codexRemoteEndpoint(alias));
    return true;
  } catch (e) {
    console.warn('[codex-remote] setup failed; starting local TUI:',
      e instanceof Error ? e.message : e);
    return false;
  }
}
/** 活跃 PTY id → 其 hive agent id，在 spawn 时记录。pty:kill 处理器只能拿到
 *  PTY id，所以有了它，关闭标签页时就能归档正确的 registry agent。 */
const ptyToAgent = new Map<string, string>();
/** PTY id → 首次 CLI 安装完成后应自动重启并继续进入的 spawn。缺 CLI 的
 *  短路路径会在这个 PTY 里运行引擎的安装器；当它干净退出时，退出处理器会
 *  重新运行同一个 spawn（禁用安装），于是刚装好的 CLI 会在同一个
 *  pty/window 里启动——无需用户点击。一旦被消费就清除，因此绝不会循环安装。 */
const pendingInstallRelaunch = new Map<string, { opts: AgentSpawnOptions; owner: Electron.WebContents | null; bin: string; rung: string }>();
const hive = new HiveManager(
  () => readConfig().harnessHome,
  (channel, payload) => {
    const wc = liveWebContents();
    if (!wc) return false;
    try { wc.send(channel, payload); return true; } catch { return false; }
  }
);
// #7C — 操作者控制状态（pause/gate/steer/halt），由 HookServer 在决定
// hook 返回值时读取。
const control = new ControlRegistry();
// Stage 7A — 实时可观测性探针。通过 loopback OTLP/JSON 接收 Claude Code 的
// 第一方 OTel，并暴露锁定的 usage-provider 接缝。resolveCwd 让 transcript
// 回退机制能从 hive registry 找到 agent 的 cwd。
const telemetry = new TelemetryCollector({
  emit: (channel, payload) => { try { liveWebContents()?.send(channel, payload); } catch { /* 窗口已拆除 */ } },
  resolveCwd: (agentId) => hive.registry().agents[agentId]?.cwd ?? null,
  // D11: 把 transcript 回退范围限定到该 agent 自己的会话，而不是把
  // （通常共享的）cwd 里的每一条 transcript 都加起来。
  resolveSessionId: (agentId) => hive.lastSession(agentId)
});
// Usage provider（Seam 1）— INTEGRATION 交换：Oscar 的 telemetry 收集器（#7）
// 就是 provider，取代 Lane A 的临时 StubUsageProvider。沿用同一个
// getAgentUsage(agentId) 拉取接缝，因此 breaker + 成本账本的使用方都不受影响；
// telemetry 内置 transcript 回退，所以在任何实时 OTel 到达之前就能工作。
const usageProvider: UsageProvider = telemetry;
// Circuit breaker（Lane A #6.6b）— 真正的策略（取代 Lane C 的临时粘合层）。
// 仅策略本身；heartbeat beat 通过 usageProvider 喂给它信号，并执行它的决策。
// 配置实时读取，因此设置变更在下一个 beat 即生效。
const breaker = new CircuitBreaker(() => {
  const c = readConfig();
  return { ...(c.circuitBreaker ?? {}), costCapUsd: c.costCapUsd, costCapTokens: c.costCapTokens, agentTokenCaps: c.agentTokenCaps };
});
// 常开 beat（与可选的 heartbeat 解耦）：Michael 读取的实时 fleet 快照 +
// breaker beat，这样即使 heartbeat 任务被禁用（它随产品出厂），护栏与监控仍能工作。
let fleetTimer: ReturnType<typeof setInterval> | null = null;
let breakerBeatTimer: ReturnType<typeof setInterval> | null = null;
// 用 Oscar 的 OTel api_error spans 喂给 breaker 的 api_error 风暴熔断——
// Jim 唯一一个没有 on-branch 来源的 breaker 输入（telemetry.onApiError 接缝）。
telemetry.onApiError((agentId) => breaker.recordError(agentId));
// 磁盘上的共享 roster —— 尽早创建，这样 HookServer 能在每次 UserPromptSubmit
// 时重新读取常驻目标（Edit Agent 的保存经 persistAgents 落到这里）。
const roster = new RosterStore(() => readConfig().harnessHome);
function standingGoalFromRoster(agentId: string): string | null {
  const snap = roster.read();
  if (!snap || !Array.isArray(snap.agents)) return null;
  for (const entry of snap.agents) {
    if (!entry || typeof entry !== 'object') continue;
    const a = entry as { id?: unknown; goal?: unknown };
    if (a.id !== agentId) continue;
    return typeof a.goal === 'string' && a.goal.trim() ? a.goal.trim() : null;
  }
  return null;
}
// Worker inbox-wake watchdog（#151）：找出收件箱有未读邮件的空闲 worker，
// 并打出渲染进程本会发出的同款受控提醒（这样被限流的后台窗口不会让 worker
// 永远停在未读收件箱上）。HookServer 把 hook 流喂给它，因此权限/HITL
// 提示会阻止 nudge。
const workerWake = new WorkerWakeWatchdog();
// HookServer 两者都需要：Oscar 的控制注册表（经 hook 返回实现 HITL
// pause/gate/steer/halt）以及 Jim 的 breaker（在每次 PostToolUse 喂 recordToolUse）。
const hookServer = new HookServer(
  hive,
  () => liveWebContents(),
  () => readConfig(),
  control,
  breaker,
  standingGoalFromRoster,
  (agentId, event, message) => workerWake.noteHook(agentId, event, message)
);
const memory = new MemoryManager(
  () => readConfig().harnessHome,
  () => { const c = readConfig(); return { enabled: c.semanticMemory !== false, model: c.embeddingModel ?? 'minilm' }; }
);
// Enterprise Knowledge Graph —— 文件后端存储 + agent CLI（默认关闭）。
const knowledge = new KnowledgeManager();
/** 每次 tick 从 config 读取 reflect 可调参数（默认值内置在这里，因此一个
 *  不含这些键的既有 config.json 仍能拿到合理值）。 */
function reflectSettings(): ReflectSettings {
  const c = readConfig();
  return {
    enabled: c.reflectEnabled !== false,
    intervalMs: c.reflectIntervalMs ?? 1_800_000,
    byteTriggerPct: c.reflectByteTriggerPct ?? 50,
    sectionTrigger: c.reflectSectionTrigger ?? 50,
    recentKeep: c.reflectRecentKeep ?? 12,
    minBytes: c.reflectMinBytes ?? 16_384
  };
}
// 补齐 janitor 缺失的 condense 半边：限制每个 agent 的 memory.md 大小
// （Haiku 尾部摘要、备份→校验→原子替换），使其永不无限增长。
const reflector = new MemoryReflector(
  () => readConfig().harnessHome,
  () => readConfig().defaultCommand ?? 'claude',
  () => memory.env(),
  reflectSettings,
  (event) => { try { hive.appendLog(event); } catch { /* 尽力而为 */ } }
);
// 持久化 harness 状态（SQLite，主进程）。Phase A：窗口边界（kv）+ 全新命令历史。
// 在 whenReady 中打开，在 teardown 块中关闭。
const persist = new PersistStore();
/** 主窗口 —— 运行 hive/god 编排的窗口，也是进程级全局定时事件
 * （missions、breaker、Slack 摄取）的落点。它是最新聚焦的活跃窗口，
 * 因此全局事件跟随用户。额外的 “floor” 窗口记录在下面的 `allWindows` 中。 */
let mainWindow: BrowserWindow | null = null;
/** 所有打开的窗口（主窗口 + floors）。它是注册表而非单个句柄，因此
 *  多窗口生命周期（焦点跟踪、退出扇出）是正确的。 */
const allWindows = new Set<BrowserWindow>();
/** 单调 floor 计数器 → 每个 floor 一个稳定、唯一的会话分区，因此每个
 *  floor 的渲染进程状态（localStorage：agents、queues、selection）都与其他
 *  窗口完全隔离。 */
let floorSeq = 0;

/** 为 true 时，跳过退出拦截器（用户已确认）。 */
let allowQuit = false;

/** 以 `isolate: true` 生成的 agent 会得到一个专用 git worktree；本映射把
 *  agent/pty id → worktree 路径，这样 kill 时能拆除它。 */
const worktreePaths = new Map<string, string>();
/** id → 创建该 worktree 时所在的原始仓库 cwd（需要在父树上运行
 *  `git worktree remove`，而不是在 worktree 自身里）。 */
const worktreeOrigins = new Map<string, string>();

/** 一个活跃的、由 god 触发的临时 worker，从 spawn 跟踪到 teardown。 */
interface WorkerRec {
  workerId: string;       // == PTY id == hive agent id（`worker-<reqId>`）
  reqId: string;          // spawn-request 的 id
  name?: string;          // 显示名（用于 worker 标签页）
  slack?: { channel: string; thread_ts: string };
  baseBranch: string;     // 其 worktree 从中切出的分支（用于 ahead-of-base 判断）
  spawnedAt: number;      // epoch 毫秒
  releasing?: boolean;    // 已发出 kill；等待 teardownPty（跳过重复处理）
  /** 来自 spawn-request 的每 worker TOTAL-token 上限（覆盖 config
   *  默认值）。0/undefined = 无每请求上限。P4 管道——目前不限。 */
  tokenCap?: number;
}
/** 按 id 索引的活跃临时 worker。由 spawn-request watcher 填充；teardownPty
 *  查询它，从而在已结束/崩溃/被回收的 worker 持有未集成工作时保留其 worktree
 *  （而非强制移除）——god 是唯一的集成者。 */
const liveWorkers = new Map<string, WorkerRec>();

/** loopback 密钥经纪人（Phase 2）。worker 通过它访问已注册的集成，而永远不会
 *  看到任何凭据。getRecord/getSecret 被注入，因此经纪人保持无 electron 依赖且
 *  可单测。在 bootstrapHiveServices 中启动；每个 worker 在 spawn 时被授予
 *  每 worker 的能力 token（在 teardownPty 中撤销）。 */
const integrationBroker = new IntegrationBroker({
  getRecord: integrations.getRecord,
  getSecret: integrations.getSecret
});

/** BYOK 后端模型提供方：非 Claude CLI 引擎（OpenCode/Crush/pi/qwen）从标准
 *  环境变量读取其 API 密钥。密钥以 WRITE-ONLY 方式存储在与 integrations 相同的
 *  加密密钥经纪人中，键为 `apikey:<backend>`，且仅在 spawn 时于 MAIN 侧实体化
 *  （绝不经过 IPC）。 */
const BACKEND_KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY'
};
const providerKeyRef = (backend: string): string => `apikey:${backend}`;

/** teardown 因持有未集成工作而保留的 worker worktree。跟踪它，以便一旦工作
 *  落入 base 或被手工移除，GC sweep 就能回收它（连同其 scratch 目录）——
 *  见 gcPreservedWorktrees()。 */
interface PreservedWorktree {
  workerId: string;
  wtPath: string;
  origCwd: string;        // 用于运行 `git worktree remove` 的父仓库
  baseBranch: string;     // 据此重新检查“是否已集成？”
  scratchDir: string | null; // HIVE_ROOT/agents/<workerId> —— 与 worktree 一起移除
  slack?: { channel: string; thread_ts: string };
  preservedAt: number;    // epoch 毫秒
}
/** 等待集成的已保留 worker worktrees，按 worktree 路径为键。GC sweep 会清空
 *  它：只有工作被证实已集成、或 worktree 已从磁盘消失时，条目才会被移除
 * （worktree + scratch 一并 GC）。 */
const preservedWorktrees = new Map<string, PreservedWorktree>();

/**
 * 拆除与某个 PTY id 相关的一切：归档其 hive agent、移除其隔离 git worktree、
 * 并清除簿记 map 条目。在显式 `pty:kill` 和自然 PTY 退出（子进程结束、崩溃、
 * 或从外部被杀）两种情况下都会运行——否则 agent 会一直保持 “active”
 * （广播会继续投递到已死的收件箱）、worktree 会变成孤儿（还在用户真实仓库里
 * 留下悬空的 `git worktree` 注册），map 也会为每个死 PTY 泄漏一条条目。
 *
 * 幂等：以 map 存在性和本就幂等的 `hive.setArchived` 为守卫，因此重复调用是
 * 无害的空操作。注意：显式 `ptyManager.kill()` 不会经 onExit 到达这里——
 * kill() 会同步删除会话，所以 node-pty 之后的异步退出回调会因会话身份守卫而
 * 失败并被吞掉。因此每个 kill 调用点都必须在 kill 之后自己调用 teardownPty
 * （它们全都这么做了）。尽力而为——每一步都包了 try，因此 teardown 错误
 * 绝不会让调用方（IPC 处理器或 node-pty 的 onExit）崩溃。
 */
function teardownPty(id: string): void {
  // 临时-worker 标志，必须在下面的清理删除该条目之前读取。所有 worker 死亡
  // （完成释放、空闲/token 回收、手动停止、崩溃）都汇聚到这里，所以这里是
  // 它们的 floor 卡片被归档的唯一地点（worker 卡片经 processSpawnRequest 中
  // 的 hive:agentSpawned 广播）。对 worker 而言，pty id == worker id == agent id。
  const wasWorker = liveWorkers.has(id);
  // 0) 撤销该 id 的经纪人能力（如有）。对非 worker PTY 幂等且无害；
  //    确保死 worker 的 token 永远无法触达任何集成。
  try { integrationBroker.revoke(id); } catch { /* 尽力而为 */ }
  // 1) 归档 agent —— 保留并标记；只有持有活跃 PTY 的 agent 才处于 active。
  const agentId = ptyToAgent.get(id);
  if (agentId) {
    ptyToAgent.delete(id);
    // 丢弃 watchdog 状态，这样死 agent 不会被 nudge，也不会泄漏宽限期。
    try { workerWake.forget(agentId, id); } catch { /* 尽力而为 */ }
    // 丢弃 breaker 状态，这样死 agent 不会泄漏/僵尸化一个已熔断的等级。
    try { breaker.forget(agentId); } catch { /* 尽力而为 */ }
    // 复用该 id 的替代品需要全新的 usage 计数器，而不是死 PTY 的那个。
    try { telemetry.forgetAgent(agentId); } catch { /* 尽力而为 */ }
    // W1 —— 若存在，杀掉该 agent 的代理桥接 sidecar（qwen），这样死 PTY
    // 绝不会留下孤儿 loopback 监听器。对非代理 agent 为空操作。
    try { hive.stopProxyBridge(agentId); } catch (e) { console.error('[hive] stopProxyBridge failed:', e); }
    if (hive.enabled()) {
      try { hive.setArchived(agentId, true); } catch (e) { console.error('[hive] setArchived failed:', e); }
    }
  }
  // 2) 移除隔离 worktree（如有）。非阻塞；错误会被记录。
  const wtPath = worktreePaths.get(id);
  if (wtPath) {
    const origCwd = worktreeOrigins.get(id) ?? wtPath;
    worktreePaths.delete(id);
    worktreeOrigins.delete(id);
    // 临时 worker 走 SAFETY-GATED teardown：绝不自动移除持有未集成工作的
    // worktree。它位于 teardownPty 内部，因此覆盖所有 teardown 路径——已结束
    // （控制器 kill）、已崩溃、或被空闲回收的 worker 都会落在这里。普通 agent
    // 保留立即的强制移除。
    const worker = liveWorkers.get(id);
    if (worker) {
      liveWorkers.delete(id);
      void finalizeWorkerWorktree(wtPath, origCwd, worker);
    } else {
      void removeWorktree(origCwd, wtPath)
        .then(r => { if (!r.ok) console.error('[worktree] removeWorktree failed:', r.error); })
        .catch(e => console.error('[worktree] removeWorktree threw:', e));
    }
  }
  // 隔离失败的 worker（非仓库 cwd）没有 worktree 需要上面的门控——仍要清除
  // 其跟踪条目，让控制器停止监视一个死 PTY。
  if (liveWorkers.has(id)) liveWorkers.delete(id);
  // 归档死 worker 的 floor 卡片（镜像 killAgent 的 voice-kill 路径；若卡片
  // 已消失，渲染进程的 archiveAgent 是空操作）。常规 agent 不做此事：它们的
  // kill 流程已自行管理各自的卡片。
  if (wasWorker) {
    try { liveWebContents()?.send('hive:agentArchived', { id }); } catch { /* 窗口已拆除 */ }
  }
  syncKeepAwake();
}

/** 向 god agent（人类的代理）发送一条 inform。临时-worker 控制器用它来上报
 *  每一个终态失败，并携带 Slack {channel,thread_ts}，使 god 能发布
 *  “无法完成” 的回复——从而闭环 Slack 回路（成功路径是 worker 自己在线程内回复）。 */
function informGod(subject: string, body: string, slack?: { channel: string; thread_ts: string }): void {
  try {
    const slackLine = slack
      // 内置 node 启动器，写为 ABSOLUTE PATH——既不是裸 `node`
      // （node 来自 nvm 的任何机器 PATH 中都没有它），也不是 `$HIVE_NODE`
      // （仅 POSIX：cmd.exe/PowerShell 会把它展开为空，整个回复命令在
      // Windows 上就是死的）。
      ? `\n\n[SLACK] Close the loop — post a reply to channel ${slack.channel} thread ${slack.thread_ts} via:\n  "${hive.nodeCommand()}" "${slackReplyScriptPath()}" --channel ${slack.channel} --thread ${slack.thread_ts} --text "<your message>"`
      : '';
    hive.send({ to: 'god', act: 'inform', subject, body: body + slackLine }, 'ephemeral-worker');
  } catch (e) {
    console.error('[worker] informGod failed:', e);
  }
}

/** 临时 worker 的门控 worktree teardown：仅当它不持有未集成工作时才移除；
 *  否则保留它（及其分支）并 ping god——唯一的集成者。异步 + 尽力而为；
 *  任何不确定情况下都保留 worktree（fail-safe——绝不自动丢弃可能宝贵的工作）。 */
async function finalizeWorkerWorktree(wtPath: string, origCwd: string, worker: WorkerRec): Promise<void> {
  try {
    const work = await worktreeHasUnintegratedWork(wtPath, worker.baseBranch);
    if (work.keep) {
      console.warn(`[worker] PRESERVING worktree with unintegrated work: ${wtPath} (${work.detail})`);
      // 跟踪它，这样一旦集成完成，GC sweep 就能回收它（+ scratch 目录）——
      // 此时 worker 已从 liveWorkers 中消失，所以其身份就记录在这里。
      preservedWorktrees.set(wtPath, {
        workerId: worker.workerId, wtPath, origCwd, baseBranch: worker.baseBranch,
        scratchDir: workerScratchDir(worker.workerId), slack: worker.slack, preservedAt: Date.now()
      });
      informGod(
        `[worker worktree preserved] ${worker.workerId}`,
        `Ephemeral worker ${worker.workerId} ended but its worktree holds unintegrated work, so it was NOT auto-removed (you are the sole integrator).\n`
        + `Worktree: ${wtPath}\nBranch: ${work.branch}\nState: ${work.detail}\n`
        + `Review/merge it — it will be auto-reclaimed once its work lands in ${worker.baseBranch}, or remove it now with: git -C "${origCwd}" worktree remove "${wtPath}"`,
        worker.slack
      );
      return;
    }
    const r = await removeWorktree(origCwd, wtPath);
    if (!r.ok) { console.error('[worker] removeWorktree failed:', r.error); return; }
    // Worktree 已消失（teardown 时干净/已集成），但把 scratch 目录的清理
    // 推迟到限流的 GC sweep，而不是在这里同步删除：HIVE_ROOT/agents/<id>
    // 存放着 worker 的 memory.md，MemPalace miner 会异步摄取它——立即删除可能
    // 抢在 miner 之前，永久丢失 worker 留在共享 palace 里的持久笔记。注册它
    // （其 worktree 路径现已不存在），让 sweep 的 path-gone 分支在一段时间后
    // 回收 scratch——与保留情形走同一条限流路径。
    preservedWorktrees.set(wtPath, {
      workerId: worker.workerId, wtPath, origCwd, baseBranch: worker.baseBranch,
      scratchDir: workerScratchDir(worker.workerId), slack: worker.slack, preservedAt: Date.now()
    });
  } catch (e) {
    console.error('[worker] finalizeWorkerWorktree threw (worktree left in place):', e);
  }
}

/** worker 的 hive scratch 目录（其 inbox/outbox/memory）：HIVE_ROOT/agents/<id>。
 *  无 hive root 时返回 null。 */
function workerScratchDir(workerId: string): string | null {
  const root = hive.root();
  return root ? join(root, 'agents', workerId) : null;
}

/** 尽力而为地移除 worker 的 scratch（hive agent）目录。守卫确保只会删除
 *  解析后精确等于 HIVE_ROOT/agents/<workerId> 的路径，且绝不删除仍在活跃的
 *  worker——因此一个伪造/错配的 id 也无法逃出 agents 根目录。 */
function removeWorkerScratch(workerId: string): void {
  if (liveWorkers.has(workerId)) return; // 绝不擦除活跃 worker 的邮箱
  const dir = workerScratchDir(workerId);
  const root = hive.root();
  if (!dir || !root) return;
  const agentsRoot = join(root, 'agents');
  // 路径安全：解析后的目录必须直接位于 agents/ 之下，且 basename == id。
  if (resolve(dir) !== join(resolve(agentsRoot), basename(dir)) || basename(dir) !== workerId) return;
  try { rmSync(dir, { recursive: true, force: true }); }
  catch (e) { console.error('[worker] removeWorkerScratch failed:', e); }
}
// 自然 PTY 退出必须执行与显式 kill 相同的 teardown——除非该 PTY 是缺 CLI
// 的安装器：那里一次干净退出意味着引擎 CLI 刚安装完成，所以自动重启并继续——
// 把同一个 spawn 重新运行进同一个 pty/window（无需用户点击）。与提供方无关。
// 结构上幂等：重启携带 `noAutoInstall`，因此安装器绝不可能会再次触发（更别说
// 循环）——一个莫名仍然缺失的二进制只是正常 spawn 然后退出。
ptyManager.setExitHandler((id, exitCode) => {
  const pending = pendingInstallRelaunch.get(id);
  if (pending) {
    pendingInstallRelaunch.delete(id);
    // 激活漏斗：自动安装器真的完成了吗？非零退出是
    // Linux-安装器-无法-无人值守-完成 的信号，过去它曾被静默忽略。
    const provider = pending.opts.provider ?? inferAgentProvider(pending.opts.command, undefined);
    if (exitCode === 0) {
      analytics.track('agent_install_finished', { provider, rung: pending.rung, outcome: 'agent_launched' });
      // 重新武装渲染进程的池化终端（清除 “process exited” 行 + 重新启用输入），
      // 让新 spawn 的 CLI 画到干净、可输入的网格上，然后重新运行正常 spawn——
      // 此时它已能找到刚安装的二进制。
      const wc = (pending.owner && !pending.owner.isDestroyed()) ? pending.owner : liveWebContents();
      try { wc?.send(`pty:relaunch:${id}`); } catch { /* 窗口已消失 */ }
      void spawnAgentCore({ ...pending.opts, noAutoInstall: true }, pending.owner);
      return; // 安装型 PTY 没有需要拆除的 agent/worktree
    }
    // 非零退出 = 安装失败；把诚实的手动修复提示留在屏幕上。
    analytics.track('agent_install_finished', { provider, rung: pending.rung, outcome: 'install_failed' });
  }
  teardownPty(id);
});

/** 当 agent 运行期间，防止系统挂起 harness。Windows Modern Standby 会在
 *  显示器休眠/锁定后不久挂起桌面应用（以及它们的子 `claude` 进程！）——
 *  整个 hive 会在回合中途冻结，直到解锁。`prevent-app-suspension` 正好挡住
 *  这种情况，同时仍允许显示器关闭、会话加锁。仅在至少有一个 PTY 存活时持有，
 *  因此空闲的 harness 不会把笔记本钉在唤醒状态。
 *
 *  可选 `config.strongKeepalive` 升级为 `prevent-display-sleep`，在 macOS 上
 *  还会阻止真正的系统睡眠（合盖/空闲），让离开时定时器与 PTY 也能准时触发——
 *  代价是耗电。默认（'prevent-app-suspension'）仍允许 Mac 真正睡眠；我们能挺
 *  过去并在恢复后补齐（见 onSystemResume）。每次调用都会重新评估，因此在
 *  agent 运行中切换标志会实时切换阻止模式。 */
type KeepAwakeMode = 'prevent-app-suspension' | 'prevent-display-sleep';
let keepAwakeId: number | null = null;
let keepAwakeMode: KeepAwakeMode | null = null;
function syncKeepAwake(): void {
  const live = ptyManager.list().length > 0;
  const desired: KeepAwakeMode | null = live
    ? (readConfig().strongKeepalive ? 'prevent-display-sleep' : 'prevent-app-suspension')
    : null;
  if (desired === keepAwakeMode) return; // 无变化——避免 stop/start 抖动和日志刷屏
  // 拆除当前的阻止器（模式变更，或转入无 agent 的空闲）。
  if (keepAwakeId !== null) {
    try { if (powerSaveBlocker.isStarted(keepAwakeId)) powerSaveBlocker.stop(keepAwakeId); } catch { /* 空操作 */ }
    keepAwakeId = null;
  }
  keepAwakeMode = desired;
  if (desired) {
    keepAwakeId = powerSaveBlocker.start(desired);
    console.log(`[power] keep-awake ON (${desired}) — agents running`);
  } else {
    console.log('[power] keep-awake off — no agents');
  }
}

/** 任务的实时调度器负责：最初的 `setTimeout`（等待距离下一次应触发还剩多久），
 *  以及触发后装备的稳定 `setInterval`。两者都被跟踪，以便关机时能清除
 *  任何一个挂起的定时器。 */
interface MissionTimer {
  timeout?: NodeJS.Timeout;
  interval?: NodeJS.Timeout;
}

/** 按任务 id 为键的活跃调度器定时器。 */
const missionTimers = new Map<string, MissionTimer>();

/** 清除并忘记所有已装备的任务定时器（setTimeout 和 setInterval 句柄）。
 *  可从 syncMissions 和关机 teardown 安全调用，因此 tick 绝不会触发进
 *  半拆除的服务里。 */
function clearMissionTimers(): void {
  for (const t of missionTimers.values()) {
    if (t.timeout) clearTimeout(t.timeout);
    if (t.interval) clearInterval(t.interval);
  }
  missionTimers.clear();
}

/** 从持久化配置重建调度器：清除每个现有定时器，然后装备每个启用的任务，
 *  并尊重其 lastFiredAt——先用 setTimeout 等到下一次应触发还剩的时间，
 *  随后稳定为固定间隔。每个 tick 把任务分发给目标 agent，并把 lastFiredAt
 *  写回 config。在启动时（router 启动后）以及每次 missions:save 后调用。 */
function syncMissions(): void {
  clearMissionTimers();
  const missions = readConfig().missions ?? [];
  for (const m of missions) {
    if (!m.enabled) continue;
    // 每周任务（星期几 + 时间）在下方装备，且不需要 interval，所以 interval
    // 守卫必须放在那个分支之后——过去它被并进上面那行，会把每一个周任务都拒绝掉。
    const weekly = m.kind === 'heartbeat' ? null : normalizeWeekly(m.weekly);
    if (!weekly && !(m.intervalMs > 0)) continue;
    // Heartbeat（Lane A #1）不采用固定 setInterval，而以自适应节奏自我重排。
    // 注册进同一个 missionTimers map，因此 clearMissionTimers() 在退出/重置时
    // 以相同方式拆除它。
    if (m.kind === 'heartbeat') { armHeartbeat(m); continue; }
    const fire = (): void => {
      try {
        // 一个 'compact' 维护任务（maint-1）只做压缩：它不携带分发 body/target，
        // 所以跳过 hive.send，只触发 auto-compact。仅以 `kind!=='compact'` 为门控——
        // 那已经排除了 compact 任务；我们刻意不添加 `&& m.body`，因此其他
        // （分发类）任务保持原有行为，包括历史上空 body 的发送（Pam N1）。
        if (m.kind !== 'compact' && hive.enabled()) {
          hive.send({ to: m.to, act: 'request', subject: m.label, body: m.body }, 'scheduler');
        }
        // Auto-compact：不要把 /compact 硬塞进繁忙的终端。交给渲染进程，它按
        // agent 排队 /compact（去重——绝不两个同时）并且只在 agent 空闲时
        // （其 drain loop）才投递，因此工作中的 agent 在步骤之间压缩，绝不在
        // 步骤中途。
        //
        // CADENCE 现在属于 context trigger，而不是任务——但遗留的每任务
        // `autoCompact` 标志仍然可用，经同一个 emit 路由，因此从 main 到
        // renderer 只有一条路径。它携带 context trigger 的当前规则，让任务驱动的
        // 压缩遵守与触发驱动相同的压力阈值。
        if (m.autoCompact || m.kind === 'compact') {
          emitContextTrigger('compact', contextRule('compact'));
        }
        const current = readConfig().missions ?? [];
        const next = current.map((x) =>
          x.id === m.id ? { ...x, lastFiredAt: Date.now() } : x
        );
        writeConfig({ missions: next });
        // 让 SCHEDULES 面板在不重载的情况下刷新 “last fired”（#2.3）。
        try { liveWebContents()?.send('missions:updated'); } catch { /* 窗口已消失 */ }
      } catch (e) {
        console.error('[scheduler] mission', m.id, e);
      }
    };
    const entry: MissionTimer = {};
    if (weekly) {
      // 每周自我重排：没有稳定的 interval 可落定，因为两个时段之间的间隔
      // 各不相同（周五到周一不是周一到周三，而且改时钟的那一周也不是 168 小时）。
      //
      // `justFired` 是防自旋守卫，不是锦上添花。weeklyDelayMs 对错过且尚未运行
      // 的时段返回 0，并从持久化的 lastFiredAt 得知“已运行”——所以如果 fire()
      // 的 writeConfig 曾失败，下一次计算会再次返回 0，永远如此。在 fire 之后把
      // `now` 作为 last-fired 下限传入，使追赶分支不可达，最坏情况只是丢一次
      // 时间戳，而不是死循环。
      const rearm = (justFired: boolean): void => {
        const now = Date.now();
        const persisted = (readConfig().missions ?? []).find((x) => x.id === m.id)?.lastFiredAt ?? 0;
        const delay = weeklyDelayMs(weekly, now, justFired ? Math.max(persisted, now) : persisted);
        if (delay === null) return;
        entry.timeout = setTimeout(() => { fire(); rearm(true); }, delay);
      };
      rearm(false);
      missionTimers.set(m.id, entry);
      continue;
    }
    // 尊重 lastFiredAt，使部分流逝的 interval 不会在重启或编辑不相关任务时
    // 从零重新开始：只等待到下一次应触发为止的剩余时间，然后落定为稳定 interval。
    const remaining = Math.max(0, m.intervalMs - (Date.now() - (m.lastFiredAt ?? 0)));
    entry.timeout = setTimeout(() => {
      fire();
      entry.interval = setInterval(fire, m.intervalMs);
    }, remaining);
    missionTimers.set(m.id, entry);
  }
}

// ─── Context trigger（auto-compact / auto-clear 各自拥有自己的定时器）────────
// 压缩曾经挂在一个任务上（`compact-maintenance`），这意味着操作者对一个行为
// 有两个相互竞争的控制——一个带 interval 的调度，一个带 cadence 的触发。该任务
// 已退役（见 ensureDefaultMissions 里的退役迁移）；这些定时器是计划性上下文
// 维护剩下的唯一来源。
//
// Main 只拥有 CADENCE。压力闸门（`minContextPct`）需要每个 agent 的实时上下文
// 使用量，而这只有渲染进程才有，所以整条规则随事件一起传送，由渲染进程决定哪些
// agent 真正收到该命令。正因为这种分工，载荷携带的是规则而不是一个裸的
// “go” 信号。

/** 两个半区的定时器，按 action 为键。与 `missionTimers` 相同的两阶段形态
 *  （先 setTimeout 等待剩余时间，再稳定为固定 interval），因此部分流逝的
 *  cadence 能在重新装备后存活。 */
const contextTimers = new Map<'compact' | 'clear', MissionTimer>();

/** `ContextRule` 没有 `lastFiredAt`（不同于 `ScheduledMission`），所以上次运行
 *  时刻存放在持久化 kv store 里。没有它们，每次重新装备——启动、设置编辑、
 *  从睡眠唤醒——都会让 2h cadence 从零重启，一天编辑两次规则的操作者永远
 *  看不到它触发。 */
const CONTEXT_LAST_RUN_KV_KEY = 'triggers.context.lastRun';
let contextLastRun: Record<string, number> | null = null;

function contextRunMap(): Record<string, number> {
  if (!contextLastRun) {
    try { contextLastRun = persist.getKv<Record<string, number>>(CONTEXT_LAST_RUN_KV_KEY) ?? {}; }
    catch { contextLastRun = {}; }
  }
  return contextLastRun;
}

/** 规则上次运行的时间。未记录的一半会被盖上 NOW 而不是读成 epoch：否则
 *  `remaining` 会夹到 0，在应用启动的瞬间就压缩每个终端。这与
 *  `ensureDefaultMissions` 播种任务时盖上 `lastFiredAt` 避开的是同一个陷阱——
 *  首次启动应等待一个完整 cadence，而不是以一次中断开场。 */
function contextLastRunAt(action: 'compact' | 'clear'): number {
  const map = contextRunMap();
  const v = map[action];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return stampContextRun(action);
}

function stampContextRun(action: 'compact' | 'clear'): number {
  const map = contextRunMap();
  const at = Date.now();
  map[action] = at;
  try { persist.setKv(CONTEXT_LAST_RUN_KV_KEY, map); } catch { /* DB 尽力而为 */ }
  return at;
}

/** 一个半区的实时规则，已深度填充。`readConfig` 已经填充了两个半区，所以
 *  这个默认值只是双保险回退。 */
function contextRule(action: 'compact' | 'clear'): ContextRule {
  return readConfig().contextTrigger?.[action] ?? DEFAULT_CONTEXT_TRIGGER[action];
}

/** 清除并忘记两个 context 定时器（setTimeout + setInterval 句柄）。 */
function clearContextTimers(): void {
  for (const t of contextTimers.values()) {
    if (t.timeout) clearTimeout(t.timeout);
    if (t.interval) clearInterval(t.interval);
  }
  contextTimers.clear();
}

/** 请求渲染进程运行 context trigger 的一个半区。
 *
 *  两个调用方都汇聚到这里——遗留的每任务 `autoCompact` 标志和 context trigger
 *  自己的定时器——因此对每个 action，从 main 到 renderer 恰好只有一条路径。 */
function emitContextTrigger(action: 'compact' | 'clear', rule: ContextRule): void {
  try { liveWebContents()?.send('trigger:context', { action, rule }); } catch { /* 窗口已消失 */ }
  // 过渡期别名：渲染进程仍保留着 pre-Triggers 的 `mission:autoCompact`
  // 监听器作为回退。compact 时两者都会触发，直到每个使用方都迁到
  // `trigger:context`；届时这行删除。
  if (action === 'compact') {
    try { liveWebContents()?.send('mission:autoCompact'); } catch { /* 窗口已消失 */ }
  }
}

/** 从持久化配置（重新）装备两个 context 定时器。先清后装，因此设置变更、
 *  启动、或从睡眠唤醒后调用它绝不会叠加重复。与任务装备一样精确地尊重
 *  距上次运行的流逝时间：逾期规则触发一次后即落定为稳定 cadence。 */
function syncContextTriggers(): void {
  clearContextTimers();
  for (const action of ['compact', 'clear'] as const) {
    const rule = contextRule(action);
    if (!rule.enabled || !(rule.everyMs > 0)) continue;
    const fire = (): void => {
      try {
        stampContextRun(action);
        // 重新读取：操作者可能已编辑消息/阈值（自定时器装备以来），
        // 渲染进程应对当前值采取行动。
        emitContextTrigger(action, contextRule(action));
      } catch (e) {
        console.error('[triggers] context', action, e);
      }
    };
    const remaining = Math.max(0, rule.everyMs - (Date.now() - contextLastRunAt(action)));
    const entry: MissionTimer = {};
    entry.timeout = setTimeout(() => {
      fire();
      entry.interval = setInterval(fire, rule.everyMs);
    }, remaining);
    contextTimers.set(action, entry);
  }
}

/** 启动迁移（#57/#58）：归档每个 `archived:false` 但没有活跃 PTY 的 agent
 *  条目。这在 bootstrapHiveServices 中运行，早于渲染进程能重新 spawn 任何东西，
 *  因此此刻没有 agent 拥有 PTY——每个 `archived:false` 条目都是上一会话未归档
 *  就退出/崩溃（例如 pre-acc13a3 的 'assistant' Dwight 条目）留下的陈旧遗留。
 *  若放任不管，它们没有活跃 PTY，breaker beat 会 steering 它们，而 steering 会
 *  作为 requires_reply 弹回 GOD，GOD 无法清除 → 收件箱洪泛。
 *
 *  “无活跃 PTY” = ptyForAgent(id) === undefined（ptyToAgent 只在 spawn 时填充、
 *  teardown 时清理）。God 永不被归档。用户的真实 agent 不受影响：“restore team”
 *  流程经 ensureAgent 重新 spawn 它们，后者会重新清除 `archived`——可恢复性
 *  不依赖 archived 标志。 */
function archiveOrphanedAgents(): void {
  if (!hive.enabled()) return;
  try {
    const reg = hive.registry();
    for (const [id, a] of Object.entries(reg.agents)) {
      if (a.archived) continue;
      if (id === reg.godId) continue;        // god 永不被归档
      if (ptyForAgent(id)) continue;         // 有活跃 PTY → 确实活跃
      hive.setArchived(id, true);            // 陈旧的 archived:false 孤儿 → 归档
      console.log('[migration] archived orphaned agent (no live PTY):', id);
    }
  } catch (e) {
    console.error('[migration] archiveOrphanedAgents failed:', e);
  }
}

/** 一次性迁移：确保内置的小时级 ops standup 存在于早于它的安装中。以
 *  `opsStandupSeeded` 为守卫，因此用户之后删除该任务也不会在每次启动时被
 *  重新加回。盖上 lastFiredAt = now，使首次 standup 等待一个完整间隔，而不是
 *  启动瞬间就触发（并压缩每个终端）。 */
function ensureDefaultMissions(): void {
  const cfg = readConfig();
  if (!cfg.opsStandupSeeded) {
    const missions = cfg.missions ?? [];
    const has = missions.some((m) => m.id === OPS_STANDUP_MISSION.id);
    writeConfig({
      missions: has ? missions : [...missions, { ...OPS_STANDUP_MISSION, lastFiredAt: Date.now() }],
      opsStandupSeeded: true
    });
  }
  // 一次性播种内置 heartbeat（Lane A #1）。随产品以 DISABLED 发布，所以它只是
  // 出现在 SCHEDULES 面板里让用户开启；lastFiredAt = now 让它在用户启用后的
  // 第一次启动时不立即触发。
  const cfg2 = readConfig();
  if (!cfg2.heartbeatSeeded) {
    const missions = cfg2.missions ?? [];
    const has = missions.some((m) => m.id === HEARTBEAT_MISSION.id);
    writeConfig({
      missions: has ? missions : [...missions, { ...HEARTBEAT_MISSION, lastFiredAt: Date.now() }],
      heartbeatSeeded: true
    });
  }

  // maint-1 RETIREMENT：`compact-maintenance` 不再是任务。计划性压缩现在是
  // CONTEXT TRIGGER 的职责，因此操作者只有一个控制（cadence + 压力闸门 +
  // 可编辑消息），而不是两个可能互相矛盾的控制——任务说 “hourly” 而触发器说
  // “2h” 是真实、不可调和的冲突。
  //
  // 迁移保留操作者的决策：压缩是否开启、多久一次。它每台安装最多运行一次，
  // 其守卫是任务自身的 ABSENCE——再也没有东西播种 `compact-maintenance`，所以
  // 一旦移除就没有可迁移的，之后对触发器的手动编辑也绝不会被覆盖。这样在无需
  // 一个只在这里被读的 config 标志的前提下，保住了 `*Seeded` 约定的承诺
  // （永久恰好一次）；`compactMaintenanceSeeded` 保持已设置，使任何东西都不会
  // 重新播种它。
  const cfg3 = readConfig();
  const missions3 = cfg3.missions ?? [];
  const retiring = missions3.find((m) => m.id === COMPACT_MAINTENANCE_MISSION.id);
  if (retiring) {
    const current = cfg3.contextTrigger ?? DEFAULT_CONTEXT_TRIGGER;
    writeConfig({
      missions: missions3.filter((m) => m.id !== COMPACT_MAINTENANCE_MISSION.id),
      contextTrigger: {
        ...current,
        compact: {
          ...current.compact,
          enabled: retiring.enabled,
          // 手工调整过的 interval 是一个决策；只有缺失/荒谬的值才回退到
          // 触发器已携带的值。
          everyMs: retiring.intervalMs > 0 ? retiring.intervalMs : current.compact.everyMs
        }
      },
      compactMaintenanceSeeded: true
    });
    // ……以及它的流逝时间，这样在周期中途退役任务不会让 2h cadence
    // 从零重启（定时器像装备时一样精确地尊重上次运行时间）。
    if (typeof retiring.lastFiredAt === 'number' && retiring.lastFiredAt > 0) {
      const map = contextRunMap();
      map.compact = retiring.lastFiredAt;
      try { persist.setKv(CONTEXT_LAST_RUN_KV_KEY, map); } catch { /* DB 尽力而为 */ }
    }
    console.log('[triggers] retired the compact-maintenance mission into contextTrigger.compact',
      `(enabled: ${retiring.enabled}, everyMs: ${retiring.intervalMs})`);
  }

  // autoCompact RETIREMENT：上面的标志只被移除了一半。退役 `compact-maintenance`
  // 后，`autoCompact: true` 仍留在 ops standup 上，因此默认安装仍会在两个 cadence
  // 上请求压缩——standup 每小时一次、触发器每两小时一次——这恰恰是退役声称要
  // 结束的那种分歧。（config.ts 甚至记录了一个会剥离它的迁移；它并不存在。）
  //
  // 无论它残留在哪里都剥离它。这是纯粹的去重，不是行为变更：contextTrigger.compact
  // 仍会运行，仍遵循用户自己的 cadence 和压力闸门，而且正是它在执行此前每一次
  // 压缩——自 Triggers 落地起，两条路径都已调用 emitContextTrigger。幂等，因此
  // 一旦干净，每次启动只花费一次 no-op 扫描。
  const cfg4 = readConfig();
  const missions4 = cfg4.missions ?? [];
  if (missions4.some((m) => m.autoCompact)) {
    writeConfig({
      missions: missions4.map(({ autoCompact, ...rest }) => {
        void autoCompact;
        return rest;
      })
    });
    console.log('[triggers] dropped the legacy per-mission autoCompact flag —',
      'contextTrigger.compact is now the only schedule that compacts');
  }
}

// ─── Heartbeat（Lane A #1）+ 熔断器 beat（#6.6b）────────────────────

/** floor 是否安静？只从主进程拥有或能 stat 的信号推导——log.jsonl 的 mtime
 *  （主信号：每次路由的 msg/drain/spawn/task 追加都会触碰它）、每个 agent 的
 *  inbox + outbox/.sent 的 mtime，以及每个活跃 PTY 的 lastOutputAt（agent 打印/
 *  思考算作活动）。关键是不用 registry.status——它在 spawn 时被写为 'idle' 且
 *  在主进程中从不转换——读它会永远看到 floor 安静。 */
function isFloorQuiet(thresholdMs: number): boolean {
  const root = hive.root();
  if (!root) return false;
  const times: number[] = [];
  const pushMtime = (p: string): void => { try { times.push(statSync(p).mtimeMs); } catch { /* 缺失 */ } };
  pushMtime(join(root, 'log.jsonl'));
  const agentsDir = join(root, 'agents');
  if (existsSync(agentsDir)) {
    for (const id of readdirSync(agentsDir)) {
      pushMtime(join(agentsDir, id, 'inbox'));
      pushMtime(join(agentsDir, id, 'outbox', '.sent'));
    }
  }
  for (const t of ptyManager.list()) times.push(t.lastOutputAt);
  if (times.length === 0) return false; // 无信号可判 → 不触发
  return Date.now() - Math.max(...times) > thresholdMs;
}

/** 一个 agent 最新的协调文件 mtime（inbox + inbox/.done、outbox +
 *  outbox/.sent、memory.md）——只算文件，刻意排除 PTY 输出，因此 “无进展”
 *  意味着 “未在协调”，即使 agent 正在忙于打印 token。inbox/.done 和 outbox 目录
 *  也算，因为处理邮件（把消息移到 .done、起草 outbox 消息）就是协调——没有它们，
 *  一次收件箱确认回合会被读成无进展（issue #109 的第二个触发器）。 */
function lastCoordinationAt(agentId: string): number {
  const root = hive.root();
  if (!root) return 0;
  const times: number[] = [0];
  const pushMtime = (p: string): void => { try { times.push(statSync(p).mtimeMs); } catch { /* 缺失 */ } };
  const dir = join(root, 'agents', agentId);
  pushMtime(join(dir, 'inbox'));
  pushMtime(join(dir, 'inbox', '.done'));
  pushMtime(join(dir, 'outbox'));
  pushMtime(join(dir, 'outbox', '.sent'));
  pushMtime(join(dir, 'memory.md'));
  return Math.max(...times);
}

/** 拥有给定 agent id 的 PTY id，或 undefined。 */
function ptyForAgent(agentId: string): string | undefined {
  for (const [ptyId, a] of ptyToAgent) if (a === agentId) return ptyId;
  return undefined;
}

/** “卡住” = 某个 worker 的 PTY 正在积极打印（近期有输出），而其协调文件已
 *  过期——在工作但未协调。这会收紧 heartbeat cadence，让我们更快发现卡死的
 *  agent。 */
function looksStuck(windowMs: number): boolean {
  const reg = hive.registry();
  const now = Date.now();
  for (const [id, a] of Object.entries(reg.agents)) {
    if (a.archived || id === reg.godId) continue;
    const ptyId = ptyForAgent(id);
    if (!ptyId) continue;
    const idle = ptyManager.idleFor(ptyId) ?? Infinity;
    if (idle < 15_000 && now - lastCoordinationAt(id) > windowMs) return true;
  }
  return false;
}

/** 给 god 的有界摘要——路径 + 计数，绝不含完整文件（reference-passing，
 *  #6.2）。至多几百个 token。 */
function buildHeartbeatDigest(quietMs: number, actionable = 0): string {
  const reg = hive.registry();
  const active = Object.entries(reg.agents).filter(([id, a]) => !a.archived && id !== reg.godId);
  const names = active.map(([, a]) => a.name).join(', ') || '—';
  const boardHead = hive.board().split('\n').slice(0, 10).join('\n').trim();
  const log = hive.logTail(8).map((e) => { try { return JSON.stringify(e); } catch { return ''; } }).filter(Boolean).join('\n');
  const withInbox = active.filter(([id]) => hive.inbox(id).length > 0).map(([, a]) => a.name);
  // 当真实 agent/人类邮件在等待时，以明确的行动号召开头，而不是 “quiet” 行——
  // 这个 beat 之所以触发是因为有未读的 actionable 收件箱，而不是因为 floor 变
  // 安静了，god 必须现在就读它。
  const header = actionable > 0
    ? `Floor heartbeat — ${actionable} actionable inbox message(s) awaiting you (worker/human mail). Drain your inbox NOW and act on them.`
    : `Floor heartbeat — quiet ~${Math.round(quietMs / 60000)}m.`;
  return [
    header,
    `Active agents (${active.length}): ${names}.`,
    withInbox.length ? `Undrained inbox: ${withInbox.join(', ')}.` : 'No undrained inboxes.',
    '',
    'Board (head):',
    boardHead || '(empty)',
    '',
    'Recent log:',
    log || '(none)',
    '',
    'Re-engage anyone stalled or blocked and keep the board accurate — or rest if the work is genuinely done.'
  ].join('\n');
}

/** 发件方其邮件是调度器自身噪音的（heartbeat beats、经 'scheduler' 的 ops-
 *  standup、breaker steers、通用 'system'）——绝不是唤醒 god 的理由。其余一切
 * （worker agent id、'webhook'、人类回复）都是 god 必须处理的真实邮件。保持
 * 狭窄，让任何未来的真实发件方默认被计入。 */
const SYSTEM_SENDERS = new Set(['heartbeat', 'scheduler', 'breaker', 'system']);

/** god 收件箱中未读的 actionable 消息数——真实 agent/人类邮件，排除调度器自己
 *  的 beats。驱动收件箱感知的 re-engage，使 worker 的回复（或人类的回答）不会在
 *  floor 忙碌时无人阅读：仅靠 floor-quiet 闸门会漏掉这种情况——任何活跃 agent 都
 *  让 floor 保持 “loud”，所以直到其他一切都空闲之前，god 永不被重新拉入。 */
function godActionableInboxCount(): number {
  try {
    const godId = hive.registry().godId;
    if (!godId) return 0;
    return hive.inbox(godId).filter((m) => !SYSTEM_SENDERS.has(m.from)).length;
  } catch { return 0; }
}

/** 重新拉入安静的 floor：往 god 的收件箱投一条持久摘要。我们绝不在这里直接
 *  往 god 的 PTY 打字——如果他正忙，那会卡在回合中途。收件箱消息由渲染进程
 *  的 busy-aware inbox-wake 投递（它只在 god 空闲时才提醒他读收件箱），因此
 *  heartbeat 绕开工作中 god 而不是打断他。 */
function reengageGod(digest: string): void {
  if (!hive.enabled()) return;
  hive.send({ to: 'god', act: 'request', subject: 'Heartbeat', body: digest }, 'heartbeat');
}

/** breaker constrain/stop 的原生 toast，受 notifications 设置门控。 */
function breakerToast(title: string, body: string): void {
  if (!readConfig().notifications) return;
  try { if (Notification.isSupported()) new Notification({ title, body }).show(); }
  catch { /* 不支持的平台 */ }
}

/** 一次熔断器 beat：为每个活跃 agent 拉取一份新 usage 样本，追加到持久成本
 *  账本（唯一的持久成本存储），tick 熔断器，在 control:breakerState（Seam 2）上
 *  发出每个 BreakerState，并强制执行任何升级。God 在 LEDGER（成本可见性）中但
 *  不在 breaker 输入里（heartbeat 管理 god；我们绝不自动 steering/kill 编排者）。 */
function runBreakerBeat(progressWindowMs: number): void {
  if (!hive.enabled()) return;
  const reg = hive.registry();
  const now = Date.now();
  const inputs: BreakerInput[] = [];
  for (const [id, a] of Object.entries(reg.agents)) {
    if (a.archived) continue;
    // #57/#58：跳过 assistant + 孤儿 shell。breaker 只能评估活跃、真实的 agent。
    // 一个 assistant 条目（例如 pre-acc13a3 的无头 'Dwight'）或任何留成
    // archived:false 且没有活跃 PTY 的孤儿条目，否则会被 steering，而那个 steer
    // 会作为 requires_reply 弹回 GOD，GOD 无法清除 → 收件箱洪泛。
    // ptyForAgent(id) === undefined 意味着没有活跃 PTY。God 豁免此孤儿检查
    // （它有自己的流程 + 下面的 godId 跳过）因此其账本行不受影响。活跃真实 agent
    // 总是拥有 PTY（ptyToAgent 在 spawn 时设置），因此它们的 breaker 行为不变。
    if (a.isAssistant) continue;
    if (id !== reg.godId && !ptyForAgent(id)) continue;
    const sample = usageProvider.getAgentUsage(id);
    // #56：只为 LIVE 会话样本追加账本行。死/孤儿 agent 的冻结 transcript 仍会
    // 经 transcript 回退产出样本，但 sessionId 为空（aggregateLive 返回 null →
    // 无 live OTel 会话）。每 ~30s 追加它就会永远重写同一行（观察到 2,417 个
    // 重复）。truthy sessionId 只由 live 会话设置（aggregateLive 挑选最近的 live
    // 会话 id），因此这以 “是否存在 live 会话” 为门控，不改变任何 live-agent 行为。
    if (sample?.sessionId) hive.appendCostLedger(sample); // 账本覆盖所有人，含 god
    // resume key 的第二个来源。recordSession() 否则只能从 hook shim 触达，因此
    // 任何 hook 落空的时间窗都会让 registry 没有 sessionId，“Restart & Continue”
    // 拒绝继续——而这份样本本身就证明应用一直都知道 live 会话 id（它上面一行
    // 已被写入成本账本）。同一 id、同一 liveness 门控；recordSession 只在变化时
    // 写入，所以 hook 正常流动后这是空操作。
    if (sample?.sessionId) hive.recordSession(id, sample.sessionId);
    if (id === reg.godId) continue;            // breaker 跳过 god
    // 进展 = 新鲜的协调文件 OR 近期的 OTel 工具 span。span 这一支补上了后台
    // 工作的盲区：subagent/Workflow 工具调用永远不会到达父会话的 PostToolUse
    // hook（所以 breaker 自己的 distinct-tool 时钟保持陈旧），但它们的 span 确实
    // 以该 agent 的 id 流过收集器——一个空闲的父 agent 监督着辛苦工作的后台
    // 舰队是进展中，而不是卡死。#109 修复后观察到的唯一残留 no-progress 误报。 
    const spans = telemetry.getSpans(id);
    const lastSpanAt = spans.length ? spans[spans.length - 1].ts : 0;
    inputs.push({
      agentId: id,
      sample,
      progressing: now - lastCoordinationAt(id) < progressWindowMs || now - lastSpanAt < progressWindowMs
    });
  }
  for (const d of breaker.tick(inputs, now)) {
    try { liveWebContents()?.send('control:breakerState', d.state); } catch { /* 窗口已消失 */ }
    if (d.action === 'none') continue;
    const name = reg.agents[d.state.agentId]?.name ?? d.state.agentId;
    const reason = d.state.reason;
    if (d.action === 'steer') {
      hive.send({ to: d.state.agentId, act: 'request', subject: 'Circuit breaker: steer',
        body: `自动护栏：${reason}。重新审视你的方法——如果你在循环或卡住，STOP 重复，总结你已尝试的，并向 god 请示方向。` }, 'breaker');
    } else if (d.action === 'constrain') {
      hive.send({ to: d.state.agentId, act: 'request', subject: 'Circuit breaker: constrain',
        body: `自动护栏升级：${reason}。现在停止主动工作：切换到只读/计划模式，写下你下一步的简短计划，并在运行更多工具之前先发给 god 审批。` }, 'breaker');
      breakerToast(l10n(`${name} constrained`, `${name} 已受限`), reason);
    } else if (d.action === 'stop') {
      const ptyId = ptyForAgent(d.state.agentId);
      if (ptyId) { try { ptyManager.kill(ptyId); } catch { /* 已消失 */ } teardownPty(ptyId); }
      breakerToast(l10n(`${name} stopped by circuit breaker`, `${name} 已被熔断器停止`), reason);
    }
  }
}

/** 生命周期花费，从 cost-ledger.jsonl 折叠而来。`telemetry` 的 usd 计数器是
 *  自进程启动以来的累计值，每次应用重启都从 ~0 重新开始，因此它无法回答
 *  “这个 agent 到底花了我们多少钱”。见 costLifetime.ts。 */
const costTotals = new CostLedgerTotals();

/** 构建并写入 Michael 读取的实时 fleet 快照（`<hive>/fleet.json`）。
 *  常开（独立于 heartbeat），因为 `claude agents` 看不到 hive 的兄弟会话。
 *  无 PII；绝不抛异常（从定时器调用）。 */
function writeFleetSnapshot(): void {
  if (!hive.enabled()) return;
  try {
    const reg = hive.registry();
    const snap = telemetry.snapshot();
    const usageById = new Map(snap.usage.map((u) => [u.agentId, u]));
    const now = Date.now();
    // 异步 + 增量；立即返回，绝不向定时器抛异常。
    const hiveRoot = hive.root();
    if (hiveRoot) void costTotals.refresh(join(hiveRoot, 'cost-ledger.jsonl'));
    const agents = Object.entries(reg.agents)
      .filter(([, a]) => !a.archived)
      .map(([id, a]) => {
        const u = usageById.get(id);
        const spans = snap.spans[id] ?? [];
        const tokens = u ? u.input + u.output + u.cacheRead + u.cacheCreation : 0;
        // `usd` 是 LIFETIME（重置校正后的）。在第一次折叠完成之前，
        // 回退到会话数值，而不是发布冰冷的 $0。
        const lifetime = costTotals.usdFor(id);
        const sessionUsd = u ? Number(u.usd.toFixed(4)) : 0;
        return {
          id,
          name: a.name,
          role: a.role ?? (a.isGod ? 'orchestrator' : 'agent'),
          cwd: a.cwd,
          isGod: !!a.isGod,
          breaker: breaker.levelFor(id),
          tokens,
          usd: lifetime === null ? sessionUsd : Number(lifetime.toFixed(4)),
          sessionUsd,
          lastTool: spans.length ? spans[spans.length - 1].tool : null,
          lastActiveSecAgo: u ? Math.round((now - u.ts) / 1000) : null,
          inboxBacklog: hive.inboxBacklog(id),
          onHold: !!a.onHold
        };
      });
    hive.writeFleetSnapshot({ ts: now, agents });
  } catch (e) {
    console.error('[fleet] snapshot failed:', e);
  }
}

/** 以自适应、自重排的 cadence 装备 heartbeat（递归 setTimeout，而非固定
 *  setInterval）。每个 beat 运行成本/熔断器检查、重新拉入安静 floor、盖上
 *  lastFiredAt，然后重新装备：正常 beat 用 ~base，agent 看起来卡住时用 base/4
 *  （最短 30s），re-engage 之后马上用 base*2.5。注册进 missionTimers 以便关机
 *  拆除它。 */
function armHeartbeat(m: ScheduledMission): void {
  const base = m.intervalMs;
  const quiet = m.quietThresholdMs ?? 300_000;
  const beat = (): void => {
    let next = base;
    try {
      // （breaker beat + 成本账本现在运行在它们自己的常开定时器上）
      // 当 floor 安静或真实 agent/人类邮件在 god 收件箱等待时重新拉入 god——
      // 后者独立于 floor-quiet，因此 worker 的回复不会在其他 agent 让 floor 忙碌
      // 时无人阅读。
      const actionable = godActionableInboxCount();
      if (isFloorQuiet(quiet) || actionable > 0) {
        reengageGod(buildHeartbeatDigest(quiet, actionable));
        next = Math.round(base * 2.5);            // re-engage 后退避
      } else if (looksStuck(quiet)) {
        next = Math.max(30_000, Math.round(base / 4)); // agent 卡死时收紧
      }
      const cur = readConfig().missions ?? [];
      writeConfig({ missions: cur.map((x) => (x.id === m.id ? { ...x, lastFiredAt: Date.now() } : x)) });
      try { liveWebContents()?.send('missions:updated'); } catch { /* 窗口已消失 */ }
    } catch (e) {
      console.error('[heartbeat]', e);
    }
    const entry = missionTimers.get(m.id) ?? {};
    entry.timeout = setTimeout(beat, next);
    missionTimers.set(m.id, entry);
  };
  const remaining = Math.max(0, base - (Date.now() - (m.lastFiredAt ?? 0)));
  missionTimers.set(m.id, { timeout: setTimeout(beat, remaining) });
}

/** 活跃的渲染进程 webContents，窗口已消失/销毁则为 null。任何从
 *  定时器/socket/子进程回调向渲染进程发消息的东西都必须经此路由——退出期间
 *  窗口可能在那些回调仍在飞行时被销毁，对已销毁 webContents 调用 `.send()`
 *  会抛 “Object has been destroyed”（主进程崩溃对话框）。 */
function liveWebContents(): Electron.WebContents | null {
  const wc = mainWindow?.webContents;
  if (wc && !wc.isDestroyed()) return wc;
  // 主窗口已消失（关闭/销毁）：回退到任何其他活跃窗口，让全局事件仍能到达
  // 某个渲染进程，而不是被静默丢弃。
  for (const w of allWindows) {
    if (!w.isDestroyed() && !w.webContents.isDestroyed()) return w.webContents;
  }
  return null;
}

// ─── Slack webhook 服务器（Slack 消息 → Michael 的队列）──────────────────
/** 运行中的 Slack 摄取服务器，禁用/停止时为 null。 */
let slackServer: SlackWebhookServer | null = null;
/** 仅 loopback 的回复端点（让内置 helper 无需看到 bot token 即可回复 Slack）。
 *  生命周期与 `slackServer` 绑定。 */
let slackReplyServer: SlackReplyServer | null = null;
/** 最近发放的公共隧道 URL——持久化，使 Settings 在重开之后仍能重新显示
 *  Request URL（Slack 会一直复用它，直到服务器停止）。 */
let lastSlackUrl: string | undefined;

/** AUTONOMOUS REQUEST PROTOCOL —— 逐消息构建（而非静态 const），因此可以
 *  内嵌请求具体的 `channel`、`thread_ts` 和已解析的 helper 路径。被（服务端、
 *  权威地）前置到 god 读取的任何 Slack 来源请求的工作指令前：键盘前没有交互
 *  的人类，所以 god 必须快速路由、以精确的回复命令委派（这样 worker 把它的
 *  真实结果自己发回本线程）、保持自主，并且只在枚举的高严重性操作上阻塞。
 *  只前置到 god 的 PROMPT——面向人类的看板卡片 TITLE 仍是用户的原始文本
 *  （渲染进程保持二者分离）。结尾空格是有意的，让用户消息紧随其后自然可读。 */
function buildAutonomousRequestProtocol(channel: string, threadTs: string, helperPath: string): string {
  return `[AUTONOMOUS REQUEST PROTOCOL — this request arrived via Slack; no interactive human is watching] Handle it under this protocol:
1. ROUTE FAST — triage and hand this to the single most-relevant agent right away. CHECK THE LIVE ROSTER FIRST (active agents in registry.json + their state in fleet.json) and prefer an EXISTING agent that fits — especially when the request names one ("ask Pam…", "have Jim…"): route to that agent and only spawn a new one if none is a sensible fit. Decompose only if it genuinely needs several. Don't sit on it.
2. DELEGATE WITH THE REPLY HANDLE — tell that agent to do the work autonomously AND to post its result back to THIS Slack thread itself when done, using exactly: "${hive.nodeCommand()}" "${helperPath}" --channel ${channel} --thread ${threadTs} --text "<substantive result>" (that first path is the harness's bundled Node, already resolved for this machine — pass it verbatim; bare "node" is not on the hook/agent PATH on many machines.)
3. AUTONOMOUS EXECUTION — no interactive questions. PAUSE/ask ONLY for high-severity actions: pushing to main or any remote; buying or spawning infrastructure or paid services; deleting an existing repo, file, or folder it did not create. Stay READ-ONLY at critical infrastructure and git-push-type changes unless explicitly approved.
4. DIRECT, SUBSTANTIVE REPLY — the agent posts a real Slack-mrkdwn answer (short *bold* headline + the actual outcome/specifics/links), NEVER a bare "done"/":white_check_mark:".
5. REPORT TO GOD — the agent then tells you (Michael) what it did.
6. ASYNC QUESTIONS — if a decision is genuinely needed, don't block: post the question + numbered OPTIONS to the thread via that reply command, and record {q, options, askedAt (ISO + day & time), thread_ts ${threadTs}} so the threaded human reply correlates back and resumes.
The user's message starts now: `;
}

// ─── Slack done-notifier（Slack 来源任务 → done → 一条摘要回复）────────
/** 轮询共享看板（hive/tasks.json）中达到 'done' 的 Slack 来源任务，并往起源
 *  线程发布一条摘要回复。生命周期与 `slackServer` 绑定。仅 OUTBOUND：绝不触碰
 *  入站队列/lanes。 */
let slackDoneTimer: ReturnType<typeof setInterval> | null = null;
/** 重入守卫，使慢发布不会与下一个 tick 重叠。 */
let slackDonePolling = false;
/** 已通知的任务 id——跨重读和重启都精确一次。惰性从 `slackDoneNotifiedPath()`
 *  加载 / 持久化到它。 */
let slackDoneNotified: Set<string> | null = null;
/** observer 启动时已为 'done' 的 id——作为基线（永不通知），因此摘要只会在
 *  实时的 …→done 转换时触发，而不是在既有的 done 上触发。 */
let slackDoneBaseline: Set<string> | null = null;
/** agent 已经经 loopback `/reply` 端点直接回答过的 thread_ts 值。done-summary
 *  轮询器跳过这些——agent 自己的实质性回复已经在线程内落地，所以轮询器只是
 *  回退，不是复制器（这正是阻止裸/重复 `:white_check_mark:` 发布的东西）。 */
const directlyRepliedThreads = new Set<string>();

/** 内置 `md-slack-reply.cjs` helper 的绝对路径。打包版：位于
 *  `process.resourcesPath`（electron-builder extraResources）。开发版：仓库的
 *  `resources/` 目录，从 app 路径解析。 */
function slackReplyScriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'md-slack-reply.cjs')
    : join(app.getAppPath(), 'resources', 'md-slack-reply.cjs');
}

/** W3 —— 打包的只读 `skills/` 源目录，在 spawn 时复制进每个 agent 的
 *  `.claude/skills/`。与上方 helpers 相同的打包/开发解析。在 lp-manifest
 *  （Kevin）填充它之前容忍缺失（hive 副本对缺失目录是空操作）。 */
function skillsResourceDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'skills')
    : join(app.getAppPath(), 'resources', 'skills');
}

/** helper 发现 loopback 端点 `{ port, token }` 的地方。放在 userData 下
 *  （不在 git 仓库，不被挖进 MemPalace）。 */
function slackReplyConfigPath(): string {
  return join(app.getPath('userData'), 'slack-reply.json');
}

/** 已发布 done-summary 的任务 id 账本。仅 id——这里绝不落任何密钥。
 *  在 userData 下（仓库之外，MemPalace 之外）。 */
function slackDoneNotifiedPath(): string {
  return join(app.getPath('userData'), 'slack-done-notified.json');
}

/** 下载的 Slack 附件保存目录（仓库之外，MemPalace 之外）。 */
function slackFilesDir(): string {
  return join(app.getPath('userData'), 'slack-files');
}

/** 单文件下载大小上限——写入前拒绝大于 10 MB 的文件。 */
const SLACK_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** 清理 Slack 文件名：只保留 basename，替换不安全字符，加随机十六进制标签
 *  前缀以防冲突和路径穿越攻击。 */
function sanitizeSlackFilename(name: string | undefined, tag: string): string {
  const safe = (typeof name === 'string' && name)
    ? basename(name).replace(/[^\w.\-]/g, '_').replace(/^\.+/, '_').slice(0, 200) || 'file'
    : 'file';
  return `${tag}-${safe}`;
}

/**
 * 用 bot token 把单个 Slack 私有文件下载进 slackFilesDir()。成功返回本地路径，
 * 任何失败（大小限制、网络等）返回 null。bot token 只用于 Authorization 头，
 * 绝不记录日志。
 */
function downloadSlackFile(
  file: SlackEventFile,
  botToken: string,
  destDir: string
): Promise<{ path: string; name: string; mimetype: string } | null> {
  return new Promise((resolve) => {
    const tag = randomBytes(4).toString('hex');
    const filename = sanitizeSlackFilename(file.name, tag);
    const destPath = join(destDir, filename);
    const name = file.name ?? filename;
    const mimetype = file.mimetype ?? 'application/octet-stream';

    try {
      mkdirSync(destDir, { recursive: true });
    } catch {
      resolve(null);
      return;
    }

    let urlObj: URL;
    try {
      urlObj = new URL(file.url_private);
    } catch {
      resolve(null);
      return;
    }
    if (urlObj.protocol !== 'https:') { resolve(null); return; }

    const req = httpsRequest(
      { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: 'GET',
        headers: { authorization: `Bearer ${botToken}` } },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          res.resume(); // 排空响应体
          resolve(null);
          return;
        }
        let written = 0;
        let aborted = false;
        const stream = createWriteStream(destPath);
        res.on('data', (chunk: Buffer) => {
          if (aborted) return;
          written += chunk.length;
          if (written > SLACK_FILE_MAX_BYTES) {
            aborted = true;
            stream.destroy();
            try { unlinkSync(destPath); } catch { /* 尽力清理 */ }
            res.destroy();
            resolve(null);
            return;
          }
          stream.write(chunk);
        });
        res.on('end', () => {
          if (aborted) return;
          stream.end(() => resolve({ path: destPath, name, mimetype }));
        });
        res.on('error', () => { stream.destroy(); resolve(null); });
        stream.on('error', () => { res.destroy(); resolve(null); });
      }
    );
    req.on('error', () => resolve(null));
    req.end();
  });
}

/**
 * 下载所有原始 Slack 文件（达到上限）并返回本地路径文件列表。失败被静默丢弃——
 * 部分列表对 agent 仍有价值。
 */
async function downloadSlackFiles(
  rawFiles: SlackEventFile[],
  botToken: string | undefined
): Promise<{ path: string; name: string; mimetype: string }[]> {
  if (!rawFiles.length || !botToken) return [];
  const destDir = slackFilesDir();
  const results = await Promise.all(
    rawFiles.map((f) => downloadSlackFile(f, botToken, destDir))
  );
  return results.filter((r): r is { path: string; name: string; mimetype: string } => r !== null);
}

function loadSlackDoneNotified(): Set<string> {
  try {
    const arr = JSON.parse(readFileSync(slackDoneNotifiedPath(), 'utf8'));
    if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch { /* 缺失/损坏 → 从空开始 */ }
  return new Set();
}

function persistSlackDoneNotified(set: Set<string>): void {
  try { writeFileSync(slackDoneNotifiedPath(), JSON.stringify([...set])); }
  catch (e) { console.error('[slack] could not persist done-notify ledger:', e); }
}

/** 对此配置而言永久性的 Slack `chat.postMessage` 错误——重试永远不可能让它们
 *  成功，所以带这些错误的失败发布会被记录（不再重试），避免每 5s 刷爆日志。
 *  其他一切按瞬态处理，留给重试。 */
const TERMINAL_SLACK_ERRORS = new Set<string>([
  'missing_scope', 'invalid_auth', 'not_authed', 'account_inactive',
  'token_revoked', 'token_expired', 'no_permission', 'channel_not_found',
  'not_in_channel', 'is_archived', 'restricted_action', 'org_login_required',
]);

/** 已完成任务的单条线程内摘要。取自任务的 result/description（回退到标题），
 *  裁剪为 Slack 友好长度。 */
function slackDoneSummary(task: HiveTask): string {
  const body = (task.result ?? task.description ?? '').trim();
  const head = `:white_check_mark: *${task.title}*`;
  const text = body ? `${head}\n\n${body}` : head;
  return text.length > 2800 ? `${text.slice(0, 2799)}…` : text;
}

/** 对看板的一次观察 pass。为任何新达 'done' 的 Slack 来源任务发布摘要。
 *  尽力而为且自我保护——绝不能向定时器抛异常，bot token 绝不离开本函数。 */
async function pollSlackDoneTasks(): Promise<void> {
  if (slackDonePolling) return;
  const botToken = readConfig().slackBotToken;
  if (!botToken) return; // 没有 token 无法发布——无事可做
  let tasks: HiveTask[];
  try {
    const ledger = hive.tasks() as { tasks?: HiveTask[] };
    tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
  } catch { return; } // 不可读/缺失的 tasks.json → 跳过本 tick

  const notified = slackDoneNotified ?? (slackDoneNotified = loadSlackDoneNotified());

  // 第一个 tick 播种基线（已 done 的 id）且不发布任何东西——因此我们只会在
  // 本会话实时观察到的转换上触发。
  if (slackDoneBaseline === null) {
    slackDoneBaseline = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
    return;
  }
  const baseline = slackDoneBaseline;

  slackDonePolling = true;
  try {
    for (const t of tasks) {
      if (t.status !== 'done') continue;
      if (baseline.has(t.id) || notified.has(t.id)) continue; // 已处理过
      const slack = t.slack;
      if (!slack || !slack.channel || !slack.thread_ts) continue; // 非 Slack 来源 → 不处理
      // 仅回退：如果 agent 已在本线程发布 DIRECT 回复（loopback /reply），
      // 人类已拿到其实质性回答——不要重复发布。
      if (directlyRepliedThreads.has(slack.thread_ts)) { notified.add(t.id); persistSlackDoneNotified(notified); continue; }
      // 绝不发布没有实质内容的裸 `:white_check_mark: *title*`：如果卡片既没有
      // 结果也没有描述，就没有任何有意义的东西可交付——跳过它（仍在 FALLBACK
      // 契约下）。
      if (!(t.result ?? t.description ?? '').trim()) { notified.add(t.id); persistSlackDoneNotified(notified); continue; }
      const res = await postSlackReply({
        botToken, channel: slack.channel, thread_ts: slack.thread_ts, text: slackDoneSummary(t)
      });
      if (res.ok) {
        notified.add(t.id);
        persistSlackDoneNotified(notified); // 成功即标记 → 恰好一条已交付回复
      } else if (res.error && TERMINAL_SLACK_ERRORS.has(res.error)) {
        // 永久性配置/认证错误（例如 bot token 缺少 `chat:write`）永远不会成功——
        // 记录该 id 让我们停止每个 tick 的猛攻，并记录一次原因。绝不记录 token
        // 或消息体。
        notified.add(t.id);
        persistSlackDoneNotified(notified);
        console.error('[slack] done-summary post for task', t.id,
          '— giving up (terminal error:', res.error + '). Fix the Slack bot scope/permissions; later tasks post once resolved.');
      } else {
        // 瞬态（网络 / 限流 / 未知）→ 保持未标记，让后续 tick 重试。只记录
        // id + 错误；绝不记录 token 或消息体。
        console.error('[slack] done-summary post failed for task', t.id, '-', res.error, '(will retry)');
      }
    }
  } finally {
    slackDonePolling = false;
  }
}

/** 开始观看看板上的 Slack 来源 done 转换（幂等）。 */
function startSlackDoneObserver(): void {
  if (slackDoneTimer) return;
  slackDoneNotified = loadSlackDoneNotified();
  slackDoneBaseline = null; // 在本会话第一个 tick 上重新播种
  slackDoneTimer = setInterval(() => { void pollSlackDoneTasks(); }, 5000);
}

/** 停止观看看板。未运行时调用也安全。 */
function stopSlackDoneObserver(): void {
  if (slackDoneTimer) { clearInterval(slackDoneTimer); slackDoneTimer = null; }
  slackDoneBaseline = null;
}

/** 从当前 config 构建一个 SlackWebhookServer 并启动它，替换任何运行中的实例，
 *  并返回启动结果（含用户粘贴到 Slack 里的公共隧道 URL）。集成被禁用或签名
 *  密钥未设置时返回 no-op + 错误结果。 */
async function startSlackServer(): Promise<{ ok: boolean; url?: string; error?: string }> {
  const cfg = readConfig();
  if (!cfg.slackEnabled || !cfg.slackSigningSecret) {
    return { ok: false, error: 'slack disabled or missing signing secret' };
  }
  slackServer?.stop();
  slackServer = new SlackWebhookServer({
    port: cfg.slackPort && cfg.slackPort > 0 ? cfg.slackPort : 3847,
    signingSecret: cfg.slackSigningSecret,
    channelId: cfg.slackChannelId,
    // 从 HTTP 服务器的事件循环触发（而非 IPC 线程）；经 liveWebContents()
    // 路由，使窗口 teardown 期间到达的消息不会抛异常。下载任何文件附件
    // （bot token 留在 main；本地路径走 IPC）。
    onMessage: async (m) => {
      const localFiles = await downloadSlackFiles(
        m._rawFiles ?? [],
        readConfig().slackBotToken
      );
      // `text` 保持用户的 RAW Slack 文本 → 驱动可读的看板卡片标题。
      // `autonomyPreamble` 是权威策略块，渲染进程只把它前置到 god 的工作指令
      // （他的 PTY prompt）前，让卡片标题保持面向人类可读。逐消息构建，使
      // AUTONOMOUS REQUEST PROTOCOL 携带本请求具体的 channel、thread_ts 和已
      // 解析的 helper 路径——god 交给 worker 一条精确的回复命令。
      // 服务端构建，因此适用于每个会话。
      const ipcMsg: { text: string; channel: string; ts: string; thread_ts: string; autonomyPreamble: string; files?: typeof localFiles } = {
        text: m.text, channel: m.channel, ts: m.ts, thread_ts: m.thread_ts,
        autonomyPreamble: buildAutonomousRequestProtocol(m.channel, m.thread_ts, slackReplyScriptPath())
      };
      if (localFiles.length > 0) ipcMsg.files = localFiles;
      try { liveWebContents()?.send('slack:incomingMessage', ipcMsg); }
      catch { /* 窗口已拆除 */ }
    }
  });
  const res = await slackServer.start();
  // ok:false 意味着我们从没绑定端口 → 丢弃实例。ok:true 但没有 url 只是意味着
  // 隧道不可用；本地 handler 仍然活跃。
  if (!res.ok) { slackServer = null; return res; }
  if (res.url) lastSlackUrl = res.url;
  // 拉起 loopback 回复端点（token 门控、绝不隧道化），并放下内置 helper 的
  // 发现文件。尽力而为：回复路径不可用不能拖垮摄取。
  await startSlackReplyServer();
  // 开始观看看板中达到 'done' 的 Slack 来源任务，以在线程内发布其一条摘要
  // 回复。仅 OUTBOUND；绝不触碰摄取。
  startSlackDoneObserver();
  analytics.trackFeature('slack_trigger');
  return res;
}

/** 启动 loopback 回复端点，并把它的 `{ port, token }` 写入 userData，让
 *  `md-slack-reply.cjs` 能触达它。bot token 在回复时从 config 惰性读取，
 *  从不写入此文件。 */
async function startSlackReplyServer(): Promise<void> {
  slackReplyServer?.stop();
  const token = randomBytes(24).toString('hex');
  slackReplyServer = new SlackReplyServer({
    token,
    getBotToken: () => readConfig().slackBotToken,
    // agent 已在本线程发布 DIRECT 实质性回复 → 记录它，使 done-summary 轮询器
    // 跳过（轮询器是回退，不是复制器）。
    onReplied: (thread_ts) => { directlyRepliedThreads.add(thread_ts); }
  });
  const r = await slackReplyServer.start();
  if (!r.ok || r.port === undefined) {
    console.error('[slack] reply endpoint failed to start:', r.error);
    slackReplyServer = null;
    return;
  }
  try {
    writeFileSync(slackReplyConfigPath(), JSON.stringify({ port: r.port, token }), { mode: 0o600 });
  } catch (e) {
    console.error('[slack] could not write reply config:', e);
  }
}

/** 停止并遗忘 Slack 服务器（+ 回复端点）。尽力而为；未运行时调用也安全。
 *  保留最后一条隧道 URL，让 Settings 持续显示它。 */
function stopSlackServer(): void {
  try { slackServer?.stop(); } catch (e) { console.error('[slack] stop failed:', e); }
  slackServer = null;
  try { slackReplyServer?.stop(); } catch (e) { console.error('[slack] reply stop failed:', e); }
  slackReplyServer = null;
  stopSlackDoneObserver();
  try { if (existsSync(slackReplyConfigPath())) unlinkSync(slackReplyConfigPath()); } catch { /* 空操作 */ }
}

// ─── 通用入站 webhook + 状态 API（多端点）──────────────────────
/** 运行中的通用 webhook 服务器，禁用/停止时为 null。PUBLIC（隧道转发）表面——
 *  与 loopback /reply 不同，它受密钥门控。一个服务器 + 一条隧道服务所有已配置
 *  端点；请求路径里的 id 决定选哪个。因此添加 webhook 不消耗端口和隧道，也绝不
 *  打扰已指向另一端点 URL 的调用方。 */
let webhookServer: WebhookServer | null = null;
/** 最近发放的公共隧道 URL——保留，让 Settings 在重开之后仍能重新显示端点
 *  （隧道每次重启都会轮换它）。 */
let lastWebhookUrl: string | undefined;

/** 共享服务器绑定的本地端口。端口是服务器的属性，不属于任何单个触发器——
 *  `webhookPort` 保持为（遗留）覆盖。 */
const WEBHOOK_DEFAULT_PORT = 3849;

/** 操作者已开启的端点。禁用的 webhook 不只是被拒之门外——它根本不会被交给
 *  服务器，因此它的 id 不存在于线路上，其密钥也不在请求路径的内存里。 */
function enabledWebhookEndpoints(): WebhookTrigger[] {
  return (readConfig().webhookTriggers ?? []).filter((t) => t.enabled && !!t.secret);
}

/** 能力 token 的 SHA-256 十六进制。原始 token 恰好一次返回给调用方
 *  （POST 响应），且从不持久化；只有这个摘要落到看板卡片上，因此 GET 可以在
 *  原始 token 从不驻留的情况下完成匹配。 */
function hashWebhookToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** tokenHash → 它所属 `pending` 历史条目的 id。
 *
 *  被模式闸门挂起的消息没有看板卡片（卡片是审批创建的），所以这张 map 是它的
 *  调用方 GET 能被回答的唯一途径——而且被诚实地回答为 “awaiting-approval”，
 *  而不是谎称工作已排队。它存储 token 的 DIGEST，绝不存 token，与卡片戳记完全
 *  一致，并镜像进持久 kv store，使重启不会让仍在礼貌等待操作者的每个调用方
 *  收到 404。 */
let heldWebhookTokens: Map<string, string> | null = null;
const HELD_TOKENS_KV_KEY = 'triggers.webhook.heldTokens';

function heldTokens(): Map<string, string> {
  if (heldWebhookTokens) return heldWebhookTokens;
  let stored: Record<string, string> | undefined;
  try { stored = persist.getKv<Record<string, string>>(HELD_TOKENS_KV_KEY); }
  catch { stored = undefined; }
  const entries = stored && typeof stored === 'object' ? Object.entries(stored) : [];
  heldWebhookTokens = new Map(entries.filter((e): e is [string, string] => typeof e[1] === 'string'));
  return heldWebhookTokens;
}

function persistHeldTokens(): void {
  try { persist.setKv(HELD_TOKENS_KV_KEY, Object.fromEntries(heldTokens())); }
  catch (e) { console.error('[webhook] could not persist held-token map:', e); }
}

/** 丢弃其历史条目已从（有上限的）账本中过期的映射——操作者不再能裁决它们，
 *  所以它们的 token 是死重。 */
function pruneHeldTokens(): void {
  const map = heldTokens();
  if (map.size === 0) return;
  const live = new Set(listTriggerHistory().map((e) => e.id));
  let changed = false;
  for (const [hash, entryId] of [...map]) {
    if (!live.has(entryId)) { map.delete(hash); changed = true; }
  }
  if (changed) persistHeldTokens();
}

/** 被挂起历史条目在被接受时使用的 token 摘要，如果我们仍持有它。 */
function heldTokenHashFor(entryId: string): string | undefined {
  for (const [hash, id] of heldTokens()) if (id === entryId) return hash;
  return undefined;
}

/** 告诉 Triggers 标签页其账本已变动，让历史实时刷新，而不是等操作者重新打开
 *  该标签页。 */
function notifyTriggerHistoryUpdated(): void {
  try { liveWebContents()?.send('triggerHistory:updated'); } catch { /* 窗口已消失 */ }
}

/**
 * 为入站消息创建已盖戳的看板卡片并路由给 god。
 *
 * 从 `handleWebhookMessage` 中拆出，是因为 APPROVAL 路径稍后会走完全相同的
 * 路线——操作者说 yes 时必须产生与自动放行消息相同的卡片、相同的 god 请求，
 * 否则两条路径会漂移，“approved” 悄然变成比 “allowed” 更弱的东西。
 *
 * 只有当卡片——调用方轮询的东西——写不出来时才返回 false。god 路由是尽力而为：
 * 即使发送出岔子，卡片也已经存在且可轮询。
 */
function dispatchWebhookWork(arg: {
  taskId: string;
  title: string;
  message: string;
  /** 盖到卡片上，使 GET 能与调用方的 token 匹配。 */
  tokenHash?: string;
  /** 'webhook' | 'org' —— 仅用于主题行和给 god 的说明。 */
  origin: 'webhook' | 'org';
}): boolean {
  try {
    const card: HiveTask = {
      id: arg.taskId,
      title: arg.title,
      description: arg.message,
      status: 'todo',
      dependsOn: [],
      priority: 1,
      createdAt: new Date().toISOString(),
      ...(arg.tokenHash ? { webhook: { tokenHash: arg.tokenHash } } : {})
    };
    // addTask 会基于磁盘上最新的账本追加，并按任务 id 幂等，所以并发写卡方
    // （Slack、god、语音、另一个 webhook）不会因为我们的陈旧整账本覆写而丢卡
    // （writeTasks 传入陈旧 existing 恰好会重现那个竞态）。全新的 taskId
    // 永不会冲突，所以这里总是新增。
    hive.addTask(card);
  } catch (e) {
    console.error('[webhook] could not create task card:', e instanceof Error ? e.message : e);
    return false;
  }
  // 消息体只携带发送者的消息 + 卡片 id（这样无论谁完成它，都能为该调用方的
  // GET 更新该卡的状态/结果）——绝不含密钥，绝不含原始 token。
  try {
    hive.send({
      to: 'god',
      act: 'request',
      subject: `[${arg.origin}] ${arg.title}`,
      body: `${arg.message}\n\n(Inbound via the generic ${arg.origin} API, tracked as kanban card ${arg.taskId}. When this work is finished, set that card's status to 'done' and fill its 'result' so the caller's status check reflects the outcome.)`,
      requires_reply: false
    }, 'webhook');
  } catch (e) {
    console.error('[webhook] could not route to god:', e instanceof Error ? e.message : e);
  }
  return true;
}

/**
 * 一个已校验的 POST，经端点的 TriggerMode 处理。
 *
 * `isAutoAllowed(mode, kind)` 就是整个闸门。当它返回 yes 时，行为与单端点
 * 服务器一贯的方式完全一致——建卡、请求 god、发能力 token。当它返回 no 时，
 * 什么都到不了 hive：消息作为 `pending` 写入账本，等待操作者裁决；调用方拿到
 * 它的 token 和一个 202，这样它能观察“挂起”状态，而不是以为工作已开始。
 *
 * 无论哪种情况都会记录一条 `inbound` 历史行。密钥绝不会到这里（服务器只交接
 * `{id,name}`），任何凭据也绝不会写入账本。
 */
function handleWebhookMessage(msg: WebhookInbound, endpoint: WebhookEndpointRef): WebhookDispatch | null {
  // 192 位不可猜测的 token，只返回一次；只存储它的哈希。
  const token = randomBytes(24).toString('hex');
  const tokenHash = hashWebhookToken(token);
  const full = msg.title ?? msg.message;
  const title = full.length > 80 ? `${full.slice(0, 79)}…` : full;

  const trigger = (readConfig().webhookTriggers ?? []).find((t) => t.id === endpoint.id);
  // 端点在请求与此查找之间消失时，回退到最严格的模式，绝不回退到最宽松的。
  const mode: TriggerMode = trigger?.mode ?? DEFAULT_TRIGGER_MODE;
  // 调用方自己的声明优先；`classifyInboundKind` 是给未声明的调用方的保守猜测
  // （它刻意偏向 'directive'）。
  const kind: InboundKind = msg.kind ?? classifyInboundKind(msg.message);
  const peer = msg.from?.trim() || endpoint.name || endpoint.id;
  // 在这里铸造、而不是从任务 id 派生，因为被挂起的消息还没有任务 id，
  // 但仍必须能与它最终获得的回复配对。
  const correlationId = randomBytes(8).toString('hex');

  const base = {
    source: 'webhook' as const,
    sourceId: endpoint.id,
    sourceName: endpoint.name,
    direction: 'inbound' as const,
    peer,
    title,
    body: msg.message,
    kind,
    correlationId
  };

  if (!isAutoAllowed(mode, kind)) {
    const entry = appendTriggerHistory({ ...base, decision: 'pending' });
    heldTokens().set(tokenHash, entry.id);
    persistHeldTokens();
    notifyTriggerHistoryUpdated();
    return { token, pending: true };
  }

  const taskId = `webhook-${randomBytes(8).toString('hex')}`;
  if (!dispatchWebhookWork({ taskId, title, message: msg.message, tokenHash, origin: 'webhook' })) return null;
  appendTriggerHistory({ ...base, decision: 'auto-allowed', taskId });
  notifyTriggerHistoryUpdated();
  return { token, taskId, pending: false };
}

/** 将能力 token 解析为其任务（或挂起的消息）的公开状态——只限定在存储哈希
 *  匹配的那一张卡（或那一条挂起的消息）范围内；绝不列出或泄露任何其他任务。
 *  任何不匹配都返回 null（服务器两种情况下都回 404，所以探测者无法区分
 *  “未知”与“格式错误”）。 */
function lookupWebhookStatus(token: string): WebhookTaskStatus | null {
  const hash = hashWebhookToken(token);

  // 先查挂起的消息——它们没有卡，而 O(1) 命中让常见的“仍在等待”轮询
  // 完全不必扫描任务。
  const heldEntryId = heldTokens().get(hash);
  if (heldEntryId) {
    const entry = listTriggerHistory().find((e) => e.id === heldEntryId);
    if (!entry) { heldTokens().delete(hash); persistHeldTokens(); return null; }
    if (entry.decision === 'pending') {
      return { status: 'awaiting-approval', title: entry.title ?? '' };
    }
    if (entry.decision === 'rejected') {
      return { status: 'rejected', title: entry.title ?? '' };
    }
    // 已批准：放行时把该哈希盖到了真实卡片上，所以继续往下走。
  }

  const wanted = Buffer.from(hash);
  let tasks: HiveTask[];
  try {
    const ledger = hive.tasks() as { tasks?: HiveTask[] };
    tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
  } catch { return null; }
  for (const t of tasks) {
    const h = t.webhook?.tokenHash;
    if (!h) continue;
    const have = Buffer.from(h);
    // 两者都是定长的 sha-256 十六进制串；防御性地用常数时间比较。
    if (have.length === wanted.length && timingSafeEqual(have, wanted)) {
      return { status: t.status, title: t.title, result: t.result };
    }
  }
  return null;
}

// ─── Webhook 完成观察器（触发账本的外向半边）────────────────────────────
// 镜像 `pollSlackDoneTasks`：监视看板，把达到 'done' 的 webhook 来源卡片
// 写入对话的回复一侧，并带上入站行的 correlationId，让 UI 能把请求与响应配对。
//
// 与 Slack 轮询器不同，这里没有“已完成 id 基线”：账本就是“我们已配对过什么”
// 的记录，所以应用关闭期间完成的卡片，下次启动时仍会获得它的出站行；而从
// 账本重新播种也使得重复变得不可能。
let webhookDoneTimer: ReturnType<typeof setInterval> | null = null;
let webhookOutboundRecorded: Set<string> | null = null;

function seedWebhookOutbound(): Set<string> {
  const seen = new Set<string>();
  try {
    for (const e of listTriggerHistory()) {
      if (e.direction === 'outbound' && e.taskId) seen.add(e.taskId);
    }
  } catch { /* 账本不可读 → 视为空；追加仍按 taskId 去重 */ }
  return seen;
}

function pollWebhookDoneTasks(): void {
  let tasks: HiveTask[];
  try {
    const ledger = hive.tasks() as { tasks?: HiveTask[] };
    tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
  } catch { return; } // 不可读/缺失的 tasks.json → 跳过本轮
  const done = tasks.filter((t) =>
    t.status === 'done' && (t.webhook != null || t.id.startsWith('webhook-')));
  if (done.length === 0) return;
  const recorded = webhookOutboundRecorded ?? (webhookOutboundRecorded = seedWebhookOutbound());
  const fresh = done.filter((t) => !recorded.has(t.id));
  if (fresh.length === 0) return;

  const history = listTriggerHistory();
  let wrote = false;
  for (const t of fresh) {
    const inbound = history.find((e) => e.direction === 'inbound' && e.taskId === t.id);
    // 没有入站行 = 账本存在之前的卡片。没有可配对的，所以标记为已处理，
    // 而不是只写对话的一半。
    if (!inbound) { recorded.add(t.id); continue; }
    appendTriggerHistory({
      source: inbound.source,
      sourceId: inbound.sourceId,
      sourceName: inbound.sourceName,
      direction: 'outbound',
      peer: inbound.peer,
      title: t.title,
      body: (t.result ?? '').trim() || '(finished with no result recorded)',
      kind: inbound.kind,
      correlationId: inbound.correlationId,
      taskId: t.id
    });
    recorded.add(t.id);
    wrote = true;
  }
  if (wrote) notifyTriggerHistoryUpdated();
}

/** 开始监视看板中 webhook 来源的完成转换（幂等）。 */
function startWebhookDoneObserver(): void {
  if (webhookDoneTimer) return;
  webhookOutboundRecorded = seedWebhookOutbound();
  webhookDoneTimer = setInterval(() => {
    try { pollWebhookDoneTasks(); } catch (e) { console.error('[webhook] done-observer:', e); }
  }, 5000);
}

/** 停止监视看板。未运行时也可安全调用。 */
function stopWebhookDoneObserver(): void {
  if (webhookDoneTimer) { clearInterval(webhookDoneTimer); webhookDoneTimer = null; }
  webhookOutboundRecorded = null;
}

/** 用已启用的端点构建共享 WebhookServer 并启动它。已在运行的服务器是“重新
 *  指向”而非重启（见 `reconcileWebhookServer`）：重启会铸造全新的隧道 URL，
 *  破坏其他所有端点的调用方。公共隧道只在这里开启——绝不对默认值开启；
 *  只有操作者启用某个 webhook 后它才会上线。 */
async function startWebhookServer(): Promise<{ ok: boolean; url?: string; error?: string }> {
  const endpoints = enabledWebhookEndpoints();
  if (endpoints.length === 0) return { ok: false, error: 'no enabled webhook endpoints' };
  if (webhookServer) {
    webhookServer.setEndpoints(endpoints);
    return { ok: true, url: webhookServer.publicUrl() ?? lastWebhookUrl };
  }
  pruneHeldTokens();
  const cfg = readConfig();
  const server = new WebhookServer({
    port: cfg.webhookPort && cfg.webhookPort > 0 ? cfg.webhookPort : WEBHOOK_DEFAULT_PORT,
    endpoints,
    onMessage: handleWebhookMessage,
    lookupStatus: lookupWebhookStatus
  });
  webhookServer = server;
  const res = await server.start();
  // ok:false 覆盖两种情况：“从未绑定端口”（致命 → 丢弃实例）和“绑定成功但
  // 隧道不可用”（安全边界仍在线，必须保持可达/可停——在此处丢弃会漏掉一个
  // 无法停止的监听器）。
  if (!res.ok && !server.listening()) { webhookServer = null; return res; }
  analytics.trackFeature('webhook_trigger');
  if (res.url) lastWebhookUrl = res.url;
  startWebhookDoneObserver();
  return res;
}

/** 任何 webhook 变更后，让运行中的服务器与配置保持一致。运行时热换端点、
 * 启用集变为非空时启动、变空时停止。绝不停健康服务器的机。 */
function reconcileWebhookServer(): void {
  const endpoints = enabledWebhookEndpoints();
  if (endpoints.length === 0) { stopWebhookServer(); return; }
  if (webhookServer) { webhookServer.setEndpoints(endpoints); return; }
  void startWebhookServer().then((r) => {
    if (!r.ok) console.error('[webhook] start failed:', r.error);
    else console.log('[webhook] listening', r.url ? `(tunnel: ${r.url})` : '(no tunnel)');
  });
}

/** 设置界面复制按钮需要的每个端点的公开 URL。隧道从未上线时为空字符串——
 *  UI 显示端点，只是还没有可交出去的 URL。 */
function webhookEndpointUrls(): { id: string; url: string }[] {
  const base = (webhookServer?.publicUrl() ?? lastWebhookUrl ?? '').replace(/\/+$/, '');
  return (readConfig().webhookTriggers ?? []).map((t) => ({
    id: t.id,
    url: base ? `${base}/${encodeURIComponent(t.id)}` : ''
  }));
}

/** 停止并遗忘 webhook 服务器。尽力而为；未运行时也安全。最后一个隧道 URL
 *  会被保留，让设置界面继续显示它。 */
function stopWebhookServer(): void {
  try { webhookServer?.stop(); } catch (e) { console.error('[webhook] stop failed:', e); }
  webhookServer = null;
  // 完成观察器刻意比服务器活得更久（它是账本的事，不是传输的事）——它随
  // 进程/hive 一起拆除，不在这里。
}

/** 持久化的主窗口几何（kv 键 `window.bounds`）。 */
interface WindowBounds { x?: number; y?: number; width: number; height: number }

const DEFAULT_WIN = { width: 1440, height: 900 };
const MIN_WIN = { width: 1280, height: 800 };

/** 校验并钳制恢复的边界：强制最小尺寸，并丢弃不再落在任何已连接显示器上的
 *  位置（显示器被拔掉），避免窗口开到屏幕外。不可用的输入返回 null。 */
function clampBounds(b: unknown): WindowBounds | null {
  if (!b || typeof b !== 'object') return null;
  const r = b as Partial<WindowBounds>;
  if (typeof r.width !== 'number' || typeof r.height !== 'number') return null;
  const width = Math.max(MIN_WIN.width, Math.round(r.width));
  const height = Math.max(MIN_WIN.height, Math.round(r.height));
  if (typeof r.x !== 'number' || typeof r.y !== 'number') return { width, height };
  const x = Math.round(r.x), y = Math.round(r.y);
  // 只有窗口矩形与某个显示器工作区重叠时才保留该位置。
  const onScreen = screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    return x < wa.x + wa.width && x + width > wa.x && y < wa.y + wa.height && y + height > wa.y;
  });
  return onScreen ? { x, y, width, height } : { width, height };
}

/** 针对移动/缩放洪流的极简尾部防抖。 */
function debounce(fn: () => void, ms: number): () => void {
  let t: NodeJS.Timeout | null = null;
  return () => { if (t) clearTimeout(t); t = setTimeout(() => { t = null; fn(); }, ms); };
}

/** 让新楼层相对聚焦窗口级联，避免完全叠在上方；钳制在屏内（clampBounds
 *  会丢弃屏外位置）。 */
function floorCascade(): WindowBounds | null {
  const base = (mainWindow && !mainWindow.isDestroyed())
    ? mainWindow
    : [...allWindows].find((w) => !w.isDestroyed());
  if (!base) return null;
  const b = base.getBounds();
  const OFFSET = 36;
  return clampBounds({ x: b.x + OFFSET, y: b.y + OFFSET, width: b.width, height: b.height });
}

// ─── 可共享的招募：munderdifflin:// 深链 + 文件导入 ─────────────────────
// 一份招募清单绝不自动生成代理：先校验，再交给渲染器，由它预填 Add-Agent
// 弹窗供人工审阅。规格与安全模型见 src/shared/hire.ts。

/** 在渲染器就绪前到达的清单。渲染器订阅挂载后通过 hire:drainPending 主动
 *  拉取这些清单——主进程绝不盲推，这样加载很快的打包版渲染器也不会因为
 *  启动竞态而丢一个深链。 */
const pendingHires: HireManifest[] = [];
let rendererReadyForHires = false;

function deliverHire(manifest: HireManifest): void {
  if (rendererReadyForHires && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('hire:import', manifest);
  } else {
    pendingHires.push(manifest);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  }
}

async function handleHireLink(link: string): Promise<void> {
  const src = parseHireDeepLink(link);
  if (!src) { console.warn('[hire] ignoring malformed deep link'); return; }
  const res = await fetchHireManifest(src);
  if (!res.ok) {
    console.error('[hire] deep link rejected:', res.error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hire:error', { error: res.error });
    }
    return;
  }
  deliverHire(res.manifest);
  analytics.trackFeature('hire_install');
}

// 注册协议。开发模式（electron .）下 Windows 需要显式的 exe+args 形式，
// 否则注册会指向不带入口参数的 electron.exe。
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('munderdifflin', process.execPath, [resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('munderdifflin');
}

// Windows/Linux 上的深链以第二个进程的 argv 到达——获取单实例锁并转发给
// 运行中的实例。（macOS 改为接收 'open-url' 事件。）该锁也杜绝了两个 harness
// 争夺同一 hive，这在以前是可能的但毫无用处。
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  allowQuit = true;
  app.quit();
} else {
  app.on('second-instance', (_evt, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const link = argv.find((a) => a.startsWith('munderdifflin://'));
    if (link) void handleHireLink(link);
  });
}

app.on('open-url', (evt, url) => {
  evt.preventDefault();
  void handleHireLink(url);
});

// IPC：渲染器发出就绪信号并主动拉取任何排队内容（在窗口/订阅存在前到达的
// 深链，包括冷启动）。
ipcMain.handle('hire:drainPending', () => {
  rendererReadyForHires = true;
  const out = pendingHires.splice(0, pendingHires.length);
  return out;
});

// IPC：Add-Agent 弹窗中的“导入招募清单…”文件选择器。每个选中文件都独立
// 校验；有效的相邻文件在遇到无效清单时仍能存活。
ipcMain.handle('hire:openFile', async () => {
  const res = await dialog.showOpenDialog({
    title: l10n('Import hire manifests', '导入招募清单'),
    filters: [{ name: l10n('Hire manifest', '招募清单'), extensions: ['json'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (res.canceled || res.filePaths.length === 0) {
    return { ok: false, manifests: [], errors: [], error: 'cancelled' };
  }
  const batch = readHireManifestFiles(res.filePaths);
  return {
    ok: batch.manifests.length > 0,
    ...batch,
    error: batch.manifests.length === 0 ? 'no valid hire manifests selected' : undefined
  };
});

/**
 * 创建一个窗口。主窗口（无 opts）恢复已保存的几何、使用默认会话、运行 hive、
 * 并保留现有的退出确认提示。楼层窗口（`{ floor: true }`）获得自己独立的持久
 * 会话分区——把它的渲染器状态（代理/队列/选中项）与其他窗口隔离——级联位置，
 * 并在关闭时只停止它自己的终端，应用继续运行。
 */
function createWindow(opts: { floor?: boolean } = {}): BrowserWindow {
  const isFloor = opts.floor === true;

  // 主窗口恢复已保存的几何；楼层相对聚焦窗口级联。
  let saved: WindowBounds | null = null;
  if (!isFloor) { try { saved = clampBounds(persist.getKv('window.bounds')); } catch { saved = null; } }
  const cascade = isFloor ? floorCascade() : null;
  const geom = cascade ?? saved;

  const win = new BrowserWindow({
    width: geom?.width ?? DEFAULT_WIN.width,
    height: geom?.height ?? DEFAULT_WIN.height,
    ...(geom && geom.x !== undefined && geom.y !== undefined ? { x: geom.x, y: geom.y } : {}),
    minWidth: MIN_WIN.width,
    minHeight: MIN_WIN.height,
    title: isFloor ? 'Munder Difflin — Floor' : 'Munder Difflin',
    backgroundColor: '#FFF8E7',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 保持 Chromium 的 OS 渲染器沙箱开启；特权工作留在主进程拥有的
      // 窄 contextBridge/IPC 表面之后。
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // 渲染器运行 hive 的心跳循环（收件箱提醒、消息冲刷、遥测轮询）。
      // Chromium 会节流被遮挡窗口里的定时器——包括锁屏之后——这会悄悄
      // 让用户离开时的 hive 停摆。不要。
      backgroundThrottling: false,
      // 每个楼层获得自己独立的持久会话分区 → 隔离 localStorage，这样楼层之间
      // 不会共享或互相践踏办公室状态。主窗口保留 DEFAULT 会话，让既有持久化
      // 状态正常加载。
      ...(isFloor ? { partition: `persist:floor-${++floorSeq}` } : {})
    }
  });

  // 捕获 webContents 一次：'closed' 之后窗口消失，但此引用仍有效，
  // 作为每个 PTY 的所有权键。
  const wc = win.webContents;

  allWindows.add(win);
  // 全局定时器事件跟随用户——最近聚焦的窗口即主窗口。主窗口也在启动时
  // 同步播种，让启动事件立刻有路由。
  win.on('focus', () => { mainWindow = win; });
  if (!isFloor) mainWindow = win;

  // 渲染器（我们自己可信的本地内容）的权限门。唯一受约束的权限是麦克风
  // 采集：只在一个麦克风功能实际启用时允许——Free Flow 听写
  // （`freeflowEnabled`）或 Realtime Michael 语音会话（`realtimeVoiceEnabled`，
  // 由会话在 start() 时 getUserMedia 之前打开、stop() 时关闭）。两个标志都关
  // 时，即使在 Electron 层也没有任何麦克风访问。我们刻意不按 OpenAI 密钥
  // 是否存在来开闸：那个密钥（`apikey:openai`）与 CLI 引擎共享，所以纯 CLI
  // 用户绝不能把麦克风闸门打开。所有其他权限保持应用此前的宽松行为
  // （例如 xterm/编辑器复制所用的剪贴板必须继续可用）。
  const micFeatureLive = (): boolean => {
    const cfg = readConfig();
    return cfg.freeflowEnabled === true || cfg.realtimeVoiceEnabled === true;
  };
  const ses = win.webContents.session;
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission === 'media') {
      const mediaTypes = details && 'mediaTypes' in details ? details.mediaTypes : undefined;
      const wantsAudio = !mediaTypes || mediaTypes.includes('audio');
      callback(micFeatureLive() && wantsAudio);
      return;
    }
    callback(true);
  });
  ses.setPermissionCheckHandler((_wc, permission) => {
    if (permission === 'media') return micFeatureLive();
    return true;
  });

  // 只有主窗口持久化几何（kv `window.bounds`）；楼层每次启动时重新级联。
  // 最大化/最小化时跳过，这样恢复不会保存全屏矩形。
  if (!isFloor) {
    const saveBounds = debounce(() => {
      if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
      try { persist.setKv('window.bounds', win.getBounds()); } catch { /* DB 尽力而为 */ }
    }, 400);
    win.on('resized', saveBounds);
    win.on('moved', saveBounds);
    win.on('close', () => {
      if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
      try { persist.setKv('window.bounds', win.getBounds()); } catch { /* DB 尽力而为 */ }
    });
  }


  win.once('ready-to-show', () => win.show());

  // 绝不打开窗口；改为把 URL 交给操作系统浏览器。
  //
  // 做了协议校验，因为这里现在可由作者控制的内容触达：发布包 iframe 带有
  // `allow-popups`，所以发布说明正文里的 target="_blank" 链接会到达此处。
  // 只允许 http(s)——不加保护的 openExternal 会在用户机器上愉快地启动
  // file:// 或已注册的自定义协议。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 存在活动 PTY 时的关闭拦截。红叉会销毁窗口；用 before-quit 相同的方式
  // 拦截它，让 PTY 用户不会措手不及。
  win.on('close', (e) => {
    if (allowQuit) return;
    if (isFloor) {
      // 楼层的关闭不是应用退出——只确认它自己的终端，通过自包含的原生对话框
      // （无渲染器弹窗）。确认后窗口关闭；它的 PTY 在 'closed' 处理器中停止。
      const owned = ptyManager.countByOwner(wc);
      if (owned > 0) {
        const choice = dialog.showMessageBoxSync(win, {
          type: 'warning',
          buttons: [l10n('Close floor', '关闭楼层'), l10n('Cancel', '取消')],
          defaultId: 1,
          cancelId: 1,
          message: l10n(`Close this floor? ${owned} running terminal${owned === 1 ? '' : 's'} on it will be stopped.`, `要关闭这个楼层吗？上面运行的 ${owned} 个终端将被停止。`),
          detail: l10n('Other floors keep running.', '其他楼层继续运行。')
        });
        if (choice === 1) e.preventDefault();
      }
      return;
    }
    // 主窗口：现有的应用级退出提示（渲染器弹窗）。
    const count = ptyManager.list().length;
    if (count === 0) return;
    e.preventDefault();
    win.focus();
    wc.send('app:closeRequested', { ptyCount: count });
  });

  // 主窗口是默认的 PTY 汇；楼层完全按每个 PTY 的所有权路由。
  if (!isFloor) ptyManager.attachWebContents(wc);

  // 主框架重载会卸载渲染器的招募订阅——重新排队，直到新渲染器拉取。
  // 用 isMainFrame 作守卫：杂散的子框架导航绝不能把就绪翻回 false
  // （渲染器只在挂载时拉取，否则后续深链会排队并一直等到完整重载）。
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame) rendererReadyForHires = false;
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  win.on('closed', () => {
    allWindows.delete(win);
    // 已关闭的楼层不能留下它在后台空转的终端。（自然的 onExit 拆除——归档 +
    // 工作树清理——仍按每个 PTY 执行。）
    if (isFloor) { try { ptyManager.killByOwner(wc); } catch { /* 尽力而为 */ } }
    if (mainWindow === win) {
      mainWindow = null;
      for (const w of allWindows) { if (!w.isDestroyed()) { mainWindow = w; break; } }
    }
    syncKeepAwake();
  });

  return win;
}

/** 打开一个新楼层窗口——由 multiWindow 标志门控。返回窗口，功能关闭时返回
 *  null（该情况下入口点已隐藏，但 IPC 保持防御性）。 */
function openFloor(): BrowserWindow | null {
  if (!readConfig().multiWindow) return null;
  return createWindow({ floor: true });
}

/** 构建并安装应用菜单。仅在 multiWindow 开启时调用，所以关掉标志时 Electron
 *  使用默认菜单（零行为变化）。使用标准基于角色的菜单项，让复制/粘贴/退出等
 *  跨平台可用，并添加“新建楼层”项（Cmd/Ctrl+Shift+N）。 */
function installAppMenu(): void {
  const isMac = process.platform === 'darwin';
  const newFloorItem = {
    label: l10n('New Floor', '新建楼层'),
    accelerator: 'CmdOrCtrl+Shift+N',
    click: () => { openFloor(); }
  };
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: l10n('File', '文件'),
      submenu: isMac
        ? [newFloorItem, { type: 'separator' as const }, { role: 'close' as const }]
        : [newFloorItem, { type: 'separator' as const }, { role: 'quit' as const }]
    },
    // Edit 菜单被显式展开而不是用 `{ role: 'editMenu' }`，原因只有一个：
    // 剪贴板项上的 `registerAccelerator: false`。
    //
    // 已注册的加速键会被菜单认领，然后通过 `webContents.paste()` 重放动作——
    // 这是比按键晚一拍的异步跳转。听写工具（Muesli、Wispr Flow 等）通过
    // 暂存剪贴板、写入转录、发送粘贴键、然后立即恢复旧剪贴板来插入文本；
    // 因此菜单的迟到粘贴读到的是一秒前恢复后的剪贴板，敲出的不是用户刚说的
    // 内容，而是他上一次复制的内容。它同时命中终端和 composer，因为两者都
    // 在这个重放的下游。
    //
    // registerAccelerator 为 false 时，菜单项仍显示其快捷键，但按键留给聚焦
    // 元素内联处理——xterm 自己的粘贴处理器和 textarea 的原生粘贴事件都在
    // 按键内部同步读取剪贴板，早于任何恢复落地。
    {
      label: l10n('Edit', '编辑'),
      submenu: [
        { role: 'undo' as const, registerAccelerator: false },
        { role: 'redo' as const, registerAccelerator: false },
        { type: 'separator' as const },
        { role: 'cut' as const, registerAccelerator: false },
        { role: 'copy' as const, registerAccelerator: false },
        { role: 'paste' as const, registerAccelerator: false },
        { role: 'selectAll' as const, registerAccelerator: false }
      ]
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}


// ─── IPC: pty 生命周期 ─────────────────────────────────────────────────────
/** Codex 把其卷展转录存放在按代理隔离的 CODEX_HOME 下
 *  （<hive>/agents/<id>/.codex/sessions/<Y>/<M>/<D>/rollout-*-<sessionId>.jsonl）。
 *  新加入的代理拿到空的 CODEX_HOME，因此 `codex resume <sid>` 什么也找不到，
 *  静默打开一个空白会话——这正像是 Add Agent“恢复会话”字段在做什么。找到
 *  拥有该卷展的代理 CODEX_HOME，返回那个 home，让被恢复的代理可以指向它
 *  （卷展和它的 state_5.sqlite 索引一起住在那里）。 */
function findCodexHomeForSession(sessionId: string, siblingsRoot: string): string | null {
  try {
    if (!sessionId || !/^[0-9a-fA-F][0-9a-fA-F-]{15,}$/.test(sessionId)) return null;
    let fallbackHome: string | null = null;
    // 遍历每个兄弟代理的 CODEX_HOME（<agent>/.codex），查找拥有这个会话的
    // 卷展。我们返回那个 home 而不是把卷展复制出来：Codex 在 state_5.sqlite
    // 里给会话建索引，所以新 home 里孤立的一份卷展对 `codex resume` 不可见。
    // 把被恢复的代理指向所属 home，就同时给了它卷展和索引。
    let agents: Array<{ name: string; isDirectory(): boolean }>;
    try {
      agents = readdirSync(siblingsRoot, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean }>;
    } catch { return null; }
    for (const a of agents) {
      if (!a.isDirectory()) continue;
      const home = join(siblingsRoot, a.name, '.codex');
      const sessions = join(home, 'sessions');
      if (!existsSync(sessions)) continue;
      const stack = [sessions];
      let hasRollout = false;
      while (stack.length && !hasRollout) {
        const d = stack.pop() as string;
        let ents: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
        try {
          ents = readdirSync(d, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
        } catch { continue; }
        for (const e of ents) {
          const pth = join(d, e.name);
          if (e.isDirectory()) stack.push(pth);
          else if (e.isFile() && e.name.endsWith('.jsonl') && e.name.includes(sessionId)) { hasRollout = true; break; }
        }
      }
      if (!hasRollout) continue;
      // 优先选择其 Codex 状态数据库确实索引了此会话的 home——刚播种的 home
      // 可能只带一份孤立的卷展副本（无索引），`codex resume` 打不开。在
      // state_5.sqlite（及其 WAL）中按原始字节匹配 id。有卷展但无索引的 home
      // 作为最后手段的回退。
      const idBuf = Buffer.from(sessionId);
      let indexed = false;
      for (const db of ['state_5.sqlite', 'state_5.sqlite-wal']) {
        try { if (readFileSync(join(home, db)).includes(idBuf)) { indexed = true; break; } } catch { /* 无 db */ }
      }
      if (indexed) return home;
      if (!fallbackHome) fallbackHome = home;
    }
    return fallbackHome;
  } catch (e) {
    console.error('[resume] findCodexHomeForSession failed:', e);
    return null;
  }
}

/** `pty:spawn` IPC 处理器与 god 触发的临时 worker 观察器共享的生成选项。 */
type AgentSpawnOptions = SpawnOptions & { hive?: AgentMeta; isolate?: boolean; resume?: boolean; requireResume?: boolean; resumeSessionId?: string; provider?: AgentProvider; noAutoInstall?: boolean };

/** 把 `ptyManager.spawn` 的失败字符串映射到封闭的 `agent_spawn_failed.reason`
 *  枚举（analytics.ts）。两个已知字符串来自 PtyManager.spawn；其他都是通用
 *  `spawn_error`。原始消息绝不出机器——只有枚举值出，按 TELEMETRY.md。 */
function spawnFailReason(error?: string): SpawnFailReason {
  if (error?.startsWith('cwd does not exist')) return 'cwd_missing';
  if (error?.includes('already exists')) return 'already_running';
  return 'spawn_error';
}

ipcMain.handle('pty:spawn', async (evt, opts: AgentSpawnOptions) => {
  if (!opts || typeof opts.id !== 'string' || typeof opts.cwd !== 'string' || typeof opts.command !== 'string') {
    return { ok: false, error: 'invalid SpawnOptions' };
  }
  // 把生成窗口记录为该 PTY 的所有者，让它的输出只路由回那个楼层，然后运行
  // 共享的生成核心。
  const owner = BrowserWindow.fromWebContents(evt.sender)?.webContents ?? null;
  return spawnAgentCore(opts, owner);
});

/** 核心代理生成逻辑——provider 推断、缺 CLI 安装器短路、git 工作树隔离、
 *  hive 供给、模型/恢复标志、最终 PTY 生成。从 `pty:spawn` IPC 处理器
 *  逐字提取出来，以便 god 触发的临时 worker 观察器（没有渲染器 `evt`）也能
 *  调用它。`owner` 是应接收该 PTY 输出的窗口（null → 主窗口）。与此前内联
 *  处理器行为一致。 */
async function spawnAgentCore(opts: AgentSpawnOptions, owner: Electron.WebContents | null): Promise<{ ok: boolean; error?: string; cwd?: string; worktreePath?: string; resumeNotFound?: boolean; resumed?: boolean; seedPrompt?: string }> {
  // ── cwd 摄取——在这里把 `~` 恰好展开一次 ───────────────────────────────
  // 这是每个代理生成的唯一入口（`pty:spawn` IPC 和 god 触发的临时 worker
  // 观察器），所以用户输入的 `~/dev/foo` 在这里变成绝对路径。只有 shell 会
  // 展开 `~`；Node 把它当普通目录，因此没有这一步，下游每个 existsSync/
  // statSync 都会以 `cwd does not exist` 失败。在 hive 供给之前展开，正是
  // 让注册表存绝对 cwd（且 `cwdValid: true`）的原因。解析后的值返回给调用方，
  // 让渲染器记录同一绝对路径。
  opts.cwd = expandTilde(opts.cwd);
  if (opts.hive) opts.hive = { ...opts.hive, cwd: expandTilde(opts.hive.cwd) };
  // 是哪个 CLI？显式优先；否则从二进制名推断（claude/codex/grok/agy）。
  // 非 Claude provider 跳过下面所有 Claude 专属的生成步骤。把解析出的 provider
  // 持久化到 opts（+ hive 元数据）上，让注册表记录与下游感知 provider 的
  // 步骤对同一个值达成一致。
  const provider = inferAgentProvider(opts.command, opts.provider ?? opts.hive?.provider);
  const claudeProvider = isClaudeProvider(provider);
  opts.provider = provider;
  if (opts.hive) opts.hive = { ...opts.hive, provider };
  // 激活漏斗入口（v0.4.6）：记录每个生成 REQUEST，这样（attempted − spawned）
  // 就能度量这次整体重建想要看到的结果。以 !noAutoInstall 为门——让缺 CLI
  // 重启（唯一的重入点，index.ts 安装退出处理器）不会把同一次用户尝试算两次
  // ——它就是同一次尝试的延续。
  if (!opts.noAutoInstall) analytics.track('agent_spawn_attempted', { provider });
  // ── 缺引擎 CLI → 先运行其安装器（生成前可见）────────────────────────
  // 如果代理的引擎二进制（claude/codex/…）未安装，生成它只会以
  // “— process exited (code 1) —” 死掉，用户完全不知道为什么。在生成前检测
  // 缺失的二进制，并在同一个终端里打印横幅 + 运行 provider 的安装命令，
  // 让用户能看到（并完成任何交互式登录）。安装器干净退出后，PTY 退出处理器
  // 会自动“重启并继续”——它重跑本次生成（带 noAutoInstall），让刚装好的 CLI
  // 在同一个 pty/窗口里启动，无需用户点击。严格在生成前：已启动的 CLI 的非零
  // 退出永远不会到这里，所以不存在安装循环；而重启携带的 noAutoInstall 保证
  // 安装器不会跑两次。没有已知安装器的 provider 只得到手动提示（且不会被武装
  // 用于重启）——绝不自动运行任何随意的东西。我们在工作树/hive/Claude 标志
  // 设置之前短路：本 id 的 ptyToAgent + worktreePaths 保持未设置，所以安装
  // PTY 退出时 teardownPty 是无害的空操作（代理不会被归档、没有工作树被拆），
  // 之后才由重启接管。
  {
    const bin = opts.command.trim().split(/\s+/)[0] || opts.command;
    if (bin && !opts.noAutoInstall && !ptyManager.isCommandAvailable(bin)) {
      // 安装命令是 `npm install -g …`。像探测引擎 CLI 一样探测 npm，
      // 让没有 Node 的机器走无 Node 档（或诚实的手动提示），而不是看着
      // `npm: not found` 滚屏。npm 的 Node 低于底线算不可用：创始人规则
      // （2026-08-07）是“他们的 Node 比我们的新 → 别动；缺失或更旧 →
      // 为他们装最新稳定版”。
      const npmAvailable =
        ptyManager.isCommandAvailable('npm') &&
        nodeIsUsable(detectNodeVersion(ptyManager.commandPath('node')));
      // 只在确实需要时才联网（npm 缺失/太旧）；resolveNodeInstaller 有超时
      // 上限，离线时返回 null，只是把档位降到 native/manual。
      const nodeInstaller = npmAvailable ? null : await resolveNodeInstaller();
      const rung = chooseInstallRung(installInfoForProvider(provider), npmAvailable, nodeInstaller);
      const res = ptyManager.spawn(
        {
          id: opts.id,
          cwd: opts.cwd,
          command: bin,
          cols: opts.cols,
          rows: opts.rows,
          shellScript: buildMissingCliScript(bin, provider, npmAvailable, process.platform, nodeInstaller)
        },
        owner
      );
      // 武装自动“重启并继续”：安装 PTY 干净退出时，退出处理器重跑生成，
      // 让刚装好的 CLI 就地启动（无需用户点击）。只在安装器实际运行时才武装
      // （没有内置安装器的 provider 只打印手动提示并退出 0——在那里重启会
      // 生成仍然缺失的二进制然后死掉）且 PTY 确实启动了。
      // …按 RUNG 而不是 `installCommand` 作键：manual 档打印提示并退出 0，
      // 在那里重启只会重新生成缺失的二进制、带着这条路径本要取代的裸
      // “process exited (code 1)” 死掉。
      if (res.ok && rung.command) {
        pendingInstallRelaunch.set(opts.id, { opts, owner, bin, rung: rung.kind });
        // 自动安装 PTY 正在运行；它的退出会通过 agent_install_finished 说明
        // 是否真的产出了一个代理（此处构造上 rung 是非 manual 档）。
        analytics.track('agent_install_started', { provider, rung: rung.kind });
      } else if (res.ok) {
        // Manual 档：PTY 只打印了提示（没有可运行的安装器，未武装重启），
        // 所以不会有代理启动。这就是过去什么都没发送的 Mode 2 情形——
        // 引擎缺失且没有无人值守安装路径。
        analytics.track('agent_spawn_failed', { provider, reason: 'cli_missing' });
      } else {
        // 安装 PTY 本身生成失败（cwd 消失、id 冲突、抛出）。
        analytics.track('agent_spawn_failed', { provider, reason: spawnFailReason(res.error) });
      }
      syncKeepAwake();
      return res;
    }
  }
  // Git 隔离：请求时且 cwd 是真实仓库时，给该代理一个基于 `agent/<id>` 分支的
  // 独立工作树，让它不会践踏其他代理（或用户）的工作树。尽力而为——失败时
  // 回退到共享 cwd 而不是阻塞生成。
  // 注意（已跟踪、尚未加固）：restore 流程传 isolate:false 并按 cwd 重入现有
  // 工作树，所以它永远到不了这里。但一个陈旧的 `isolate:true` 配方针对已存在
  // 的工作树路径生成时，会让下面的 addWorktree 冲突（路径/分支已存在）并回退
  // 到基础 cwd——复用既有工作树的处理是后续工作。
  if (opts.isolate === true && await isRepo(opts.cwd)) {
    try {
      const origCwd = opts.cwd;
      const wtRoot = join(readConfig().harnessHome ?? origCwd, 'worktrees');
      // id 由渲染器提供（只校验为字符串）。slug 化它，让精心构造的 id 无法
      // 注入路径分隔符，然后断言解析后的路径仍位于工作树根之下（抵御 slug 化
      // 会原样留下的裸 '..'）。若会逃逸，则放弃隔离 → 回退到 cwd。
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
  // 代理档 CLI（qwen）通过回环 sidecar 路由其 LLM 流量，sidecar 的
  // UPSTREAM 在 hive.ensureAgent 内部从预设的 bridge.baseUrlEnv 读取。
  // 对本地 LLM 路径，把用户配置的 base URL 喂给该 upstream，让代理转发到
  // 他们的端点（Ollama/LM Studio/vLLM）。在 ensureAgent 读取它之前设置到
  // process.env 上。
  if (opts.hive && provider === 'qwen') {
    const bridge = providerPreset(provider).bridge;
    const baseUrl = readConfig().providerBaseUrls?.[provider];
    if (bridge && bridge.kind === 'proxy' && baseUrl) process.env[bridge.baseUrlEnv] = baseUrl;
  }
  // 若代理携带 hive 元数据，供给其工作区并注入 provider 专属的生成参数。
  // 非 Claude provider 只获得共享的 AGENT_* 环境变量；Claude Code 还会获得
  // prompt/settings 钩子参数。
  // 必须在启动后敲进裸 TUI 的协议种子（Crush——seedDelivery:'type-into-tui'）
  // 而不是经 argv 传入。在生成结果中带出，让渲染器通过每条 pty 的写入链
  // 把它敲进去。（ondev-b）
  let seedPrompt: string | undefined;
  if (opts.hive && hive.enabled()) {
    try {
      const inj = await hive.ensureAgent(
        { ...opts.hive, cwd: opts.cwd, provider },
        {
          semanticMemory: memory.active(),
          knowledgeGraph: knowledge.active(),
          // 把绝对的 KG CLI 路径烘焙进代理的 prompt。prompt 过去写成
          // `$KG_CLI`，那只是 POSIX 的写法：在 cmd.exe/PowerShell 下会展开成
          // 空，所以 Windows 楼层上的每条知识图谱指令都是死的。KG 关闭时为空
          // （那时不发出该行）。
          kgCliPath: knowledge.env().KG_CLI,
          theme: readConfig().terminalTheme ?? 'light',
          // W3 — 默认 MCP 同意状态 + 打包技能源目录。
          mcpDefaults: readConfig().mcpDefaults,
          skillsDir: skillsResourceDir(),
          // 共享宫殿由代理自己的 `mempalace` 调用修改，所以 OS 沙箱必须放行
          // （内存关闭时为空）。
          extraWritableDirs: [memory.env().MEMPALACE_PALACE_PATH].filter((p): p is string => !!p)
        }
      );
      opts.args = [...(opts.args ?? []), ...inj.args];
      seedPrompt = inj.seedPrompt;
      // 降级生成（代理桥从未绑定）以与熔断器升级相同的方式告知用户：原生
      // 提示，以通知设置为门。hive 已记录它并推送 hive:degraded 到楼层。
      if (inj.degraded) breakerToast(l10n('Agent running degraded', '代理运行降级'), inj.degraded);
      // 把代理的 mempalace CLI 指向共享宫殿、`kg` CLI 指向企业知识库
      // （各自标志关闭时都为空操作/为空）。
      opts.env = { ...(opts.env ?? {}), ...inj.env, ...memory.env(), ...knowledge.env() };
    } catch (e) {
      // hive 供给是尽力而为的；绝不让它阻塞生成。
      console.error('[hive] ensureAgent failed:', e);
    }
  }
  // 长跑护栏 + 分档（Lane A #6.4/#6.6）。都附加到已组装好的 args 上
  // （含 hive 注入）；显式选择总是优先。
  // 当显式填写的 Add Agent“恢复会话”id 找不到、我们静默回退到新会话时置位
  // ——返回给对话框以便把它浮出来。
  let resumeNotFound = false;
  // 当 `--resume` 实际被附加（显式 id 或重启恢复）时置位，让渲染器可以跳过
  // 对已恢复其线程的 god/助理重新定位。
  let didResume = false;
  // Claude 专属——这些是 Claude Code 标志；其他 CLI 在渲染器已构建的命令
  // 字符串里带自己的标志。
  if (opts.hive && claudeProvider) {
    const cfg = readConfig();
    // 权限姿态（D9）：只有 GUI 招聘（Add Agent）通过 buildSpawnCommand 构建
    // 命令，它把 autoMode 的绕过标志烘进命令 STRING，早于本函数见到它。
    // 仅主进程的生成（临时 worker 观察器、语音招聘）完全跳过那一步，所以它
    // 之前到达这里时既没有标志也没有等价物——其他每个 Claude 生成路径都得到
    // 用户 autoMode 的姿态，唯独这条没有。argsWithAutoModeFlag 是幂等的
    // （GUI 生成的 args 已带标志，对它来说是空操作），并且与 spawnAgentCore
    // 几行后为 opencode/crush 等经 HIVE_AUTO_APPROVE 应用的检查相同——一个
    // 全局开关、一个姿态、每条生成路径。
    // 实盘确认：没有这个标志生成的 worker 死锁——发给它的跨会话消息返回
    // “held for the recipient user's approval”，却没有任何人可授予该批准的界面。
    const args = argsWithAutoModeFlag(opts.args ?? [], cfg.autoMode, provider);
    // 模型优先级：显式的逐代理 --model（来自渲染器）优先；否则用户全局
    // defaultModel；否则基于角色的默认档。GOD 特殊处理：它有自己的引擎配置
    // （godProvider/godModel），所以 modelForRole 解析它，优先于面向 worker
    // 的 defaultModel。
    if (!args.includes('--model')) {
      const m = opts.hive.isGod
        ? modelForRole(opts.hive, cfg)
        : cfg.defaultModel ?? modelForRole(opts.hive, cfg);
      if (m) args.push('--model', m);
    }
    // 用代理的名字命名 Remote Control 会话（Michael、Jim、Dev1…），好让它在
    // claude.ai / 手机端可辨认。否则 Claude 默认用机器主机名做前缀
    // （如 "vyapaks-macbook-pro-…"），几个代理同时跑时完全无法区分——
    // 尤其在 remoteControlAtStartup 开启、RC 对每个会话都自动启用时。
    // 把友好名字 slug 成单个安全 token；Claude 仍会加上自己的随机后缀保证唯一。
    if (!args.includes('--remote-control-session-name-prefix')) {
      const label = (opts.hive.name || opts.hive.id || '')
        .trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
      if (label) args.push('--remote-control-session-name-prefix', label);
    }
    // 粗略的失控上限。
    if (typeof cfg.maxTurns === 'number' && cfg.maxTurns > 0 && !args.includes('--max-turns')) {
      args.push('--max-turns', String(cfg.maxTurns));
    }
    // 恢复：显式的会话 id（Add Agent“恢复会话”字段，#2）优先，否则用该代理
    // 最后一次记录的会话（#1 重启即恢复 / #6.6a）。先把 transcript 播种到目标
    // cwd 的 Claude 项目目录——Claude 按键 cwd 组织会话，所以在别处启动的
    // 会话直到其 `.jsonl` 被拷过来前都是不可见的。只有在 transcript 实际存在
    // 时（无论原本就在还是拷贝后）才附加 `--resume`；否则回退到新会话，而不是
    // 对着缺失的 id 启动 `--resume`。
    const explicitSid = typeof opts.resumeSessionId === 'string' ? opts.resumeSessionId.trim() : '';
    const sid = explicitSid || (opts.resume === true ? hive.lastSession(opts.hive.id) : undefined);
    if (sid && !args.includes('--resume')) {
      if (seedSessionTranscript(opts.cwd, sid)) {
        args.push('--resume', sid);
        didResume = true;
      } else if (explicitSid) {
        // 用户在 Add Agent 对话框里敲了会话 id，但它不在任何 Claude 项目目录
        // 里——我们回退到一个全新会话，而不是坏掉的 `--resume`。不静默处理：
        // 在楼层上警告并把标志回传给渲染器，让对话框能告诉用户“已全新开始”。
        console.warn(`[resume] session "${explicitSid}" not found in any Claude project dir — starting a fresh session`);
        resumeNotFound = true;
      }
    }
    opts.args = args;
  }
  // 重启即恢复的幂等会话恢复（#6.6a），provider 感知：Claude `--resume <sid>`、
  // Grok `--resume <sid>`、Antigravity `--conversation <id>`。记录的会话 id 来自
  // 钩子载荷，所以被恢复的 worker 会继续它之前的 CLI 会话。仅在请求了恢复且该
  // 代理存在先前 id 时。Claude 版恢复——含 transcript 播种与仅在有内容时附加
  // ——在上面的 Claude 专属块里处理；这个通用标志路径覆盖其他 CLI（播种失败
  // 时绝不能盲目附加 `--resume`）。
  if (opts.hive && !claudeProvider) {
    const preset = providerPreset(provider);
    const rf = preset.resumeFlag;
    const rsub = preset.resumeSubcommand;
    // 用户在 Add Agent“恢复会话”字段里敲的 id 优先；否则回退到该代理自己记录
    // 的会话（原地重启）。之前 resumeSessionId 只在 Claude 分支里读，所以 Codex
    // 代理会静默忽略它并启动一个全新的空会话。
    const typedSid = typeof opts.resumeSessionId === 'string' ? opts.resumeSessionId.trim() : '';
    const sid = typedSid || (opts.resume === true ? hive.lastSession(opts.hive.id) : undefined);
    if (sid && rf) {
      const args = opts.args ?? [];
      if (!args.includes(rf)) { args.push(rf, sid); opts.args = args; didResume = true; }
    } else if (sid && rsub) {
      // 子命令形式（Codex）：`codex resume [OPTIONS] [SESSION_ID]`——子命令必须
      // 是 argv[0]，id 跟在标志后面。Codex 在 state_5.sqlite 里给会话建索引，
      // 所以新代理的空 CODEX_HOME 无法按 id 恢复。如果该代理自己的 home 已有
      // 该会话，就原地恢复；否则把 CODEX_HOME 指向拥有它的代理 home（那里同时
      // 有卷展和 sqlite 索引）。
      const myHome = (opts.env ?? {}).CODEX_HOME;
      const agentsRoot = myHome ? dirname(dirname(myHome)) : '';
      const ownerHome = agentsRoot ? findCodexHomeForSession(sid, agentsRoot) : null;
      if (!ownerHome) {
        console.warn(`[resume] codex session "${sid}" not found in any agent CODEX_HOME - starting fresh`);
        if (typedSid) resumeNotFound = true;
      } else {
        if (ownerHome !== myHome) opts.env = { ...(opts.env ?? {}), CODEX_HOME: ownerHome };
        const args = opts.args ?? [];
        // 位置顺序很关键：`codex resume [OPTIONS] [SESSION_ID] [PROMPT]`。hive
        // 身份提示以位置参数形式骑在 `args` 里（codex 没有 prompt 标志），所以
        // id 必须在它之前——把 id 追加到最后会让 codex 把提示当 SESSION_ID 读
        // （"No saved session found with ID You are \"Dev2\"…"）而把 id 当提示。
        if (args[0] !== rsub) { opts.args = [rsub, sid, ...args]; didResume = true; }
        console.log('[resume] codex resume', sid, 'in', ownerHome);
      }
    }
  }
  if (opts.requireResume === true && !didResume) {
    return {
      ok: false,
      error: 'Existing session could not be resumed; no replacement process was started.',
      ...(resumeNotFound ? { resumeNotFound: true } : {})
    };
  }
  // 记住哪个代理拥有这个 PTY，这样关闭标签页时可以归档它。活的终端意味着
  // 活跃——上面的 ensureAgent 已经清掉了 `archived`。
  if (opts.hive?.id) {
    ptyToAgent.set(opts.id, opts.hive.id);
    // Worker 收件箱唤醒看门狗（#151）：启动宽限期从生成时开始，让最初的
    // 定向提示永远不会被误判为闲置代理。
    workerWake.noteSpawn(opts.id);
  }
  // 预先接受 Claude Code 的绕过模式警告 + 文件夹信任对话框，让代理（以
  // --permission-mode bypassPermissions 生成）不会卡在它无法回答的交互式
  // 提示上然后以退出码 1 结束。尽力而为，绝不阻塞。仅 Claude——其他 CLI
  // 处理自己的权限 UX。
  if (claudeProvider) {
    try { ensureClaudePermissionsAccepted(opts.cwd); } catch { /* 绝不阻塞 spawn */ }
  }
  // 静默掉 provider 需要的首次运行交互提示（如 Codex 的目录信任闸门经
  // CODEX_NON_INTERACTIVE）。合并进 opts 上已有的任何 env。
  const nonInteractiveEnv = nonInteractiveEnvForProvider(provider);
  if (Object.keys(nonInteractiveEnv).length > 0) {
    opts.env = { ...(opts.env ?? {}), ...nonInteractiveEnv };
  }
  // ── 非 Claude 引擎的 BYOK 键 + 逐 provider 配置（v0.3.1）──────────────
  // qwen 从标准 env 变量读 BYOK API 键，并且在本地 LLM 路径下读逐 provider 的
  // base URL。键在 broker 里只写（这里仅在主进程读取，从不记日志）；
  // base URL 放在 HarnessConfig 里。Claude/codex 用自己的登录，所以跳过这里。
  if (opts.hive && provider === 'qwen') {
    const cfg = readConfig();
    const extra: Record<string, string> = {};
    // 1) BYOK 键——最小权限（Pam/Jim NIT-2）：能识别出所生成模型的 provider
    //    前缀时，只注入该 provider 的那一个键；模型/前缀未知时（默认模型、
    //    qwen 别名、自定义）回退到全部已存键。相比把每个键都发给每个 CLI，
    //    这缩小了爆炸半径。
    const modelIdx = (opts.args ?? []).indexOf('--model');
    const modelSlug = modelIdx >= 0 ? (opts.args?.[modelIdx + 1] ?? '') : '';
    const prefix = modelSlug.includes('/') ? modelSlug.split('/')[0].toLowerCase() : '';
    const PREFIX_BACKEND: Record<string, string> = {
      anthropic: 'anthropic', openai: 'openai', google: 'google', gemini: 'google', groq: 'groq', openrouter: 'openrouter'
    };
    const scoped = PREFIX_BACKEND[prefix];
    const backends = scoped ? [scoped] : Object.keys(BACKEND_KEY_ENV);
    for (const backend of backends) {
      const key = integrations.getSecret(providerKeyRef(backend));
      if (!key) continue;
      extra[BACKEND_KEY_ENV[backend]] = key;
      // OpenCode/AI-SDK 的 Google provider 读的是 GOOGLE_GENERATIVE_AI_API_KEY
      // 而不是 GEMINI_API_KEY——两个都注入，好让 google/* 能认证（Jim NIT #1）。
      if (backend === 'google') extra.GOOGLE_GENERATIVE_AI_API_KEY = key;
    }
    // 2) pi 的内置扩展自动放行的楼层自动态（guardrail #5）：只有这个值为 '1'
    //    时它才自动批准工具调用（即楼层自动模式开启）。
    extra.HIVE_AUTO_APPROVE = cfg.autoMode ? '1' : '0';
    // 3) 强制 qwen 的 getShellConfiguration 命中 Git Bash 分支：qwen 在
    //    Windows 上按 MSYSTEM（MINGW/MSYS 前缀）→ Git Bash、ComSpec 以
    //    powershell 结尾 → -NoProfile -Command、否则 cmd 三级判定。本机
    //    ComSpec=cmd.exe，qwen 会落 cmd 分支并用 `chcp 65001` 前缀——那只改
    //    控制台代码页，管不到 PowerShell 5.1 Get-Content 的 ANSI/GBK 读取
    //    解码，UTF-8 文件在 agent 读文件时乱码（璧氶挶）。设 MSYSTEM 让 qwen
    //    走 findGitBashPath 找到的 D:\Git\bin\bash.exe（在 PATH 里），bash
    //    读文件按字节流透传，UTF-8 无转换。双通道之一：本注入是 spawn 级兜底，
    //    与 ~/.qwen/settings.json 的 env.MSYSTEM（qwen 自加载）互为备份。
    extra.MSYSTEM = 'MINGW64';
    // 4) qwen 的终端擦除优化（installTerminalRedrawOptimizer）在 ConPTY 下
    //    把多行擦除序列重写为光标序列，导致大量重复行/截断帧/视觉乱码。
    //    设 legacy 擦除开关为 '1'，走逐行擦除路径。
    extra.QWEN_CODE_LEGACY_ERASE_LINES = '1';
    // 5) qwen 的 resize-reflow 优化（installTerminalResizeReflow）在窗口
    //    缩窄时向输出流注入 CLEAR_VIEWPORT（ESC[2J ESC[H）并重绘整屏。
    //    该序列经 node-pty 的 ConPTY 通道转发时若被拆分/时序错位，旧帧
    //    不会真正清除，新帧直接叠加在其后——窄窗口（列数 < 80，首帧即
    //    视为 shrink）下启动横幅会重复 3 份。设 legacy 开关为 '1' 禁用。
    extra.QWEN_CODE_LEGACY_RESIZE_ERASE = '1';
    opts.env = { ...(opts.env ?? {}), ...extra };
  }
  // Codex Remote 是基于守护进程的（没有 `/remote-control` 斜杠命令）。
  // 在该代理隔离的 CODEX_HOME 下启动/启用守护进程并把 TUI 连上去，让线程
  // 在 ChatGPT 手机端可见。尽力而为：不可用/更旧的 Codex 安装仍会得到一个
  // 普通本地终端。
  if (provider === 'codex' && opts.hive?.id) {
    await enableCodexRemoteForSpawn(opts, opts.hive.id);
  }
  const res = ptyManager.spawn(opts, owner);
  if (res.ok) analytics.track('agent_spawned', { provider });
  else analytics.track('agent_spawn_failed', { provider, reason: spawnFailReason(res.error) });
  syncKeepAwake(); // 只要有 ≥1 个代理 PTY 活着就武装省电拦截器（#18）
  // 把解析出的工作树路径交回渲染器，让它持久化到代理上（只有在上面真的
  // 供给出工作树时才设置）。restore 流程按 cwd == worktreePath 精确重入这个
  // 工作树，所以被恢复的隔离代理回到的是正确的检出，而不是基础仓库。
  const worktreePath = worktreePaths.get(opts.id);
  // `cwd` 把展开过 ~ 的绝对路径回传，让渲染器的代理记录与注册表和 PTY
  // 实际使用的路径一致。
  return { ...res, cwd: opts.cwd, ...(worktreePath ? { worktreePath } : {}), ...(resumeNotFound ? { resumeNotFound: true } : {}), ...(didResume ? { resumed: true } : {}), ...(seedPrompt ? { seedPrompt } : {}) };
}
ipcMain.handle('pty:write', (_evt, id: string, data: string) => {
  if (typeof id !== 'string' || typeof data !== 'string') return { ok: false, error: 'invalid args' };
  return ptyManager.write(id, data);
});
ipcMain.handle('pty:resize', (_evt, id: string, cols: number, rows: number) => {
  if (typeof id !== 'string' || typeof cols !== 'number' || typeof rows !== 'number') return { ok: false, error: 'invalid args' };
  return ptyManager.resize(id, cols, rows);
});
ipcMain.handle('pty:redraw', (_evt, id: string) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  return ptyManager.redraw(id);
});
ipcMain.handle('pty:kill', (_evt, id: string) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  // 先杀进程，再执行共享的生命周期拆解（归档 agent、移除其隔离的 worktree、
  // 清空各映射）。teardownPty 是幂等的，所以子进程真正死后 node-pty 再触发
  // onExit 也只是无害的空操作。
  const res = ptyManager.kill(id);
  teardownPty(id);
  return res;
});
ipcMain.handle('pty:list', () => ptyManager.list());

// ─── IPC: analytics（渲染器面向外界的唯一接缝）────────────────────────────────
/** 计数一条人工发送的消息（TELEMETRY.md → `message_sent`）。这只是一个 COUNT，
 *  仅此而已：该通道不接收文本、长度或 id，因此消息内容无论如何都无法从这里流出。
 *
 *  这是渲染器能引发的唯一一个 analytics 事件。之所以存在它，是因为四个发送面中有
 *  两个——输入到 agent 终端里的一行，以及队列 composer——是 main 无法观测到的
 *  submit：上面的 `pty:write` handler 在每次按键都会触发，所以在那里计数得到的是
 *  按键计数，而不是消息计数。`steer` 和 `hive` 在本文件各自的 IPC handler 里计数，
 *  并在这里被拒绝（isRendererMessageSurface），因此它们永远不会被计两次。事件名在
 *  这里固定，而非传入：渲染器选择的是一个 surface，而不是一个事件。 */
ipcMain.handle('analytics:messageSent', (_evt, surface: unknown) => {
  if (!isRendererMessageSurface(surface)) return { ok: false };
  analytics.trackMessageSent(surface);
  return { ok: true };
});

// 把粘贴进来的 Claude session id 解析回它最初运行时的 cwd，以便 Add Agent 对话框
// 能为恢复会话（#2 零步骤恢复）自动填充文件夹。从 transcript 记录里读取 cwd；
// 当 id 无效/未知时返回 null。
ipcMain.handle('session:resolveCwd', (_evt, sessionId: unknown) =>
  (typeof sessionId === 'string' ? resolveSessionCwd(sessionId) : null));

// ─── IPC: 剪贴板 ───────────────────────────────────────────────────────────
ipcMain.handle('app:copyToClipboard', (_evt, text: unknown) => {
  if (typeof text !== 'string') return { ok: false, error: 'invalid text' };
  try { clipboard.writeText(text); return { ok: true }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
ipcMain.handle('app:readClipboard', () => {
  try { return clipboard.readText(); } catch { return ''; }
});
// 同样的读取，但为终端的粘贴快捷键做成 SYNCHRONOUS（同步）版本。
//
// 听写工具（muesli.works、Wispr Flow 等）的输入方式是：先把用户的剪贴板内容
// 藏起来、写入识别文本、发送粘贴按键，然后立刻恢复旧的剪贴板。`invoke` 读取会
// 晚一到两个 tick 才返回——到那时恢复已经完成，我们会粘贴到的是「之前」的文本。
// `sendSync` 读取则在 keydown handler 内部完成，趁工具还没来得及把旧内容放回去。
ipcMain.on('app:readClipboardSync', (evt) => {
  try { evt.returnValue = clipboard.readText(); } catch { evt.returnValue = ''; }
});
// 注意：终端主题会在 spawn 时镜像进每个 agent 的 per-session Claude 设置
// （hive.ensureAgent 的 theme 选项）——特意不用 `claude config set -g theme`，
// 因为那会把应用之外的、用户自己的 Claude 会话也一并重设主题。

// ─── IPC: 文件夹选择器 ──────────────────────────────────────────────────────
ipcMain.handle('dialog:chooseFolder', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return { ok: false as const, error: 'no window' };
  const res = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title: l10n('Pick a folder', '选择文件夹')
  });
  if (res.canceled || res.filePaths.length === 0) return { ok: false as const, error: 'cancelled' };
  return { ok: true as const, path: res.filePaths[0] };
});

// ─── IPC: 在某个文件夹处打开 Terminal.app ───────────────────────────────────
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

// ─── IPC: integrations（Phase 2 注册表——Ryan 的 Settings UI 的后端）──────────
// 记录只是元数据（基于 config）；密钥在静止时加密，且绝不会经 IPC 返回。
// `list` 会把 secretRef 脱敏为 `hasSecret` 布尔值。
ipcMain.handle('integrations:list', () => integrations.listRecordsRedacted());
ipcMain.handle('integrations:templates', () => INTEGRATION_TEMPLATES);
ipcMain.handle('integrations:upsert', (_evt, record: unknown) => integrations.upsertRecord(record));
ipcMain.handle('integrations:setSecret', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { id?: unknown; secret?: unknown };
  if (typeof p.id !== 'string' || !p.id) return { ok: false, error: 'id required' };
  if (typeof p.secret !== 'string' || !p.secret) return { ok: false, error: 'secret required' };
  return integrations.setSecret(secretRefFor(p.id), p.secret);
});
ipcMain.handle('integrations:remove', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { id?: unknown };
  if (typeof p.id !== 'string' || !p.id) return { ok: false, error: 'id required' };
  return integrations.removeRecord(p.id);
});
// ─── IPC: 每个 CLI provider 的 BYOK 密钥（只写）──────────────────────────────
// 非 Claude CLI 所用的后端模型 provider 的 API 密钥，以「只写」方式存于同一个
// 加密 broker 下的 `apikey:<backend>`。渲染器可以 SET（设置）一个密钥、或询问
// 是否已设置（布尔值）——它永远无法读回明文。密钥只在 spawn 时（spawnAgentCore）
// 于 MAIN 侧物化。Base URL 并非机密，随 HarnessConfig.providerBaseUrls 走
// （普通的 config 保存）。
ipcMain.handle('providerKey:set', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { backend?: unknown; key?: unknown };
  if (typeof p.backend !== 'string' || !(p.backend in BACKEND_KEY_ENV)) return { ok: false, error: 'unknown backend' };
  if (typeof p.key !== 'string' || !p.key) return { ok: false, error: 'key required' };
  return integrations.setSecret(providerKeyRef(p.backend), p.key);
});
ipcMain.handle('providerKey:has', (_evt, backend: unknown) =>
  typeof backend === 'string' ? integrations.hasSecret(providerKeyRef(backend)) : false);
ipcMain.handle('providerKey:clear', (_evt, backend: unknown) => {
  if (typeof backend !== 'string' || !(backend in BACKEND_KEY_ENV)) return { ok: false, error: 'unknown backend' };
  try { integrations.deleteSecret(providerKeyRef(backend)); return { ok: true }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
// 经 broker 自己的认证路径探测一个集成是否可达（仅管理员；在 main 中运行，
// 因此密钥被使用但从不返回——只回上游状态）。
ipcMain.handle('integrations:test', async (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { id?: unknown; path?: unknown };
  if (typeof p.id !== 'string' || !p.id) return { ok: false, error: 'id required' };
  const rec = integrations.getRecord(p.id);
  if (!rec) return { ok: false, error: 'unknown integration' };
  const probe = validateBaseUrl(rec.baseUrl);
  if (!probe.ok) return { ok: false, error: probe.error };
  // 让探测路径与 worker 的 forward() 路径走同一个门禁，从而 p.path 中的绝对
  // URL / 反斜杠主机 / 目录穿越无法覆盖 origin 或把密钥外泄给攻击者主机。在密钥
  // 物化之前就完成解析（并拒绝），因此一个坏路径甚至根本不会触发解密。
  const target = resolveUpstreamUrl(rec.baseUrl, typeof p.path === 'string' ? p.path : '');
  if (!target) return { ok: false, error: 'path escapes the integration baseUrl', code: 'bad_request' };
  const secret = integrations.getSecret(rec.secretRef);
  const headers = buildAuthHeaders(rec.authType, rec.authHeader, secret);
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15_000);
    const r = await fetch(target, { method: 'GET', headers, redirect: 'manual', signal: ac.signal });
    clearTimeout(timer);
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

// ─── IPC: config ────────────────────────────────────────────────────────────
ipcMain.handle('config:get', (): HarnessConfig => readConfig());
ipcMain.handle('config:update', (_evt, patch: Partial<HarnessConfig>) => {
  // 首次运行：所有绑定 hive 的服务都由 bootstrapHiveServices() 启动，它只在
  // app-ready 时运行一次，并且在 `!hive.enabled()` 时提前返回——也就是说只要
  // harnessHome 仍为 null（这正是全新安装启动时的状态），就会这样。之后引导流程
  // 通过「本 handler」设置 harnessHome，但没有任何东西重新启动服务，于是 hook
  // server、消息 router、telemetry collector 和 mission scheduler 在整个会话的
  // 剩余时间里都保持死寂。
  //
  // 症状：agent 能 spawn 并运行（PTY 并不绑定 hive），但没有任何 hook 能到达应用
  // ——磁盘上没有 `hooks.sock`，所以没有 SessionStart，也就意味着 recordSession()
  // 永远不会被调用，「Restart & Continue」会报「No recorded session ID」；卡片
  // 也会停在「ctx no status tick yet」且 0 次工具调用。下一次启动应用时一切自愈，
  // 这正是问题被掩盖的原因。
  //
  // changeHome() 一直通过重启来解决这一点；引导流程不重启，所以这里要在
  // null → set 的转换上做 bootstrap。以该转换作为门禁，普通 config 写入就不会
  // 再次进入它。
  const hiveWasEnabled = hive.enabled();
  const wasOnboarded = readConfig().onboardingComplete;
  const next = writeConfig(patch);
  // 从 Settings → Privacy 实时选择启用/停用（TELEMETRY.md）。
  if (typeof patch?.telemetryEnabled === 'boolean') analytics.setEnabled(patch.telemetryEnabled);
  // 激活漏斗（v0.4.6）：引导刚刚完成（false → true）——位于「启动 → 首个 agent」
  // 漏斗的顶端。`provider` 是向导中选择的引擎。
  // 在这里（main）触发而不是在渲染器里，以便与其余事件共用同一个 allowlist。
  if (!wasOnboarded && next.onboardingComplete) {
    analytics.track('onboarding_completed', { provider: next.godProvider ?? 'claude' });
  }
  // 让 hive 对 spawn 门禁的镜像保持最新。队列本身每个 tick 都会读 config，
  // 因此它即时生效；这里针对的是 PROMPT——它按每次 spawn 构建，所以翻转该开关
  // 会在 god 下次启动时生效。
  if (typeof patch?.orchestratorMaySpawn === 'boolean') hive.setOrchestratorMaySpawn(patch.orchestratorMaySpawn);
  if (!hiveWasEnabled && hive.enabled()) {
    console.log('[hive] harnessHome configured — bootstrapping hive services');
    try { bootstrapHiveServices(); } catch (e) { console.error('[hive] bootstrap after onboarding:', e); }
  }
  return next;
});
ipcMain.handle('config:setAgentTokenCap', (_evt, agentId: unknown, tokenCap: unknown) =>
  setAgentTokenCap(agentId, tokenCap)
);
ipcMain.handle('config:ensureHome', (_evt, path: unknown) => {
  if (typeof path !== 'string' || path.length === 0) return { ok: false, error: 'invalid path' };
  return ensureHarnessHome(path);
});

// 更换 harnessHome 文件夹。由于所有派生路径（hive 根、palace、sock、agent 目录）
// 都通过 getHome() 惰性解析，唯一真正的工作是：可选地「移动」现有 hive + palace 并
// 重启，让每个服务都重新绑定到新根上。mode: 'move' 会复制数据（旧数据保留作为
// 安全网），'fresh' 则只重新指向并引导一个空 home。
ipcMain.handle('config:changeHome', async (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { newHome?: unknown; mode?: unknown };
  if (typeof p.newHome !== 'string' || !p.newHome) return { ok: false, error: 'invalid newHome' };
  const mode: 'move' | 'fresh' = p.mode === 'fresh' ? 'fresh' : 'move';
  // 在 resolve 之前先 expandTilde：两个 UI 调用方传入的都是文件夹对话框的结果
  // （总是绝对路径），但 hive 选择器的 recents 列表可能给出一个由 pre-#140 构建
  // 持久化下来的字面量 "~/…"——resolve() 会把它锚定到 cwd，应用就会重启到一个
  // 真的叫 "~" 的目录。这与 expandTilde 自身文档里「在消费端做纵深防御」的规则一致。
  const newHome = resolve(expandTilde(p.newHome));
  const oldRaw = readConfig().harnessHome;
  const oldHome = oldRaw ? resolve(oldRaw) : null;

  // 防止同一文件夹 / 嵌套文件夹（移动会无限自我复制）。
  if (oldHome) {
    if (newHome === oldHome) return { ok: false, error: 'That is already the current home folder.' };
    const a = newHome + sep, b = oldHome + sep;
    if (a.startsWith(b) || b.startsWith(a)) {
      return { ok: false, error: 'Pick a folder that is not inside (or a parent of) the current home.' };
    }
  }

  const ensured = ensureHarnessHome(newHome);
  if (!ensured.ok) return ensured;

  // 复制前先把所有绑定到旧根的东西拆掉，避免复制中途有写入——否则一个正在进行的
  // hive/.git 提交会被当成只写了一半的对象复制走，从而损坏被移动的仓库。
  try { clearMissionTimers(); } catch (e) { console.error('[changeHome] clearMissionTimers:', e); }
  try { clearContextTimers(); } catch (e) { console.error('[changeHome] clearContextTimers:', e); }
  try { stopWebhookDoneObserver(); } catch (e) { console.error('[changeHome] stopWebhookDoneObserver:', e); }
  try { stopEphemeralWorkerWatcher(); } catch (e) { console.error('[changeHome] stopWorkerWatcher:', e); }
  try { integrationBroker.stop(); } catch (e) { console.error('[changeHome] broker.stop:', e); }
  try { hive.stopRouter(); } catch (e) { console.error('[changeHome] stopRouter:', e); }
  try { hookServer.stop(); } catch (e) { console.error('[changeHome] hookServer.stop:', e); }
  try { stopSlackServer(); } catch (e) { console.error('[changeHome] slack.stop:', e); }
  try { stopWebhookServer(); } catch (e) { console.error('[changeHome] webhook.stop:', e); }
  try { memory.stop(); } catch (e) { console.error('[changeHome] memory.stop:', e); }
  try { reflector.stop(); } catch (e) { console.error('[changeHome] reflector.stop:', e); }

  if (mode === 'move' && oldHome) {
    try {
      // roster.json 及其备份随 hive/palace 一起走：roster 是同一状态的渲染器端一半，
      // 把它留下就意味着把 agent 的会话和记忆移到新家，而它们的名字、备注和 worktree
      // 路径仍留在旧家。
      for (const sub of ['hive', 'palace', 'roster.json', 'roster-backups']) {
        const src = join(oldHome, sub);
        if (!existsSync(src)) continue;
        // cpSync 会复制整棵树（含 .git），并且跨设备安全（不同于 renameSync——
        // 跨卷时会抛 EXDEV）。我们只复制、绝不删除——旧文件夹保留下来，作为用户
        // 手动移除的安全网。
        cpSync(src, join(newHome, sub), { recursive: true, force: true, dereference: false });
      }
    } catch (e) {
      // 复制失败：针对未改变的旧 home 原地恢复（config 从未重新指向），让用户什么
      // 都不损失，并把错误暴露出来——不重启。
      bootstrapHiveServices();
      const cfg = readConfig();
      if (cfg.slackEnabled && cfg.slackSigningSecret) void startSlackServer();
      reconcileWebhookServer();
      return { ok: false, error: `Could not copy data: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // 重新指向 config 并重启，让每个服务都针对 newHome 重新引导。
  // （与 resetAll 相同的恢复路径——重启就是干净的重新绑定。）
  allowQuit = true;
  writeConfig({ harnessHome: newHome });
  try { ptyManager.killAll(); } catch (e) { console.error('[changeHome] killAll:', e); }
  app.relaunch();
  app.exit(0);
  return { ok: true as const }; // 不可达（进程已退出）——仅为渲染器做类型标注
});

// ─── IPC: 文件系统（沙箱化到某个根）─────────────────────────────────────────
ipcMain.handle('fs:listDir', (_evt, root: unknown, rel: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
  return listDir(root, rel);
});
ipcMain.handle('fs:readFile', (_evt, root: unknown, rel: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
  return readFileText(root, rel);
});
// 文本读取器拒绝的文件（如图片）的原始字节。渲染器无法自行从磁盘加载它们——
// CSP 没有 `file:` 源，也没有注册 file 协议——所以字节经这里流转，在另一端变成
// `blob:` URL。与所有其他 fs handler 一样受同一根约束限制。
ipcMain.handle('fs:readBinary', (_evt, root: unknown, rel: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
  return readFileBinary(root, rel);
});
ipcMain.handle('fs:writeFile', (_evt, root: unknown, rel: unknown, content: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string' || typeof content !== 'string') {
    return { ok: false, error: 'invalid args' };
  }
  return writeFileText(root, rel, content);
});
// v0.3.4: 终端 ⌘-点击 markdown 流程的存在性检查（仅元数据）。
ipcMain.handle('fs:statAbs', (_evt, p: unknown) => {
  if (typeof p !== 'string' || p.length > 4096 || p.includes('\0')) {
    return { exists: false, isFile: false, path: '' };
  }
  return statAbs(p);
});

/** 在操作系统的文件浏览器中显示某个路径——Finder、Explorer 或 Linux 桌面注册的
 *  任何程序。支撑在终端中对那些我们无法自行打开的路径（图片、压缩包、未知扩展名）
 *  的 ⌘-点击。
 *
 *  对文件，用 `showItemInFolder`，绝不用 `shell.openPath`。路径来自 agent 输出，
 *  openPath 会把任意文件交给它的默认应用：一段打印出来的 `installer.dmg` 或
 *  `.desktop` 距执行只差一次点击。reveal 永远只会打开一个文件浏览器，所以 agent
 *  打印路径所能造成的最大后果，也就是打开一个用户本来就能自己打开的文件夹窗口。
 *
 *  openPath 只用于目录，而且仅在 statAbs 确认它是目录之后——目录没有可启动的
 *  默认应用，所以上面的执行论证不适用；而且在父目录里 reveal 一个文件夹，也不是
 *  「打开这个文件夹」对任何人而言的含义。 */
ipcMain.handle('fs:revealPath', async (_evt, p: unknown) => {
  if (typeof p !== 'string' || !p.length || p.length > 4096 || p.includes('\0')) {
    return { ok: false, error: 'bad request' };
  }
  const st = await statAbs(p);
  if (!st.exists) return { ok: false, error: 'not found' };
  if (st.isFile) { shell.showItemInFolder(st.path); return { ok: true }; }
  const err = await shell.openPath(st.path);
  return err ? { ok: false, error: err } : { ok: true };
});

// ─── IPC: git ───────────────────────────────────────────────────────────────
ipcMain.handle('git:isRepo', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return false;
  return isRepo(cwd);
});

// cwd 所属的仓库——沿链接的 worktree 回溯到它的主 checkout；渲染器据此对
// agent roster 分组。
ipcMain.handle('git:mainRepo', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string' || !cwd) return null;
  return mainRepoRoot(cwd);
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
ipcMain.handle('git:diff', (_evt, cwd: unknown, relPath: unknown) => {
  if (typeof cwd !== 'string' || typeof relPath !== 'string') {
    return { ok: false, error: 'invalid args' };
  }
  return getDiff(cwd, relPath);
});
// ─── v0.3.4: 历史 / 对比 / checkout（git 可视化）────────────────────────────
ipcMain.handle('git:logGraph', (_evt, cwd: unknown, n: unknown, skip: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid args' };
  const count = Math.min(500, Math.max(1, typeof n === 'number' ? n : 200));
  const off = Math.max(0, typeof skip === 'number' ? skip : 0);
  return getLogGraph(cwd, count, off);
});
ipcMain.handle('git:commitFiles', (_evt, cwd: unknown, sha: unknown) => {
  if (typeof cwd !== 'string' || typeof sha !== 'string') return { error: 'invalid args' };
  return getCommitFiles(cwd, sha);
});
ipcMain.handle('git:showFile', (_evt, cwd: unknown, rev: unknown, relPath: unknown) => {
  if (typeof cwd !== 'string' || typeof rev !== 'string' || typeof relPath !== 'string') {
    return { ok: false, error: 'invalid args' };
  }
  return getFileAtRev(cwd, rev, relPath);
});
ipcMain.handle('git:compareRefs', (_evt, cwd: unknown, base: unknown, head: unknown, mode: unknown) => {
  if (typeof cwd !== 'string' || typeof base !== 'string' || typeof head !== 'string') {
    return { error: 'invalid args' };
  }
  return compareRefs(cwd, base, head, mode === 'two' ? 'two' : 'three');
});
ipcMain.handle('git:worktrees', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid args' };
  return listWorktrees(cwd);
});
ipcMain.handle('git:checkout', async (_evt, cwd: unknown, ref: unknown, detach: unknown) => {
  if (typeof cwd !== 'string' || typeof ref !== 'string') return { ok: false, error: 'invalid args' };
  // 守卫：绝不在正在工作的 agent 下交换文件。客观信号由 main 持有——任何
  // cwd 位于该目录树内、并且在最近 10 秒内输出过的存活 pty 都被视为运行中。
  // （空闲但打开的终端没问题：checkoutRef 还要求工作树干净，TUI 会优雅地
  // 重绘以响应文件系统变化。）
  const busy = ptyManager.list().find((p) =>
    (p.cwd === cwd || p.cwd.startsWith(cwd.endsWith('/') ? cwd : `${cwd}/`)) &&
    Date.now() - p.lastOutputAt < 10_000
  );
  if (busy) {
    return { ok: false, error: `an agent is actively working in this repo (${busy.id}) — try again when it goes quiet` };
  }
  return checkoutRef(cwd, ref, detach === true);
});

// ─── IPC: roster mirror（开发版与打包构建共享）─────────────────────────
// 渲染进程的 store 在模块加载时就同步构建，早于任何异步 IPC 解析，因此读取走
// `ipcMain.on` + `returnValue`——启动时一次阻塞往返，换来的是首次绘制时 roster
// 即为正确，而不是先闪烁一片空楼层再填上。
// （`roster` 本身更早构建，HookServer 因此能读取常驻目标。）
/**
 * roster 名称跟随 registry。roster 由 RENDERER 写入
 * （`persistAgents` -> 500ms 防抖 -> `roster:write`），渲染进程在自己的
 * memory/localStorage 里保存显示名。一旦它们与 hive 身份（registry.json 是权威，
 * 例如 god 侧改名为中文后）漂移，渲染进程的写入会把正确的名字悄悄覆盖回去。
 * 所以在每次 `roster:write` 落盘前，我们都用 registry 重新盖印每条记录的 `name`
 * ——渲染进程继续管理其余一切（role、status、order、queues、selectedId），
 * 但 name 始终镜像 registry。
 */
function withRegistryNames(snap: unknown): unknown {
  if (!snap || typeof snap !== 'object') return snap;
  const s = snap as { agents?: unknown[]; archived?: unknown[]; restorable?: unknown[] };
  const reg = hive.registry();
  const fix = (list: unknown[] | undefined): unknown[] | undefined =>
    Array.isArray(list)
      ? list.map((a) => {
          if (!a || typeof a !== 'object') return a;
          const entry = a as { id?: unknown; name?: unknown };
          if (typeof entry.id !== 'string') return a;
          const regName = reg.agents?.[entry.id]?.name;
          return regName ? { ...entry, name: regName } : a;
        })
      : list;
  return { ...s, agents: fix(s.agents), archived: fix(s.archived), restorable: fix(s.restorable) };
}

ipcMain.on('roster:readSync', (evt) => { evt.returnValue = roster.read(); });
ipcMain.on('config:homeSync', (evt) => { evt.returnValue = readConfig().harnessHome ?? null; });
ipcMain.handle('roster:read', () => roster.read());
ipcMain.handle(
  'roster:write',
  (_evt, snap: unknown) => roster.write(withRegistryNames(snap)),
);

// ─── IPC: hive（多 agent 协调）───────────────────────────────────────
ipcMain.handle('hive:registry', () => hive.registry());
ipcMain.handle('hive:renameAgent', (_evt, id: unknown, name: unknown) => {
  if (typeof id !== 'string' || typeof name !== 'string') {
    return { ok: false, error: 'Invalid rename request' };
  }
  return hive.renameAgent(id, name);
});
ipcMain.handle('hive:setAgentHold', (_evt, id: unknown, hold: unknown) => {
  if (typeof id !== 'string' || typeof hold !== 'boolean') {
    return { ok: false, error: 'Invalid hold request' };
  }
  return hive.setAgentHold(id, hold);
});
ipcMain.handle('hive:board', () => hive.board());
ipcMain.handle('hive:tasks', () => hive.tasks());
ipcMain.handle('hive:log', (_evt, n: unknown) => hive.logTail(typeof n === 'number' ? n : 200));
ipcMain.handle('hive:memory', (_evt, id: unknown) => (typeof id === 'string' ? hive.memory(id) : ''));
ipcMain.handle('hive:inbox', (_evt, id: unknown) => (typeof id === 'string' ? hive.inbox(id) : []));
// 语音读取层：最近消息 CONTENT（inbox/outbox 正文），已在主进程侧由
// hive.voiceMessages() 脱敏。渲染进程/语音层永远看不到原始正文——机密在结果
// 跨过 IPC 之前就在这里被剥离。
ipcMain.handle('hive:messages', (_evt, opts: unknown) =>
  hive.voiceMessages(opts && typeof opts === 'object' ? (opts as Parameters<typeof hive.voiceMessages>[0]) : {})
);
ipcMain.handle('hive:send', (_evt, partial: Partial<HiveMessage>, from: unknown) => {
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  const sender = typeof from === 'string' ? from : 'system';
  const msg = hive.send(partial ?? {}, sender);
  // 只统计 PERSON 发送的。每个以人类名义分发的渲染进程界面都传 'human'
  // （Command Center 派发、线程回复、ASK ME 答复）；agent 间流量传的是 agent id，
  // 会把数字淹没。在发送之后才统计，因此被拒绝的消息永远不会被计入。
  if (sender === 'human') analytics.trackMessageSent('hive');
  return { ok: true, message: msg };
});
ipcMain.handle('hive:addTask', (_evt, task: unknown) => {
  if (!task || typeof task !== 'object' || Array.isArray(task)
    || typeof (task as { id?: unknown }).id !== 'string') {
    return { ok: false, error: 'invalid task' };
  }
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  return { ok: hive.addTask(task as HiveTask) };
});
ipcMain.handle('hive:patchTask', (_evt, id: unknown, patch: unknown) => {
  if (typeof id !== 'string' || !id || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'invalid task patch' };
  }
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  return { ok: hive.patchTask(id, patch as Partial<Omit<HiveTask, 'id'>>) };
});
ipcMain.handle('hive:deleteTask', (_evt, id: unknown) => {
  if (typeof id !== 'string' || !id) return { ok: false, error: 'invalid task id' };
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  return { ok: hive.deleteTask(id) };
});
ipcMain.handle('hive:setArchived', (_evt, id: unknown, archived: unknown) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  hive.setArchived(id, archived === true);
  return { ok: true };
});
ipcMain.handle('hive:patchAgentRole', (_evt, id: unknown, role: unknown) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  if (typeof role !== 'string') return { ok: false, error: 'invalid role' };
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  return hive.patchAgentRole(id, role);
});

// ─── IPC: Settings hero payload（远程数据，已缓存）─────────────────────────
/** Plan 文案与 sponsor，从仓库获取，以便无需发版即可变更。在到达渲染进程前
 *  于 shared/heroPayload 中校验。 */
ipcMain.handle('hero:payload', async (_evt, force: unknown) =>
  loadHero(join(app.getPath('userData'), 'hero.json'), { force: force === true }));

// ─── IPC: skills（本地安装 + 可浏览的目录）────────────────────────────────
/** 本机 CLI 已能使用的 skills。扫描已注册仓库外加 agent 自己的 cwd，因此
 *  项目级 skill 会在其适用处出现。 */
ipcMain.handle('skills:local', (_evt, cwd: unknown): LocalSkill[] => {
  const cfg = readConfig();
  const cwds = [
    ...(typeof cwd === 'string' && cwd ? [cwd] : []),
    ...(cfg.registeredRepos ?? [])
  ];
  try {
    return listLocalSkills({ cwds, bundledDir: skillsResourceDir() });
  } catch (e) {
    console.error('[skills] local scan failed:', e);
    return [];
  }
});
/** skills 目录，从 README 解析并缓存在 userData。
 *  `force` 是显式刷新按钮；其余都从一天前的缓存提供，打开标签页因此从不
 *  等待网络。 */
ipcMain.handle('skills:catalog', async (_evt, force: unknown) => {
  const cachePath = join(app.getPath('userData'), 'skill-catalog.json');
  return loadCatalog(cachePath, { force: force === true });
});

/** 把一个目录 skill 安装进 ~/.claude/skills。结构化拒绝而非抛异常：
 *  UI 得以区分「无法安装」与「安装失败」。 */
ipcMain.handle('skills:install', async (_evt, url: unknown, name: unknown) => {
  if (typeof url !== 'string' || typeof name !== 'string') {
    return { ok: false as const, error: 'bad request' };
  }
  return installSkill(url, name);
});
/** 删除一个已安装的 skill。护栏在 uninstallSkill 里——它拒绝任何无法证明是
 *  某个 skills 根目录内 skill 文件夹的路径。 */
ipcMain.handle('skills:uninstall', (_evt, path: unknown) => {
  if (typeof path !== 'string') return { ok: false as const, error: 'bad request' };
  const cfg = readConfig();
  return uninstallSkill(path, { cwds: cfg.registeredRepos ?? [] });
});
/** 在磁盘上揭示一个 skill。`openExternal` 刻意只允许 https，因此 file:// URL
 *  无法（也不应该）借它偷渡。 */
ipcMain.handle('skills:reveal', (_evt, path: unknown) => {
  if (typeof path !== 'string' || !path.trim()) return { ok: false, error: 'bad request' };
  const skillRoots = [join(homedir(), '.claude', 'skills')];
  const target = resolve(path);
  const inRoot = skillRoots.some((r) => target.startsWith(resolve(r) + sep))
    || (readConfig().registeredRepos ?? []).some((c) => target.startsWith(resolve(c) + sep));
  if (!inRoot) return { ok: false, error: 'outside a managed skills directory' };
  shell.showItemInFolder(target);
  return { ok: true };
});

// ─── IPC: setup catalog（本机实际装了哪些外部工具）────────────────────────
/**
 * 针对本机探测目录中的每一行。
 *
 * 存在性是一次 PATH 解析，而非 spawn：为读 --version 而运行每个候选，等于每次
 * 打开面板都要发起十几个进程启动，而且其中好几个 CLI 裸调用会启动 TUI。
 * `resolveCommand` 找不到时原样返回输入，所以「解析到真实存在的路径、而不是
 * 只有裸名字」就是找到的判据。
 *
 * mempalace 是唯一不来自 PATH 的行：memory 子系统已经解析过它（包括 PATH 对
 * Finder 启动的应用可能不携带的 uv/pip 位置），并且知道 palace 是否已初始化，
 * 因此这里以其为准直接复用，而不是用另一种方式重新探测。
 */
ipcMain.handle('tools:status', (): ToolStatus[] => {
  const win = process.platform === 'win32';
  const mem = (() => { try { memory.resetBinCache(); return memory.status(); } catch { return null; } })();
  return toolCatalog().map((spec): ToolStatus => {
    const installCommand = win ? spec.install.win32 : spec.install.posix;
    if (spec.id === 'mempalace') {
      return {
        ...spec,
        installCommand,
        found: !!mem?.available,
        path: mem?.bin ?? null,
        detail: mem?.available
          ? (mem.initialized ? 'palace initialised' : 'installed — palace not built yet')
          : undefined
      };
    }
    if (!spec.bin) return { ...spec, installCommand, found: false, path: null };
    let path: string | null = null;
    try {
      const resolved = resolveCliCommand(spec.bin);
      if (resolved !== spec.bin && existsSync(resolved)) path = resolved;
    } catch { /* 探测绝不能拖垮面板 */ }
    return { ...spec, installCommand, found: !!path, path };
  });
});

// ─── IPC: semantic memory（MemPalace CLI）───────────────────────────────────
// refresh() = resetBinCache + 幂等 start()。轮询是唯一能可靠察觉 mempalace
// 在启动后被安装的机制，因此由它来武装 boot 的 start() 不得不跳过的 mine
// 循环——否则那个状态点会一直显示 "getting ready" 直到应用重启。
ipcMain.handle('hive:memoryStatus', () => memory.refresh());
ipcMain.handle('hive:searchMemory', (_evt, query: unknown, wing: unknown) => {
  if (typeof query !== 'string' || !query.trim()) return { ok: false, output: '', error: 'empty query' };
  return memory.search(query, { wing: typeof wing === 'string' ? wing : undefined });
});
ipcMain.handle('hive:memoryWakeUp', (_evt, wing: unknown) =>
  memory.wakeUp(typeof wing === 'string' ? wing : undefined));
ipcMain.handle('hive:mineNow', () => { memory.mineNow(); return { ok: true }; });
// 按需压缩 memory.md：显式 id 压缩那一个 agent（跳过大小触发——「立即压缩」
// 按钮）；无 id 则运行完整阈值扫描。
ipcMain.handle('memory:reflectNow', (_evt, id: unknown) =>
  reflector.reflectNow(typeof id === 'string' && id ? id : undefined));

// ─── IPC: enterprise Knowledge Graph（面向 agent 的多模态上下文）────────────
ipcMain.handle('kg:status', () => knowledge.status());
ipcMain.handle('kg:list', () => knowledge.list());
ipcMain.handle('kg:search', (_evt, query: unknown, limit: unknown) => {
  if (typeof query !== 'string' || !query.trim()) return [];
  return knowledge.search(query, typeof limit === 'number' ? limit : undefined);
});
ipcMain.handle('kg:get', (_evt, id: unknown) =>
  (typeof id === 'string' && id ? knowledge.get(id) : null));
ipcMain.handle('kg:remove', (_evt, id: unknown) =>
  ({ ok: typeof id === 'string' && id ? knowledge.remove(id) : false }));
// 从磁盘摄取一个或多个文件。逐文件尽力而为；返回逐文件结果，UI 因此能
// 报告部分成功。
ipcMain.handle('kg:ingestFiles', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { paths?: unknown; tags?: unknown };
  const paths = Array.isArray(p.paths) ? p.paths.filter((x): x is string => typeof x === 'string') : [];
  const tags = Array.isArray(p.tags) ? p.tags.filter((x): x is string => typeof x === 'string') : undefined;
  const results = paths.map((srcPath) => {
    try {
      const r = knowledge.ingestFile(srcPath, { tags });
      return { ok: true as const, srcPath, docId: r.docId, chunkCount: r.chunkCount };
    } catch (e) {
      return { ok: false as const, srcPath, error: e instanceof Error ? e.message : String(e) };
    }
  });
  return { results };
});
// 打开一个多文件选择器，并在一次往返中摄取所选工件。
ipcMain.handle('kg:addFiles', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return { ok: false as const, error: 'no window' };
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    title: l10n('Add documents to the Knowledge Graph', '向知识图谱添加文档')
  });
  if (res.canceled || res.filePaths.length === 0) return { ok: false as const, error: 'cancelled' };
  const results = res.filePaths.map((srcPath) => {
    try {
      const r = knowledge.ingestFile(srcPath);
      return { ok: true as const, srcPath, docId: r.docId, chunkCount: r.chunkCount };
    } catch (e) {
      return { ok: false as const, srcPath, error: e instanceof Error ? e.message : String(e) };
    }
  });
  return { ok: true as const, results };
});

// ─── IPC: composer 附件（图片 + 任意文件，按 PATH 附加）────────────────────
// 消息队列把原始文本送进 Claude CLI PTY，因此附件以文件 PATH 随行，agent 用
// 其 Read 工具读取（与 Slack 同约定）。选择器提供 Images 组 + All Files。
ipcMain.handle('dialog:attachFiles', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return { ok: false as const, error: 'no window' };
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    title: l10n('Attach images or files', '附加图片或文件'),
    filters: [
      { name: l10n('Images', '图片'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'tiff', 'avif'] },
      { name: l10n('All Files', '所有文件'), extensions: ['*'] }
    ]
  });
  if (res.canceled || res.filePaths.length === 0) return { ok: false as const, error: 'cancelled' };
  return { ok: true as const, files: res.filePaths.map((p) => ({ path: p, name: basename(p) })) };
});

// 把当前系统剪贴板图片持久化为临时 PNG，让粘贴的截图可以按 PATH 附加。
// 剪贴板没有图片时（例如普通文本粘贴）返回错误结果。
ipcMain.handle('clipboard:saveImage', async () => {
  try {
    const img = clipboard.readImage();
    if (img.isEmpty()) return { ok: false as const, error: 'no image in clipboard' };
    const dir = join(app.getPath('temp'), 'cth-pastes');
    mkdirSync(dir, { recursive: true });
    const name = `paste-${Date.now()}.png`;
    const dest = join(dir, name);
    writeFileSync(dest, img.toPNG());
    return { ok: true as const, file: { path: dest, name } };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
});

// ─── IPC: command history（SQLite——提交给 agent 的每条提示）─────────────────
ipcMain.handle('history:add', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { agentId?: unknown; cwd?: unknown; text?: unknown };
  if (typeof p.agentId !== 'string' || typeof p.text !== 'string') return { ok: false, error: 'invalid args' };
  try {
    persist.addHistory({ agentId: p.agentId, cwd: typeof p.cwd === 'string' ? p.cwd : null, text: p.text });
    return { ok: true };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
ipcMain.handle('history:list', (_evt, agentId: unknown, limit: unknown) =>
  persist.listHistory(
    typeof agentId === 'string' && agentId ? agentId : undefined,
    typeof limit === 'number' ? limit : undefined
  ));
ipcMain.handle('history:search', (_evt, query: unknown, limit: unknown) =>
  persist.searchHistory(typeof query === 'string' ? query : '', typeof limit === 'number' ? limit : undefined));

// ─── IPC: 退出确认 ────────────────────────────────────────────────────────
/** 拆除 harness 并退出。被硬「kill all & quit」路径与 closing-time 收尾
 *  （god 确认楼层已保存之后）共用。 */
function teardownAndQuit(): void {
  allowQuit = true;
  // 每个拆除步骤都是尽力而为：这里抛出的异常（例如垂死的子进程或拆到一半的
  // socket）绝不能中止退出或弹出崩溃对话框。
  try { clearMissionTimers(); } catch (e) { console.error('[quit] clearMissionTimers:', e); }
  try { clearContextTimers(); } catch (e) { console.error('[quit] clearContextTimers:', e); }
  try { stopWebhookDoneObserver(); } catch (e) { console.error('[quit] stopWebhookDoneObserver:', e); }
  try { stopEphemeralWorkerWatcher(); } catch (e) { console.error('[quit] stopWorkerWatcher:', e); }
  try { integrationBroker.stop(); } catch (e) { console.error('[quit] broker.stop:', e); }
  try { hive.stopRouter(); } catch (e) { console.error('[quit] stopRouter:', e); }
  try { hookServer.stop(); } catch (e) { console.error('[quit] hookServer.stop:', e); }
  try { telemetry.stop(); } catch (e) { console.error('[quit] telemetry.stop:', e); }
  try { stopSlackServer(); } catch (e) { console.error('[quit] slack.stop:', e); }
  try { stopWebhookServer(); } catch (e) { console.error('[quit] webhook.stop:', e); }
  try { memory.stop(); } catch (e) { console.error('[quit] memory.stop:', e); }
  try { reflector.stop(); } catch (e) { console.error('[quit] reflector.stop:', e); }
  try { persist.close(); } catch (e) { console.error('[quit] persist.close:', e); }
  try { hive.stopAllProxyBridges(); } catch (e) { console.error('[quit] stopAllProxyBridges:', e); }
  try { ptyManager.killAll(); } catch (e) { console.error('[quit] killAll:', e); }
  app.quit();
}
ipcMain.handle('app:confirmClose', () => {
  closingTime.cancel(); // 硬退出会覆盖正在进行的 closing time
  teardownAndQuit();
});
ipcMain.handle('app:cancelClose', () => {
  // 模态框在渲染进程侧关闭。main 在这里对任何人只欠一个真相：关于
  // restart-to-install——如果这次退出就是其中的一次，它刚刚被取消，而等待它
  // 的人需要听到这一点，而不是永远被禁用、傻等一个不会死掉的进程。
  abortPendingRestart();
});

// 打开一个新楼层（独立办公室窗口）。由 openFloor() 内的 multiWindow 标志
// 门控；返回是否已打开窗口，渲染进程按钮据此反映可用性。应用菜单的
// "New Floor" 项直接调用 openFloor()。
ipcMain.handle('window:newFloor', () => {
  const win = openFloor();
  return { ok: win != null };
});

// ─── IPC: closing time（优雅、不丢数据的关机）───────────────────────────────
// 第三个退出对话框按钮。god 广播 closing time，每个 worker 保存记忆并 ACK，
// god 以 CLOSING-TIME-COMPLETE 收尾——只有到那时 harness 才拆除。协议见
// closingTime.ts。
const closingTime = new ClosingTimeController(
  hive,
  // roster 来源：此刻持有存活 PTY 的 agent（ptyToAgent 在每次拆除时清理）。
  // 单看 registry 会把硬退出结束的会话里那些 ghost worker 也算进来——它们
  // 从未被归档，也永远无法 ACK。
  () => [...new Set(ptyToAgent.values())],
  () => liveWebContents(),
  () => teardownAndQuit(),
  // #7C.2 steering——那种能在深度忙碌的 agent 到达下一个 hook 边界时触达它、
  // 而不是等一个 Stop 的优雅中断。
  control
);
hive.setRoutedObserver((msg, targets) => closingTime.onRouted(msg, targets));
ipcMain.handle('app:startClosingTime', () => closingTime.start());
ipcMain.handle('app:cancelClosingTime', () => closingTime.cancel());

// ─── IPC: full reset（清除数据 + 配置，重启进入 onboarding）───────────────
ipcMain.handle('app:resetAll', () => {
  allowQuit = true;
  // 先拆除一切，这样就不会有任何东西写回我们要清空的目录。
  try { clearMissionTimers(); } catch (e) { console.error('[reset] clearMissionTimers:', e); }
  try { clearContextTimers(); } catch (e) { console.error('[reset] clearContextTimers:', e); }
  try { stopWebhookDoneObserver(); } catch (e) { console.error('[reset] stopWebhookDoneObserver:', e); }
  try { stopEphemeralWorkerWatcher(); } catch (e) { console.error('[reset] stopWorkerWatcher:', e); }
  try { integrationBroker.stop(); } catch (e) { console.error('[reset] broker.stop:', e); }
  try { hive.stopRouter(); } catch (e) { console.error('[reset] stopRouter:', e); }
  try { hookServer.stop(); } catch (e) { console.error('[reset] hookServer.stop:', e); }
  try { telemetry.stop(); } catch (e) { console.error('[reset] telemetry.stop:', e); }
  try { stopSlackServer(); } catch (e) { console.error('[reset] slack.stop:', e); }
  try { memory.stop(); } catch (e) { console.error('[reset] memory.stop:', e); }
  try { reflector.stop(); } catch (e) { console.error('[reset] reflector.stop:', e); }
  try { persist.close(); } catch (e) { console.error('[reset] persist.close:', e); }
  try { ptyManager.killAll(); } catch (e) { console.error('[reset] killAll:', e); }
  try { hive.removeExposedCodexData(); } catch (e) { console.error('[reset] removeExposedCodexData:', e); }
  // 抹除 hive（Michael 与每个 agent 的 memory、inbox、tasks、board、git 历史）
  // 以及语义记忆 palace。只移除这些由 harness 创建的子目录——绝不动用户整个
  // harnessHome 文件夹。
  for (const dir of [hive.root(), memory.palacePath()]) {
    if (!dir) continue;
    try { rmSync(dir, { recursive: true, force: true }); }
    catch (e) { console.error('[reset] rm', dir, e); }
  }
  // roster 是同一状态的渲染进程半边，因此它随 hive 一起退役——归档到
  // roster-backups/ 而不是删除，并清空为活动文件，这样之后重新选择该文件夹
  // 不会复活那些会话与记忆都已消失的 agent。
  try { roster.archive(); }
  catch (e) { console.error('[reset] roster.archive:', e); }
  // 回到首次运行默认值，然后干净地重启，让所有内存中的服务从零重新引导，
  // 渲染进程落到 onboarding。
  resetConfig();
  app.relaunch();
  app.exit(0);
});

// ─── IPC: token telemetry（CC transcript 的真实用量 + 估算成本）─────────────
// Reconciler/fallback 路径：按 cwd 汇总 transcript，现在按 MODEL 计价（cost
// bug #1 已在 pricing.ts 修复）。为与既有 UsageRow 向后兼容而保留。
ipcMain.handle('hive:agentUsage', (_evt, cwd: unknown) =>
  typeof cwd === 'string' ? readAgentUsage(cwd) : null);
// agent LIVE 会话的当前上下文大小（tokens）——transcript 路径从 agent 的
// hook 负载习得（SessionStart 在 spawn 时立即触发），因此即使几个 agent 共享
// 同一个 cwd 也能工作。首个 hook 触发前为 null；已知但为空的 transcript 读作
// 0，因此新（重）启动的会话会把仪表清零，而不是留一个过期值在上面。
ipcMain.handle('hive:agentContext', (_evt, agentId: unknown) => {
  if (typeof agentId !== 'string') return null;
  const tp = hookServer.transcriptPath(agentId);
  if (!tp) return null;
  return readContextTokens(tp) ?? 0;
});

// 一个合并的、NON-SENSITIVE 的按-agent 目录，供语音读取层使用
// （Realtime Michael 的 get_agent_detail / list_agents）。一次读取即联接
// 办公室侧栏 + telemetry 对每个 agent 所知的一切：registry 记录
// （name/role/provider/cwd/status/archived/isGod/isAssistant/sessionId/
// cwdValid）、实时 token + breaker + 最近工具 telemetry，以及当前上下文窗口
// 占用。包含 ARCHIVED agent（不同于 heartbeat 的 fleet.json——它只含存活），
// 因此 Michael 能对不活跃 agent 讲话——它们的 cwd 与记忆保持可达。无 PII：
// 机密、env、API keys 不会离开 main；成本以 tokens 承载（外加一个语音层刻意
// 从不提及的 usd 字段）。
ipcMain.handle('hive:agentDirectory', () => {
  if (!hive.enabled()) return { godId: null, agents: [] };
  const reg = hive.registry();
  const snap = telemetry.snapshot();
  const usageById = new Map(snap.usage.map((u) => [u.agentId, u]));
  const now = Date.now();
  const agents = Object.entries(reg.agents).map(([id, a]) => {
    const u = usageById.get(id);
    const spans = snap.spans[id] ?? [];
    const tokens = u ? u.input + u.output + u.cacheRead + u.cacheCreation : 0;
    const ctx = hookServer.contextFor(id);
    return {
      id,
      name: a.name,
      role: a.role ?? (a.isGod ? 'orchestrator' : 'agent'),
      provider: a.provider ?? 'claude',
      model: u?.model ?? null,
      status: a.status ?? 'idle',
      cwd: a.cwd ?? null,
      cwdValid: a.cwdValid ?? null,
      archived: !!a.archived,
      isGod: !!a.isGod,
      isAssistant: !!a.isAssistant,
      sessionId: a.sessionId ?? null,
      hasMemory: hive.hasMemory(id),
      inboxBacklog: hive.inboxBacklog(id),
      breaker: breaker.levelFor(id),
      tokens,
      usd: u ? Number(u.usd.toFixed(4)) : 0,
      lastTool: spans.length ? spans[spans.length - 1].tool : null,
      lastActiveSecAgo: u ? Math.round((now - u.ts) / 1000) : null,
      contextTokens: ctx?.tokens ?? null,
      contextLimit: ctx?.limit ?? null,
      contextPct: ctx && ctx.limit > 0 ? Math.round((ctx.tokens / ctx.limit) * 100) : null
    };
  });
  return { godId: reg.godId, agents };
});

// ─── IPC: live telemetry（OTel collector——被锁定的 usage-provider 接缝）────
// fleet 网格 + span waterfall（#7B）读取这些；Lane A 的 breaker（#6）经 provider
// 在进程内消费 getAgentUsage，而非走 IPC。
ipcMain.handle('telemetry:usage', (_evt, agentId: unknown) =>
  typeof agentId === 'string' ? telemetry.getAgentUsage(agentId) : null);
ipcMain.handle('telemetry:spans', (_evt, agentId: unknown) =>
  typeof agentId === 'string' ? telemetry.getSpans(agentId) : []);
ipcMain.handle('telemetry:snapshot', () => telemetry.snapshot());

// ─── IPC: circuit-breaker state（Lane A #6 策略 → 本 lane 的 avatars/meter）──
// Lane A 的 breaker 以 BreakerState 调用它；我们在 `control:breakerState` 上
// 扇出给渲染进程，avatar 适配器在那里让它优先于 hook 派生的状态
// （#5C looping/zombie）。在此定义是为了让通道在 Jim 的策略落地之前就存在；
// 他生产，本 lane 消费。
ipcMain.handle('control:setBreakerState', (_evt, state: unknown) => {
  try { liveWebContents()?.send('control:breakerState', state); } catch { /* 窗口已拆除 */ }
  return { ok: true };
});

// ─── IPC: operator control over agents（#7C.1–7C.3）─────────────────────────
// 全部返回 agent 最新的 control 快照，UI 因此能反映状态。
ipcMain.handle('control:pause', (_evt, agentId: unknown, on: unknown) => {
  if (typeof agentId !== 'string') return null;
  control.pause(agentId, on === true);
  return control.snapshot(agentId);
});
ipcMain.handle('control:autoDelivery', (_evt, agentId: unknown, paused: unknown) => {
  if (typeof agentId !== 'string') return null;
  const on = paused === true;
  control.pauseAutoDelivery(agentId, on);
  const current = new Set(readConfig().autoDeliveryPausedAgents ?? []);
  if (on) current.add(agentId); else current.delete(agentId);
  writeConfig({ autoDeliveryPausedAgents: Array.from(current).sort() });
  return control.snapshot(agentId);
});
ipcMain.handle('control:resume', (_evt, agentId: unknown) => {
  if (typeof agentId !== 'string') return null;
  control.resume(agentId);
  return control.snapshot(agentId);
});
ipcMain.handle('control:gateTool', (_evt, agentId: unknown, tool: unknown, on: unknown) => {
  if (typeof agentId !== 'string' || typeof tool !== 'string') return null;
  control.gateTool(agentId, tool, on === true);
  return control.snapshot(agentId);
});
ipcMain.handle('control:steer', (_evt, agentId: unknown, text: unknown) => {
  if (typeof agentId !== 'string' || typeof text !== 'string') return null;
  control.steer(agentId, text);
  // 在控制条里输入的一条 steer 是人类消息。在这里、IPC 接缝处统计，刻意不放在
  // control.steer() 内部：closingTime 与语音动作层直接调用它，而两者都不是人
  // 在打字。
  analytics.trackMessageSent('steer');
  return control.snapshot(agentId);
});
ipcMain.handle('control:halt', (_evt, agentId: unknown) => {
  if (typeof agentId !== 'string') return null;
  control.halt(agentId);
  return control.snapshot(agentId);
});
ipcMain.handle('control:snapshot', (_evt, agentId: unknown) =>
  typeof agentId === 'string' ? control.snapshot(agentId) : null);

// ─── IPC: scheduled missions（周期性自动派发）────────────────────────
ipcMain.handle('missions:list', () => readConfig().missions ?? []);
ipcMain.handle('missions:save', (_evt, missions) => {
  // lastFiredAt 归调度器所有。渲染进程只加载一次 missions，之后发回的是过期的
  // 数组，因此整体写入会抹掉调度器此后打上的每一个 lastFiredAt。按 id 合并并
  // 保留较新的 lastFiredAt（几乎总是已持久化的那个），UI 因此永远无法擦掉它。
  const incoming = (Array.isArray(missions) ? missions : []) as ScheduledMission[];
  const persistedById = new Map(
    (readConfig().missions ?? []).map((m) => [m.id, m] as const)
  );
  const merged = incoming.map((m) => {
    const prevLastFired = persistedById.get(m.id)?.lastFiredAt ?? 0;
    const lastFiredAt = Math.max(m.lastFiredAt ?? 0, prevLastFired) || undefined;
    return { ...m, lastFiredAt };
  });
  writeConfig({ missions: merged });
  syncMissions();
  return { ok: true };
});

// ─── IPC: 跨 hive 文件全文搜索（board、tasks、memory）──────────────────────
ipcMain.handle('hive:textSearch', (_evt, query: unknown) => {
  if (typeof query !== 'string' || !query.trim()) return { ok: false, results: [] };
  const root = hive.root();
  if (!root) return { ok: false, results: [] };
  const q = query.toLowerCase();
  const results: Array<{ source: string; excerpt: string }> = [];
  // 每个目标文件是（path, 可读标签）。agents/<id>/memory.md 在下方展开。
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
      // 匹配处两侧各约 40 个字符的上下文。
      const excerpt = line.slice(Math.max(0, idx - 40), idx + q.length + 40).trim();
      results.push({ source, excerpt });
      hits++;
    }
  }
  return { ok: true, results };
});

// ─── IPC: GitHub issue 摄取（gh CLI）───────────────────────────────────
ipcMain.handle('github:issues', (_evt, cwd: unknown) =>
  typeof cwd === 'string' ? listIssues(cwd) : { ok: false, error: 'no cwd' }
);

// ─── IPC: GitHub CI 状态监听（gh CLI）─────────────────────────────────
ipcMain.handle('github:ciRuns', (_evt, cwd: unknown) =>
  typeof cwd === 'string' ? listCIRuns(cwd) : { ok: false, error: 'no cwd' }
);

// ─── IPC: 桌面通知开关 ─────────────────────────────────────────────────
ipcMain.handle('app:setNotifications', (_evt, val) => writeConfig({ notifications: val === true }));

// ─── IPC: onboarding 可靠性——打开 Settings 深链 + login-item 切换 ──────────
/** 在系统默认处理器中打开一个 System Settings 深链（或 https URL）。
 *  限定 Settings 面板 / https，渲染进程因此无法执行任意 scheme。用于 onboarding
 *  的「Permissions & reliability」步骤。 */
ipcMain.handle('app:openExternal', async (_evt, url: unknown) => {
  if (typeof url !== 'string' || !/^(x-apple\.systempreferences:|https:\/\/)/.test(url)) {
    return { ok: false, error: 'blocked url' };
  }
  await shell.openExternal(url);
  return { ok: true };
});
/** 切换 macOS「Open at Login」——完全编程式，无权限提示。
 *  返回结果状态，渲染进程开关因此反映现实。 */
ipcMain.handle('app:setLoginItem', (_evt, enabled: unknown) => {
  app.setLoginItemSettings({ openAtLogin: enabled === true });
  return app.getLoginItemSettings().openAtLogin;
});

// ─── IPC: Slack 集成 ───────────────────────────────────────────────────────
ipcMain.handle('slack:start', () => startSlackServer());
ipcMain.handle('slack:stop', () => { stopSlackServer(); return { ok: true }; });
/** 当前连接状态 + 最近一次 Request URL——让 Settings 填充「Connected」徽章，
 *  并在重开时重新显示持久化的隧道 URL。 */
ipcMain.handle('slack:status', () => ({ running: slackServer != null, url: lastSlackUrl }));
/** 捆绑的回复助手的绝对路径，供办公室 worker 运行以把摘要发回线程内。
 *  没有机密跨越此边界。 */
ipcMain.handle('slack:replyScriptPath', () => slackReplyScriptPath());
/** 渲染进程立即发回触发线程的「queued」确认。机器人 token 留在 main——
 *  只有 channel/thread/text 跨过 IPC。 */
ipcMain.handle('slack:reply', (_evt, arg: unknown) => {
  const p = (arg ?? {}) as { channel?: unknown; thread_ts?: unknown; text?: unknown };
  const cfg = readConfig();
  // CLAUSE-3（人类：「默认不要往 Slack 发帖」）：这是唯一的 app/voice 主动发起的
  // Slack 帖子（渲染进程的「queued」确认）。除非用户在 Settings → Slack 里选择
  // 开启，否则保持关闭。Slack 来源的 done-reply 往返（done-poller）以及 agent
  // 自己的直接 /reply 不经过这里，因此它们不受影响、始终开启。
  if (!cfg.slackProactivePosting) return { ok: false, error: 'app-initiated Slack posting disabled (enable in Settings → Slack)' };
  const botToken = cfg.slackBotToken;
  if (!botToken) return { ok: false, error: 'no bot token' };
  if (typeof p.channel !== 'string' || typeof p.thread_ts !== 'string' || typeof p.text !== 'string') {
    return { ok: false, error: 'channel, thread_ts, text required' };
  }
  // CLAUSE-1（fix-slack-integration）：app 发起的发送必须指向显式线程——拒绝
  // 空白/纯空白的 channel 或 thread，而不是让它落到隐式目标（channel 根）。
  if (!p.channel.trim() || !p.thread_ts.trim()) {
    return { ok: false, error: 'explicit channel + thread_ts required' };
  }
  return postSlackReply({ botToken, channel: p.channel, thread_ts: p.thread_ts, text: p.text });
});
ipcMain.handle('slack:setConfig', (_evt, patch: unknown) => {
  const p = (patch ?? {}) as {
    signingSecret?: unknown; botToken?: unknown; channelId?: unknown; port?: unknown; enabled?: unknown;
    proactivePosting?: unknown;
  };
  const next: Partial<HarnessConfig> = {};
  // 裁剪字符串字段；被清空的字段回到 undefined。
  if (typeof p.signingSecret === 'string') next.slackSigningSecret = p.signingSecret.trim() || undefined;
  if (typeof p.botToken === 'string') next.slackBotToken = p.botToken.trim() || undefined;
  if (typeof p.channelId === 'string') next.slackChannelId = p.channelId.trim() || undefined;
  if (typeof p.port === 'number' && Number.isFinite(p.port)) next.slackPort = p.port;
  if (typeof p.enabled === 'boolean') next.slackEnabled = p.enabled;
  if (typeof p.proactivePosting === 'boolean') next.slackProactivePosting = p.proactivePosting;
  writeConfig(next);
  // 协调运行中的服务器：禁用（或清空 secret）会停止它。此处刻意不自动（重新）
  // 启动——用户在 Settings 里按 Start 以获取全新的（临时）隧道 URL。
  const cfg = readConfig();
  if (!cfg.slackEnabled || !cfg.slackSigningSecret) stopSlackServer();
  return { ok: true };
});

// ─── IPC: Triggers——context（auto-compact / auto-clear）─────────────────────
ipcMain.handle('triggers:getContext', () => readConfig().contextTrigger ?? DEFAULT_CONTEXT_TRIGGER);
ipcMain.handle('triggers:setContext', (_evt, arg: unknown) => {
  const current = readConfig().contextTrigger ?? DEFAULT_CONTEXT_TRIGGER;
  const p = (arg ?? {}) as Partial<ContextTriggerConfig>;
  const next: ContextTriggerConfig = {
    compact: sanitizeContextRule(p.compact, current.compact),
    clear: sanitizeContextRule(p.clear, current.clear)
  };
  writeConfig({ contextTrigger: next });
  // 定时器本身就是设置——保存了节奏却没有重新武装，就会一直按旧节奏触发
  // 直到下次启动。
  syncContextTriggers();
  return next;
});

/** 钳制 context trigger 的一半。渲染进程不得参与武装计算：零/负/NaN 的
 *  `everyMs` 会武装一个失控的定时器，而越界的百分比会静默禁用（或永久触发）
 *  压力闸门。 */
function sanitizeContextRule(patch: Partial<ContextRule> | undefined, current: ContextRule): ContextRule {
  const p = (patch ?? {}) as Partial<ContextRule>;
  const num = (v: unknown, fallback: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : current.enabled,
    everyMs: num(p.everyMs, current.everyMs, 60_000, 86_400_000),
    minContextPct: num(p.minContextPct, current.minContextPct, 0, 100),
    minContextPctLargeWindow: num(p.minContextPctLargeWindow, current.minContextPctLargeWindow, 0, 100),
    message: typeof p.message === 'string' ? p.message : current.message
  };
}

// ─── IPC: Triggers——webhooks（多端点、单服务器、单隧道）────────────────────
ipcMain.handle('webhooks:list', () => readConfig().webhookTriggers ?? []);
ipcMain.handle('webhooks:save', (_evt, arg: unknown) => {
  const incoming = Array.isArray(arg) ? arg : [];
  const existing = readConfig().webhookTriggers ?? [];
  const list: WebhookTrigger[] = [];
  const seen = new Set<string>();
  for (const raw of incoming) {
    const t = sanitizeWebhookTrigger(raw, existing);
    if (!t || seen.has(t.id)) continue; // id 是 URL 路径段——每个 id 只有一个所有者
    seen.add(t.id);
    list.push(t);
  }
  writeConfig({ webhookTriggers: list });
  reconcileWebhookServer();
  return list;
});
ipcMain.handle('webhooks:delete', (_evt, arg: unknown) => {
  const id = typeof arg === 'string' ? arg : '';
  const list = (readConfig().webhookTriggers ?? []).filter((t) => t.id !== id);
  writeConfig({ webhookTriggers: list });
  // 撤销一个端点不得打扰其他端点：在线服务器被重新指向而非重启，因此其余
  // 调用方的 URL 继续工作。
  reconcileWebhookServer();
  return list;
});
/** 为操作者铸一枚强（256 位）secret，供其粘贴进调用方。
 *  此处不持久化——它属于 UI 保存到的那个端点。 */
ipcMain.handle('webhooks:generateSecret', () => randomBytes(32).toString('hex'));
/** 服务器状态 + 隧道根 + 每个已配置端点一个公开 URL（UI 对每个 webhook
 *  提供复制按钮，因此单有根不够）。 */
ipcMain.handle('webhooks:status', () => ({
  running: webhookServer != null,
  url: lastWebhookUrl,
  endpoints: webhookEndpointUrls()
}));

/** 规范化一个从渲染进程回来的端点。未知/空字段回退到已持久化的值，因此
 *  往返部分填充行的 UI 永远无法清空一个活的 secret 或静默放宽某种模式。 */
function sanitizeWebhookTrigger(raw: unknown, existing: WebhookTrigger[]): WebhookTrigger | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<WebhookTrigger>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  // 该 id 会被拼进一个公开 URL 路径。限制为朴素的字符集，而不是事后转义：
  // 无斜杠（会伪造嵌套路由）、无编码穿越、没有任何能让两个端点互为别名的
  // 内容。
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) return null;
  const prior = existing.find((t) => t.id === id);
  const secret = typeof r.secret === 'string' && r.secret.trim() ? r.secret.trim() : prior?.secret ?? '';
  const mode = isTriggerMode(r.mode) ? r.mode : prior?.mode ?? DEFAULT_TRIGGER_MODE;
  return {
    id,
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : prior?.name ?? id,
    secret,
    // 没有 secret 的端点永远无法启用——那会是一扇敞开的大门。
    enabled: secret ? (typeof r.enabled === 'boolean' ? r.enabled : prior?.enabled ?? false) : false,
    mode,
    schema: typeof r.schema === 'string' && r.schema.trim() ? r.schema : prior?.schema ?? DEFAULT_WEBHOOK_SCHEMA,
    createdAt: typeof r.createdAt === 'number' && r.createdAt > 0 ? r.createdAt : prior?.createdAt ?? Date.now()
  };
}

function isTriggerMode(v: unknown): v is TriggerMode {
  return v === 'strict' || v === 'allow-all' || v === 'communication-only';
}

// ─── IPC: Triggers——organisation（仅持久化；尚无传输）──────────────────────
ipcMain.handle('org:getTrigger', () => readConfig().orgTrigger ?? DEFAULT_ORG_TRIGGER);
ipcMain.handle('org:setTrigger', (_evt, arg: unknown) => {
  const current = readConfig().orgTrigger ?? DEFAULT_ORG_TRIGGER;
  const p = (arg ?? {}) as Partial<OrgTriggerConfig>;
  // 仅持久化——对等消息服务还不存在，因此除了显示它的设置界面外，没有人
  // 读取 `apiKey`。刻意没有 start/stop、没有网络、没有任何副作用。
  const next: OrgTriggerConfig = {
    apiKey: typeof p.apiKey === 'string' ? p.apiKey.trim() : current.apiKey,
    enabled: typeof p.enabled === 'boolean' ? p.enabled : current.enabled,
    mode: isTriggerMode(p.mode) ? p.mode : current.mode
  };
  writeConfig({ orgTrigger: next });
  return next;
});

// ─── IPC: Triggers——history ledger + approval gate───────────────────────────
ipcMain.handle('triggerHistory:list', () => listTriggerHistory());
ipcMain.handle('triggerHistory:clear', (_evt, arg: unknown) => {
  const source = arg === 'webhook' || arg === 'org' ? arg : undefined;
  clearTriggerHistory(source);
  pruneHeldTokens();
  notifyTriggerHistoryUpdated();
  return { ok: true };
});
/**
 * 操作者对一个被扣住消息的裁决。
 *
 * 'approved' 释放它：它走一条自动放行消息本会走的完全相同的路径（card + god
 * request），然后条目翻转。'rejected' 只是翻转——什么都不会被派发。
 *
 * 构造上幂等：只有仍停在 `pending` 的条目可以被裁决，因此双击（或两个窗口
 * 同时裁决）无法把同一条消息派发两次。
 */
ipcMain.handle('triggerHistory:decide', (_evt, arg: unknown) => {
  const p = (arg ?? {}) as { id?: unknown; decision?: unknown };
  const id = typeof p.id === 'string' ? p.id : '';
  const decision = p.decision === 'approved' ? 'approved' : p.decision === 'rejected' ? 'rejected' : null;
  if (!id || !decision) return null;
  const entry: TriggerHistoryEntry | undefined = listTriggerHistory().find((e) => e.id === id);
  if (!entry) return null;
  if (entry.decision !== 'pending') return entry; // 已裁决 → 空操作，而非重新派发

  if (decision === 'rejected') {
    const next = updateTriggerHistory(id, { decision: 'rejected' });
    notifyTriggerHistoryUpdated();
    return next;
  }

  const taskId = `webhook-${randomBytes(8).toString('hex')}`;
  const tokenHash = heldTokenHashFor(id);
  const title = entry.title ?? (entry.body.length > 80 ? `${entry.body.slice(0, 79)}…` : entry.body);
  if (!dispatchWebhookWork({ taskId, title, message: entry.body, tokenHash, origin: entry.source })) {
    // card 是调用方轮询、也是 god 据以工作的东西。让条目保持 pending，这样
    // 一旦 hive 可写，操作者就能再次批准。
    return entry;
  }
  // hash 现在在 card 上，因此调用方的 GET 从此刻起经由正常的任务查找解析。
  if (tokenHash) { heldTokens().delete(tokenHash); persistHeldTokens(); }
  const next = updateTriggerHistory(id, { decision: 'approved', taskId });
  pruneHeldTokens();
  notifyTriggerHistoryUpdated();
  return next;
});

// ─── IPC: Generic webhook（LEGACY 单端点通道）───────────────────────────────
// 为 Settings → Webhook 而保留，它仍使用单 secret 形态。它们现在是多端点引擎
// 之上的薄垫片：遗留 secret 与 enabled 标志映射到配置迁移创建的 `legacy`
// WebhookTrigger，因此两个界面永远不会对端点是否在线产生分歧。
ipcMain.handle('webhook:start', () => startWebhookServer());
ipcMain.handle('webhook:stop', () => { stopWebhookServer(); return { ok: true }; });
/** 当前状态 + 最近一个公开端点 URL，供 Settings 徽章/URL 字段使用。 */
ipcMain.handle('webhook:status', () => ({ running: webhookServer != null, url: lastWebhookUrl }));
/** 铸一枚强（256 位）secret、持久化并返回，以便 Settings 展示给用户复制进
 *  客户端。之前的 secret 被替换。 */
ipcMain.handle('webhook:generateSecret', () => {
  const secret = randomBytes(32).toString('hex');
  writeConfig({ webhookSecret: secret });
  upsertLegacyWebhookTrigger({ secret });
  return { ok: true, secret };
});
ipcMain.handle('webhook:setConfig', (_evt, patch: unknown) => {
  const p = (patch ?? {}) as { secret?: unknown; port?: unknown; enabled?: unknown };
  const next: Partial<HarnessConfig> = {};
  if (typeof p.secret === 'string') next.webhookSecret = p.secret.trim() || undefined;
  if (typeof p.port === 'number' && Number.isFinite(p.port)) next.webhookPort = p.port;
  if (typeof p.enabled === 'boolean') next.webhookEnabled = p.enabled;
  writeConfig(next);
  upsertLegacyWebhookTrigger({
    secret: typeof p.secret === 'string' ? p.secret.trim() : undefined,
    enabled: typeof p.enabled === 'boolean' ? p.enabled : undefined
  });
  // 禁用（或清空 secret）会立即停止公开面；reconcile 也接手其他端点仍启用
  // 的情形——此时服务器继续运行，只是少掉 legacy 那一个。
  reconcileWebhookServer();
  return { ok: true };
});

/** 把一次遗留的 `webhook:setConfig` / `webhook:generateSecret` 编辑镜像到
 *  `legacy` WebhookTrigger。只在 secret 存在后才创建该行——没有 secret 的
 *  启用端点等于敞开的大门，因此对从未配置过的 webhook 做裸「enable」刻意是
 *  空操作。 */
function upsertLegacyWebhookTrigger(patch: { secret?: string; enabled?: boolean }): void {
  const list = readConfig().webhookTriggers ?? [];
  const prior = list.find((t) => t.id === 'legacy');
  const secret = patch.secret !== undefined ? patch.secret : prior?.secret ?? '';
  if (!secret) return;
  const row: WebhookTrigger = {
    id: 'legacy',
    name: prior?.name ?? 'Default webhook',
    secret,
    enabled: patch.enabled !== undefined ? patch.enabled : prior?.enabled ?? false,
    mode: prior?.mode ?? DEFAULT_TRIGGER_MODE,
    schema: prior?.schema ?? DEFAULT_WEBHOOK_SCHEMA,
    createdAt: prior?.createdAt ?? Date.now()
  };
  writeConfig({
    webhookTriggers: prior ? list.map((t) => (t.id === 'legacy' ? row : t)) : [...list, row]
  });
}

// ─── IPC: Free Flow（语音听写 → 消息队列）──────────────────────────────────
// 入口 B 是按住 Option 说话，完全在渲染进程处理（捕获阶段按键监听）——这里
// 没有 globalShortcut。macOS 不把 Fn 键交给 Electron（electron#16714），而忠实的
// 原生 Fn 助手（CGEventTap）被推迟；按住 Option 是人类选择的 v1 激活方式。

ipcMain.handle('freeflow:setConfig', (_evt, patch: unknown) => {
  const p = (patch ?? {}) as { enabled?: unknown; apiKey?: unknown; model?: unknown };
  const next: Partial<HarnessConfig> = {};
  if (typeof p.enabled === 'boolean') next.freeflowEnabled = p.enabled;
  // 裁剪字符串字段；被清空的键回到 undefined。
  if (typeof p.apiKey === 'string') next.groqApiKey = p.apiKey.trim() || undefined;
  if (typeof p.model === 'string') next.freeflowModel = p.model.trim() || DEFAULT_GROQ_MODEL;
  writeConfig(next);
  return { ok: true };
});

/** 通过 Groq 转写一段捕获的音频。由标志 + 存在 key 门控，因此被禁用的功能
 *  永远无法触达网络。Groq key 留在 main——入站只有音频字节跨过 IPC，出站只有
 *  transcript。 */
ipcMain.handle('freeflow:transcribe', async (_evt, arg: unknown) => {
  const cfg = readConfig();
  if (!cfg.freeflowEnabled) return { ok: false, error: 'Free Flow is disabled' };
  if (!cfg.groqApiKey) return { ok: false, error: 'no Groq API key set' };
  const a = (arg ?? {}) as { audio?: unknown; mimeType?: unknown; filename?: unknown; language?: unknown };
  if (!(a.audio instanceof ArrayBuffer) && !(a.audio instanceof Uint8Array)) {
    return { ok: false, error: 'no audio' };
  }
  const out = await transcribeWithGroq({
    apiKey: cfg.groqApiKey,
    audio: a.audio,
    mimeType: typeof a.mimeType === 'string' ? a.mimeType : undefined,
    filename: typeof a.filename === 'string' ? a.filename : undefined,
    model: cfg.freeflowModel || DEFAULT_GROQ_MODEL,
    language: typeof a.language === 'string' && a.language ? a.language : undefined
  });
  if (out.ok) analytics.trackFeature('voice_dictation');
  return out;
});

// ─── IPC: Realtime Michael（语音编排器——临时 token mint，rt-1）──────────────
// MAIN 持有 BYOK OpenAI key（加密 broker，apikey:openai），并铸一枚短命的
// EPHEMERAL 客户端 secret；真实 key 绝不跨过 IPC。所有接线都在 ./realtime 里，
// 因此这里只是一行注册。
registerRealtimeIpc();

// ─── IPC: Realtime Michael voice ACTIONS（rt-5，Phase 2）─────────────────────
// 是对 god PTY 已用的同一批 main 函数的薄适配器。整条安全脊——软 vs 破坏性
// 分级、两步口头回显确认、独立 token 规则、硬允许列表（禁止 kill-god / 批量
// 操作）、以及 michael-voice 归属——都在 ./realtimeActions 里。此处只注入
// 既有函数；不新增任何编排逻辑。
// ─── IPC: Realtime Michael completion watcher（rt-12，Phase 2）───────────────
// Jim 的全新引擎（realtimeCompletionWatcher.ts）检测语音派发的任务完成
// （card→done 或 michael-voice 收件箱里的 done-reply）并 EMITS 它；我拥有这个
// 接缝——注入 hive 读取依赖，把完成事件推给活跃会话（于是 Michael 会主动说出
// 它们），并在 IPC 上桥接 waitFor / queue-drain。
const completionWatcher = initCompletionWatcher({
  readTasks: () => { const t = hive.tasks() as { tasks?: TaskCard[] }; return Array.isArray(t?.tasks) ? t.tasks : []; },
  // 语音派发以 from:michael-voice 发出，因此被指派人的 done-reply 落在这里。
  readInbox: () => {
    // 语音派发以 from:michael-voice 发出，因此 done-reply 通常落进它的收件箱，
    // ——但被指派人可能出于习惯发给 god。合并两个收件箱（按 id 去重），发往
    // god 的完成事件因此也不会漏掉；检测器按发送者过滤。
    try {
      const mv = hive.inbox('michael-voice') as unknown as InboxMessage[];
      const godId = hive.registry().godId;
      const god = godId ? (hive.inbox(godId) as unknown as InboxMessage[]) : [];
      const seen = new Set<string>();
      return [...mv, ...god].filter((m) => !!m?.id && !seen.has(m.id) && seen.add(m.id) !== undefined);
    } catch {
      return [];
    }
  },
  onNotify: (evt) => {
    try {
      if (!Notification.isSupported()) return;
      const reg = hive.registry();
      const title = resolveGodName(reg.agents[reg.godId ?? 'god']?.name);
      new Notification({ title, body: evt.summary }).show();
    } catch { /* 尽力而为 */ }
  }
});

registerRealtimeActionIpc({
  hiveEnabled: () => hive.enabled(),
  hiveSend: (partial, from) => hive.send(partial, from),
  hiveTasks: () => hive.tasks(),
  hiveWriteTasks: (tasks) => hive.writeTasks(tasks),
  hiveRegistry: () => hive.registry(),
  hiveLog: (event) => hive.appendLog(event),
  controlPause: (id, on) => control.pause(id, on),
  controlSteer: (id, text) => control.steer(id, text),
  controlHalt: (id) => control.halt(id),
  controlSnapshot: (id) => control.snapshot(id),
  killAgent: (id) => {
    const r = ptyManager.kill(id);
    teardownPty(id);
    // 语音（MAIN 发起）的 kill：渲染进程没有自己移除卡片（与 UI kill 不同），
    // 所以告诉楼层归档它。镜像 hive:agentSpawned。
    try { liveWebContents()?.send('hive:agentArchived', { id }); } catch { /* 窗口已拆除 */ }
    return r;
  },
  spawnAgent: async (opts) => {
    const o = opts as AgentSpawnOptions;
    const res = await spawnAgentCore(o, null);
    // 渲染进程 roster 只被渲染进程发起的 hiring（AddAgentModal）改变，因此
    // MAIN 发起的 spawn 在广播前对楼层不可见。渲染进程（useHive）用这个
    // 描述符构建 Agent 卡片；addAgent 幂等，因此渲染进程发起的 hire 绝不会
    // 被重复建卡。
    if (res.ok) {
      try {
        liveWebContents()?.send('hive:agentSpawned', {
          id: o.id,
          name: o.hive?.name ?? o.id,
          provider: o.provider ?? o.hive?.provider ?? 'claude',
          cwd: res.worktreePath ?? o.cwd,
          command: o.command,
          role: o.hive?.role,
          worktreePath: res.worktreePath
        });
      } catch { /* 窗口已拆除 */ }
    }
    return res;
  },
  listMissions: () => readConfig().missions ?? [],
  // spec 经 listMissions() 带着 lastFiredAt 一路传来，因此整体写入会保留
  // 调度器的时间戳；edit_schedule 是刻意且罕见的操作。
  saveMissions: (missions) => { writeConfig({ missions }); },
  // rt-12：注册每次语音派发，让 watcher 能检测到它的完成。
  trackDispatch: (d) => { try { completionWatcher.track({ ...d, kind: 'dispatch' }); } catch { /* watcher 不可用 */ } },
  // ── v0.3.4 全权控制扩展 ──
  controlResume: (id) => control.resume(id),
  controlAutoDelivery: (id, paused) => control.pauseAutoDelivery(id, paused),
  controlGateTool: (id, toolName, on) => control.gateTool(id, toolName, on),
  setArchived: (id, archived) => {
    if (!hive.enabled()) return { ok: false, error: 'hive disabled' };
    hive.setArchived(id, archived);
    try { liveWebContents()?.send(archived ? 'hive:agentArchived' : 'hive:agentSpawned', { id }); } catch { /* 窗口已消失 */ }
    return { ok: true };
  },
  // clear_context：把文本交给渲染进程的队列，投递因此借用每道既有闸门
  // （仅空闲、启动宽限、草稿/选择器安全）。
  enqueueToAgent: (id, text) => {
    try { liveWebContents()?.send('realtime:enqueue', { agentId: id, text }); } catch { /* 窗口已消失 */ }
  },
  getConfigValue: (key) => (readConfig() as unknown as Record<string, unknown>)[key],
  patchConfig: (patch) => { writeConfig(patch as Partial<HarnessConfig>); }
});

// rt-12 接缝：把检测到的完成推给活跃楼层；在 IPC 上桥接 live 标志、队列排空
// （关闭会话的暖启动）与 wait_for。然后开始轮询。
completionWatcher.onCompletion((evt) => { try { liveWebContents()?.send('realtime:completion', evt); } catch { /* 窗口已消失 */ } });
// v0.3.4：floor delta watcher 共享会话 live 标志——语音会话打开期间，它推送
// 合并后的楼层更新，渲染进程将其注入为静默对话条目（连接时快照 + 只追加增量）。
const floorWatcher = new RealtimeFloorWatcher({
  enabled: () => hive.enabled(),
  registry: () => hive.registry(),
  tasks: () => hive.tasks(),
  ptys: () => ptyManager.list().map((p) => ({ id: p.id, lastOutputAt: p.lastOutputAt })),
  push: (text) => { try { liveWebContents()?.send('realtime:floorDelta', { text }); } catch { /* 窗口已消失 */ } }
});
floorWatcher.start();
ipcMain.handle('realtime:setSessionLive', (_e, live: unknown) => {
  completionWatcher.setSessionLive(live === true);
  floorWatcher.setSessionLive(live === true);
  return { ok: true };
});
// v0.3.4：语音 get_app_info 工具的应用自知——版本 + 最新 CHANGELOG 片段。
// 只读；随应用携带 CHANGELOG.md。
ipcMain.handle('app:info', () => {
  let changelog = '';
  for (const p of [join(app.getAppPath(), 'CHANGELOG.md'), join(process.cwd(), 'CHANGELOG.md')]) {
    try { changelog = readFileSync(p, 'utf8'); if (changelog) break; } catch { /* 尝试下一个 */ }
  }
  const top = changelog
    ? changelog.split(/\n## /).slice(1, 3).map((s) => `## ${s}`).join('\n').slice(0, 8000)
    : '';
  return { version: app.getVersion(), changelog: top };
});
ipcMain.handle('realtime:drainCompletions', () => completionWatcher.drainQueuedCompletions());
ipcMain.handle('realtime:waitFor', (_e, taskId: unknown, timeoutMs: unknown) =>
  typeof taskId === 'string'
    ? completionWatcher.waitFor(taskId, typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 120_000)
    : Promise.resolve({ timedOut: true as const, taskId: '' }));
completionWatcher.start();

// ─── god 触发的临时 Slack worker ────────────────────────────────────────────
// god 将 spawn-request JSON 投递到 HIVE_ROOT/spawn-requests/；MAIN 轮询该队列
// （与 hive router 相同的节奏 + 原子重命名归档 —— 可靠性优先于延迟，无需
// fs.watch/dedup），通过共享的 spawnAgentCore 启动一个全新的隔离 worker，
// 通过标准 inbox 路径派发目标，然后监视每个 worker 是否给出终态 `act:"done"`
// （成功 → 释放）或过度闲置（回收）。所有 teardown 都流经 teardownPty 的
// safety-gate，因此只要 worker 还持有未整合的工作，其 worktree 就绝不会被自动移除。
// 每个终态失败都会连同 Slack 坐标一并通知 god，让 god 关闭 Slack 循环；成功路径
// 则是 worker 在 thread 内回复。

/** god 投递到 HIVE_ROOT/spawn-requests/<id>.json 的 spawn-request。由 god 直接
 *  编写；`objective` 和 `cwd` 是仅有的必填字段。 */
interface SpawnRequest {
  id?: string;
  objective?: string;
  command?: string;                                   // 引擎 CLI；默认 = config.defaultCommand
  provider?: AgentProvider;                           // 可选显式 provider
  model?: string;                                     // 可选 --model 覆盖（Claude）
  cwd?: string;                                        // worker（及其 worktree）运行的仓库
  name?: string;                                       // 显示名称
  slack?: { channel: string; thread_ts: string };     // 回复目标 + 失败浮现的位置
  isolate?: boolean;                                   // 默认 true（全新 worktree）
  tokenCap?: number;                                   // 可选按 worker 的 token 上限（advisory P1）
  // 办公室楼层上的外观。二者皆可选，且均在 renderer 侧对照真实的 cast 与 accent
  // 列表校验，因此坏值会退化为默认值，而不会破坏卡片。
  //
  // 用 cast 成员的名字来命名 worker，本就会获得该成员的头像：楼层卡片会根据名字
  // 推断出来。这两个字段用于处理推断无法表达的情况——一个叫别的名字、却仍应看起来
  // 像某个特定角色的 agent，以及选用 accent 而非取用从 worker id 哈希得到的那个。
  character?: string;
  accent?: string;
}

/** 轮询节奏 —— 与 hive router 一致。 */
const WORKER_TICK_MS = 1500;
let workerWatchTimer: ReturnType<typeof setInterval> | null = null;
/** 重入保护，确保慢速 tick（await spawn / git 检查）永不重叠。 */
let workerTickRunning = false;

/** HIVE_ROOT/spawn-requests —— god 投递请求的队列目录。 */
function spawnRequestsDir(): string | null {
  const root = hive.root();
  return root ? join(root, 'spawn-requests') : null;
}

/** 将已处理的请求移出队列，确保它永不被重复处理。 */
function archiveRequest(filePath: string, sub: '.done' | '.failed'): void {
  const queue = spawnRequestsDir();
  try {
    if (!queue) throw new Error('no hive root');
    const dir = join(queue, sub);
    mkdirSync(dir, { recursive: true });
    renameSync(filePath, join(dir, basename(filePath)));
  } catch (e) {
    // 最后手段：删除它，这样投毒文件就不会无限循环。
    try { unlinkSync(filePath); } catch { /* 无操作 */ }
    console.error('[worker] archiveRequest failed:', e);
  }
}

/** 该 worker 是否已给出终态 `act:"done"`？扫描它自己的 outbox 以及
 *  outbox/.sent（router 约每 1.5s 会把已投递的邮件归档到那里），因此无论信号
 *  是否已被路由出去，都能捕获到。
 *
 *  陈旧-done 防护：agent 目录在 teardown 后会保留，所以复用 reqId 会让先前
 *  worker 的 `done` 残留在同一目录里。若无防护，那个陈旧信号会在新 worker 的
 *  首个 tick 就释放它——在它做任何事或回复之前——从而造成静默的 Slack 挂起。
 *  因此我们只统计在该 worker 启动之后产生的 `done`：依据其 `created_at`（消息
 *  自带的时间戳），当 `created_at` 缺失或不可解析时回退到文件的 mtime。当二者
 *  都无法给出可用时间戳时，我们不计入（倾向于让 worker 存活——闲置回收器是兜底）。 */
function workerSignaledDone(workerId: string, spawnedAt: number): boolean {
  const root = hive.root();
  if (!root) return false;
  const base = join(root, 'agents', workerId, 'outbox');
  for (const dir of [base, join(base, '.sent')]) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const fp = join(dir, f);
      try {
        const msg = JSON.parse(readFileSync(fp, 'utf8')) as { act?: string; created_at?: string };
        if (msg.act !== 'done') continue;
        let ts = Date.parse(msg.created_at ?? '');
        if (!Number.isFinite(ts)) {
          try { ts = statSync(fp).mtimeMs; } catch { ts = NaN; }
        }
        if (Number.isFinite(ts) && ts > spawnedAt) return true;
      } catch { /* 跳过不可读/不完整的 */ }
    }
  }
  return false;
}

/** 从一份 spawn-request 启动一个临时 worker。终态失败（坏请求、缺少 CLI、spawn
 *  错误）会归档到 .failed，并连同 Slack 坐标通知 god，让 god 能发布一条
 *  “无法启动”的回复。成功后，worker 会被注册（用于 done 扫描 / 回收 / 安全
 *  teardown），并通过标准 inbox 路径派发其目标。 */
async function processSpawnRequest(filePath: string): Promise<void> {
  let raw: SpawnRequest;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8')) as SpawnRequest;
  } catch (e) {
    console.error('[worker] unparseable spawn-request:', filePath, e);
    informGod('[worker spawn rejected] unparseable request', `Could not parse spawn-request ${basename(filePath)} — ${String(e)}`);
    archiveRequest(filePath, '.failed');
    return;
  }
  const slack = raw.slack && typeof raw.slack.channel === 'string' && typeof raw.slack.thread_ts === 'string'
    ? { channel: raw.slack.channel, thread_ts: raw.slack.thread_ts } : undefined;
  const fail = (reason: string): void => {
    informGod(`[worker 生成被拒] ${reason}`, `生成请求 ${basename(filePath)} 被拒绝: ${reason}。`, slack);
    archiveRequest(filePath, '.failed');
  };

  const objective = typeof raw.objective === 'string' ? raw.objective.trim() : '';
  if (!objective) { fail('缺少 "objective"'); return; }

  const reqId = (typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : basename(filePath).replace(/\.json$/i, ''))
    .replace(/[^A-Za-z0-9._-]/g, '-');
  const workerId = `worker-${reqId}`;
  if (liveWorkers.has(workerId)) { fail(`worker "${workerId}" 已在运行`); return; }

  // Worker 请求文件是手写 / LLM 编写的，所以这里也会出现 `~/…` —— 在存在性检查
  // 之前展开（Node 会按字面读取 `~`）。
  const cwd = typeof raw.cwd === 'string' && raw.cwd.trim() ? expandTilde(raw.cwd) : '';
  if (!cwd || !existsSync(cwd)) { fail(`"cwd" 缺失或未找到 (${cwd || '未设置'})`); return; }

  // 请求行 → 可执行文件 + argv（auto 模式继承、token 化、model 标志去重）。纯函数
  // 且经过单测 —— 至于为何这层转换值得写测试，见 workerLaunch.ts。
  const cfgSpawn = readConfig();
  const launch = buildWorkerLaunch({
    requestCommand: raw.command,
    requestProvider: raw.provider,
    requestModel: raw.model,
    defaultCommand: cfgSpawn.defaultCommand,
    autoMode: !!cfgSpawn.autoMode
  });
  const bin = launch.bin;
  // 在 spawn 路径上校验可执行文件名。spawn-request 文件是不可信输入（由编排器编写，
  // 任何能写 HIVE_ROOT/spawn-requests 的东西都能触达），因此 bin 必须是纯命令 token
  // 或绝对路径 —— 绝不能是下游 shell `which`/`where` 可能重新解释的字符串。在这里、
  // 任何解析之前就拒绝；其后层层的 resolver 守卫也会做同样的深度校验。
  if (!isSafeCommandName(bin) && !isAbsolute(bin)) {
    fail(`拒绝生成: 引擎命令 "${bin}" 不是纯命令名或绝对路径`);
    return;
  }
  // 缺少 CLI → 快速失败。无头 worker 没有人类来看安装程序，所以我们在这里从不运行
  // cc49e1e 安装横幅 —— 直接拒绝并告知 god。
  if (!ptyManager.isCommandAvailable(bin)) { fail(`引擎 CLI "${bin}" 未安装`); return; }

  const isolate = raw.isolate !== false; // 默认 true
  // worktree 将从其上切出的基分支（用于 ahead-of-base 安全检查）。
  let baseBranch = 'main';
  try { const br = await getBranch(cwd); if ('current' in br && br.current) baseBranch = br.current; } catch { /* 保留默认 */ }

  const meta: AgentMeta = {
    id: workerId,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : `Worker ${reqId.slice(0, 12)}`,
    provider: raw.provider,
    role: 'worker',
    cwd
  };
  // 阶段 2：为这个 worker 授予一个对当前已启用集成的 broker 能力，并把 broker URL +
  // 每 worker 的能力 TOKEN（一个句柄，绝非机密）注入其 env，这样它就能经由回环
  // 机密 broker 触达已注册的 REST 集成，而永远看不到任何凭据。仅在 broker 处于运行
  // 状态时进行；该授权会在 teardownPty（以及下面 spawn 失败时）中被吊销。
  const brokerEnv: Record<string, string> = {};
  if (integrationBroker.running()) {
    const token = integrationBroker.grant(workerId, integrations.enabledIds());
    brokerEnv.MD_BROKER_URL = integrationBroker.url();
    brokerEnv.MD_BROKER_TOKEN = token;
  }
  const spawnOpts: AgentSpawnOptions = {
    id: workerId, cwd, command: bin, cols: 120, rows: 32,
    args: launch.args,
    hive: meta, isolate, provider: raw.provider, env: brokerEnv
  };

  let res: { ok: boolean; error?: string; worktreePath?: string };
  try {
    res = await spawnAgentCore(spawnOpts, liveWebContents());
  } catch (e) {
    res = { ok: false, error: String(e) };
  }
  if (!res.ok) { integrationBroker.revoke(workerId); fail(`spawn failed — ${res.error ?? 'unknown error'}`); return; }

  // 由 god 雇佣的 worker 是 MAIN 发起的 spawn，所以 renderer 自己永远不会给它
  // 建卡片（与 voice-spawn 广播同样的原因）：没有这个广播，worker 在楼层上不可见、
  // 永远不会进入 roster，重启后也没有任何东西提议恢复它。卡片从这里起走正常的
  // agent 生命周期 —— teardownPty 广播对应的归档。应用退出后恢复的卡片，会经由
  // renderer 的正常 spawn 路径复活，且永远不会重新进入 liveWorkers：临时性属于雇佣
  // 这个动作，而非卡片本身，所以恢复的 worker 就是普通 agent（不再回收）。
  try {
    liveWebContents()?.send('hive:agentSpawned', {
      id: workerId,
      name: meta.name,
      provider: raw.provider ?? 'claude',
      cwd: res.worktreePath ?? cwd,
      command: launch.command,
      role: meta.role,
      worktreePath: res.worktreePath,
      character: typeof raw.character === 'string' ? raw.character : undefined,
      accent: typeof raw.accent === 'string' ? raw.accent : undefined
    });
  } catch { /* 窗口已拆除 */ }

  // 注册以用于 done 扫描 / 闲置回收 / token 上限 / 安全 teardown（pty id == workerId）。
  // tokenCap 是可选管道（默认不限）—— 只保留正的有限上限。
  const tokenCap = typeof raw.tokenCap === 'number' && Number.isFinite(raw.tokenCap) && raw.tokenCap > 0
    ? raw.tokenCap : undefined;
  liveWorkers.set(workerId, { workerId, reqId, name: meta.name, slack, baseBranch, spawnedAt: Date.now(), tokenCap });

  // 通过标准 inbox 路径派发目标（零新增传输），复用自主请求的前言，让 worker 拿到
  // 精确的 Slack 回复命令 + 自主策略。`from: god`，使 worker 依其协议把它当作 god 派发。
  try {
    const prefix = slack
      ? buildAutonomousRequestProtocol(slack.channel, slack.thread_ts, slackReplyScriptPath())
      : '[AUTONOMOUS WORKER TASK — no interactive human is watching. Work autonomously; do not ask interactive questions.] The task starts now: ';
    const suffix = `\n\n[CAPABILITIES] Before you start, consult your capability catalog — run the \`/capabilities\` skill (or read \`$AGENT_DIR/.claude/skills/capabilities/SKILL.md\`). It lists your temporal date-range skills (\`/today\`, \`/last30Days\`, \`/lastQuarter\`, …) and the integrations available to you (reached via the loopback broker) and how to call each. For any time-scoped work, resolve the dates with those skills instead of computing them by hand.\n\n[WORKER COMPLETION] When finished, signal done by sending ONE outbox message to god with "act":"done" and a short result summary — that releases this ephemeral worker (terminal closed; your branch is handed to god). Do NOT push to any remote; god is the sole integrator.`;
    hive.send({ to: workerId, conversation: `worker-${reqId}`, act: 'request', subject: meta.name, body: `${prefix}${objective}${suffix}` }, 'god');
  } catch (e) {
    console.error('[worker] dispatch send failed:', e);
  }

  console.log(`[worker] spawned ${workerId} (cwd=${cwd}, base=${baseBranch}${slack ? ', slack' : ''})`);
  archiveRequest(filePath, '.done');
}

/** 一个 worker 迄今累计消耗的 token（输入+输出+缓存），取自 usage provider ——
 *  未知时为 0。镜像了 breaker 的 `tokensOf`。仅由（默认关闭的）每 worker token 上限使用。 */
function workerTokensUsed(workerId: string): number {
  const s = usageProvider.getAgentUsage(workerId);
  return s ? s.input + s.output + s.cacheRead + s.cacheCreation : 0;
}

/** GC 清扫的节流 —— git 检查很廉价，但没必要每个 1.5s tick 都跑。 */
const GC_SWEEP_MS = 60_000;
let lastGcSweepAt = 0;
let gcSweepRunning = false;

/** 回收那些工作现已整合、或其 worktree 已被手工移除的保留 worker worktree（连同
 *  其 scratch 目录）。故障安全：仅当 `worktreeIsGcSafe` 证明它既干净又已整合时才
 *  移除 worktree；任何存疑都会保留（绝不丢弃未整合的工作 —— god 是唯一整合者）。
 *  在 worker tick 内运行，按 GC_SWEEP_MS 节流；当没有保留项时是无操作（常见情况
 *  → 零成本）。 */
async function gcPreservedWorktrees(): Promise<void> {
  if (gcSweepRunning || preservedWorktrees.size === 0) return;
  gcSweepRunning = true;
  try {
    for (const [key, e] of [...preservedWorktrees]) {
      // 一个再次活跃的 worker id（reqId 复用）→ 绝不在新运行下方回收其 worktree 或
      // scratch；把陈旧条目留给后续清扫。
      if (liveWorkers.has(e.workerId)) continue;
      // (a) worktree 已消失（干净 teardown 时移除，或 god 依保留说明手工移除）
      //     → 只回收 scratch 目录并停止跟踪。
      if (!existsSync(e.wtPath)) {
        removeWorkerScratch(e.workerId);
        preservedWorktrees.delete(key);
        console.log(`[worker gc] ${e.workerId}: worktree already gone — reclaimed scratch`);
        continue;
      }
      // (b) 仍在磁盘上 → 仅当可证明已整合且干净时才回收。
      let safe: { gc: boolean; detail: string };
      try { safe = await worktreeIsGcSafe(e.wtPath, e.baseBranch); }
      catch (err) { console.error('[worker gc] gc-safe check threw (keeping):', err); continue; }
      if (!safe.gc) continue; // 保留 —— 故障安全
      const r = await removeWorktree(e.origCwd, e.wtPath);
      if (!r.ok) { console.error(`[worker gc] removeWorktree failed (keeping ${e.workerId}):`, r.error); continue; }
      removeWorkerScratch(e.workerId);
      preservedWorktrees.delete(key);
      console.log(`[worker gc] reclaimed ${e.workerId} (${safe.detail})`);
      informGod(
        `[worker worktree reclaimed] ${e.workerId}`,
        `The preserved worktree for ${e.workerId} is now integrated (${safe.detail}), so it and its scratch dir were garbage-collected.\nWorktree: ${e.wtPath}`,
        e.slack
      );
    }
  } finally {
    gcSweepRunning = false;
  }
}

/** 一次控制器 tick：(1) 结束/回收正在运行的 worker（释放槽位），然后 (2) 拉取新请求
 *  直至并发上限。顺序很重要，这样释放的槽位能在同一个 tick 内被复用。 */
async function ephemeralWorkerTick(): Promise<void> {
  if (workerTickRunning) return;
  workerTickRunning = true;
  try {
    const cfg = readConfig();
    const maxWorkers = Math.max(1, cfg.maxConcurrentWorkers ?? 4);
    const idleTimeoutMs = Math.max(1, cfg.workerIdleTimeoutMinutes ?? 20) * 60_000;
    // 每 worker token 上限。0 = 不限（默认 —— 已接线但从不节流，除非按请求或通过
    // defaultWorkerTokenCap 设置了正上限）。
    const defaultTokenCap = typeof cfg.defaultWorkerTokenCap === 'number' && cfg.defaultWorkerTokenCap > 0
      ? cfg.defaultWorkerTokenCap : 0;

    // (1) 结束或回收。每次释放都在 kill 之后显式调用 teardownPty，与其它所有 kill
    //     点一致：ptyManager.kill() 会同步删除会话，所以当 node-pty 的异步 onExit
    //     稍后触发时，会失败于会话身份守卫，全局退出处理器（→ teardownPty）永远不会
    //     运行。在此依赖 onExit 会让已释放的 worker 无法完成 teardown：没有 hive
    //     归档、没有 hive:agentArchived、楼层卡片冻结，而且 god 会继续向死掉的 agent
    //     投递邮件（2026-08-16 实测，涉及 worker-business/worker-qa/worker-bizreview）。
    //     双重 teardown 是无害的 no-op。
    for (const [workerId, rec] of [...liveWorkers]) {
      if (rec.releasing) continue;
      if (workerSignaledDone(workerId, rec.spawnedAt)) {
        // 成功：worker 已在 thread 内回复；只需释放它。
        rec.releasing = true;
        console.log(`[worker] ${workerId} signaled done — releasing`);
        ptyManager.kill(workerId);
        teardownPty(workerId);
        continue;
      }
      // token 上限回收（默认关闭的管道）。有效上限 > 0 → 当 worker 累计 token 用量
      // 超过它时回收；其已提交的工作会被保留。
      const tokenCap = (rec.tokenCap && rec.tokenCap > 0) ? rec.tokenCap : defaultTokenCap;
      if (tokenCap > 0) {
        const used = workerTokensUsed(workerId);
        if (used > tokenCap) {
          rec.releasing = true;
          console.warn(`[worker] reaping ${workerId} — token cap (${used.toLocaleString()} > ${tokenCap.toLocaleString()})`);
          informGod(
            `[worker reaped — token cap] ${workerId}`,
            `Worker ${workerId} used ${used.toLocaleString()} tokens (> its cap of ${tokenCap.toLocaleString()}) and was reaped. Any committed work on its branch is preserved for you.`,
            rec.slack
          );
          ptyManager.kill(workerId);
          teardownPty(workerId);
          continue;
        }
      }
      const idleMs = ptyManager.idleFor(workerId);
      if (idleMs === undefined) continue; // PTY 已消失；teardownPty 会清理
      if (idleMs > idleTimeoutMs) {
        rec.releasing = true;
        console.warn(`[worker] reaping idle ${workerId} (${Math.round(idleMs / 60000)}min idle)`);
        informGod(
          `[worker reaped — idle] ${workerId}`,
          `Worker ${workerId} produced no output for ${Math.round(idleMs / 60000)} min (> the ${Math.round(idleTimeoutMs / 60000)} min cap) and never signaled done, so it was reaped. Any committed work on its branch is preserved for you.`,
          rec.slack
        );
        ptyManager.kill(workerId);
        teardownPty(workerId);
      }
    }

    // (2) 处理新请求，遵守并发上限（背压：把其余的留在队列里，留给后面的 tick）。
    //
    //     受 config.orchestratorMaySpawn（默认关）门控：让编排器未经提示就启动 agent
    //     是一项 SPEND 决策，所以由操作员选择开启。这个门放在这里、放在 intake 上，
    //     而不是放在 watcher 本身，因为上面的步骤 (1) 掌管着已在运行的 worker 的
    //     生命周期 —— 回收、teardown、Slack 失败通知 —— 中途关掉开关不能把它们搁浅。
    //
    //     拒绝也意味着拒绝消费。在关闭期间被投入的请求会留在队列里，等到开启时再运行，
    //     而不是被吃掉并以一个 god 从未问及的理由而失败。
    const dir = readConfig().orchestratorMaySpawn ? spawnRequestsDir() : null;
    if (dir && existsSync(dir)) {
      let files: string[] = [];
      try { files = readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { /* 目录已消失 */ }
      for (const f of files) {
        if (liveWorkers.size >= maxWorkers) break;
        await processSpawnRequest(join(dir, f));
      }
    }

    // (3) 回收那些工作此后已整合的保留 worktree。按 GC_SWEEP_MS 节流，当没有保留项
    //     时是无操作（常见情况）。
    const now = Date.now();
    if (preservedWorktrees.size > 0 && now - lastGcSweepAt >= GC_SWEEP_MS) {
      lastGcSweepAt = now;
      await gcPreservedWorktrees();
    }
  } catch (e) {
    console.error('[worker] tick error:', e);
  } finally {
    workerTickRunning = false;
  }
}

function startEphemeralWorkerWatcher(): void {
  if (workerWatchTimer || !hive.enabled()) return;
  const dir = spawnRequestsDir();
  if (dir) { try { mkdirSync(dir, { recursive: true }); } catch { /* 空操作 */ } }
  workerWatchTimer = setInterval(() => { void ephemeralWorkerTick(); }, WORKER_TICK_MS);
}

function stopEphemeralWorkerWatcher(): void {
  if (workerWatchTimer) { clearInterval(workerWatchTimer); workerWatchTimer = null; }
}

/** 供 renderer 的 Workers 标签页使用的单个活动临时 worker 快照。 */
interface WorkerSnapshot {
  workerId: string;
  reqId: string;
  name: string;
  baseBranch: string;
  spawnedAt: number;
  ageMs: number;
  idleMs: number | null;        // null = PTY 已消失
  tokensUsed: number;
  tokenCap: number | null;      // 有效上限（按请求或配置默认）；null = 不限
  hasSlack: boolean;
  releasing: boolean;
  status: 'releasing' | 'working';
}
/** 供标签页使用的、已保留但尚未 GC 的 worktree 快照。 */
interface PreservedSnapshot {
  workerId: string;
  wtPath: string;
  baseBranch: string;
  preservedAt: number;
}

/** 列出活动临时 worker（+ 等待 GC 的保留 worktree），供标签页使用。 */
ipcMain.handle('workers:list', (): { live: WorkerSnapshot[]; preserved: PreservedSnapshot[]; maxWorkers: number } => {
  const cfg = readConfig();
  const defaultCap = typeof cfg.defaultWorkerTokenCap === 'number' && cfg.defaultWorkerTokenCap > 0
    ? cfg.defaultWorkerTokenCap : 0;
  const now = Date.now();
  const live: WorkerSnapshot[] = [...liveWorkers.values()].map((rec) => {
    const idle = ptyManager.idleFor(rec.workerId);
    const effCap = (rec.tokenCap && rec.tokenCap > 0) ? rec.tokenCap : (defaultCap > 0 ? defaultCap : 0);
    return {
      workerId: rec.workerId,
      reqId: rec.reqId,
      name: rec.name ?? rec.workerId,
      baseBranch: rec.baseBranch,
      spawnedAt: rec.spawnedAt,
      ageMs: Math.max(0, now - rec.spawnedAt),
      idleMs: idle === undefined ? null : idle,
      tokensUsed: workerTokensUsed(rec.workerId),
      tokenCap: effCap > 0 ? effCap : null,
      hasSlack: !!rec.slack,
      releasing: !!rec.releasing,
      status: rec.releasing ? 'releasing' : 'working'
    };
  });
  const preserved: PreservedSnapshot[] = [...preservedWorktrees.values()].map((e) => ({
    workerId: e.workerId, wtPath: e.wtPath, baseBranch: e.baseBranch, preservedAt: e.preservedAt
  }));
  return { live, preserved, maxWorkers: Math.max(1, cfg.maxConcurrentWorkers ?? 4) };
});

/** 手动停止一个活动临时 worker。镜像 done-释放路径：标记 releasing，然后 kill +
 *  teardownPty 运行经 SAFETY-GATED 的 worktree teardown（已提交的工作会被保留，
 *  绝不强制丢弃）。幂等。teardownPty 被显式调用（D10），而不是交给 PTY 的自然退出：
 *  kill() 会同步释放管理器的 id 槽位，所以当进程真正的退出到达时，退出处理器的
 *  陈旧-id 守卫已把它误判为已回收的 id 并跳过 teardown —— 之后这个 worker 会永远
 *  以 “live” 状态留在 registry.json 和 fleet.json 里。 */
ipcMain.handle('workers:stop', (_evt, workerId: string): { ok: boolean; error?: string } => {
  if (typeof workerId !== 'string' || !workerId) return { ok: false, error: 'invalid worker id' };
  const rec = liveWorkers.get(workerId);
  if (!rec) return { ok: false, error: 'no such live worker' };
  if (rec.releasing) return { ok: true }; // 已在停止
  rec.releasing = true;
  console.log(`[worker] manual stop requested for ${workerId}`);
  try { ptyManager.kill(workerId); } catch (e) { return { ok: false, error: String(e) }; }
  teardownPty(workerId);
  return { ok: true };
});

/** 针对当前 harnessHome 启动每个与 hive 绑定的后台服务。在启动时调用，若文件夹变更
 *  复制失败则再次调用以就地恢复（config:changeHome 会在复制前把这些全部 teardown）。
 *  无 home 时为无操作。 */
function bootstrapHiveServices(): void {
  if (!hive.enabled()) return;
  hive.ensureHive();
  // 在任何东西 spawn 之前，告诉 hive 它运行在什么环境中：prompt 构建器会读取这个，
  // 所以更早 spawn 的 agent 永远不会得知。
  hive.setRuntimeInfo({ version: app.getVersion(), packaged: app.isPackaged, appPath: app.getAppPath() });
  hive.setOrchestratorMaySpawn(readConfig().orchestratorMaySpawn === true);
  // 事件日志中的应用启动标记。log.jsonl 曾有十二种事件类型，但没有一种表示“应用
  // 重启了”，因此一次重启——更重要的是打包构建与本地构建之间的切换——对读取该
  // 数据流的每个 agent 都不可见。这个缺口导致了一次数小时的排查，答案恰恰就是：
  // 本地构建继承启动 shell 的 umask，而 Finder 启动的应用不会。
  hive.appendLog({
    kind: 'app-start',
    version: app.getVersion(),
    packaged: app.isPackaged,
    // 是哪一个 bundle，而不只是哪个版本。版本加 packaged 不足以区分两个构建：
    // /Applications 里的陈旧副本与 dist/ 里的新副本可以报告相同版本且同为打包，
    // 而凭习惯拿错的那个，看起来恰好就像新构建坏了。在这一行存在之前，我们已经
    // 为此吃过两次亏。
    appPath: app.getAppPath(),
    exePath: process.execPath,
    electron: process.versions.electron,
    platform: process.platform
  });
  control.replaceAutoDeliveryPauses(readConfig().autoDeliveryPausedAgents ?? []);
  archiveOrphanedAgents(); // #57/#58: 归档无活动 PTY 的陈旧 archived:false 条目
  // Roster 名称始终镜像 registry（方案 B, #roster-name-sync）：如果先前 renderer
  // 的写入在 roster.json 里留下了英文/localStorage 名称，就在启动时把 registry 的
  // 权威名称盖回去，使 UI 以正确的显示名称打开（例如中文团队名）。RosterStore.write
  // 会先做备份。
  try {
    const boot = roster.read();
    if (boot) roster.write(withRegistryNames(boot));
  } catch (e) { console.error('[roster] boot name-sync failed:', e); }
  hive.startRouter();
  startEphemeralWorkerWatcher(); // 轮询 HIVE_ROOT/spawn-requests → 临时 worker
  // 阶段 2：回环机密 broker。在 worker spawn 之前绑定，这样每次 spawn 都能在其 env
  // 中获授一个能力 token + broker URL。仅回环、幂等。
  void integrationBroker.start().then((r) => {
    if (r.ok) console.log('[broker] integration broker listening on', integrationBroker.url());
    else console.error('[broker] failed to start:', r.error);
  });
  ensureDefaultMissions(); // 一次性：植入内置的每小时 ops 站会
  syncMissions(); // 现在 router 已上线，为循环自动派发任务布防
  syncContextTriggers(); // ……以及 context trigger 自身的 compact/clear 节奏
  // 把入站 webhook 消息的回复配对到 ledger 中。绑定的是 FEATURE（任何已配置的
  // endpoint），而不是服务器：一条已批准消息的卡片可以在操作员关掉公共表面很久之后
  // 才完成，其回复仍应属于历史记录。
  if ((readConfig().webhookTriggers ?? []).length > 0) startWebhookDoneObserver();
  hookServer.start();
  // 在 renderer spawn 任何 agent 之前绑定遥测收集器，然后把 hive 指向它，这样之后
  // 每次 spawn 都会被插桩。尽力而为 —— 绑定失败只是让遥测保持关闭（transcript
  // reconciler 仍会保留）。无 breaker.start()：breaker 只做策略，由心跳 beat 驱动
  // （#1，随产品默认关闭）。
  void telemetry.start().then((r) => {
    if (r.ok && r.endpoint) { hive.setOtelEndpoint(r.endpoint); console.log('[telemetry] collector listening', r.endpoint); }
    else console.error('[telemetry] collector failed to start:', r.error);
  });
  memory.start(); // 初始化共享 palace + 挖掘循环（无 mempalace 时为无操作）
  reflector.start(); // 定时约束过大的 memory.md 文件（阈值前为无操作）

  armAlwaysOnBeats();
}

/** worker inbox-wake watchdog 的节奏（#151）。远低于 renderer 自身的 nudge
 *  冷却，因此节流的窗口能在停滞约 15s 内被捕捉到。 */
const WORKER_WAKE_POLL_MS = 15_000;
let workerWakeTimer: ReturnType<typeof setInterval> | null = null;

/** 把 renderer 的受保护 nudge 键入一个 worker 的 PTY —— 先文本、稍后一个 tick 再
 *  回车（正是 submitToPty 的模式：单块写入会把 “\r” 落到输入框内而永不提交）。
 *  尽力而为 + 从不抛出。 */
function nudgeWorker(ptyId: string, ids: string[] = []): void {
  // 与 renderer 排队的文本相同（#187 的 inboxNudgeText），因此两条唤醒路径产生的
  // nudge 逐字节一致：队列的单待处理规则可经 isInboxNudge 识别任一条，且 watchdog
  // nudge 会点名其 ids，使 agent 仍能区分“我上一轮已提交”与“被无缘无故唤醒”。
  const wrote = ptyManager.write(ptyId, inboxNudgeText(ids));
  if (!wrote.ok) { console.warn(`[worker-wake] write failed for ${ptyId}: ${wrote.error}`); return; }
  setTimeout(() => {
    try {
      const submitted = ptyManager.write(ptyId, '\r');
      if (!submitted.ok) console.warn(`[worker-wake] submit failed for ${ptyId}: ${submitted.error}`);
    } catch (e) { console.error('[worker-wake] submit threw:', e); }
  }, 140);
}

/** 主进程 inbox-wake beat（issue #151，方案 A）：renderer 的闲置 nudge
 *  （useHive.ts）是唤醒停靠在未排空 inbox 上的 worker 的唯一路径——而它生活在
 *  renderer 的一个 setInterval 上，被节流或遮挡的窗口会停止履行它。这个 beat 是
 *  独立于 renderer 的兜底：它收集活动 worker 的事实（PTY 静止、inbox 深度、控制
 *  标志），让 WorkerWakeWatchdog.decide 应用与 renderer 完全相同的守卫（仅闲置、
 *  启动宽限期后、未暂停/未停止、无待处理的 HITL、冷却），然后键入 renderer 本会
 *  键入的同一个 nudge。god 永不是候选（其心跳路径已重新接合它）。 */
function runWorkerWakeBeat(): void {
  if (!hive.enabled()) return;
  const reg = hive.registry();
  if (!reg?.agents || !reg.godId) return;
  const now = Date.now();
  const facts: WorkerWakeFacts[] = [];
  for (const [agentId, a] of Object.entries(reg.agents)) {
    if (agentId === reg.godId || a?.archived) continue;
    const ptyId = ptyForAgent(agentId);
    if (!ptyId) continue;
    const snap = control.snapshot(agentId);
    facts.push({
      agentId,
      isGod: agentId === reg.godId,
      ptyId,
      lastOutputAt: ptyManager.lastOutputAt(ptyId) ?? 0,
      inboxCount: hive.inbox(agentId).length,
      autoDeliveryPaused: snap.autoDeliveryPaused,
      paused: snap.paused,
      halted: snap.halted
    });
  }
  for (const agentId of workerWake.decide(facts, now)) {
    const ptyId = ptyForAgent(agentId);
    if (!ptyId) continue;
    // 在投递时刻重新读取，而不是用 facts 快照：agent 可能已在本 beat 期间排空了
    // 邮件，而点名它已提交的 ids 的 nudge，正是 #187 存在所要阻止的那种陈旧。
    const ids = hive.inbox(agentId).map((m) => m.id).filter(Boolean);
    if (!ids.length) { console.log(`[worker-wake] ${agentId} drained before delivery, skipping`); continue; }
    console.log(`[worker-wake] nudging ${agentId} on ${ptyId} (${ids.length} pending)`);
    nudgeWorker(ptyId, ids);
  }
}

/** （重新）布防 always-on beats（与可选心跳解耦）：Michael 读取的实时 fleet 快照
 *  （约 8s）+ breaker/成本 ledger beat（约 30s）。受保护（先清后设），因此重新
 *  bootstrap（changeHome 恢复）或 powerMonitor resume 都不会堆积重复定时器——这些
 *  setInterval 句柄在真正的系统休眠期间会冻结，必须在唤醒时重新布防。 */
function armAlwaysOnBeats(): void {
  if (fleetTimer) clearInterval(fleetTimer);
  writeFleetSnapshot();
  fleetTimer = setInterval(writeFleetSnapshot, 8_000);
  if (breakerBeatTimer) clearInterval(breakerBeatTimer);
  breakerBeatTimer = setInterval(() => { try { runBreakerBeat(300_000); } catch (e) { console.error('[breaker beat]', e); } }, 30_000);
  if (workerWakeTimer) clearInterval(workerWakeTimer);
  workerWakeTimer = setInterval(() => { try { runWorkerWakeBeat(); } catch (e) { console.error('[worker-wake beat]', e); } }, WORKER_WAKE_POLL_MS);
  runWorkerWakeBeat(); // 布防时追赶 —— power-resume 会重新布防并排空积压
}

/** 我们最后一次观察到机器挂起或锁屏的墙上时钟时刻，使 resume 能报告我们离线了多久。
 *  为 renderer 后续操作（auto-revive）提供尽力而为的上下文；在会话第一次挂起/锁屏前
 *  为 null。 */
let lastSuspendAt: number | null = null;
/** 单个待处理的 resume 后 PTY 健康检查，使重叠的 resume+unlock 事件折叠为一次检查
 *  （最近一次），而不是叠加。 */
let resumeHealthTimer: NodeJS.Timeout | null = null;

/** 机器唤醒后，探测每个活动 PTY 的活性，并暴露任何未能存活的 PTY。macOS 可能在长
 *  时间休眠期间卡住子 `claude` 进程/套接字，而 node-pty 仍持有该 fd（其 exit 事件
 *  从未触发）——所以一个已死的 PTY 可能滞留在我们的列表里。`process.kill(pid, 0)`
 *  是纯粹的存活性探测（信号 0 从不触碰进程）；ESRCH 表示进程已消失。这里我们只
 *  记录 + 通知（不自动 kill/重生——真正的复活由 renderer 经 pty:spawn 负责），并把
 *  `power:resume` 作为后续 renderer 自动复活卡片的集成点发出。 */
function healthCheckPtys(reason: string, awayMs: number | null): void {
  const ptys = ptyManager.list();
  const dead: string[] = [];
  for (const p of ptys) {
    if (typeof p.pid === 'number' && p.pid > 0) {
      try { process.kill(p.pid, 0); }   // 仅为活性探测 —— 绝不 kill
      catch { dead.push(p.id); }        // ESRCH：进程已消失但 PTY 仍被注册
    }
  }
  const away = awayMs != null ? ` (away ~${Math.round(awayMs / 1000)}s)` : '';
  if (dead.length) {
    console.warn(`[power] ${reason}${away}: ${dead.length}/${ptys.length} PTY(s) look wedged (process gone):`, dead.join(', '));
    breakerToast(l10n('Agents need a restart', '代理需要重启'), l10n(`${dead.length} agent terminal(s) didn't survive sleep — re-open them to resume.`, `${dead.length} 个代理终端在休眠后未能恢复——请重新打开以继续。`));
  } else {
    console.log(`[power] ${reason}${away}: ${ptys.length} PTY(s) healthy`);
  }
  // （独立的）renderer 自动复活卡片的唯一集成点：它可以监听 'power:resume' 并用
  // --resume 重生这些 `dead` PTY。
  try { liveWebContents()?.send('power:resume', { reason, awayMs, dead, total: ptys.length }); } catch { /* 窗口已销毁 */ }
}

/** 机器休眠后，重新布防每个运行在冻结的 libuv 定时器上的东西，并暴露任何未能存活的
 *  PTY。macOS 在真正的系统休眠期间会暂停 setTimeout/setInterval（单调时钟停止）——
 *  唤醒后它们从暂停处继续，整体偏移整个休眠时长，因此休眠期间到期的任务从未触发、
 *  也从未重放。我们重建调度器（syncMissions 复用其 remaining=max(0,…) 语义 → 每个
 *  逾期的任务恰好触发一次后重新归位，绝不 N 次重放），重新布防 always-on beats，
 *  重新评估 power blocker，然后——在给 PTY 一个唤醒其管道的短暂宽限期之后——健康
 *  检查终端。幂等：重叠的 resume+unlock 事件安全折叠（处处先清后设；至多一次追赶触发）。 */
function onSystemResume(reason: string): void {
  console.log(`[power] ${reason} — re-arming scheduler, beats, router, keep-awake`);
  try { syncMissions(); } catch (e) { console.error('[power] syncMissions on resume', e); }
  // 同样的冻结、同样的追赶：context 定时器尊重距上次运行的经过时间，因此在机器休眠
  // 期间到期的 compact/clear 在这里恰好触发一次，而不是丢失或重放 N 次。
  try { syncContextTriggers(); } catch (e) { console.error('[power] syncContextTriggers on resume', e); }
  try { armAlwaysOnBeats(); } catch (e) { console.error('[power] armAlwaysOnBeats on resume', e); }
  // hive 消息 router（outbox→inbox 排空）是与上面那些 beat 一样的 setInterval，在
  // 真正的系统休眠期间冻结——但它是唯一从未在唤醒时重新布防的 always-on 定时器。
  // 症状：长时间休眠后，scheduler→god 路径恢复（它直接注入 god 的 inbox），而每个
  // agent 的 outbox 静默停止排空，导致 god→worker 和 worker↔worker 邮件积压未送达。
  // 重新布防轮询循环（先清后设、幂等）并立即排空我们离线期间累积的积压，而不是等待
  // 唤醒后的第一个 tick。然后 renderer 的闲置 inbox-wake nudge（useHive.ts）会在
  // 邮件落地的瞬间唤醒每个停靠的收件人。
  try {
    hive.stopRouter();
    hive.startRouter();
    const drained = hive.routeOnce();
    if (drained > 0) console.log(`[power] ${reason} — flushed ${drained} queued hive message(s)`);
  } catch (e) { console.error('[power] router re-arm on resume', e); }
  try { syncKeepAwake(); } catch (e) { console.error('[power] syncKeepAwake on resume', e); }
  const awayMs = lastSuspendAt != null ? Date.now() - lastSuspendAt : null;
  // 在判定终端异常前，给 PTY 一个恢复管道的节拍；重置任何待处理检查，使快速 resume
  // 后紧接 unlock 只运行一次探测。
  if (resumeHealthTimer) clearTimeout(resumeHealthTimer);
  resumeHealthTimer = setTimeout(() => {
    resumeHealthTimer = null;
    healthCheckPtys(reason, awayMs);
  }, 15_000);
}

app.whenReady().then(() => {
  // Realtime Michael 麦克风门控卫生（rt-8 / Pam rt-10 nit）：语音会话通过持久化
  // realtimeVoiceEnabled=true 打开麦克风权限门，并在断开时关闭它——但会话中途硬崩溃/
  // 重载会跳过该 teardown，使标志卡在 true，导致门控以无活动会话的 PRE-OPEN 状态
  // 启动。在启动时强制关闭它（真正的会话会经 setMicGate(true) 重新打开）；macOS TCC
  // 无论如何仍是第二道门。
  if (readConfig().realtimeVoiceEnabled) writeConfig({ realtimeVoiceEnabled: false });

  // 匿名产品分析（PostHog）——完整约定见 TELEMETRY.md。除非注入了构建时密钥（仅官方
  // 发布），否则为无操作，并受 DO_NOT_TRACK + telemetryEnabled 配置门控（可退出）。
  analytics.init({
    stateDir: app.getPath('userData'),
    appVersion: app.getVersion(),
    enabled: readConfig().telemetryEnabled !== false
  });

  // 冷启动深链（Windows/Linux）搭载在我们自己的 argv 上。
  const startupHireLink = process.argv.find((a) => a.startsWith('munderdifflin://'));
  if (startupHireLink) void handleHireLink(startupHireLink);

  // 通过继承的 env（pty 合并 process.env）把 Slack 回复发现文件的路径交给每个已
  // spawn 的 agent。无论服务器是否在运行，该路径都稳定；而文件只在服务器运行期间
  // 存在，因此辅助函数会干净地退化为“endpoint 未运行”。env 中没有任何机密——只有路径。
  process.env.MD_SLACK_REPLY_CONFIG = slackReplyConfigPath();
  // 先打开持久化存储——createWindow() 会读取保存的窗口边界。受保护：数据库故障
  // （例如原生构建损坏）必须退化为默认值，绝不让应用启动阻塞。
  try { persist.open(); } catch (e) { console.error('[db] open failed:', e); }
  // 从 GitHub releases 自动更新（仅打包构建；受 `autoUpdate` 配置标志门控）。
  // 后台下载 + 重启应用 toast；从不自行重启。在无法进行原生更新的地方（win-portable、
  // 类 dev 构建）回退为仅通知的 releases/latest 检查。
  initAutoUpdater(() => liveWebContents());
  // 启动 hive（若已配置 harnessHome）并启动消息 router。
  bootstrapHiveServices();
  // 挺过休眠/锁屏。macOS 在真正的系统休眠期间冻结 libuv 定时器，因此锁屏/闲置/休眠的
  // Mac 会停止触发调度并可能卡住 PTY。唤醒时我们重新布防调度器（一次性追赶错过的
  // 任务）+ beats + keep-awake，然后健康检查终端。应用生命周期监听器——powerMonitor
  // 比每个窗口都活得久，因此退出时无需拆除任何东西。
  powerMonitor.on('resume', () => onSystemResume('resume'));
  powerMonitor.on('unlock-screen', () => onSystemResume('unlock-screen'));
  powerMonitor.on('suspend', () => { lastSuspendAt = Date.now(); console.log('[power] suspend — system sleeping'); });
  powerMonitor.on('lock-screen', () => { lastSuspendAt = Date.now(); console.log('[power] lock-screen'); });
  // 多窗口楼层（可选加入）：安装携带 “New Floor” 的菜单。关闭时，应用保留 Electron
  // 的默认菜单——零行为变化。
  if (readConfig().multiWindow) installAppMenu();
  createWindow();
  // 配置时自动启动 Slack webhook 服务器。尽力而为：tunnel 失败（离线）只记日志，
  // 不致命。tunnel URL 是临时的、每次重启都会变化，因此用户经 Settings → Start
  // 重新粘贴。
  const slackCfg = readConfig();
  if (slackCfg.slackEnabled && slackCfg.slackSigningSecret) {
    void startSlackServer().then((r) => {
      if (!r.ok) console.error('[slack] auto-start failed:', r.error);
      else console.log('[slack] webhook listening', r.url ? `(tunnel: ${r.url})` : '(no tunnel)');
    });
  }
  // 只为用户显式启用的 endpoint（各有其独立密钥）自动启动通用 webhook——绝不默认
  // 开启公共表面。与 Slack 一样是可选的；未启用任何 endpoint 的安装不会打开 tunnel。
  if (enabledWebhookEndpoints().length > 0) {
    void startWebhookServer().then((r) => {
      if (!r.ok) console.error('[webhook] auto-start failed:', r.error);
      else console.log('[webhook] listening', r.url ? `(tunnel: ${r.url})` : '(no tunnel)');
    });
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// before-quit 覆盖 Cmd-Q / dock 退出；每窗口的关闭处理器覆盖红色关闭按钮。两条路径
// 都命中同一个警告 UX。
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

// 每个窗口都在启动时加载一次配置，所以在设置被保存时告知它们全部——被漏掉的楼层
// 会一直显示它打开时的旧配置。
onConfigWritten((config) => {
  for (const w of allWindows) {
    if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
    w.webContents.send('config:changed', config);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // 完整 teardown，而非单纯的 killAll：这条路径还必须停止 proxy 侧车和辅助服务器
    // ——在 Windows 上，子进程不会随父进程退出而被杀掉，所以任何在这里被跳过的东西
    // 都会比应用活得更久。
    teardownAndQuit();
  }
});

// 最终的分析 flush（session_ended + 排空发送队列），设有界，使挂起的网络永远不会
// 卡死退出：preventDefault 一次，让 flush 与一个短超时竞速，然后硬退出。
//
// finish 必须是 app.exit()，而不是可重入的 app.quit()：当退出是在窗口仍打开时发起
// 的（“kill all & quit” 确认路径调用 teardownAndQuit → app.quit()，而窗口在退出
// 过程中关闭），Electron 会在这次 preventDefault 之后把内部 is-quitting 状态置位，
// 之后再次调用 app.quit() 会静默地成为 no-op——没有 before-quit、没有 will-quit、
// 没有 quit；主进程在零窗口的情况下永远空转。在 Windows 上，这让整个 Electron
// 进程组（main + GPU + network service）在每次 agents-running 退出后都被搁浅。到
// 这一步，teardown 已经运行完毕，flush 也已结束或超时，所以无条件的退出正是剩下
// 要做的事。
let analyticsFlushed = false;
app.on('will-quit', (e) => {
  if (analyticsFlushed) return;
  analyticsFlushed = true;
  e.preventDefault();
  const finish = (): void => app.exit(0);
  Promise.race([
    analytics.endSession(),
    new Promise<void>((r) => setTimeout(r, 1200))
  ]).then(finish, finish);
});

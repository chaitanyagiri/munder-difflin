/**
 * Hive —— 磁盘上的多智能体协调层。
 *
 * 位于 `<harnessHome>/hive/` 下，作为单一 git 仓库，只有这个主进程提交
 * （智能体从不调用 git —— 它们只是写文件）。完整设计见 HIVE.md。职责：
 *   - 每个智能体的工作区（identity.md、memory.md、inbox/、outbox/、cursor.json）
 *   - hive 身份（registry.json：id/role/cwd/session —— 智能体读取的内容），
 *     与 UI 楼层名册（`<harnessHome>/roster.json`）相互独立
 *   - 共享黑板（board.md）、任务台账，以及仅追加的事件日志（log.jsonl）
 *   - 一个路由器，将每个智能体的 outbox 清空投递到收件人的 inbox
 *
 * 人机协作对每个智能体的 Claude Code 会话是原生的：权限提示会出现在该
 * 智能体自己的终端中（也可通过 `/remote-control` 远程批准）。Hive 不设独立
 * 的审批队列 —— 发给 "human" 的消息会被路由到 god/orchestrator，即该人在
 * 楼层的代理。
 *   - 单一提交者 git，带重试/退避 + 陈旧锁恢复
 *
 * 这里的一切都运行在 Electron 主进程中。
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
  readdirSync, statSync, lstatSync, realpathSync, rmSync, appendFileSync,
  symlinkSync, unlinkSync, copyFileSync, cpSync, chmodSync
} from 'node:fs';
import { join, dirname, basename, isAbsolute, relative } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import type { AgentUsageSample } from './usage';
import { COMMAND_GROUPS } from '../shared/claudeCommands';
import {
  isClaudeProvider,
  isHiveAwareProvider,
  canReceiveInbox,
  providerPreset,
  bridgeOf,
  type AgentProvider
} from '../shared/agentProvider';
import { MCP_CATALOG } from '../shared/mcpCatalog';
import { selectBroadcastTargets } from '../shared/broadcast';
import { preferredAgentRole } from '../shared/agentRole';
import { mergeTaskLedger } from '../shared/taskLedger';
import { expandTilde } from './fs';
import { resolveGodName } from '../shared/godIdentity';

/** HarnessConfig 中 hive 消费的部分（用于默认 MCP 合并）。
 *  保持为本地形状，这样 hive.ts 就无需仅为类型而引入基础配置模块。 */
type McpDefaultsMap = { [id: string]: { enabled: boolean } } | undefined;

// ─── 类型 ────────────────────────────────────────────────────────────────────

export type MessageAct = 'request' | 'inform' | 'propose' | 'query' | 'agree' | 'refuse' | 'done';

export interface HiveMessage {
  id: string;
  conversation: string;
  in_reply_to: string | null;
  from: string;
  to: string;                 // 一个 agentId、'god' 或 'broadcast'
  act: MessageAct;
  subject: string;
  body: string;
  hops: number;
  requires_reply: boolean;
  needs_human: boolean;
  created_at: string;
}

/** 一条为语音读取层（`hive:messages`）重塑的 hive 消息：inbox/outbox 消息的
 *  操作员简报视图。`subject` 和 `body` 在离开主进程前已在主进程侧 REDACTED
 *  （见 {@link redactSecrets}）—— 渲染器/语音层永远看不到原始 body，也永远
 *  看不到机密。按构造即无 PII + 无机密。 */
export interface VoiceMessage {
  id: string;
  conversation: string;
  from: string;
  to: string;
  act: MessageAct;
  /** 已 REDACTED 的主题行。 */
  subject: string;
  /** 已 REDACTED 的消息正文。 */
  body: string;
  requires_reply: boolean;
  /** 这份副本是从哪个邮箱文件夹读出的，相对于 `owner`。 */
  direction: 'inbox' | 'outbox';
  /** 拥有这份副本所在邮箱的智能体。 */
  owner: string;
  /** 为 true 表示读自归档/已处理子文件夹（inbox/.done、outbox/.sent）。 */
  archived: boolean;
  created_at: string;
}

/** 与人类的一次一问一答，记录在任务卡片上，使决策轨迹始终伴随它所
 *  解除阻塞的工作。 */
export interface HumanQA {
  q: string;
  a?: string;
  askedAt?: string;
  answeredAt?: string;
  dismissedAt?: string;
}

export interface HiveTask {
  id: string;
  title: string;
  description?: string;
  assignee?: string;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  dependsOn: string[];
  priority: number;
  createdAt: string;
  /** 一等公民的人类反馈：当卡片只能靠人类的输入才能推进时，god 追加 {q}
   *  （状态变为 blocked）；harness UI 填入 {a}。完整历史永远留在卡片上。 */
  humanQA?: HumanQA[];
  /** 结果摘要，当此卡片达到 'done' 时由 Slack 完成通知器展示。
   *  可选；通知器回退到 description/title。 */
  result?: string;
  /** 当此任务源自一条 Slack 消息时设置 —— 完成摘要回复会被回贴到的
   *  线程。仅 OUTBOUND 消费；填充它是 inbound/看板侧的工作，不影响路由。 */
  slack?: { channel: string; thread_ts: string };
  /** 当此任务源自一个通用 webhook POST 时设置。存储能力令牌的 SHA-256
   *  （绝不存原始令牌 —— 原始令牌只返回给调用方一次且从不持久化），这样
   *  GET 状态查询可以通过哈希提交的令牌来匹配。只读能力：它不会扩大路由
   *  或暴露面。 */
  webhook?: { tokenHash: string };
}

export interface AgentMeta {
  id: string;
  name: string;
  /** 此智能体运行在哪个 CLI 上。未设置时默认 'claude'（旧版）。 */
  provider?: AgentProvider;
  role?: string;
  capabilities?: string[];
  cwd: string;
  isGod?: boolean;
  /** Michael 的预备助手 —— 丰富提示词并将其转发给 Michael。
   *  仅发送：从广播扇出中排除，使其永不耗尽 inbox。 */
  isAssistant?: boolean;
}

export interface RegistryAgent extends AgentMeta {
  status: 'idle' | 'working' | 'blocked' | 'gone';
  lastSeen: number;
  /** 智能体的终端/PTY 标签页关闭后为 true。记录被保留（不删除）以使其
   *  历史/记忆得以存续；只有带活动 PTY 的智能体才算 'active'。广播扇出和
   *  名册读取会跳过已归档智能体。 */
  archived?: boolean;
  /** 人类正在与此智能体一对一协作，在人类将其切回之前 Michael 必须不打扰它。
   *  被持有的智能体保持 ACTIVE 并保留其终端 —— 这是「不要分派给它」，不是
   *  「它已消失」，所以它拥有自己的标志，而非复用 `archived` 或熔断等级。 */
  onHold?: boolean;
  /** 此智能体最近一次看到的 Claude Code session_id（Lane A #6.6a），
   *  从 hook 负载中捕获。兼任 `--resume` 键（崩溃/重启后可幂等恢复）以及
   *  每条 AgentUsageSample / cost-ledger 行的成本核算/去重键。 */
  sessionId?: string;
  /** `cwd` 是否真的可用于（重新）spawn —— 即一个存在且为目录的 ABSOLUTE
   *  路径。在 spawn 时计算并持久化，使名册能可靠地暴露每个工作进程的环境
   *  有效性。非绝对路径片段（如 "ClaudeTerminalHarness"）会 spawn 进一个
   *  不存在的目录而失败；此标志使之可见，而不是让它悄悄溜过。 */
  cwdValid?: boolean;
}

export interface Registry {
  godId: string | null;
  agents: Record<string, RegistryAgent>;
}

/** 构建让智能体进程具有 hive 感知能力的 env + 额外 spawn 参数。 */
export interface SpawnInjection {
  args: string[];
  env: Record<string, string>;
  /** 启动后要「键入」TUI 的 hive 协议种子，而不是通过 argv 传递 —— 仅对
   *  `seedDelivery:'type-into-tui'` 提供者（Crush）设置，其裸 TUI 会拒绝位置
   *  参数种子。渲染器通过与 inbox 唤醒提示相同的 per-pty 写入链将其键入。
   *  （ondev-b） */
  seedPrompt?: string;
  /** 当智能体以用户应当知晓的降级姿态 spawn 时设置（今天：代理桥接 sidecar
   *  在重试后仍未绑定，因此 Crush 这类代理层智能体将无 hive 事件运行）。
   *  人类可读，一行。 */
  degraded?: string;
}

const HOP_CAP = 12;

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/** 文件系统与排序安全的时间戳，例如 2026-05-30T14-03-11-123Z。 */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function shortRand(): string {
  return randomBytes(3).toString('hex');
}

/** `mempalace mine` 不得摄入的非记忆文件（Claude Code hooks 配置、光标、
 *  原始 inbox/outbox JSON）。`mempalace mine` 遵循 .gitignore，所以我们会在
 *  每个智能体目录放入一个；在诞生时写入，并由 mine 循环刷新。
 *
 *  把 `.codex/` 放在这里还有第二个原因，而且是关键的那个：Codex 工作进程的
 *  CODEX_HOME 位于其智能体目录内部（见 installCodexHooks —— Codex 只能通过
 *  它自己 home 里的 config.toml 获得 hooks，所以它无法共享用户的 ~/.codex）。
 *  于是 Codex 会用完整的会话转录、一个 80MB+ 的 logs sqlite 和插件缓存塞满
 *  那个文件夹，而 hive 的 git 仓库忠实地把所有内容的每个版本都纳入了版本控制。
 *  二十个 Codex 智能体把 hive 的 .git 撑到 7.5GB，此时 git 自身的 auto-gc 尝试
 *  重新打包，占用了 22GB 内存 —— 机器开始交换内存，应用停止响应。这些东西
 *  从未被需要进入历史：它是 Codex 的私有临时状态，并且无论哪种情况它都留在
 *  磁盘上（因此恢复仍可工作）。 */
/** 每次 spawn 时代理桥接 sidecar 的绑定尝试次数，以及每次重试前的停顿。 */
const PROXY_BIND_ATTEMPTS = 3;
const PROXY_BIND_BACKOFF_MS = [250, 750];

const MINE_IGNORE_LINES = ['settings.json', 'cursor.json', 'inbox/', 'outbox/', '.codex/'];

/** 幂等地确保 `<agentDir>/.gitignore` 排除非记忆文件。
 *  仅追加：只写入缺失的行，保留任何已有条目。 */
function ensureMineIgnore(agentDir: string): void {
  const path = join(agentDir, '.gitignore');
  let existing = '';
  try { if (existsSync(path)) existing = readFileSync(path, 'utf8'); } catch { return; }
  const have = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = MINE_IGNORE_LINES.filter((l) => !have.has(l));
  if (missing.length === 0) return;
  const prefix = existing && !existing.endsWith('\n') ? existing + '\n' : existing;
  try { writeFileSync(path, prefix + missing.join('\n') + '\n', 'utf8'); } catch { /* 尽力而为 */ }
}

/**
 * 在自由文本离开主进程前往语音/渲染器层之前，剥离形似机密的子串。这是
 * 语音读取层消息内容路径（`hive:messages`）的主进程侧隐私闸门：消息正文可能
 * 引用一个 key、粘贴一个令牌，或回显一个凭据，所以每个 body 和 subject 在
 * 跨越 IPC 之前都要经过这里。渲染器持有零脱敏策略 —— 它只接收已经清理过的
 * 字符串。
 *
 * 刻意保持保守：它匹配已知的凭据「形态」（提供者 key 前缀、JWT、PEM 私钥、
 * bearer 令牌）以及敏感的 key=value / key: value 赋值，然后将机密替换为
 * `[redacted]`。它不会按熵做全盘脱敏，因此简报所需的、对操作者有意义的
 * 内容 —— git SHA、智能体 id、文件路径、普通散文 —— 完整保留。过度脱敏
 * （如一个非机密的 `apikey:openai` 引用）是可接受的；泄漏真实机密则不可。
 *
 * 严格同步：下面的正则库在 test/voice-messages.test.cjs 中逐字符镜像（.cjs
 * 测试无法导入此 TS 模块）。如果你改了这里的某个模式，就在那里镜像它 ——
 * 正是该测试证明形似机密的值会被剥离。
 */
export function redactSecrets(text: unknown): string {
  if (typeof text !== 'string' || !text) return typeof text === 'string' ? text : '';
  let s = text;
  // 1. PEM 私钥块（RSA/EC/OPENSSH/PGP —— 从头到脚）。
  s = s.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[redacted]');
  // 2. JSON Web Tokens —— 由点分隔的三个 base64url 段。
  s = s.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '[redacted]');
  // 3. 已知的凭据前缀：OpenAI/Anthropic（sk-、sk-ant-）、Slack
  //    （xoxb/xoxp/xoxa/xoxr/xoxs-、xapp-）、GitHub（ghp_/gho_/ghu_/ghs_/ghr_、
  //    github_pat_）、AWS 访问密钥 id（AKIA…）、Google API 密钥（AIza…）。
  s = s.replace(
    /(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|xox[bpaors]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|gh[posru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,})/g,
    '[redacted]'
  );
  // 4. Bearer 令牌 —— 保留标签，丢弃凭据。
  s = s.replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]');
  // 5. 敏感 key = value / key: value —— 保留 key 名，丢弃值。
  //    可选命名空间前缀（aws_、gcp_、…）被并入捕获的 key，使带标签的机密
  //    能越过 \b 边界：`aws_secret_access_key` 全部是单词字符，所以裸的
  //    `\b(secret)\b` 永远看不到它。仅列出 secret_access_key / private_key
  //    不够 —— 正是前缀段让 `aws_secret_access_key=…`（值无 AKIA 形态）得以
  //    脱敏。
  s = s.replace(
    /\b((?:[a-z0-9]+[_-])*(?:api[_-]?key|secret[_-]?access[_-]?key|secret|token|password|passwd|pwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|signing[_-]?secret|webhook[_-]?secret|auth[_-]?token|bot[_-]?token|private[_-]?key))(\s*[:=]\s*)(["']?)[^\s"',}]{6,}\3/gi,
    (_m, k) => `${k}=[redacted]`
  );
  return s;
}

// ─── HiveManager ────────────────────────────────────────────────────────────

export class HiveManager {
  /**
   * @param getHome  懒解析 harnessHome，使 hive 跟随配置变化。
   * @param emit     面向渲染器事件的可选接收器（由主进程设为
   *                 `webContents.send`）。用于在办公楼层上动画化路由消息；
   *                 在测试/无头场景中为空操作。
   */
  constructor(
    private getHome: () => string | null,
    private emit?: (channel: string, payload: unknown) => boolean | void
  ) {}

  private routerTimer: NodeJS.Timeout | null = null;

  /** 内嵌 OTLP 收集器的回环 URL，由主进程在收集器绑定后设置（telemetry.ts）。
   *  null = 遥测关闭 → spawn 时不注入任何 OTel env（转录协调器仍是成本来源）。 */
  private _otelEndpoint: string | null = null;
  /** 让新 spawn 的智能体指向活动的遥测收集器。在收集器启动后调用；只影响
   *  之后进行的 spawn。 */
  setOtelEndpoint(url: string | null): void {
    this._otelEndpoint = url;
  }
  /** 智能体被指向的收集器 URL，遥测关闭时为 null。 */
  otelEndpoint(): string | null {
    return this._otelEndpoint;
  }

  /** 运行此 hive 的应用究竟是什么：它的版本，以及是打包构建还是本地开发运行。
   *
   *  智能体以前看不到这一点，而且它代价不菲。一次针对异常文件模式的多智能体
   *  调查进行了数小时，最后才发现原因是操作者退出了下载的构建并启动了本地
   *  构建 —— 本地构建继承启动 shell 的 umask，而非 Finder 的 022。没有智能体
   *  能观察到这一点，几个已发布的结论不得不撤回，log.jsonl 也没有任何应用
   *  启动标记能让人从两者中发现切换。 */
  private _runtime: { version: string; packaged: boolean; appPath?: string } | null = null;
  setRuntimeInfo(info: { version: string; packaged: boolean; appPath?: string } | null): void {
    this._runtime = info;
  }
  runtimeInfo(): { version: string; packaged: boolean; appPath?: string } | null {
    return this._runtime;
  }

  /** config.orchestratorMaySpawn 是否开启，在此镜像一份，使提示词构建器能决定
   *  是否告诉 god spawn 队列可用。在引导时和每次配置写入时设置；hive.ts 刻意
   *  不导入配置模块。 */
  private _maySpawn = false;
  setOrchestratorMaySpawn(on: boolean): void {
    this._maySpawn = on;
  }
  orchestratorMaySpawn(): boolean {
    return this._maySpawn;
  }

  // — 路径 —
  root(): string | null {
    const home = this.getHome();
    return home ? join(home, 'hive') : null;
  }
  enabled(): boolean {
    return this.root() !== null;
  }
  private agentDir(id: string): string {
    return join(this.root()!, 'agents', id);
  }
  /** cth-hook shim 通信的 IPC 端点（阶段 1 自治）。
   *  在 POSIX 上，这是 hive 根目录下的一个 Unix 域套接字文件。在 Windows 上，
   *  Node 的 `net` IPC 使用命名管道（平坦的 `\\.\pipe\` 命名空间，而非文件
   *  系统），所以裸文件路径会以 EACCES 绑定失败 —— 改为派生一个稳定的、
   *  按根目录的管道名。服务器（`listen`）和 shim（`createConnection`）都读取
   *  同一个值，因此它们保持同步。 */
  sockPath(): string | null {
    const root = this.root();
    if (!root) return null;
    if (process.platform === 'win32') {
      const id = createHash('sha1').update(root).digest('hex').slice(0, 12);
      return `\\\\.\\pipe\\munder-difflin-${id}`;
    }
    return join(root, 'hooks.sock');
  }
  private shimPath(): string | null {
    const root = this.root();
    return root ? join(root, 'bin', 'cth-hook.cjs') : null;
  }
  /** 代理桥接 sidecar（qwen）。纯 Node 回环反向代理，观察无 hook CLI 的 LLM
   *  流量，并合成 hook shim 发出的相同 HIVE_SOCK 负载。在 ensureHive 中与
   *  cth-hook.cjs 一并写入。 */
  private proxyShimPath(): string | null {
    const root = this.root();
    return root ? join(root, 'bin', 'hive-proxy.cjs') : null;
  }

  /**
   * BUNDLED-NODE 启动器：`<root>/bin/hive-node`（POSIX）/ `hive-node.cmd`
   * （Windows）。hive 中的每个 `.cjs` shim 都通过它执行。
   *
   * 为什么存在：hook 由智能体 CLI 通过一个裸的 `/bin/sh -c` 与精简的
   * `PATH=/usr/bin:/bin:/usr/sbin:/sbin` 运行。用户若从 nvm 获得 node
   * （PATH 仅由交互式登录 shell 设置），那里就没有 node，因此写为
   * `node "<shim>"` 的 hook 会以 **127 —— 找不到命令** 退出，每个负载都悄然
   * 丢失：没有实时状态、没有 Stop→inbox 清空、没有会话 id。Electron 自身的
   * 二进制在 `ELECTRON_RUN_AS_NODE=1` 下就是一个完整的 Node 运行时，并且它
   * 一定存在（就是我们）。
   *
   * 用包装脚本而非内联的 `ELECTRON_RUN_AS_NODE=1 "<exe>" …` 前缀，是因为该
   * 前缀是 POSIX-sh 语法 —— 在 cmd.exe 下是硬错误，而 cmd.exe 正是 Windows
   * 上运行 hook 命令的东西。包装脚本还给智能体一个可直接调用的 `$HIVE_NODE`
   * （不带环境变量地运行 Electron 二进制会启动第二个应用窗口，而非脚本）。
   *
   * 每次引导都会重写，因此应用更新/移动会重新烘焙 execPath。
   */
  private nodeLauncherPath(): string | null {
    const root = this.root();
    if (!root) return null;
    return join(root, 'bin', process.platform === 'win32' ? 'hive-node.cmd' : 'hive-node');
  }

  /** 写入上文所述的启动器。尽力而为：失败时调用方回退到裸 `node`，即
   *  与修复前完全一致的行为。 */
  private writeNodeLauncher(): void {
    const p = this.nodeLauncherPath();
    if (!p) return;
    try {
      if (process.platform === 'win32') {
        writeFileSync(p, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" %*\r\n`, 'utf8');
      } else {
        writeFileSync(p, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "$@"\n`, 'utf8');
        chmodSync(p, 0o755);
      }
    } catch (e) {
      console.error('[hive] writeNodeLauncher failed:', e);
    }
  }

  /** 实际存在于磁盘上的启动器路径，否则为 null（→ 调用方回退到裸 `node`，
   *  即与修复前完全一致的行为 —— 绝不会比以前更差）。 */
  private nodeLauncher(): string | null {
    const p = this.nodeLauncherPath();
    return p && existsSync(p) ? p : null;
  }

  /** 要「烘焙」进任何期望智能体运行的文本中的 ABSOLUTE bundled-node 命令
   *  （`<launcher> <script> …`），回退到裸 `node`。
   *
   *  恰为智能体 `HIVE_NODE` 环境变量的值 —— 但面向智能体的文本绝不能把它写成
   *  `$HIVE_NODE`：那是 POSIX shell 语法。Windows 智能体通过 cmd.exe/PowerShell
   *  运行其命令，在那里 `$HIVE_NODE` 会展开为 NOTHING（cmd）或一个未定义变量
   *  （PowerShell），所以每一条这样的指令在那里都形同虚设。绝对路径在所有平台上
   *  都正确，且完全无需展开。 */
  nodeCommand(): string {
    return this.nodeLauncher() ?? 'node';
  }

  /**
   * `<root>/bin/runtime` —— 与 `hive-node` 相同的 bundled-node 技巧，但包装
   * 脚本名为 `node`，因此任何从 PATH 解析 `node` 的东西都能找到一个。
   *
   * `hive-node` 只覆盖我们生成的命令。它对智能体自己工作所需的 node 毫无帮助：
   * 一个声明为 `node ./server.js` 的 MCP 服务器、一个 shell 到 node 的提供者
   * CLI、一个智能体自己编写的 `.cjs` 辅助脚本。在没有系统 node 的机器上，
   * 它们都像 hook 一样以 127 死掉。
   *
   * 此目录被 APPEND 到智能体的 PATH（见 pty.spawn），绝不前置：有自己的 node
   * 的用户会保留自己的版本 —— 我们严格只是回退。前置会悄然把每个智能体的
   * node 换成用户自己项目之下的 Electron node（Electron 32.3.3 的 20.18.1）。
   *
   * 注意：只有 `node` —— 刻意没有 `npm`/`npx`。Electron 打包的是 Node 运行时，
   * 不是 npm CLI（那是约 12MB 我们不随附的 JS），所以这里的 `npm` 包装只能是一
   * 个令人困惑地失败的桩。缺少 `npm` 是诚实的信号；安装阶梯
   * （main/cliInstall.ts）会检测并安装一个真正的系统 Node —— 它会带来 npm。
   * 此 shim 只是当安装无法运行时（离线，或没有官方安装程序平台）的最后手段。
   */
  runtimeBinDir(): string | null {
    const root = this.root();
    return root ? join(root, 'bin', 'runtime') : null;
  }

  /** 写入上文所述的 `node` shim。尽力而为：失败时该目录简单地不出现在
   *  PATH 中，行为与之前完全一致。 */
  private writeRuntimeShims(): void {
    const dir = this.runtimeBinDir();
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      if (process.platform === 'win32') {
        writeFileSync(
          join(dir, 'node.cmd'),
          `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" %*\r\n`,
          'utf8'
        );
      } else {
        const p = join(dir, 'node');
        writeFileSync(p, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "$@"\n`, 'utf8');
        chmodSync(p, 0o755);
      }
    } catch (e) {
      console.error('[hive] writeRuntimeShims failed:', e);
    }
  }

  /** 构建一条在保证的 node 下运行 `script` 的 hook 命令字符串，用双引号括起
   *  （对含空格路径安全）。 */
  private nodeRun(script: string, ...args: string[]): string {
    const launcher = this.nodeLauncher();
    return [launcher ? `"${launcher}"` : 'node', `"${script}"`, ...args].join(' ');
  }

  /** 同上，但不加引号 —— 用于其 hook 配置会弄坏内嵌引号的 CLI（cmd.exe 上的
   *  agy）或把命令存进引号敏感字面量的 CLI（codex 的单引号 TOML）。安全是因为
   *  hive 根目录与其内的启动器按构造均不含空格；这只保留各安装器现有的引用
   *  约定，同时把 `node` 换成捆绑运行时。 */
  private nodeRunUnquoted(script: string, ...args: string[]): string {
    return [this.nodeLauncher() ?? 'node', script, ...args].join(' ');
  }

  /** 每个活动代理层智能体对应一个代理 sidecar，以 agentId 为键。在
   *  ensureAgent 中 spawn，在 PTY 退出 / removeAgent / 应用退出时被杀（index.ts）
   *  —— 因此死掉的智能体绝不会泄漏一个孤儿回环监听器。 */
  private proxyChildren = new Map<string, ChildProcess>();

  // — 引导 —

  /** 如缺失则创建 hive 骨架 + git 仓库。幂等。 */
  ensureHive(): void {
    const root = this.root();
    if (!root) return;
    mkdirSync(join(root, 'agents'), { recursive: true });

    // 每次引导都刷新，正如下面的 COMMANDS.md。过去只在缺失时写入，这意味着
    // 一次创建的 hive 再也不会看到协议变更：这个仓库自己的 hive 仍带着创建
    // 当天的文件，所以此后每次协议新增都只到达新 hive。该文件是生成的、非
    // 用户编写，且智能体被指引以它为准，因此陈旧副本比重写更糟。
    writeFileSync(join(root, 'PROTOCOL.md'), PROTOCOL_MD, 'utf8');

    const registry = join(root, 'registry.json');
    if (!existsSync(registry)) {
      this.writeJson(registry, { godId: null, agents: {} } as Registry);
    }
    const userCodexHome = join(homedir(), '.codex');
    for (const [id, agent] of Object.entries(this.registry().agents)) {
      const codexHome = join(root, 'agents', id, '.codex');
      if (agent.provider === 'codex' && existsSync(codexHome)) {
        this.exposeCodexDataDirs(codexHome, userCodexHome, id);
      }
    }
    const board = join(root, 'board.md');
    if (!existsSync(board)) {
      writeFileSync(board, '# Hive board\n\n_Shared plans live here. The god agent is the scribe._\n', 'utf8');
    }
    const tasks = join(root, 'tasks.json');
    if (!existsSync(tasks)) this.writeJson(tasks, { tasks: [] });
    const log = join(root, 'log.jsonl');
    if (!existsSync(log)) writeFileSync(log, '', 'utf8');

    // Michael 查阅的 Claude Code 命令参考（每次引导刷新，以跟踪捆绑列表）。
    writeFileSync(join(root, 'COMMANDS.md'), COMMANDS_MD, 'utf8');

    // 让多变/临时的活动文件留在 hive git 仓库之外。
    const gitignore = join(root, '.gitignore');
    const want = ['fleet.json', 'hooks.sock', 'cost-ledger.jsonl', '.DS_Store'];
    let lines: string[] = [];
    if (existsSync(gitignore)) { try { lines = readFileSync(gitignore, 'utf8').split('\n'); } catch { lines = []; } }
    const missing = want.filter((w) => !lines.includes(w));
    if (missing.length) writeFileSync(gitignore, [...lines.filter(Boolean), ...missing].join('\n') + '\n', 'utf8');

    // hook shim：`claude` hook 与我们的 UDS 之间的一个哑管道。每次引导刷新
    // 以跟踪代码变更。
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(this.shimPath()!, HOOK_SHIM, 'utf8');
    // 用于无 hook CLI（qwen）的代理桥接 sidecar。相同刷新策略。
    writeFileSync(this.proxyShimPath()!, PROXY_BRIDGE_SHIM, 'utf8');
    // 上面每个 shim 都通过它调用的 bundled-node 启动器 —— 必须在任何 hook
    // 安装器运行前写入（它们会探测它）。
    this.writeNodeLauncher();
    // ……以及用于智能体自身子进程的、PATH 可见的 `node` 回退。
    this.writeRuntimeShims();

    if (!existsSync(join(root, '.git'))) {
      this.git(['init', '-q'], root);
      this.commit('hive: init');
    }
  }

  /** 像 spawn 那样校验智能体的 cwd —— 它必须是存在且为目录的 ABSOLUTE 路径。
   *  在注册表项上以 `cwdValid` 呈现，使名册能可靠地暴露工作进程的工作目录
   *  是否可用。尽力而为；绝不抛异常（stat 错误降级为无效）。 */
  private cwdValidity(cwd: string | undefined): { valid: boolean; issue: string | null } {
    if (!cwd || typeof cwd !== 'string') return { valid: false, issue: 'missing' };
    // 纵深防御：较旧注册表项中的 `~/…` cwd（在摄取期展开前写入）会永远
    // 被读成 'not-absolute'。先展开，使名册能报告 spawn 实际将使用的目录的
    // 真相。
    cwd = expandTilde(cwd);
    if (!isAbsolute(cwd)) return { valid: false, issue: 'not-absolute' };
    try {
      return statSync(cwd).isDirectory()
        ? { valid: true, issue: null }
        : { valid: false, issue: 'not-a-directory' };
    } catch {
      return { valid: false, issue: 'missing-dir' };
    }
  }

  /**
   * 确保一个智能体的工作区 + 注册表项，返回使进程具有 hive 感知能力的 spawn
   * 注入（提供者相关参数 + env）。
   */
  async ensureAgent(
    meta: AgentMeta,
    opts: {
      semanticMemory?: boolean;
      knowledgeGraph?: boolean;
      /** Knowledge-Graph CLI 的 ABSOLUTE 路径（`knowledge.env().KG_CLI`），烘焙
       *  进智能体提示词而非 `$KG_CLI` shell 引用 —— `$VAR` 仅限 POSIX，在
       *  cmd.exe/PowerShell 下展开为空，所以 KG 指令在 Windows 上不可用。
       *  可选：undefined 降级为旧的 env-var 拼写。 */
      kgCliPath?: string;
      theme?: 'light' | 'dark';
      /** 默认 MCP 包的同意状态（W3）。由调用方从实时 HarnessConfig 传入；
       *  undefined → 应用目录默认值。 */
      mcpDefaults?: { [id: string]: { enabled: boolean } };
      /** 应用资源 `skills/` 源目录（W3）。捆绑的只读技能在每次 spawn 时被
       *  复制进智能体的 `.claude/skills/`；undefined 或缺失为空操作（在 Kevin
       *  填充资源目录前容忍）。 */
      skillsDir?: string;
      /** 智能体沙盒可能写入的额外目录（例如共享的 MemPalace 目录，`mempalace`
       *  会改动它）。绝对路径；对无沙盒的提供者忽略。 */
      extraWritableDirs?: string[];
    } = {}
  ): Promise<SpawnInjection> {
    const root = this.root();
    if (!root) return { args: [], env: {} };
    this.ensureHive();

    const dir = this.agentDir(meta.id);
    mkdirSync(join(dir, 'inbox', '.done'), { recursive: true });
    mkdirSync(join(dir, 'outbox', '.sent'), { recursive: true });

    // 在写 identity.md 之前解析 role。重启会传入楼层名册的 `description`，
    // 它可能是状态标题（"on standby"）。identity.md 和 registry.role 才是雇佣
    // 时的持久职责。
    const reg = this.registry();
    const prev = reg.agents[meta.id];
    if (meta.cwd) meta = { ...meta, cwd: expandTilde(meta.cwd) };
    const role = preferredAgentRole(meta.role, prev?.role, !!meta.isGod);
    meta = { ...meta, role };

    const identity = join(dir, 'identity.md');
    writeFileSync(identity, this.identityText(meta), 'utf8'); // 每次 spawn 刷新

    // W3 —— 捆绑只读技能：每次 spawn 都从应用资源 skills/ 目录刷新智能体的
    // .claude/skills/（与 identity.md 同策略），使智能体始终携带随附的安全技能
    // 集。容忍：缺失或部分的源目录为空操作（Kevin 在 lp-manifest 中填充资源
    // 目录）。
    if (opts.skillsDir) this.copyBundledSkills(opts.skillsDir, join(dir, '.claude', 'skills'));

    const memory = join(dir, 'memory.md');
    if (!existsSync(memory)) {
      writeFileSync(memory, `# Memory — ${meta.name} (${meta.id})\n\n_Append durable facts, decisions, and context below._\n`, 'utf8');
    }
    ensureMineIgnore(dir); // 让 settings.json / cursor / 消息远离 mempalace 的索引
    const cursor = join(dir, 'cursor.json');
    if (!existsSync(cursor)) this.writeJson(cursor, { lastProcessed: null });

    // upsert registry —— 先展开 PRIOR 条目，使重新 spawn 能保留 spawn `meta`
    // 不携带的字段，尤其是 `sessionId`。没有它，ensureAgent（在 pty:spawn 处理器
    // 中的恢复查找之前运行）会抹掉已记录的会话 id，于是 `lastSession()` 返回
    // undefined，`--resume` 永远不会被附加 —— 即每次重启都会开一条全新线程。
    // 在源头校验工作目录，使坏值在名册上可见（cwdValid），而非悄悄 spawn 进
    // 一个不存在的目录。存储展开后的 cwd，绝不用用户键入的原始 `~/…` —— 注册表
    // 会被 hook、名册和 worker 监视器读取，它们都不运行 shell。
    const cwd = this.cwdValidity(meta.cwd);
    reg.agents[meta.id] = {
      ...prev,
      ...meta,
      capabilities: meta.capabilities ?? prev?.capabilities ?? [],
      role,
      status: 'idle',
      cwdValid: cwd.valid,
      // （重新）spawn 总是意味着活动终端 —— 清除任何先前的已归档标志。
      archived: false,
      lastSeen: Date.now()
    };
    if (meta.isGod) reg.godId = meta.id;
    this.atomicWriteJson(join(root, 'registry.json'), reg);

    this.appendLog({ kind: 'spawn', agentId: meta.id, name: meta.name, isGod: !!meta.isGod });
    // 仅在 cwd 无效时记录（罕见）—— 不是每次 spawn 一行，避免日志刷屏。
    if (!cwd.valid) {
      this.appendLog({ kind: 'cwd_invalid', agentId: meta.id, cwd: meta.cwd, issue: cwd.issue });
    }
    this.commit(`hive: register ${meta.id}`);

    const env: Record<string, string> = {
      AGENT_ID: meta.id,
      AGENT_NAME: meta.name,
      HIVE_ROOT: root,
      AGENT_DIR: dir
    };
    // bundled-node 启动器，使智能体即使 PATH 上没有 `node`，也能运行 hive 的
    // .cjs 辅助脚本（KG CLI、Slack 回复辅助）。直接调用 Electron 二进制会打开
    // 第二个应用窗口，所以必须保留包装路径，绝不能用 process.execPath。
    //
    // 保留为环境变量是为智能体便利以及任何以编程方式读取它的东西 —— 但面向
    // 智能体的 TEXT 不再按名字引用它：`$HIVE_NODE` 是仅 POSIX 的语法，在
    // cmd.exe / PowerShell 下展开为空，所以每一条此类指令在 Windows 楼层上都是
    // 死的。我们写给智能体运行的命令改为烘焙 `nodeCommand()` 的绝对路径。
    env.HIVE_NODE = this.nodeCommand();
    // 为自行绘制背景的 TUI 提供的通用明/暗提示。应用默认为浅色，但每个智能体
    // CLI 都假定是深色终端，所以 Crush 和 OpenCode 看起来像贴进了一个浅色窗口。
    // COLORFGBG 是经典的 "fg;bg" 约定（rxvt/konsole），lipgloss/termenv 在
    // OSC 11 查询得不到回答时会回退到它。Claude Code 通过其 per-session
    // settings.json（hookSettings）获得同样的提示；Crush 和 OpenCode 通过下面
    // 各自的 per-agent 配置目录。运行中的 TUI 不会重读此值：新智能体采用当前
    // 主题，运行中的则保留启动时的主题。
    if (opts.theme) env.COLORFGBG = opts.theme === 'dark' ? '15;0' : '0;15';

    const claudeProvider = isClaudeProvider(meta.provider ?? 'claude');

    // 非 hive 感知提供者（Antigravity 的 `agy`、OpenAI 的 `codex`、xAI 的
    // `grok`）不理解 Claude Code 的标志（没有 `--append-system-prompt`、没有
    // 遥测、没有 `--settings`）。改为：（1）hive 身份+协议作为会话的 INITIAL
    // 提示随行 —— 这些 CLI 提供的、最接近 `--append-system-prompt` 的东西
    // （第一轮之后会话正常继续）；以及（2）生命周期 hook 通过下面 preset 的
    // `hookBridge` 接入。二者结合使 Gemini/Codex worker 成为完全的 hive 公民 ——
    // 实时状态 + Stop→inbox 清空 —— 而根本无需安装 Claude。
    //
    // 提示随行方式因 CLI 而异：
    //  - agy 在标志下接收（`agy -i "<prompt>"`）→ 推 [flag, prompt]。
    //  - codex/grok 按 POSITIONAL 接收（`codex|grok "<prompt>"`）→ 把裸提示
    //    作为尾随参数推入（node-pty 按字面传递 argv，所以它在 codex 自己的
    //    标志之后作为一个位置参数到达）。
    if (!isHiveAwareProvider(meta.provider)) {
      const preset = providerPreset(meta.provider ?? 'claude');
      const flag = preset.initialPromptFlag;
      const prompt = this.injectedPrompt(meta, dir, root, opts.semanticMemory ?? false, opts.knowledgeGraph ?? false, opts.kgCliPath);
      // agy、codex 和 grok 暴露 Claude 风格的生命周期 hook 表面，所以每个都
      // 获得与 Claude 相同的实时状态 + Stop→inbox 清空 —— 由 preset 的
      // `hookBridge` 选择。agy 需要一个翻译 shim（其 hook stdin/stdout 形状
      // 与 Claude 不同）；codex 逐字复用 Claude 的 `cth-hook` shim（其 hook
      // 负载 + 响应契约已是 Claude 形状），并隔离到 per-agent CODEX_HOME，使
      // 用户的全局 Codex 配置永不被改动。两者都共享下面的 HIVE_SOCK 接线。
      const preArgs: string[] = [];
      let degraded: string | undefined;
      // 基于结构化桥接描述符分发（基座的 `bridgeOf` 从旧版 `hookBridge` 为
      // agy/codex 派生 {kind:'hooks'}，并为 qwen 返回显式 {kind:'proxy'}）。
      // 无 hook CLI 成为 hive 公民的两种方式：
      //   - 'hooks' → 安装配置文件 hook shim（agy 翻译器 / codex 逐字）。
      //   - 'proxy' → spawn 一个回环反向代理 sidecar，观察 CLI 的 LLM 流量并
      //               合成相同的 HIVE_SOCK 负载。
      const desc = bridgeOf(meta.provider);
      const sock = this.sockPath();
      if (desc && sock) {
        env.HIVE_SOCK = sock;
        try {
          if (desc.kind === 'hooks') {
            // 骨架钩子桥：Codex 是唯一仍使用 hooks 桥的 provider。
            if (desc.shim === 'codex') {
              env.CODEX_HOME = this.installCodexHooks(dir, meta.id);
              // Codex 拒绝在没有持久化「hook 信任」（通常是一道交互式闸门）的
              // 情况下从配置目录运行 hook。我们的 hooks.json 是在隔离的 CODEX_HOME
              // 内由 hive 编写的，所以我们为此自动化 spawn 绕过该闸门 —— 该标志
              // 的文档化用途就是「已审核 hook 来源的自动化」。没有它，hook 会悄然
              // 永不触发。必须位于位置参数提示之前。
              preArgs.push('--dangerously-bypass-hook-trust');
              // 自动模式保持 codex 的 OS 沙盒（`-a never -s danger-full-access`，
              // agentProvider.ts）。智能体文件夹（inbox/.done、memory.md、outbox）
              // 和共享 hive 根目录（研究交付物、god 的看板）通过 --add-dir 作为
              // 额外可写根加入。自动模式之外无害。（workspace-write 会在启动时
              // 拒绝 --add-dir，codex 0.151，所以 full-access 才是让 hive 文件夹
              // 可写的东西。）
              for (const d of this.sandboxWritableDirs(meta, dir, root, opts.extraWritableDirs)) preArgs.push('--add-dir', d);
            }
          } else if (desc.kind === 'proxy') {
            // 每次 spawn 的稳定会话 id，盖在每条合成负载上，使 recordSession
            // （注册表恢复键）与成本台账得以持久化。
            const spawnTs = String(Date.now());
            const sessionId = `proxy-${meta.id}-${createHash('sha1').update(root + meta.id + spawnTs).digest('hex').slice(0, 12)}`;
            env.HIVE_PROXY_SESSION = sessionId;
            // CLI 通常从 `baseUrlEnv` 读取其上游 base URL；捕获用户配置的值作为
            // sidecar 的 UPSTREAM，然后把 CLI 指向回环代理。用户未设置时回退到
            // 云默认。
            const upstream = process.env[desc.baseUrlEnv]
              || (desc.api === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1');
            // 端口 0 上的回环绑定只会在瞬时失败（忙碌时刻、sidecar 启动慢过
            // 4 秒上限），所以放弃前多试几次：没有这个，spawn 时一个坏瞬间
            // 就让智能体在整个会话中失去 hive 事件。
            const port = await this.startProxyBridgeWithRetry(meta.id, { sock, sessionId, api: desc.api, upstream });
            // 只有当 sidecar 实际绑定到端口时，才把 CLI 重定向到代理。失败时让
            // 路由保持原样 → CLI 直接与其真实上游通信（降级：无合成 hive 事件，
            // 但仍在运行）。刻意降级没问题；静默降级则不行，所以失败要写入
            // log.jsonl、渲染器和 spawn 结果。
            if (port > 0) {
              const loopback = `http://127.0.0.1:${port}`;
              // 唯一仍使用 proxy 桥的 provider 是 qwen——它从 baseUrlEnv
              // （OPENAI_BASE_URL）读取上游，因此把 CLI 重定向到回环 sidecar。
              env[desc.baseUrlEnv] = loopback;
            }
            else {
              degraded = `${meta.name} is running without hive events: its proxy bridge did not bind after ${PROXY_BIND_ATTEMPTS} attempts. Live status, cost and inbox wake will not work for this session. Respawn the agent to try again.`;
              console.error(`[hive] proxy bridge for ${meta.id} did not bind — spawning without hive events`);
              this.appendLog({ kind: 'proxy-degraded', agentId: meta.id, name: meta.name, provider: meta.provider, attempts: PROXY_BIND_ATTEMPTS });
              this.emit?.('hive:degraded', { agentId: meta.id, name: meta.name, reason: 'proxy-bind', message: degraded });
            }
          }
        } catch (e) { console.error(`[hive] install ${desc.kind} bridge failed:`, e); }
      }
      // 无论 CLI 以哪种方式接受，注入协议文本。
      // type-into-tui（Crush）：裸 TUI 会把位置参数当作 Cobra 子命令
      // → `Unknown command`。所以丢弃位置参数，把协议交回为 seedPrompt；
      // 渲染器在启动后将其键入 TUI（ondev-b）。
      const deg = degraded ? { degraded } : {};
      if (preset.seedDelivery === 'type-into-tui') return { args: [...preArgs], env, seedPrompt: prompt, ...deg };
      // 如果某提供者既无标志也无位置参数提示，就裸 spawn。
      if (flag) return { args: [...preArgs, flag, prompt], env, ...deg };
      if (preset.positionalInitialPrompt) return { args: [...preArgs, prompt], env, ...deg };
      return { args: preArgs, env, ...deg };
    }

    // 阶段 7A —— 第一方 Claude Code 遥测 → 内嵌回环 OTLP 收集器（telemetry.ts）。
    // 纯 env，不改 --settings。仅在收集器启动后（otelEndpoint 已设置）为
    // Claude Code 注入，因此遥测关闭的安装和非 Claude 提供者与之前完全一致。
    if (claudeProvider && this._otelEndpoint) {
      env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';
      env.OTEL_METRICS_EXPORTER = 'otlp';
      env.OTEL_LOGS_EXPORTER = 'otlp';
      env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json';
      env.OTEL_EXPORTER_OTLP_ENDPOINT = this._otelEndpoint;
      env.OTEL_METRIC_EXPORT_INTERVAL = '5000'; // 5 秒 —— 近乎实时且不刷屏
      env.OTEL_LOGS_EXPORT_INTERVAL = '2000';
      env.OTEL_RESOURCE_ATTRIBUTES = `agent.id=${meta.id},agent.name=${meta.name}`;
    }
    const args: string[] = [];
    if (!claudeProvider) return { args, env };

    args.push('--append-system-prompt', this.injectedPrompt(meta, dir, root, opts.semanticMemory ?? false, opts.knowledgeGraph ?? false, opts.kgCliPath));

    // 阶段 1 —— 自治：通过 --settings 附加生命周期 hook（不修改用户仓库），使
    // 智能体报告活动并在 Stop 时清空其 inbox。
    const sock = this.sockPath();
    const shim = this.shimPath();
    if (sock && shim) {
      env.HIVE_SOCK = sock;
      const settingsPath = join(dir, 'settings.json');
      this.writeJson(settingsPath, this.hookSettings(shim, meta.cwd, opts.mcpDefaults, opts.theme, this.sandboxWritableDirs(meta, dir, root, opts.extraWritableDirs)));
      args.push('--settings', settingsPath);
    }
    return { args, env };
  }

  /** 不重新 spawn 地更新持久职责字符串（雇佣角色）。刷新 registry.json +
   *  identity.md，使楼层编辑器和 hive 保持对齐。 */
  patchAgentRole(id: string, role: string): { ok: boolean; error?: string } {
    const root = this.root();
    if (!root) return { ok: false, error: 'hive disabled' };
    const next = role.trim();
    if (!next) return { ok: false, error: 'empty role' };
    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent) return { ok: false, error: '未知 agent' };
      if (agent.role === next) return { ok: true };
      agent.role = next;
      agent.lastSeen = Date.now();
      this.writeJson(join(root, 'registry.json'), reg);
      writeFileSync(join(this.agentDir(id), 'identity.md'), this.identityText(agent), 'utf8');
      this.appendLog({ kind: 'role', agentId: id, role: next });
      this.commit(`hive: role ${id}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * 翻转智能体的 archived 标志并持久化注册表。关闭终端标签页会归档智能体
   * （保留 + 标记，不删除）；（重新）spawn 会清除它。若智能体未注册或标志已
   * 按请求设置，则为空操作。尽力而为 —— 绝不抛异常，因此垂死的 PTY/kill
   * 处理器不会崩溃。
   */
  setArchived(id: string, archived: boolean): void {
    const root = this.root();
    if (!root) return;
    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent || agent.archived === archived) return;
      agent.archived = archived;
      agent.lastSeen = Date.now();
      this.atomicWriteJson(join(root, 'registry.json'), reg);
      this.appendLog({ kind: 'archive', agentId: id, archived });
      this.commit(`hive: ${archived ? 'archive' : 'unarchive'} ${id}`);
    } catch { /* 尽力而为 —— 绝不让生命周期处理器崩溃 */ }
  }

  /**
   * 在不改变其持久身份的情况下更改智能体的显示名。
   * 注册表键、智能体目录、会话 id 以及每个邮箱路径仍以 `id` 为键；只有
   * 面向人类的名称被更新。
   *
   * 在同一操作中修补 `fleet.json`，使 god 的下一个提示词立即收到新名称，
   * 而不是等待周期性的 fleet 刷新。
   */
  /**
   * 把智能体置于保留状态，或解除保留，并立即告知 Michael。
   *
   * 在同一操作中修补 `fleet.json`，理由与 `renameAgent` 相同：god 的名册
   * 在其下一个提示词时从该文件注入，而等待长达 8 秒的周期性刷新意味着又
   * 一次分派仍可能落到人类刚刚认领的人头上。
   */
  setAgentHold(id: string, hold: boolean): { ok: boolean; onHold?: boolean; error?: string } {
    const root = this.root();
    if (!root) return { ok: false, error: 'hive disabled (no harnessHome)' };
    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent) return { ok: false, error: '找不到 agent' };
      if (!!agent.onHold === hold) return { ok: true, onHold: hold };

      agent.onHold = hold;
      this.writeJson(join(root, 'registry.json'), reg);

      const fleetPath = join(root, 'fleet.json');
      if (existsSync(fleetPath)) {
        try {
          const fleet = this.readJson<{ agents?: Array<{ id?: string; onHold?: boolean }> }>(fleetPath, {});
          if (Array.isArray(fleet.agents)) {
            const row = fleet.agents.find((candidate) => candidate.id === id);
            if (row) { row.onHold = hold; this.writeJson(fleetPath, fleet); }
          }
        } catch { /* fleet 是缓存 —— 上面的注册表才是记录 */ }
      }
      this.appendLog({ kind: 'agent-hold', id, onHold: hold });
      return { ok: true, onHold: hold };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  renameAgent(id: string, name: string): { ok: boolean; name?: string; error?: string } {
    const root = this.root();
    if (!root) return { ok: false, error: 'hive disabled (no harnessHome)' };

    const nextName = name.trim();
    if (!nextName) return { ok: false, error: 'Name is required' };

    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent) return { ok: false, error: '找不到 agent' };
      if (agent.name === nextName) return { ok: true, name: nextName };

      const previousName = agent.name;
      agent.name = nextName;
      this.writeJson(join(root, 'registry.json'), reg);

      // fleet.json 是临时文件，可能还不存在。当它存在时，让它的显示名与注册表
      // 保持同步，使 rosterContext() 保持新鲜。
      const fleetPath = join(root, 'fleet.json');
      if (existsSync(fleetPath)) {
        try {
          const fleet = this.readJson<{ agents?: Array<{ id?: string; name?: string }> }>(fleetPath, {});
          if (Array.isArray(fleet.agents)) {
            const row = fleet.agents.find((candidate) => candidate.id === id);
            if (row) {
              row.name = nextName;
              this.writeJson(fleetPath, fleet);
            }
          }
        } catch { /* 周期性快照会修复损坏/过期的 fleet 文件 */ }
      }

      this.appendLog({ kind: 'rename', agentId: id, previousName, name: nextName });
      this.commit(`hive: rename ${id}`);
      return { ok: true, name: nextName };
    } catch {
      return { ok: false, error: '无法重命名 agent' };
    }
  }

  /**
   * 持久化智能体的 Claude Code session_id（Lane A #6.6a）。从 hook 负载捕获；
   * 仅在实际变化（新会话）时写入，因此在绝大多数 hook 事件上是空操作。该 id
   * 是崩溃/重启后幂等恢复的 `--resume` 键，也是成本样本的核算/去重键。
   * 尽力而为 —— 绝不向 hook 处理器抛异常。
   */
  recordSession(agentId: string, sessionId: string): void {
    const root = this.root();
    if (!root || !sessionId) return;
    try {
      const reg = this.registry();
      const agent = reg.agents[agentId];
      if (!agent || agent.sessionId === sessionId) return; // 未知 agent 或未变化 → 不写
      agent.sessionId = sessionId;
      agent.lastSeen = Date.now();
      this.atomicWriteJson(join(root, 'registry.json'), reg);
      this.appendLog({ kind: 'session', agentId, sessionId });
      this.commit(`hive: session ${agentId}`);
    } catch { /* 尽力而为——绝不使 hook 处理器崩溃 */ }
  }

  /** 某智能体最后已知的 session_id，或 undefined。用于构建 `claude --resume
   *  <id>` spawn，使重启的智能体恢复其线程。 */
  lastSession(agentId: string): string | undefined {
    return this.registry().agents[agentId]?.sessionId;
  }

  /** 把所有相关 hook 路由到 shim 的 Claude Code 设置，加上（W3）合并进此
   *  PER-SESSION 设置文件的默认 MCP 包。cwd 限定文件系统/git 服务器的范围；
   *  cfg（同意映射）决定写入哪些服务器。仅 Claude —— 只在 Claude spawn 路径上
   *  调用。 */
  /**
   * 沙盒智能体在 cwd 之外还可写入的目录：它自己的智能体文件夹（hive 内务）
   * 和 hive 根目录（研究交付物；god 的 board 和 tasks.json；outbox 投递由主进程
   * 完成，而非智能体）。正是这使自动模式能保持 OS 沙盒开启 —— 旧的完全绕过
   * 姿态存在只是因为这些路径位于项目 cwd 之外。
   */
  private sandboxWritableDirs(meta: AgentMeta, dir: string, root: string, extra?: string[]): string[] {
    const out = [dir, root, ...(extra ?? [])].filter((d) => typeof d === 'string' && d.length > 0);
    return Array.from(new Set(out));
  }

  private hookSettings(shim: string, cwd: string, cfg: McpDefaultsMap, theme?: 'light' | 'dark', writableDirs: string[] = []): unknown {
    // 捆绑 node，而非裸 `node` —— 见 nodeLauncherPath()。Claude 用精简 PATH 的
    // `sh -c` 运行每一条，那里 `node` 常缺失。
    const cmd = this.nodeRun(shim);
    const entry = (matcher?: string) => ({
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: 'command', command: cmd }]
    });
    const mcpServers = this.buildDefaultMcpServers(cwd, cfg);
    return {
      // 把 TUI 的 truecolor 调色板匹配到 harness 终端主题 —— 按会话，因此用户
      // 的全局 Claude 主题（应用之外的终端）永不被触碰。
      //
      // 'auto'，而非字面的 light/dark。钉死该值会在 SPAWN 时匹配主题，然后
      // 忽略此后每次变更：Claude Code 支持 DEC 2031 主题通知，但钉死的主题
      // 无需再考虑，于是切换应用会让运行中的智能体继续用旧调色板绘制其消息块
      // （奶油色终端上的黑色高亮）。'auto' 是倾听的值。CLI 一启用 2031，终端
      // 就立即报告当前主题，因此启动仍无需钉死任何东西即匹配。
      ...(theme ? { theme: 'auto' } : {}),
      // W3 —— 默认技能/MCP 包。只写进 PER-SESSION 设置文件（绝不写 ~/.claude），
      // 因此用户自己的 MCP 服务器永不被覆盖；Claude 以追加方式合并。为空时整体
      // 省略，使没有启用服务器的设置文件与之前一致。
      ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
      // 状态行在每次响应后获取会话状态 JSON —— 包括
      // context_window.{total_input_tokens,context_window_size}，这是会话真实
      // 上下文窗口唯一干净的程序化来源。shim 打印紧凑的终端内仪表，并把负载
      // 转发给 harness（智能体卡片上下文仪表、精确上限）。
      statusLine: { type: 'command', command: `${cmd} --status`, padding: 0 },
      // 面向 Bash 子进程的原生 OS 沙盒（macOS Seatbelt / Linux bubblewrap）。
      // 自动模式以 `--permission-mode bypassPermissions` spawn，那只会静默
      // 提示；沙盒是另一层可选层，从未被打开。已在线上验证（claude 2.1.239）：
      // 有此块时，bypass 模式仍写 cwd 和所列目录，但 `touch $HOME/x` 以
      // "Operation not permitted" 失败。需要两层：`sandbox.filesystem` 管辖
      // Bash 子进程，`permissions.additionalDirectories` 管辖 Edit/Write 工具；
      // 只给一层，智能体会在它自己的 inbox 上死锁。
      // failIfUnavailable 保持 false：没有沙盒的平台（Windows）按之前的方式
      // 运行，而非拒绝 spawn。
      ...(writableDirs.length
        ? {
            sandbox: { enabled: true, filesystem: { allowWrite: writableDirs } },
            permissions: { additionalDirectories: writableDirs }
          }
        : {}),
      hooks: {
        Stop: [entry()],
        SubagentStop: [entry()],
        PreToolUse: [entry('*')],
        PostToolUse: [entry('*')],
        UserPromptSubmit: [entry()],
        Notification: [entry()],
        SessionStart: [entry()],
        // #5C：暴露 `正在 /compact`，使正在打包上下文的智能体在楼层上显示为
        // 'compacting'，而不是看似冻结。
        PreCompact: [entry()],
        PostCompact: [entry()]
      }
    };
  }

  /**
   * W3 —— 从默认目录构建 per-agent `mcpServers` 映射。仅包含已启用的服务器
   * （目录 ∩ 同意），把 filesystem/git 限定到智能体 cwd（绝不整盘），并把每个
   * id 命名空间化为 `munder-<id>`，使用户自己的 ~/.claude 中同名服务器永不被
   * 覆盖。写/机密服务器仅当显式 `enabled:true` 同意时才包含 —— 绝不通过默认值
   * —— 这样损坏/部分的配置不会悄然武装一个带密钥的服务器。
   */
  private buildDefaultMcpServers(
    cwd: string,
    cfg: McpDefaultsMap
  ): Record<string, { command: string; args: string[]; env?: Record<string, string> }> {
    const out: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
    for (const e of MCP_CATALOG) {
      const consented = cfg?.[e.id]?.enabled;
      const enabled = consented ?? e.defaultEnabled;
      if (!enabled) continue;
      // 纵深防御：写/机密服务器要求显式选择加入；它永远不能靠默认值混入（目录
      // 已经把这些默认关闭，但这也守卫了手改/部分的 mcpDefaults 映射）。
      if (e.tier !== 'safe-readonly' && consented !== true) continue;
      // 在合并时把 `<cwd>` 占位符（filesystem/git）替换为智能体 cwd，使这些
      // 服务器严格限定在项目工作区内。
      const args = e.spec.args.map((a) => (a === '<cwd>' ? cwd : a));
      out[`munder-${e.id}`] = {
        command: e.spec.command,
        args,
        ...(e.spec.env ? { env: e.spec.env } : {})
      };
    }
    return out;
  }

  /**
   * W3 —— 从应用资源 `skills/` 目录刷新智能体的捆绑技能。镜像 `identity.md`：
   * 每次 spawn 覆盖，使随附的安全技能集跟随应用。尽力而为且完全容忍 —— 缺失/
   * 空源目录为空操作（Kevin 在 lp-manifest 中填充资源目录），任何 IO 错误都被
   * 吞掉，使技能供给绝不阻塞 spawn。
   */
  private copyBundledSkills(srcDir: string, destDir: string): void {
    try {
      if (!existsSync(srcDir)) return;
      const copyTree = (from: string, to: string): void => {
        const entries = readdirSync(from, { withFileTypes: true });
        if (!entries.length) return;
        mkdirSync(to, { recursive: true });
        for (const ent of entries) {
          const s = join(from, ent.name);
          const d = join(to, ent.name);
          if (ent.isDirectory()) copyTree(s, d);
          else if (ent.isFile()) copyFileSync(s, d);
        }
      };
      copyTree(srcDir, destDir);
    } catch (e) { console.error('[hive] copyBundledSkills failed:', e); }
  }

  /**
   * W1 —— 为无 hook 的代理层智能体（qwen）启动代理桥接 sidecar。
   * 在 Node 下 spawn `<root>/bin/hive-proxy.cjs`，它绑定一个回环端口，并在
   * stdout 上以一行 `{"port":N}` 回报。解析已绑定的端口（失败时为 0，因此调用方
   * 优雅降级，不重定向 CLI）。幂等：先杀掉该智能体任何先前的 sidecar，因此
   * 重新 spawn 绝不泄漏监听器。记录在 `proxyChildren` 中以备拆除。
   */
  /** startProxyBridge 带一个短重试阶梯。每次尝试都先杀掉之前的 sidecar
   *  （startProxyBridge 是幂等的），因此重试绝不泄漏监听器。解析已绑定的端口，
   *  或当每次尝试都失败后返回 0。 */
  private async startProxyBridgeWithRetry(
    agentId: string,
    cfg: { sock: string; sessionId: string; api: 'openai' | 'anthropic'; upstream: string }
  ): Promise<number> {
    for (let attempt = 1; attempt <= PROXY_BIND_ATTEMPTS; attempt++) {
      const port = await this.startProxyBridge(agentId, cfg);
      if (port > 0) return port;
      if (attempt < PROXY_BIND_ATTEMPTS) {
        console.warn(`[hive] proxy bridge for ${agentId} did not bind (attempt ${attempt}/${PROXY_BIND_ATTEMPTS}), retrying`);
        await new Promise((r) => setTimeout(r, PROXY_BIND_BACKOFF_MS[attempt - 1] ?? 1000));
      }
    }
    return 0;
  }

  private startProxyBridge(
    agentId: string,
    cfg: { sock: string; sessionId: string; api: 'openai' | 'anthropic'; upstream: string }
  ): Promise<number> {
    this.stopProxyBridge(agentId);
    const script = this.proxyShimPath();
    if (!script) return Promise.resolve(0);
    return new Promise<number>((resolve) => {
      let settled = false;
      const settle = (port: number): void => { if (!settled) { settled = true; resolve(port); } };
      let child: ChildProcess;
      try {
        child = spawn(process.execPath, [script], {
          env: {
            ...process.env,
            // 在 Electron 的捆绑 Node 下运行 .cjs，而不是作为第二个应用窗口。
            ELECTRON_RUN_AS_NODE: '1',
            HIVE_SOCK: cfg.sock,
            AGENT_ID: agentId,
            UPSTREAM_BASE_URL: cfg.upstream,
            HIVE_PROXY_SESSION: cfg.sessionId,
            HIVE_PROXY_API: cfg.api
          },
          // 从 stdout 读取端口行；绝不继承 stdio（sidecar 绝不能写入智能体的
          // 终端，也不能把请求体泄漏到日志）。
          stdio: ['ignore', 'pipe', 'ignore']
        });
      } catch (e) {
        console.error(`[hive] startProxyBridge spawn failed for ${agentId}:`, e);
        return settle(0);
      }
      this.proxyChildren.set(agentId, child);
      let buf = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (d: string) => {
        if (settled) return;
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        try {
          const msg = JSON.parse(buf.slice(0, nl));
          if (typeof msg.port === 'number' && msg.port > 0) settle(msg.port);
          else settle(0);
        } catch { settle(0); }
      });
      child.on('error', () => settle(0));
      child.on('exit', () => {
        if (this.proxyChildren.get(agentId) === child) this.proxyChildren.delete(agentId);
        settle(0); // 若 sidecar 在报告前死亡，绝不挂起 spawn
      });
      // 硬上限：若 sidecar 永不报告端口，降级而非挂起。
      setTimeout(() => settle(0), 4000).unref?.();
    });
  }

  /** 杀掉某智能体的代理 sidecar（若有）。幂等；绝不抛异常。 */
  stopProxyBridge(agentId: string): void {
    const child = this.proxyChildren.get(agentId);
    if (!child) return;
    this.proxyChildren.delete(agentId);
    try { child.kill(); } catch { /* 已消失 */ }
  }

  /** 杀掉所有活动代理 sidecar（应用退出）。尽力而为。 */
  stopAllProxyBridges(): void {
    for (const id of [...this.proxyChildren.keys()]) this.stopProxyBridge(id);
  }

  /**
   * 为 Stop hook 清空智能体的 inbox。返回是否要阻塞以继续，以及要回馈的
   * 消息文本。使用 per-agent 游标，使一条消息恰好呈现一次（无无限循环）。
   */
  drainForStop(agentId: string): { block: boolean; reason?: string } {
    const dir = this.agentDir(agentId);
    if (!existsSync(dir)) return { block: false };
    const cursorPath = join(dir, 'cursor.json');
    const cursor = this.readJson<{ lastProcessed: string | null }>(cursorPath, { lastProcessed: null });
    const fresh = this.inbox(agentId)
      .filter((m) => !cursor.lastProcessed || m.id > cursor.lastProcessed)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    if (fresh.length === 0) return { block: false };

    cursor.lastProcessed = fresh[fresh.length - 1].id;
    this.atomicWriteJson(cursorPath, cursor);
    this.appendLog({ kind: 'drain', agentId, count: fresh.length });

    const lines = fresh.map((m) => `- [from ${m.from}, ${m.act}] ${m.subject}: ${m.body}`).join('\n');
    const reason = [
      `You have ${fresh.length} new hive message(s) in your inbox. Address them before finishing:`,
      lines,
      // 原生分隔符（join，而非字符串拼接 `/`），使 Windows 智能体拿到的是其
      // 自身 shell/工具接受的路径，而非 `C:\…\agents\god/inbox/`。
      `Open the files in ${join(dir, 'inbox')} for full detail, act on each, then move handled ones to ${join(dir, 'inbox', '.done')}. Reply via your outbox if a message requires it.`
    ].join('\n');
    return { block: true, reason };
  }

  // — 面向智能体的文本 —

  private identityText(meta: AgentMeta): string {
    const caps = (meta.capabilities ?? []).join(', ') || '—';
    return [
      `# ${meta.name} (${meta.id})`,
      '',
      `- Role: ${meta.role ?? (meta.isGod ? 'orchestrator (god)' : 'agent')}`,
      `- Capabilities: ${caps}`,
      `- Working directory: ${meta.cwd}`,
      meta.isGod ? '- You are the **god / orchestrator**. You run the floor — keep awareness of the whole team, delegate execution, and personally own only the important calls (decomposition, sign-offs, conflicts, integration), not the grunt work.' : '',
      meta.isGod ? '- Monitor the team with `fleet.json` (live per-agent status/tokens/cost/breaker) and `registry.json`; full command reference in `COMMANDS.md`. `claude agents` does NOT list your hive siblings.' : '',
      ''
    ].filter(Boolean).join('\n');
  }

  /**
   * 通过 --append-system-prompt 注入到每次 spawn 的系统提示词前缀。
   *
   * 🔒 提示缓存不变量 —— 保持此前缀「无易变内容」。它只插值对一个智能体整个
   * 生命周期都稳定的值（name、id、dir、root、semanticMemory）。不要在此添加
   * 日期、UUID、计数器、board/registry 状态，或任何 `Date.now()` 派生的文本：
   * 每次 spawn 都变化的前缀会击穿 Anthropic 的提示缓存（每轮都重新播种整个
   * 系统提示词）。易变上下文应属于活动通道 —— inbox（hive 消息）和 PTY ——
   * 绝不烘焙进此前缀。（Lane A #6.1。）
   *
   * 🪟 无 SHELL 语法。这里的每条路径和命令都按智能体在它所运行平台上真正会
   * 键入的方式书写。这排除了两种曾是静默 Windows 专属故障的习惯：
   *  - `$VAR` —— 仅 POSIX。在 cmd.exe 下 `$HIVE_NODE`/`$KG_CLI` 展开为空，
   *    在 PowerShell 下展开为未定义变量，所以那些指令在每个 Windows 楼层上都
   *    是死的。改为烘焙 ABSOLUTE 解析后的路径：它平台无关、无需展开、且保持
   *    提示缓存稳定。
   *  - `'…' + '/inbox/'` —— 字符串拼接分隔符告诉 Windows 智能体去读
   *    `C:\Users\x\hive\agents\god/inbox/`。用 join()，使智能体自己的工具拿到
   *    可直接传给其 shell 的路径。
   */
  private injectedPrompt(
    meta: AgentMeta,
    dir: string,
    root: string,
    semanticMemory: boolean,
    knowledgeGraph: boolean,
    kgCliPath?: string
  ): string {
    // 原生分隔符路径助手——见上方 🪟 注释。
    const inDir = (...parts: string[]): string => join(dir, ...parts);
    const inRoot = (...parts: string[]): string => join(root, ...parts);
    // 在这里、该 agent 自身 spawn 时一次性解析——与上方 name/id/dir/root 相同、
    // 对提示缓存稳定的形状，而非每轮实时重读。
    // 仅供下方 PREP ASSISTANT persona 需要，它以散文方式用名字称呼 god；
    // god 自己的提示已经通过 `meta.name` 拿到名字。
    const godRegistry = meta.isAssistant ? this.registry() : null;
    const godNameForPrompt = godRegistry
      ? resolveGodName(godRegistry.agents[godRegistry.godId ?? 'god']?.name)
      : '';
    const ctxLine = 'LIVE CONTEXT: each agent row in the LIVE ROSTER carries a `ctx NN%` tag — its live context-window occupancy. Treat it as the real headroom signal when routing: prefer an agent with a LOW `ctx` for a big task; treat a HIGH `ctx` (near 100%) as busy rather than idle, even if the cumulative token count looks modest.';

    const memoryLine = semanticMemory
      // 宫殿位置是点名而不是 `$MEMPALACE_PALACE_PATH` 拼写：`mempalace` 自己
      // 读取那个环境变量，POSIX 的 `$` 形式对一个试图按字面使用它的 Windows
      // 智能体来说是噪音（或空展开）。
      ? 'Semantic memory: the whole hive shares a searchable MemPalace at the path in your MEMPALACE_PALACE_PATH environment variable. To recall relevant past knowledge across the team, run `mempalace search "<query>"`; run `mempalace wake-up` at the start of a task for a memory digest. Your notes in memory.md are mined into the palace automatically — write durable facts there.'
      : '';
    // 企业知识图谱（可选加入）。无易变内容：捆绑 node 启动器和 KG CLI 对一个
    // 安装来说都是固定绝对路径，所以烘焙它们既保持前缀提示缓存稳定，又让命令
    // 在 cmd.exe/PowerShell 以及 POSIX shell 中均可运行。
    const hiveNode = this.nodeCommand();
    const kgCli = kgCliPath || (process.platform === 'win32' ? '%KG_CLI%' : '$KG_CLI');
    const knowledgeLine = knowledgeGraph
      ? `Enterprise knowledge: this organisation has a private Knowledge Graph of its own documents, policies, and business context. When a task needs that context — company-specific facts, house style, internal processes — query it instead of guessing: run \`"${hiveNode}" "${kgCli}" search "<query>"\` for ranked passages, \`"${hiveNode}" "${kgCli}" list\` to see what is available, and \`"${hiveNode}" "${kgCli}" get <id>\` for a full document. (That first path is the harness's bundled Node — use it instead of bare \`node\`, which may not be on your PATH.)`
      : '';
    // 第 13 项：说明构建。智能体过去无法得知它们运行在哪个版本、甚至是哪种
    // 构建之中，所以任何在打包应用与本地开发运行之间变化的东西（umask 正是
    // 咬过我们的那个）对每项调查都不可见。
    const rt = this.runtimeInfo();
    const runtimeLine = rt
      ? `RUNNING BUILD: Munder Difflin v${rt.version}, ${rt.packaged ? 'packaged app' : 'local dev build'}${rt.appPath ? `, from ${rt.appPath}` : ''}. Say this version if asked which one is running, and do not assume behaviour from an older one. A local dev build inherits the launching shell's environment (umask included) where a packaged app does not, so file modes and inherited env can legitimately differ between the two. \`log.jsonl\` records an \`app-start\` event on every launch, which is how you spot a restart or a build switch.`
      : '';
    // 第 11 项：god 找不到 spawn 队列。该机制自 v0.4.4 起一直有效，但没有任何
    // 东西告诉他它存在 —— 提示词只说 "spawn" 没说怎么做，COMMANDS.md 和
    // PROTOCOL.md 都没有提到它，唯一的描述躺在一条源码注释里。于是他回退到写
    // 雇佣清单，那需要人类点击确认，看起来就像什么都没发生。由开关门控：宣传
    // 一条已禁用的路径比什么都不说更糟，而 COMMANDS.md 两种情况都记载了 ——
    // 用于操作者在 god 已运行后把它打开的情形。
    const spawnQueueLine = meta.isGod && this.orchestratorMaySpawn()
      ? `SPAWNING A WORKER: you can start an ephemeral worker yourself by writing ONE JSON file into ${inRoot('spawn-requests')}/<id>.json. Required: \`objective\` (what the worker must do) and \`cwd\` (the repo it runs in). Optional: \`name\`, \`command\`, \`provider\`, \`model\`, \`isolate\` (default true = its own git worktree), \`tokenCap\`, and \`slack\` ({channel, thread_ts}) to route its failures back to a thread. The harness polls that directory, spawns \`worker-<id>\`, and moves the request to \`spawn-requests/.done/\` on success or \`.failed/\` with a reason. This is the ONLY way you can spawn; a hire manifest under research/hires/ needs the human to confirm it in the UI, so it is not a route you can complete on your own. Reuse an existing agent first, as above — a worker is a fresh spend every time.`
      : '';
    const godLine = meta.isGod
      ? 'You are the GOD / ORCHESTRATOR of this hive — your job is to ORCHESTRATE, not to implement: maintain live situational awareness and delegate the work. (1) AWARENESS — always know what is going on: keep an accurate picture of every agent (active vs archived/idle), the task board, and all in-flight work; drain your inbox continually and triage every other agent\'s requests, answering clarifications so the team runs autonomously. (2) DELEGATE — decompose work and fan it out to the hive agents via their inboxes (route messages and assign owners; do not do their jobs); do NOT take on grunt implementation yourself. Stay aware of who is already on the floor and delegate OPPORTUNISTICALLY: BEFORE you spawn anything, CHECK THE LIVE ROSTER (active agents in registry.json + their state in fleet.json) and prefer routing to an EXISTING agent that fits — above all when the request names one ("ask Pam to…", "have Jim…"), route to that agent instead of reflexively creating a new one. Reuse an idle or already-running agent whose role matches; only spawn a fresh agent when no existing one is a sensible fit, and say that you checked. One capable owner beats a duplicate. (3) OWN ONLY THE IMPORTANT, high-leverage things — task decomposition, dispatch decisions, sign-offs, conflict resolution, branch integration, and final QA — and remain the sole scribe of board.md. You are otherwise fully autonomous — there is NO separate approval queue. For the genuinely critical (destructive actions, spending real money, scope changes, unresolvable conflicts), ask the human directly in your own session and let the tool-permission prompt gate the action; the human approves natively, including remotely from their phone via /remote-control. Keep the team unblocked. When you DISPATCH a task, write it as a 4-part contract so the agent can run autonomously: (1) OBJECTIVE — the concrete goal; (2) OUTPUT — the expected deliverable/format; (3) TOOLS — what to use or avoid, and any references to read instead of re-deriving; (4) BOUNDARIES — scope limits + the definition of done. Pass references (file paths, message ids, board sections), not pasted content — keep dispatches short.'
        + ` MONITOR the floor by reading ${inRoot('fleet.json')} (live per-agent tokens, cost, status, last tool, breaker level, inbox backlog) and ${inRoot('registry.json')} — note that running 'claude agents' will NOT list your hive's sibling agents. A full Claude Code command reference is at ${inRoot('COMMANDS.md')} (slash commands act ONLY on your own session; CLI commands run in your shell and can target the fleet). You periodically receive scheduler / "Heartbeat" standup requests — on each, review every agent via fleet.json, re-engage anyone stalled, over-budget, or breaker-armed, and keep board.md and tasks.json accurate. In tasks.json, ALWAYS set each task's "assignee" to the worker's agent id the moment you dispatch it, and NEVER clear it on status changes — a done card must still say who did the work (the human reads the board by who-did-what). HUMAN FEEDBACK is first-class in the ledger: when a task can only proceed with the human's input — a QUESTION to answer OR an ACTION only the human can perform (create an account, approve a purchase, provide credentials/screenshots, test on their device) — set its status to "blocked" and append the concrete ask to the card's "humanQA" array (push {"q":"...","askedAt":"<iso>"}; phrase actions as clear to-dos; keep every past entry — the history documents the card's decisions). WRITE THE ASK SHORT AND IN MARKDOWN. The human reads it on a CARD, not in a terminal, so an ask longer than a short paragraph plus its options (roughly 700 characters) is a report, not a question — cut the narrative, keep the decision. Open with ONE **bold** sentence saying exactly what you need from them; put paths, commands, values and identifiers in \`backticks\`; give each option or step its own "-" bullet or "1." number; leave a blank line between paragraphs (a single newline is a line break, so each option stays on its own line). When the ask originates in another agent's report, REWRITE it into that shape — never paste the report body in as the question, and never make the human read the investigation to find the decision. The harness surfaces open questions on the office floor's ASK ME board; the human's answer lands in the same entry ("a") AND arrives as an inbox message to you — read it, act on it, and unblock the card so work continues. Do NOT park human questions in separate files (no HumanQuestion.md) and never sit waiting on the human in your own session. Steward the token budget.`
      : meta.isAssistant
      ? `You are ${godNameForPrompt}'s PREP ASSISTANT. You will be handed short, possibly vague instructions (each begins with "ENRICH TASK:"). For each one: (1) figure out which project it concerns and cd into the most relevant repo — you start in ${godNameForPrompt}'s home directory; (2) gather concrete context READ-ONLY (exact file paths, current state, relevant code, conventions, active branch, gotchas) — NEVER modify, create, or delete files; (3) rewrite the instruction into ONE clear, self-contained prompt that ${godNameForPrompt} can execute autonomously, preserving the user's original intent without inventing scope. Then deliver it: write ONE message JSON into your outbox with "to":"god", "act":"request", a short subject, and the finished prompt as the body. Do NOT perform the task yourself — your only output is the improved prompt sent to ${godNameForPrompt}.`
      : 'For anything ambiguous, cross-cutting, or needing sign-off, address a message to "god".';
    const guardrailsLine = 'Guardrails: a circuit breaker watches the floor — a "Circuit breaker: steer/constrain" message means you are looping or overspending, so STOP repeating, summarize what you tried, and follow it. Be token-frugal (a floor-wide or per-agent token budget can pause you). The shared plan has two parts: board.md (freeform; god is the sole scribe) and tasks.json (structured kanban — todo/doing/blocked/done).';
    const slackLine = meta.isGod
      ? 'SLACK REPLIES: When composing a Slack reply (or writing the `result` field of a Slack-origin kanban card), you MUST: (1) directly address what the user asked — never a bare "done"; (2) include the relevant specifics, outcome, and details; (3) format for Slack mrkdwn — open with a short *bold* headline, use bullet points for multiple items, wrap code/paths in `backtick` blocks, keep it concise (no walls of text). When finishing a Slack-origin task, always write a complete, user-facing, well-formatted `result` on the kanban card — the system posts it verbatim to Slack as the done reply.'
      : `SLACK REPLIES: If god dispatches you a task that came from Slack, it will include an exact \`"${hiveNode}" "<helper>" --channel … --thread … --text "…"\` reply command — when you finish, run it VERBATIM to post your result back to that thread yourself. The reply must be SUBSTANTIVE Slack mrkdwn (a short *bold* headline + the actual outcome/specifics/links), NEVER a bare "done".`;
    return [
      `You are "${meta.name}" (${meta.id}), an autonomous agent in a collaborating hive of Claude agents.`,
      `Your private workspace is ${dir}. The shared hive is ${root}. Full protocol: ${inRoot('PROTOCOL.md')}.`,
      '',
      'HIVE PROTOCOL — follow it every task:',
      'LANGUAGE: communicate entirely in Simplified Chinese (简体中文). Write every report to god, every outbox message body, every task reply, and every conversation with the user or other agents in Simplified Chinese. Regardless of what language a task arrives in, your replies and all hive messages are in Chinese.',
      `1. At the START of a task, read ${inDir('memory.md')} and EVERY file in ${inDir('inbox')} (messages other agents sent you). After handling an inbox message, move its file into ${inDir('inbox', '.done')}.`,
      `2. Record durable facts, decisions, and context by appending to ${inDir('memory.md')}.`,
      `3. To ask another agent for something or share information, write ONE message JSON into ${inDir('outbox')} (schema in PROTOCOL.md). NEVER write into another agent's folder — the orchestrator delivers your outbox.`,
      '4. At the END of a task, append what you learned to memory.md so future-you remembers.',
      guardrailsLine,
      memoryLine,
      knowledgeLine,
      godLine,
      spawnQueueLine,
      runtimeLine,
      slackLine,
      ctxLine,
      `Env vars available to you: AGENT_ID, AGENT_NAME, HIVE_ROOT, AGENT_DIR.`
    ].filter(Boolean).join('\n');
  }

  // — 消息 —

  /** 把一条不完整消息规范化为完整的 HiveMessage。 */
  private normalize(partial: Partial<HiveMessage>, from: string): HiveMessage {
    const act = (partial.act ?? 'inform') as MessageAct;
    return {
      id: partial.id ?? `${stamp()}-${shortRand()}`,
      conversation: partial.conversation ?? `conv-${shortRand()}`,
      in_reply_to: partial.in_reply_to ?? null,
      from: partial.from ?? from,
      to: partial.to ?? 'god',
      act,
      subject: partial.subject ?? '',
      body: partial.body ?? '',
      hops: typeof partial.hops === 'number' ? partial.hops : 0,
      requires_reply: partial.requires_reply ?? ['request', 'query', 'propose'].includes(act),
      needs_human: partial.needs_human ?? false,
      created_at: partial.created_at ?? new Date().toISOString()
    };
  }

  /** 原子地把一条消息投递到收件人智能体的 inbox。
   *  当收件人没有 inbox 时返回 false，使调用方能退回并记录丢弃，而不是让消息
   *  凭空消失。 */
  private deliver(msg: HiveMessage, toId: string): boolean {
    const inbox = join(this.agentDir(toId), 'inbox');
    if (!existsSync(inbox)) return false; // 未知收件人 —— 由调用方报告
    this.atomicWriteJson(join(inbox, `${msg.id}.json`), msg);
    return true;
  }

  /** 直接注入一条消息（供编排器 / UI / 测试使用）。 */
  send(partial: Partial<HiveMessage>, from = 'system'): HiveMessage {
    const msg = this.normalize(partial, from);
    this.routeMessage(msg);
    this.commit(`hive: msg ${msg.from}→${msg.to} (${msg.act})`);
    return msg;
  }

  private routeMessage(msg: HiveMessage): void {
    if (msg.hops > HOP_CAP) {
      // 环路护栏 —— 丢弃失控消息，而不是让智能体互相乒乓。
      // 没有可回退的人类队列；god 智能体拥有冲突。
      this.appendLog({ kind: 'drop', reason: 'hop-cap', from: msg.from, to: msg.to, id: msg.id });
      return;
    }
    const reg = this.registry();
    const godId = reg.godId ?? 'god';
    // hive 没有独立的人类审批队列 —— 审批对每个智能体的 Claude Code 会话是
    // 原生的（并可远程批准）。发给 "human" 的消息由这里的 god/编排器（人类的
    // 代理）处理。
    const resolveTo = (to: string): string => (to === 'human' || to === 'god' ? godId : to);
    const targets = msg.to === 'broadcast'
      // 扇出的名册是 ACTIVE 注册表：跳过仅发送的预备助手和任何已归档智能体
      // （已关闭标签页）。无 hook 提供者不会被跳过 —— 下面的 per-target 路径
      // 已经给它们一份终端工作单，所以在这里排除它们只会让广播对一条直邮可达
      // 的智能体不可见。见 selectBroadcastTargets。
      ? selectBroadcastTargets(reg.agents, msg.from)
      // 绝不投递给自己 —— 阻止 god → "human" 消息回环到 god。
      : [resolveTo(msg.to)].filter((t) => t !== msg.from);
    // 实际接收投递的目标。下面的日志报告这些而非意图，因此退回或丢弃的消息
    // 永远不能被读成已投递。
    const delivered: string[] = [];
    for (const t of targets) {
      // 仅发送的预备助手绝不能成为投递目标：它不清空 inbox，所以直邮给它会在
      // 那里腐烂无人读（线上观察：一份任务简报加上一封关于未读 inbox 的后续
      // 训斥邮件，两者都数小时未读）。改为把此类邮件退回给 god，使发送者的
      // 意图立即呈现，且没有东西被悄然丢失。
      if (reg.agents[t]?.isAssistant) {
        this.deliver({
          ...msg,
          to: godId,
          subject: `[bounced — "${t}" is the send-only prep assistant; route work to a real agent] ${msg.subject}`
        }, godId);
        continue;
      }
      // 没有安全空闲生命周期状态的 provider（一个无 hook 的自定义命令）会让
      // 直接邮件烂在未读里。Claude 与桥接的 Antigravity/Codex 直接收进 inbox/，
      // 由渲染进程受控投递。否则先尝试把终端工作单移交给其 REPL（#53）；
      // 如果渲染进程不可用，则弹回给 god 转达。god 豁免（它就是弹回目标）。
      //
      // 链路修复（#link-fix）：terminal 型 worker 此前只走 emitTerminalHandoff、
      // 不落收件箱文件 → inboxCount 恒为 0 → workerWake 看门狗永不唤醒它们。
      // 改为双通道：既落收件箱文件（看门狗以 inboxCount>0 为唤醒条件），也尽力
      // 发射 terminalHandoff（渲染端可见时的即时通道）。收件箱文件是权威——渲染
      // 进程后台/节流或事件丢失时，worker 醒来读 inbox 仍能拿到消息并归档。
      if (t !== godId && !canReceiveInbox(reg.agents[t]?.provider)) {
        const inboxed = this.deliver(msg, t);
        const handed = this.emitTerminalHandoff(msg, t);
        if (inboxed || handed) { delivered.push(t); continue; }
        this.deliver({
          ...msg,
          to: godId,
          subject: `[undeliverable — "${t}" runs ${reg.agents[t]?.provider ?? 'a hookless CLI'} and the terminal handoff failed (renderer unavailable); relay this to it] ${msg.subject}`
        }, godId);
        continue;
      }
      // 1d —— 代理层提供者（qwen）能接收 inbox，但只能通过合成的 Stop，它只推进
      // 游标 —— sidecar 观察 CLI 的流，无法把清空理由注入回它的回合。所以真实
      // 邮件逐字走终端工作单路径，与无 hook 提供者完全一样；合成的 Stop→清空
      // 让游标保持同步。
      //
      // 链路修复（#link-fix）：与上面分支一致，双通道投递——收件箱文件落盘
      // （workerWake 看门狗以 inboxCount>0 为唤醒条件）+ 尽力 terminalHandoff。
      // 与合成 Stop 推进游标（drainForStop）不冲突：游标只记录已呈现的消息，
      // 收件箱文件是持久权威，worker 醒来按协议读 inbox 并归档即可。
      const proxyDesc = bridgeOf(reg.agents[t]?.provider);
      if (t !== godId && proxyDesc?.kind === 'proxy' && proxyDesc.inboxDelivery === 'terminal') {
        const inboxed = this.deliver(msg, t);
        const handed = this.emitTerminalHandoff(msg, t);
        if (inboxed || handed) { delivered.push(t); continue; }
        this.deliver({
          ...msg,
          to: godId,
          subject: `[undeliverable — "${t}" runs ${reg.agents[t]?.provider ?? 'a proxy-tier CLI'} and the terminal handoff failed (renderer unavailable); relay this to it] ${msg.subject}`
        }, godId);
        continue;
      }
      if (this.deliver(msg, t)) { delivered.push(t); continue; }
      // 没有 agents/<t>/inbox —— 一个不在楼层上的 id。这是唯一既无退回也无日志
      // 的投递失败：发送者看到已路由的消息，而邮件就这么不存在了。把这个丢弃
      // 记录在 hop-cap 那条旁边，并像上面那些无法投递的退回一样退回给 god。
      this.appendLog({ kind: 'drop', reason: 'no-inbox', from: msg.from, to: t, id: msg.id });
      if (t !== godId) {
        this.deliver({
          ...msg,
          to: godId,
          subject: `[undeliverable — no agent "${t}" on this floor; check the id against the roster] ${msg.subject}`
        }, godId);
      }
    }
    this.appendLog({ kind: 'message', from: msg.from, to: msg.to, act: msg.act, subject: msg.subject, id: msg.id, delivered });
    this.emitMessage(msg, targets);
    // 主进程观察者（例如监视团队 ACK 和 god 的 COMPLETE 的收尾控制器）。
    // 尽力而为，绝不破坏路由。
    try { this.routedObserver?.(msg, targets); } catch { /* 观察者错误 */ }
  }

  /** 针对每条已路由消息及其解析后的目标调用的观察者。
   *  供对 hive 流量作出反应的主进程特性使用（收尾时间）。 */
  private routedObserver: ((msg: HiveMessage, targets: string[]) => void) | null = null;
  setRoutedObserver(cb: ((msg: HiveMessage, targets: string[]) => void) | null): void {
    this.routedObserver = cb;
  }

  /** 告知渲染器一条消息已路由，及其解析后的收件人，使楼层可以从发送者向每个
   *  收件人飞一个信封。尽力而为。 */
  private emitMessage(msg: HiveMessage, targets: string[]): void {
    this.emit?.('hive:message', {
      id: msg.id,
      from: msg.from,
      to: msg.to,
      act: msg.act,
      subject: msg.subject,
      targets,
      // 对智能体标记给人类（现已路由到 god 代理）的消息给楼层信封上珊瑚色。
      // 仅装饰 —— 背后没有队列。
      needsHuman: msg.to === 'human'
    });
  }

  /** 非 Claude 提供者无法清空 hive inbox；把直邮交给渲染器，使其能为目标 PTY
   *  排队一份终端工作单。 */
  private emitTerminalHandoff(msg: HiveMessage, targetId: string): boolean {
    const delivered = this.emit?.('hive:terminalHandoff', {
      id: msg.id,
      from: msg.from,
      to: targetId,
      act: msg.act,
      subject: msg.subject,
      body: msg.body,
      requiresReply: msg.requires_reply,
      createdAt: msg.created_at
    }) === true;
    this.appendLog({
      kind: 'terminal-handoff',
      from: msg.from,
      to: targetId,
      act: msg.act,
      subject: msg.subject,
      id: msg.id,
      delivered
    });
    return delivered;
  }

  // — 路由器：清空 outboxes → inboxes —

  /** 基于轮询的路由器。廉价且稳健，规避 macOS 上 fs.watch 的怪癖。 */
  startRouter(intervalMs = 1500): void {
    if (this.routerTimer || !this.enabled()) return;
    this.routerTimer = setInterval(() => {
      try { this.routeOnce(); } catch { /* 让循环保持存活 */ }
    }, intervalMs);
  }
  stopRouter(): void {
    if (this.routerTimer) { clearInterval(this.routerTimer); this.routerTimer = null; }
  }

  routeOnce(): number {
    const root = this.root();
    if (!root) return 0;
    const agentsDir = join(root, 'agents');
    if (!existsSync(agentsDir)) return 0;
    let routed = 0;
    for (const id of readdirSync(agentsDir)) {
      const outbox = join(agentsDir, id, 'outbox');
      if (!existsSync(outbox)) continue;
      for (const f of readdirSync(outbox)) {
        if (!f.endsWith('.json')) continue;
        const full = join(outbox, f);
        try {
          const partial = JSON.parse(readFileSync(full, 'utf8')) as Partial<HiveMessage>;
          const msg = this.normalize(partial, id);
          msg.from = id; // 发送者是权威 —— 所属目录
          this.routeMessage(msg);
          renameSync(full, join(outbox, '.sent', f)); // 归档，不重新处理
          routed++;
        } catch {
          // 损坏文件 —— 隔离，避免我们反复处理它
          try { renameSync(full, join(outbox, '.sent', `bad-${f}`)); } catch { /* 空操作 */ }
        }
      }
    }
    if (routed > 0) this.commit(`hive: routed ${routed} message(s)`);
    return routed;
  }

  // — 读取辅助（供 IPC / UI）—

  registry(): Registry {
    const root = this.root();
    if (!root) return { godId: null, agents: {} };
    return this.readJson<Registry>(join(root, 'registry.json'), { godId: null, agents: {} });
  }
  board(): string {
    const root = this.root();
    return root && existsSync(join(root, 'board.md')) ? readFileSync(join(root, 'board.md'), 'utf8') : '';
  }
  tasks(): unknown {
    const root = this.root();
    return root ? this.readTasks() : { tasks: [] };
  }

  /**
   * 读取 tasks.json 并规范化为 { tasks: [...] } 形状。god 手写该文件时
   * 历史上曾写成顶层裸数组（导致 UI parseTasks 返回空、看板空白）。这里
   * 兜底：若顶层是数组则自动包成 { tasks }，让读路径永远拿到统一结构，
   * 从而 add/patch/delete 也不会基于空列表重写而真清空。
   */
  private readTasks(): { tasks?: unknown[] } {
    const root = this.root();
    if (!root) return { tasks: [] };
    const path = join(root, 'tasks.json');
    const raw = this.readJson<unknown>(path, { tasks: [] });
    if (Array.isArray(raw)) return { tasks: raw };
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'tasks' in raw) {
      const t = raw.tasks;
      return { tasks: Array.isArray(t) ? t : [] };
    }
    return { tasks: [] };
  }

  /** 把任务台账持久化到 hive/tasks.json 并提交它。镜像 board/message 的
   *  持久化模式：写 JSON、记录变更、单次提交。
   *
   *  按卡片 id 合并，而非整体覆盖。调用方持有卡片的 PARTIAL 模型 —— 渲染器的
   *  看板解析器知道九个字段，god 按工作需要写多少就写多少（`result`、回贴给
   *  用户的逐字 Slack 回复；`repo`；`scope`；`origin`；`commit`；…）。整体写入
   *  意味着通过 UI 做一次小编辑就会删除看板上每张卡片的每个未建模字段。现在
   *  未提及的字段保留其在磁盘上的值。
   *
   *  删除卡片仍然有效：传入列表就是成员关系，所以从中移除的卡片
   *  （TasksKanban 关闭、语音 delete_task 动作）就消失了。合并保护字段，
   *  从不保护卡片成员关系。 */
  writeTasks(tasks: HiveTask[]): void {
    const root = this.root();
    if (!root) return;
    // 防真清空/防结构损坏：入站必须是非空合法数组（每张卡含 id）。
    // 若调用方传入空数组或非数组（如基于被写坏的裸数组/空列表重写），
    // 拒写并告警，绝不静默覆盖磁盘上已有的台账。
    if (!Array.isArray(tasks) || tasks.length === 0 || !tasks.every((t) => t && typeof t.id === 'string' && t.id)) {
      this.appendLog({ kind: 'tasks-guard', count: Array.isArray(tasks) ? tasks.length : -1, reason: 'write-guard: invalid or empty task list rejected' });
      return;
    }
    this.ensureHive();
    const path = join(root, 'tasks.json');
    const current = this.readTasks();
    const merged = mergeTaskLedger(current?.tasks, tasks);
    this.writeJson(path, { tasks: merged });
    this.appendLog({ kind: 'tasks', count: merged.length });
    this.commit(`hive: tasks (${merged.length})`);
  }

  /** 针对最新磁盘台账追加一张卡片。渲染器调用方必须用这个，而不是重写它们在
   *  另一个来源（webhook、Slack、god、语音）加入工作之前读到的集合。按任务 id
   *  幂等。 */
  addTask(task: HiveTask): boolean {
    const ledger = this.tasks() as { tasks?: HiveTask[] };
    const tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
    if (tasks.some((current) => current?.id === task.id)) return false;
    this.writeTasks([...tasks, task]);
    return true;
  }

  /** 针对最新磁盘台账修补一张卡片，保留无关的卡片和字段（尤其是 webhook.
   *  tokenHash 和 Slack 线程元数据）。 */
  patchTask(id: string, patch: Partial<Omit<HiveTask, 'id'>>): boolean {
    const ledger = this.tasks() as { tasks?: HiveTask[] };
    const tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
    const index = tasks.findIndex((task) => task?.id === id);
    if (index < 0) return false;
    const next = tasks.slice();
    next[index] = { ...tasks[index], ...patch, id };
    this.writeTasks(next);
    return true;
  }

  /** 只从最新磁盘台账删除指定卡片。 */
  deleteTask(id: string): boolean {
    const ledger = this.tasks() as { tasks?: HiveTask[] };
    const tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
    const next = tasks.filter((task) => task?.id !== id);
    if (next.length === tasks.length) return false;
    this.writeTasks(next);
    return true;
  }
  memory(id: string): string {
    const p = join(this.agentDir(id), 'memory.md');
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  }
  /** 某智能体是否记录了非平凡的记忆 —— 即在 ensureAgent 播种的样板头部之外
   *  追加了真实笔记。让语音读取层能回答「团队记住了什么」并枚举谁有值得读的
   *  内容（每个已注册智能体技术上都有一份 memory.md，但楼层的大部分历史活在
   *  其中少数几份里）。廉价：读一个小的 markdown 文件；绝不抛异常。对任意 id
   *  有效，active 或 archived 都行。 */
  hasMemory(id: string): boolean {
    const p = join(this.agentDir(id), 'memory.md');
    if (!existsSync(p)) return false;
    try {
      // 新鲜种子约 90 字符（一行头部 + 提示）。任何明显更长的都意味着智能体
      // 追加了持久事实。
      return readFileSync(p, 'utf8').trim().length > 200;
    } catch { return false; }
  }
  inbox(id: string): HiveMessage[] {
    return this.listMessages(join(this.agentDir(id), 'inbox'));
  }
  /** 读取某智能体的 OUTBOX（它撰写/发送的消息）。与 inbox() 对称；路由器会把
   *  活动的 outbox 文件清空进收件人的 inbox，并把原件归档到 outbox/.sent 下，
   *  因此已发送消息在那里保留。 */
  outbox(id: string): HiveMessage[] {
    return this.listMessages(join(this.agentDir(id), 'outbox'));
  }

  /**
   * 语音读取层：最近消息内容（inbox + outbox 正文），供操作员简报，主进程侧
   * 已 REDACTED。这是语音查询面的消息内容一半（活动一半是 logTail()）。
   *
   * 模式：
   *   - { id }                → 拥有该 id 的唯一条消息，无论它在哪。
   *   - { agentId }           → 只读那个智能体邮箱里的最近消息。
   *   - {}                    → 整个楼层上的最近消息，最新在前。
   * `limit` 限制列表（默认 12，最大 40）；`includeArchived`（默认 true）也读取
   * 已处理子文件夹（inbox/.done、outbox/.sent）。
   *
   * 安全：每个 subject + body 都在这里、在主进程内经过 redactSecrets()，因此
   * 没有机密也没有原始正文会跨越 IPC。已投递消息同时存在于发送者的
   * outbox/.sent 和收件人的 inbox/.done；我们按消息 id 去重，使每条只出现一次。
   */
  voiceMessages(opts: { agentId?: string; id?: string; limit?: number; includeArchived?: boolean } = {}): VoiceMessage[] {
    const root = this.root();
    if (!root) return [];
    const agentsDir = join(root, 'agents');
    if (!existsSync(agentsDir)) return [];

    const wantId = typeof opts.id === 'string' ? opts.id.trim() : '';
    const onlyAgent = typeof opts.agentId === 'string' ? opts.agentId.trim() : '';
    const includeArchived = opts.includeArchived !== false; // 默认为 true

    let owners: string[];
    try {
      owners = onlyAgent
        ? [onlyAgent]
        : readdirSync(agentsDir).filter((id) => !id.startsWith('.') && existsSync(this.agentDir(id)));
    } catch {
      return [];
    }

    const seen = new Set<string>();
    const out: VoiceMessage[] = [];
    for (const owner of owners) {
      const base = this.agentDir(owner);
      const folders: Array<{ dir: string; direction: 'inbox' | 'outbox'; archived: boolean }> = [
        { dir: join(base, 'inbox'), direction: 'inbox', archived: false },
        { dir: join(base, 'outbox'), direction: 'outbox', archived: false }
      ];
      if (includeArchived) {
        folders.push({ dir: join(base, 'inbox', '.done'), direction: 'inbox', archived: true });
        folders.push({ dir: join(base, 'outbox', '.sent'), direction: 'outbox', archived: true });
      }
      for (const f of folders) {
        for (const m of this.listMessages(f.dir)) {
          if (!m || typeof m.id !== 'string' || seen.has(m.id)) continue;
          seen.add(m.id);
          if (wantId && m.id !== wantId) continue;
          out.push({
            id: m.id,
            conversation: m.conversation,
            from: m.from,
            to: m.to,
            act: m.act,
            subject: redactSecrets(m.subject),
            body: redactSecrets(m.body),
            requires_reply: !!m.requires_reply,
            direction: f.direction,
            owner,
            archived: f.archived,
            created_at: m.created_at
          });
        }
      }
    }

    // 按 ISO created_at 最新在前（对 ISO-8601 字典序 == 时间序）。
    out.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    if (wantId) return out.slice(0, 1);
    const lim = typeof opts.limit === 'number' && isFinite(opts.limit)
      ? Math.max(1, Math.min(40, Math.round(opts.limit)))
      : 12;
    return out.slice(0, lim);
  }
  /** 统计某智能体未清空的 inbox 消息数（廉价 —— 供 fleet 快照使用）。 */
  inboxBacklog(id: string): number {
    const dir = join(this.agentDir(id), 'inbox');
    if (!existsSync(dir)) return 0;
    try { return readdirSync(dir).filter((f) => f.endsWith('.json')).length; } catch { return 0; }
  }


  /** Codex 生命周期 hook 桥 → 让 `codex` worker 获得完整 hive 对等能力（实时
   *  状态 + Stop→inbox 排空）。
   *
   *  Codex 的 hook 契约已经是 Claude 形状：snake_case 的 stdin
   *  （hook_event_name/tool_name/tool_input/session_id/cwd）与匹配的响应契约，
   *  其中 `Stop` 尊重 {decision:'block',reason}，意思是「继续，把 reason 用作下一条
   *  提示」——正是 drainForStop() 返回的东西。所以我们逐字复用 Claude 的
   *  `cth-hook` 垫片（不像 agy 那样需要翻译器），让 HookServer 原样处理一切。
   *
   *  隔离：不改动用户的全局 Codex 配置（其中还存有他们的登录），而是把这个
   *  worker 指向一个 PER-AGENT CODEX_HOME（`<dir>/.codex`，与 Claude 的
   *  settings.json 并列），其中存放我们自己的带 `[hooks]` 表的 config.toml——
   *  于是 hook 只对 hive worker 触发，个人的 `codex` 运行不受打扰。Rollout 目录
   *  从标准全局扫描根下的带命名空间路径链接进那个隔离 home。用户的
   *  ~/.codex/auth.json 被链接进来，其 config.toml 被复制并扩展
   *  （login + model/provider/trust 设置仍然生效）。
   *  返回 CODEX_HOME 路径，供调用方放进 worker 的 env。 */
  private installCodexHooks(dir: string, agentId: string): string {
    const home = join(dir, '.codex');
    try {
      mkdirSync(home, { recursive: true });
      const userHome = join(homedir(), '.codex');
      // 符号链接用户的登录，让隔离 home 以他们的身份认证。
      // （config.toml 不符号链接——我们在下面写入自己的，以他们的为种子，
      // 因为它必须携带我们的 [hooks] 表。）在符号链接需要特权（Windows）时
      // 回退为复制。幂等——已链接则跳过。
      const authSrc = join(userHome, 'auth.json');
      const authDest = join(home, 'auth.json');
      if (existsSync(authSrc) && !existsSync(authDest)) {
        try { symlinkSync(authSrc, authDest); }
        catch { try { copyFileSync(authSrc, authDest); } catch { /* 尽力而为 */ } }
      }
      // Codex Remote Control 使用的受管 app-server 守护进程从根在
      // $CODEX_HOME/packages 的独立安装启动。共享用户已安装的二进制，
      // 而不复制进每个 agent。
      const packagesSrc = join(userHome, 'packages');
      const packagesDest = join(home, 'packages');
      if (existsSync(packagesSrc) && !existsSync(packagesDest)) {
        try {
          symlinkSync(packagesSrc, packagesDest, process.platform === 'win32' ? 'junction' : 'dir');
        } catch { /* 远程集成不可用时回退到本地 TUI */ }
      }
      // 通过 config.toml 的 `[hooks]` 表接线生命周期 hook——这是 Codex 真正
      // 扫描的用户层发现面。（裸的 $CODEX_HOME/hooks.json 是插件作用域的——
      // 从插件清单引用——普通配置目录不会发现它；实证它从不触发。）我们用
      // 用户的 config.toml 播种（他们的 model/provider/trust 设置带过来），并为
      // 每个事件追加一个 `[[hooks.<Event>]]` 组，每个都指向同一个 cth-hook
      // 垫片——逐字复用（Codex 的 hook 负载与响应已是 Claude 形状，因此
      // HookServer/drainForStop 原样运行）。每次 spawn 重新生成（幂等）。单引号
      // TOML 字面量避免路径转义（hive 根无空格/引号）。注意：hook 在 INTERACTIVE
      // codex 会话（hive worker 的运行方式）中触发，不在无头 `codex exec` 中。
      //
      // 这里的 `timeout` 单位是秒——不要把 Claude 的 `timeout: 0` 哨兵复制进
      // 本文件。Codex 把该键解析为 `timeout_sec`，并用
      // `timeout_sec.unwrap_or(600).max(1)` 归一化，因此 0 不意味着「无超时」：
      // 它被压到 ONE SECOND——现存最短的预算。这一点随 v0.3.7 发布，让每个
      // codex worker 都记录 `SessionStart hook (failed) — hook timed out after 1s`
      // （UserPromptSubmit 同理），因为每个 hook 都经 hive-node 冷启动 Electron
      // 二进制然后等待 hooks.sock——实测空闲 0.08-0.16s，但 8 个并发 spawn 时
      // 为 0.6-0.7s，而这正是会话启动与提示派发时的样子。30s 把该时间缩短两个
      // 数量级，同时仍能在卡死垫片自己 5s 内部上限失效之前封住它；裸省略
      // （600s）会让卡死看起来像冻结。用 codex 自己的解析器验证任何改动，
      // 不花模型的钱：`codex app-server` → initialize → `hooks/list` 报告每个
      // 事件归一化后的 timeoutSec。
      const shim = this.shimPath();
      let config = existsSync(join(userHome, 'config.toml'))
        ? readFileSync(join(userHome, 'config.toml'), 'utf8') : '';
      if (shim) {
        const events = ['PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop',
          'SessionStart', 'UserPromptSubmit', 'PreCompact', 'PostCompact'];
        config += '\n# --- munder-hive lifecycle hooks (auto-generated; do not edit) ---\n';
        for (const ev of events) {
          config += `\n[[hooks.${ev}]]\n[[hooks.${ev}.hooks]]\ntype = "command"\ncommand = '${this.nodeRunUnquoted(shim)}'\ntimeout = 30\n`;
        }
      }
      writeFileSync(join(home, 'config.toml'), config, 'utf8');

      // 保持每个 worker 的 CODEX_HOME 隔离，同时把其 rollout 数据放到 Codex
      // 标准扫描根之下。外部使用工具因此能在不理解 hive 私有目录布局的情况下
      // 发现会话。
      this.exposeCodexDataDirs(home, userHome, agentId);
    } catch (e) { console.error('[hive] installCodexHooks failed:', e); }
    return home;
  }

  private exposeCodexDataDirs(home: string, userHome: string, agentId: string): void {
    for (const kind of ['sessions', 'archived_sessions'] as const) {
      try { this.exposeCodexDataDir(home, userHome, agentId, kind); }
      catch (e) { console.error(`[hive] exposeCodexDataDir(${kind}) failed:`, e); }
    }
  }

  private moveCodexDataDir(from: string, to: string): void {
    try {
      renameSync(from, to);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      cpSync(from, to, { recursive: true, force: false, errorOnExist: true });
      rmSync(from, { recursive: true, force: true });
    }
  }

  private exposeCodexDataDir(
    home: string,
    userHome: string,
    agentId: string,
    kind: 'sessions' | 'archived_sessions'
  ): void {
    const root = this.root();
    if (!root) return;
    if (!agentId || basename(agentId) !== agentId || agentId === '.' || agentId === '..') {
      throw new Error(`invalid agent id: ${agentId}`);
    }
    const source = join(home, kind);
    const scanRoot = join(userHome, kind, 'munder-difflin');
    const hiveId = createHash('sha1').update(root).digest('hex').slice(0, 12);
    const target = join(scanRoot, hiveId, agentId);

    let sourceStat: ReturnType<typeof lstatSync> | null = null;
    try { sourceStat = lstatSync(source); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }

    if (sourceStat?.isSymbolicLink()) {
      let current: string | null = null;
      try { current = realpathSync(source); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        unlinkSync(source);
        sourceStat = null;
      }
      if (current) {
        const rel = relative(realpathSync(scanRoot), current);
        const scope = dirname(rel);
        if (rel && !rel.startsWith('..') && !isAbsolute(rel)
          && dirname(scope) === '.' && basename(rel) === agentId) return;
        throw new Error(`${source} points outside ${scanRoot}`);
      }
    }
    if (sourceStat && !sourceStat.isDirectory()) throw new Error(`${source} is not a directory`);

    mkdirSync(dirname(target), { recursive: true });
    if (sourceStat) {
      if (existsSync(target)) {
        if (readdirSync(target).length > 0) throw new Error(`${source} and ${target} both contain data`);
        rmSync(target, { recursive: true, force: true });
      }
      this.moveCodexDataDir(source, target);
    } else if (!existsSync(target)) {
      mkdirSync(target, { recursive: true });
    }

    try {
      symlinkSync(target, source, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
      if (!existsSync(source) && existsSync(target)) {
        try { this.moveCodexDataDir(target, source); } catch { /* 数据保留在目标处 */ }
      }
      throw e;
    }
  }

  /** 在完整 hive 重置移除隔离的 CODEX_HOME 链接之前，移除移到用户标准 Codex
   *  扫描根下的 rollout 目录。 */
  removeExposedCodexData(): void {
    const root = this.root();
    if (!root) return;
    const agents = join(root, 'agents');
    if (!existsSync(agents)) return;
    const userHome = join(homedir(), '.codex');

    for (const entry of readdirSync(agents, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const kind of ['sessions', 'archived_sessions'] as const) {
        const source = join(agents, entry.name, '.codex', kind);
        try {
          if (!lstatSync(source).isSymbolicLink()) continue;
          const target = realpathSync(source);
          const scanRoot = realpathSync(join(userHome, kind, 'munder-difflin'));
          const rel = relative(scanRoot, target);
          const scope = dirname(rel);
          if (!rel || rel.startsWith('..') || isAbsolute(rel)
            || dirname(scope) !== '.' || basename(rel) !== entry.name) continue;
          rmSync(target, { recursive: true, force: true });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error('[hive] removeExposedCodexData failed:', e);
          }
        }
      }
    }
  }





  /** 写 Michael 读取的实时 fleet 快照（`fleet.json`，已 gitignore）。
   *  尽力而为——从定时器调用，绝不能抛异常。 */
  writeFleetSnapshot(snapshot: unknown): void {
    const root = this.root();
    if (!root) return;
    try { writeFileSync(join(root, 'fleet.json'), JSON.stringify(snapshot, null, 2), 'utf8'); } catch { /* 空操作 */ }
  }

  /** 该 agent 是否是 hive 的 god/编排者？ */
  isGod(agentId: string): boolean {
    try {
      const reg = this.registry();
      return reg.godId === agentId || !!reg.agents[agentId]?.isGod;
    } catch { return false; }
  }

  /**
   * 由 `fleet.json` 构建的紧凑、一次性 LIVE ROSTER 行——在 SessionStart 与每次
   * UserPromptSubmit 时注入 god 的上下文作为 `additionalContext`（见 HookServer）。
   *
   * 为什么：fleet.json/registry.json 在磁盘上总是新鲜的（8s 快照 + 启动时
   * archiveOrphanedAgents + PTY 退出归档），但 god 的 CONTEXT 不是。应用重启后，
   * god 恢复一个 transcript 仍描述旧楼层的会话，它会高兴地给已不存在的 agent
   * 发消息。它被告知要读 fleet.json，但「被告知」不等于「总会知道」——所以我们
   * 每一轮主动把真相推进去。一行而已，成本可忽略。
   *
   * `ctxOf`（可选，由 HookServer 提供）让调用方把 LIVE 上下文窗口占用叠加在
   * 磁盘快照之上——每个 agent 得到一个 `ctx NN%`，god 在路由工作时一眼就能
   * 看到谁的上下文几乎满了。fleet.json 只携带累计的 `tokens`，那是花费数字、
   * 不是当前窗口有多满；真实占用活在 HookServer.contextById（来自 statusLine
   * 垫片）。回调缺失或某个 agent 还没有 Status tick 时省略。
   *
   * 无话可说（无 hive、无快照、无 agent）时返回 null，hook 因此保持空操作，
   * 而不是注入噪音。
   */
  rosterContext(
    ctxOf?: (agentId: string) => { tokens: number; limit: number } | undefined
  ): string | null {
    const root = this.root();
    if (!root) return null;
    try {
      const raw = readFileSync(join(root, 'fleet.json'), 'utf8');
      const snap = JSON.parse(raw) as {
        ts?: number;
        agents?: Array<{
          id: string; name?: string; role?: string; isGod?: boolean;
          breaker?: string; tokens?: number; usd?: number;
          lastTool?: string | null; lastActiveSecAgo?: number | null; inboxBacklog?: number;
          onHold?: boolean;
        }>;
      };
      const agents = Array.isArray(snap.agents) ? snap.agents : [];
      if (!agents.length) return null;

      const ago = (s: number | null | undefined): string =>
        typeof s !== 'number' ? 'unknown'
          : s < 90 ? `${s}s ago`
            : s < 5400 ? `${Math.round(s / 60)}m ago`
              : `${Math.round(s / 3600)}h ago`;

      // 限制列表长度，大楼层才不至于挤掉真正的提示。其余仍被统计，fleet.json
      // 一次 Read 即可取。
      const MAX = 24;
      const shown = agents.slice(0, MAX);
      let anyCtx = false;
      let anyHold = false;
      const rows = shown.map((a) => {
        const bits = [a.role ?? 'agent',
          typeof a.lastActiveSecAgo === 'number' ? `active ${ago(a.lastActiveSecAgo)}` : 'no activity yet'];
        if (a.tokens) bits.push(`${Math.round(a.tokens / 1000)}k tok`);
        if (a.usd) bits.push(`$${a.usd.toFixed(2)}`);
        if (a.inboxBacklog) bits.push(`inbox ${a.inboxBacklog}`);
        if (a.breaker && a.breaker !== 'ok' && a.breaker !== 'none') bits.push(`breaker ${a.breaker}`);
        if (a.isGod) bits.push('you');
        // 放在角色之后的行首会更响亮，但该位置与 `breaker`、`inbox` 处于同一
        // 扫描视线，而 god 已把那些当作路由信号。
        if (a.onHold) { bits.push('ON HOLD — 1:1 with the human'); anyHold = true; }
        // 来自 statusLine 垫片的实时上下文窗口占用——让 god 在路由时看到哪些
        // agent 接近满载，而不是从累计 token 数猜测。钳制到 0-100；新仪表在
        // 窗口轮换前可能短暂报告超过 100%。
        const cw = ctxOf?.(a.id);
        if (cw && cw.limit > 0) {
          const pct = Math.max(0, Math.min(100, Math.round((cw.tokens / cw.limit) * 100)));
          bits.push(`ctx ${pct}%`);
          anyCtx = true;
        }
        return `${a.id}${a.name ? ` "${a.name}"` : ''} (${bits.join(', ')})`;
      });
      const more = agents.length > shown.length ? ` +${agents.length - shown.length} more` : '';
      const age = typeof snap.ts === 'number' ? ago(Math.round((Date.now() - snap.ts) / 1000)) : 'unknown';

      return `[LIVE ROSTER — auto-injected from ${join(root, 'fleet.json')}, snapshot ${age}] `
        + `${agents.length} ACTIVE agent(s): ${rows.join('; ')}.${more} `
        + 'This is the CURRENT floor and it SUPERSEDES any roster earlier in this conversation — '
        + 'agents you remember that are absent here have been archived or killed, so do not message them. '
        + (anyCtx
          ? '`ctx NN%` = live window occupancy; absent = not yet reported (unknown, not empty). '
          : '')
        + (anyHold
          ? 'An agent marked `ON HOLD — 1:1 with the human` is UNAVAILABLE: the human is working '
            + 'with them directly. Do NOT message them, do NOT dispatch to them, and do NOT count '
            + 'them when picking an owner. Route to someone else, or say the work is waiting. They '
            + 'are still running and their terminal is alive, so this is not a reason to archive '
            + 'them or spawn a replacement. The human flips it off when they are done. '
          : '')
        + 'Route work to someone on this list before spawning anyone new.';
    } catch { return null; }
  }
  logTail(n = 200): unknown[] {
    const root = this.root();
    if (!root || !existsSync(join(root, 'log.jsonl'))) return [];
    const lines = readFileSync(join(root, 'log.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  }

  private listMessages(dir: string): HiveMessage[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')) as HiveMessage; } catch { return null; } })
      .filter((m): m is HiveMessage => m !== null);
  }

  // — log —
  appendLog(event: Record<string, unknown>): void {
    const root = this.root();
    if (!root) return;
    const line = JSON.stringify({ ts: Date.now(), ...event }) + '\n';
    try { appendFileSync(join(root, 'log.jsonl'), line, 'utf8'); } catch { /* 空操作 */ }
  }

  /**
   * 把一个成本样本追加到位于 `<root>/cost-ledger.jsonl` 的持久、只追加账本
   * （Lane A #6.6d）。这是唯一的持久成本存储；它的行恰是 Kevin（#4）为
   * cost_ledger SQLite 表预留的形状，因此迁移是一次机械的 INSERT…SELECT。
   *
   * 🔒 PII：只持久化白名单中的 AgentUsageSample——绝不存原始 OTel 记录
   * （那些带有 user.email / account / org / hashed-user-id）。样本在上游
   * （provider 的 normalize 步骤）就已经无 PII，因此此处不添加脱敏；我们只是
   * 不能加宽写入的内容。文件位于 hive 根，因此 `mempalace mine`（只扫描
   * 按-agent 目录）绝不会摄取它——无 palace 噪音，也无需 MINE_IGNORE 条目。
   *
   * 与 appendLog 一样：立刻追加到磁盘（即刻持久），让它随下一次自然提交。
   * 尽力而为——绝不把异常抛进 beat。
   */
  appendCostLedger(sample: AgentUsageSample): void {
    const root = this.root();
    if (!root) return;
    // 完全 snake_case，行因此与 Kevin（#4）的 cost_ledger SQLite 列一一对应
    // （agent_id, session_id, ts, input, output, cache_read,
    // cache_creation, model, usd）——迁移是一次直白的 INSERT…SELECT。
    const row = {
      agent_id: sample.agentId,
      session_id: sample.sessionId,
      ts: sample.ts,
      input: sample.input,
      output: sample.output,
      cache_read: sample.cacheRead,
      cache_creation: sample.cacheCreation,
      model: sample.model,
      usd: sample.usd
    };
    try { appendFileSync(join(root, 'cost-ledger.jsonl'), JSON.stringify(row) + '\n', 'utf8'); } catch { /* 空操作 */ }
  }

  // — json + 原子 io —
  private readJson<T>(p: string, fallback: T): T {
    try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return fallback; }
  }
  private writeJson(p: string, data: unknown): void {
    writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  }
  private atomicWriteJson(p: string, data: unknown): void {
    const tmp = `${p}.tmp-${shortRand()}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, p);
  }

  // — git（单一提交者，重试 + 陈旧锁恢复）—
  private git(args: string[], cwd: string): { ok: boolean; out: string; err: string } {
    const res = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=Hive', '-c', 'user.email=hive@local', ...args], {
      cwd, encoding: 'utf8', timeout: 8000
    });
    return { ok: res.status === 0, out: res.stdout ?? '', err: res.stderr ?? '' };
  }

  /** 一次性 cost-ledger untrack 流程是否已在本进程运行过？ */
  private untrackedCostLedger = false;

  /**
   * 停止对成本账本做版本控制。
   *
   * `cost-ledger.jsonl` 只追加，每个用量样本增加一行，因此跟踪它的仓库会在
   * 每次 hive 提交时存下整个文件的新副本——而 hive 频繁提交。一个四分之一 GB
   * 的账本背后几千次提交，就是 git 要行走的几百 GB blob，这正是让例行 `gc`
   * 变成多 GB `pack-objects` 运行的东西。ensureHive 里的忽略行挡住新副本；
   * 这里把已在索引中的那个去掉，因为无论 .gitignore 说什么，git 都会继续记录
   * 它已在跟踪的文件——于是单看忽略行像是一个修复，仓库却继续膨胀。账本仍在
   * 磁盘上，应用读到的成本历史不受影响。
   */
  private untrackCostLedger(root: string): void {
    if (this.untrackedCostLedger) return;
    this.untrackedCostLedger = true;
    // 变更前先探测：`rm --cached` 作用于从未跟踪它的仓库，仍然会在每次启动时
    // 重写索引，而这发生在重试路径内部。
    const tracked = this.git(['ls-files', '--', 'cost-ledger.jsonl'], root);
    if (!tracked.ok || !tracked.out.trim()) return;
    this.git(['rm', '--cached', '-q', '--ignore-unmatch', '--', 'cost-ledger.jsonl'], root);
    console.warn('[hive] untracked the cost ledger from the hive repo');
  }

  /** 一次性 Codex-home untrack 流程是否已在本进程运行过？ */
  private untrackedCodexHomes = false;

  /**
   * 停止对已在索引中的 Codex worker homes 做版本控制。
   *
   * 给每个 agent 的 .gitignore 加 `.codex/` 只挡住新路径；git 会愉快地继续记录
   * 它已在跟踪的文件，因此早于那一行 ignore 的 hive 会一如既往地提交每一次
   * SQLite 与 transcript 修订——.gitignore 读起来像修复，仓库却继续膨胀。这里
   * 把它封死：每进程一次，刷新每个 agent 的忽略文件（未运行的 agent 永远不会
   * 经过 spawn，而 mine 循环只有安装了 mempalace 才会触达它们），并把任何已
   * 跟踪的 `.codex` 路径从索引中移除。文件留在磁盘上，`codex --resume` 因此
   * 不受影响；只是它们的历史停止记录。
   */
  private untrackCodexHomes(root: string): void {
    if (this.untrackedCodexHomes) return;
    this.untrackedCodexHomes = true;
    const agentsDir = join(root, 'agents');
    if (!existsSync(agentsDir)) return;
    try {
      for (const id of readdirSync(agentsDir)) ensureMineIgnore(join(agentsDir, id));
    } catch { /* 尽力而为 */ }
    // 变更前先探测：`rm --cached` 作用于干净仓库，仍然会在每次启动时重写索引，
    // 而这运行在提交重试路径内部。
    const tracked = this.git(['ls-files', '--', 'agents/*/.codex'], root);
    if (!tracked.ok || !tracked.out.trim()) return;
    this.git(['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', 'agents/*/.codex'], root);
    console.warn('[hive] untracked previously-committed Codex homes from the hive repo');
  }

  /** 提交所有 hive 变更。没有暂存内容则为空操作。 */
  commit(message: string): void {
    const root = this.root();
    if (!root || !existsSync(join(root, '.git'))) return;
    this.untrackCostLedger(root);
    this.untrackCodexHomes(root);
    for (let attempt = 0; attempt < 5; attempt++) {
      this.clearStaleLock(root);
      const add = this.git(['add', '-A'], root);
      const commit = this.git(['commit', '-q', '-m', message], root);
      if (commit.ok) return;
      if (/nothing to commit/i.test(commit.out + commit.err)) return;
      if (!add.ok || /index\.lock/i.test(commit.err)) { sleepSync(50 * (attempt + 1)); continue; }
      return; // 非锁失败——安静放弃，下一次变更会重试
    }
  }

  private clearStaleLock(root: string): void {
    const lock = join(root, '.git', 'index.lock');
    try {
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock);
    } catch { /* 空操作 */ }
  }
}

// ─── PROTOCOL.md（写入 hive，每个 agent 可读）────────────────────────────────

/** 写入 <hive>/COMMANDS.md 的 Claude Code 命令参考，与 UI "命令" 选项卡
 *  来自同一份源，永远不会漂移。以编排者说明开头：slash = 仅作用于自身会话，
 *  cli = shell/车队；通过 fleet.json 监控兄弟代理
 *  （claude agents 看不到它们）。 */
function renderCommandsMd(): string {
  const lines: string[] = [
    '# Claude Code commands',
    '',
    'Reference of the Claude Code commands available to you. Two kinds:',
    '- **slash** commands act ONLY on your own session — you CANNOT run them on another agent\'s terminal.',
    '- **cli** commands run in your shell (Bash) and can target the fleet, spawn, or query.',
    '',
    'To MONITOR the other agents in this hive, read `fleet.json` in the hive root (live per-agent tokens, cost, status, last tool, breaker level, inbox backlog) plus `registry.json` — `claude agents` does NOT list your hive siblings. Use `claude -p "..." --output-format json` for a one-off headless query.',
    '',
    '## File encoding on Windows (PowerShell)',
    'This hive\'s data files (`log.jsonl`, `fleet.json`, `registry.json`, `tasks.json`, messages, memory) are UTF-8 **without** a byte-order mark. Windows PowerShell 5.1 (`powershell.exe`) reads such files with the system ANSI codepage (GBK/cp936 on this machine) unless you say otherwise, which mangles Chinese into mojibake (`璧氶挶` instead of `赚钱`).',
    '- When reading a hive/UTF-8 file with PowerShell, ALWAYS pass `-Encoding UTF8`, e.g. `Get-Content -Encoding UTF8 -Raw log.jsonl | ConvertFrom-Json`.',
    '- When writing, also pass `-Encoding UTF8` (`Set-Content -Encoding UTF8`, `Add-Content -Encoding UTF8`, `Out-File -Encoding UTF8`).',
    '- Never rely on PowerShell\'s default encoding for hive files; default is ANSI, not UTF-8, on zh-CN Windows.',
    '- `[Console]::OutputEncoding` is also GBK here — pipe through `Out-String -Width` or re-encode if a command prints non-ASCII and you need it intact.',
    ''
  ];
  for (const g of COMMAND_GROUPS) {
    lines.push(`## ${g.title}`, '');
    for (const it of g.items) {
      lines.push(`- \`${it.cmd.trim()}\` _(${it.kind})_ — ${it.desc}${it.usage ? ` e.g. \`${it.usage}\`` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
const COMMANDS_MD = renderCommandsMd();

const PROTOCOL_MD = `# Hive protocol

You are one of several Claude agents sharing this hive. Coordination is entirely
file-based; the harness (main process) is the only thing that runs git and the
only thing that moves messages between agents.

## Your workspace — \`agents/<your-id>/\`
- \`identity.md\`  — who you are (read-only; the harness writes it).
- \`memory.md\`    — your long-term memory. Read at the start of a task; append to it as you learn.
- \`inbox/\`       — messages addressed to you. Read them at the start of a task.
- \`inbox/.done/\` — move a message here once you've handled it.
- \`outbox/\`      — drop messages here to send them. The harness delivers them.

**Never write into another agent's folder.** Write to your own \`outbox/\`; the
orchestrator routes it. This keeps every file single-writer.

## Sending a message
Write one JSON file into \`outbox/\` (any filename ending in \`.json\`):

\`\`\`json
{
  "to": "<agent-id> | god | broadcast",
  "act": "request | inform | propose | query | agree | refuse | done",
  "subject": "one-line summary",
  "body": "the details",
  "conversation": "carry this across a thread (optional)",
  "in_reply_to": "<message id you're replying to> (optional)"
}
\`\`\`

The harness fills in \`id\`, \`from\`, \`hops\`, and timestamps.

## Rules of the road
- Only \`request\`, \`query\`, and \`propose\` expect a reply. \`inform\` and \`done\` are terminal —
  don't reply to them, or two agents will loop forever.
- For anything ambiguous, cross-cutting, or needing sign-off, message \`god\` — the
  god agent clarifies answers for you so you rarely need the human directly.
- There is NO separate human-approval queue. Human-in-the-loop is native to Claude
  Code: a tool you run that needs permission prompts in your own session (the human
  can approve it remotely from their phone via \`/remote-control\`). If you genuinely
  need a human decision, raise it with \`god\` (a message \`"to": "human"\` is routed to
  the god/orchestrator, the human's proxy on the floor).
- \`board.md\` is the shared plan. Don't edit it directly — \`propose\` changes to \`god\`,
  who is its sole scribe.
- Re-reading a message you already moved to \`.done/\` is a no-op. Don't reprocess.

## The work: board.md vs tasks.json
There are two shared surfaces, both in the hive root:
- \`board.md\` — the freeform narrative plan. The god agent is its sole scribe; others \`propose\` edits.
- \`tasks.json\` — the structured task ledger (a kanban: \`todo / doing / blocked / done\`, with title,
  assignee, priority, deps). Keep the task you're working reflected in its status.

## Asking the human (the ASK ME card)
When a card can only move with the human — a question to answer, or an action only they can do
(create an account, approve a spend, hand over credentials, test on their device) — the god sets the
card \`"status": "blocked"\` and appends the ask to its \`humanQA\` array:

\`\`\`json
{ "q": "the ask, in markdown", "askedAt": "<iso timestamp>" }
\`\`\`

The harness shows the open ask on the ASK ME board and in the ASK ME tab, and the human's reply lands
in the same entry as \`"a"\` plus an inbox message to god. Every past entry stays on the card — that
trail is the decision history.

**Write the ask short, and in markdown.** The card renders it, so plain-text asterisks and backticks
show up literally, and a card is not a terminal — an ask longer than a short paragraph plus its
options (roughly 700 characters) is a report, not a question. Cut the narrative and keep the decision:
- open with ONE **bold** sentence saying exactly what you need from them;
- \`backticks\` for paths, commands, values, and identifiers;
- \`-\` bullets or \`1.\` numbering for every option or step;
- a blank line between paragraphs; a single newline is rendered as a line break, so each option
  stays on its own line.

When the ask originates in another agent's report, REWRITE it into that shape. Never paste the report
body in as the question, and never make the human read the investigation to find the decision. Do NOT park human questions in separate files (no \`HumanQuestion.md\`),
and never sit idle waiting for a reply — move on to other work and pick the answer up when it arrives.

## Guardrails: circuit breaker & token budgets
A circuit breaker watches every agent for runaway behavior (looping on the same tool, error storms,
overspending). It escalates gently: \`steer\` → \`constrain\` → \`stop\`. If a \`Circuit breaker: steer\`
or \`Circuit breaker: constrain\` message lands in your inbox, you ARE the problem it caught — stop
repeating, summarize what you've tried, and do exactly what the message says (constrain = go read-only
and get god's sign-off before more tool calls). Be **token-frugal**: the floor has a token budget and
each agent can have its own token limit; crossing it trips the breaker. Prefer references over pasted
content, and \`/compact\` your own session when context gets heavy.

## Fleet monitoring (orchestrator)
You (god) are responsible for situational awareness. To see the live state of every agent, read
\`fleet.json\` in the hive root — it is refreshed continuously with each agent's tokens, cost, status,
breaker level, last tool, last-active time, and inbox backlog. Pair it with \`registry.json\` (the roster)
and \`log.jsonl\` (the event feed). IMPORTANT: \`claude agents\` will NOT show your hive's sibling
sessions (they're spawned independently) — \`fleet.json\` is your source of truth for them. For a deeper
look at one agent, read its \`agents/<id>/memory.md\` and \`inbox/\`, or send it a \`query\`. A full
Claude Code command reference (slash = your own session only; CLI = your shell, can target the fleet)
is in \`COMMANDS.md\` in the hive root.

## Spawning a worker (orchestrator)
You can start an ephemeral worker yourself. Write ONE JSON file into \`spawn-requests/<id>.json\` in
the hive root:

\`\`\`json
{
  "objective": "what the worker must do (required)",
  "cwd": "/absolute/path/to/the/repo (required)",
  "name": "display name (optional)",
  "command": "engine CLI (optional; defaults to the configured one)",
  "provider": "claude | codex | cursor | antigravity | … (optional)",
  "model": "model override (optional)",
  "isolate": true,
  "tokenCap": 0,
  "slack": { "channel": "C…", "thread_ts": "…" },
  "character": "meredith",
  "accent": "coral"
}
\`\`\`

The harness polls that directory, spawns \`worker-<id>\`, and moves the request to
\`spawn-requests/.done/\` once it starts or to \`spawn-requests/.failed/\` with a reason. \`isolate\`
defaults to true, giving the worker its own git worktree. \`slack\` routes its failures back to a
thread. This is the ONLY spawn route you can complete on your own: a hire manifest under
\`research/hires/\` needs the human to confirm it in the UI.

\`character\` and \`accent\` set how the worker looks on the office floor, and both are optional.
Naming a worker after a cast member already gets you that avatar, so you only need \`character\` when
the name and the face should differ. An unrecognised value falls back rather than failing the spawn.

**It can be switched off.** The operator controls this under Settings → Autonomy & Budgets, and it is
OFF by default, because every worker you start spends tokens nobody approved. While it is off your
request is NOT failed or deleted, it waits in \`spawn-requests/\` and runs if the operator turns it on.
If a request of yours has sat there without moving, that is why, and it is a decision to raise with the
human rather than retry. Route work to an agent already on the floor first either way.

## Semantic memory (optional — when \`mempalace\` is installed)
When \`MEMPALACE_PALACE_PATH\` is set in your environment, the hive shares a
searchable MemPalace and you have the \`mempalace\` CLI:
- \`mempalace search "<query>"\` — recall relevant past knowledge across the whole
  team by meaning (not just keywords). Add \`--wing <agent-id>\` to scope to one
  agent, \`--results N\` to widen.
- \`mempalace wake-up\` — a short digest of what matters, good at the start of a task.

Your \`memory.md\` is mined into the palace automatically, so the durable facts you
write there become searchable by every agent. You don't run \`mine\` yourself.

## File encoding on Windows (PowerShell)
This hive's files (\`log.jsonl\`, \`fleet.json\`, \`registry.json\`, \`tasks.json\`, inbox/outbox
messages, memory) are UTF-8 **without** a byte-order mark. Windows PowerShell 5.1
(\`powershell.exe\`) reads such files using the system ANSI codepage (GBK/cp936 on this
machine) unless you say otherwise, which turns Chinese into mojibake (\`璧氶挶\` instead
of \`赚钱\`). The Bash tool on Windows runs through PowerShell.
- When reading a hive/UTF-8 file with PowerShell, ALWAYS pass \`-Encoding UTF8\`, e.g.
  \`Get-Content -Encoding UTF8 -Raw log.jsonl | ConvertFrom-Json\`.
- When writing, also pass \`-Encoding UTF8\` (\`Set-Content -Encoding UTF8\`,
  \`Add-Content -Encoding UTF8\`, \`Out-File -Encoding UTF8\`).
- Never rely on PowerShell's default encoding for hive files; on zh-CN Windows the default
  is ANSI/GBK, not UTF-8.
- If a PowerShell command prints non-ASCII and the output looks garbled, re-encode via
  \`Out-String -Width\` or set \`[Console]::OutputEncoding\` for that one command.
`;

// ─── cth-hook 垫片（写入 <hive>/bin/cth-hook.cjs）─────────────────────────────
// 极简管道：从 stdin 读取 hook 负载，打上该代理的 id，转发到 hive 的 UDS，
// 再把响应转回给 `claude`。所有真正逻辑在主进程（HookServer）中。
// 错误时绝不阻塞停止。
const HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
const isStatus = process.argv.includes('--status');
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(data || '{}'); } catch (_) {}
  if (!payload.agent_id) payload.agent_id = process.env.AGENT_ID || null;
  const sock = process.env.HIVE_SOCK;
  if (isStatus) {
    // Status-line 模式：Claude Code 在每次响应后把会话状态 JSON（含
    // context_window.total_input_tokens / .context_window_size）送进来。立即打印
    // 终端内仪表（TUI 在等待），再把负载 fire-and-forget 转发给 harness，
    // 让 agent 卡片的上下文仪表以推送方式、用 EXACT 窗口大小更新。
    payload.hook_event_name = 'Status';
    const cw = payload.context_window || {};
    const used = cw.total_input_tokens, size = cw.context_window_size;
    if (typeof used === 'number' && typeof size === 'number' && size > 0) {
      const pct = Math.round((used / size) * 100);
      process.stdout.write('ctx ' + Math.round(used / 1000) + 'k/' + Math.round(size / 1000) + 'k (' + pct + '%)');
    }
    if (sock) {
      try {
        const c = net.createConnection(sock, () => { c.end(JSON.stringify(payload) + '\\n'); });
        c.on('error', () => {});
        c.on('close', () => process.exit(0));
      } catch (_) { process.exit(0); }
    } else {
      process.exit(0);
    }
    setTimeout(() => process.exit(0), 1500).unref();
    return;
  }
  if (!sock) { process.exit(0); }
  let resp = '';
  const done = (code) => { if (resp) process.stdout.write(resp); process.exit(code); };
  const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\\n'));
  c.setEncoding('utf8');
  c.on('data', (d) => { resp += d; });
  c.on('end', () => done(0));
  c.on('error', () => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
`;

// ─── agy-hook 垫片（写入 <hive>/bin/agy-hook.cjs）─────────────────────────────
// Antigravity 的 `agy` CLI 会触发生命周期钩子（PreToolUse/PostToolUse/Stop/
// PreInvocation/PostInvocation），但与 Claude 相比 stdin 形状不同
// （conversationId / toolCall{name,args} / workspacePaths，且没有 hook_event_name
// ——事件作为 argv 从 hooks.json 命令传来）。此垫片将其标准化为
// HookServer 已经消费的相同 HookPayload，从而状态、Stop 时的收件箱排空、
// 工具门控都会原样复用，再把服务端的 Claude 形状响应转译回 agy 的 stdout 契约
// （decision: allow|deny|block + 一条消息）。以 AGENT_ID 为作用域：
// 没有 AGENT_ID 的个人 agy 会话是无操作，因此全局 hooks.json 绝不会打扰
// 用户自己的 agy 使用——只有 hive 工作线程（带 AGENT_ID 生成）才会桥接。
// NOTE（agy bug, antigravity-cli#49）：加载器读 ~/.gemini/antigravity-cli/
// hooks.json 但触发器读 ~/.gemini/config/hooks.json —— 我们写入 BOTH。
const AGY_HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
const event = process.argv[2] || 'Unknown';
const agentId = process.env.AGENT_ID || null;
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  const sock = process.env.HIVE_SOCK;
  if (!agentId || !sock) { process.exit(0); } // 非 hive worker → 忽略
  let agy = {};
  try { agy = JSON.parse(data || '{}'); } catch (_) {}
  const tc = agy.toolCall || {};
  const payload = {
    hook_event_name: event,
    agent_id: agentId,
    session_id: agy.conversationId,
    transcript_path: agy.transcriptPath,
    cwd: Array.isArray(agy.workspacePaths) ? agy.workspacePaths[0] : undefined,
    tool_name: tc.name,
    tool_input: tc.args
  };
  let resp = '';
  const done = () => {
    // 把 HookServer 的 Claude 形状回复转译进 agy 的契约。关键：
    // agy 把写入 stdout 的任何对象都当作一个决策并 FAIL-CLOSE（一个
    // 空/无决策对象 = DENY）。因此只在存在真实指令（deny/block/steer）时才发出
    // JSON；否则什么都不写——无输出 = allow。
    let out = null;
    try {
      const r = JSON.parse(resp || '{}');
      if (r.decision === 'block') out = { decision: 'block', reason: r.reason, stopReason: r.reason, systemMessage: r.reason };
      else if (r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny') out = { decision: 'deny', reason: r.hookSpecificOutput.permissionDecisionReason };
      else if (r.continue === false) out = { decision: 'block', stopReason: r.stopReason };
      else if (r.hookSpecificOutput && r.hookSpecificOutput.additionalContext) out = { systemMessage: r.hookSpecificOutput.additionalContext };
    } catch (_) {}
    if (out) { try { process.stdout.write(JSON.stringify(out)); } catch (_) {} }
    process.exit(0);
  };
  try {
    const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\\n'));
    c.setEncoding('utf8');
    c.on('data', (d) => { resp += d; });
    c.on('end', done);
    c.on('error', () => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  } catch (_) { process.exit(0); }
});
`;

// ─── pi 桥接扩展（写入 <agentDir>/.pi-agent/extensions/）──────────────────────
// 为 Pi（earendil-works）打包的扩展。Pi 暴露了 pi.on(event,…) 生命周期；
// 在 tool_call / tool_result / agent_end 时向 HIVE_SOCK 发送 cth-hook 形状
// 的负载，并在楼层处于自动模式时自动批准工具调用
// （HIVE_AUTO_APPROVE，由 config.autoMode 门控——Pam 护栏 #5）。
// agent_end→Stop 让状态与主循环同步（→ idle），这样渲染进程的空闲
// 收件箱唤醒提示可以投递邮件。全部包裹，让错误的 API 猜测也永远不会
// 破坏生成。LIVE-UNVERIFIED（Pi 的确切扩展面需要 BYOK keys）。
const PI_EXTENSION = `'use strict';
var net = require('node:net');
var SOCK = process.env.HIVE_SOCK;
var AGENT = process.env.AGENT_ID || null;
var AUTO = process.env.HIVE_AUTO_APPROVE === '1';
function post(payload) {
  try {
    if (!SOCK) return;
    payload.agent_id = payload.agent_id || AGENT;
    var c = net.createConnection(SOCK, function () { try { c.end(JSON.stringify(payload) + '\\n'); } catch (e) {} });
    c.on('error', function () {});
  } catch (e) {}
}
function register(pi) {
  if (!pi || typeof pi.on !== 'function') return false;
  try {
    pi.on('tool_call', function (ev) {
      post({ hook_event_name: 'PreToolUse', tool_name: ev && (ev.name || (ev.tool && ev.tool.name)), tool_input: ev && (ev.args || ev.input) });
      if (AUTO) { try { if (ev && typeof ev.approve === 'function') ev.approve(); } catch (e) {} return { approve: true }; }
      return undefined;
    });
    pi.on('tool_result', function (ev) { post({ hook_event_name: 'PostToolUse', tool_name: ev && (ev.name || (ev.tool && ev.tool.name)) }); });
    pi.on('agent_end', function () { post({ hook_event_name: 'Stop' }); });
    return true;
  } catch (e) { return false; }
}
try { if (typeof globalThis !== 'undefined' && globalThis.pi) register(globalThis.pi); } catch (e) {}
module.exports = function (pi) { return register(pi); };
module.exports.activate = function (pi) { return register(pi); };
module.exports.default = module.exports;
`;

// ─── opencode 桥接插件（写入 <agentDir>/.opencode/plugin/）─────────────────────
// 为 OpenCode（anomalyco/opencode）打包的插件——god 决策 1。OpenCode
// 没有 Claude 形状的 Stop 钩子，但其插件 API 暴露了真实的 session.idle
// 事件；它在 tool.execute.before/
// after + session.idle 时向 HIVE_SOCK 发送 cth-hook 形状的负载。session.idle→Stop
// 让状态与主循环同步（→ idle），这样渲染进程的空闲收件箱唤醒提示投递邮件。
// ESM（OpenCode 运行在 Bun 上）。全部包裹。LIVE-UNVERIFIED（插件自动加载 +
// session.idle 触发需要 BYOK keys）。
const OPENCODE_PLUGIN = `import { createConnection } from 'node:net';
const SOCK = process.env.HIVE_SOCK;
const AGENT = process.env.AGENT_ID || null;
function post(payload) {
  try {
    if (!SOCK) return;
    payload.agent_id = payload.agent_id || AGENT;
    const c = createConnection(SOCK, () => { try { c.end(JSON.stringify(payload) + '\\n'); } catch (e) {} });
    c.on('error', () => {});
  } catch (e) {}
}
export const HiveBridge = async () => {
  return {
    event: async (input) => {
      try { if (input && input.event && input.event.type === 'session.idle') post({ hook_event_name: 'Stop' }); } catch (e) {}
    },
    'tool.execute.before': async (input) => {
      try { post({ hook_event_name: 'PreToolUse', tool_name: input && (input.tool || input.name) }); } catch (e) {}
    },
    'tool.execute.after': async (input) => {
      try { post({ hook_event_name: 'PostToolUse', tool_name: input && (input.tool || input.name) }); } catch (e) {}
    }
  };
};
export default HiveBridge;
`;

// ─── proxy-bridge sidecar（写入 <hive>/bin/hive-proxy.cjs）────────────────────
// 每个代理层级的 agent（qwen）一个。无依赖、仅 loopback 的反向代理：
// agent 的 CLI 指向这里（通过 ANTHROPIC_BASE_URL/OPENAI_BASE_URL），
// 并把每个请求原封不动地转发给用户的真实上游（headers、body、流式）。
// 它对每个响应进行 TEES，以合成与 hook 垫片相同的 HIVE_SOCK 负载——
// Status（上下文仪表盘）、PostToolUse（熔断器）、Stop（空闲排空）
// 和新的 CostSample（成本账本）——让没有钩子的 CLI 成为 hive 公民。
// 绝不记录 body 或 keys；捕获的 body 在内存中解析后丢弃。
// 空闲是启发式的：一轮结束后如果没有工具调用，且 ~800ms 内没有新请求 → Stop
// （新请求会取消它）。
const PROXY_BRIDGE_SHIM = `#!/usr/bin/env node
'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const { URL } = require('url');

const SOCK = process.env.HIVE_SOCK;
const AGENT_ID = process.env.AGENT_ID || null;
const UPSTREAM = process.env.UPSTREAM_BASE_URL || '';
const SESSION = process.env.HIVE_PROXY_SESSION || null;
const API = process.env.HIVE_PROXY_API === 'anthropic' ? 'anthropic' : 'openai';

function trimSlash(s) { while (s.length && s.charAt(s.length - 1) === '/') s = s.slice(0, -1); return s; }

// 所有引擎统一 1M 上下文窗口（用于 Status 仪表盘）。
const CONTEXT_WINDOW_SIZE = 1000000;

// 以垫片形状的负载向 hive socket 发起一次 fire-and-forget 发射。绝不抛错。
function emit(payload) {
  if (!SOCK) return;
  try {
    const c = net.createConnection(SOCK, function () { c.end(JSON.stringify(payload) + '\\n'); });
    c.on('error', function () {});
  } catch (e) {}
}

let stopTimer = null;
function armStop() {
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = setTimeout(function () {
    stopTimer = null;
    emit({ hook_event_name: 'Stop', agent_id: AGENT_ID, session_id: SESSION });
  }, 800);
  if (stopTimer.unref) stopTimer.unref();
}
function cancelStop() { if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; } }

function safeArgs(s) {
  if (s == null) return {};
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (e) { return { _raw: String(s).slice(0, 500) }; }
}

// 解析已完成的响应（单 JSON 或 SSE 流）并合成事件。
function parseAndEmit(bodyStr, isSse) {
  const objs = [];
  if (isSse) {
    const lines = bodyStr.split('\\n');
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const idx = ln.indexOf('data:');
      if (idx === -1) continue;
      const data = ln.slice(idx + 5).trim();
      if (!data || data === '[DONE]') continue;
      try { objs.push(JSON.parse(data)); } catch (e) {}
    }
  } else {
    try { objs.push(JSON.parse(bodyStr)); } catch (e) {}
  }
  if (!objs.length) { armStop(); return; }

  let model = null, input = 0, output = 0, cacheRead = 0, cacheCreation = 0, sawUsage = false;
  const toolCalls = [];
  const oaiTools = {}; // 按索引累积流式 openai tool_calls

  for (let i = 0; i < objs.length; i++) {
    const o = objs[i];
    if (!o || typeof o !== 'object') continue;
    if (o.model) model = o.model;
    if (API === 'anthropic') {
      if (o.type === 'message_start' && o.message) {
        if (o.message.model) model = o.message.model;
        const u = o.message.usage || {};
        input += u.input_tokens || 0;
        cacheRead += u.cache_read_input_tokens || 0;
        cacheCreation += u.cache_creation_input_tokens || 0;
        sawUsage = true;
      } else if (o.type === 'message_delta' && o.usage) {
        output += o.usage.output_tokens || 0;
        sawUsage = true;
      } else if (o.type === 'content_block_start' && o.content_block && o.content_block.type === 'tool_use') {
        toolCalls.push({ name: o.content_block.name, input: o.content_block.input || {} });
      } else if (o.usage && !o.type) {
        // 非流式完整消息体
        const u = o.usage;
        input += u.input_tokens || 0;
        output += u.output_tokens || 0;
        cacheRead += u.cache_read_input_tokens || 0;
        cacheCreation += u.cache_creation_input_tokens || 0;
        sawUsage = true;
      }
      if (Array.isArray(o.content)) {
        for (let j = 0; j < o.content.length; j++) {
          const blk = o.content[j];
          if (blk && blk.type === 'tool_use') toolCalls.push({ name: blk.name, input: blk.input || {} });
        }
      }
    } else {
      if (o.usage) {
        const u = o.usage;
        input += u.prompt_tokens || 0;
        output += u.completion_tokens || 0;
        if (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) cacheRead += u.prompt_tokens_details.cached_tokens;
        sawUsage = true;
      }
      const choices = o.choices || [];
      for (let c = 0; c < choices.length; c++) {
        const ch = choices[c];
        if (!ch) continue;
        if (ch.message && Array.isArray(ch.message.tool_calls)) {
          for (let t = 0; t < ch.message.tool_calls.length; t++) {
            const tc = ch.message.tool_calls[t];
            if (tc && tc.function) toolCalls.push({ name: tc.function.name, input: safeArgs(tc.function.arguments) });
          }
        }
        if (ch.delta && Array.isArray(ch.delta.tool_calls)) {
          for (let t = 0; t < ch.delta.tool_calls.length; t++) {
            const tc = ch.delta.tool_calls[t];
            if (!tc) continue;
            const k = (tc.index != null ? tc.index : t);
            if (!oaiTools[k]) oaiTools[k] = { name: null, args: '' };
            if (tc.function) {
              if (tc.function.name) oaiTools[k].name = tc.function.name;
              if (tc.function.arguments) oaiTools[k].args += tc.function.arguments;
            }
          }
        }
      }
    }
  }
  const keys = Object.keys(oaiTools);
  for (let i = 0; i < keys.length; i++) {
    const t = oaiTools[keys[i]];
    if (t.name) toolCalls.push({ name: t.name, input: safeArgs(t.args) });
  }

  if (sawUsage) {
    emit({ hook_event_name: 'Status', agent_id: AGENT_ID, context_window: { total_input_tokens: input + cacheRead + cacheCreation, context_window_size: CONTEXT_WINDOW_SIZE } });
    emit({ hook_event_name: 'CostSample', agent_id: AGENT_ID, session_id: SESSION, model: model, input: input, output: output, cache_read: cacheRead, cache_creation: cacheCreation });
  }
  if (toolCalls.length) {
    cancelStop(); // 一次工具调用意味着回合继续
    for (let i = 0; i < toolCalls.length; i++) {
      emit({ hook_event_name: 'PostToolUse', agent_id: AGENT_ID, session_id: SESSION, tool_name: toolCalls[i].name, tool_input: toolCalls[i].input });
    }
  } else {
    armStop();
  }
}

let upstreamUrl = null;
try { upstreamUrl = new URL(UPSTREAM); } catch (e) {}

const server = http.createServer(function (req, res) {
  cancelStop(); // 新请求意味着回合仍在进行
  if (!upstreamUrl) { res.statusCode = 502; res.end('proxy: no upstream'); return; }
  let target;
  try { target = new URL(trimSlash(UPSTREAM) + req.url); } catch (e) { res.statusCode = 502; res.end('proxy: bad url'); return; }
  const isHttps = target.protocol === 'https:';
  const lib = isHttps ? https : http;
  const headers = Object.assign({}, req.headers);
  headers.host = target.host;
  // 向上游请求明文，tee 才能可靠解析 SSE/JSON；客户端拿到未压缩字节（回环——
  // 可忽略），也无须解掉任何 content-encoding。
  delete headers['accept-encoding'];
  const opts = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    method: req.method,
    path: target.pathname + target.search,
    headers: headers
  };
  const upReq = lib.request(opts, function (upRes) {
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    const ct = String((upRes.headers['content-type'] || ''));
    const wantParse = ct.indexOf('json') !== -1 || ct.indexOf('event-stream') !== -1;
    const isSse = ct.indexOf('event-stream') !== -1;
    const chunks = [];
    let total = 0;
    upRes.on('data', function (chunk) {
      res.write(chunk); // 直接流到 CLI
      if (wantParse && total < 4194304) { chunks.push(chunk); total += chunk.length; }
    });
    upRes.on('end', function () {
      res.end();
      if (wantParse && chunks.length) {
        try { parseAndEmit(Buffer.concat(chunks).toString('utf8'), isSse); } catch (e) {}
      }
    });
    upRes.on('error', function () { try { res.end(); } catch (e) {} });
  });
  upReq.on('error', function () { try { res.statusCode = 502; res.end('proxy: upstream error'); } catch (e) {} });
  req.pipe(upReq);
});

server.on('error', function () {
  try { process.stdout.write(JSON.stringify({ port: 0 }) + '\\n'); } catch (e) {}
  process.exit(0);
});
server.listen(0, '127.0.0.1', function () {
  const addr = server.address();
  const port = (addr && typeof addr === 'object') ? addr.port : 0;
  try { process.stdout.write(JSON.stringify({ port: port }) + '\\n'); } catch (e) {}
});
`;

// 官方 Gemini CLI 桥接。Gemini 已经发送 snake_case 字段；
// 规范化其事件名，再把 HookServer 决策转译回
// Gemini 文档化的 hook 输出契约。
const GEMINI_HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
const agentId = process.env.AGENT_ID || null;
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  const sock = process.env.HIVE_SOCK;
  if (!agentId || !sock) { process.exit(0); }
  let gemini = {};
  try { gemini = JSON.parse(data || '{}'); } catch (_) {}
  const names = {
    SessionStart: 'SessionStart',
    BeforeAgent: 'UserPromptSubmit',
    BeforeTool: 'PreToolUse',
    AfterTool: 'PostToolUse',
    AfterAgent: 'Stop'
  };
  const payload = {
    ...gemini,
    hook_event_name: names[gemini.hook_event_name] || gemini.hook_event_name || 'Unknown',
    agent_id: agentId
  };
  let resp = '';
  const done = () => {
    let out = null;
    try {
      const r = JSON.parse(resp || '{}');
      if (r.continue === false) out = { continue: false, stopReason: r.stopReason };
      else if (r.decision === 'block') out = { decision: 'deny', reason: r.reason };
      else if (r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny') {
        out = { decision: 'deny', reason: r.hookSpecificOutput.permissionDecisionReason };
      } else if (r.hookSpecificOutput && r.hookSpecificOutput.additionalContext) {
        out = { hookSpecificOutput: { additionalContext: r.hookSpecificOutput.additionalContext } };
      }
    } catch (_) {}
    if (out) { try { process.stdout.write(JSON.stringify(out)); } catch (_) {} }
    process.exit(0);
  };
  try {
    const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\\n'));
    c.setEncoding('utf8');
    c.on('data', (d) => { resp += d; });
    c.on('end', done);
    c.on('error', () => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  } catch (_) { process.exit(0); }
});
`;

// ─── grok-hook 垫片（写入 <hive>/bin/grok-hook.cjs）───────────────────────────
// Grok 的生命周期事件与决策与 Claude 兼容，但 wire 负载是 camelCase
// 并使用 snake_case 事件值。对 HookServer 规范化输入，并把其
// Claude 风格的权限拒绝转译回 Grok 的直接决策形式。以 AGENT_ID 为作用域，
// 使可信全局钩子在 Munder 生成的 worker 之外保持惰性。
const GROK_HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
const agentId = process.env.AGENT_ID || null;
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  const sock = process.env.HIVE_SOCK;
  if (!agentId || !sock) { process.exit(0); }
  let grok = {};
  try { grok = JSON.parse(data || '{}'); } catch (_) {}
  const names = {
    pre_tool_use: 'PreToolUse',
    post_tool_use: 'PostToolUse',
    post_tool_use_failure: 'PostToolUseFailure',
    permission_denied: 'PermissionDenied',
    stop: 'Stop',
    stop_failure: 'StopFailure',
    session_start: 'SessionStart',
    session_end: 'SessionEnd',
    user_prompt_submit: 'UserPromptSubmit',
    notification: 'Notification',
    subagent_start: 'SubagentStart',
    subagent_stop: 'SubagentStop',
    pre_compact: 'PreCompact',
    post_compact: 'PostCompact'
  };
  const payload = {
    hook_event_name: names[grok.hookEventName] || grok.hookEventName || 'Unknown',
    agent_id: agentId,
    session_id: grok.sessionId,
    cwd: grok.cwd || grok.workspaceRoot,
    tool_name: grok.toolName,
    tool_input: grok.toolInput,
    stop_hook_active: grok.stopHookActive,
    prompt: grok.prompt,
    source: grok.source,
    notification_type: grok.notificationType,
    message: grok.message
  };
  let resp = '';
  const done = () => {
    let out = null;
    try {
      const r = JSON.parse(resp || '{}');
      if (r.continue === false) out = { continue: false, stopReason: r.stopReason };
      else if (r.decision === 'block') out = { decision: 'block', reason: r.reason };
      else if (r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny') {
        out = { decision: 'deny', reason: r.hookSpecificOutput.permissionDecisionReason };
      } else if (r.hookSpecificOutput && r.hookSpecificOutput.additionalContext) {
        out = r;
      }
    } catch (_) {}
    if (out) { try { process.stdout.write(JSON.stringify(out)); } catch (_) {} }
    process.exit(0);
  };
  try {
    const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\\n'));
    c.setEncoding('utf8');
    c.on('data', (d) => { resp += d; });
    c.on('end', done);
    c.on('error', () => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  } catch (_) { process.exit(0); }
});
`;

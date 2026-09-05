/**
 * 产品分析（PostHog）——匿名、白名单、默认退出（opt-out）。
 *
 * 这是 telemetry.ts 的对外产品使用量对应物（telemetry.ts 是仅回环的本机
 * OTel 采集器，永远不会离开机器）。这里的一切都受 TELEMETRY.md——公共
 * 契约约束。两者必须保持同步：TELEMETRY.md 中不存在的事件或属性绝不能
 * 在这里添加，
 * 反之亦然。
 *
 * 🔒 匿名性「按构造（BY CONSTRUCTION）」保证，与 telemetry.ts 理念一致：
 *   - 每个事件都携带 `$process_person_profile: false` → PostHog 将其存储为
 *     匿名事件，且绝不创建人物画像。
 *   - distinct id 是在首次运行时铸造的随机 UUID，存储于 userData
 *     （`telemetry-install-id`）——不是机器 id，不可由任何东西推导，应用数据目录
 *     被删除即随之消失。
 *   - `track()` 强制按事件属性白名单（见下方 EVENTS），因此未来的
 *     调用点不会意外泄露新属性：未知事件和未知键都会被丢弃，
 *     绝不发送。
 *   - 不含任何提示词、对话记录、文件路径、仓库名、主机名或 agent 输出——
 *     没有任何自由格式内容越过这条界线。
 *
 * 发送受以下所有条件门控（按此顺序检查）：
 *   1. 构建期密钥（__POSTHOG_KEY__，在发布 CI 中从 POSTHOG_KEY 环境变量
 *      注入）。开发构建和 fork 编译为 '' → 对它们而言整个模块
 *      是静默 no-op。
 *   2. DO_NOT_TRACK 环境变量约定（除 '' / '0' 之外的任何值）——无条件遵守，
 *      在每次发送时检查，因此不会被竞态绕过。
 *   3. 用户的 `telemetryEnabled` 配置（设置 → 隐私；默认为开启，即 opt-out
 *      ——可通过 setEnabled() 实时切换）。
 *
 * 刻意不引入任何 `electron` 导入（路径/版本经 init 注入），因此可以像 telemetry.ts
 * 一样作为纯 Node 模块做冒烟测试。
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PostHog } from 'posthog-node';

// 由 electron-vite `define`（electron.vite.config.ts）在构建时从
// POSTHOG_KEY / POSTHOG_HOST 环境变量注入。开发/fork 构建中为空。
declare const __POSTHOG_KEY__: string;
declare const __POSTHOG_HOST__: string;

/** 完整的事件 → 允许属性键契约。与 TELEMETRY.md 精确对应；`track()` 会拒绝
 *  契约之外的任何内容。通用属性（`app_version`、`os`、`arch`）在中心统一
 *  打上，不逐事件列出。 */
const EVENTS: Record<string, ReadonlySet<string>> = {
  /** 每次安装仅一次，当安装 id 首次铸造时触发。 */
  first_run: new Set<string>(),
  /** 每次应用启动时触发。DAU/留存（retention）的支柱。 */
  app_launched: new Set<string>(),
  /** 每次版本变化一次，在版本变动后的首次运行时触发。两个值都是
   *  与每个事件已携带的 `app_version` 同形态的版本字符串；对早于
   *  版本打点（version stamping）的安装，`from_version` 为
   *  `unknown`（即任何升级到首个携带该事件的版本的安装）。
   *  `via` 是固定的三值枚举，说明是我们的更新器还是其他东西
   *  移动了版本。 */
  update_applied: new Set<string>(['from_version', 'to_version', 'via']),
  /** 一个 agent PTY 已产生。`provider` 仅是 CLI 引擎名。 */
  agent_spawned: new Set<string>(['provider']),
  /** ── 激活漏斗（v0.4.6）：app_launched → onboarding_completed →
   *  agent_spawn_attempted → {agent_spawned | agent_spawn_failed |
   *  agent_install_started → agent_install_finished}。每个新增属性都是
   *  封闭枚举或封闭的 CLI 名——不含自由格式内容，与白名单规则一致。 */
  /** 引导向导完成（安装使 onboardingComplete 从 false→true）。`provider` 是
   *  所选引擎，一个封闭的 CLI 名。漏斗顶端：多少比例的安装完成设置，以及他们
   *  选择哪个引擎。 */
  onboarding_completed: new Set<string>(['provider']),
  /** 已请求一次 spawn——经过 spawnAgentCore 的每条路径。与
   *  agent_spawned 对应；(attempted − spawned) 即激活漏斗的流失。 */
  agent_spawn_attempted: new Set<string>(['provider']),
  /** 一次 spawn 未产生运行中的 agent。`reason` 是固定枚举（见
   *  SpawnFailReason）：`cli_missing`（引擎缺失且无自动安装器，仅可手动）、
   *  `cwd_missing`、`already_running`、`spawn_error`。 */
  agent_spawn_failed: new Set<string>(['provider', 'reason']),
  /** 引擎 CLI 缺失，因此自动安装器 PTY 启动。`rung` 是固定枚举（见
   *  InstallRung）：`npm`、`node-then-npm`、`native`。 */
  agent_install_started: new Set<string>(['provider', 'rung']),
  /** 自动安装器 PTY 已退出。`outcome` 是固定枚举（见
   *  InstallOutcome）：`agent_launched`（干净退出，agent 正在重新启动）或
   *  `install_failed`（非零退出——例如无法无人值守完成的安装器）。这是
   *  首个 agent 从未真正启动的信号。 */
  agent_install_finished: new Set<string>(['provider', 'rung', 'outcome']),
  /** ── 激活漏斗的末端（v0.4.6）：一个「人」向 agent 发送了消息。在提交
   *  （SUBMIT）边界计数，绝不按每次击键——可发送消息的四个位置见
   *  MESSAGE_SURFACES。只携带一个计数，别无其他：没有文本、没有长度、没有哈希。
   *  `surface` 是封闭枚举。 */
  message_sent: new Set<string>(['surface']),
  /** 粗粒度的功能采纳情况；`feature` 是固定枚举（见 FEATURES），每个功能在每个
   *  应用会话内至多触发一次。 */
  feature_used: new Set<string>(['feature']),
  /** 退出时触发。`duration_bucket` 是粗粒度标签，绝不是原始毫秒数。 */
  session_ended: new Set<string>(['duration_bucket'])
};

/** `feature_used.feature` 唯一可取的值。 */
export type AnalyticsFeature =
  | 'slack_trigger'
  | 'webhook_trigger'
  | 'hire_install'
  | 'voice_dictation';

/** `agent_spawn_failed.reason` 唯一可取的值。封闭枚举，因此「agent 为何未启动」
 *  的拆分永远不会携带自由格式消息。 */
export type SpawnFailReason = 'cli_missing' | 'cwd_missing' | 'already_running' | 'spawn_error';

/** 安装事件的 `rung` 唯一可取的值。对应
 *  cliInstall.InstallRungKind 减去 `manual`——manual 这一级不产生安装器，
 *  因此它永远不会到达 agent_install_started；它会成为 agent_spawn_failed:cli_missing。 */
export type InstallRung = 'npm' | 'node-then-npm' | 'native';

/** `agent_install_finished.outcome` 唯一可取的值。 */
export type InstallOutcome = 'agent_launched' | 'install_failed';

/** `message_sent.surface` 唯一可取的值——人（HUMAN）可以向 agent 发送消息的
 *  四个位置：
 *
 *   - `terminal` — 直接键入 agent 的终端并按 Enter 提交（terminalPool 的
 *     提交边界，不是 `pty:write`——后者每次击键都会触发，统计的是打字而非
 *     消息）。
 *   - `composer` — 每个 agent 的消息队列编辑器（composer）。
 *   - `steer`    — agent 控制条上的 steer 输入框。
 *   - `hive`     — 由人发送的 hive 消息（Command Center 派发、线程回复、
 *     ASK ME 回答）。agent 之间的 hive 流量不计入：`hive:send` 携带 `from`，
 *     只有 `'human'` 才符合条件。
 *
 *  封闭枚举，与这里每个其他属性规则相同。 */
export const MESSAGE_SURFACES = ['terminal', 'composer', 'steer', 'hive'] as const;
export type MessageSurface = typeof MESSAGE_SURFACES[number];

/** 渲染进程（RENDERER）被允许通过 IPC 命名的 MESSAGE_SURFACES 子集。
 *
 *  `steer` 和 `hive` 在 main 进程中、在已经接收它们的 IPC 处理器处计数，
 *  因此渲染进程绝不能命名这两个——否则未来某个渲染进程调用点会把
 *  main 已经计过数的消息重复计数。`terminal` 和 `composer` 是
 *  main 无法自行看到的仅有的两个提交，
 *  因此它们也是仅有的跨桥（bridge）传输的。 */
const RENDERER_MESSAGE_SURFACES: ReadonlySet<string> = new Set<string>(['terminal', 'composer']);

/** 校验来自渲染进程的 surface。任何越过该界线的输入都不可信，而 `track()` 的
 *  白名单只过滤属性键（KEYS）而不过滤属性值（VALUES）——因此若没有此校验，
 *  无法识别的字符串会作为自由格式值随行，这正是 TELEMETRY.md 承诺绝不会发生的
 *  事。 */
export function isRendererMessageSurface(v: unknown): v is MessageSurface {
  return typeof v === 'string' && RENDERER_MESSAGE_SURFACES.has(v);
}

export interface AnalyticsInitOptions {
  /** 安装 id 文件所在目录（userData）。若不存在则创建。 */
  stateDir: string;
  /** 打在每个事件上的应用版本。 */
  appVersion: string;
  /** 启动时用户的 `telemetryEnabled` 配置（默认 true = opt-out）。 */
  enabled: boolean;
}

function dntSet(): boolean {
  const v = process.env.DO_NOT_TRACK;
  return v !== undefined && v !== '' && v !== '0';
}

/** 仅为单元测试导出——index.ts 使用下方 `analytics` 单例。构造全新实例是
 *  在单个进程中多次演练每次安装只发生一次的路径（first_run、update_applied）
 *  的唯一方式。 */
export class Analytics {
  private client: PostHog | null = null;
  private distinctId = '';
  private enabled = false;
  private firstRun = false;
  /** 当状态目录不可写、loadOrMintInstallId 回退到临时 id 时为 false。这样
   *  的安装无法在多次启动之间被识别，因此绝不能上报版本变迁——否则它会在
   *  每次启动时都上报一次，虚增 update_applied 恰恰要统计的那个数字，
   *  这个数字正是它存在的目的。 */
  private idPersisted = false;
  private startedAt = 0;
  private sessionEnded = false;
  /** 针对 feature_used 的会话级去重。 */
  private readonly featuresSeen = new Set<string>();
  private common: Record<string, string> = {};

  /** 启动客户端（没有构建期密钥 / 设置了 DNT 时为 no-op）。返回
   *  本次启动是否铸造了全新的安装 id（首次运行）。 */
  init(opts: AnalyticsInitOptions): void {
    this.enabled = opts.enabled;
    this.startedAt = Date.now();
    this.common = {
      app_version: opts.appVersion,
      os: process.platform,
      arch: process.arch
    };
    if (!__POSTHOG_KEY__ || dntSet()) return; // 保持静默：无客户端、无 id 文件
    try {
      this.distinctId = this.loadOrMintInstallId(opts.stateDir);
      this.client = new PostHog(__POSTHOG_KEY__, {
        host: __POSTHOG_HOST__ || 'https://us.i.posthog.com',
        // 事件很少（每个会话只有几个）——立即发送，这样退出时最多丢失最后的
        // session_ended，绝不会丢失整批。
        flushAt: 1,
        flushInterval: 10_000,
        // GeoIP 保持关闭（posthog-node 默认）。此前曾在此为获取国家级别数字
        // 而显式重新启用，但本代码库从未读取过国家，而且启用它会让 PostHog
        // 同时推导城市、邮政编码和经纬度——远超 TELEMETRY.md 所述的
        // 国家范围。
        disableGeoip: true
      });
    } catch (e) {
      console.error('[analytics] init failed (telemetry disabled):', e);
      this.client = null;
      return;
    }
    // 版本变迁检测。在刷新打点之前读取，在发送之前打点：此处「至多一次」
    // （at-most-once）优于「至少一次」（at-least-once），因为重复的
    // update_applied 会破坏它本要统计的那个数字，而丢失一次只是成千上万
    // 次安装中损失一次。
    // 对在应用内（IN THE APP）选择退出的用户，打点仍会刷新——我们只在本地
    // 记录，由 track() 决定是否有内容离开机器，因此重新开启后绝不会从
    // 静默期回补一次变迁。
    // 在 DO_NOT_TRACK 或无构建密钥的情况下打点不会被刷新，因为 init() 早在
    // 任何代码运行前就返回了：这些安装根本不写文件，而一个之后取消 DNT 的
    // 用户只会上报一次 'unknown'。
    let transition: VersionTransition | null = null;
    if (this.idPersisted) {
      const previous = readVersionStamp(opts.stateDir);
      transition = updateTransition(previous, opts.appVersion, this.firstRun);
      if (previous !== opts.appVersion) writeVersionStamp(opts.stateDir, opts.appVersion);
    }

    if (this.firstRun) this.track('first_run');
    if (transition) {
      const via = updateVia(readUpdaterLogTail(opts.stateDir), transition.to_version);
      this.track('update_applied', { ...transition, via });
    }
    this.track('app_launched');
  }

  /** 从设置中实时选择加入/退出。关闭会立即停止发送；重新开启无需重建
   *  任何东西。 */
  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  /** 捕获一个白名单内的事件。不在 EVENTS 中的内容被静默丢弃。 */
  track(event: string, props: Record<string, string> = {}): void {
    if (!this.client || !this.enabled || dntSet() || this.sessionEnded) return;
    const allowed = EVENTS[event];
    if (!allowed) return;
    const properties: Record<string, unknown> = {
      ...this.common,
      $process_person_profile: false, // 匿名事件——不创建人物画像
      // 仅当事件未携带 $ip 时，PostHog 才会从连接中填充 $ip，因此显式
      // 将其发送为 null 是阻止 IP 被存储的唯一的客户端方式。与项目级
      // 丢弃（discard）设置双保险：仅此一项就保护了从这里发送的每个
      // 事件。
      $ip: null
    };
    for (const [k, v] of Object.entries(props)) {
      if (allowed.has(k) && typeof v === 'string') properties[k] = v;
    }
    try {
      this.client.capture({ distinctId: this.distinctId, event, properties });
    } catch (e) {
      console.error('[analytics] capture failed:', e);
    }
  }

  /** 一条人类发送的消息。不去重——与 trackFeature 不同，这是一个用量表
   *  （usage meter），计数正是其意义所在。在运行时重新检查该枚举，
   *  因为 `terminal`/`composer` 这两个 surface 源于渲染进程。 */
  trackMessageSent(surface: MessageSurface): void {
    if (!(MESSAGE_SURFACES as readonly string[]).includes(surface)) return;
    this.track('message_sent', { surface });
  }

  /** feature_used，带会话级去重（采纳信号，而非用量表）。 */
  trackFeature(feature: AnalyticsFeature): void {
    if (this.featuresSeen.has(feature)) return;
    this.featuresSeen.add(feature);
    this.track('feature_used', { feature });
  }

  /** 触发 session_ended 并刷新。由调用方限定时间（will-quit 会把它与超时
   *  竞争）——绝不要假设它会完成。幂等。 */
  async endSession(): Promise<void> {
    if (!this.client || this.sessionEnded) return;
    this.track('session_ended', { duration_bucket: durationBucket(Date.now() - this.startedAt) });
    this.sessionEnded = true;
    try {
      await this.client.shutdown();
    } catch (e) {
      console.error('[analytics] shutdown flush failed:', e);
    }
    this.client = null;
  }

  private loadOrMintInstallId(stateDir: string): string {
    const file = join(stateDir, 'telemetry-install-id');
    try {
      if (existsSync(file)) {
        const id = readFileSync(file, 'utf8').trim();
        if (id) {
          this.idPersisted = true;
          return id;
        }
      }
      const id = randomUUID();
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(file, id + '\n', 'utf8');
      this.firstRun = true;
      this.idPersisted = true;
      return id;
    } catch (e) {
      // 状态目录不可写：为本次会话使用临时 id，而不是在 analytics 上失败关闭
      // （仍然匿名，只是不稳定）。
      console.error('[analytics] install-id persist failed (ephemeral id):', e);
      return randomUUID();
    }
  }
}

/** 该安装上次运行的版本，与安装 id 一起保存在 userData 中。
 *  删除应用数据目录会像清除安装 id 一样清除它。 */
const VERSION_STAMP_FILE = 'telemetry-last-version';

/** 只要求符合 Semver 形态，别无其他。打点是 userData 中一个用户可以编辑的
 *  普通文件，因此输出时会重新校验——即使面对手工编辑过的状态目录，也能保证
 *  `from_version` 可证明是封闭形式，并兑现 TELEMETRY.md「不含自由格式内容」
 *  的承诺。 */
const VERSION_RE = /^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(?:-[0-9A-Za-z.]{1,32})?$/;

/** 这是一个类型别名，不是 interface：`track()` 接收 `Record<string, string>`，
 *  而 TypeScript 只会给对象 *类型别名* 隐式索引签名。 */
export type VersionTransition = {
  from_version: string;
  to_version: string;
};

/** 判断一次启动是否为版本变迁的唯一位置。
 *
 *  - `firstRun`（安装 id 刚刚铸造）→ 全新安装，绝不是更新。这正
 *    是保持 update_applied 与 first_run 不相交的原因。
 *  - 已有 id 的安装却没有打点 → 该安装早于版本打点功能，因此
 *    它是从某个更早的版本来到这里的：`from_version: 'unknown'`。
 *    这使首个携带该事件的版本可被度量，而不是沉默
 *    整整一个周期。
 *  - 打点 !== 当前 → 版本变迁（降级也会如实上报，
 *    即 from > to）。
 *  - 打点 === 当前 → 普通重新启动。无事发生。
 *
 *  纯函数并导出，因此可以在不依赖 PostHog 的情况下对决策做单元测试。 */
export function updateTransition(
  previous: string | null,
  current: string,
  firstRun: boolean
): VersionTransition | null {
  if (firstRun) return null;
  if (!VERSION_RE.test(current)) return null; // 无法命名我们落到的版本
  if (previous === current) return null;
  return {
    from_version: previous && VERSION_RE.test(previous) ? previous : 'unknown',
    to_version: current
  };
}

/** 原始打点，缺失或不可读时为 null。绝不抛异常。 */
export function readVersionStamp(stateDir: string): string | null {
  try {
    const file = join(stateDir, VERSION_STAMP_FILE);
    if (!existsSync(file)) return null;
    return readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** 尽力而为。打点失败只意味着下次启动可能再次上报该变迁；绝不能让
 *  应用崩溃。 */
export function writeVersionStamp(stateDir: string, version: string): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, VERSION_STAMP_FILE), version + '\n', 'utf8');
  } catch (e) {
    console.error('[analytics] version stamp persist failed:', e);
  }
}

/** ── 是我们的更新器，还是用户手动重装？──────────────────────
 *
 *  `update_applied` 单独只能说明版本移动了；它无法说明
 *  是什么移动了它，因为自动更新和手动重新下载都会保留
 *  userData、保留安装 id，并推进版本。显而易见的修法是在
 *  用户点击 restart-to-install 时由旧进程写入一个标记——但旧
 *  进程是已发布在外的构建，所以现在添加的标记恰恰对我们需要
 *  关注的版本毫无用处，只会在一个周期之后才开始说
 *  真话。
 *
 *  事实上我们并不需要新标记：`updater.ts` 自 v0.3.7 起就向 `updater.log`
 *  追加了一行，且下面两行在已发布的 v0.4.3 和 v0.4.4 构建中是逐字节相同的。
 *  一次自动更新会留下这一有序对：
 *
 *      update downloaded: <version> — waiting for the user to restart
 *      quitAndInstall requested by the user
 *
 *  按版本匹配正是其可信之处：来自上一次升级遗留的
 *  有序对指向那个更老的版本，因此不会被误认为本次。
 *  该有序对是必要条件但不充分，因为 `quitAndInstall()`
 *  可能在未安装任何东西的情况下就返回——所以请求之后
 *  启动时命名的版本不同，或退出警告被拒绝，都会被归回
 *  `manual`。这一修正从 0.4.5 起比之前更重要：标题栏徽章
 *  现在是手动下载，因此自动安装悄悄什么都没做的用户，
 *  正是随后会去手动下载的用户，而把那次安装记成 `auto`
 *  会美化那条失败的路径。
 *  读取日志仅仅是为了推导下面的封闭枚举——其中的任何行、路径或消息都
 *  绝不会被发送，且 updater.ts 并未被修改来支持此功能
 *  （`test/update-applied.test.cjs` 断言这两个字面量仍然匹配，因此未来
 *  改词会让测试套件失败，而不是悄悄劣化该指标）。
 */
const LOG_FILE = 'updater.log';
const LOG_DOWNLOADED = 'update downloaded: ';
const LOG_QUIT_REQUESTED = 'quitAndInstall requested by the user';
const LOG_QUIT_FAILED = 'quitAndInstall failed:';
/** 每次打包启动时写一次，指明启动的版本——在已发布的 v0.4.3 和 v0.4.4 中
 *  已存在，因此 0.4.5 一跳时可读。 */
const LOG_READY = /native updater ready \(current v([^)\s]+)\)/;
/** 仅 0.4.5 及之后才有，因此它从 0.4.6 一跳开始产生价值。 */
const LOG_QUIT_CANCELLED = 'quitAndInstall cancelled by the user at the quit warning';
/** 日志每次更新只增长一两行，例行检查时从不增长，因此这里可能有数年历史
 *  ——但它是用户可写的文件，所以读取是有界（bounded）的，而不是完全
 *  信任。 */
const LOG_TAIL_BYTES = 128 * 1024;

/** `auto` 表示我们的更新器安装了它，`manual` 表示其他东西移动了版本，
 *  `unknown` 表示没有可读的日志（因此也没有任何一方的证据）。 */
export type UpdateVia = 'auto' | 'manual' | 'unknown';

/** 纯函数：给定日志文本与我们所处的版本，给出完整判断。 */
export function updateVia(logText: string | null, toVersion: string): UpdateVia {
  if (logText === null) return 'unknown';
  const lines = logText.split('\n');
  // 前向断言排除了版本可以继续匹配的每个字符，因此 `0.4.5` 既不会匹配
  // `0.4.55` 也不会匹配预发布版 `0.4.5-beta.1`——两者都是不同的构建，
  // 下载其中一个并不能作为另一个的证据。
  const downloaded = new RegExp(
    `${LOG_DOWNLOADED}${toVersion.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}(?![0-9.\\-])`
  );

  // 该版本的最后一次下载——更早的都属于之前的升级，反正会命名不同
  // 的版本。
  let i = -1;
  for (let n = 0; n < lines.length; n++) if (downloaded.test(lines[n])) i = n;
  if (i < 0) return 'manual';

  // 在该下载之后出现的重启请求。日志只追加，因此文件顺序即
  // 时间顺序。
  let j = -1;
  for (let n = i + 1; n < lines.length; n++) if (lines[n].includes(LOG_QUIT_REQUESTED)) j = n;
  if (j < 0) return 'manual';

  // updater.ts 会在请求之后紧接的 catch 中记录失败，因此抛异常的
  // 尝试正好是下一行——应用从未退出，之后无论什么移动了版本都
  // 不是我们。
  if (lines[j + 1]?.includes(LOG_QUIT_FAILED)) return 'manual';

  // 抛异常的请求是简单情形。真正要紧的是干净返回却仍未安装的请求：
  // `quitAndInstall()` 不报告任何结果（updater.ts 在其自身的头部注释里
  // 也这么说），因此静默的 no-op 与成功安装是同一行。日志无论如何都能
  // 将它们区分开，因为随后运行的 NEXT 应用会表明
  // 自己的身份：
  //
  //  - 启动时命名的版本不是我们所处的版本，意味着在请求重启之后
  //    运行的是非目标构建，
  //    因此那次重启并未安装本版本；
  //  - 用户拒绝退出警告也直截了当地说明了同样的事。
  //
  // 两者都只能作为反证。它们的不存在并不是成功的证据，因此这里仍然无法
  // 发现那种安装失败且之后没有任何东西运行的场景。
  for (let n = j + 1; n < lines.length; n++) {
    if (lines[n].includes(LOG_QUIT_CANCELLED)) return 'manual';
    const launched = LOG_READY.exec(lines[n]);
    if (launched && launched[1] !== toVersion) return 'manual';
  }
  return 'auto';
}

/** updater.log 的最后 LOG_TAIL_BYTES 字节，没有可读内容时为 null。
 *  绝不抛异常——日志缺失本身就是一个答案（'unknown'），而非失败。 */
export function readUpdaterLogTail(stateDir: string): string | null {
  let fd: number | null = null;
  try {
    const file = join(stateDir, LOG_FILE);
    if (!existsSync(file)) return null;
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    if (size === 0) return null;
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buf = Buffer.allocUnsafe(length);
    readSync(fd, buf, 0, length, size - length);
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* 无事可做 */ } }
  }
}

/** 粗粒度、不可识别的会话时长标签。 */
function durationBucket(ms: number): string {
  const m = ms / 60_000;
  if (m < 5) return '<5m';
  if (m < 30) return '5-30m';
  if (m < 120) return '30m-2h';
  if (m < 480) return '2-8h';
  return '8h+';
}

/** 进程级单例，与 index.ts 拥有其他服务的方式一致。 */
export const analytics = new Analytics();

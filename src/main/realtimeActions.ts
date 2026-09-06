/**
 * Realtime Michael —— 语音动作主干（卡片 rt-5，第二阶段）。
 *
 * 第一阶段给了语音版 Michael 读取工具。第二阶段给他写权限：他可以用纯语音
 * ping/调度 agent、编辑任务看板、引导/暂停/中止/杀死 worker、雇佣新 worker、
 * 编辑日程。因为确认面是纯语音的（人类拒绝了屏幕上的确认卡片），本文件中的
 * 回声主干就是全部的安全面，所以它全部住在 MAIN（受信任的一侧）——渲染进程
 * 的工具只是薄调用方。纵深防御：即使模型（或杂音音频）尝试越界，MAIN 也会
 * 强制层级、独立的确认 token 和硬白名单。
 *
 * 分层（2026-06-25 由人类锁定，见 board.md 第二阶段）：
 *   • 软写入  —— ping、创建/分配/更新任务、调度、引导 —— 直接执行
 *     （爆炸半径小；完全可逆 / 建议性质）。
 *   • 破坏性 / 昂贵 —— 雇佣、杀死、暂停、中止、edit_schedule ——
 *     需要两步口头回声：(1) 原样念回确切的动词 + 目标
 *     （+ spawn/hire 的 $ 估算——此处为占位；rt-9 接入真实数字），
 *     (2) 一个独立的确认 token（动词词或 "confirm"——绝不是裸的
 *     "yes"，以免环境语音授权一次 kill），(3) 提交瞬间麦克风空闲
 *     （渲染进程在确认工具调用期间静音麦克风——见 session.ts
 *     agent_tool_start），(4) 熔断器仍然门控（动作走它所拥有的
 *     同一条控制路径）。
 *   • 硬白名单 —— 对 god 编排器 kill/pause/halt，以及任何批量 /
 *     全体 agent 操作，即使有有效确认也禁止语音执行——直接拒绝，
 *     不创建 pending。
 *
 * 每个已提交的动作都归属 actor `michael-voice`（每个动词上的日志戳 +
 * 消息上的 `from: michael-voice`）。rt-7 把它深化为实时的 god-PTY
 * 交叉通知；rt-5 只需要归属在场即可。
 *
 * 只是薄包装——没有新的编排逻辑。每个动词映射到 god PTY 已在用的
 * 主函数（hive.send / writeTasks / spawnAgentCore /
 * control.pause+steer+halt / pty kill / missions save），通过 deps 注入，
 * 让本模块与 index.ts 接线解耦。
 */
import { ipcMain } from 'electron';
import type { HiveMessage, HiveTask, Registry } from './hive';
import type { ScheduledMission } from './config';
import { inferAgentProvider } from '../shared/agentProvider';
import { clearCommandForProvider } from '../shared/providerAutomation';
import { resolveGodName } from '../shared/godIdentity';

export const VOICE_ACTOR = 'michael-voice';

/** 最小化 spawn 规格——index.ts 把它适配成自己的 AgentSpawnOptions + spawnAgentCore。 */
export interface RealtimeSpawnSpec {
  id: string;
  cwd: string;
  command: string;
  provider?: string;
  hive?: { id: string; name: string; provider?: string; role?: string; cwd: string };
}

/** 语音动作包装的既有主函数，从 index.ts 注入，让这里的安全逻辑可做
 *  单元测试，index.ts 保持为薄适配器。 */
export interface RealtimeActionDeps {
  hiveEnabled(): boolean;
  hiveSend(partial: Partial<HiveMessage>, from: string): HiveMessage;
  hiveTasks(): unknown;
  hiveWriteTasks(tasks: HiveTask[]): void;
  hiveRegistry(): Registry;
  hiveLog(event: Record<string, unknown>): void;
  controlPause(agentId: string, on: boolean): void;
  controlSteer(agentId: string, text: string): void;
  controlHalt(agentId: string): void;
  controlSnapshot(agentId: string): { paused?: boolean; halted?: boolean } | null;
  killAgent(agentId: string): { ok: boolean; error?: string };
  spawnAgent(opts: RealtimeSpawnSpec): Promise<{ ok: boolean; error?: string }>;
  listMissions(): ScheduledMission[];
  saveMissions(missions: ScheduledMission[]): void;
  /** rt-12：向完成观察器注册一次语音调度，让引擎能检测它结束并说出通知。
   *  可选——在 index.ts 中接线。 */
  trackDispatch?(d: { correlationId: string; targetAgentId: string; objective?: string; dispatchedAt: number; dispatchMessageId?: string }): void;
  // ── v0.3.4 全控制扩展 ──
  controlResume(agentId: string): void;
  controlAutoDelivery(agentId: string, paused: boolean): void;
  controlGateTool(agentId: string, tool: string, on: boolean): void;
  setArchived(agentId: string, archived: boolean): { ok: boolean; error?: string };
  /** clear_context：把文本推入 agent 的渲染进程消息队列，于是投递会经过
   *  每一个既有的门（仅空闲、启动宽限、草稿/选择器安全、自动投递暂停）。 */
  enqueueToAgent(agentId: string, text: string): void;
  /** update_setting：非机密配置快照 + 补丁。本文件中按 key 的策略表是
   *  从语音到配置的唯一路径——绝不暴露原始补丁。 */
  getConfigValue(key: string): unknown;
  patchConfig(patch: Record<string, unknown>): void;
}

/** 每个 action / confirm / cancel 返回给渲染进程工具的结果，后者把
 *  `spoken` 直接交给模型去说。 */
export interface ActionResult {
  ok: boolean;
  spoken: string;
  /** 当破坏性操作此刻正等待口头确认时为 true。 */
  needsConfirm?: boolean;
}

type Tier = 'soft' | 'destructive';

/** 每个动词的规格：层级 + 确认中必须出现、面向人类的词。 */
const VERBS: Record<string, { tier: Tier; confirmWord: string; agentTargeted: boolean }> = {
  ping: { tier: 'soft', confirmWord: 'ping', agentTargeted: true },
  create_task: { tier: 'soft', confirmWord: 'create', agentTargeted: false },
  assign_task: { tier: 'soft', confirmWord: 'assign', agentTargeted: false },
  update_task: { tier: 'soft', confirmWord: 'update', agentTargeted: false },
  dispatch: { tier: 'soft', confirmWord: 'dispatch', agentTargeted: true },
  steer: { tier: 'soft', confirmWord: 'steer', agentTargeted: true },
  spawn: { tier: 'destructive', confirmWord: 'spawn', agentTargeted: false },
  kill: { tier: 'destructive', confirmWord: 'kill', agentTargeted: true },
  pause: { tier: 'destructive', confirmWord: 'pause', agentTargeted: true },
  halt: { tier: 'destructive', confirmWord: 'halt', agentTargeted: true },
  edit_schedule: { tier: 'destructive', confirmWord: 'schedule', agentTargeted: false },
  // ── v0.3.4 全控制扩展 ──
  resume: { tier: 'soft', confirmWord: 'resume', agentTargeted: true },
  auto_delivery: { tier: 'soft', confirmWord: 'delivery', agentTargeted: true },
  gate_tool: { tier: 'soft', confirmWord: 'gate', agentTargeted: true },
  delete_task: { tier: 'soft', confirmWord: 'delete', agentTargeted: false },
  unarchive: { tier: 'soft', confirmWord: 'unarchive', agentTargeted: true },
  clear_context: { tier: 'destructive', confirmWord: 'clear', agentTargeted: true },
  archive: { tier: 'destructive', confirmWord: 'archive', agentTargeted: true },
  create_schedule: { tier: 'destructive', confirmWord: 'schedule', agentTargeted: false },
  update_setting: { tier: 'destructive', confirmWord: 'setting', agentTargeted: false }
};

/** v0.3.4 update_setting 策略——语音唯一能碰的设置，每项都有层级和类型
 *  校验。所有未列出的（harnessHome、每个携带机密的 key、provider 基 URL、
 *  integrations、……）一律拒绝：原始配置带着凭据和危险 key，
 *  未校验的 config:update IPC 绝不能从语音触达。 */
const SETTING_POLICY: Record<string, {
  tier: 'soft' | 'confirm';
  type: 'boolean' | 'number' | 'string';
  min?: number; max?: number; values?: string[];
}> = {
  // soft：外观型 / 低爆炸半径，可即时撤销
  notifications: { tier: 'soft', type: 'boolean' },
  tvShowOffices: { tier: 'soft', type: 'boolean' },
  officeTheme: { tier: 'soft', type: 'string', values: ['office', 'friends', 'brooklyn99', 'siliconvalley', 'got', 'hogwarts'] },
  terminalTheme: { tier: 'soft', type: 'string', values: ['light', 'dark'] },
  freeflowEnabled: { tier: 'soft', type: 'boolean' },
  strongKeepalive: { tier: 'soft', type: 'boolean' },
  autoUpdate: { tier: 'soft', type: 'boolean' },
  realtimeIdleDisconnectMs: { tier: 'soft', type: 'number', min: 30_000, max: 3_600_000 },
  // confirm：改变行为——回声 old→new + 独立 token
  autoMode: { tier: 'confirm', type: 'boolean' },
  defaultModel: { tier: 'confirm', type: 'string' },
  godProvider: { tier: 'confirm', type: 'string' },
  godModel: { tier: 'confirm', type: 'string' },
  maxConcurrentWorkers: { tier: 'confirm', type: 'number', min: 1, max: 16 },
  costCapTokens: { tier: 'confirm', type: 'number', min: 0, max: 1_000_000_000 },
  maxTurns: { tier: 'confirm', type: 'number', min: 1, max: 1000 },
  slackEnabled: { tier: 'confirm', type: 'boolean' },
  webhookEnabled: { tier: 'confirm', type: 'boolean' },
  semanticMemory: { tier: 'confirm', type: 'boolean' },
  multiWindow: { tier: 'confirm', type: 'boolean' }
};

const PENDING_TTL_MS = 120_000;

const PROVIDER_COMMAND: Record<string, string> = {
  claude: 'claude', codex: 'codex', kimi: 'kimi', qwen: 'qwen'
};

/** 绝不能独自授权破坏性操作的裸肯定——环境语音 / 一句乱入的 "yeah"
 *  不能被允许确认一次 kill。 */
const BARE_AFFIRMATIONS = new Set([
  'yes', 'yeah', 'yep', 'yup', 'ya', 'ok', 'okay', 'k', 'sure', 'go', 'go ahead',
  'do it', 'please', 'fine', 'affirmative', 'uh huh', 'mhm', 'mm hmm', 'right', 'correct'
]);

// ─── 辅助 ────────────────────────────────────────────────────────────────

const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const norm = (s: string): string => s.toLowerCase().replace(/[.!?,;:'"]/g, ' ').replace(/\s+/g, ' ').trim();
/** N1 (rt-10 hardening): escape regex metachars before interpolating a verb word into
 *  `new RegExp`. Safe with today's verb vocab (plain words) — defense in depth. */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function shortId(): string {
  // 应用代码（不是 Workflow 脚本）——这里用 Math.random 没问题。
  return Math.random().toString(36).slice(2, 8);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'agent';
}

/** 说出的目标是批量 / 全体 agent 引用吗？无论有没有确认，破坏性动词都
 *  禁止语音执行这些。 */
function isMassTarget(target: string): boolean {
  const t = norm(target);
  if (!t) return false;
  if (/\b(all|every|everyone|everybody)\b/.test(t)) return true;
  if (t === '*' || t === 'agents' || t === 'the team' || t === 'team' || t === 'fleet' || t === 'everything')
    return true;
  // 逗号/and 分隔的多目标列表
  if (/,| and /.test(t)) return true;
  return false;
}

interface ResolvedAgent { id: string; name: string; isGod: boolean }

/** 把说出的目标（"jim"、"kill oscar"、一个 id）解析成单个存活 agent，
 *  否则返回口述的消歧错误。优先选未归档的匹配。 */
function resolveAgent(target: string, reg: Registry): ResolvedAgent | { error: string } {
  const t = norm(target);
  if (!t) return { error: '未指定任何 agent' };
  const entries = Object.entries(reg.agents ?? {});
  const mk = (id: string, m: { name?: string; isGod?: boolean }): ResolvedAgent => ({
    id, name: m.name || id, isGod: !!m.isGod || id === reg.godId
  });
  // 精确 id
  const byId = entries.find(([id]) => id.toLowerCase() === t);
  if (byId) return mk(byId[0], byId[1]);
  // 编排器的 'god' / 'michael' 别名
  if ((t === 'god' || t === 'michael' || t === 'the god') && reg.godId)
    return mk(reg.godId, reg.agents[reg.godId] ?? {});
  // 精确名称，优先存活的
  const byName = entries.filter(([, m]) => (m.name || '').toLowerCase() === t);
  const liveName = byName.filter(([, m]) => !m.archived);
  const namePick = liveName.length ? liveName : byName;
  if (namePick.length === 1) return mk(namePick[0][0], namePick[0][1]);
  if (namePick.length > 1)
    return { error: `${namePick.length} 个 agent 都叫 ${target}——请说出确切的 agent id` };
  // 部分包含，仅存活
  const partial = entries.filter(
    ([id, m]) => !m.archived && (id.toLowerCase().includes(t) || (m.name || '').toLowerCase().includes(t))
  );
  if (partial.length === 1) return mk(partial[0][0], partial[0][1]);
  if (partial.length > 1) return { error: `有多个 agent 匹配 "${target}"——请说得更具体或报出 id` };
  return { error: `没有找到匹配 "${target}" 的 agent` };
}

/** 独立 token 确认检查。只有当句子带有动词词或字面 "confirm" 时才接受；
 *  裸肯定（"yes"、"ok"）被拒绝。 */
function confirmAccepted(phrase: string, confirmWord: string): boolean {
  const p = norm(phrase);
  if (!p) return false;
  if (BARE_AFFIRMATIONS.has(p)) return false;
  if (/\bconfirm(ed|s)?\b/.test(p)) return true;
  if (new RegExp(`\\b${escapeRegExp(confirmWord)}\\b`).test(p)) return true;
  return false;
}

// ─── pending（单槽两阶段确认）───────────────────────────────────────────────

interface Pending {
  verb: string;
  confirmWord: string;
  targetLabel: string;
  createdAt: number;
  commit: () => Promise<string>;
}
let pending: Pending | null = null;

function pendingFresh(): Pending | null {
  if (pending && Date.now() - pending.createdAt > PENDING_TTL_MS) pending = null;
  return pending;
}

// ─── 软写入执行器（立即运行）────────────────────────────────────────────────

function attribute(deps: RealtimeActionDeps, verb: string, target: string, extra: Record<string, unknown> = {}): void {
  try {
    deps.hiveLog({ kind: 'voice_action', actor: VOICE_ACTOR, verb, target, ...extra });
  } catch {
    /* 归属是尽力而为——绝不阻塞动作 */
  }
  // rt-7 双编排器协调：告诉 god PTY 语音版 Michael 刚刚提交了什么，让
  // 两个自主编排器保持相互感知，不做重复/矛盾的动作。attribute() 只在已提交
  // 的写入上运行（软执行 + 确认后的提交），所以 god 绝不会收到仅仅是
  // 提议/未提交的破坏性动作的通知。
  try {
    const detail =
      typeof extra.objective === 'string' ? `: ${extra.objective}`
      : typeof extra.text === 'string' ? `: ${extra.text}`
      : typeof extra.title === 'string' ? `: ${extra.title}`
      : typeof extra.status === 'string' ? ` → ${extra.status}`
      : typeof extra.action === 'string' ? ` (${extra.action})`
      : '';
    const reg = deps.hiveRegistry();
    const godName = resolveGodName(reg.agents[reg.godId ?? 'god']?.name);
    deps.hiveSend(
      {
        to: 'god',
        act: 'inform',
        subject: `语音动作：${verb} ${target}`,
        body: `${godName}（语音编排器，${VOICE_ACTOR}）刚刚执行了：对 ${target} 执行 ${verb}${detail}。提醒一下以免重复——看板是唯一的事实来源。`
      },
      VOICE_ACTOR
    );
  } catch {
    /* god 交叉通知是尽力而为——绝不阻塞动作 */
  }
}

function findTasks(deps: RealtimeActionDeps): HiveTask[] {
  const data = deps.hiveTasks() as { tasks?: unknown } | null;
  return Array.isArray(data?.tasks) ? (data!.tasks as HiveTask[]) : [];
}

function execPing(deps: RealtimeActionDeps, a: Record<string, unknown>): ActionResult {
  const reg = deps.hiveRegistry();
  const r = resolveAgent(str(a.agentId) || str(a.target) || str(a.name), reg);
  if ('error' in r) return { ok: false, spoken: r.error };
  const message = str(a.message) || str(a.text) || '打个招呼。';
  deps.hiveSend({ to: r.id, act: 'inform', subject: `来自 ${resolveGodName(reg.agents[reg.godId ?? 'god']?.name)} 的语音消息`, body: message }, VOICE_ACTOR);
  attribute(deps, 'ping', r.id);
  return { ok: true, spoken: `已给 ${r.name} 发了消息。` };
}

function execDispatch(deps: RealtimeActionDeps, a: Record<string, unknown>): ActionResult {
  const reg = deps.hiveRegistry();
  const r = resolveAgent(str(a.agentId) || str(a.target) || str(a.name), reg);
  if ('error' in r) return { ok: false, spoken: r.error };
  const objective = str(a.objective) || str(a.task) || str(a.message);
  if (!objective) return { ok: false, spoken: '我要派发什么？需要一个目标说明。' };
  // 四部分契约 → 投递到 agent 的 inbox。
  const body =
    `OBJECTIVE: ${objective}\n` +
    `背景：${str(a.context) || '（未提供）'}\n` +
    `约束：${str(a.constraints) || '（自行判断；遵守护栏）'}\n` +
    `完成标准：${str(a.doneWhen) || str(a.done) || '把结果回报给 god'}`;
  const msg = deps.hiveSend(
    { to: r.id, act: 'request', subject: `语音派发：${objective.slice(0, 60)}`, body, requires_reply: true },
    VOICE_ACTOR
  );
  attribute(deps, 'dispatch', r.id, { objective: objective.slice(0, 120) });
  // rt-12：注册，让完成观察器能在 r.id 完成时告诉我们。
  deps.trackDispatch?.({ correlationId: msg.id, targetAgentId: r.id, objective, dispatchedAt: Date.now(), dispatchMessageId: msg.id });
  return { ok: true, spoken: `已派发任务给 ${r.name}：${objective.slice(0, 80)}。` };
}

function execSteer(deps: RealtimeActionDeps, a: Record<string, unknown>): ActionResult {
  const reg = deps.hiveRegistry();
  const r = resolveAgent(str(a.agentId) || str(a.target) || str(a.name), reg);
  if ('error' in r) return { ok: false, spoken: r.error };
  const text = str(a.text) || str(a.message) || str(a.steer);
  if (!text) return { ok: false, spoken: '要用什么指导去引导他们？' };
  deps.controlSteer(r.id, `[${VOICE_ACTOR}] ${text}`);
  attribute(deps, 'steer', r.id, { text: text.slice(0, 120) });
  return { ok: true, spoken: `正在引导 ${r.name}：${text.slice(0, 80)}。` };
}

function execCreateTask(deps: RealtimeActionDeps, a: Record<string, unknown>): ActionResult {
  const title = str(a.title) || str(a.task) || str(a.name);
  if (!title) return { ok: false, spoken: '任务该叫什么标题？' };
  const tasks = findTasks(deps);
  const id = `${slug(title)}-${shortId()}`;
  const card: HiveTask = {
    id,
    title,
    description: str(a.description) || undefined,
    assignee: str(a.assignee) || undefined,
    status: 'todo',
    dependsOn: [],
    priority: typeof a.priority === 'number' ? a.priority : 5,
    createdAt: new Date().toISOString()
  };
  deps.hiveWriteTasks([...tasks, card]);
  attribute(deps, 'create_task', id, { title: title.slice(0, 120), assignee: card.assignee });
  return { ok: true, spoken: `已创建任务「${title}」${card.assignee ? `，指派给 ${card.assignee}` : ''}。` };
}

// 仅供匹配的归一化器：剥掉所有非字母数字（含连字符），让说出的
// "message visibility" 匹配存储的 "message-visibility"。与上面的 `norm`
// 分开，后者必须为确认词回声规则保留 token 形状。
const normMatch = (s: string): string =>
  (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const toksMatch = (s: string): string[] => normMatch(s).split(' ').filter(Boolean);
const AMBIGUOUS_MARGIN = 0.08; // 前两名在此范围内 => 问是哪一个，别猜

/** 给一个口头/键入引用与某张卡片的匹配度打分。0..1。分层、与顺序无关、
 *  容忍截断和标点。镜像 bin/find-task.cjs 的 scoreTask（由它的 --selftest
 *  验证，8/8）。 */
function scoreCard(refNorm: string, refToks: string[], c: HiveTask): number {
  if (!refNorm) return 0;
  const titleN = normMatch(c.title);
  const idN = normMatch(c.id);
  if (idN === refNorm || titleN === refNorm) return 1; // 精确（归一化后）
  if (titleN && (titleN.startsWith(refNorm) || refNorm.startsWith(titleN))) return 0.92; // 截断
  if (idN && idN.startsWith(refNorm)) return 0.9;
  const hay = new Set(toksMatch(c.title).concat(toksMatch(c.id)));
  const coverage = refToks.length ? refToks.filter((w) => hay.has(w)).length / refToks.length : 0;
  const hayArr = [...hay];
  const prefixCov = refToks.length
    ? refToks.filter((w) => hayArr.some((h) => h.startsWith(w) || w.startsWith(h))).length / refToks.length
    : 0;
  if (coverage === 1) return 0.85; // 每个说出的词都在场（与顺序无关）
  if (titleN.includes(refNorm) || idN.includes(refNorm)) return Math.max(0.7, coverage); // 连续子串
  if (prefixCov === 1) return 0.78; // 每个说出的词都作为前缀在场
  return Math.max(coverage, prefixCov) * 0.7; // 部分重叠
}

/** 找出口头/键入引用所指的卡片。返回得分最高的匹配；当前两名落在
 *  AMBIGUOUS_MARGIN 之内时返回 `ambiguous`（相近的候选）——调用方会问
 *  是哪一个，而不是改错卡片。 */
function findCard(
  deps: RealtimeActionDeps,
  ref: string
): { tasks: HiveTask[]; card: HiveTask | null; ambiguous?: HiveTask[] } {
  const tasks = findTasks(deps);
  const refNorm = normMatch(ref);
  const refToks = toksMatch(ref);
  const scored = tasks
    .map((c) => ({ c, s: scoreCard(refNorm, refToks, c) }))
    .filter((x) => x.s >= 0.45)
    .sort((a, b) => b.s - a.s);
  if (!scored.length) return { tasks, card: null };
  const top = scored[0];
  const close = scored.filter((x) => x.s >= top.s - AMBIGUOUS_MARGIN);
  if (close.length > 1) return { tasks, card: null, ambiguous: close.slice(0, 3).map((x) => x.c) };
  return { tasks, card: top.c };
}

function execAssignTask(deps: RealtimeActionDeps, a: Record<string, unknown>): ActionResult {
  const ref = str(a.taskId) || str(a.task) || str(a.title);
  const assignee = str(a.assignee) || str(a.to) || str(a.agentId);
  if (!ref || !assignee) return { ok: false, spoken: '我需要一个任务以及把任务指派给谁。' };
  const { tasks, card, ambiguous } = findCard(deps, ref);
  if (ambiguous) {
    return { ok: false, spoken: `哪一个——${ambiguous.map((c) => `「${c.title}」`).join('，还是 ')}？` };
  }
  if (!card) return { ok: false, spoken: `找不到匹配 "${ref}" 的任务。` };
  card.assignee = assignee;
  deps.hiveWriteTasks(tasks);
  attribute(deps, 'assign_task', card.id, { assignee });
  return { ok: true, spoken: `已把「${card.title}」指派给 ${assignee}。` };
}

function execUpdateTask(deps: RealtimeActionDeps, a: Record<string, unknown>): ActionResult {
  const ref = str(a.taskId) || str(a.task) || str(a.title);
  if (!ref) return { ok: false, spoken: '要更新哪个任务？' };
  const { tasks, card, ambiguous } = findCard(deps, ref);
  if (ambiguous) {
    return { ok: false, spoken: `哪一个——${ambiguous.map((c) => `「${c.title}」`).join('，还是 ')}？` };
  }
  if (!card) return { ok: false, spoken: `找不到匹配 "${ref}" 的任务。` };
  const status = str(a.status);
  const valid = ['todo', 'doing', 'blocked', 'done'];
  if (status && !valid.includes(status)) return { ok: false, spoken: `"${status}" 不是有效状态。` };
  if (status) card.status = status as HiveTask['status'];
  if (str(a.result)) card.result = str(a.result);
  if (str(a.assignee)) card.assignee = str(a.assignee);
  deps.hiveWriteTasks(tasks);
  attribute(deps, 'update_task', card.id, { status: card.status });
  return { ok: true, spoken: `已更新「${card.title}」${status ? `，状态改为 ${status}` : ''}。` };
}

// ─── v0.3.4 软执行器 ──────────────────────────────────────────────────

function execResume(deps: RealtimeActionDeps, a: Record<string, unknown>): ActionResult {
  const r = resolveAgent(str(a.agentId) || str(a.target) || str(a.name), deps.hiveRegistry());
  if ('error' in r) return { ok: false, spoken: r.error };
  deps.controlResume(r.id);
  attribute(deps, 'resume', r.id);
  return { ok: true, spoken: `已恢复 ${r.name}——工具重新流通。` };
}

function execAutoDelivery(deps: RealtimeActionDeps, a: Record<string, unknown>): ActionResult {
  const r = resolveAgent(str(a.agentId) || str(a.target) || str(a.name), deps.hiveRegistry());
  if ('error' in r) return { ok: false, spoken: r.error };
  const raw = norm(str(a.state) || str(a.action) || (a.paused === true ? 'pause' : a.paused === false ? 'resume' : ''));
  if (!raw) return { ok: false, spoken: '要暂停还是恢复消息投递？' };
  const paused = /pause|off|hold|stop/.test(raw);
  deps.controlAutoDelivery(r.id, paused);
  attribute(deps, 'auto_delivery', r.id, { action: paused ? 'paused' : 'resumed' });
  return {
    ok: true,
    spoken: paused
      ? `已暂停对 ${r.name} 的自动投递——排队的消息会等着。`
      : `已恢复对 ${r.name} 的自动投递。`
  };
}

function execGateTool(deps: RealtimeActionDeps, a: Record<string, unknown>): ActionResult {
  const r = resolveAgent(str(a.agentId) || str(a.target) || str(a.name), deps.hiveRegistry());
  if ('error' in r) return { ok: false, spoken: r.error };
  const toolName = str(a.tool) || str(a.toolName);
  if (!toolName || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(toolName)) {
    return { ok: false, spoken: '要门控哪个工具？给出精确名称，比如 Bash 或 WebFetch。' };
  }
  const raw = norm(str(a.state) || str(a.action));
  const on = !/off|allow|ungate|unblock|enable/.test(raw); // 默认：门控它
  deps.controlGateTool(r.id, toolName, on);
  attribute(deps, 'gate_tool', r.id, { action: `${on ? 'gated' : 'ungated'} ${toolName}` });
  return { ok: true, spoken: `${on ? '已门控' : '已解除门控'} ${r.name} 的 ${toolName} 工具。` };
}

function execDeleteTask(deps: RealtimeActionDeps, a: Record<string, unknown>): ActionResult {
  const ref = str(a.taskId) || str(a.task) || str(a.title);
  if (!ref) return { ok: false, spoken: '要删除哪个任务？' };
  const { tasks, card, ambiguous } = findCard(deps, ref);
  if (ambiguous) return { ok: false, spoken: `哪一个——${ambiguous.map((c) => `「${c.title}」`).join('，还是 ')}？` };
  if (!card) return { ok: false, spoken: `找不到匹配 "${ref}" 的任务。` };
  deps.hiveWriteTasks(tasks.filter((t) => t.id !== card.id));
  attribute(deps, 'delete_task', card.id, { title: card.title.slice(0, 120) });
  return { ok: true, spoken: `已删除任务「${card.title}」。如果删错了，随时可以重建。` };
}

function execUnarchive(deps: RealtimeActionDeps, a: Record<string, unknown>): ActionResult {
  const r = resolveAgent(str(a.agentId) || str(a.target) || str(a.name), deps.hiveRegistry());
  if ('error' in r) return { ok: false, spoken: r.error };
  const res = deps.setArchived(r.id, false);
  attribute(deps, 'unarchive', r.id);
  return res.ok
    ? { ok: true, spoken: `已把 ${r.name} 从归档中恢复。` }
    : { ok: false, spoken: `无法恢复 ${r.name}：${res.error || '未知错误'}。` };
}

// ─── 破坏性提交构造器（确认后运行）───────────────────────────────────────

function buildKill(deps: RealtimeActionDeps, r: ResolvedAgent): () => Promise<string> {
  return async () => {
    const res = deps.killAgent(r.id);
    attribute(deps, 'kill', r.id);
    return res.ok ? `已终止 ${r.name}。` : `无法终止 ${r.name}：${res.error || '未知错误'}。`;
  };
}

function buildPause(deps: RealtimeActionDeps, r: ResolvedAgent): () => Promise<string> {
  return async () => {
    deps.controlPause(r.id, true);
    attribute(deps, 'pause', r.id);
    return `已暂停 ${r.name}。`;
  };
}

function buildHalt(deps: RealtimeActionDeps, r: ResolvedAgent): () => Promise<string> {
  return async () => {
    deps.controlHalt(r.id);
    attribute(deps, 'halt', r.id);
    return `已中止 ${r.name}。`;
  };
}

function buildSpawn(deps: RealtimeActionDeps, spec: RealtimeSpawnSpec, label: string): () => Promise<string> {
  return async () => {
    const res = await deps.spawnAgent(spec);
    attribute(deps, 'spawn', spec.id, { provider: spec.provider, role: spec.hive?.role });
    return res.ok ? `已雇佣 ${label}。` : `无法雇佣 ${label}：${res.error || '未知错误'}。`;
  };
}

function buildClearContext(deps: RealtimeActionDeps, r: ResolvedAgent): () => Promise<string> {
  return async () => {
    // '/clear' 并非通用——过去这里对每个 provider 都硬编码了它，导致
    // Grok/OpenCode/pi（它们的动词是 '/new'）收到一个被当聊天文本打进去的
    // 字面 "/clear"，而 Crush/Copilot 收到一个没有提示能接收它的命令。
    // 解析 provider 自己的动词；null = 没有安全可键入的东西，就直接说出来，
    // 而不是发一条什么都不做的命令。
    const provider = inferAgentProvider(undefined, deps.hiveRegistry().agents?.[r.id]?.provider);
    const command = clearCommandForProvider(provider);
    if (!command) {
      return `${r.name} 运行在 ${provider} 上，而它没有我能键入的清除上下文命令。请在其终端里清除。`;
    }
    // 经渲染进程消息队列排队：投递继承每一个既有的安全门
    // （仅空闲、启动宽限、草稿/选择器保护）。
    deps.enqueueToAgent(r.id, command);
    attribute(deps, 'clear_context', r.id);
    return `已为 ${r.name} 排队一条清除上下文指令——会在它空闲的那一刻送达。`;
  };
}

function buildArchive(deps: RealtimeActionDeps, r: ResolvedAgent): () => Promise<string> {
  return async () => {
    const res = deps.setArchived(r.id, true);
    attribute(deps, 'archive', r.id);
    return res.ok
      ? `已归档 ${r.name}——离开楼层，历史保留。说 unarchive 可恢复。`
      : `无法归档 ${r.name}：${res.error || '未知错误'}。`;
  };
}

function buildEditSchedule(
  deps: RealtimeActionDeps,
  mission: ScheduledMission,
  action: 'enable' | 'disable' | 'delete'
): () => Promise<string> {
  return async () => {
    const all = deps.listMissions();
    let next: ScheduledMission[];
    if (action === 'delete') next = all.filter((m) => m.id !== mission.id);
    else next = all.map((m) => (m.id === mission.id ? { ...m, enabled: action === 'enable' } : m));
    deps.saveMissions(next);
    attribute(deps, 'edit_schedule', mission.id, { action });
    return `${action === 'delete' ? '已删除' : action === 'enable' ? '已启用' : '已停用'}日程「${mission.label}」。`;
  };
}

// ─── propose：分类、白名单门控、运行或暂存 ────────────────────────

function proposeDestructive(deps: RealtimeActionDeps, verb: string, a: Record<string, unknown>): ActionResult {
  const spec = VERBS[verb];
  const reg = deps.hiveRegistry();

  // 面向 agent 的破坏性动词：解析 + 硬白名单（god + 批量）。
  if (spec.agentTargeted) {
    const rawTarget = str(a.agentId) || str(a.target) || str(a.name);
    if (isMassTarget(rawTarget))
      return { ok: false, spoken: `${verb} 一次性对所有 agent 执行是被语音禁止的。请逐个 agent 执行，或改用界面。` };
    const r = resolveAgent(rawTarget, reg);
    if ('error' in r) return { ok: false, spoken: r.error };
    // 每个动词的 god 策略：对 god 的 kill/pause/halt/archive 保持禁止语音。
    // 对 god 的 clear_context 在确认后是允许的——它是可恢复的
    // （会话可续接），而且“清掉 Michael 的上下文”是真实的运维需求。
    if (r.isGod && verb !== 'clear_context')
      return { ok: false, spoken: `${verb} 对 god 编排器执行是被语音禁止的。那必须在界面里操作。` };

    const commit =
      verb === 'kill' ? buildKill(deps, r)
      : verb === 'pause' ? buildPause(deps, r)
      : verb === 'halt' ? buildHalt(deps, r)
      : verb === 'clear_context' ? buildClearContext(deps, r)
      : buildArchive(deps, r);
    const breaker = deps.controlSnapshot(r.id);
    const note = breaker?.halted ? '（注意：已中止）' : breaker?.paused ? '（注意：已暂停）' : '';
    pending = { verb, confirmWord: spec.confirmWord, targetLabel: r.name, createdAt: Date.now(), commit };
    const consequence = verb === 'clear_context'
      ? `这会清除 ${r.name} 对当前会话的工作记忆。`
      : verb === 'archive'
        ? `这会带走 ${r.name}（历史保留）。`
        : `这是破坏性操作。`;
    return {
      ok: true,
      needsConfirm: true,
      spoken: `你要求我${verb.replace('_', ' ')} ${r.name}${note}。${consequence} 要继续，请说 "confirm" 或 "${spec.confirmWord}"。说 "cancel" 可取消。`
    };
  }

  // spawn / hire——昂贵；占位 $ 估算（rt-9 接入真实数字）。
  if (verb === 'spawn') {
    const provider = (str(a.provider) || 'claude').toLowerCase();
    const role = str(a.role) || str(a.job);
    const name = str(a.name) || (role ? role.replace(/\b\w/g, (c) => c.toUpperCase()) : provider) || 'Worker';
    const godCwd = reg.godId ? reg.agents[reg.godId]?.cwd : undefined;
    const cwd =
      str(a.cwd) || godCwd || Object.values(reg.agents).find((m) => m.cwd)?.cwd || '';
    if (!cwd) return { ok: false, spoken: '我需要一个工作目录来雇佣——当前未配置。' };
    const command = str(a.command) || PROVIDER_COMMAND[provider] || 'claude';
    const id = `${slug(name)}-${shortId()}`;
    const spec2: RealtimeSpawnSpec = { id, cwd, command, provider, hive: { id, name, provider, role: role || undefined, cwd } };
    pending = { verb, confirmWord: 'spawn', targetLabel: name, createdAt: Date.now(), commit: buildSpawn(deps, spec2, `${name} on ${provider}`) };
    return {
      ok: true,
      needsConfirm: true,
      // Spawn/hire 由口头回声确认门控。不报价——
      // 编排器人设不向用户展示金钱。
      spoken: `你想雇佣一个新的 ${provider} agent${role ? `，担任 ${role}` : ''}，名字叫 ${name}。要雇佣，请说 "confirm" 或 "spawn"。说 "cancel" 可取消。`
    };
  }

  // edit_schedule
  if (verb === 'edit_schedule') {
    const missions = deps.listMissions();
    if (!missions.length) return { ok: false, spoken: '当前没有可编辑的定时任务。' };
    const ref = norm(str(a.missionId) || str(a.schedule) || str(a.label) || str(a.target));
    const m =
      missions.find((x) => x.id.toLowerCase() === ref) ||
      missions.find((x) => (x.label || '').toLowerCase() === ref) ||
      missions.find((x) => (x.label || '').toLowerCase().includes(ref) || x.id.toLowerCase().includes(ref));
    if (!m) return { ok: false, spoken: ref ? `找不到匹配 "${str(a.label) || ref}" 的日程。` : '要编辑哪个日程？' };
    const raw = norm(str(a.action) || str(a.op));
    const action: 'enable' | 'disable' | 'delete' =
      raw.includes('delete') || raw.includes('remove') ? 'delete' : raw.includes('disable') || raw.includes('off') || raw.includes('pause') ? 'disable' : 'enable';
    pending = {
      verb,
      confirmWord: 'schedule',
      targetLabel: m.label,
      createdAt: Date.now(),
      commit: buildEditSchedule(deps, m, action)
    };
    return {
      ok: true,
      needsConfirm: true,
      spoken: `你想${action === 'delete' ? '删除' : action === 'enable' ? '启用' : '停用'}日程「${m.label}」。要继续，请说 "confirm" 或 "schedule"。说 "cancel" 可取消。`
    };
  }

  // v0.3.4：创建全新的日程（edit_schedule 只切换/删除）。
  if (verb === 'create_schedule') {
    const label = str(a.label) || str(a.name) || str(a.title);
    const body = str(a.prompt) || str(a.body) || str(a.message);
    if (!label || !body) return { ok: false, spoken: '我需要日程的名称以及要告诉 agent 的内容。' };
    const minutes = typeof a.intervalMinutes === 'number' && isFinite(a.intervalMinutes)
      ? Math.min(7 * 24 * 60, Math.max(5, Math.round(a.intervalMinutes)))
      : 60;
    const to = str(a.to) || str(a.agentId) || 'god';
    const target = resolveAgent(to, reg);
    const targetId = 'error' in target ? 'god' : target.id;
    const mission: ScheduledMission = {
      id: `voice-${slug(label)}-${shortId()}`,
      label,
      intervalMs: minutes * 60_000,
      to: targetId,
      body,
      enabled: true
    };
    pending = {
      verb, confirmWord: 'schedule', targetLabel: label, createdAt: Date.now(),
      commit: async () => {
        deps.saveMissions([...deps.listMissions(), mission]);
        attribute(deps, 'create_schedule', mission.id, { title: label.slice(0, 120) });
        return `已创建日程「${label}」——每 ${minutes} 分钟向 ${targetId} 发送。`;
      }
    };
    return {
      ok: true,
      needsConfirm: true,
      spoken: `你想要一个新日程「${label}」，每 ${minutes} 分钟向 ${targetId} 发送消息。要创建，请说 "confirm" 或 "schedule"。说 "cancel" 可取消。`
    };
  }

  // v0.3.4：设置，只经策略表。
  if (verb === 'update_setting') {
    const key = str(a.key) || str(a.setting) || str(a.name);
    const policy = SETTING_POLICY[key];
    if (!key) return { ok: false, spoken: '要更改哪个设置？' };
    if (!policy) {
      return { ok: false, spoken: `设置 "${key}" 不能通过语音更改——请到设置界面操作。` };
    }
    // 按 key 声明的类型强制转换 + 校验值。
    let value: unknown = a.value;
    if (policy.type === 'boolean') {
      if (typeof value === 'string') value = /^(true|on|yes|enable|enabled|1)$/i.test(value.trim());
      if (typeof value !== 'boolean') return { ok: false, spoken: `${key} 应该是开还是关？` };
    } else if (policy.type === 'number') {
      if (typeof value === 'string') value = parseFloat(value);
      if (typeof value !== 'number' || !isFinite(value)) return { ok: false, spoken: `${key} 应该设为多少？` };
      if (policy.min !== undefined && value < policy.min) return { ok: false, spoken: `${key} 不能低于 ${policy.min}。` };
      if (policy.max !== undefined && value > policy.max) return { ok: false, spoken: `${key} 不能超过 ${policy.max}。` };
      value = Math.round(value as number);
    } else {
      if (typeof value !== 'string' || !value.trim() || value.length > 200) {
        return { ok: false, spoken: `${key} 应该设置成什么？` };
      }
      value = value.trim();
      if (policy.values && !policy.values.includes(value as string)) {
        return { ok: false, spoken: `${key} 必须是以下之一：${policy.values.join(', ')}。` };
      }
    }
    const oldValue = deps.getConfigValue(key);
    const describe = (v: unknown): string => typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v ?? 'unset');
    if (describe(oldValue) === describe(value)) {
      return { ok: true, spoken: `${key} 已经是 ${describe(value)}——无需修改。` };
    }
    const applyNow = (): string => {
      deps.patchConfig({ [key]: value });
      attribute(deps, 'update_setting', key, { action: `${describe(oldValue)} → ${describe(value)}` });
      return `完成——${key} 现为 ${describe(value)}（原为 ${describe(oldValue)}）。`;
    };
    if (policy.tier === 'soft') {
      // 低爆炸半径的 key 立即生效，就像其他软动词一样。
      return { ok: true, spoken: applyNow() };
    }
    pending = { verb, confirmWord: 'setting', targetLabel: key, createdAt: Date.now(), commit: async () => applyNow() };
    return {
      ok: true,
      needsConfirm: true,
      spoken: `${key} 当前为 ${describe(oldValue)}；你想把它设为 ${describe(value)}。要修改，请说 "confirm" 或 "setting"。说 "cancel" 可取消。`
    };
  }

  return { ok: false, spoken: `我不知道如何执行 ${verb}。` };
}

/** 一个动词的顶层 propose/execute。软写入立即运行；破坏性的暂存一个
 *  pending 并要求口头确认。 */
function runAction(deps: RealtimeActionDeps, verb: string, a: Record<string, unknown>): ActionResult {
  if (!deps.hiveEnabled()) return { ok: false, spoken: 'hive 尚未配置，所以我无法执行该操作。' };
  const spec = VERBS[verb];
  if (!spec) return { ok: false, spoken: `没有名为 "${verb}" 的操作。` };
  // 任何新提议都取代过期的 pending。
  pending = null;
  if (spec.tier === 'soft') {
    switch (verb) {
      case 'ping': return execPing(deps, a);
      case 'dispatch': return execDispatch(deps, a);
      case 'steer': return execSteer(deps, a);
      case 'create_task': return execCreateTask(deps, a);
      case 'assign_task': return execAssignTask(deps, a);
      case 'update_task': return execUpdateTask(deps, a);
      case 'resume': return execResume(deps, a);
      case 'auto_delivery': return execAutoDelivery(deps, a);
      case 'gate_tool': return execGateTool(deps, a);
      case 'delete_task': return execDeleteTask(deps, a);
      case 'unarchive': return execUnarchive(deps, a);
      default: return { ok: false, spoken: `我不知道如何执行 ${verb}。` };
    }
  }
  return proposeDestructive(deps, verb, a);
}

// ─── IPC 注册 ───────────────────────────────────────────────────────

/** rt-5 线上 bug 插桩：把真实的错误 + 堆栈写到控制台和 hive 日志，
 *  让下一次语音复现能自诊断（模型只看到友好的 'spoken' 字符串，
 *  它掩盖了真正的失败）。尽力而为。 */
function logActionFailure(deps: RealtimeActionDeps, channel: string, verb: string, e: unknown): void {
  const err = e instanceof Error ? e : new Error(String(e));
  console.error(`[realtime-action] ${channel} verb=${verb} FAILED:`, err.stack || err.message);
  try {
    deps.hiveLog({
      kind: 'voice_action_error',
      actor: VOICE_ACTOR,
      channel,
      verb,
      error: err.message,
      stack: (err.stack || '').slice(0, 800)
    });
  } catch {
    /* 绝不让日志向 handler 抛异常 */
  }
}

/**
 * 接好语音动作 IPC。从 index.ts 调用一次，带上既有的主函数。
 * 通道：
 *   realtime:action          {verb, ...args}  → ActionResult（软动作立即运行；
 *                                                破坏性动作暂存一个 pending）
 *   realtime:action:confirm  {phrase}         → ActionResult（仅当独立 token
 *                                                匹配时提交那个 pending）
 *   realtime:action:cancel   {}               → ActionResult（丢弃 pending）
 */
export function registerRealtimeActionIpc(deps: RealtimeActionDeps): void {
  ipcMain.handle('realtime:action', async (_evt, payload: unknown) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    const verb = norm(str(p.verb)).replace(/\s+/g, '_');
    try {
      const res = runAction(deps, verb, p);
      // 非 ok 结果是预期的友好拒绝（目标错误、hive 关闭等）——
      // 安静地记一条日志，让线上复现仍可关联，但它不是错误。
      if (!res.ok) console.warn(`[realtime-action] verb=${verb} rejected: ${res.spoken}`);
      return res;
    } catch (e) {
      logActionFailure(deps, 'realtime:action', verb, e);
      const msg = e instanceof Error ? e.message : 'unknown error';
      return { ok: false, spoken: `该操作失败：${msg}。` } satisfies ActionResult;
    }
  });

  ipcMain.handle('realtime:action:confirm', async (_evt, payload: unknown) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    const cur = pendingFresh();
    if (!cur) return { ok: false, spoken: '当前没有待确认的操作。' } satisfies ActionResult;
    const phrase = str(p.phrase) || str(p.confirm) || str(p.text);
    if (!confirmAccepted(phrase, cur.confirmWord)) {
      return {
        ok: false,
        spoken: `我不会仅凭这句话就对 ${cur.targetLabel} 执行 ${cur.verb}——出于安全，我需要你说 "confirm" 或 "${cur.confirmWord}"，而不是简单的 yes。请清楚地说出来，或说 cancel 取消。`
      } satisfies ActionResult;
    }
    const commit = cur.commit;
    const verb = cur.verb;
    pending = null; // 运行前消费掉，让失败无法被二次确认
    try {
      const spoken = await commit();
      return { ok: true, spoken } satisfies ActionResult;
    } catch (e) {
      logActionFailure(deps, 'realtime:action:confirm', verb, e);
      const msg = e instanceof Error ? e.message : 'unknown error';
      return { ok: false, spoken: `该操作失败：${msg}。` } satisfies ActionResult;
    }
  });

  ipcMain.handle('realtime:action:cancel', async () => {
    const had = pendingFresh();
    pending = null;
    return { ok: true, spoken: had ? `已取消 ${had.verb}。` : '没有要取消的操作。' } satisfies ActionResult;
  });
}

/**
 * 触发器——God 编排器在无需人工输入的情况下被唤醒的各种方式。
 *
 * 本模块是 main、preload 和 renderer 共享的单一契约。四种触发类型同处一室：
 *
 *   schedules  — 周期性派发的任务（既有的 `ScheduledMission`；
 *                仍归 config.missions 所有，在 Triggers 下展示）
 *   context    — 代理终端上下文的自动压缩 / 自动清除
 *   webhook    — 来自任意调用方的入站 HTTP，每个端点一条记录
 *   org        — 来自队友克隆节点的入站对等消息（目前仅 UI）
 *
 * webhook 和 org 两种类型都接受外部一方，因此二者共享同一个
 * `TriggerMode` 门控，并都写入同一个 `TriggerHistoryEntry` 台账。
 *
 */

/* ────────────────────────────── 行为门控 ───────────────────────────── */

/**
 * 外部发送方被信任的程度。
 *
 *   strict              — 每条入站消息都等待操作员批准。
 *   allow-all           — 一切直接放行：消息、指令和沟通类内容一律通过。
 *   communication-only  — 信息性流量直接通过；任何要求 hive *行动*
 *                         （指令）的内容等待批准。
 *
 */
export type TriggerMode = 'strict' | 'allow-all' | 'communication-only';

export const TRIGGER_MODES: { value: TriggerMode; label: string; blurb: string }[] = [
  { value: 'strict', label: 'strict', blurb: 'Ask me before anything reaches the hive.' },
  { value: 'allow-all', label: 'allow all', blurb: 'Messages, directives and communication all flow.' },
  { value: 'communication-only', label: 'communication only', blurb: 'Chatter flows; directives need my approval.' }
];

export const DEFAULT_TRIGGER_MODE: TriggerMode = 'strict';

/**
 * 一条入站消息在要求什么。*directive*（指令）要求 hive 做工作；
 * *communication*（沟通）是信息性的（状态询问、通知、回复）。
 * 发送方可声明它；未声明时由 `classifyInboundKind` 猜测。
 */
export type InboundKind = 'directive' | 'communication';

/** 根据 mode + kind 判定消息是否可在无人工的情况下被路由。 */
export function isAutoAllowed(mode: TriggerMode, kind: InboundKind): boolean {
  if (mode === 'allow-all') return true;
  if (mode === 'communication-only') return kind === 'communication';
  return false; // strict 模式
}

/**
 * 当载荷未声明 `kind` 时，对意图尽最大努力猜测。
 *
 * 刻意保持保守：任何我们不确定是闲聊的内容都当作指令处理，
 * 因为把指令误标为沟通正是让未经批准的工作在 `communication-only`
 * 模式下溜过去的途径。在乎的调用方应发送显式的 `kind`。
 *
 */
export function classifyInboundKind(text: string): InboundKind {
  const t = text.trim().toLowerCase();
  if (!t) return 'communication';
  // 以疑问词开头且无祈使语气的句子，读作有人在询问而非派活。
  const asksOnly = /^(what|how|when|where|who|why|is|are|do|does|did|can|could|status|any)\b/.test(t)
    && t.endsWith('?')
    && !/\b(fix|build|ship|deploy|run|write|create|add|remove|delete|refactor|implement|update|merge|revert)\b/.test(t);
  return asksOnly ? 'communication' : 'directive';
}

/* ──────────────────────────── 上下文触发器 ────────────────────────────── */

/**
 * 上下文触发器的一半（compact 或 clear）。发送给代理的 *message*
 * 和触发它的 *conditions* 都是用户可编辑的——这正是把它作为触发器
 * 暴露出来而不是写死代码的全部意义。
 *
 * 当两个条件都成立时，某个代理会触发一次运行：
 *   - 距上次运行至少经过了 `everyMs`，且
 *   - 该代理的上下文已至少用到 `minContextPct`。
 * `minContextPct` 为 0 时禁用压力门控（仅靠时间触发）。
 */
export interface ContextRule {
  enabled: boolean;
  /** 两次运行之间的最小墙钟间隔。 */
  everyMs: number;
  /** 触发前必须已使用的上下文窗口百分比（0-100）。 */
  minContextPct: number;
  /**
   * 针对超大上下文窗口（约 1M token）单独设置的更低门槛，
   * 因为此时更小的*占比*仍是巨大的绝对文本量。
   */
  minContextPctLargeWindow: number;
  /**
   * 对 `compact`：附加到提供方压缩命令之后的额外焦点文本，
   * 适用于会读取尾部文本的提供方（codex 和 opencode 忽略它，
   * 因此对它们丢弃而不作为游离输入键入）。
   *
   * 对 `clear`：一条覆盖提供方自身 clear 动词的字面命令。
   * 该覆盖同时充当我们刻意映射为无操作——Crush（仅调色板）、
   * Copilot（打印模式）和自定义二进制——的提供方的逃生口，
   * 这些情况下操作员了解自己的 CLI 而我们不了解。
   *
   * 空字符串 = 发送提供方的裸命令。
   */
  message: string;
}

export interface ContextTriggerConfig {
  compact: ContextRule;
  clear: ContextRule;
}

/**
 * 始终随 `/compact` 一起发送的焦点文本。作为默认值原样保留，
 * 让升级用户在节奏之外看不到任何行为变化。
 */
export const DEFAULT_COMPACTION_FOCUS =
  'Keep the current task, recent decisions, open questions, and file paths in play. Drop resolved tangents.';

/**
 * 默认值刻意设为旧节奏的两倍、旧文档压力门槛的两倍。
 *
 * 历史：`main/config.ts` 曾文档化一个 30% / 20% 的上下文门控，但从未真正
 * 实现——每个在线代理都在每个 tick 被压缩，每小时一次。这里让门控变为真实
 * 并设为 2 倍，使压缩现在只给代理造成一半的打扰。
 *
 * 自动清除默认关闭。`/clear` 是破坏性的——它丢弃上下文而不是总结它，
 * 代码库也早已把手动命令关在需要口头确认词的门后。开启它是操作员的
 * 显式选择。
 *
 *
 */
export const DEFAULT_CONTEXT_TRIGGER: ContextTriggerConfig = {
  compact: {
    enabled: true,
    everyMs: 7_200_000, // 2h — 之前是 1h
    minContextPct: 60, // 之前是文档化但未强制执行的 30
    minContextPctLargeWindow: 40, // 之前是文档化但未强制执行的 20
    message: DEFAULT_COMPACTION_FOCUS
  },
  clear: {
    enabled: false,
    everyMs: 7_200_000,
    minContextPct: 90,
    minContextPctLargeWindow: 80,
    message: ''
  }
};

/* ──────────────────────────── Webhook 触发器 ───────────────────────────── */

/**
 * 一个入站端点。可同时存在多个；它们在单个 HTTP 服务器 + 隧道上多路复用，
 * 通过请求路径中的 `id` 区分，因此添加 webhook 不额外占用端口、不额外
 * 占用隧道。
 *
 * `secret` 按端点独立：吊销一个调用方绝不会影响其他调用方。
 */
export interface WebhookTrigger {
  id: string;
  name: string;
  /** 调用方在 `x-md-webhook-secret` 中回显的共享密钥。从不记录。 */
  secret: string;
  enabled: boolean;
  mode: TriggerMode;
  /** 用户可编辑的 JSON Schema（序列化形式），入站请求体将按其校验。 */
  schema: string;
  createdAt: number;
}

/**
 * 入站 POST 的默认契约。用户可按每个 webhook 编辑它以匹配调用系统
 * 已产出的内容；`message` 是路由真正需要的唯一字段。
 *
 */
export const DEFAULT_WEBHOOK_SCHEMA_OBJECT = {
  type: 'object',
  required: ['message'],
  properties: {
    message: { type: 'string', description: 'What you want the orchestrator to know or do.' },
    title: { type: 'string', description: 'Short label for the kanban card.' },
    kind: {
      type: 'string',
      enum: ['directive', 'communication'],
      description: 'directive = asks the hive to act; communication = informational.'
    },
    from: { type: 'string', description: 'Who is sending, for the trigger history.' }
  }
} as const;

export const DEFAULT_WEBHOOK_SCHEMA = JSON.stringify(DEFAULT_WEBHOOK_SCHEMA_OBJECT, null, 2);

/* ────────────────────────── 组织触发器 ─────────────────────────── */

/**
 * 队友各自安装之间的对等消息。每位队友运行自己的 Munder Difflin；
 * 设置组织密钥后，他们的实例即可寻址到你的实例。
 *
 * 目前仅 UI + 持久化——传输服务尚不存在，因此除了展示它的设置界面外，
 * 没有任何东西读取 `apiKey`。
 */
export interface OrgTriggerConfig {
  apiKey: string;
  enabled: boolean;
  mode: TriggerMode;
}

export const DEFAULT_ORG_TRIGGER: OrgTriggerConfig = {
  apiKey: '',
  enabled: false,
  mode: DEFAULT_TRIGGER_MODE
};

/** 组织密钥字段下方展示的文案。放在这里使设置页和触发器保持一致。 */
export const CLONE_NODE_BLURB =
  'Set an organisation key and your teammates can message your clone node — the copy of '
  + 'Munder Difflin running on your machine. Each teammate runs their own, so an org key '
  + 'is how two installs find each other.';

/* ──────────────────────────── 触发器历史 ────────────────────────────── */

/**
 * 台账中的一行。两个方向都被记录，操作员可以把对话当对话读：
 * 他们发来什么，我们又回了什么。`correlationId` 把我们的出站回复
 * 与促成它的入站消息绑定在一起。
 */
export interface TriggerHistoryEntry {
  id: string;
  source: 'webhook' | 'org';
  /** 哪个 webhook（或哪个对端）——webhook 时为 `WebhookTrigger.id`。 */
  sourceId: string;
  /** 事件发生时的显示名，使历史在重命名/删除后仍然可用。 */
  sourceName: string;
  direction: 'inbound' | 'outbound';
  /** 另一方：谁发给我们，或我们发给了谁。 */
  peer: string;
  title?: string;
  /** 完整消息正文——存盘时永不截断；显示多少由 UI 决定。 */
  body: string;
  kind: InboundKind;
  decision?: 'auto-allowed' | 'pending' | 'approved' | 'rejected';
  correlationId?: string;
  taskId?: string;
  at: number;
}

/** 台账上限。超过此数后最旧的条目会被丢弃，文件才不会无限增长。 */
export const TRIGGER_HISTORY_LIMIT = 500;

/* ───────────────────────── 最小化 Schema 校验 ─────────────────────── */

/**
 * 一个刻意保持精简的 JSON-Schema 子集校验器——`type`、`required`、
 * `properties`、`enum`。项目没有校验依赖，入站 webhook 请求体也不值得
 * 引入一个；任何它不理解的内容都被忽略而不是当作失败，
 * 因此一个奇怪的用户 schema 会退化为“接受”，而不会把调用方锁在
 * 他们自己的端点之外。
 */
export function validateAgainstSchema(
  value: unknown,
  schema: unknown
): { ok: true } | { ok: false; error: string } {
  if (!schema || typeof schema !== 'object') return { ok: true };
  const s = schema as Record<string, unknown>;

  const expected = typeof s.type === 'string' ? s.type : undefined;
  if (expected && !matchesType(value, expected)) {
    return { ok: false, error: `expected ${expected}` };
  }

  if (Array.isArray(s.enum) && !s.enum.some((e) => e === value)) {
    return { ok: false, error: `must be one of ${s.enum.map((e) => String(e)).join(', ')}` };
  }

  if (expected === 'object' || (!expected && isPlainObject(value))) {
    if (!isPlainObject(value)) return { ok: false, error: 'expected object' };
    for (const key of Array.isArray(s.required) ? s.required : []) {
      if (typeof key !== 'string') continue;
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined || v === null || v === '') return { ok: false, error: `${key} required` };
    }
    const props = isPlainObject(s.properties) ? s.properties : {};
    for (const [key, sub] of Object.entries(props)) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue; // 缺失的可选字段没问题；其余由 `required` 覆盖
      const r = validateAgainstSchema(v, sub);
      if (!r.ok) return { ok: false, error: `${key}: ${r.error}` };
    }
  }

  return { ok: true };
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return isPlainObject(value);
    case 'null': return value === null;
    default: return true; // 未知的类型关键字——别因此让调用方失败
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

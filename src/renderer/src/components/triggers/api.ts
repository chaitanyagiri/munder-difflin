import {
  DEFAULT_CONTEXT_TRIGGER,
  DEFAULT_TRIGGER_MODE,
  DEFAULT_WEBHOOK_SCHEMA,
  type ContextRule,
  type ContextTriggerConfig,
  type OrgTriggerConfig,
  type WebhookTrigger
} from '@shared/triggers';

/**
 * TRIGGER IPC —— 触发器配置界面的渲染器侧。
 *
 * 有意保持轻薄：`window.cth` 已经为每个调用提供了类型（preload 桥接了
 * `triggers:*`、`webhooks:*` 和 `org:*`），所以本模块只存在于三种原始 invoke
 * 做不到的事——在到达数字输入之前深度填充一份写了一半的 context 规则；把被
 * 拒绝的读取变成「保留你已有的」而不是「什么都不采纳」；以及以 Settings →
 * Connections 铸造新端点时相同的形态铸造一个。
 */

/** 形态来自 preload 的 `webhooks:status` 处理器，是推导而不是重打的
 *  （WorkersTab 的惯例），因此它不会与真实应答脱节。 */
export type WebhooksStatus = Awaited<ReturnType<typeof window.cth.webhooksStatus>>;

/* ───────────────────────────── context 触发器 ───────────────────────────── */

function fillRule(partial: Partial<ContextRule> | undefined, fallback: ContextRule): ContextRule {
  return {
    enabled: partial?.enabled ?? fallback.enabled,
    everyMs: typeof partial?.everyMs === 'number' ? partial.everyMs : fallback.everyMs,
    minContextPct: typeof partial?.minContextPct === 'number' ? partial.minContextPct : fallback.minContextPct,
    minContextPctLargeWindow: typeof partial?.minContextPctLargeWindow === 'number'
      ? partial.minContextPctLargeWindow
      : fallback.minContextPctLargeWindow,
    message: typeof partial?.message === 'string' ? partial.message : fallback.message
  };
}

/** 读取 context 触发器，深度填充。写了一半的子对象绝不能以 `undefined` 到达
 *  数字输入——React 会让它们变成不受控的。 */
export async function getContextTrigger(): Promise<ContextTriggerConfig> {
  try {
    const cfg: Partial<ContextTriggerConfig> | null = await window.cth.getContextTrigger();
    return {
      compact: fillRule(cfg?.compact, DEFAULT_CONTEXT_TRIGGER.compact),
      clear: fillRule(cfg?.clear, DEFAULT_CONTEXT_TRIGGER.clear)
    };
  } catch {
    return DEFAULT_CONTEXT_TRIGGER;
  }
}

/** 即发即忘——控件已经移动，这是 Command Center 中配置写入的惯例模式。 */
export function setContextTrigger(cfg: ContextTriggerConfig): void {
  void window.cth.setContextTrigger(cfg).catch(() => { /* 乐观更新 */ });
}

/* ─────────────────────────────── webhook 端点 ────────────────────────────── */

/** 失败时返回 `null`，绝不是 `[]`——否则调用方会采纳一个空列表，并因为一次
 *  掉线的 IPC 而抹掉一份好好的存储镜像。 */
export async function listWebhooks(): Promise<WebhookTrigger[] | null> {
  try {
    return (await window.cth.listWebhooks()) ?? null;
  } catch {
    return null;
  }
}

/**
 * 持久化并交回 main 的权威列表——它会净化渲染器发送的内容（修剪名字、拒绝
 * 非 URL 安全的 id、在无密钥端点上强制 `enabled: false`），所以保存后的真实
 * 结果可能与发送的内容不同。
 */
export async function saveWebhooks(list: WebhookTrigger[]): Promise<WebhookTrigger[] | null> {
  try {
    return (await window.cth.saveWebhooks(list)) ?? null;
  } catch {
    return null;
  }
}

export async function deleteWebhook(id: string): Promise<WebhookTrigger[] | null> {
  try {
    return (await window.cth.deleteWebhook(id)) ?? null;
  } catch {
    return null;
  }
}

export async function webhooksStatus(): Promise<WebhooksStatus> {
  try {
    return await window.cth.webhooksStatus();
  } catch {
    return { running: false, endpoints: [] };
  }
}

/** 256 位十六进制，即 main 铸造的形态。只在铸造调用失败时才会走到这里——
 *  本地铸造的密钥仍会通过 `saveWebhooks` 持久化，所以「添加 webhook」绝不会
 *  悄悄给出一个空白凭据。 */
function localSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function generateWebhookSecret(): Promise<string> {
  try {
    const secret = await window.cth.generateWebhookSecret();
    if (secret) return secret;
  } catch { /* 回退到本地铸造 */ }
  return localSecret();
}

/**
 * 一个新端点。两个刻意的选择，都与 Settings → Connections 对齐，这样无论在
 * 哪个界面创建的端点都是同一个东西：
 *
 *  - id 形态是 `wh-<base36 时间>-<随机>`。它会成为公开 URL 路径段，因此在整个
 *    端点生命周期内保持稳定（保存时绝不再编号），并且落在 main 的 URL 安全
 *    字符集内。
 *  - 创建时是 DISABLED（禁用）。操作者先复制 URL 和密钥，然后选择启用——一个
 *    创建瞬间就上线的端点，会在任何人被告知地址之前就门户大开。
 */
export function newWebhook(secret: string, index: number): WebhookTrigger {
  return {
    id: `wh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: index === 0 ? 'inbound' : `inbound ${index + 1}`,
    secret,
    enabled: false,
    mode: DEFAULT_TRIGGER_MODE,
    schema: DEFAULT_WEBHOOK_SCHEMA,
    createdAt: Date.now()
  };
}

/* ───────────────────────────── organisation 配置 ──────────────────────────────── */

/** 失败时返回 `null`；存储镜像保持不变。 */
export async function getOrgTrigger(): Promise<OrgTriggerConfig | null> {
  try {
    return (await window.cth.getOrgTrigger()) ?? null;
  } catch {
    return null;
  }
}

export function setOrgTrigger(cfg: OrgTriggerConfig): void {
  void window.cth.setOrgTrigger(cfg).catch(() => { /* 乐观更新 */ });
}

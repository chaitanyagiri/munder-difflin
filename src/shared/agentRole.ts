/**
 * 持久的 agent 角色 vs 实时状态。
 *
 * Hive `registry.json` 存储 `role`（job / hire 的一句话说明）。底层花名册
 * 把同一个字符串存储为 `description`。实时运行状态属于
 * `status` / `action`——绝不属于 role。暂停、空闲和 Cursor 的 "standby"
 * 说明文字是状态，不是 job。
 */

const TRANSIENT_ROLE_RE = /^(on\s+)?standby$|^(idle|awaiting|paused|resumed|working|thinking|archived|starting up|reconnecting…?|running the floor|a fresh harness)$/i;

export function isDurableRole(text: string | undefined | null): boolean {
  const value = (text ?? '').trim();
  if (!value) return false;
  return !TRANSIENT_ROLE_RE.test(value);
}

/**
 * 挑选出应在一次重生或花名册/registry 同步后存活的 job 字符串。
 * 真实的 hire 角色总是胜过状态样的说明文字。当两者都是持久的时，
 * `candidate` 胜出（操作员刚设置的值）。
 */
export function preferredAgentRole(
  candidate: string | undefined | null,
  fallback: string | undefined | null,
  isGod = false
): string {
  const incoming = (candidate ?? '').trim();
  const existing = (fallback ?? '').trim();
  if (isDurableRole(incoming)) return incoming;
  if (isDurableRole(existing)) return existing;
  if (incoming) return incoming;
  if (existing) return existing;
  return isGod ? 'orchestrator (god)' : 'agent';
}

/** 在 spawn/重启时发送的角色。省略临时的花名册说明文字，让 hive
 *  registry 能保留上一个真实的 hire 角色。 */
export function roleForHiveSpawn(agent: {
  description?: string;
  isGod?: boolean;
  isAssistant?: boolean;
}): string | undefined {
  if (agent.isGod) return preferredAgentRole(agent.description, 'orchestrator (god)', true);
  if (agent.isAssistant) {
    return preferredAgentRole(agent.description, "Michael's prep assistant");
  }
  const role = agent.description?.trim();
  return role && isDurableRole(role) ? role : undefined;
}

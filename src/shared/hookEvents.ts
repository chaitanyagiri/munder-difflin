/** 面向渲染器的 hook 事件，跨 Electron IPC 边界共享。 */
export interface HookEvent {
  agentId?: string;
  event: string;
  tool?: string;
  notificationType?: string;
  source?: string;
  message?: string;
  blocked?: boolean;
}

const OPTIONAL_STRING_FIELDS = ['tool', 'notificationType', 'source', 'message'] as const;

/** 在不可信载荷跨过 Electron IPC 边界之前先校验它。 */
export function validateHookEvent(value: unknown): value is HookEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.event !== 'string' || candidate.event.length === 0) return false;
  if (
    candidate.agentId !== undefined &&
    (typeof candidate.agentId !== 'string' || candidate.agentId.length === 0)
  ) return false;

  for (const field of OPTIONAL_STRING_FIELDS) {
    if (candidate[field] !== undefined && typeof candidate[field] !== 'string') return false;
  }

  return candidate.blocked === undefined || typeof candidate.blocked === 'boolean';
}

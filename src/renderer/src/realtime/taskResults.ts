export interface TaskResultNotice {
  key: string;
  taskId: string;
  title: string;
  result: string;
  missingResult: boolean;
}

/** Read only top-level, local task completions that belong to God. */
export function readTaskResultNotices(raw: unknown, godId: string): TaskResultNotice[] {
  if (!godId || !raw || typeof raw !== 'object' || !Array.isArray((raw as { tasks?: unknown }).tasks)) {
    return [];
  }

  return (raw as { tasks: unknown[] }).tasks.flatMap((value): TaskResultNotice[] => {
    if (!value || typeof value !== 'object') return [];
    const task = value as {
      id?: unknown;
      title?: unknown;
      status?: unknown;
      assignee?: unknown;
      result?: unknown;
      slack?: unknown;
      webhook?: unknown;
    };
    if (typeof task.id !== 'string' || !task.id
      || task.status !== 'done'
      || task.assignee !== godId
      || task.slack != null
      || task.webhook != null) return [];

    const result = typeof task.result === 'string' ? task.result.trim() : '';
    return [{
      key: `${task.id}:${result || '<missing>'}`,
      taskId: task.id,
      title: typeof task.title === 'string' && task.title.trim() ? task.title.trim() : '(untitled task)',
      result,
      missingResult: !result
    }];
  });
}

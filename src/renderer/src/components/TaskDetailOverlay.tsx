import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import { TaskDetail, parseTasks, type HiveTask } from './TasksKanban';

/**
 * 任务详情的全应用范围宿主：无论谁调用 store.openTaskDetail(id)——一张看板
 * 卡片、agent 条状卡上的便签、地板道具——都会在办公室地板上渲染出同一个大的
 * 覆盖层。它自己维护 5 秒账本轮询，让打开中的详情在 god 编辑卡片时保持新鲜。
 */

const POLL_MS = 5000;

export function TaskDetailOverlay() {
  const taskDetailId = useStore((s) => s.taskDetailId);
  const closeTaskDetail = useStore((s) => s.closeTaskDetail);
  const agents = useStore((s) => s.agents);
  const restorable = useStore((s) => s.restorableAgents);
  const [tasks, setTasks] = useState<HiveTask[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    // parseTasks 会 NORMALIZE（账本是人手写的文件；卡片可能缺少
    // dependsOn/priority 等）——一张没有 dependsOn 的原始卡片曾让详情崩溃。
    // 绝不要把未解析的账本条目喂给 TaskDetail。
    try { setTasks(parseTasks(await window.cth.hiveTasks())); } catch { /* 保留最后的好数据 */ }
  }, []);

  useEffect(() => {
    if (!taskDetailId) return;
    void refresh();
    timer.current = setInterval(() => { void refresh(); }, POLL_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [taskDetailId, refresh]);

  if (!taskDetailId) return null;
  const task = tasks.find((t) => t.id === taskDetailId);
  if (!task) return null;

  const nameFor = (id?: string): string | undefined =>
    id ? (agents.find((a) => a.id === id)?.name ?? restorable.find((a) => a.id === id)?.name ?? id) : undefined;

  // 移动卡片只写一个字段。在原始账本上操作（与 TasksKanban.dismissTask 相同的
  // 模式），绝不要用显示解析后的状态：parseTasks 会 NORMALIZE，所以重新序列化
  // 它会把手写的 `priority: "high"` 变成数字 3，并把 `dependsOn: []` 嫁接到
  // 一个拼写 `deps` 键的卡片上。那些是真实值，所以它们在 hive.writeTasks 的
  // 合并中存活并落盘——一次状态变更悄悄改写 god 的卡片。
  const move = async (status: HiveTask['status']) => {
    const next = tasks.map((t) => (t.id === task.id ? { ...t, status } : t));
    setTasks(next); // 乐观
    try {
      const result = await window.cth.hivePatchTask(task.id, { status });
      if (!result.ok) void refresh();
    } catch { void refresh(); }
  };

  const assign = () => {
    // 经命令中心的分发框走（它会给 god 发信——人类从不直接写进 worker 的
    // 收件箱）。
    const st = useStore.getState();
    const god = st.agents.find((a) => a.isGod);
    if (god) st.select(god.id);
    const desc = task.description?.trim() ? task.description.trim() : '(no description)';
    st.requestDispatchSeed(`Task: ${task.title}\nContext: ${desc}\n`);
    st.requestCommandCenterTab('floor');
    closeTaskDetail();
  };

  return (
    <TaskDetail
      task={task}
      all={tasks}
      assigneeName={nameFor(task.assignee)}
      onMove={(s) => void move(s)}
      onAssign={assign}
      onClose={closeTaskDetail}
    />
  );
}

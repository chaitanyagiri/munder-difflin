import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import { PixelBadge } from './PixelBadge';
import { useStore } from '@/store/store';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';
import { type HiveTask, type HumanQA, openQuestion, waitsOnHuman } from './TasksKanban';
import { compareByNewestAsk } from './askMeOrder';
import { isComposingKey } from '@shared/imeGuard';
import { useRtl } from '@/i18n/useDirection';

/**
 * ASK ME —— 通过任务系统提供的一等公民式人工反馈。
 *
 * 只有依赖人类输入 god 才能推进的任务都放在这里。一条记录未必是问题——
 * 它也可以是人类才能完成的待办事项（创建账号、审批购买、提供凭证、
 * 在真实设备上测试）。每张卡片都显示未解决的询问、一个回复的位置
 * （一个答案，或一句"完成，这是结果"的确认），以及下游那些
 * 卡在这条上的任务级联 —— 于是"为什么 X 还没做完？"读起来就是
 * "啊，因为我在这里还欠着些什么。"
 *
 * 发送答案会做两件事：
 *   1. 把它写进卡片在 hive/tasks.json 中的 humanQA 条目（该决定会
 *      永久记录在任务上），以及
 *   2. 给 god 发信，让它接收答案、解锁卡片、继续工作——
 *      不再需要单独的 HumanQuestion.md 旁路通道。
 */

const POLL_MS = 5000;

function parse(raw: unknown): HiveTask[] {
  const list = (raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks))
    ? (raw as { tasks: HiveTask[] }).tasks
    : [];
  return list.filter((t) => !!t && typeof t === 'object');
}

/** 所有传递性等待 `id` 的任务（依赖链），循环安全。 */
function dependentsTree(id: string, all: HiveTask[], seen = new Set<string>()): HiveTask[] {
  if (seen.has(id)) return [];
  seen.add(id);
  const direct = all.filter((t) => Array.isArray(t.dependsOn) && t.dependsOn.includes(id) && t.status !== 'done');
  return direct.flatMap((d) => [d, ...dependentsTree(d.id, all, seen)]);
}

export function AskMeTab() {
  const { t: translate } = useTranslation();
  const rtl = useRtl();
  const agents = useStore((s) => s.agents);
  const restorable = useStore((s) => s.restorableAgents);
  const [tasks, setTasks] = useState<HiveTask[]>([]);
  // 草稿存在 STORE 中（按任务 id 键控）——切换标签页会卸载本视图，
  // 打了一半的答案必须在往返过程中存活下来。
  const drafts = useStore((s) => s.answerDrafts);
  const setAnswerDraft = useStore((s) => s.setAnswerDraft);
  const openTaskDetail = useStore((s) => s.openTaskDetail);
  const [sending, setSending] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try { setTasks(parse(await window.cth.hiveTasks())); } catch { /* 保留上次有效数据 */ }
  }, []);

  useEffect(() => {
    refresh();
    timer.current = setInterval(refresh, POLL_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [refresh]);

  const nameFor = (id?: string): string | undefined =>
    id ? (agents.find((a) => a.id === id)?.name ?? restorable.find((a) => a.id === id)?.name ?? id) : undefined;

  // 最新的询问在最上面，最旧的在最下面。在此之前看板完全没有比较器，
  // 因此问题的位置取决于它的卡片在 tasks.json 中的位置，纯属偶然。
  // `filter` 返回的本来就是新数组，所以原地排序绝不会触碰 store 自身的顺序。
  // 每张卡片用来排名的询问来自 openQuestion() —— 与 waitsOnHuman 使用的
  // 是同一个谓词 —— 并且只有这层外层列表被排序；卡片的 humanQA 历史
  // 始终保持时间顺序（见 askMeOrder.ts）。
  const waiting = tasks
    .filter(waitsOnHuman)
    .sort((a, b) => compareByNewestAsk(openQuestion(a), openQuestion(b)));

  /**
   * 在原始账本上把 `patch` 应用到一张卡片的 OPEN humanQA 条目上。
   * 返回是否落地成功。
   *
   * 先重新读取 tasks.json，而不是写入本视图那份 5 秒前的快照，
   * 因为 `hive:writeTasks` 把传入的数组当作卡片 MEMBERSHIP（成员集合）：
   * 若把我们自己的快照写回去，就会删掉自上次轮询以来 god 新增的任何卡片。
   * 按文本重新定位未解决的问题还意味着答案绝不会落到 god 在
   * 我们脚下换掉的另一个问题上——那种情况下什么都不写，草稿被保留。
   */

  const sendAnswer = async (task: HiveTask) => {
    const text = (drafts[task.id] ?? '').trim();
    const open = openQuestion(task);
    if (!text || !open || sending) return;
    setSending(task.id);
    try {
      // 1) 把答案记录在卡片上。
      const next = tasks.map((t) => {
        if (t.id !== task.id) return t;
        const qa = (t.humanQA ?? []).map((e) =>
          e === open || (e.q === open.q && !e.a)
            ? { ...e, a: text, answeredAt: new Date().toISOString() }
            : e
        );
        return { ...t, humanQA: qa };
      });
      const updated = next.find((candidate) => candidate.id === task.id);
      const result = updated
        ? await window.cth.hivePatchTask(task.id, { humanQA: updated.humanQA })
        : { ok: false };
      if (!result.ok) throw new Error('答案保存前任务已发生变化');
      setTasks(next);
      // 2) 告知 god，让卡片被解锁并继续工作。
      await window.cth.hiveSend({
        to: 'god',
        act: 'inform',
        subject: `用户已作答，任务「${task.title}」`,
        body: [
          `用户已回答了任务 ${task.id}（"${task.title}"）上的开放问题：`,
          `问：${open.q}`,
          `答：${text}`,
          '该答案也已记录在卡片的 humanQA 中。请据此处理、解锁卡片，并继续工作。'
        ].join('\n')
      }, 'human');
      setAnswerDraft(task.id, '');
    } catch { /* 保留草稿以便用户重试 */ }
    setSending(null);
  };

  // 在不作答的情况下把未解决的询问从 ASK ME 看板上移除。我们把未解决的
  // humanQA 条目标记为 `dismissedAt`（不编造答案），这样 openQuestion()
  // 就不再返回它、卡片离开本视图——问题本身仍留在卡片上，
  // 所以问答历史永远不会丢失（协议）。任务在看板上保持 blocked；
  // god 可以追加一条新的 humanQA 条目来重新提问。
  const dismiss = async (task: HiveTask) => {
    const open = openQuestion(task);
    if (!open || sending === task.id) return;
    const next = tasks.map((t) => {
      if (t.id !== task.id) return t;
      const qa = (t.humanQA ?? []).map((e) =>
        e === open || (e.q === open.q && !e.a && !e.dismissedAt)
          ? { ...e, dismissedAt: new Date().toISOString() }
          : e
      );
      return { ...t, humanQA: qa };
    });
    setTasks(next); // 乐观更新 —— 卡片立即消失
    try {
      const updated = next.find((candidate) => candidate.id === task.id);
      const result = updated
        ? await window.cth.hivePatchTask(task.id, { humanQA: updated.humanQA })
        : { ok: false };
      if (!result.ok) throw new Error('在问询被关闭前任务已发生变化');
    } catch {
      setTasks(tasks); // 失败时还原，让用户可以重试
    }
  };

  return (
    // 正文文本使用等宽字体（VT323）——与内存查看器相同的可读字体。
    // Pixelify Sans（font-ui）对问答这类散文来说太厚重。
    // 显示/徽章部分保留各自明确指定的字体。
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: 'var(--cth-paper-200)', padding: 10, display: 'flex', flexDirection: 'column', gap: 10, fontFamily: 'var(--cth-font-mono)' }}>
      {waiting.length === 0 && (
        <div style={{ textAlign: 'center', padding: '24px 12px', color: 'var(--cth-ink-500)', fontSize: 12 }}>
          {translate('askMe.emptyTitle')}<br />
          <span style={{ fontSize: 11, color: 'var(--cth-ink-300)' }}>
            {translate('askMe.emptySub')}
          </span>
        </div>
      )}
      {waiting.map((t) => {
        const open = openQuestion(t)!;
        const stuck = dependentsTree(t.id, tasks);
        return (
          <div key={t.id} style={{
            background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
            display: 'flex', flexDirection: 'column'
          }}>
            {/* 头部：标题 + 负责人 */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px',
              background: 'var(--cth-lilac-light, #ece2f5)', boxShadow: 'inset 0 -1px 0 var(--cth-ink-700)'
            }}>
              <button
                onClick={() => openTaskDetail(t.id)}
                title={translate('askMe.openDetail')}
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, textAlign: 'left',
                  fontFamily: 'var(--cth-font-mono)', fontSize: 15, color: 'var(--cth-ink-900)',
                  flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                }}
              >
                {t.title}
              </button>
              {nameFor(t.assignee) && <PixelBadge status="blocked" label={nameFor(t.assignee)!} />}
              {/* Dismiss —— 把此询问从看板移除但不作答。
                  卡片的问答历史会被保留（问题仍留在卡片上，只是标记为已驳回）。 */}
              <button
                onClick={() => void dismiss(t)}
                disabled={sending === t.id}
                title={translate('askMe.dismissTitle')}
                aria-label={translate('askMe.dismissAria')}
                style={{
                  flexShrink: 0, width: 18, height: 18, padding: 0, marginLeft: 2,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
                  border: 'none', cursor: sending === t.id ? 'default' : 'pointer',
                  background: 'transparent', color: 'var(--cth-ink-500)',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 13
                }}
                onMouseEnter={(e) => { if (sending !== t.id) e.currentTarget.style.color = 'var(--cth-coral)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--cth-ink-500)'; }}
              >✕</button>
            </div>

            <div style={{ padding: 9, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* 问题，以 markdown 渲染。god 写问题时带强调、列表、`code`
                  和链接；若按纯文本显示，星号和反引号就会原样出现在屏幕上。
                  card 变体保留本卡片的等宽字体，并把单个换行转成换行符，
                  因此不含 markdown 的问题看起来和之前完全一样。 */}
              <div dir={rtl ? 'auto' : undefined} style={{ fontSize: 15, lineHeight: '19px', color: 'var(--cth-ink-900)' }}>
                <MarkdownPreview source={open.q} variant="card" />
              </div>

              {/* 回答框 */}
              <textarea
                dir={rtl ? 'auto' : undefined}
                value={drafts[t.id] ?? ''}
                onChange={(e) => setAnswerDraft(t.id, e.target.value)}
                onKeyDown={(e) => { if (isComposingKey(e)) return; if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void sendAnswer(t); }}
                rows={3}
                placeholder={translate('askMe.answerPlaceholder')}
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '6px 8px', resize: 'vertical',
                  background: 'var(--cth-paper-100)', border: 'none',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                  fontFamily: 'var(--cth-font-mono)', fontSize: 15, lineHeight: '18px',
                  color: 'var(--cth-ink-900)', outline: 'none'
                }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <PixelButton
                  variant="primary" size="sm"
                  disabled={!(drafts[t.id] ?? '').trim() || sending === t.id}
                  onClick={() => void sendAnswer(t)}
                >
                  {sending === t.id ? translate('askMe.sending') : translate('askMe.respond')}
                </PixelButton>
                {(t.humanQA?.filter((e) => e.a).length ?? 0) > 0 && (
                  <button
                    onClick={() => openTaskDetail(t.id)}
                    title={translate('askMe.viewAnswersHistory')}
                    style={{
                      border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
                      fontSize: 10, color: 'var(--cth-ink-700)', fontFamily: 'var(--cth-font-display)',
                      textDecoration: 'underline'
                    }}
                  >
                    {(() => {
                      const n = t.humanQA!.filter((e) => e.a).length;
                      return n === 1
                        ? translate('askMe.viewAnswers', { count: n })
                        : translate('askMe.viewAnswersPlural', { count: n });
                    })()}
                  </button>
                )}
              </div>

              {/* 级联：卡在这个答案后面的内容 */}
              {stuck.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-coral)' }}>
                    {stuck.length === 1
                      ? translate('askMe.blockingDownstream', { count: stuck.length })
                      : translate('askMe.blockingDownstreamPlural', { count: stuck.length })}
                  </div>
                  {stuck.slice(0, 6).map((d, i) => (
                    <div key={d.id} style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      paddingLeft: 8 + Math.min(i, 3) * 8,
                      fontSize: 12, color: 'var(--cth-ink-700)'
                    }}>
                      <span style={{ color: 'var(--cth-ink-300)' }}>└</span>
                      <span style={{ width: 7, height: 7, flexShrink: 0, background: d.status === 'blocked' ? 'var(--cth-coral)' : 'var(--cth-sky)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
                      {nameFor(d.assignee) && <span style={{ fontSize: 10, color: 'var(--cth-ink-500)' }}>({nameFor(d.assignee)})</span>}
                    </div>
                  ))}
                  {stuck.length > 6 && (
                    <div style={{ paddingLeft: 14, fontSize: 11, color: 'var(--cth-ink-300)' }}>{translate('askMe.more', { count: stuck.length - 6 })}</div>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

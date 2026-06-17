import { useCallback, useEffect, useRef, useState } from 'react';
import { PixelButton } from './PixelButton';
import { PixelBadge } from './PixelBadge';
import { useStore } from '@/store/store';
import { type HiveTask, openQuestion, waitsOnHuman } from './TasksKanban';

/**
 * ASK ME — first-class human feedback through the task system.
 *
 * Tasks the god can only move with the human's input sit here. An entry isn't
 * necessarily a question — it can be a TO-DO only the human can perform
 * (create an account, approve a purchase, provide credentials, test on a real
 * device). Each card shows the open ask, a place to respond (an answer, or a
 * "done, here's the result" confirmation), and the CASCADE of downstream
 * tasks stuck waiting on this one — so "why isn't X done?" reads as "ah,
 * because I still owe something here."
 *
 * Sending an answer does two things atomically-ish:
 *   1. writes it into the card's humanQA entry in hive/tasks.json (the
 *      decision is documented ON the task, forever), and
 *   2. mails the god so it picks the answer up, unblocks the card, and the
 *      work continues — no separate HumanQuestion.md side-channel anymore.
 */

const POLL_MS = 5000;

function parse(raw: unknown): HiveTask[] {
  const list = (raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks))
    ? (raw as { tasks: HiveTask[] }).tasks
    : [];
  return list.filter((t) => !!t && typeof t === 'object');
}

/** All tasks transitively waiting on `id` (dependents chain), cycle-safe. */
function dependentsTree(id: string, all: HiveTask[], seen = new Set<string>()): HiveTask[] {
  if (seen.has(id)) return [];
  seen.add(id);
  const direct = all.filter((t) => Array.isArray(t.dependsOn) && t.dependsOn.includes(id) && t.status !== 'done');
  return direct.flatMap((d) => [d, ...dependentsTree(d.id, all, seen)]);
}

export function AskMeTab() {
  const agents = useStore((s) => s.agents);
  const restorable = useStore((s) => s.restorableAgents);
  const [tasks, setTasks] = useState<HiveTask[]>([]);
  // Drafts live in the STORE (keyed by task id) — switching tabs unmounts this
  // view, and a half-typed answer must survive the round trip.
  const drafts = useStore((s) => s.answerDrafts);
  const setAnswerDraft = useStore((s) => s.setAnswerDraft);
  const openTaskDetail = useStore((s) => s.openTaskDetail);
  const [sending, setSending] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try { setTasks(parse(await window.cth.hiveTasks())); } catch { /* keep last good */ }
  }, []);

  useEffect(() => {
    refresh();
    timer.current = setInterval(refresh, POLL_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [refresh]);

  const nameFor = (id?: string): string | undefined =>
    id ? (agents.find((a) => a.id === id)?.name ?? restorable.find((a) => a.id === id)?.name ?? id) : undefined;

  const waiting = tasks.filter(waitsOnHuman);

  const sendAnswer = async (task: HiveTask) => {
    const text = (drafts[task.id] ?? '').trim();
    const open = openQuestion(task);
    if (!text || !open || sending) return;
    setSending(task.id);
    try {
      // 1) Document the answer ON the card.
      const next = tasks.map((t) => {
        if (t.id !== task.id) return t;
        const qa = (t.humanQA ?? []).map((e) =>
          e === open || (e.q === open.q && !e.a)
            ? { ...e, a: text, answeredAt: new Date().toISOString() }
            : e
        );
        return { ...t, humanQA: qa };
      });
      await window.cth.hiveWriteTasks(next);
      setTasks(next);
      // 2) Tell the god, so the card gets unblocked and work continues.
      await window.cth.hiveSend({
        to: 'god',
        act: 'inform',
        subject: `HUMAN ANSWER on task "${task.title}"`,
        body: [
          `The human answered the open question on task ${task.id} ("${task.title}"):`,
          `Q: ${open.q}`,
          `A: ${text}`,
          'The answer is also recorded in the card\'s humanQA. Act on it, unblock the card, and continue the work.'
        ].join('\n')
      }, 'human');
      setAnswerDraft(task.id, '');
    } catch { /* leave the draft so the user can retry */ }
    setSending(null);
  };

  // Dismiss the open ask off the ASK ME board WITHOUT answering it. We mark the
  // open humanQA entry `dismissedAt` (no fabricated answer) so openQuestion()
  // stops returning it and the card leaves this view — the question itself stays
  // on the card, so the Q&A history is never dropped (protocol). The task stays
  // blocked on the kanban; the god can re-ask by appending a fresh humanQA entry.
  // Reuses hiveWriteTasks (same path as the answer flow) — no new IPC.
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
    setTasks(next); // optimistic — the card disappears immediately
    try {
      await window.cth.hiveWriteTasks(next);
    } catch {
      setTasks(tasks); // restore on failure so the user can retry
    }
  };

  return (
    // Body text is set in the mono face (VT323) — the same readable font the
    // memory viewer uses. Pixelify Sans (font-ui) is too chunky for prose like
    // questions and answers. Display/badge bits keep their explicit faces.
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: 'var(--cth-paper-200)', padding: 10, display: 'flex', flexDirection: 'column', gap: 10, fontFamily: 'var(--cth-font-mono)' }}>
      {waiting.length === 0 && (
        <div style={{ textAlign: 'center', padding: '24px 12px', color: 'var(--cth-ink-500)', fontSize: 13 }}>
          Nothing needs you right now. 🌿<br />
          <span style={{ fontSize: 11, color: 'var(--cth-ink-300)' }}>
            When the team blocks a task on your input — a question to answer or a to-do only
            you can perform — it shows up here (and on the ASK ME board on the floor).
          </span>
        </div>
      )}
      {waiting.map((t) => {
        const open = openQuestion(t)!;
        const stuck = dependentsTree(t.id, tasks);
        return (
          <div key={t.id} style={{
            background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
            display: 'flex', flexDirection: 'column'
          }}>
            {/* header: title + assignee */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px',
              background: 'var(--cth-lilac-light, #ece2f5)', boxShadow: 'inset 0 -1px 0 var(--cth-ink-700)'
            }}>
              <button
                onClick={() => openTaskDetail(t.id)}
                title="open the full task detail"
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, textAlign: 'left',
                  fontFamily: 'var(--cth-font-mono)', fontSize: 15, color: 'var(--cth-ink-900)',
                  flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                }}
              >
                {t.title}
              </button>
              {nameFor(t.assignee) && <PixelBadge status="blocked" label={nameFor(t.assignee)!} />}
              {/* Dismiss — clears this ask off the board without answering it.
                  The card's Q&A history is preserved (the question stays on the
                  card, just marked dismissed). */}
              <button
                onClick={() => void dismiss(t)}
                disabled={sending === t.id}
                title="dismiss — clear this off the ASK ME board without answering (history kept)"
                aria-label="dismiss this ask"
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
              {/* the question */}
              <div style={{ fontSize: 15, lineHeight: '19px', color: 'var(--cth-ink-900)', whiteSpace: 'pre-wrap' }}>
                {open.q}
              </div>

              {/* answer box */}
              <textarea
                value={drafts[t.id] ?? ''}
                onChange={(e) => setAnswerDraft(t.id, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void sendAnswer(t); }}
                rows={3}
                placeholder="Your answer — or 'done', with the result… (Ctrl+Enter to send)"
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '6px 8px', resize: 'vertical',
                  background: 'var(--cth-paper-100)', border: 'none',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
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
                  {sending === t.id ? 'sending…' : 'respond & unblock'}
                </PixelButton>
                {(t.humanQA?.filter((e) => e.a).length ?? 0) > 0 && (
                  <button
                    onClick={() => openTaskDetail(t.id)}
                    title="open the task detail with the full Q&A history"
                    style={{
                      border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
                      fontSize: 10, color: 'var(--cth-ink-700)', fontFamily: 'var(--cth-font-display)',
                      textDecoration: 'underline'
                    }}
                  >
                    VIEW {t.humanQA!.filter((e) => e.a).length} EARLIER ANSWER{t.humanQA!.filter((e) => e.a).length === 1 ? '' : 'S'}
                  </button>
                )}
              </div>

              {/* the cascade: what's stuck behind this answer */}
              {stuck.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-coral)' }}>
                    BLOCKING {stuck.length} DOWNSTREAM TASK{stuck.length === 1 ? '' : 'S'}
                  </div>
                  {stuck.slice(0, 6).map((d, i) => (
                    <div key={d.id} style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      paddingLeft: 8 + Math.min(i, 3) * 8,
                      fontSize: 12, color: 'var(--cth-ink-700)'
                    }}>
                      <span style={{ color: 'var(--cth-ink-300)' }}>└</span>
                      <span style={{ width: 7, height: 7, flexShrink: 0, background: d.status === 'blocked' ? 'var(--cth-coral)' : 'var(--cth-sky)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)' }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
                      {nameFor(d.assignee) && <span style={{ fontSize: 10, color: 'var(--cth-ink-500)' }}>({nameFor(d.assignee)})</span>}
                    </div>
                  ))}
                  {stuck.length > 6 && (
                    <div style={{ paddingLeft: 14, fontSize: 11, color: 'var(--cth-ink-300)' }}>… +{stuck.length - 6} more</div>
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

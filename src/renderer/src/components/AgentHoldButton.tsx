import { useEffect, useState } from 'react';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useStore } from '@/store/store';

/**
 * 1:1 —— "我要单独占用这个 agent，Michael 别再派活给它了。"
 *
 * 位于 `AgentControlStrip` 中，紧挨"屏蔽工具"和"本步之后停止"，
 * 因此在侧边栏和焦点模式中都可见。它曾短暂出现在标题栏，
 * 而标题栏会被焦点模式遮住，使它在 1:1 时最可能用到的那个模式里不可见。
 *
 * 它与旁边的两个控件是不同"种类"，由于分组不再能表达这一点，
 * 就由 tooltip 承担：那两者约束的是 AGENT（拿走它的工具，或在本步之后
 * 停止它），而这个控件约束的是 MICHAEL。agent 继续运行、继续回答你。
 * 事实上，在 1:1 中"本步之后停止"是最不该用的，因为它会停掉
 * 你想对话的那个 agent。
 *
 * 绝不为 Michael 本人渲染：告诉编排器停止把活派给它自己，
 * 并不是一个值得存在的状态。
 */
export function AgentHoldButton({ agentId }: { agentId: string }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
  const godName = useStore((s) => s.agents.find((a) => a.isGod)?.name) ?? 'the orchestrator';
  const [busy, setBusy] = useState(false);
  /** 最近一次失败，显示在按钮本身上。一个默默无作为的控件
   *  比一个会说明原因的控件更糟。 */
  const [err, setErr] = useState<string | null>(null);

  // 注册表才是记录，并且能跨重启存活，因此 store 的副本在全新启动时
  // 可能已经过期。每个 agent 只回读一次。
  useEffect(() => {
    let alive = true;
    window.cth.hiveRegistry?.().then((reg) => {
      if (!alive) return;
      const onHold = !!(reg as { agents?: Record<string, { onHold?: boolean }> })?.agents?.[agentId]?.onHold;
      if (onHold !== !!useStore.getState().agents.find((a) => a.id === agentId)?.onHold) {
        useStore.getState().updateAgent(agentId, { onHold });
      }
    }).catch(() => { /* 无 hive —— 按钮在两种情况下都无害 */ });
    return () => { alive = false; };
  }, [agentId]);

  if (!agent || agent.isGod) return null;
  const on = !!agent.onHold;

  return (
    <PixelButton
      variant={on ? 'primary' : 'secondary'}
      size="sm"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        // 用 Promise.resolve().then(...) 而不是直接调用 bridge：
        // 在 PRELOAD 早于该功能的开发构建中，该方法未定义，
        // 由此产生的 TypeError 会从 onClick 中同步抛出，
        // 于是 `finally` 永远不执行，按钮会一直处于禁用状态，
        // 直到 React 重新挂载它。这正是当初报告的故障。
        // Preload 不会热重载；只有重启才能让它生效。
        void Promise.resolve()
          .then(() => window.cth.hiveSetAgentHold?.(agentId, !on)
            ?? Promise.reject(new Error('重启应用：此构建的 preload 早于 1:1 控制功能')))
          // 仅在主进程确认写入后再在本地镜像。乐观翻转会显示一个
          // Michael 从未听说过的 hold。
          .then((r) => {
            if (r?.ok) { setErr(null); useStore.getState().updateAgent(agentId, { onHold: !on }); }
            else setErr(r?.error ?? '无法设置 hold');
          })
          .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
          .finally(() => setBusy(false));
      }}
    >
      <span
        className="cth-tip cth-tip-wrap"
        data-tip={err ? err : on
          ? `结束 1:1。${godName} 可以重新把工作交给 ${agent.name}。`
          : `把 ${agent.name} 拉到一边。在你结束之前，${godName} 不会再给它派活。与这里的两个按钮不同，这并不会限制 agent：它照常运行、照常回答你。`}
        aria-label={on ? `结束 1:1，将 agent 交还给 ${godName}` : '把 agent 拉到一边进行 1:1'}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
      >
        <Icon name={on ? 'pause' : 'play'} /> {err ? '1:1 失败' : on ? '1:1 进行中' : '1:1'}
      </span>
    </PixelButton>
  );
}

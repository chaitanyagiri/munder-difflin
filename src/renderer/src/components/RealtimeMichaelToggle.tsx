/**
 * Realtime Michael —— 语音开关 + 实时状态指示（卡片 rt-3，Phase 1）。
 *
 * 面向 god/编排 agent（"Michael"）的可复用麦克风按钮。它消费已经
 * 构建好的 `useRealtimeMichael()` 语音循环 hook（一个共享的模块级单例——
 * 见 realtime/session.ts），并暴露一个启动/停止控件加上循环状态的实时指示。
 *
 * 门控复刻既有的 Free Flow / Groq 先例（MessageQueueComposer 里的 FreeFlowButton）：
 * 当没有 BYOK OpenAI key 时按钮保持 VISIBLE 但 DISABLED
 * （`hasOpenAiKey === false`），带指向 Settings 的 tooltip——所以没有 key 时
 * connect() / getUserMedia 永不被触达（不可用时零调用的保证）。
 *
 * 点击行为：status==='off' → connect()；其他任何状态 → disconnect()。
 *
 * 在两个地方渲染（god 卡片的 AgentCard、Michael 全屏时的 FullscreenTerminal
 * 头部）。它刻意只依赖 state / hook，所以两者都能挂载它。
 */
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useStore } from '@/store/store';
import { useRealtimeMichael, type RealtimeStatus } from '@/realtime/session';

/** 各状态的外观：按钮变体、SHORT 标签、圆点颜色，以及（可选的）
 *  实时状态指示圆点的动画。把 hook.status 映射到视觉。
 *  标签是 i18n key（`realtimeToggle.*`）；长帮助/标题文本因为要插值错误
 *  信息，所以每次渲染经 t() 解析。 */
const STATE_VIEW: Record<
  RealtimeStatus,
  {
    variant: 'primary' | 'secondary' | 'destructive';
    labelKey: string;
    dot: string;
    anim?: string;
    helpKey: string;
    /** 活跃时的按钮填充——一个不同的强调色，让活动的麦克风绝不被读作
     *  扁平的黑色 'primary' 按钮。（working 用破坏性的珊瑚变体，
     *  已经非黑，所以无需覆盖。） */
    activeBg?: string;
  }
> = {
  off: {
    variant: 'secondary',
    labelKey: 'realtimeToggle.talk',
    dot: 'var(--cth-ink-300)',
    helpKey: 'realtimeToggle.helpOff'
  },
  connecting: {
    variant: 'secondary',
    labelKey: 'realtimeToggle.connecting',
    dot: 'var(--cth-lemon)',
    anim: 'cth-blink 700ms steps(2, end) infinite',
    helpKey: 'realtimeToggle.helpConnecting'
  },
  listening: {
    variant: 'primary',
    labelKey: 'realtimeToggle.listening',
    dot: 'var(--cth-mint)',
    anim: 'cth-pulse 1000ms steps(2, end) infinite',
    helpKey: 'realtimeToggle.helpListening',
    activeBg: 'var(--cth-mint)'
  },
  responding: {
    variant: 'primary',
    labelKey: 'realtimeToggle.speaking',
    dot: 'var(--cth-sky)',
    anim: 'cth-pulse 600ms steps(2, end) infinite',
    helpKey: 'realtimeToggle.helpSpeaking',
    activeBg: 'var(--cth-sky)'
  },
  working: {
    variant: 'destructive',
    labelKey: 'realtimeToggle.working',
    dot: 'var(--cth-coral)',
    anim: 'cth-blink 500ms steps(2, end) infinite',
    helpKey: 'realtimeToggle.helpWorking'
  }
};

export interface RealtimeMichaelToggleProps {
  /** 全屏头部 / 紧凑行的紧凑形态——隐藏文本标签。 */
  compact?: boolean;
}

export function RealtimeMichaelToggle({ compact = false }: RealtimeMichaelToggleProps) {
  const { t } = useTranslation();
  const hasOpenAiKey = useStore((s) => s.hasOpenAiKey);
  const { status, error, connect, disconnect } = useRealtimeMichael();
  // 实测的视口坐标，不是 CSS 偏移。agent dock 会裁剪它的子元素，所以
  // 定位在卡片内部的 popover 无论怎么锚定都会被卡片的边缘切掉——这正是
  // 之前发生的情况。portalling 到 <body> 用固定坐标，就彻底离开了那个裁剪上下文。
  const [hint, setHint] = useState<{ left: number; top: number } | null>(null);
  const hintRef = useRef<HTMLSpanElement | null>(null);
  const iconRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const hintOpen = hint !== null;

  const view = STATE_VIEW[status];
  const noKey = !hasOpenAiKey;

  // 没有 BYOK OpenAI key：保持可见但禁用（与 FreeFlowButton 一致）。
  // Talk 用 OpenAI key（apikey:openai）铸造一个临时 token——就是 Agents & Models
  // 下设置的那个 SAME OpenAI provider key，用于 Realtime voice API。
  // tooltip 承载完整的 WHY；下面安静的 info 提示提供一个可发现的线索，
  // 让用户绝不会遇到一个悄悄死掉的按钮。
  const title = noKey
    ? t('realtimeToggle.noKeyTitle')
    : error
      ? `${t(view.helpKey)} — ${error}`
      : t(view.helpKey);

  const onClick = () => {
    if (noKey) return;
    if (status === 'off') void connect();
    else disconnect();
  };

  // 直接跳到持有该 key 的标签页。App 拥有 Settings modal 的打开状态，
  // 所以这里走 `cth:` 窗口事件约定，而不是把回调一路穿过
  // AgentCard/FullscreenTerminal 传下来。
  // 目标是 VOICE，不是 Agents & Models：key 两处都能设置，
  // 但只有其中一处解释它是干什么用的。
  const openKeySettings = (e: MouseEvent): void => {
    e.stopPropagation();
    setHint(null);
    window.dispatchEvent(
      new CustomEvent('cth:open-settings', { detail: { section: 'Voice' } })
    );
  };

  const HINT_W = 210;
  const HINT_GAP = 8;

  /** 把 popover 放在 VIEWPORT 空间里贴着图标，优先在上方，只有确实
   *  没有空间时才翻到下方——agent dock 位于底边，所以"上方"几乎总是
   *  对的。两个轴都夹在视口内，绝不会伸出边缘。 */
  const toggleHint = (e: MouseEvent): void => {
    e.stopPropagation();
    if (hint) { setHint(null); return; }
    const r = iconRef.current?.getBoundingClientRect();
    if (!r) return;
    // 高度取决于内容；这是两行 + 链接的情况，如果它折成三行，
    // 下面的 clamp 会吸收这个误差。
    const estH = 78;
    const above = r.top - HINT_GAP - estH;
    const top = above >= 8 ? above : Math.min(r.bottom + HINT_GAP, window.innerHeight - estH - 8);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - HINT_W - 8));
    setHint({ left, top: Math.max(8, top) });
  };

  // 点击打开的说明。悬停 title 对鼠标够用，但它位于一个禁用控件上——
  // 正是人们没反应时会去点的东西——所以答案应该藏在这次点击后面。
  useEffect(() => {
    if (!hintOpen) return;
    const onDown = (ev: globalThis.MouseEvent): void => {
      const t = ev.target as Node;
      // popover 被 portalled 到这个子树之外，所以"内部点击"必须同时
      // 对锚点和浮动面板两者做测试。
      if (hintRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setHint(null);
    };
    const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') setHint(null); };
    // dock 滚动或窗口缩放会让固定坐标失效，
    // 一个漂离图标的 popover 比关掉的更糟。
    const onReflow = (): void => setHint(null);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onReflow);
      window.removeEventListener('scroll', onReflow, true);
    };
  }, [hintOpen]);

  // 包在一个（非禁用）span 里，让原生的 title tooltip 在内层按钮被禁用时
  // 仍能在悬停时显示——Chromium 会抑制禁用按钮上的 tooltip。
  return (
    <span
      title={title}
      className="cth-titlebar-nodrag"
      // minWidth:0 才是真正阻止溢出的东西：没有它，这个 inline-flex
      // 会保持它的 max-content 宽度，无论内部标签做什么都顶出卡片边缘。
      style={{ display: 'inline-flex', alignItems: 'center', gap: noKey ? 4 : 0, minWidth: 0 }}
      // 阻止点击冒泡到父卡片的 onClick（选择 agent）。
      onClick={(e) => e.stopPropagation()}
    >
      <PixelButton
        variant={view.variant}
        size="sm"
        onClick={onClick}
        disabled={noKey}
        // 活动麦克风 → 清晰的强调色填充（mint 聆听 / sky 说话），让
        // 活跃按钮绝不被读作扁平的黑色 primary。禁用（无 key）和
        // off/connecting 状态跳过，所以那些状态不被触碰。
        style={!noKey && view.activeBg ? { background: view.activeBg, color: 'var(--cth-ink-900)' } : undefined}
      >
        <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
          {/* 实时状态指示圆点——颜色与动画反映循环的状态。 */}
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              flexShrink: 0,
              background: noKey ? 'var(--cth-ink-300)' : view.dot,
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              animation: noKey ? 'none' : view.anim
            }}
          />
          <Icon name="mic" />
          {!compact && (
            <span style={{ fontFamily: 'var(--cth-font-ui)' }}>
              {noKey ? t('realtimeToggle.talk') : t(view.labelKey)}
            </span>
          )}
        </span>
      </PixelButton>
      {/* 缺 key 是 SETUP STATE（配置态），不是失败——所以这是一个安静的
          info 标记和一条修复途径，绝不是警告 chip。旧版柠檬色 chip 把整个
          问题内联写出来（"needs OpenAI key · Settings"），而且因为是
          nowrap + flex-shrink:0，把自己顶出了 agent 卡片的边缘而不是换行。
          现在解释放在悬停 tooltip 里；屏幕上留下的只是一个 16px 字形
          加一个两词的行动。

          在紧凑模式（全屏工具栏）下，只有图标在承载它——tooltip 依然解释，
          而且 Settings 就在同一头部的点击范围里。 */}
      {noKey && (
        <span ref={hintRef} style={{ display: 'inline-flex', flexShrink: 0 }}>
          <button
            ref={iconRef}
            type="button"
            aria-label={t('realtimeToggle.whyDisabled')}
            aria-expanded={hintOpen}
            onClick={toggleHint}
            style={{
              border: 'none', background: 'none', padding: 0, cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center',
              opacity: hintOpen ? 1 : 0.75
            }}
          >
            <Icon name="info" />
          </button>

          {hint && createPortal(
            <div
              ref={panelRef}
              role="dialog"
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'fixed',
                left: hint.left,
                top: hint.top,
                zIndex: 460,
                width: HINT_W,
                padding: '8px 10px',
                display: 'flex',
                flexDirection: 'column',
                gap: 5,
                boxSizing: 'border-box',
                background: 'var(--cth-paper-100)',
                // 与笔记编辑器的 portalled popover 一致：发丝线 + 硬投影，
                // 让它读作浮在 dock 之上，而不是所覆盖的某张卡片的一部分。
                boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500), 4px 4px 0 rgba(26,19,32,0.25)',
                fontFamily: 'var(--cth-font-ui)',
                fontSize: 11,
                lineHeight: '15px',
                color: 'var(--cth-ink-900)',
                textAlign: 'left',
                whiteSpace: 'normal'
              }}
            >
              <span>{t('realtimeToggle.popoverBody')}</span>
              <button
                type="button"
                onClick={openKeySettings}
                style={{
                  border: 'none', background: 'none', padding: 0, cursor: 'pointer',
                  alignSelf: 'flex-start',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 11, lineHeight: '15px',
                  color: 'var(--cth-ink-900)', textDecoration: 'underline'
                }}
              >
                {t('realtimeToggle.setItUpNow')}
              </button>
            </div>,
            document.body
          )}
        </span>
      )}
    </span>
  );
}

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelPanel } from './PixelPanel';
import { PixelBadge, StatusKind } from './PixelBadge';
import { useHasTerminalDraft } from './terminalPool';
import { SpritePortrait } from './SpritePortrait';
import { RealtimeMichaelToggle } from './RealtimeMichaelToggle';
import { CostHud } from '@/realtime/CostHud';
import { AccentColorName } from '@/design/tokens';
import { OfficeCharacterName } from '@/scene/office/cast';
import { AgentNameEditor } from './AgentNameEditor';

export interface AgentCardProps {
  name: string;
  character: OfficeCharacterName;
  accent: AccentColorName;
  status: StatusKind;
  /** 此代理的 pty（如果有）。仅用于感知 USER 在其提示符上有未发送的文本——
   *  这会占住代理的队列；除此之外它看起来和没有任务的空闲代理完全一样。 */
  ptyId?: string;
  project: string;
  action?: string;
  /** 上下文仪表：0..8 段填充（会话上下文 ÷ 上下文上限）。 */
  progress?: number;
  /** 实时上下文大小（tokens）——显示在仪表 tooltip 中。 */
  contextTokens?: number;
  /** 该代理模型假定的上下文窗口上限（tokens）。 */
  contextLimit?: number;
  selected?: boolean;
  /** 你的克隆体——获得持久的强调色边框 + BOSS 标签以便突出显示。
   *  （`isGod` / `god` 代理 id 内部保持不变；这只是显示层面的东西。） */
  isGod?: boolean;
  onClick?: () => void;
  /** 持久化一次内联的显示名编辑；身份与 hive 路径保持不变。 */
  onRename?: (name: string) => Promise<{ ok: boolean; error?: string }>;
  /** 此代理正在实际执行的 ledger 任务数量——渲染为贴在卡片上的蓝色
   *  便签。点击它会打开第一个任务的详情。 */
  doingCount?: number;
  onTaskNoteClick?: () => void;
  draggable?: boolean; // 必须放在 <button> 本身上——Chromium 不会从表单控件内部的祖先元素上开始拖拽
  /** 私密备注——渲染为卡片自己的行（v0.3.4），这样它永远不会
   *  盖住上下文仪表。只显示第一行；完整文本在 tooltip 中。 */
  note?: string;
  /** 打开备注编辑器（该操作条拥有编辑浮层）。设置后，卡片会在备注行上
   *  显示一个小的 ✎ 提示。 */
  onEditNote?: () => void;
}

const fmtK = (n: number): string => `${Math.round(n / 1000)}k`;

/**
 * v0.3.4 紧凑重设计：一行身份（名字 + 状态）、一行上下文（工作时显示动作，
 * 空闲时显示仓库——都在 tooltip 中）、一行备注，以及一条贴在底部边缘的
 * 细仪表。任何东西都不会互相重叠。
 */
export function AgentCard({
  name, character, accent, status, ptyId, project, action, progress = 0,
  contextTokens, contextLimit, selected, isGod, onClick, onRename,
  doingCount = 0, onTaskNoteClick, draggable, note, onEditNote
}: AgentCardProps) {
  const { t } = useTranslation();
  const [hover, setHover] = useState(false);
  const typing = useHasTerminalDraft(ptyId);
  // 身份（IDENTITY）和选中（SELECTION）是两回事，把它们混为一谈正是
  // 「选中 Michael 却看起来什么都没发生」的原因。
  //
  // 过去卡片把 `isGod || selected` 传入 PixelPanel 的 'active' 变体，其边框是
  // `inset 1px + 3px accent + 5px ink`——五像素的边框，用的是代理自己颜色的
  // 强调色。这一下带来三个问题：选中提示随代理而变色（sky 代理出现「蓝色光晕」）、
  // 在 god 上不可见（因为 god 无条件带边框）、在它外面再叠加选中环让老板卡片
  // 明显比邻居更胖。
  //
  // 现在：god 由其表面（SURFACE）标记（见 godSurface），所有卡片共用同一条
  // 1px 面板边框，选中则是一个与强调色无关的环——每张卡片上完全一致，god
  // 也不例外。

  // 被选中的卡片在边框外戴一个 ink 色环。用 ink-900 而不是强调色，这样提示在
  // 每个代理上完全一致，并且会随主题翻转（米色底上近黑、深色底上近白），在
  // 卡片自带的任何强调色之上都清晰可辨。
  const selectionRing = selected ? '0 0 0 2px var(--cth-ink-900)' : '';

  // 上下文仪表是一整条干净的填充（0..8 → 0..100%）。颜色随窗口填满而升级：
  // 舒适时用强调色，6/8 起变琥珀色，7/8 起变珊瑚色。
  const pct = Math.min(8, Math.max(0, progress)) / 8 * 100;
  const gaugeColor = progress >= 7 ? 'var(--cth-coral)'
    : progress >= 6 ? 'var(--cth-lemon)'
      : `var(--cth-${accent})`;
  const gaugeTitle = contextTokens !== undefined && contextLimit
    ? t('agentCard.contextTitle', { used: fmtK(contextTokens), limit: fmtK(contextLimit), pct: Math.round((contextTokens / contextLimit) * 100) })
    : t('agentCard.contextGaugeTitle');

  // 所有代理使用同一种卡片尺寸。过去 god 是 216x86，其他代理是 196x76，
  // 导致停靠栏永远对不齐——而且一旦在其 5px 强调色边框外加了选中环，老板卡片的
  // 边缘就明显比其他卡片更粗。现在区别来自卡片的表面（SURFACE），而不是把盒子
  // 做大或把边框加粗。
  // 一旦 god 的行需要容纳 NAME + BOSS + status，196 就太挤了：名字被截成
  // "MIC…"——而名字是卡片上唯一绝不能成为被截断对象的内容。为每张卡片加宽，
  // 让停靠栏保持统一，同时留出足够余量，使 Talk 的信息标记（只在 OpenAI key
  // 缺失时出现）有地方安放，而不是把这一行撑开。
  const width = 220;
  const height = 78;
  const lift = (isGod ? -2 : 0) - (hover ? 1 : 0) - (selected ? 1 : 0);
  /** God 的区分：一层淡色表面外加一圈细强调色边框——而不是过去只放在顶部边缘的
   *  3px 规则。那条规则读起来像一条游离的黄色横条，而不是卡片的一部分；而且只
   *  出现在单侧的边缘处理总会被看成错误或进度条。与其他所有卡片同样的 1px
   *  几何结构，因此盒子不变，选中环在任何地方仍然只表达唯一一种含义。 */
  const godSurface: React.CSSProperties = isGod
    ? {
        background: `var(--cth-${accent}-light)`,
        boxShadow: `inset 0 0 0 1px var(--cth-${accent})`
      }
    : {};
  const dropShadow = isGod
    ? `2px 3px 0 0 rgba(26,19,32,${hover ? 0.2 : 0.14})`
    : (hover ? '1px 2px 0 0 rgba(26,19,32,0.12)' : 'none');
  // 环放在最前，紧贴卡片；然后是现有的投影。
  const outerShadow = [selectionRing, dropShadow === 'none' ? '' : dropShadow]
    .filter(Boolean).join(', ') || 'none';

  // 一行上下文：工作时显示在做什么，空闲时显示它存在于哪里。
  const infoLine = (status !== 'idle' && action) ? action : project;
  const noteFirstLine = (note ?? '').split('\n').find((l) => l.trim()) ?? '';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick?.();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      draggable={draggable}
      // 这个环是「哪个终端开着」的视觉答案；这里是同一个答案的屏幕阅读器版本。
      // 与全屏模式中的 SidebarRow 保持一致。
      aria-current={selected ? 'true' : undefined}
      className="cth-titlebar-nodrag"
      style={{
        width, minWidth: width, height,
        padding: 0, border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left',
        position: 'relative',
        transform: lift ? `translateY(${lift}px)` : 'none',
        boxShadow: outerShadow,
        transition: 'transform 90ms steps(2, end), box-shadow 90ms steps(2, end)'
      }}
    >
      {/* 便签，像贴在桌面上那样贴在卡片上：这个 worker 正在实际执行一个
          ledger 任务。点击 → 该任务的详情浮层。 */}
      {doingCount > 0 && (
        <span
          title={doingCount === 1
            ? t('agentCard.doingTasks', { count: doingCount })
            : t('agentCard.doingTasksPlural', { count: doingCount })}
          onClick={(e) => { e.stopPropagation(); onTaskNoteClick?.(); }}
          style={{
            position: 'absolute', right: -4, bottom: -5, zIndex: 2,
            width: 20, height: 18,
            background: 'var(--cth-sky)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300), 1px 2px 0 rgba(26,19,32,0.18)',
            transform: 'rotate(4deg)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-900)',
            cursor: 'pointer'
          }}
        >
          {doingCount > 1 ? doingCount : '✎'}
        </span>
      )}
      <PixelPanel
        variant="default"
        style={{ height: '100%', padding: '6px 8px', ...godSurface }}
        noPadding
      >
        <div style={{ display: 'flex', gap: 8, height: '100%' }}>
          {/* 头像方块——垂直居中，让卡片看起来平静而整齐。 */}
          <div style={{
            width: 36, height: isGod ? 50 : 46, alignSelf: 'center',
            // God 的卡片现在是浅强调色底，所以方块不能再是——否则会融入自己的
            // 背景。纸色在浅色底上读起来像一圈内嵌边框，这正是方块应有的样子。
            background: isGod ? 'var(--cth-paper-100)' : `var(--cth-${accent}-light)`,
            boxShadow: `inset 0 0 0 1px var(--cth-ink-${isGod ? '300' : '100'})`,
            // 锚定精灵图的顶部：56px 高的肖像会溢出这个方块，底部锚定会裁掉
            // 头部——裁脚不裁脸。
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflow: 'hidden',
            flexShrink: 0
          }}>
            <SpritePortrait character={character} scale={2} />
          </div>

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            {/* 身份行：名字（+ BOSS 标签）+ 状态。 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between', minWidth: 0 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0, flex: 1 }}>
                {onRename ? (
                  <AgentNameEditor name={name} onCommit={onRename} uppercase />
                ) : (
                  <span style={{
                    fontFamily: 'var(--cth-font-display)',
                    fontSize: 'var(--cth-text-display-sm)',
                    lineHeight: 'var(--cth-lh-display-sm)',
                    color: 'var(--cth-ink-900)',
                    flex: 1, minWidth: 0,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                  }}>{name.toUpperCase()}</span>
                )}
                {isGod && (
                  <span style={{
                    fontFamily: 'var(--cth-font-display)', fontSize: 7, lineHeight: '11px',
                    background: `var(--cth-${accent})`, color: 'var(--cth-ink-900)',
                    padding: '1px 4px 0', flexShrink: 0
                  }}>{t('agentCard.boss')}</span>                )}
              </span>
              {/* flexShrink:0 —— 徽章是一个固定的 2 到 5 字符小块；如果允许它
                  收缩，浏览器会通过吞掉名字来解决溢出。截断应该落在最长、
                  最冗余的内容上，而不是落在身份上。 */}
              <PixelBadge status={typing ? 'typing' : status} style={{ flexShrink: 0 }} />
            </div>

            {/* 上下文行：工作时显示动作，空闲时显示仓库。 */}
            <div
              title={`${project}${action && status !== 'idle' ? ` — ${action}` : ''}`}
              style={{
                fontSize: 11, lineHeight: '14px',
                color: 'var(--cth-ink-500)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
              }}
            >{infoLine}</div>

            {/* God：声音独占一行紧凑的行。Worker：私密备注行。
                两者都在仪表上方，所以仪表永远不会被盖住。 */}
            {isGod ? (
              // OpenAI key 缺失时 Talk 会多出一个信息标记，所以这一行要容纳
              // 三样东西而不是两样。`overflow: hidden` 是防护：开关的标签会
              // 先收缩（它有 minWidth:0），如果仍然放不下，这一行会在卡片
              // 内部裁剪，而不是溢出到边框外。
              <div
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  minWidth: 0, overflow: 'hidden'
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <RealtimeMichaelToggle />
                <CostHud compact />
              </div>
            ) : (
              <div
                onClick={(e) => e.stopPropagation()}
                style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, minHeight: 14 }}
              >
                {noteFirstLine ? (
                  <span
                    title={note}
                    style={{
                      flex: 1, minWidth: 0, fontSize: 10.5, lineHeight: '14px',
                      color: 'var(--cth-ink-500)', fontStyle: 'italic',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                    }}
                  >{noteFirstLine}</span>
                ) : <span style={{ flex: 1 }} />}
                {onEditNote && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => { e.stopPropagation(); onEditNote(); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); onEditNote(); }
                    }}
                    title={note ? t('agentCard.editNote') : t('agentCard.addNote')}
                    aria-label={t('agentCard.editNoteAria', { name })}
                    style={{
                      flexShrink: 0, width: 15, height: 14,
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 10, lineHeight: 1, cursor: 'pointer',
                      // 卡片悬停前保持低调——可被发现，但不聒噪。
                      color: hover ? 'var(--cth-ink-500)' : 'var(--cth-ink-300)'
                    }}
                  >✎</span>
                )}
              </div>
            )}

            {/* 上下文仪表——固定在卡片底部边缘的细填充条。 */}
            <div style={{ marginTop: 'auto' }} title={gaugeTitle}>
              <div style={{
                height: 4, width: '100%',
                background: 'var(--cth-cream-200)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                overflow: 'hidden'
              }}>
                <div style={{ width: `${pct}%`, height: '100%', background: gaugeColor }} />
              </div>
            </div>
          </div>
        </div>
      </PixelPanel>
    </div>
  );
}

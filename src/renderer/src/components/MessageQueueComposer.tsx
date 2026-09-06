import { ClipboardEvent, DragEvent, KeyboardEvent, type MouseEvent as ReactMouseEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useStore, type Agent, type QueuedMessage } from '@/store/store';
import { clearTerminalDraft, dismissTerminalPicker, terminalAutomationBlockFor } from './terminalPool';
import type { TerminalAutomationBlock } from './terminalAutomation';
import { freeflowRecorder, useFreeflow } from '@/freeflow/recorder';
import { useTerminalFontSize } from './terminalFontSize';
import { isComposingKey } from '@shared/imeGuard';
import { useRtl } from '@/i18n/useDirection';

const EMPTY_QUEUE: QueuedMessage[] = [];

/** 附加到草稿的文件/图片。作为一条 PATH 传给 agent 去 Read。 */
interface Attachment {
  path: string;
  name: string;
}

// 前置的内容（只加到入队值，从不加到可见草稿）当

export interface MessageQueueComposerProps {
  agent: Agent;
}

/**
 * 让用户在 agent 终端运行中途也能继续给它发消息。输入的消息停在
 * 每个 agent 自己的队列里，等它的 Claude TUI 一空闲就逐条提交
 *（见 useHive 的 flush 循环）。
 */
export function MessageQueueComposer({ agent }: MessageQueueComposerProps) {
  const { t } = useTranslation();
  const rtl = useRtl();
  const queue = useStore((s) => s.messageQueues[agent.id]) ?? EMPTY_QUEUE;
  const enqueueMessage = useStore((s) => s.enqueueMessage);
  const removeQueuedMessage = useStore((s) => s.removeQueuedMessage);
  const releaseQueuedMessage = useStore((s) => s.releaseQueuedMessage);
  const clearQueue = useStore((s) => s.clearQueue);

  // 草稿存在 store 里，按 agent 分键——切换 agent 会重挂这个
  // 组件，组件本地状态会悄悄吃掉已输入的文本。
  const text = useStore((s) => s.drafts[agent.id] ?? '');
  const setDraft = useStore((s) => s.setDraft);
  const setText = (t: string) => setDraft(agent.id, t);

  // Free Flow 语音听写（入口 A）。麦克风按钮只在 Settings 里启用该功能时
  // 出现；转录文本追加到这个草稿里供发送前审阅（绝不自动发送）。启用但
  // 未配置 Groq key 时，按钮保持 VISIBLE 但 DISABLED，带指向 Settings 的
  // tooltip（hasGroqKey 只表示布尔存在——key 值从不进入 store）。
  const freeflowEnabled = useStore((s) => s.freeflowEnabled);
  const hasGroqKey = useStore((s) => s.hasGroqKey);
  const ff = useFreeflow();
  const ffMine = ff.targetAgentId === agent.id;
  const ffHint = !freeflowEnabled
    ? null
    : ffMine && ff.status === 'recording'
    ? t('queueComposer.recording')
    : ffMine && ff.status === 'transcribing'
    ? t('queueComposer.transcribing')
    : ff.error && (ffMine || ff.targetAgentId === null)
    ? `${t('queueComposer.voice')}: ${ff.error}`
    : null;

  // 草稿框是终端的孪生——它应该在任何缩放级别下都与 agent 输出
  // 同字号阅读。
  const composerFontSize = useTerminalFontSize();
  const composerLineHeight = Math.round(composerFontSize * 1.4);

  const idle = agent.status === 'idle';

  // 只有 god/Michael agent 有委托开关。默认关。

  // 为下一条消息暂存的文件/图片。组件本地状态：切换 agent 会重挂
  // 这个组件，所以附件在切换标签页时被清掉（草稿保存在 store 里，
  // 附件刻意不跨标签页保留）。
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const addAttachments = (incoming: Attachment[]) =>
    setAttachments((prev) => {
      const seen = new Set(prev.map((a) => a.path));
      const fresh = incoming.filter((a) => a.path && !seen.has(a.path));
      return fresh.length ? [...prev, ...fresh] : prev;
    });

  const removeAttachment = (path: string) =>
    setAttachments((prev) => prev.filter((a) => a.path !== path));

  // '+' 按钮 → OS 选择器（图片组 + 所有文件）。
  const pickFiles = async () => {
    const res = await window.cth.attachFiles();
    if (res.ok) addAttachments(res.files);
  };

  // 把文件拖到 composer 上 → 把每个都解析成绝对路径。
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = Array.from(e.dataTransfer?.files ?? []);
    if (!dropped.length) return;
    const atts = dropped
      .map((f) => ({ path: window.cth.pathForFile(f), name: f.name }))
      .filter((a) => a.path);
    if (atts.length) addAttachments(atts);
  };

  // 粘贴截图（无路径 → 把原生剪贴板图片持久化到临时文件）
  // 或粘贴从 OS 文件管理器复制的文件（带真实路径）。
  const onPaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const hasImage = items.some((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (hasImage) {
      e.preventDefault();
      const res = await window.cth.saveClipboardImage();
      if (res.ok) addAttachments([res.file]);
      return;
    }
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length) {
      const atts = files
        .map((f) => ({ path: window.cth.pathForFile(f), name: f.name }))
        .filter((a) => a.path);
      if (atts.length) {
        e.preventDefault();
        addAttachments(atts);
      }
    }
  };

  const canSend = !!text.trim() || attachments.length > 0;

  const queueIt = () => {
    if (!canSend) return;
    // 用与 Slack 入站路径（useHive.ts）相同的基于路径的约定，
    // 前置一个 "Attached files:" 块，让 agent 直接 Read 这些文件。
    const body = attachments.length
      ? (text.trim()
          ? `${text}\n\nAttached files:\n`
          : 'Attached files:\n') + attachments.map((a) => `- ${a.path} (${a.name})`).join('\n')
      : text;
    enqueueMessage(agent.id, body);
    // 在 HERE（composer 的提交处）计数，而不是 enqueueMessage 内部：
    // 那个 store action 也是工单、Slack 入站、提醒和 compact 命令到达
    // agent 的途径，而它们没有一个是真人发消息。在 onKey 的
    // isComposingKey 守卫之后，所以 IME 候选字的 Enter 绝不会被计数。
    // (TELEMETRY.md → message_sent)
    void window.cth.trackMessageSent('composer');
    setText('');
    setAttachments([]);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposingKey(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      queueIt();
    }
  };

  // 投递可能被 agent 自己的终端拖住（打到一半的草稿或打开的斜杠命令
  // 选择器占着 prompt）。过去这不可见——提示声称正在发送而什么都没动——
  // 所以轮询它并说出来。
  const block = useTerminalBlock(agent.ptyId, queue.length > 0 && idle);

  // 全地板的自动投递暂停（Command Center 开关）也会拖住队列。
  // 不说清楚这一点、也没有逐行"立即发送"覆盖的话，消息看起来就像
  // 永远卡住，既无解释也无逃生口。
  const deliveryPaused = useDeliveryPaused(agent.id, queue.length > 0);

  const statusHint = queue.length === 0
    ? null
    : !idle
    ? t('queueComposer.busyQueued', { name: agent.name, count: queue.length })
    : deliveryPaused && !queue[0]?.manual
    ? t('queueComposer.heldFloor')
    : block === 'draft'
    ? t('queueComposer.heldDraft', { name: agent.name })
    : block === 'picker'
    ? t('queueComposer.heldPicker', { name: agent.name })
    : block === 'exited'
    ? t('queueComposer.heldExited', { name: agent.name })
    : t('queueComposer.sendingOneByOne', { name: agent.name });

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
      onDragLeave={(e) => {
        // 只在光标真正离开 composer 时才清除，而不是进入子元素时。
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragOver(false);
      }}
      onDrop={onDrop}
      style={{
        flexShrink: 0,
        borderTop: '1px solid var(--cth-ink-700)',
        background: 'var(--cth-cream-100)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: 8,
        boxShadow: dragOver ? 'inset 0 0 0 2px var(--cth-lilac)' : undefined
      }}>
      {dragOver && (
        <span style={{
          fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '12px',
          color: 'var(--cth-ink-700)', textAlign: 'center'
        }}>{t('queueComposer.dropToAttach')}</span>
      )}
      {/* 头部：标签、计数、状态、全部清除 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          fontFamily: 'var(--cth-font-display)',
          fontSize: 9, lineHeight: '12px',
          color: 'var(--cth-ink-700)'
        }}>{t('queueComposer.queue')}</span>
        {queue.length > 0 && (
          <span style={{
            fontSize: 11, padding: '1px 6px 0',
            background: 'var(--cth-cream-200)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
            fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-900)'
          }}>{queue.length}</span>
        )}
        {statusHint && (
          <span
            title={deliveryPaused && !queue[0]?.manual
              ? t('queueComposer.pausedTitle')
              : statusHint}
            style={{
              fontSize: 12,
              color: idle ? 'var(--cth-ink-700)' : 'var(--cth-ink-500)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
            }}
          >{statusHint}</span>
        )}
        {(block === 'draft' || block === 'picker') && agent.ptyId && (
          <button
            onClick={() => {
              // 选择器和草稿由不同的键解锁：Escape 关掉选择器，Ctrl-U
              // 杀掉输入行。在打开的选择器上发 Ctrl-U 会让它继续开着，
              // 却告诉自动化 prompt 已空——于是排队的消息被打进一个
              // 菜单里并被标记为已投递。
              if (block === 'picker') { dismissTerminalPicker(agent.ptyId!); return; }
              // 保留 prompt 上的内容——它落到这个 composer 里，让用户
              // 能正式发送，而不是被 Ctrl-U 丢掉。
              const discarded = clearTerminalDraft(agent.ptyId!);
              if (discarded.trim()) setText(text ? `${text}\n${discarded}` : discarded);
            }}
            title={block === 'picker'
              ? "关闭该 agent 已打开的选择器，以便投递排队中的消息"
              : "把该 agent 的 prompt 中遗留的文本移入此框，以便投递排队中的消息"}
            style={{
              border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
              fontFamily: 'var(--cth-font-ui)', fontSize: 12,
              color: 'var(--cth-ink-900)', textDecoration: 'underline'
            }}
          >{block === 'picker' ? t('queueComposer.closePicker') : t('queueComposer.recoverPrompt')}</button>
        )}
        {queue.length > 1 && (
          <button
            onClick={() => clearQueue(agent.id)}
            title={t('queueComposer.clearAllTitle')}
            style={{
              marginLeft: 'auto', flexShrink: 0, whiteSpace: 'nowrap',
              border: 'none', background: 'transparent', cursor: 'pointer',
              fontFamily: 'var(--cth-font-ui)', fontSize: 12,
              color: 'var(--cth-ink-500)'
            }}
          >{t('queueComposer.clearAll')}</button>
        )}
      </div>

      {/* 待处理列表 */}
      {queue.length > 0 && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 4,
          maxHeight: 280, overflowY: 'auto'
        }}>
          {queue.map((m, i) => (
            <QueuedMessageRow
              key={m.id}
              index={i}
              message={m}
              paused={deliveryPaused}
              onSendNow={() => releaseQueuedMessage(agent.id, m.id)}
              onRemove={() => removeQueuedMessage(agent.id, m.id)}
            />
          ))}
        </div>
      )}

      {/* Free Flow 录音/转录状态（入口 A） */}
      {ffHint && (
        <span style={{
          fontSize: 12, lineHeight: '16px',
          color: ff.error && !(ffMine && ff.status !== 'idle') ? 'var(--cth-coral)' : 'var(--cth-ink-500)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
        }}>{ffHint}</span>
      )}

      {/* 附加的文件/图片——带移除 'x' 的 chips，位于 textarea 上方。 */}
      {attachments.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {attachments.map((a) => (
            <span
              key={a.path}
              title={a.path}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                maxWidth: '100%',
                padding: '2px 4px 2px 6px',
                background: 'var(--cth-cream-200)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                fontFamily: 'var(--cth-font-mono)', fontSize: 12, lineHeight: '16px',
                color: 'var(--cth-ink-900)'
              }}
            >
              <Icon name="folder" />
              <span style={{
                overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', maxWidth: 180
              }}>{a.name}</span>
              <button
                onClick={() => removeAttachment(a.path)}
                title={t('queueComposer.removeAttachment')}
                style={{
                  flexShrink: 0, border: 'none', background: 'transparent', cursor: 'pointer',
                  color: 'var(--cth-ink-500)', padding: 0,
                  display: 'inline-flex', alignItems: 'center'
                }}
              >
                <Icon name="x" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Composer——全宽输入，下面一条整洁的控制栏（cc-ui-polish），
          带文件/图片附件 chips + 粘贴即附加（rich-composer）。 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <textarea
          dir={rtl ? 'auto' : undefined}
          className="cth-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          rows={5}
          placeholder={idle ? t('queueComposer.messagePlaceholder', { name: agent.name }) : t('queueComposer.busyPlaceholder', { name: agent.name })}
          style={{
            width: '100%',
            resize: 'vertical',
            // 跟随终端的缩放（Cmd +/- 或终端自己的缩放按钮），而不是
            // 写死的 13px。在大屏幕上，终端文本放大了而这个框还那么小；
            // 框高从同一个尺寸推导，可见行数才稳定。
            minHeight: composerLineHeight * 5 + 14,
            maxHeight: composerLineHeight * 18,
            padding: '6px 8px',
            background: 'var(--cth-paper-100)',
            border: 'none',
            // 边框放在 .cth-input 里，这样 :focus 能改它——内联的
            // boxShadow 在这里会压过样式表，focus 状态就永远不生效了。
            fontFamily: 'var(--cth-font-mono)',
            fontSize: composerFontSize, lineHeight: `${composerLineHeight}px`,
            color: 'var(--cth-ink-900)',
            outline: 'none',
            boxSizing: 'border-box'
          }}
        />
        {/* 控制栏：Attach + 语音 + Send 右对齐。flexWrap 让窄侧边栏
            把按钮换行到第二行，而不是把 Send 推出屏幕。 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, rowGap: 6, flexWrap: 'wrap', minWidth: 0 }}>
          <span style={{ flex: 1 }} />
          <PixelButton variant="secondary" size="sm" onClick={pickFiles}>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <Icon name="plus" /> {t('queueComposer.files')}
            </span>
          </PixelButton>
          {freeflowEnabled && <FreeFlowButton agentId={agent.id} hasGroqKey={hasGroqKey} />}
          <PixelButton variant="primary" size="sm" onClick={queueIt} disabled={!canSend}>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              {t('commandBar.send')} <Icon name="arrow-right" />
            </span>
          </PixelButton>
        </div>
      </div>
    </div>
  );
}

/** 当有东西在等它时，轮询 pty 的自动化阻塞状态。该标志活在终端池里
 * （一个普通模块 map，不是 store），所以没有可订阅的东西——
 * 队列待处理时 1s 轮询一次就足够了。 */
function useTerminalBlock(ptyId: string | undefined, active: boolean): TerminalAutomationBlock {
  const [block, setBlock] = useState<TerminalAutomationBlock>(null);
  useEffect(() => {
    if (!ptyId || !active) { setBlock(null); return; }
    const read = () => setBlock(terminalAutomationBlockFor(ptyId));
    read();
    const iv = setInterval(read, 1000);
    return () => clearInterval(iv);
  }, [ptyId, active]);
  // 'settling' 是写入之间的亚秒级空隙——不值得告诉任何人。
  return block === 'settling' ? null : block;
}

/** 当这个 agent 有待处理消息时，轮询全地板自动投递暂停（主进程控制
 * 状态）。2s 足够——暂停以人类时间尺度翻转，而 drain 在每次发送前都会
 * 重读实时快照。 */
function useDeliveryPaused(agentId: string, active: boolean): boolean {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!active) { setPaused(false); return; }
    let alive = true;
    const read = () => {
      window.cth.controlSnapshot(agentId)
        .then((s) => { if (alive) setPaused(!!s?.autoDeliveryPaused); })
        .catch(() => { /* 主进程未就绪——假定未暂停 */ });
    };
    read();
    const iv = setInterval(read, 2000);
    return () => { alive = false; clearInterval(iv); };
  }, [agentId, active]);
  return paused;
}

/**
 * 一条待处理队列行。折叠时钳制到 2 行；"see more"就地展开，
 * 让长消息不用悬停等 tooltip 也能读全。开关只在文本确实被裁剪时
 * 渲染，所以短消息保持整洁。
 */
function QueuedMessageRow(
  { index, message, paused, onSendNow, onRemove }: {
    index: number;
    message: QueuedMessage;
    /** 全地板自动投递已暂停——提供逐消息覆盖。 */
    paused: boolean;
    onSendNow: () => void;
    onRemove: () => void;
  }
) {
  const { t } = useTranslation();
  const rtl = useRtl();
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 针对 CLAMPED 盒子测量，让开关在展开后依然成立（展开的盒子
  // 永不溢出，否则会报 clipped = false）。
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => {
      if (expanded) return;
      setClipped(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    // 面板可调整大小——宽度变化时重测，而不只是文本变化。
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [message.text, expanded]);

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 6,
      padding: '4px 6px',
      background: 'var(--cth-paper-100)',
      boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
    }}>
      <span style={{
        fontFamily: 'var(--cth-font-mono)', fontSize: 12,
        color: 'var(--cth-ink-500)', lineHeight: '18px', flexShrink: 0
      }}>{`${index + 1}.`}</span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div
          ref={bodyRef}
          dir={rtl ? 'auto' : undefined}
          title={expanded ? undefined : message.text}
          style={{
            fontSize: 12, lineHeight: '18px',
            color: 'var(--cth-ink-900)',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            ...(expanded
              // 限制展开的正文，让一条长消息不会把队列其余部分
              // 挤出列表自己的 280px 滚动区。
              ? { maxHeight: 220, overflowY: 'auto' as const }
              : {
                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                  overflow: 'hidden'
                })
          }}
        >{message.text}</div>
        {(clipped || expanded || paused) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {(clipped || expanded) && (
              <button
                onClick={() => setExpanded((e) => !e)}
                title={expanded ? t('queueComposer.collapse') : t('queueComposer.showFull')}
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
                  fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '16px',
                  color: 'var(--cth-ink-500)', textDecoration: 'underline'
                }}
              >{expanded ? t('queueComposer.seeLess') : t('queueComposer.seeMore')}</button>
            )}
            {paused && !message.manual && (
              <button
                onClick={onSendNow}
                title={t('queueComposer.sendNowTitle')}
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
                  fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '16px',
                  color: 'var(--cth-ink-900)', textDecoration: 'underline'
                }}
              >{t('queueComposer.sendNow')}</button>
            )}
            {paused && message.manual && (
              <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                {t('queueComposer.sendingWhenFree')}
              </span>
            )}
          </div>
        )}
      </div>
      <button
        onClick={onRemove}
        title={t('queueComposer.removeFromQueue')}
        style={{
          flexShrink: 0, border: 'none', background: 'transparent',
          cursor: 'pointer',
          color: 'var(--cth-ink-500)', padding: 0,
          display: 'inline-flex', alignItems: 'center'
        }}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}


/**
 * 队列 composer 的按住说话按钮。点击开始录音，再点一次停止 →
 * 转录 → 文本追加到这个 agent 的草稿。另一个 agent 正在听写时
 * 它被禁用（共用一个录音器）。实际的采集 + Groq 调用活在
 * freeflow 录音器单例里。
 *
 * 未配置 Groq key 时按钮保持可见但禁用，带指向 Settings 的
 * tooltip——它绝不会开始录音，所以 getUserMedia 和 Groq STT 调用
 * 永不被触达（保持"不可用时零调用"的保证）。`hasGroqKey` 只表示
 * 布尔存在；key 值绝不落到这里。
 */
function FreeFlowButton({ agentId, hasGroqKey }: { agentId: string; hasGroqKey: boolean }) {
  const { t } = useTranslation();
  const ff = useFreeflow();
  const mine = ff.targetAgentId === agentId;
  const recording = ff.status === 'recording' && mine;
  const transcribing = ff.status === 'transcribing' && mine;
  // 另一个 agent 的片段正在录音/上传时阻塞（单个录音器）。
  const busyElsewhere = ff.status !== 'idle' && !mine;
  const noKey = !hasGroqKey;

  const hintRef = useRef<HTMLSpanElement | null>(null);
  const iconRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [hint, setHint] = useState<{ left: number; top: number } | null>(null);
  const hintOpen = hint !== null;

  const HINT_W = 244;
  const HINT_GAP = 8;
  const EST_H = 188;

  const title = noKey
    ? t('queueComposer.ffNoKeyTitle')
    : recording ? t('queueComposer.ffStopTranscribe')
    : transcribing ? t('queueComposer.transcribing')
    : t('queueComposer.ffTitle');

  /** 与 RealtimeMichaelToggle 提示的同一放置规则：优先上方（composer
   *  在面板里位置偏下），只有没空间时才翻到下方，并把两个轴都夹住，
   *  让它绝不会伸出边缘。 */
  const toggleHint = (e: ReactMouseEvent): void => {
    e.stopPropagation();
    if (hint) { setHint(null); return; }
    const r = iconRef.current?.getBoundingClientRect();
    if (!r) return;
    const above = r.top - HINT_GAP - EST_H;
    const top = above >= 8 ? above : Math.min(r.bottom + HINT_GAP, window.innerHeight - EST_H - 8);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - HINT_W - 8));
    setHint({ left, top: Math.max(8, top) });
  };

  useEffect(() => {
    if (!hintOpen) return;
    const onDown = (ev: globalThis.MouseEvent): void => {
      const t = ev.target as Node;
      // Portalled，所以"内部点击"必须同时对两个节点做测试。
      if (hintRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setHint(null);
    };
    const onKey = (ev: globalThis.KeyboardEvent): void => { if (ev.key === 'Escape') setHint(null); };
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

  const openKeySettings = (e: ReactMouseEvent): void => {
    e.stopPropagation();
    setHint(null);
    window.dispatchEvent(new CustomEvent('cth:open-settings', { detail: { section: 'Voice' } }));
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: noKey ? 4 : 0, minWidth: 0 }}>
      {/* 包在一个（非禁用）span 里，让原生 tooltip 在内层按钮被禁用时
         仍能在悬停时显示——Chromium 会抑制禁用 <button> 自身的 tooltip。 */}
      <span title={title} style={{ display: 'inline-flex' }}>
        <PixelButton
          variant={recording ? 'destructive' : 'secondary'}
          size="sm"
          onClick={() => { if (noKey) return; freeflowRecorder.toggle(agentId); }}
          disabled={noKey || transcribing || busyElsewhere}
        >
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <Icon name="mic" />
            {transcribing ? '…' : recording ? t('queueComposer.stop') : t('queueComposer.voice')}
          </span>
        </PixelButton>
      </span>

      {/* 缺 key 是 SETUP STATE，不是失败——与 Talk 得到的处理一致。
         没有它按钮点击就是死的，而且能让用户行动的两个事实（它是 FREE 的、
         有个按住说话的快捷键）在 UI 里没有任何地方写明。 */}
      {noKey && (
        <span ref={hintRef} style={{ display: 'inline-flex', flexShrink: 0 }}>
          <button
            ref={iconRef}
            type="button"
            aria-label={t('queueComposer.ffHowEnable')}
            aria-expanded={hintOpen}
            onClick={toggleHint}
            style={{
              border: 'none', background: 'none', padding: 0, cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center',
              color: 'var(--cth-ink-500)',
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
                position: 'fixed', left: hint.left, top: hint.top, zIndex: 460,
                width: HINT_W, padding: '10px 12px', boxSizing: 'border-box',
                display: 'flex', flexDirection: 'column', gap: 7,
                background: 'var(--cth-paper-100)',
                boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500), 4px 4px 0 rgba(26,19,32,0.25)',
                fontFamily: 'var(--cth-font-ui)', fontSize: 11, lineHeight: '15px',
                color: 'var(--cth-ink-900)', textAlign: 'left', whiteSpace: 'normal'
              }}
            >
              <span style={{
                fontFamily: 'var(--cth-font-display)', fontSize: 9, letterSpacing: 0.5,
                textTransform: 'uppercase', color: 'var(--cth-ink-500)'
              }}>{t('queueComposer.ffSetupTitle')}</span>

              {/* 先讲代价，因为"add an API key"读起来像"这会扣我钱"，
                 而正是这个假设挡住了人。 */}
              <span>
                {t('queueComposer.ffSetupIntro')}
              </span>

              <ol style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 3 }}>
                <li>
                  {t('queueComposer.ffCreateKey')}{' '}
                  <a
                    href="https://console.groq.com/keys"
                    onClick={(e) => { e.preventDefault(); void window.cth.openExternal('https://console.groq.com/keys'); }}
                    style={{ color: 'var(--cth-ink-900)' }}
                  >{t('queueComposer.groqKeysLink')}</a>
                </li>
                <li>{t('queueComposer.ffPasteKey')}</li>
                <li>{t('queueComposer.ffClickOrHold')}</li>
              </ol>

              <span style={{ color: 'var(--cth-ink-500)' }}>
                {t('queueComposer.ffHoldHint')}
              </span>

              <button
                type="button"
                onClick={openKeySettings}
                style={{
                  border: 'none', background: 'none', padding: 0, cursor: 'pointer',
                  alignSelf: 'flex-start',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 11, lineHeight: '15px',
                  color: 'var(--cth-ink-900)', textDecoration: 'underline'
                }}
              >				{t('realtimeToggle.setItUpNow')}</button>
            </div>,
            document.body
          )}
        </span>
      )}
    </span>
  );
}

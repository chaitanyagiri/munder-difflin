import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ContextRule, ContextTriggerConfig } from '@shared/triggers';
import { getContextTrigger, setContextTrigger } from './api';
import {
  Callout, Field, Hint, IntervalPicker, Muted, PctField, SubCard, SubHeader, Toggle,
  fmtInterval, textareaStyle
} from './ui';
import { useRtl } from '@/i18n/useDirection';

/**
 * CONTEXT —— 触发条件是代理自身终端被填满，而不是仅仅靠时钟。两条规则，而且
 * 它们不是同一种操作：compaction（压缩）对上下文做 SUMMARISE（概括），
 * clearing（清空）则 THROWS IT AWAY（把它丢掉）。
 */

const WRITE_DEBOUNCE_MS = 400;

export function ContextSection({ onSummary }: { onSummary?: (s: string) => void }) {
  const { t } = useTranslation();
  const [cfg, setCfg] = useState<ContextTriggerConfig | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    getContextTrigger().then((c) => { if (alive) setCfg(c); }).catch(() => { /* defaults */ });
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    if (!cfg) return;
    const on = [
      cfg.compact.enabled ? t('contextSection.compact') : null,
      cfg.clear.enabled ? t('contextSection.clear') : null
    ].filter(Boolean);
    onSummary?.(on.length ? on.join(' + ') : t('contextSection.bothOff'));
  }, [cfg, onSummary, t]);

  // 乐观 + 防抖：控件即时响应，消息框里的一阵输入会合并成一次写入，而不是
  // 每次按键一次。
  const commit = (next: ContextTriggerConfig) => {
    setCfg(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setContextTrigger(next), WRITE_DEBOUNCE_MS);
  };
  const patch = (key: 'compact' | 'clear', fields: Partial<ContextRule>) => {
    if (!cfg) return;
    commit({ ...cfg, [key]: { ...cfg[key], ...fields } });
  };

  if (!cfg) return <Muted>{t('contextSection.loading')}</Muted>;

  return (
    <>
      <Muted>
        {t('contextSection.intro')}
      </Muted>
      <div style={{ height: 8 }} />

      <RuleCard
        title={t('contextSection.compact')}
        blurb={t('contextSection.compactBlurb')}
        rule={cfg.compact}
        messageLabel={t('contextSection.extraFocus')}
        messageHint={t('contextSection.extraFocusHint')}
        messagePlaceholder={t('contextSection.extraFocusPlaceholder')}
        onPatch={(fields) => patch('compact', fields)}
      />

      <RuleCard
        title={t('contextSection.clear')}
        blurb={t('contextSection.clearBlurb')}
        rule={cfg.clear}
        messageLabel={t('contextSection.command')}
        messageHint={t('contextSection.commandHint')}
        messagePlaceholder="/clear"
        caution={t('contextSection.clearCaution')}
        onPatch={(fields) => patch('clear', fields)}
      />
    </>
  );
}

function RuleCard({ title, blurb, rule, messageLabel, messageHint, messagePlaceholder, caution, onPatch }: {
  title: string;
  blurb: string;
  rule: ContextRule;
  messageLabel: string;
  messageHint: string;
  messagePlaceholder: string;
  caution?: ReactNode;
  onPatch: (fields: Partial<ContextRule>) => void;
}) {
  const { t } = useTranslation();
  const rtl = useRtl();
  const [open, setOpen] = useState(false);
  return (
    <SubCard>
      <SubHeader
        open={open}
        onToggle={() => setOpen((o) => !o)}
        title={title}
        sub={blurb}
        right={<Toggle on={rule.enabled} onClick={() => onPatch({ enabled: !rule.enabled })} />}
      />
      {/* 警告始终显示在屏幕上 —— 这正是它随关闭一起下线的意义 —— 但它只有
          在破坏性规则真正启用时才变成珊瑚色。对已关闭的设置亮红框是狼来了。 */}
      {caution && <Callout tone={rule.enabled ? 'warn' : 'note'}>{caution}</Callout>}
      {!open && (
        <Hint>
          {rule.enabled
            ? t('contextSection.hintEvery', { interval: fmtInterval(rule.everyMs), pct: rule.minContextPct })
            : t('contextSection.off')}
        </Hint>
      )}
      {open && (
        <div style={{ marginTop: 4 }}>
          <Field label={t('contextSection.noSoonerThan')}>
            {/* Main 将上下文节奏限制在 1 分钟 … 24 小时，因此
                选择器只提供该范围，绝不会标记一个它实际上
                无法存储的值。 */}
            <IntervalPicker
              value={rule.everyMs}
              onChange={(everyMs) => onPatch({ everyMs })}
              minMs={60_000}
              maxMs={86_400_000}
            />
          </Field>
          <Field label={t('contextSection.contextBar')}>
            <PctField value={rule.minContextPct} onChange={(minContextPct) => onPatch({ minContextPct })} />
            <Hint>{t('contextSection.contextBarHint')}</Hint>
          </Field>
          <Field label={t('contextSection.bigWindows')}>
            <PctField
              value={rule.minContextPctLargeWindow}
              onChange={(minContextPctLargeWindow) => onPatch({ minContextPctLargeWindow })}
            />
            <Hint>{t('contextSection.bigWindowsHint')}</Hint>
          </Field>
          <Field label={messageLabel}>
            <textarea
              dir={rtl ? 'auto' : undefined}
              value={rule.message}
              onChange={(e) => onPatch({ message: e.target.value })}
              rows={3}
              placeholder={messagePlaceholder}
              style={textareaStyle}
            />
            <Hint>{messageHint}</Hint>
          </Field>
        </div>
      )}
    </SubCard>
  );
}

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import { CLONE_NODE_BLURB, type OrgTriggerConfig, type TriggerMode } from '@shared/triggers';
import { getOrgTrigger, setOrgTrigger as persistOrgTrigger } from './api';
import { Callout, Field, Hint, ModePicker, SecretField, Toggle } from './ui';

/**
 * ORGANISATION —— 队友克隆节点之间的对等消息传递。
 *
 * 只有配置。目前还没有传输服务，所以在这里保存一个 key 不会启动任何东西；
 * 它只是将来服务一旦存在就会读取的设置。文案正是这样说的，而不是暗示已有连接。
 *
 * 与 Settings → Connections 一样基于 store 镜像渲染，并遵循同样的先镜像后
 * 持久化规则：输入 key 会更新镜像（这样 Settings 保持实时），并在 blur 时提交；
 * 开关和信任模式则当场持久化。
 */
export function OrgSection({ onSummary }: { onSummary?: (s: string) => void }) {
  const { t } = useTranslation();
  const cfg = useStore((s) => s.orgTrigger);
  const mirror = useStore((s) => s.setOrgTrigger);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    // 只在镜像看起来未播种时读取——无条件采纳可能会覆盖 Settings 里此刻
    // 正在输入的 key。
    if (useStore.getState().orgTrigger.apiKey) return;
    void getOrgTrigger().then((c) => {
      if (c && !useStore.getState().orgTrigger.apiKey) mirror(c);
    });
  }, [mirror]);

  useEffect(() => {
    onSummary?.(!cfg.apiKey.trim() ? t('orgSection.noKey') : cfg.enabled ? t('common.on') : t('common.off'));
  }, [cfg, onSummary, t]);

  const apply = (next: OrgTriggerConfig, persist = true) => {
    mirror(next);
    if (persist) persistOrgTrigger(next);
  };

  const hasKey = cfg.apiKey.trim().length > 0;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ flex: 1, fontSize: 12, color: 'var(--cth-ink-700)' }}>
          {t('orgSection.acceptMessages')}
        </span>
        <Toggle on={cfg.enabled} onClick={() => apply({ ...cfg, enabled: !cfg.enabled })} />
      </div>

      <Field label={t('orgSection.key')}>
        <SecretField
          value={cfg.apiKey}
          revealed={revealed}
          onReveal={() => setRevealed((r) => !r)}
          placeholder={t('orgSection.keyPlaceholder')}
          onChange={(apiKey) => apply({ ...cfg, apiKey }, false)}
          onBlur={() => apply(cfg)}
        />
        <Hint>{CLONE_NODE_BLURB}</Hint>
      </Field>

      <Field label={t('orgSection.trust')}>
        <ModePicker value={cfg.mode} onChange={(mode: TriggerMode) => apply({ ...cfg, mode })} />
      </Field>

      <Callout tone="note">
        {t('orgSection.settingsOnly')}
      </Callout>

      {cfg.enabled && !hasKey && (
        <Callout>{t('orgSection.noKeyWarning')}</Callout>
      )}
    </>
  );
}

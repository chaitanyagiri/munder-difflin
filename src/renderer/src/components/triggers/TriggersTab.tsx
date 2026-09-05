import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SchedulesSection } from './SchedulesSection';
import { ContextSection } from './ContextSection';
import { WebhooksSection } from './WebhooksSection';
import { OrgSection } from './OrgSection';
import { Muted, Scroll, TriggerCard } from './ui';

/**
 * TRIGGERS —— 无需人工输入就能唤醒地面的所有方式，集中在一个标签页里。
 * 四种类型（src/shared/triggers.ts 是契约）：schedules、context、webhooks 和
 * organisation。Schedules 最古老，过去就是这整个标签页。
 *
 * 这个面板是侧栏，所以四个扁平表单会像一面墙一样展开。每种类型是一个折叠的
 * 卡片，带着自己的名字、一行「这是什么」和一个实时摘要 chip；schedules 默认
 * 展开，因为它是老牌选手，而且办公室日历会深链接到这里。卡片内部，每一行以
 * 同样的方式折叠，所以任何东西最多隔两层就能看清。
 */
export function TriggersTab() {
  const { t } = useTranslation();
  const [schedulesSummary, setSchedulesSummary] = useState('');
  const [contextSummary, setContextSummary] = useState('');
  const [webhooksSummary, setWebhooksSummary] = useState('');
  const [orgSummary, setOrgSummary] = useState('');

  return (
    <Scroll>
      <Muted>{t('triggersTab.intro')}</Muted>
      <div style={{ height: 8 }} />

      <TriggerCard
        title={t('triggersTab.schedules')}
        blurb={t('triggersTab.schedulesBlurb')}
        summary={schedulesSummary}
        defaultOpen
      >
        <SchedulesSection onSummary={setSchedulesSummary} />
      </TriggerCard>

      <TriggerCard
        title={t('triggersTab.context')}
        blurb={t('triggersTab.contextBlurb')}
        summary={contextSummary}
      >
        <ContextSection onSummary={setContextSummary} />
      </TriggerCard>

      <TriggerCard
        title={t('triggersTab.webhooks')}
        blurb={t('triggersTab.webhooksBlurb')}
        summary={webhooksSummary}
      >
        <WebhooksSection onSummary={setWebhooksSummary} />
      </TriggerCard>

      <TriggerCard
        title={t('triggersTab.organisation')}
        blurb={t('triggersTab.organisationBlurb')}
        summary={orgSummary}
      >
        <OrgSection onSummary={setOrgSummary} />
      </TriggerCard>
    </Scroll>
  );
}

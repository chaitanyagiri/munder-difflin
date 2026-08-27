import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SchedulesSection } from './SchedulesSection';
import { ContextSection } from './ContextSection';
import { WebhooksSection } from './WebhooksSection';
import { OrgSection } from './OrgSection';
import { Muted, Scroll, TriggerCard } from './ui';

/**
 * TRIGGERS — every way the floor gets woken up without a human typing, in one
 * tab. Four types (src/shared/triggers.ts is the contract): schedules, context,
 * webhooks and organisation. Schedules is the oldest and used to BE this tab.
 *
 * This panel is a sidebar, so four flat forms would open as a wall. Each type is
 * a collapsed card carrying its name, a one-line "what this is", and a live
 * summary chip; schedules opens expanded because it is the incumbent and the
 * office calendar deep-links here. Inside a card, each row collapses the same
 * way, so nothing is more than two disclosures from legible.
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

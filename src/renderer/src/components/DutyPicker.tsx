import { type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { AGENT_DUTIES, normalizeDuty, type AgentDuty } from '@shared/agentDuty';

export interface DutyPickerProps {
  value: AgentDuty;
  onChange: (duty: AgentDuty) => void;
}

/**
 * The duty dropdown shared by Add Agent and Edit Agent.
 *
 * One component rather than two copies, because the duty set is the thing the
 * harness enforces: a picker that drifts from `AGENT_DUTIES` would offer a
 * value the gate does not recognise, and `normalizeDuty` would quietly file it
 * as `unassigned` — an agent the operator believes is a reviewer, that reviews
 * nothing. Options are rendered FROM the shared constant for the same reason.
 *
 * A native `<select>`, matching the status dropdown on the task detail. The
 * other choices in these dialogs are chip rows, but this one is a closed set of
 * four with a sentence of consequence each — a dropdown reads as "pick one",
 * where four chips read as tags you might combine.
 */
export function DutyPicker({ value, onChange }: DutyPickerProps) {
  const { t } = useTranslation();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <select
        value={value}
        onChange={(e) => onChange(normalizeDuty(e.target.value))}
        style={selectStyle}
      >
        {AGENT_DUTIES.map((duty) => (
          <option key={duty} value={duty}>{t(`duty.label.${duty}`)}</option>
        ))}
      </select>
      {/* The consequence of the choice, not a restatement of the label. A duty
          silently changes whether this agent may implement and whether its
          approval closes a card, and neither is guessable from one word. */}
      <span style={{ fontSize: 12, color: 'var(--cth-ink-500)', lineHeight: '16px' }}>
        {t(`duty.hint.${value}`)}
      </span>
    </div>
  );
}

// Same recipe as the status <select> on the task detail, so the two dropdowns
// in the app look like one control.
const selectStyle: CSSProperties = {
  width: '100%',
  padding: '6px 8px 4px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 14,
  color: 'var(--cth-ink-900)',
  cursor: 'pointer',
  outline: 'none',
  boxSizing: 'border-box'
};

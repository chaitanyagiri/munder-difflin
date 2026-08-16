import { useState } from 'react';
import { Icon } from './Icon';

interface ProjectAssignment {
  hire: string;
  project: string;
}

const PROJECTS: ProjectAssignment[] = [
  { hire: 'Jim', project: 'marketing-control-room' },
  { hire: 'Angela', project: '1SystematicReviewTools' },
  { hire: 'Dwight (new)', project: 'EvidenceTableBuilder' },
  { hire: 'Pam', project: 'study_screening_manual' },
  { hire: 'Oscar', project: 'ai-systematicreview' },
  { hire: 'Stanley', project: 'evidentia-systems' },
  { hire: 'Ryan', project: 'aiautomationx' },
  { hire: 'Kevin', project: 'SoftwareFactory' },
  { hire: 'Creed (new)', project: 'prospero-scrape-leads' }
];

export function ProjectNoticeboard() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      border: '1px solid var(--cth-ink-300)',
      boxShadow: 'inset 0 0 0 1px var(--cth-paper-100)'
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 16px',
        borderBottom: '1px solid var(--cth-ink-300)',
        backgroundColor: 'var(--cth-cream-100)',
        cursor: 'pointer',
        userSelect: 'none',
        flexShrink: 0
      }}
      onClick={() => setCollapsed(!collapsed)}
      >
        <div style={{
          fontFamily: 'var(--cth-font-display)',
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--cth-ink-900)',
          textTransform: 'uppercase',
          letterSpacing: '0.5px'
        }}>
          ASSIGNMENTS
        </div>
        <Icon 
          name={collapsed ? 'arrow-right' : 'code'} 
          size={0.8}
          style={{
            width: 14,
            height: 14,
            color: 'var(--cth-ink-500)',
            transition: 'transform 200ms ease'
          }}
        />
      </div>

      {!collapsed && (
        <div style={{
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          backgroundColor: 'var(--cth-paper-200)'
        }}>
          {PROJECTS.map((assignment, idx) => (
            <div
              key={idx}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                paddingBottom: 12,
                marginBottom: 12,
                borderBottom: idx < PROJECTS.length - 1 ? '1px solid var(--cth-ink-200)' : 'none',
                gap: 8
              }}
            >
              <div style={{
                fontFamily: 'var(--cth-font-display)',
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--cth-ink-900)',
                textTransform: 'uppercase',
                whiteSpace: 'nowrap'
              }}>
                {assignment.hire}
              </div>
              <div style={{
                fontFamily: 'var(--cth-font-ui)',
                fontSize: 12,
                color: 'var(--cth-ink-700)',
                wordBreak: 'break-word',
                textAlign: 'right',
                flex: 1,
                minWidth: 0
              }}>
                {assignment.project}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

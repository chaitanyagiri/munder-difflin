import React from 'react';
import { envKeyIssue } from '@shared/agentEnv';
import { PixelButton } from './PixelButton';

export type EnvRow = { key: string; value: string };

/** Rows → the env record a spawn wants; empty/blank-key rows are dropped.
 *  Returns undefined when nothing usable is set. */
export function rowsToEnv(rows: EnvRow[]): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  for (const r of rows) if (r.key.trim()) env[r.key.trim()] = r.value;
  return Object.keys(env).length ? env : undefined;
}

/** First problem across the rows (mirrors the main-process rules for instant
 *  feedback — main remains the enforcing boundary), or null when clean. */
export function envRowsIssue(rows: EnvRow[]): string | null {
  const seen = new Set<string>();
  for (const r of rows) {
    const key = r.key.trim();
    if (!key) continue;
    const issue = envKeyIssue(key);
    if (issue) return issue;
    if (seen.has(key)) return `duplicate env key "${key}"`;
    seen.add(key);
  }
  return null;
}

const cellStyle: React.CSSProperties = {
  padding: '5px 7px 3px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
  fontFamily: 'var(--cth-font-mono)',
  fontSize: 13,
  color: 'var(--cth-ink-900)',
  outline: 'none',
  minWidth: 0
};

/** KEY=VALUE row editor for per-agent env vars (#105). Dumb component: owns no
 *  state — parent holds the rows (Add Agent form state / Settings config). */
export function EnvVarsEditor({ rows, onChange }: {
  rows: EnvRow[];
  onChange: (rows: EnvRow[]) => void;
}) {
  const issue = envRowsIssue(rows);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            value={r.key}
            onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
            placeholder="CLAUDE_CONFIG_DIR"
            spellCheck={false}
            style={{ ...cellStyle, width: 200, flexShrink: 0 }}
          />
          <span style={{ color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-mono)', fontSize: 13 }}>=</span>
          <input
            value={r.value}
            onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
            placeholder="~/.claude-personal"
            spellCheck={false}
            style={{ ...cellStyle, flex: 1 }}
          />
          <PixelButton size="sm" variant="ghost" title="remove"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}>✕</PixelButton>
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <PixelButton size="sm" onClick={() => onChange([...rows, { key: '', value: '' }])}>
          + env var
        </PixelButton>
        {issue && (
          <span style={{ fontSize: 12, color: 'var(--cth-paprika-700, #b3502e)' }}>{issue}</span>
        )}
      </div>
    </div>
  );
}

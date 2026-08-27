import { DiffEditor } from '@monaco-editor/react';
import { useTranslation } from 'react-i18next';
import { setupMonaco, CTH_MONACO_THEME, languageForPath } from './monaco';

setupMonaco();

export interface MonacoDiffProps {
  /** File path — drives syntax language only. */
  path: string;
  /** Left side (committed HEAD content). */
  original: string;
  /** Right side (current working-tree content). */
  modified: string;
}

/** Read-only side-by-side diff (working tree vs HEAD) backed by Monaco's
 *  built-in DiffEditor — the same dependency as the editor, no extra view layer. */
export function MonacoDiff({ path, original, modified }: MonacoDiffProps) {
  const { t } = useTranslation();
  return (
    <DiffEditor
      theme={CTH_MONACO_THEME}
      language={languageForPath(path)}
      original={original}
      modified={modified}
      loading={<div style={{ padding: 12, color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-ui)' }}>{t('idePanel.loadingDiff')}</div>}
      options={{
        readOnly: true,
        renderSideBySide: true,
        fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
        fontSize: 12,
        lineHeight: 20,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        ignoreTrimWhitespace: false,
        renderOverviewRuler: false
      }}
    />
  );
}

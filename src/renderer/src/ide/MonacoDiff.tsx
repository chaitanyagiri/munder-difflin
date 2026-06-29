import { DiffEditor } from '@monaco-editor/react';
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
  return (
    <DiffEditor
      theme={CTH_MONACO_THEME}
      language={languageForPath(path)}
      original={original}
      modified={modified}
      loading={<div style={{ padding: 12, color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-ui)' }}>loading diff…</div>}
      options={{
        readOnly: true,
        renderSideBySide: true,
        fontFamily: 'VT323, "JetBrains Mono", monospace',
        fontSize: 15,
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

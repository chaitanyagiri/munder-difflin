import { DiffEditor } from '@monaco-editor/react';
import { setupMonaco, CTH_MONACO_THEME, languageForPath } from './monaco';

setupMonaco();

export interface MonacoDiffProps {
  /** 文件路径 —— 仅驱动语法高亮语言。 */
  path: string;
  /** 左侧（已提交的 HEAD 内容）。 */
  original: string;
  /** 右侧（当前工作树内容）。 */
  modified: string;
}

/** 只读并排 diff（工作树 vs HEAD），由 Monaco 内置的
 *  DiffEditor 驱动 —— 与编辑器相同的依赖，无额外视图层。 */
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

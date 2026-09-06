import { useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { setupMonaco, CTH_MONACO_THEME, languageForPath } from './monaco';

// 将 @monaco-editor/react 固定到打包的 monaco + 在模块加载时注册主题，
// 在任何 <Editor/> 挂载之前（避免 CDN 获取 / 无主题的首次绘制）。
setupMonaco();

export interface MonacoEditorProps {
  /** 文件路径 —— 仅驱动语法高亮语言。 */
  path: string;
  value: string;
  onChange: (value: string) => void;
  /** 编辑器获得焦点时 Cmd/Ctrl+S 触发。 */
  onSave?: () => void;
  readOnly?: boolean;
}

export function MonacoEditor({ path, value, onChange, onSave, readOnly }: MonacoEditorProps) {
  // 在 ref 中保存最新的 onSave，使得编辑器命令（挂载时绑定一次）
  // 始终调用当前处理器而无需重新绑定。
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const handleMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current?.();
    });
  };

  return (
    <Editor
      theme={CTH_MONACO_THEME}
      language={languageForPath(path)}
      value={value}
      onChange={(v) => onChange(v ?? '')}
      onMount={handleMount}
      loading={<div style={{ padding: 12, color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-ui)' }}>loading editor…</div>}
      options={{
        readOnly,
        fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
        fontSize: 12,
        lineHeight: 20,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        renderWhitespace: 'selection',
        tabSize: 2,
        wordWrap: 'off',
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        padding: { top: 8, bottom: 8 }
      }}
    />
  );
}

import { useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { setupMonaco, CTH_MONACO_THEME, languageForPath } from './monaco';

// Pin @monaco-editor/react to the bundled monaco + register themes at module load,
// before any <Editor/> mounts (avoids a CDN fetch / unthemed first paint).
setupMonaco();

export interface MonacoEditorProps {
  /** File path — drives syntax language only. */
  path: string;
  value: string;
  onChange: (value: string) => void;
  /** Invoked on Cmd/Ctrl+S while the editor has focus. */
  onSave?: () => void;
  readOnly?: boolean;
}

export function MonacoEditor({ path, value, onChange, onSave, readOnly }: MonacoEditorProps) {
  // Keep the latest onSave in a ref so the editor command (bound once at mount)
  // always calls the current handler without rebinding.
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
        fontFamily: 'VT323, "JetBrains Mono", monospace',
        fontSize: 15,
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

import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { json } from '@codemirror/lang-json';

/**
 * 用于 webhook schema 的小型 JSON 编辑器。与 IDE 用的是同一个 CodeMirror，
 * 为侧栏做了精简：没有行号、没有折叠沟槽、没有搜索栏——那些在这里会吃掉
 * 三分之一的宽度，而且对编辑二十行 schema 毫无帮助。颜色来自 `--cth-*`
 * tokens，所以它和其他东西一样跟随主题。
 */

const editorTheme = EditorView.theme({
  '&': {
    background: 'var(--cth-paper-100)',
    color: 'var(--cth-ink-900)',
    fontFamily: 'var(--cth-font-mono)',
    fontSize: '13px'
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': { padding: '6px 8px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--cth-coral)', borderLeftWidth: '2px' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '17px' },
  '.cm-gutters': { display: 'none' },
  '.cm-activeLine': { background: 'transparent' },
  '.cm-selectionBackground, ::selection': { background: 'var(--cth-lemon-light) !important' }
});

const editorSyntax = HighlightStyle.define([
  { tag: tags.propertyName, color: 'var(--cth-ink-700)' },
  { tag: tags.string, color: 'var(--cth-mint)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--cth-coral)' },
  { tag: tags.punctuation, color: 'var(--cth-ink-500)' }
]);

const extensions = [json(), EditorView.lineWrapping, editorTheme, syntaxHighlighting(editorSyntax)];

export function JsonEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)' }}>
      <CodeMirror
        value={value}
        onChange={onChange}
        height="180px"
        extensions={extensions}
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          autocompletion: false,
          searchKeymap: false,
          highlightSelectionMatches: false
        }}
      />
    </div>
  );
}

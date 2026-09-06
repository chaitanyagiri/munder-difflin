/**
 * Electron 渲染器的 Monaco 初始化（electron-vite / Vite）。
 *
 * 要让 Monaco 在打包的 Electron 应用中工作，必须满足两件事：
 *
 *  1. Worker 必须是自托管的，不能从 CDN 获取。我们通过 Vite 的
 *     `?worker` 后缀导入每种语言 worker，它生成一个真实的
 *     打包 worker chunk 和构造函数。`MonacoEnvironment.getWorker`
 *     为每种语言向 Monaco 提供对应的 worker。这是 electron-vite 安全的
 *     经典 `getWorkerUrl` CDN 方案等价物 —— 离线可用，且在
 *     打包的 `app.asar` 内部也能工作，因为 worker URL 在构建时由 Vite 解析
 *     （相对 `base: './'`）。
 *
 *  2. `@monaco-editor/react` 必须使用这个打包的 `monaco` 实例，而不是
 *     它默认通过 AMD 从 CDN 懒加载 monaco 的行为。我们用
 *     `loader.config({ monaco })` 将其固定。
 *
 * 在任何 editor 挂载之前，只导入此模块一次（利用其副作用）。
 */
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';

import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(self as any).MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new JsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker();
      case 'typescript':
      case 'javascript':
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  }
};

let themesDefined = false;

/** 注册 CTH 浅色/深色 Monaco 主题（幂等）。 */
function defineThemes(m: typeof monaco): void {
  if (themesDefined) return;
  themesDefined = true;
  m.editor.defineTheme('cth-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: '1A1320', background: 'FCFAF0' },
      { token: 'comment', foreground: '6B5878', fontStyle: 'italic' },
      { token: 'keyword', foreground: '8B5CF6' },
      { token: 'string', foreground: '3FA45B' },
      { token: 'number', foreground: 'D94F4F' },
      { token: 'type', foreground: '2A9D94' },
      { token: 'function', foreground: 'C2603A' },
      { token: 'variable', foreground: '1A1320' },
      { token: 'delimiter', foreground: '6B5878' }
    ],
    colors: {
      'editor.background': '#FCFAF0',
      'editor.foreground': '#1A1320',
      'editorLineNumber.foreground': '#A899B5',
      'editorLineNumber.activeForeground': '#3D2E4A',
      'editor.selectionBackground': '#FFEC99',
      'editor.lineHighlightBackground': '#FFF8E7',
      'editorCursor.foreground': '#FF6B6B',
      'editorGutter.background': '#F0EAD2',
      'editorWidget.background': '#FFF8E7',
      'editorIndentGuide.background1': '#E8D9A0',
      'diffEditor.insertedTextBackground': '#6BCF7F33',
      'diffEditor.removedTextBackground': '#FF6B6B33',
      'diffEditor.insertedLineBackground': '#6BCF7F22',
      'diffEditor.removedLineBackground': '#FF6B6B22'
    }
  });
}

let configured = false;

/** 将 @monaco-editor/react 固定到打包的 monaco + 注册主题。幂等。 */
export function setupMonaco(): typeof monaco {
  if (!configured) {
    configured = true;
    loader.config({ monaco });
  }
  defineThemes(monaco);
  return monaco;
}

export const CTH_MONACO_THEME = 'cth-light';

/** 将文件名映射为 Monaco language id（用于设置模型语言）。 */
export function languageForPath(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  switch (ext) {
    case 'ts': return 'typescript';
    case 'tsx': return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs': return 'javascript';
    case 'json': return 'json';
    case 'md':
    case 'markdown': return 'markdown';
    case 'py': return 'python';
    case 'rb': return 'ruby';
    case 'go': return 'go';
    case 'rs': return 'rust';
    case 'java': return 'java';
    case 'c':
    case 'h': return 'c';
    case 'cpp':
    case 'cc':
    case 'hpp': return 'cpp';
    case 'cs': return 'csharp';
    case 'php': return 'php';
    case 'sh':
    case 'bash':
    case 'zsh': return 'shell';
    case 'html':
    case 'htm': return 'html';
    case 'css': return 'css';
    case 'scss': return 'scss';
    case 'less': return 'less';
    case 'yml':
    case 'yaml': return 'yaml';
    case 'toml': return 'ini';
    case 'xml': return 'xml';
    case 'sql': return 'sql';
    case 'dockerfile': return 'dockerfile';
    default:
      if (name.toLowerCase() === 'dockerfile') return 'dockerfile';
      return 'plaintext';
  }
}

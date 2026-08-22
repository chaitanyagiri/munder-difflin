import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CodeEditor } from './CodeEditor';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';
import { useStore } from '@/store/store';

/**
 * Full-window overlay for one file. The absolute path is in store; root + rel
 * are derived by prefix-matching agent cwds (falling back to the file's parent
 * dir, so files outside any workspace still open).
 *
 * v0.3.4: markdown files get an edit | preview toggle (preview is the default
 * when opened from a terminal ⌘-click), plus an "open in IDE" escalation that
 * queues the path for IdePanel and opens it. Preview renders the SAVED file —
 * switch to edit to change it, save, and the preview picks it up on return.
 */
export function FullscreenFileEditor() {
  const { t } = useTranslation();
  const fullscreenFilePath = useStore(s => s.fullscreenFilePath);
  const view = useStore(s => s.fullscreenFileView);
  const setFullscreenFile = useStore(s => s.setFullscreenFile);
  const agents = useStore(s => s.agents);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setFullscreenFile(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setFullscreenFile]);

  if (!fullscreenFilePath) return null;

  // Find the agent cwd that's a prefix of this path. Falls back to using the
  // file's parent dir as the root so we can still read it.
  const matchedAgent = agents.find(a => fullscreenFilePath.startsWith(a.cwd + '/') || fullscreenFilePath === a.cwd);
  const root = matchedAgent?.cwd ?? fullscreenFilePath.replace(/\/[^/]+$/, '');
  const rel = matchedAgent
    ? fullscreenFilePath.slice(matchedAgent.cwd.length + 1)
    : fullscreenFilePath.split('/').pop() ?? fullscreenFilePath;

  const isMd = /\.(md|markdown)$/i.test(fullscreenFilePath);
  const mode: 'edit' | 'preview' = isMd ? view : 'edit';

  const copyPath = () => {
    navigator.clipboard.writeText(fullscreenFilePath).catch(() => { /* noop */ });
  };

  const openInIde = () => {
    const s = useStore.getState();
    s.setIdeInitialFile(fullscreenFilePath);
    s.setFullscreenFile(null);
    // The owning agent is already resolved above (it is how `root` was derived),
    // so hand it over instead of making the IDE re-guess from the selection —
    // this overlay is often reached from a terminal link with nothing selected.
    s.setIdeOpen(true, matchedAgent?.id ?? null);
  };

  const chip: React.CSSProperties = {
    padding: '2px 10px', height: 22, border: 'none', cursor: 'pointer',
    fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)',
    background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
    display: 'inline-flex', alignItems: 'center'
  };

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'var(--cth-cream-100)',
      zIndex: 280,
      display: 'flex', flexDirection: 'column',
      paddingTop: 36
    }}>
      <div
        className="cth-titlebar-drag"
        style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 36,
          background: 'linear-gradient(180deg, var(--cth-cream-100) 0%, var(--cth-cream-200) 100%)',
          borderBottom: '1px solid var(--cth-ink-300)',
          display: 'flex', alignItems: 'center',
          paddingLeft: 96, paddingRight: 12, gap: 12,
          userSelect: 'none',
          fontFamily: 'var(--cth-font-display)', fontSize: 12, lineHeight: '20px',
          color: 'var(--cth-ink-900)'
        }}
      >
        MUNDER DIFFLIN · {t('fileEditor.file')}
        <span
          className="cth-titlebar-nodrag"
          style={{
            fontFamily: 'var(--cth-font-mono)', fontSize: 13, color: 'var(--cth-ink-500)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '38vw'
          }}
          title={fullscreenFilePath}
        >{rel}</span>
        <span className="cth-titlebar-nodrag" style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          {isMd && (
            <span style={{ display: 'inline-flex' }}>
              {(['edit', 'preview'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setFullscreenFile(fullscreenFilePath, v)}
                  title={v === 'edit' ? t('fileEditor.editTitle') : t('fileEditor.previewTitle')}
                  style={{
                    ...chip,
                    background: mode === v ? 'var(--cth-sky-light)' : 'var(--cth-cream-100)',
                    boxShadow: mode === v ? 'inset 0 0 0 1px var(--cth-ink-500)' : 'inset 0 0 0 1px var(--cth-ink-100)'
                  }}
                >{v === 'edit' ? t('fileEditor.edit') : t('fileEditor.preview')}</button>
              ))}
            </span>
          )}
          <button onClick={openInIde} title={t('fileEditor.openInIdeTitle')} style={chip}>{t('fileEditor.openInIde')}</button>
          <button onClick={() => setFullscreenFile(null)} title={t('fileEditor.closeTitle')} style={chip}>✕</button>
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: mode === 'preview' ? 'auto' : 'hidden' }}>
        {mode === 'preview' ? (
          <SavedFilePreview root={root} rel={rel} />
        ) : (
          <CodeEditor
            root={root}
            filePath={rel}
            fullscreen
            onToggleFullscreen={() => setFullscreenFile(null)}
            onCopyPath={copyPath}
          />
        )}
      </div>
    </div>
  );
}

/** Reads the saved file and renders it as markdown. Untrusted input is fine —
 *  MarkdownPreview has no HTML sink. */
function SavedFilePreview({ root, rel }: { root: string; rel: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; content: string; error?: string }>({
    status: 'loading', content: ''
  });
  useEffect(() => {
    let alive = true;
    setState({ status: 'loading', content: '' });
    window.cth.readFile(root, rel).then((res) => {
      if (!alive) return;
      setState(res.ok
        ? { status: 'ready', content: res.content }
        : { status: 'error', content: '', error: res.error });
    });
    return () => { alive = false; };
  }, [root, rel]);

  if (state.status === 'loading') {
    return <div style={{ padding: 24, fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)' }}>{t('fileTree.loading')}</div>;
  }
  if (state.status === 'error') {
    return <div style={{ padding: 24, fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-coral)' }}>{state.error}</div>;
  }
  return (
    <div style={{ display: 'flex', justifyContent: 'center' }}>
      {/* `root` is what lets screenshots referenced by the report actually
          render — it is the same root this component already reads through, so
          images are confined to exactly the tree the text came from. */}
      <MarkdownPreview source={state.content} baseRel={rel} root={root} />
    </div>
  );
}

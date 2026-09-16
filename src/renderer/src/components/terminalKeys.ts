/**
 * Modifier-key encoding for the embedded terminal.
 *
 * xterm.js encodes Shift+Enter exactly like Enter — a bare CR — so a TUI cannot
 * tell the two apart, and Shift+Enter at a prompt submits instead of opening a
 * new line (#481). Terminals that get this right send a distinct sequence, and
 * the one Claude Code's `/terminal-setup` installs for iTerm2 and VS Code is
 * ESC CR. Nothing configures that for our pane, so it has to be sent here.
 *
 * Kept structural and free of imports — no xterm, no window — so the mapping is
 * unit-testable on its own, the same way askMeOrder.ts and queueDelivery.ts are.
 * The caller supplies the fields it reads from a KeyboardEvent.
 */

/** ESC CR — "insert a newline, do not submit". Provider-neutral: it is the
 *  convention `/terminal-setup` writes for Claude Code, and the same sequence
 *  Alt+Enter has always produced, so any TUI that honours one honours the other. */
export const NEWLINE_SEQUENCE = '\x1b\r';

/** The fields this needs from a KeyboardEvent. */
export interface TerminalKey {
  type: string;
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/**
 * The bytes to send for a key the terminal would otherwise encode wrongly, or
 * null to let xterm handle it as usual.
 *
 * Deliberately narrow. Only Shift+Enter is claimed, and only when it is the ONLY
 * modifier held:
 *   - plain Enter still submits, which is the whole point of the prompt;
 *   - Alt+Enter already produces this sequence natively, so intercepting it
 *     would be a no-op at best and a double-encode at worst;
 *   - Ctrl+Enter and Cmd+Enter belong to the TUI (and to the app's own
 *     shortcuts), so they are left alone rather than quietly redefined.
 *
 * keydown only: xterm's custom-key hook also sees keypress and keyup, and
 * answering on more than one of them would insert the newline two or three times.
 */
export function terminalKeySequence(ev: TerminalKey): string | null {
  if (ev.type !== 'keydown') return null;
  if (ev.key !== 'Enter') return null;
  if (!ev.shiftKey) return null;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return null;
  return NEWLINE_SEQUENCE;
}

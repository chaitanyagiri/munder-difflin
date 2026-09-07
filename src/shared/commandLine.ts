/** Split a command string into argv, respecting double/single quotes so a model
 *  value with spaces (agy's `--model "Gemini 3.1 Pro (High)"`) stays one token.
 *  Quotes are stripped from the result.
 *
 *  Shared because BOTH sides split command lines: the renderer's spawn flows
 *  (AddAgentModal, restore, command center) and main's god-hired-worker path
 *  (processSpawnRequest). They used to carry byte-identical copies, which is an
 *  invitation for the two to drift — and a worker whose command line splits
 *  differently from the renderer's is exactly the class of silent breakage the
 *  spawn-request fix exists to prevent. */
export function tokenizeCommand(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** The inverse of the model→command splice (config.ts's buildSpawnCommand):
 *  given a modelFlag (a provider preset's `--model`, or undefined for a
 *  provider with no model flag at all) and a — possibly hand-edited — command
 *  line, pull the value that follows that flag back out.
 *
 *  The command field is deliberately editable "for power users" (AddAgentModal)
 *  and its comment already calls it "the source of truth for the actual
 *  spawn" — but until now that was one-directional: picking a model preset
 *  wrote it INTO the command, while typing over the command's `--model` value
 *  left the picker's separate `model` state pointing at whichever preset was
 *  clicked last. A saved agent persists both fields, so that drift didn't just
 *  mis-highlight a button — EditAgentModal seeds its own `model` state from the
 *  saved (stale) value and rebuilds the command from it on save, silently
 *  reverting a manually-typed model back to the last-clicked preset.
 *  Re-deriving the model from the command everywhere it matters closes the
 *  loop: the command decides, the picker just reflects it.
 *
 *  Returns undefined when there's no model flag (custom/no-model providers) or
 *  the flag isn't present in the command (e.g. bare `codex`, no explicit
 *  model) — callers treat that as "no preset active", i.e. CLI default. */
export function parseModelFromCommand(command: string, modelFlag: string | undefined): string | undefined {
  if (!modelFlag) return undefined;
  const tokens = tokenizeCommand(command);
  const i = tokens.indexOf(modelFlag);
  return i >= 0 && i + 1 < tokens.length ? tokens[i + 1] : undefined;
}

/** What a human typed into a "model id" field, read as a model id.
 *
 *  Pasting a WHOLE command line in there is the predictable mistake — the app
 *  asks for a full command in the Add/Edit Agent dialog two clicks away, and
 *  the string people have on their clipboard is usually the one that already
 *  works in a terminal. Taken literally that becomes
 *  `--model "claude --model x --permission-mode …"`, which is not a model and
 *  fails somewhere far from the field that caused it.
 *
 *  So: if the text carries this provider's model flag, read the model out of
 *  it; otherwise it IS the model. Deliberately not "reject anything with a
 *  space" — agy model ids legitimately contain them ("Gemini 3.1 Pro (High)").
 *  Empty / whitespace-only input returns undefined so callers can no-op. */
export function modelIdFromInput(raw: string, modelFlag: string | undefined): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  if (modelFlag && text.includes(modelFlag)) {
    return parseModelFromCommand(text, modelFlag) ?? text;
  }
  return text;
}

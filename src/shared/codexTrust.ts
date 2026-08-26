/** Codex gates every working directory behind an interactive "do you trust this
 *  directory?" prompt, and the answer is persisted per config home as a
 *  `[projects."<dir>"]` table with `trust_level = "trusted"`. An agent that gets
 *  its own isolated CODEX_HOME therefore starts with a virgin config and hits
 *  that prompt on its first turn — with nobody at the keyboard it simply stalls.
 *
 *  Pre-seeding the same table is the only way out: no flag or environment
 *  variable skips the prompt (notably NOT
 *  `--dangerously-bypass-approvals-and-sandbox`, which governs command approval,
 *  not directory trust), and a `-c projects…` override is not persisted so it
 *  does not count as an answer either. */

/** Render a string as a TOML basic string, quotes included.
 *
 *  A directory name may legally contain a quote or a backslash on POSIX, and
 *  interpolating one straight into `[projects."…"]` produces a config file Codex
 *  cannot parse — which is worse than the prompt it was meant to remove. */
export function tomlBasicString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0) as number;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\r') out += '\\r';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

/** The config.toml fragment that marks `dir` as already trusted.
 *
 *  `dir` must be canonical (realpath-resolved): Codex resolves the directory
 *  before looking it up, so an entry keyed by an unresolved spelling — `/tmp/x`
 *  where the kernel says `/private/tmp/x` — never matches and the prompt returns. */
export function codexTrustEntry(dir: string): string {
  return `\n[projects.${tomlBasicString(dir)}]\ntrust_level = "trusted"\n`;
}

/**
 * i18n-scan — find user-visible English text that never reaches a locale file.
 *
 * `en.json` holds 1203 strings, but only 48 of the renderer's 138 files ever
 * call `t()`. The rest render their labels as literals, which no translation
 * can touch: someone running the app in Arabic or Chinese still reads English
 * buttons around translated prose. This tool finds those literals so they can
 * be extracted into keys.
 *
 * ── Why an AST and not a grep ──────────────────────────────────────────────
 * A regex pass over the same tree reported 44 hits in `src/shared/releaseDrop.ts`,
 * a file with no UI text at all — every one of them prose inside a block
 * comment or a token in a CSP string. A parser does not see comments, does not
 * see import paths, and knows a JSX attribute from an object key, so what it
 * reports is worth reading. Nothing here needs a type checker: each file is
 * parsed on its own, so the scan runs in about a second with no build.
 *
 * ── What counts as user-visible ────────────────────────────────────────────
 *   - JSX text:        <button>Save changes</button>
 *   - UI attributes:   title / placeholder / aria-label / label / alt / tooltip
 *   - Alert-ish calls: toast(...), dialog.showMessageBox({ message }), Notification
 * Everything else is assumed technical until someone proves otherwise. The
 * `looksTranslatable` heuristic below is deliberately conservative: a false
 * negative costs one missed string that a human can still spot, a false
 * positive spent on every identifier and file path would bury the report and
 * get the tool ignored.
 *
 * Usage:
 *   node tools/i18n-scan.cjs            # human summary
 *   node tools/i18n-scan.cjs --json     # machine-readable findings
 *   node tools/i18n-scan.cjs --allowlist tools/i18n-allowlist.json
 */
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

/** Attributes whose string value is read aloud or shown to a person. */
const UI_ATTRS = new Set(['title', 'placeholder', 'aria-label', 'label', 'alt', 'tooltip', 'data-tip']);
// `data-tip` is this app's own tooltip: `.cth-tip` renders it with CSS, so it
// is shown text exactly like `title`, just not a standard attribute.

/** Call expressions whose string arguments end up on screen. */
const UI_CALLS = /(^|\.)(toast|notify|showMessageBox|showErrorBox|setToolTip|alert|confirm)$/i;

/** Object keys that carry shown text when handed to Electron, a toast or a card. */
const UI_KEYS = new Set([
  'message', 'detail', 'title', 'body', 'label', 'buttonLabel', 'sublabel',
  'blurb', 'hint', 'caption', 'subtitle', 'heading', 'placeholder'
]);
/** Compound keys that end like a UI key (secretLabel, secretHelp, emptyHint)
 *  carry shown text just the same — src/shared/integrations.ts alone holds 18
 *  such strings that an exact-key set never sees. */
const UI_KEY_SUFFIX = /[a-z](Label|Help|Hint|Title|Placeholder|Tooltip|Caption|Subtitle|Heading)$/;

// `description` is deliberately NOT in that set. In this codebase it is
// overwhelmingly the description field of an LLM function-tool schema
// (src/renderer/src/realtime/actions.ts alone holds 63 of them). That text is
// written FOR a model, not for a person — translating it would change what the
// model does, which is the opposite of a translation's job.

/**
 * Is this literal plausibly a sentence or label a person reads, rather than a
 * key, path, class name or command?
 *
 * The rules are ordered cheapest-first and every one of them exists because
 * something real tripped it: `src/main/index.ts` is a path, `agent.hired` is
 * an event name, `px-2 py-1` is Tailwind, `#1a1a1a` is a colour.
 */
function looksTranslatable(raw, { allowBareWord = false, allowCaps = false } = {}) {
  const s = raw.trim();
  if (s.length < 3 || s.length > 200) return false;
  if (!/[A-Za-z]/.test(s)) return false;
  // SCREAMING_CASE and acronym-only tokens are identifiers — except in a UI
  // position, where this app sets its pixel-font headers in capitals: JSX text
  // ("NO AGENT SELECTED") and panel titles (title="SELECT A HARNESS CONFIG").
  // Two or more capitalised words there is a heading, not a constant; a lone
  // `OK` or `PTY` still stays out.
  if (!/[a-z]/.test(s) && !(allowCaps && /[A-Z]{2,}\s+[A-Z]{2,}/.test(s))) return false;
  if (/^[#$@]/.test(s)) return false; // colours, shell vars, decorators
  if (/^(https?:|file:|data:|\/|\.\/|\.\.\/|~\/)/.test(s)) return false; // URLs and paths
  if (/\.(ts|tsx|js|cjs|mjs|json|css|png|svg|webp|md|html)$/i.test(s)) return false;
  if (/^[a-z0-9]+([.:_-][a-z0-9]+)+$/i.test(s) && !/\s/.test(s)) return false; // dotted ids, kebab keys
  if (/^[a-z]+([A-Z][a-z0-9]*)+$/.test(s)) return false; // camelCase identifier
  // A Tailwind-ish class soup: several space-separated tokens, none capitalised,
  // most carrying a dash or colon. Real prose has capitals or plain words.
  if (/\s/.test(s) && !/[A-Z]/.test(s)) {
    const parts = s.split(/\s+/);
    const classy = parts.filter((p) => /[-:]/.test(p) || /^\d/.test(p)).length;
    if (parts.length > 1 && classy >= parts.length / 2) return false;
  }
  // Single lowercase word with no space: almost always an identifier or enum —
  // except under a known UI key, where `label: 'strict'` sits in the same array
  // as `label: 'allow all'` and is just as visible. Only that position earns the
  // exception; a bare word anywhere else stays out.
  if (!/\s/.test(s) && !/^[A-Z]/.test(s) && !allowBareWord) return false;
  return true;
}

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'out' || entry.name === 'dist') continue;
      walkFiles(p, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * The literal text of a string or template, with each `${…}` shown as `{…}`;
 * null for anything else. Only the literal parts decide translatability, so a
 * template that is nothing but interpolations (`${a}${b}`) reads as empty.
 */
function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((s) => '{…}' + s.literal.text).join('');
  }
  return null;
}

/**
 * Is this node already translated? Inside a `t(...)` call it is a key; inside
 * `<Trans i18nKey="…">` it is only the fallback react-i18next renders when the
 * key is missing — the key's value is what users actually see.
 */
function insideTranslationCall(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isCallExpression(n)) {
      const fn = n.expression;
      const name = ts.isIdentifier(fn) ? fn.text : ts.isPropertyAccessExpression(fn) ? fn.name.text : '';
      if (name === 't' || name === 'tx' || name === 'tr') return true;
    }
    if (ts.isJsxElement(n) && n.openingElement.tagName.getText() === 'Trans') {
      const hasKey = n.openingElement.attributes.properties.some(
        (a) => ts.isJsxAttribute(a) && a.name.getText() === 'i18nKey'
      );
      if (hasKey) return true;
    }
  }
  return false;
}

function scanFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const usesI18n = /useTranslation|i18n\.t\(/.test(text);
  const findings = [];

  const at = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const add = (node, value, kind, opts) => {
    if (!looksTranslatable(value, opts)) return;
    if (insideTranslationCall(node)) return;
    findings.push({ file: rel, line: at(node), text: value.trim(), kind, usesI18n });
  };

  const visit = (node) => {
    if (ts.isJsxText(node)) {
      add(node, node.text, 'jsx-text', { allowCaps: true });
    } else if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sf);
      // title="…" and title={`…`} / title={`Edit ${name}: …`} are the same
      // on screen; the template form is how a tooltip gets a name into it.
      const init = ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer;
      const text = init && literalText(init);
      if (UI_ATTRS.has(name) && text !== null && text !== undefined) {
        add(init, text, `attr:${name}`, { allowCaps: true });
      }
    } else if (ts.isCallExpression(node)) {
      const fn = node.expression;
      const name = ts.isIdentifier(fn) ? fn.text : ts.isPropertyAccessExpression(fn) ? fn.getText(sf) : '';
      if (UI_CALLS.test(name)) {
        for (const arg of node.arguments) {
          if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
            add(arg, arg.text, 'call-arg');
          }
        }
      }
    } else if (ts.isPropertyAssignment(node)) {
      const key = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : '';
      const v = node.initializer;
      const text = literalText(v);
      if ((UI_KEYS.has(key) || UI_KEY_SUFFIX.test(key)) && text !== null) {
        add(v, text, `prop:${key}`, { allowBareWord: true, allowCaps: true });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

function loadAllowlist(p) {
  if (!p || !fs.existsSync(p)) return { allow: new Set(), ignoreFiles: [] };
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  const entries = Array.isArray(data) ? data : data.allow || [];
  return {
    allow: new Set(entries.map((e) => (typeof e === 'string' ? e : e.text))),
    ignoreFiles: Array.isArray(data) ? [] : data.ignoreFiles || []
  };
}

function scan({ allowlist } = {}) {
  const { allow, ignoreFiles } = loadAllowlist(allowlist);
  const all = [];
  for (const f of walkFiles(SRC)) all.push(...scanFile(f));
  return all.filter((f) => !allow.has(f.text) && !ignoreFiles.some((p) => f.file.startsWith(p)));
}

module.exports = { scan, looksTranslatable };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const allowIdx = argv.indexOf('--allowlist');
  const findings = scan({ allowlist: allowIdx >= 0 ? argv[allowIdx + 1] : undefined });

  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(findings, null, 2));
    process.exit(0);
  }

  const byFile = new Map();
  for (const f of findings) byFile.set(f.file, (byFile.get(f.file) || 0) + 1);
  const area = (f) => (f.startsWith('src/main') ? 'main' : f.startsWith('src/renderer') ? 'renderer' : 'other');
  const byArea = {};
  const byKind = {};
  for (const f of findings) {
    byArea[area(f.file)] = (byArea[area(f.file)] || 0) + 1;
    byKind[f.kind.split(':')[0]] = (byKind[f.kind.split(':')[0]] || 0) + 1;
  }

  console.log(`untranslated user-visible strings: ${findings.length} in ${byFile.size} file(s)`);
  console.log('by area:', byArea);
  console.log('by kind:', byKind);
  console.log('\nfile                                                        count  i18n');
  const usesI18nByFile = new Map(findings.map((f) => [f.file, f.usesI18n]));
  for (const [file, n] of [...byFile].sort((a, b) => b[1] - a[1])) {
    console.log(`${file.padEnd(58)} ${String(n).padStart(5)}  ${usesI18nByFile.get(file) ? 'yes' : 'no'}`);
  }
}

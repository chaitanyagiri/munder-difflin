# SDD-i18n: UI Localization Contract

How the MunderDifflin UI ships in more than one language, and what a new
locale must do to land. This is the contributor-facing copy of
`openspec/changes/add-spanish-i18n/design.md` — the design is the source of
truth for rationale; this file is the contract for day-to-day work.

## Dictionaries

- Location: `src/renderer/src/i18n/locales/` — one JSON file per language code.
- `en.json` is the source of truth. Every other locale (`zh-CN.json`,
  `ar.json`, `es.json`) MUST carry exactly the same leaf-key tree: no missing
  keys (they would silently fall back to English), no extra keys (dead strings).
- Register: usted-neutral formal Spanish for `es`; no `tú` forms.
- Translation correctness is explicitly UNREVIEWED for agent-written locales
  (`ar` precedent, now `es` too). Tests prove coverage and shape, never wording.

## Injection (`src/renderer/src/i18n/index.ts`)

Adding a language is five lines at four anchors — nothing else moves:

1. `import es from './locales/es.json';` (next to the `en`/`zh-CN`/`ar` imports)
2. `LANGUAGES += { code: 'es', label: 'Español', dir: 'ltr' }` (display order
   is the picker order)
3. `resources.es = { translation: es }` (bundled inline, no suspense)
4. `supportedLngs += 'es'`

Untouched: `SUPPORTED` (derived from `LANGUAGES`), `fallbackLng: 'en'`,
`defaultVariables: { godName }`, `detectLanguage` (reads only
`localStorage['cth.language']` — never `navigator`), `setLanguage`,
`setGodName`, `useDirectionSync`, `useGodNameSync`.

Give the entry `dir: 'rtl'` only for a right-to-left script. `RTL_CODES` is
derived from `LANGUAGES`, so direction support follows the declaration.

## Selector (`SettingsModal.tsx`)

Settings → General renders the picker by mapping `LANGUAGES` — no per-locale
component change. `SettingsHeroCard` is display-only (`t()` calls, no picker).

## Fonts / CSP / RTL inertness

- Spanish is LTR Latin: no token-stack change, no `<link>`, no `font-src`
  change, no `[dir="rtl"]` rule, no terminal-pin change.
- `directionFor('es') === 'ltr'`, `isRtlLanguage('es') === false`; every RTL
  branch takes its pre-existing path.
- `index.html` keeps `font-src 'self'`; `tokens.css` keeps bundled stacks only.

## Parity rules (enforced by `test/spanish-ui.test.cjs` + `test/i18n-god-name.test.cjs`)

- Leaf-key set of `es.json` ≡ leaf-key set of `en.json`.
- No empty values, no placeholder stubs.
- No English left behind: any `es` string still identical to `en` fails,
  except the `SAME_ON_PURPOSE` allowlist (proper nouns, literal user-typed
  paths, pure `{{var}}` format strings). The allowlist must not rot: entries
  that become translated must be dropped from it.
- Every `{{var}}` set, markup-tag multiset (`<strong>` etc.), and indexed
  array length must equal `en` per key. Arrays are indexed scenes — a short
  array is an out-of-range read.
- No locale hardcodes the orchestrator name ("Michael"); strings about it use
  `{{godName}}` (supplied as an i18next default variable). Per-agent strings
  use `{{name}}`, never `{{godName}}`.
- English stays the default and the fallback; the app never auto-detects the
  OS locale.

## Scope note (post-design additions on `feat/add-spanish-i18n`)

The design (`openspec/changes/add-spanish-i18n/design.md`) covered the base
locale; the branch grew past it. Post-design additions, all under the same
parity rules above:

- Onboarding language picker (`e44c108b`) + onboarding copy (`e2d7348f`).
- Full Spanish rewrite, 7 commits (`1d06e980`, `5031b413`, `7586d2e7`,
  `75e18528`, `7f1874ed`, `25e31c07`, `85246ff5`): usted-neutral register,
  natural copy per area.
- Orchestrator command field (`a1a2efed`).
- Connections setup, 4 commits (`1693cb82`, `688804c2`, `22c6c112`,
  `4b2de64f`): MCP servers, Slack, Webhook API, org-key clone-node.
- Restart hive picker (`bdb15158`): `hivePicker.*` keys in all four locales.
- Finale: `desencadenador*` → `activador*` rename in `es` values only.

## Integration strategy

1. Add the key to `en.json`.
2. Mirror it into `es.json`, `zh-CN.json` and `ar.json` (same tree position,
   same `{{vars}}`, same tags, same array length).
3. Run `npm run test:focused` (parity + placeholder + markup gates) and
   `npm run typecheck`.
4. Rollback is reverse order: docs → locale + registration → tests. Deleting
   `es.json` plus its five registration lines restores the picker; `en`
   fallback is untouched.

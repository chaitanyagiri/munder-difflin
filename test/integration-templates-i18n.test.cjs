/**
 * Every integration template needs its credential copy in en.json.
 *
 * IntegrationsRegistry looks up integrations.templates.<id>.secretLabel and
 * .secretHelp for each template in src/shared/integrations.ts. A template
 * added without those keys does not fail anywhere — i18next quietly renders
 * the key path ("integrations.templates.slack.secretHelp") in the form. Source
 * read, because the template list is plain data.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const src = readFileSync(join(root, 'src/shared/integrations.ts'), 'utf8');
const templates = JSON.parse(readFileSync(join(root, 'src/renderer/src/i18n/locales/en.json'), 'utf8'))
  .integrations.templates;

// Same rule as templateSecret() in IntegrationsRegistry.tsx.
const ids = [...src.matchAll(/kind:\s*'([^']+)'[\s\S]*?idSuggestion:\s*'([^']+)'/g)]
  .map(([, kind, id]) => (id === 'my-api' ? kind : id));

test('the template list was actually found', () => {
  assert.ok(ids.length >= 9, `only ${ids.length} templates parsed — the regex no longer matches the file`);
});

test('every integration template has translated credential copy', () => {
  const missing = ids.filter((id) => !templates[id]?.secretLabel || !templates[id]?.secretHelp);
  assert.deepEqual(missing, []);
});

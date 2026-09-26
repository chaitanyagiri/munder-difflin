'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { parseSummary } = loadTs('src/main/reflect.ts');

const CONDENSED = '<<<CONDENSED>>>';
const HOIST = '<<<HOIST>>>';
const END = '<<<END>>>';

function frame(condensed, hoist = []) {
  return [
    CONDENSED,
    condensed,
    HOIST,
    ...hoist.map((fact) => `- ${fact}`),
    END
  ].join('\n');
}

test('parses the framed summary contract', () => {
  assert.deepEqual(parseSummary(frame('A bounded summary.', ['fact one', 'fact two'])), {
    condensed: 'A bounded summary.',
    hoist: ['fact one', 'fact two']
  });
  assert.deepEqual(parseSummary(frame('No durable facts.')), {
    condensed: 'No durable facts.',
    hoist: []
  });
});

test('framed condensed text is literal and does not depend on JSON escaping', () => {
  const condensed = [
    'Mode is "plan" and the repo is C:\\D\\ai-agent\\src\\main.',
    'Use `npm run build` and preserve config = {"mode":"safe"}.',
    'A truncated JSON fragment is still memory content: {"foo": "bar"',
    '```ts',
    'const path = "C:\\\\work\\\\repo";',
    '```'
  ].join('\n');

  assert.deepEqual(parseSummary(frame(condensed, ['Preserve quoted Windows paths'])), {
    condensed,
    hoist: ['Preserve quoted Windows paths']
  });
});

test('normalizes framed CRLF and accepts CLI result or text envelopes', () => {
  const output = frame('line one\nline two', ['durable']);
  const expected = { condensed: 'line one\nline two', hoist: ['durable'] };

  assert.deepEqual(parseSummary(output.replace(/\n/g, '\r\n')), expected);
  assert.deepEqual(parseSummary(JSON.stringify({ result: output })), expected);
  assert.deepEqual(parseSummary(JSON.stringify({ text: output })), expected);
});

test('accepts an optional complete outer code fence without stripping inner fences', () => {
  const condensed = ['Keep this example:', '```json', '{"ok": true}', '```'].join('\n');
  const output = frame(condensed);
  const expected = { condensed, hoist: [] };

  for (const tag of ['', 'text', 'json']) {
    assert.deepEqual(parseSummary(`\`\`\`${tag}\n${output}\n\`\`\``), expected);
  }
});

test('rejects partial, duplicated, out-of-order, or contaminated frames', () => {
  const invalid = [
    `summary\n${HOIST}\n${END}`,
    `${CONDENSED}\nsummary\n${END}`,
    `${CONDENSED}\nsummary\n${HOIST}`,
    `${CONDENSED}\nsummary\n${CONDENSED}\n${HOIST}\n${END}`,
    `${CONDENSED}\nsummary\n${HOIST}\n${HOIST}\n${END}`,
    `${CONDENSED}\nsummary\n${HOIST}\n${END}\n${END}`,
    `${HOIST}\n${CONDENSED}\nsummary\n${END}`,
    `Here is the summary:\n${frame('summary')}`,
    `${frame('summary')}\nHope this helps.`,
    `${CONDENSED}\n \n${HOIST}\n${END}`,
    `${CONDENSED}\nsummary\n${HOIST}\nnot a bullet\n${END}`,
    `${CONDENSED}\nsummary\n${HOIST}\n- \n${END}`,
    `\`\`\`text\n${frame('summary')}`
  ];

  for (const output of invalid) {
    assert.doesNotThrow(() => parseSummary(output));
    assert.equal(parseSummary(output), null, output);
  }
});

test('preserves valid legacy JSON and its existing hoist filtering', () => {
  const legacy = { condensed: 'legacy summary', hoist: ['fact', 42, null] };
  const expected = { condensed: 'legacy summary', hoist: ['fact'] };

  assert.deepEqual(parseSummary(JSON.stringify(legacy)), expected);
  assert.deepEqual(parseSummary(JSON.stringify({ result: JSON.stringify(legacy) })), expected);
  assert.deepEqual(parseSummary(`\`\`\`json\n${JSON.stringify(legacy)}\n\`\`\``), expected);
  assert.deepEqual(parseSummary(JSON.stringify({ condensed: 'legacy summary' })), {
    condensed: 'legacy summary',
    hoist: []
  });
});

test('malformed legacy JSON and garbage remain fail-closed', () => {
  const invalid = [
    '',
    'random text',
    '{{{{',
    '{"condensed":"unfinished","hoist":[]',
    String.raw`{"condensed":"C:\work","hoist":[]}`,
    '{"condensed":"line one\nline two","hoist":[]}',
    '{"hoist":[]}',
    '{"condensed":"   ","hoist":[]}'
  ];

  for (const output of invalid) {
    assert.doesNotThrow(() => parseSummary(output));
    assert.equal(parseSummary(output), null, output);
  }
});

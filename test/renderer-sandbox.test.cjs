'use strict';

/**
 * Pins the Electron renderer boundary on every application-created window.
 *
 * The desktop can run inside a hardened container while its web renderer is
 * still unsandboxed: Electron turns `webPreferences.sandbox: false` into an
 * effective renderer `--no-sandbox` switch. Parse the TypeScript AST so comments,
 * unrelated objects, or string markers cannot satisfy this security contract.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const sourcePath = path.join(__dirname, '..', 'src', 'main', 'index.ts');

function property(object, name) {
  return object.properties.find((entry) => (
    ts.isPropertyAssignment(entry)
    && ((ts.isIdentifier(entry.name) && entry.name.text === name)
      || (ts.isStringLiteral(entry.name) && entry.name.text === name))
  ));
}

function browserWindowOptions() {
  const text = fs.readFileSync(sourcePath, 'utf8');
  const source = ts.createSourceFile(sourcePath, text, ts.ScriptTarget.Latest, true);
  const windows = [];

  function visit(node) {
    if (
      ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'BrowserWindow'
    ) {
      windows.push(node.arguments?.[0]);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return windows;
}

test('every BrowserWindow explicitly enables the Chromium renderer sandbox', () => {
  const windows = browserWindowOptions();
  assert.ok(windows.length > 0, 'no BrowserWindow construction found');

  for (const options of windows) {
    assert.ok(options && ts.isObjectLiteralExpression(options), 'BrowserWindow options must be literal');
    const webPreferences = property(options, 'webPreferences');
    assert.ok(
      webPreferences && ts.isObjectLiteralExpression(webPreferences.initializer),
      'BrowserWindow webPreferences must be literal'
    );
    const sandbox = property(webPreferences.initializer, 'sandbox');
    assert.ok(sandbox, 'BrowserWindow must declare sandbox explicitly');
    assert.equal(sandbox.initializer.kind, ts.SyntaxKind.TrueKeyword);
  }
});

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const cache = new Map();

function resolveTs(fromDir, request) {
  const base = request.startsWith('@shared/')
    ? path.resolve(__dirname, '..', 'src/shared', request.slice('@shared/'.length))
    : path.resolve(fromDir, request);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function loadFile(filename) {
  const cached = cache.get(filename);
  if (cached) return cached.exports;
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true,
      // Match tsconfig.node/tsconfig.web. Without it a default import of a CJS
      // builtin (`import path from 'node:path'`) compiles to `path_1.default`,
      // which is undefined at run time — the module loads fine and then explodes
      // on first use. Test harness only; no shipped code compiles through here.
      esModuleInterop: true,
      // .tsx files need a JSX emit or transpileModule chokes on the first `<`.
      // The AUTOMATIC runtime is deliberate: classic emit needs `React` in
      // scope, and these components do not need a React default import.
      // A test can therefore stub `react/jsx-runtime` and get a plain element
      // tree without pulling in react-dom.
      ...(filename.endsWith('.tsx') ? { jsx: ts.JsxEmit.ReactJSX } : {})
    },
    fileName: filename,
    reportDiagnostics: true
  });
  if (output.diagnostics?.length) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(output.diagnostics, {
      getCurrentDirectory: () => process.cwd(),
      getCanonicalFileName: (name) => name,
      getNewLine: () => '\n'
    }));
  }
  const mod = { exports: {} };
  cache.set(filename, mod);
  const localRequire = (request) => {
    if (request.startsWith('.') || request.startsWith('@shared/')) {
      const resolved = resolveTs(path.dirname(filename), request);
      if (resolved) return loadFile(resolved);
    }
    return require(request);
  };
  const run = new Function('module', 'exports', 'require', '__filename', '__dirname', output.outputText);
  run(mod, mod.exports, localRequire, filename, path.dirname(filename));
  return mod.exports;
}

/** Load a TypeScript module and its local TypeScript imports for node:test. */
module.exports = function loadTs(relativePath) {
  return loadFile(path.resolve(__dirname, '..', relativePath));
};

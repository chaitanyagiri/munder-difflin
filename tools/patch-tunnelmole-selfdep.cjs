#!/usr/bin/env node
'use strict';
/**
 * Strip tunnelmole's self-reference, re-applied on every install (postinstall).
 * Idempotent and a no-op once the dependency is gone.
 *
 * tunnelmole@2.4.0 lists ITSELF in its own `dependencies` ("tunnelmole": "^2.1.6").
 * `npm list --json --long` — which electron-builder 26's npm node-module collector
 * shells out to — then reports a node that contains itself, and the collector walks
 * `dep.dependencies` recursively with no visited set. The recursion never bottoms
 * out, so every `npm run dist:*` dies with "JavaScript heap out of memory" while
 * "searching for node modules". Raising --max-old-space-size does not help; the
 * growth is unbounded (see electron-builder#10068 for the same failure via libsql).
 *
 * Removing the self-reference is safe: nothing resolves `require('tunnelmole')`
 * from inside tunnelmole itself, and the real dependency edge is ours, declared in
 * this project's package.json.
 */
const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const manifest = join(__dirname, '..', 'node_modules', 'tunnelmole', 'package.json');
if (!existsSync(manifest)) process.exit(0);

const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
if (!pkg.dependencies || !pkg.dependencies.tunnelmole) process.exit(0);

delete pkg.dependencies.tunnelmole;
writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);
console.log('[patch-tunnelmole-selfdep] removed tunnelmole self-reference');

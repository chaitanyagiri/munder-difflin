#!/usr/bin/env node
'use strict';
/**
 * Windows-only node-pty crash guard, re-applied on every install (postinstall,
 * after electron-rebuild). No-op on non-Windows and when already patched.
 *
 * node-pty forks `conpty_console_list_agent.js` to enumerate console processes
 * when a pty is killed/exits. For a child whose console is already gone — e.g.
 * an agent CLI that manages its own console and exits fast (Antigravity's `agy`)
 * — `getConsoleProcessList(shellPid)` throws "AttachConsole failed" UNCAUGHT in
 * that forked helper, which cascades into a whole-app crash (exit 255). Wrap it
 * so it degrades to an empty list instead.
 */
const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

if (process.platform !== 'win32') process.exit(0);

const agent = join(__dirname, '..', 'node_modules', 'node-pty', 'lib', 'conpty_console_list_agent.js');
if (!existsSync(agent)) process.exit(0);

const src = readFileSync(agent, 'utf8');
// Idempotent: only patch the original unguarded form.
if (!src.includes('var consoleProcessList = getConsoleProcessList(shellPid);')) process.exit(0);

const guarded =
  'var consoleProcessList = [];\n' +
  '// PATCHED: AttachConsole can fail when the shell console is already gone (e.g.\n' +
  "// a fast-exiting agent CLI that owns its console). Don't let the uncaught throw\n" +
  '// crash this forked helper and cascade into a whole-app crash.\n' +
  'try { consoleProcessList = getConsoleProcessList(shellPid); } catch (e) { consoleProcessList = []; }';

let out = src.replace('var consoleProcessList = getConsoleProcessList(shellPid);', guarded);
out = out.replace(
  'process.send({ consoleProcessList: consoleProcessList });',
  'try { process.send({ consoleProcessList: consoleProcessList }); } catch (e) { /* parent gone */ }'
);
if (out !== src) {
  writeFileSync(agent, out, 'utf8');
  console.log('[patch-node-pty-conpty] guarded conpty_console_list_agent against AttachConsole crash');
}

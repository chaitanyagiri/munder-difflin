'use strict';

/**
 * The 8.3 lookup that keeps Windows hook commands quote-free.
 *
 * A hook command is written into a provider's config and run by that provider's
 * shell. Codex uses PowerShell on Windows, and PowerShell parses a line that
 * STARTS with a quoted string as an expression, not a command:
 *
 *   "C:\…\hive-node.cmd" "C:\…\cth-hook.cjs"
 *    → Unexpected token '"C:\…\cth-hook.cjs"' in expression or statement
 *
 * so every hook of every codex/agy/grok agent exits 1 — and nothing surfaces it
 * except the provider's own TUI. `shortenForShell` exists to make that line
 * quote-free by reducing each path to its 8.3 short form, which has no space.
 *
 * It could not do it. It asked cmd for the short name with the path quoted
 * INSIDE the spawn argument, and a `"` never survives that trip: Node escapes it
 * as `\"` (the MSVCRT convention) and cmd.exe, which has no backslash escape,
 * parses the line as garbage. Since the function only runs for paths that
 * contain a space, it failed in 100% of its calls and silently returned the long
 * path — the exact input the quoting fallback then produced a broken command
 * from. The fix moves the quotes into an environment variable, so the command
 * line handed to cmd contains no quote at all.
 *
 * The behavioural half of this file therefore checks the TECHNIQUE against the
 * real cmd.exe, because the bug lived entirely in that boundary and no amount of
 * reading the source revealed it.
 *
 * Claude Code is the odd one out: it hosts hooks in Git Bash on Windows, where
 * BOTH Windows shapes fail — the quoted .cmd form via bash's cmd.exe hop, the
 * unquoted short form because bash eats backslashes. Its hook is bash-shaped
 * instead (nodeRunSh), and the bash tests below pin that against the real
 * bash.exe for the same reason.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const win = process.platform === 'win32';
const source = fs.readFileSync(path.join(__dirname, '..', 'src/main/hive.ts'), 'utf8');

/** The body of shortenForShell, isolated from the rest of hive.ts (which pulls
 *  in electron and cannot be loaded here). */
function shortenBody() {
  const start = source.indexOf('private shortenForShell(p: string): string {');
  assert.notEqual(start, -1, 'shortenForShell not found in hive.ts');
  return source.slice(start, source.indexOf('\n  }', start));
}

test('the path reaches cmd through the environment, never as a quoted argument', () => {
  const body = shortenBody();
  assert.match(body, /HIVE_SHORT_SRC/, 'the env-var indirection is gone');
  const spawnArg = body.match(/'\/d', '\/c', ('[^']*')/);
  assert.ok(spawnArg, 'could not find the cmd command line');
  assert.equal(spawnArg[1].includes('"'), false,
    `the cmd command line embeds a quote again: ${spawnArg[1]} — Node escapes it as \\" and cmd cannot read it`);
});

test('a failed lookup is reported instead of silently producing a broken hook', () => {
  // The whole cost of this bug was that nothing said anything: hooks just
  // exited 1, for hours, with the app reporting the agent as healthy.
  assert.match(shortenBody(), /console\.error\(/);
});

test('the quoted fallback is what breaks PowerShell, so it stays the last resort', () => {
  // Pins the ordering the fix depends on: nodeRunUnquoted shortens FIRST and
  // only joinCommandLine (which quotes anything with a space) sees the result.
  const start = source.indexOf('private nodeRunUnquoted(');
  assert.notEqual(start, -1);
  const body = source.slice(start, source.indexOf('\n  }', start));
  assert.match(body, /joinCommandLine\(\[this\.shortenForShell\(launcher\), this\.shortenForShell\(script\)/);
});

test("Claude's Windows hook is bash-shaped: POSIX launcher, forward slashes, no .cmd", () => {
  // Claude Code hosts its hooks in Git Bash on Windows too. Its own transcript
  // recorded both Windows shapes failing there:
  //   quoted .cmd  → bash hands the .cmd to cmd.exe, whose `/c "A" "B"` quote
  //                  stripping re-splits at the space:
  //                  'C:\Users\…\Documents\Munder' is not recognized …
  //   short 8.3    → bash eats every backslash of an unquoted path:
  //                  /usr/bin/bash: line 1: C:UsersfardiDOCUME~1…HIVE-N~1.CMD: command not found
  // So hookSettings must hand bash a bash command, and neither of the two.
  const start = source.indexOf('private hookSettings(');
  assert.notEqual(start, -1);
  const body = source.slice(start, source.indexOf('\n  }', start));
  assert.match(body, /process\.platform === 'win32' \? this\.nodeRunSh\(shim\) : this\.nodeRun\(shim\)/,
    'hookSettings no longer routes the Windows hook through nodeRunSh');

  const sh = source.indexOf('private nodeRunSh(');
  assert.notEqual(sh, -1, 'nodeRunSh is gone');
  const shBody = source.slice(sh, source.indexOf('\n  }', sh));
  assert.match(shBody, /this\.posixLauncherPath\(\)/, 'nodeRunSh must route through the POSIX launcher');
  assert.match(shBody, /replace\(\/\\\\\/g, '\/'\)/, 'lost the forward-slash conversion');
  assert.equal(shBody.includes('nodeLauncherPath()'), false, 'nodeRunSh must not route through the .cmd launcher');

  // And the POSIX launcher has to exist on Windows for that to work.
  const w = source.indexOf('private writeNodeLauncher(');
  const wBody = source.slice(w, source.indexOf('\n  }', w));
  assert.match(wBody, /if \(posix\) writeFileSync\(posix, posixBody, 'utf8'\)/,
    'Windows no longer writes the POSIX hive-node alongside hive-node.cmd');
});

// — the technique, against the real cmd.exe —

test('cmd.exe runs the short form and chokes on the quoted one',
  { skip: win ? false : 'Windows-only: cmd.exe quote stripping' }, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md hook '));
    const launcher = path.join(dir, 'launch.cmd');
    const arg = path.join(dir, 'shim.cjs');
    fs.writeFileSync(launcher, '@echo off\r\nexit /b 0\r\n', 'utf8');
    fs.writeFileSync(arg, '// probe\n', 'utf8');

    const shortOf = (p) => {
      const r = spawnSync('cmd', ['/d', '/c', 'for %I in (%S%) do @echo %~sI'],
        { encoding: 'utf8', env: { ...process.env, S: `"${p}"` } });
      return (r.stdout || '').trim();
    };
    const runLine = (line) => spawnSync('cmd', ['/d', '/c', line],
      { encoding: 'utf8', windowsVerbatimArguments: true });

    const quoted = runLine(`"${launcher}" "${arg}"`);
    assert.notEqual(quoted.status, 0,
      'cmd suddenly accepts the quoted form — re-check whether the short path is still needed');
    assert.match(quoted.stderr || '', /is not recognized/);

    const s = shortOf(launcher);
    if (!s || s.includes(' ') || !fs.existsSync(s)) {
      t.skip(`8.3 names unavailable on ${path.parse(dir).root}`);
      return;
    }
    assert.equal(runLine(`${s} ${shortOf(arg)}`).status, 0, 'the short form must run');
  });

const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']
  .find((p) => fs.existsSync(p));

test('under Git Bash only the bash-shaped command survives a path with a space',
  { skip: win ? (gitBash ? false : 'Git Bash not installed') : 'Windows-only: Git Bash hook host' }, () => {
    // The dir has a space, like the default hive home. The launcher wraps the
    // test runner's own node: the claim under test is the SHAPE — a POSIX sh
    // launcher, forward slashes, quotes — not which binary sits behind it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md hook '));
    const fwd = (p) => p.replace(/\\/g, '/');
    const script = path.join(dir, 'probe.cjs');
    fs.writeFileSync(script, 'process.stdout.write("ran " + (process.env.ELECTRON_RUN_AS_NODE || "no-env") + " " + process.argv.slice(2).join(","));\n', 'utf8');
    const posixLauncher = path.join(dir, 'hive-node');
    // Exactly the body writeNodeLauncher writes, with node standing in for Electron.
    fs.writeFileSync(posixLauncher, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${fwd(process.execPath)}" "$@"\n`, 'utf8');
    const cmdLauncher = path.join(dir, 'launch.cmd');
    fs.writeFileSync(cmdLauncher, '@echo off\r\nexit /b 0\r\n', 'utf8');
    const bash = (line) => spawnSync(gitBash, ['-c', line], { encoding: 'utf8', input: '{}' });

    // The shape nodeRunSh emits — no chmod, as on a real Windows install.
    const ok = bash(`"${fwd(posixLauncher)}" "${fwd(script)}" --status`);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), 'ran 1 --status', 'env or argument did not survive the launcher');

    // The two shapes the other providers use, which is what Claude used to get.
    const quotedCmd = bash(`"${fwd(cmdLauncher)}" "${fwd(script)}"`);
    assert.notEqual(quotedCmd.status, 0, 'bash now runs a quoted .cmd with a spaced path — re-check the design');
    const unquotedBackslash = bash(`${script} x`);
    assert.equal(unquotedBackslash.status, 127, 'bash stopped eating unquoted backslashes — re-check the design');
  });

test('cmd returns a usable 8.3 name only when the quotes come from the environment',
  { skip: win ? false : 'Windows-only: 8.3 short names' }, (t) => {
    // A directory whose name contains a space is the only case that ever calls
    // the function, and the only case the old code got wrong.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md hook '));
    const file = path.join(dir, 'cth-hook.cjs');
    fs.writeFileSync(file, '// probe\n', 'utf8');
    const usable = (out) => {
      const s = (out || '').trim();
      return !!s && !s.includes(' ') && fs.existsSync(s);
    };

    const viaEnv = spawnSync('cmd', ['/d', '/c', 'for %I in (%HIVE_SHORT_SRC%) do @echo %~sI'], {
      encoding: 'utf8',
      env: { ...process.env, HIVE_SHORT_SRC: `"${file}"` }
    });
    if (!usable(viaEnv.stdout)) {
      // 8.3 generation is a per-volume policy; with it off, no technique works
      // and the app falls back to quoting (and now says so). Nothing to assert.
      t.skip(`8.3 names unavailable on ${path.parse(dir).root}`);
      return;
    }

    const inlineQuotes = spawnSync('cmd', ['/d', '/c', `for %I in ("${file}") do @echo %~sI`], { encoding: 'utf8' });
    assert.equal(usable(inlineQuotes.stdout), false,
      'the old inline-quote form suddenly works — if Node changed its cmd escaping, '
      + 'simplify shortenForShell deliberately rather than by accident');
  });

test('the command line the fix produces is quote-free, which is what PowerShell needs',
  { skip: win ? false : 'Windows-only: 8.3 short names' }, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md hook '));
    const file = path.join(dir, 'cth-hook.cjs');
    fs.writeFileSync(file, '// probe\n', 'utf8');

    const res = spawnSync('cmd', ['/d', '/c', 'for %I in (%HIVE_SHORT_SRC%) do @echo %~sI'], {
      encoding: 'utf8',
      env: { ...process.env, HIVE_SHORT_SRC: `"${file}"` }
    });
    const short = (res.stdout || '').trim();
    if (!short || short.includes(' ') || !fs.existsSync(short)) {
      t.skip(`8.3 names unavailable on ${path.parse(dir).root}`);
      return;
    }
    // joinCommandLine only quotes a part that contains whitespace, so a short
    // path yields a bare first token — the thing PowerShell needs to treat the
    // line as a command at all.
    const { joinCommandLine } = require('./load-ts.cjs')('src/shared/commandLine.ts');
    const line = joinCommandLine([short, short]);
    assert.equal(line.includes('"'), false, line);

    const parsed = spawnSync('powershell',
      ['-NoProfile', '-Command', '$l=[Console]::In.ReadToEnd(); try { $null=[ScriptBlock]::Create($l); "OK" } catch { "FAIL" }'],
      { encoding: 'utf8', input: line });
    assert.equal((parsed.stdout || '').trim(), 'OK', `PowerShell rejected: ${line}`);
  });

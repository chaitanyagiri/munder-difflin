---
title: "Our Auto-Update Never Ran Once: A CommonJS Export That Vanished Into an ESM Namespace"
description: "Munder Difflin shipped auto-update in v0.3.4 and it silently never worked in a single packaged build. The cause was one destructuring assignment across the CommonJS/ESM boundary — and a catch block that threw the evidence away. Here's how we found it, and what v0.3.7 changes."
date: 2026-08-08
category: internals
categoryLabel: Internals
type: Technical
primaryKeyword: "electron-updater not working"
secondaryKeywords: ["electron auto update not working", "cjs-module-lexer named export undefined", "await import commonjs electron", "electron-updater autoUpdater undefined", "electron app.isPackaged debugging"]
tags: ["Internals", "Electron", "Debugging", "Release", "Open Source"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "Why was electron-updater's autoUpdater undefined?"
    a: "electron-updater is a CommonJS package that attaches autoUpdater to its exports through a lazy Object.defineProperty getter. Node's cjs-module-lexer detects named exports by static analysis, and it cannot see through a getter defined at runtime. So the ESM namespace produced by `await import('electron-updater')` has no autoUpdater key at all — it only exists on the namespace's `.default`. Destructuring `const { autoUpdater } = await import('electron-updater')` therefore yields undefined. Use `ns.autoUpdater ?? ns.default?.autoUpdater`, or plain `require()`, instead."
  - q: "Why didn't this show up in development?"
    a: "The whole updater setup block was behind an `app.isPackaged` check, which is false in dev. Development runs never executed the line that threw, so the bug could only ever appear in a shipped build — and shipped builds have no visible console. It survived three releases that way."
  - q: "How do you debug an Electron app that only misbehaves when packaged?"
    a: "Launch the installed binary directly from a terminal with an isolated data directory: `/Applications/YourApp.app/Contents/MacOS/YourApp --user-data-dir=/tmp/probe`. Electron's single-instance lock is keyed to the user-data directory, so this runs alongside the copy the user already has open, and every console.log and stack trace lands in your terminal instead of disappearing."
  - q: "Do I need to reinstall Munder Difflin to get v0.3.7?"
    a: "Yes, once. Every build from v0.3.4 through v0.3.6 carries the broken updater, so it cannot fetch this fix by itself. Download v0.3.7 manually from munderdiffl.in or the GitHub releases page. From v0.3.7 onward, updates download in the background and wait for your restart."
  - q: "How do you stop a bug like this from hiding again?"
    a: "Three changes. Errors are never swallowed — every updater failure is emitted to the UI and appended to a log file on disk. The notify-only fallback is per-check rather than a permanent latch, so one blip doesn't disable updates for the session. And the state model moved into a plain electron-free module with unit tests, so the rules can be verified without booting the app."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>Munder Difflin shipped auto-update in <strong>v0.3.4</strong>. It never ran — not once, in any packaged build, through three releases. The cause was a single destructuring assignment across the CommonJS/ESM boundary that produced <code>undefined</code>, and a <code>catch</code> block that threw away the error message. <strong>v0.3.7</strong> fixes it, turns the toolbar version into the update button, and makes sure the next failure can't hide.</p></div>

A user restarted the app after v0.3.6 went live and reported that auto-update hadn't
triggered. What they got instead was a toast offering to open the releases page in a
browser — the fallback path, meant for installs that genuinely can't update themselves.

That's a good bug report, because the fallback existing at all means the app *knew* there
was a new version. It found the release. It just refused to install it.

## Ruling things out, expensively

The obvious suspect on macOS is notarization. An update that isn't properly signed and
stapled gets refused by Gatekeeper, and the failure is quiet. So the published asset went
under a microscope first:

```bash
shasum -a 512 Munder-Difflin-0.3.6-mac-universal.zip   # matches latest-mac.yml exactly
codesign --verify --deep --strict --verbose=2 "Munder Difflin.app"
xcrun stapler validate "Munder Difflin.app"
spctl --assess -vv "Munder Difflin.app"
```

All clean. Developer ID signature, notarization ticket stapled, `spctl` accepted, and the
SHA-512 matching the update feed byte for byte. The release was fine.

Next suspect: the feed. Running `electron-updater` directly against the live GitHub release
resolved 0.3.5 → 0.3.6 correctly, downloaded all 232 MB, verified the hash, and emitted
`update-downloaded`. The updater library was fine too.

So the release worked, the library worked, and the app still wouldn't update. The problem
had to be in our own code — and our own code was refusing to say what was wrong.

## Getting a packaged app to talk

Everything interesting here lives behind `app.isPackaged`, which is false in development.
The bug could only exist in a build with no visible console.

The trick that cracked it: **Electron's single-instance lock is keyed to the user-data
directory.** Point a second launch at a different one and it runs happily alongside the
copy already open, with stdout wired to your terminal.

```bash
"/Applications/Munder Difflin.app/Contents/MacOS/Munder Difflin" \
  --user-data-dir=/tmp/updater-probe
```

Thirty seconds later, the first check fired and printed the thing the app had been
swallowing for three releases:

```
[updater] electron-updater unavailable; notify-only mode:
TypeError: Cannot set properties of undefined (setting 'autoDownload')
```

{% img "note-1" %}

## One line, three releases

Here is the code that shipped in v0.3.4:

```js
const { autoUpdater } = await import('electron-updater');
autoUpdater.autoDownload = true;          // ← TypeError, every single time
```

`electron-updater` is a CommonJS package, and it attaches `autoUpdater` to its exports
through a lazy `Object.defineProperty` getter. Node's ESM loader detects named exports from
CommonJS with `cjs-module-lexer`, which works by **static analysis** — and a property
defined at runtime by a getter is invisible to it.

The result, confirmed by probing the namespace directly:

```js
const ns = await import('electron-updater');
Object.keys(ns);            // AppUpdater, MacUpdater, NsisUpdater, … default
ns.autoUpdater;             // undefined   ← what we destructured
ns.default.autoUpdater;     // object      ← where it actually lives
require('electron-updater').autoUpdater;  // object
```

So the destructuring produced `undefined`, and the very next line — setting a property on
it — threw. That exception landed in a `catch` that set a `fallbackActive` flag and moved
on. From then on, every check in that session took the notify-only path. Which is exactly
what the user saw: an app that finds new releases and can only offer you a link.

The fix is unglamorous:

```js
const ns = await import('electron-updater');
const autoUpdater = ns.autoUpdater ?? ns.default?.autoUpdater;
if (!autoUpdater) throw new Error('electron-updater exposes no `autoUpdater` export');
```

**The general rule: never destructure a named export off `await import()` of a CommonJS
package.** If the package builds its exports at runtime — getters, `Object.assign`,
conditional wiring — the lexer won't see them, and you get `undefined` instead of an error
telling you why.

## The real bug was the catch block

A one-character-class fix that survives three releases isn't really a story about interop.
It's a story about a `catch` that discarded its argument.

The error existed. It was specific, it named the exact property, and it pointed at the exact
line. It was thrown away, and replaced with a degraded mode that looked deliberate. Anyone
watching the app saw a working feature: it noticed new versions and offered a download link.
Nothing looked broken enough to investigate.

So v0.3.7 changes three things beyond the interop fix:

- **Errors are never swallowed.** Every updater failure is emitted to the renderer *and*
  appended to an `updater.log` in the app's data folder. The tooltip on the toolbar badge
  shows the actual message.
- **The fallback is per-check, not a latch.** A transient network error used to cost the
  session its ability to self-update until the next restart. Now the next tick tries the
  native path again.
- **The state rules are testable.** How updater events map to what the UI shows moved into a
  plain module with no Electron imports, with unit tests covering the rule that bit us — a
  re-check must never wipe out an update you already have staged.

{% img "note-2" %}

## The version number is now a button

The other half of the report was that nothing in the app told the user what was happening.
There was a toast for "downloaded", and nothing for anything else — so a multi-minute
232 MB download looked exactly like an app doing nothing.

The version text next to the logo is now the control. It shows `checking…`, then
`v0.3.8 ready to install` (click to download), then live progress, then **restart to
update** (click to apply). With nothing pending, clicking it checks on demand — previously
the only checks were 30 seconds after launch and every six hours after that, with no way to
ask.

## If you're on v0.3.5 or v0.3.6

You'll need to install v0.3.7 by hand, once. Your current build carries the broken updater,
so it can't fetch the fix that repairs it — the one bootstrap problem a self-updating app
can't solve for itself. Grab it from [munderdiffl.in](https://munderdiffl.in/) or the
[releases page](https://github.com/chaitanyagiri/munder-difflin/releases/latest).

After that, it updates itself. For real this time — and if it ever doesn't, it'll tell you
why.

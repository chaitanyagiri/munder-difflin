---
title: "Launching Munder Difflin v0.4.6: It Speaks Chinese and Arabic Now"
description: "v0.4.6 adds Chinese and Arabic interfaces with right-to-left support, ships its fonts inside the app so nothing is fetched from Google, and makes the updater actually update itself instead of pointing at a download page."
date: 2026-08-27
category: story
categoryLabel: Story
type: Non-technical
primaryKeyword: "munder difflin v0.4.6"
secondaryKeywords: ["munder difflin release", "claude code chinese interface", "arabic rtl developer tools", "electron auto update", "ai agent telemetry privacy"]
tags: ["Story", "Release", "i18n", "Open Source"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What languages does Munder Difflin v0.4.6 support?"
    a: "English, Simplified Chinese and Arabic. English stays the default and nothing changes until you pick another language in Settings under General. The app never guesses from your operating system locale."
  - q: "Is the Arabic translation finished?"
    a: "Every string is translated, with nothing falling back to English, and the terminals read right to left. Some screens still need their padding and icons mirrored, and that is the next piece of work. No Arabic speaker has reviewed the wording yet, so reports are welcome."
  - q: "Does the app still fetch fonts from Google?"
    a: "No. All three faces ship inside the app. That was breaking the interface in mainland China, where both Google font hosts are blocked, which is exactly where the Chinese translation was headed."
  - q: "What changed in the updater?"
    a: "Clicking the update badge now runs the real download and restart instead of handing you a disk image and install instructions. The check can no longer hang forever on a stalled connection, and the what's new list shows real features."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p><strong>v0.4.6 is the release where the
app stops assuming everyone reads English left to right.</strong> Simplified Chinese and Arabic
interfaces, right-to-left support, fonts that ship inside the app instead of loading from a host
that is blocked in China, and a fix for the input method bug that was sending half typed messages.
Also: the updater finally updates itself, Settings has one Save button, and analytics stopped
collecting location data it promised it was not collecting.</p></div>

Most of our releases so far have been about making the office floor work. This one is about who
gets to walk onto it.

## Chinese and Arabic

Munder Difflin now runs in Simplified Chinese and Arabic. English stays the default and nothing
moves until you pick a language in Settings, under General. The app deliberately does not read
your operating system locale, because changing somebody's whole interface out from under them on
an upgrade is rude even when you are right about what they speak.

The Chinese work came from the community. [@Schopenhauer-loves-Hegel](https://github.com/Schopenhauer-loves-Hegel)
opened [PR #205](https://github.com/chaitanyagiri/munder-difflin/pull/205) and built the entire
foundation: react-i18next mounted, the language picker, and then the slow part, walking every
screen and pulling out hardcoded strings. The office floor, the Command Center, Settings, the
setup wizard, the triggers tabs, the Kanban board, the IDE panels. It is a little under 1,200 strings.
That is not a fun afternoon and he did it anyway.

{% img "note-1", "Every screen walked, every hardcoded string pulled out. Roughly 1,200 of them." %}

### The font problem underneath it

Here is a thing you only find out by shipping to people who are not near you. The app loaded
Press Start 2P, Inter and JetBrains Mono from Google Fonts on every boot. Both of Google's font
hosts are blocked in mainland China. So the app started there with all three faces failing, the
pixel brand chrome degraded to generic monospace, and the whole thing looked broken. For exactly
the people we were adding a Chinese translation for.

A desktop app should not need the network to render its own type. All three faces now ship inside
the bundle, 84KB for the set. No CJK or Arabic face is bundled, because a full CJK font is 8 to
10MB and every platform we ship on already carries a good one, so the font stacks name the system
faces instead. The content security policy no longer allows either Google host at all.

### The Enter key bug

This one had nothing to do with translation and was hitting people the whole time. If you type
Chinese, Japanese or Korean, you use an input method editor: you type, you get a list of candidate
words, and you press Enter to choose one. Every Enter handler in the app read that as "send it".
So choosing a candidate sent your message, ran your search, or committed a rename, with half
composed text still sitting in the box. Then you retyped the thing the app had already sent badly.

Eleven text entry handlers now check whether an input method is mid composition before treating
Enter as go. Buttons that pair Enter with Space were left alone on purpose, because those really
are "activate this".

### Arabic, and what is honestly still rough

Arabic is the harder half, because right to left is not a text direction toggle. It is a layout
question, and layout is where a UI hides its assumptions.

Every string is translated, with nothing falling back to English, and the terminals read right to
left. Some screens still need their padding and icons mirrored, and that is the next piece of work.

The terminal part is worth one sentence of why. xterm has no bidi of its own, so picking Arabic
quietly moves terminals onto the browser's text engine, which is where Arabic actually joins and
orders properly. Markdown reads the right way too. Code blocks and shell commands stay left to
right, because reordering a command changes what it says.

One more thing worth saying plainly: **no Arabic speaker has reviewed the translation yet.** It was
written by an agent and checked by machine for the things you can check without reading Arabic,
coverage and placeholders and structure. Whether it reads well is unverified. We shipped it anyway,
because a translation you can use and file bugs against beats a perfect one that never arrives. If
you read Arabic and something is wrong,
[tell us](https://github.com/chaitanyagiri/munder-difflin/issues) and it gets fixed.

The Arabic and right to left groundwork started as
[PR #213](https://github.com/chaitanyagiri/munder-difflin/pull/213) from
[@abo123v-glitch](https://github.com/abo123v-glitch), including the terminal shaping recipe, which
is the fiddly part.

## The updater actually updates now

If you clicked the update badge on 0.4.5, you did not get an update. You got a disk image and a
card explaining how to drag it into Applications. The Settings pane had the real thing all along,
native download and restart, but the badge never called it. So the founder clicked the badge, got
homework, and reasonably concluded that auto update did not work.

The badge now runs the same path Settings does. It says download, it downloads, it says restart,
it installs. The manual disk image is demoted to what it should always have been, the fallback for
when the native updater genuinely cannot fetch the build.

Two more updater fixes worth naming:

**The check could spin forever.** There was no timeout around the update check. On a stalled
connection, a captive portal, or a half open socket after your laptop woke up, the request opened
and never answered, so the badge sat on "checking" until you restarted the app. There is a hard
cap on it now.

**The what's new list was one line of CSS.** This is my favourite bug of the release. The update
toast was showing exactly one item: `{ box-sizing: border-box; }`. The release notes page carries
its own inline stylesheet, and the updater was scanning the rendered page for bullet points. In
the whole document the only line matching bullet syntax was a CSS rule starting with `*`, because
an asterisk followed by a space is a bullet. So a reset rule was the entire feature list. The
notes are now written into the release metadata directly, where the update toast reads them before
you upgrade rather than after.

{% img "note-2", "The what's new list was a CSS reset rule. An asterisk followed by a space is a bullet." %}

## Settings has one Save button

Settings used to persist three different ways at once. Some toggles wrote to disk the moment you
clicked them. Autonomy and Budgets had its own Save. Max turns saved when you clicked away.
Nothing on screen told you which one you were looking at, so "did that stick?" had no answer you
could learn once.

Everything is staged now and written by one Save in the footer. Close with unsaved changes and it
asks first. The Connections tab also stopped repeating itself.

Underneath, the model lists moved out of the renderer source and into a checked in JSON file.
Shipping a new model used to mean editing code and rebuilding. Now it is one line in a catalog,
and entries can say which app versions they belong to, so a build stops offering a model its CLI
never shipped. That was [@aaroncoville](https://github.com/aaroncoville) in
[PR #339](https://github.com/chaitanyagiri/munder-difflin/pull/339).

## Security and privacy

Three things, plainly.

**Engine command launching is hardened.** When an agent launches its CLI, the command name is now
validated before it is ever looked up against your PATH. Only a plain command name or an absolute
path gets that far, and the Windows lookup no longer re-parses its own argument. All three places
that resolve a command got the same guard.

The operating system sandbox now stays on in auto mode. It used to be dropped entirely, because a
worker needs to write to its own agent folder which sits outside the project directory. That is a
path problem, so it is fixed as one: the sandbox stays on and the folders it needs are added to
the allowed list.

Analytics stopped sending your IP address and everything derived from it. Our telemetry document
and our privacy policy both said the IP was not retained on the event. It was, along with city,
postal code and coordinates, because a geolocation flag was explicitly turned on in our own code,
with a comment next to it restating the promise it was breaking. Nothing in the codebase ever read
any of it, so it bought us nothing. It is off now in the app, the blog and the marketing site, and
both published promises were corrected to describe the stronger position rather than the other way
round.

## Telemetry, and what it counts

There is now a funnel from launching the app to running your first agent. Five new events cover
the gap between "opened the app" and "has an agent running", because that is where people fall
out and we had nothing there. A failed spawn used to send nothing at all, which made "the engine
CLI was missing" and "the user changed their mind" the same non event.

The funnel now also counts the messages you send to an agent. A count, and nothing else. Not the
text, not the length, not a character count, not the first few characters, not a hash of it. The
event carries one property, which surface you sent from, and that is a fixed list. The channel the
interface uses to report a message does not accept a message argument at all, so there is no shape
in which your text could cross it by accident. It is counted when you hit send, not per keystroke.

Everything in the funnel is a closed list of values: which engine, and one of four reasons a spawn
failed. No prompts, no code, no file paths, no agent output, ever. The full list of every event and every
property is in [TELEMETRY.md](https://github.com/chaitanyagiri/munder-difflin/blob/main/TELEMETRY.md),
and it is short on purpose.

## The rest

- **Terminals stop blacking out.** Chromium allows about 16 live WebGL contexts and silently
  evicts the oldest when you pass it. Switching between agents leaked one per switch, so eventually
  a terminal or the office floor itself went black. Contexts are released properly now.
  [@aaroncoville](https://github.com/aaroncoville), [PR #323](https://github.com/chaitanyagiri/munder-difflin/pull/323).
- **The release notes page no longer shows a white screen.** It painted nothing until its
  stylesheets resolved, and it was still fetching fonts from Google. On a network where that host
  is blocked the fetch does not fail, it hangs, so a new version greeted you with a blank rectangle
  for as long as the timeout took. Its fonts are inlined now, remote stylesheets are refused
  outright, and a loader covers the frame until the page is actually there.
- **Settings stops showing stale values.** The interface loaded the config once at startup and
  nothing told it when a write landed, so reopening Settings showed you the value from before
  your last change. Every write is announced now.
- **Renaming the orchestrator sticks.** If you renamed Michael, the rename was saved correctly and
  then thrown away on the next restart, because his identity was rebuilt from scratch with the name
  hardcoded in three places. It reads the saved name now, everywhere.
- **The ASK ME card renders markdown.** Questions with emphasis, bullets, `code`, tables and links
  render properly instead of showing you their raw asterisks.
- **The ASK ME board is in order.** It had no sort at all, so a question from five minutes ago
  could sit below one from three days ago.
- **An agent's usage counter resets when its terminal exits.**
  [@aaroncoville](https://github.com/aaroncoville), [PR #317](https://github.com/chaitanyagiri/munder-difflin/pull/317).

{% img "note-3", "Sixteen community pull requests from thirteen contributors, one of them re-implemented rather than merged." %}

## Credits

16 community pull requests from 13 contributors landed in this release, one of them (#213)
re-implemented rather than merged.

[@Schopenhauer-loves-Hegel](https://github.com/Schopenhauer-loves-Hegel) built the entire
multilingual foundation, which is the biggest single piece of work in the release.
[@abo123v-glitch](https://github.com/abo123v-glitch) brought the Arabic and right to left work,
including the terminal shaping recipe. [@aaroncoville](https://github.com/aaroncoville) landed
three, among them the WebGL fix that stops terminals going black.
[@LavaDMan](https://github.com/LavaDMan) fixed a test that raced its own input.

**About that re-implemented one.** [PR #213](https://github.com/chaitanyagiri/munder-difflin/pull/213)
counts because the work shipped, not because it merged. We split it, took the terminal half, then
re-implemented the UI half against the language picker that landed after it was written. The code
ships and the design is theirs. On GitHub the pull request still reads as unmerged, which looks
like a rejection and is not one, so this is the place to say so plainly.

And the rest of the thirteen, whose fixes are in this build:
[@BUGHUNTER-SACHIN](https://github.com/BUGHUNTER-SACHIN),
[@djbiz](https://github.com/djbiz),
[@gpechieu](https://github.com/gpechieu),
[@HsienW](https://github.com/HsienW),
[@HundredBillion](https://github.com/HundredBillion),
[@jhinzzz](https://github.com/jhinzzz),
[@L422Y](https://github.com/L422Y),
[@raifemre](https://github.com/raifemre) and
[@savvaskoualis](https://github.com/savvaskoualis).

Merge a pull request and a workflow hands you the **employee of the month** role in
[our Discord](/blog/we-opened-a-discord/). Still thematically required.

## Get it

If you are on 0.3.5 or later the app will offer the update itself, and this time clicking the
badge actually installs it. Fresh install: [munderdiffl.in](https://munderdiffl.in). Every receipt
is in [the changelog](https://github.com/chaitanyagiri/munder-difflin/blob/main/CHANGELOG.md).

If you run the app in Chinese or Arabic, we want to hear what is broken. Especially Arabic, and
especially the wording, since nobody who reads it has checked it yet.

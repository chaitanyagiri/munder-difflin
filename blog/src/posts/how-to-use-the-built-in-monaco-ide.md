---
title: "How to Use the Built-in Monaco IDE"
description: "A practical walkthrough of Munder Difflin v0.3.3's built-in Monaco IDE: the title-bar IDE button, the git CHANGES rail with side-by-side diffs vs HEAD, the file tree, tabs, Cmd/Ctrl+S save — and the agent review workflow it enables."
date: 2026-07-03
category: guides
categoryLabel: Guides
type: Technical
primaryKeyword: "built-in monaco ide"
secondaryKeywords: ["review ai agent code changes", "monaco editor electron app", "side-by-side git diff vs head", "munder difflin ide walkthrough", "human review workflow for ai agents"]
tags: ["Guides", "IDE", "Git", "Human-in-the-Loop", "Local-First"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "How do I open the built-in IDE in Munder Difflin?"
    a: "Click the IDE button in the title bar. It toggles a full-window Monaco editor overlay on top of the office floor — the floor, terminals, and voice UX keep running underneath, untouched. Click the button again to drop back to the floor. It shipped in v0.3.3."
  - q: "How do I see what an agent changed?"
    a: "Open the IDE and look at the git CHANGES rail on the left. It lists every file with uncommitted changes in the workspace; click a file and you get a read-only side-by-side diff against HEAD, so you see exactly what the agent wrote next to what was there before."
  - q: "Can I edit files in the built-in IDE, not just read diffs?"
    a: "Yes. The left rail also has the workspace file tree — clicking a file there opens it in a real editable Monaco tab. Tabs show a dirty-state dot when you have unsaved edits, and Cmd/Ctrl+S saves the active tab. Saves are hardened so keystrokes typed while a save is still writing are never silently dropped."
  - q: "Which folder does the IDE open — how is the workspace root chosen?"
    a: "The workspace root snapshots from an agent's working directory when the overlay opens: the selected agent's cwd if one is selected, otherwise the GOD agent's, otherwise the first agent's. So selecting the agent whose work you want to review before clicking IDE puts you in the right repo."
  - q: "Does Monaco load from a CDN? Does the renderer touch my disk?"
    a: "No and no. Monaco — the same editor engine VS Code uses — is fully self-hosted and bundled with the app, with no CDN involved, so it works offline. And the renderer holds no filesystem or git access at all: every read, write, and diff is brokered through main-process IPC via the preload bridge."
  - q: "Why build an IDE into an agent harness instead of using VS Code?"
    a: "Because the review loop is faster when it lives where the agents live. An agent finishes, you click IDE, read the side-by-side diff vs HEAD, fix small things in place, and go approve — no context switch to another app, no hunting for the right worktree. For heavy editing sessions your regular editor is still there; the built-in IDE is optimized for reviewing agent output."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>Munder Difflin v0.3.3 ships a <strong>built-in Monaco IDE</strong> — the VS&nbsp;Code editor engine, fully self-hosted, no CDN. A title-bar <strong>IDE</strong> button toggles a full-window overlay above the office floor: a <strong>git CHANGES rail</strong> where clicking a file opens a <strong>side-by-side diff vs HEAD</strong>, a workspace <strong>file tree</strong>, <strong>editor tabs with dirty-state dots</strong>, and <strong>Cmd/Ctrl+S</strong> save. The workspace root snapshots from the <strong>selected → god → first agent's cwd</strong>, and <strong>all fs/git access goes through main-process IPC</strong> — the renderer never touches disk. The point: <em>agent finishes → open IDE → read the diff → tweak → approve</em>, without leaving the app.</p></div>

You hired a floor of agents, one of them just announced it's done, and now comes the part that actually matters: **reading what it changed before you bless it.** Until v0.3.3, that meant alt-tabbing to your editor, finding the right directory, and running `git diff` by hand. Now the review surface is built in. This is a practical walkthrough of the Monaco IDE that shipped in [v0.3.3](/blog/launching-munder-difflin-v0-3-3/) — what each piece does and the workflow it's designed around.

## Opening it: the title-bar IDE button

There's an **IDE** button in the title bar. Click it and a full-window Monaco editor overlays the office floor — same fullscreen-overlay pattern as the rest of the app, so the floor, the terminals, and the voice UX keep running underneath, untouched. Click it again and you're back watching avatars.

Monaco is the editor engine inside VS Code, and here it's **fully self-hosted**: bundled workers, no CDN, themed to the harness's light palette. That's not a vanity detail — it means the IDE works offline and nothing about your code round-trips through a third-party host just to render syntax highlighting. Local-first, like everything else in the app.

## The left rail: CHANGES first, tree second

The left rail has two jobs, in priority order.

**The git CHANGES list** is the headline. It shows every file with uncommitted changes in the workspace. Click one and you get a **read-only side-by-side diff against HEAD** — the agent's version on one side, what was committed before on the other. This is the "what did my agent actually do" view, and it's deliberately read-only: a diff is for reading, not for accidentally editing the wrong pane.

**The workspace file tree** sits alongside it. Click any file there and it opens as a normal, *editable* Monaco tab. So the rail gives you both motions: *review* (CHANGES → diff) and *fix* (tree → edit).

{% img "note-1" %}

## Tabs, dirty dots, and Cmd/Ctrl+S

Open files stack up as **editor tabs** on the right, each with a **dirty-state dot** when it has unsaved edits, plus save and close. **Cmd/Ctrl+S** saves the active tab.

One hardening detail worth knowing because it's the kind of thing that silently eats work in lesser editors: saves are protected against the in-flight race. If you keep typing while a save is still writing to disk, those keystrokes are **not** dropped when the save completes. v0.3.3 fixed this explicitly.

## Which folder am I looking at? The workspace root

The IDE has to pick a repo to show, and it snapshots the workspace root from an agent's working directory when the overlay opens, in this order:

1. the **selected agent's** cwd, if you have one selected;
2. otherwise the **GOD agent's** cwd;
3. otherwise the **first agent's** cwd.

Practical consequence: **select the agent whose work you want to review, then click IDE.** That drops you straight into its directory — which matters on a floor where [each agent can run in its own isolated git worktree](/blog/claude-code-git-worktrees-vs-hive/), so "the repo" isn't one place.

{% img "note-2" %}

## The security posture: the renderer never touches disk

Everything the IDE does — listing the tree, reading files, writing saves, computing diffs — is **brokered through main-process IPC**. The diff view rides a `git:diff` IPC channel plus the preload bridge; the renderer process holds no filesystem or git access of its own. That's the same architecture as the rest of the harness: the sandboxed renderer asks, the main process does, and the attack surface of "web content with disk access" simply doesn't exist here.

## The workflow it's built for: finish → diff → tweak → approve

Here's the loop the whole feature is shaped around:

1. **An agent finishes.** You get the desktop notification, or Michael tells you.
2. **Select that agent, click IDE.** You're in its workspace.
3. **Read the CHANGES rail.** Click through each touched file, read the side-by-side diff vs HEAD. This is the honest answer to "what did it do," straight from git — not the agent's summary of itself.
4. **Tweak in place.** Wrong variable name, missing edge case, comment you'd phrase differently — open the file from the tree, fix it, Cmd/Ctrl+S. No editor switch.
5. **Approve.** Now that you've *seen* the change, act on it — answer the approval-queue escalation, tell the agent to commit, or dispatch the follow-up.

That last step is the point. [Human-in-the-loop approval](/blog/human-in-the-loop-approving-ai-agents/) is only as good as the human's view of the change, and "I skimmed the agent's summary" is not a view. A diff vs HEAD is. The built-in IDE closes the gap between *the agent says it's done* and *you know what done contains* — inside the same window where the work happened.

## Try it

The IDE ships in v0.3.3 for macOS, Windows, and Linux — [grab the latest release](https://github.com/chaitanyagiri/munder-difflin/releases/latest), or start with the [install guide](/blog/how-to-install-and-use-munder-difflin/) if you're new. If the review loop saves you an alt-tab, a [GitHub star](https://github.com/chaitanyagiri/munder-difflin) helps more people find it.

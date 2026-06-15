---
name: md-fetch-summarize
version: 1.0.0
description: |
  Fetch a URL and return a concise markdown summary of its content.
  Read-only: no files are written; the summary is returned as output only.
  Use when asked to "fetch and summarize", "summarize this URL", "what does
  this page say", or "get the content of <url>".
  Proactively suggest when the user pastes a URL and asks what it contains. (munder-difflin)
allowed-tools:
  - WebFetch
  - Bash
---

## Fetch & Summarize

Given a URL, fetch its content and return a concise markdown summary.

Steps:
1. Fetch the page with `WebFetch` (or `Bash` with `curl -sL <url> | head -200` as a fallback).
2. Extract the main content — ignore nav, footer, ads, and boilerplate.
3. Return a structured summary with:
   - **Title** (the page's `<title>` or heading)
   - **One-paragraph overview** of what the page is about
   - **Key points** as a bullet list (max 5)
   - **Source** — the URL fetched

Do not save or write the fetched content anywhere. Return the summary directly.

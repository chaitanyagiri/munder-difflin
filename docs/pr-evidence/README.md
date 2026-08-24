# PR evidence — screenshots

Before/after screenshots for pull request evidence, served to the PR body via
`raw.githubusercontent.com` (the API cannot produce GitHub's drag-and-drop
`user-attachments` URLs, so the raw CDN is the only scriptable path).

- `before-220.png` — the hive floor before the fix: a headless worker whose
  dispatched objective never reaches its terminal (inbox stays undrained).
- `after-220.png` — the same floor after the fix: the worker is carded and
  woken, and its inbox mail is delivered to its terminal like any other agent.

# PR evidence — screenshots

Before/after screenshots for pull request evidence, served to the PR body via
`raw.githubusercontent.com` (the API cannot produce GitHub's drag-and-drop
`user-attachments` URLs, so the raw CDN is the only scriptable path).

- `before-en.png` — the UI in English before the change.
- `after-zh.png` — the same screen with 简体中文 selected in Settings → General.
- `before-task-id.png` / `after-task-id.png` — the Tasks kanban DOING column
  without and with the task id on each card (#352). Rendered off the real
  `TaskCard` component with the real design tokens and bundled fonts, at one
  window size against one fixed set of cards, so the pair differs only by the
  change itself.

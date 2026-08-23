<!-- Thanks for contributing to Munder Difflin.

     Read this line before you go further: a PR without a BEFORE and an AFTER
     is not reviewable and will not be merged. The `PR evidence` check runs the
     moment you open this and will tell you if it is missing. Keep the `Before`
     and `After` headings below exactly as they are — the check reads them. -->

## What & why

<!-- What changed, and why it needed to. Two or three sentences beats a
     bullet list of file names — we can read the diff, we cannot read your
     reasoning. If this fixes an issue, link it: Closes #123 -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / cleanup
- [ ] Docs
- [ ] Build / CI

## Evidence

<!-- REQUIRED. Drag images or a screen recording directly under each heading —
     GitHub uploads them inline. Both headings must have something under them.

     No visible UI? You still owe evidence. Record the failing behaviour and
     then the same steps passing: a terminal capture, a log diff, a test that
     goes from red to green. "It has no UI" is not an exemption.

     Truly nothing observable, like a CI tweak or a typo? Say so in
     "What & why" and ask a maintainer for the `no-visual-change` label. -->

### Before

<!-- The problem, as it exists on main right now. -->

### After

<!-- The same view or the same steps, with your change applied.
     Same window size, same theme, same data — a reviewer should be able to
     flip between the two and see only what you changed. -->

## How I tested it

<!-- The actual steps you ran, on which OS. Not "tested locally". -->

- OS:
- Steps:

## Discord (optional)

<!-- For the `employee of the month` role in our Discord when this merges.
     Join first so we can find you: https://discord.gg/SEDzP5ZPk5 -->

Discord:

## Checklist

- [ ] **Before and after evidence is attached above**, under both headings.
- [ ] `npm run typecheck` passes.
- [ ] `npm run test:focused` passes.
- [ ] `npm run build` succeeds.
- [ ] This PR is **one change**. Unrelated fixes belong in their own PR.
- [ ] I read the diff myself before opening this, and there is no debug output,
      commented-out code, or unrelated formatting churn in it.
- [ ] Any new UI derives from `DESIGN.md` / `tokens.ts` — no ad-hoc colors,
      spacing, or fonts.
- [ ] If I added art, it's my own or compatibly licensed, and listed in
      `ATTRIBUTION.md`.

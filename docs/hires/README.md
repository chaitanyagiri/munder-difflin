# Agent Gallery

A community gallery of **shareable hires** — portable agent role templates for the
[Munder Difflin](https://munderdiffl.in) multi-agent harness. Browse a role, download
its manifest, and import it in the app — its goal, model, flags, and token budget land
pre-filled (you always review before it spawns).

Static site: no build step, no framework, no trackers. `index.html` + `style.css` +
`app.js` + `manifests/`. The design mirrors munderdiffl.in's neo-brutalist landing page.

## Run it locally

```bash
cd site
python3 -m http.server 8080
# → http://localhost:8080
```

Note: each card's **⤓ download** button saves the `.json` locally — import it via the
app's *Add agent → import hire…* button, review every field, then spawn.

## Deploy

It's a static folder — GitHub Pages, Cloudflare Pages, Netlify, anything. For GitHub Pages:
push, then Settings → Pages → deploy from branch, folder `/site`.

## Add your hire

Manifests are just files. Start from any card's *view json*, follow the
[spec](spec/HIRE_SPEC.md), check it with the on-page validator, and import it via
the app's *Add agent → import hire…* button. A public submission queue is tracked
as a separate feature request (manifest-as-PR pipelines flood maintainers — the
intake design deserves its own discussion).

Maintainer flow for adding a curated hire:

1. Add `manifests/<slug>.hire.json`, append the filename to `manifests/index.json`.
2. Run `python3 scripts/build-data.py` (regenerates per-provider variants +
   `manifests-data.js`).
3. Commit.

## Model suggestions

`models.json` is the source of truth for the model suggestions in The Hiring Desk
(a manifest may use *any* model string — suggestions never validate, they only help).
When new models ship (e.g. `claude-fable-5`):

```bash
cd site
python3 scripts/build-data.py --sync-models   # scrape upstream's config.ts + merge
```

or just edit `models.json` by hand and run `python3 scripts/build-data.py`. Local
additions survive a sync (additive merge), so the site can suggest models before
upstream's picker knows about them.

Review bar: goals must be honest about what the agent does, no prompt-injection games,
flags must be flag-shaped (the schema enforces this), and `homepage` should link somewhere
real. Manifests can't name executables or carry shell syntax — by design.

## How importing works

Download a card's `.json`, then in the app open *Add agent → import hire…* and pick the
file. The app validates the manifest and pre-fills its Add-Agent modal. Import never
auto-spawns — a human reviews the final command and clicks spawn.

## License

MIT. Not affiliated with NBC's *The Office*, Dunder Mifflin, or (yet) the Munder Difflin
project — the integration PR lives in [`../app-pr`](../app-pr).

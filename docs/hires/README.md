# The Hiring Fair

A community gallery of **shareable hires** — portable agent role templates for the
[Munder Difflin](https://munderdiffl.in) multi-agent harness. Browse a role, click
**hire**, and it walks into your office with its goal, model, flags, and token budget
pre-filled (you always review before it spawns).

Static site: no build step, no framework, no trackers. `index.html` + `style.css` +
`app.js` + `manifests/`. The design mirrors munderdiffl.in's neo-brutalist landing page.

## Run it locally

```bash
cd site
python3 -m http.server 8080
# → http://localhost:8080
```

Note: the one-click **hire** button needs the site served over **https** (the app refuses
non-https manifest URLs by design). On localhost the button falls back to downloading the
`.json`, which you can import via the app's *Add agent → import hire…* button.

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

## How the deep link works

The hire button fires `munderdifflin://hire?src=<https-url-of-manifest>`. A Munder Difflin
install (with the shareable-hires integration) fetches the manifest (https only, 10s
timeout, 64 KB cap), validates it, and opens its Add-Agent modal pre-filled. Import never
auto-spawns — a human reviews the final command and clicks spawn.

## License

MIT. Not affiliated with NBC's *The Office*, Dunder Mifflin, or (yet) the Munder Difflin
project — the integration PR lives in [`../app-pr`](../app-pr).

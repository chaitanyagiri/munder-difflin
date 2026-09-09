# Bundled MemPalace

This directory feeds the `extraResources` rule in `electron-builder.yml`: at
package time, the contents of `resources/mempalace/<os>/` (win | mac | linux)
are copied to `<resourcesPath>/mempalace/` inside the installed app.

## Resolution order (see `src/main/memory.ts` `bin()`)

1. The user's `PATH` (`where` on Windows, login-shell `which` elsewhere).
2. Common install spots (`~/.local/bin`, Homebrew, pip's Scripts dir).
3. **The copy bundled here — strictly last.** A user's own install always
   wins; the bundled binary exists so a machine that has never seen Python
   or pip still gets semantic memory out of the box instead of the silent
   no-op degrade.

## What goes in `<os>/`

A **standalone** `mempalace` executable (`mempalace.exe` on Windows) that runs
with no Python installation present, plus the `LICENSE` file already placed in
each directory (MemPalace is MIT — the notice ships beside the binary).

> ⚠ **Do NOT drop in the executable from `~/.local/bin`.** On Windows that
> file is pip's `simple_launcher` shim: ~108 KB, embeds an absolute path to
> the machine's `python.exe`, and only appears to work because the backing
> environment exists locally. On a user's machine it dies immediately. The
> same is true of pipx/uv shims on macOS/Linux.

## Producing a real standalone binary

MemPalace is a Python package (MIT, https://github.com/MemPalace/mempalace,
deps include chromadb/numpy/tokenizers — expect a chunky artifact):

```bash
pip install mempalace pyinstaller
pyinstaller --onefile --name mempalace -p . $(python -c "import mempalace, os; print(os.path.join(os.path.dirname(mempalace.__file__), '__main__.py'))")
```

Then verify it is genuinely standalone before committing it:

```bash
# from a directory that is NOT on any Python path, ideally a machine/container
# without Python at all:
./dist/mempalace --version && ./dist/mempalace --help
```

One binary per platform/arch, built on (or cross-built for) that platform —
CI is the natural home for this step (`dist:mac` / `dist:win` / `dist:linux`).

## Semantic-mode caveat

`mempalace` pulls an embedding model on first semantic use (huggingface-hub).
The app initializes heuristics-only (`--no-llm`), so the default experience
stays fully local/offline; bundling does not change that either way.

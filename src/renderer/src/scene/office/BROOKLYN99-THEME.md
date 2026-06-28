# Brooklyn Nine-Nine — the 99th precinct office theme

A TV-show re-skin of the agent floor: the pixel office becomes the **99th precinct
bullpen**. It rides the pluggable office-theme system (`themeRegistry.ts`), so the
renderer engine — `TiledMapRenderer`, BFS pathfinding, camera, sprite animation — is
unchanged; only the per-theme **`ThemeConfig`** (map, seats, café, coffee, props, errands,
palette, **cast**, and an optional **flavor** line-pool) differs. The Office stays the
default; this theme ships behind an experimental flag, off.

## How to enable

1. **Settings → Office Theme** → toggle **"TV-show office themes (experimental)"** to **on**
   (config `tvShowOffices: true`).
2. In the picker, choose **Brooklyn Nine-Nine** (config `officeTheme: 'brooklyn99'`).
3. Confirm the switch. Both keys persist via `updateConfig`; on next launch the floor
   restores the saved theme (flag off ⇒ always the office).

Config keys (mirrored across `src/main/config.ts`, `src/preload/index.ts`,
`src/renderer/src/store/config.ts`):

| Key             | Type                           | Default    | Meaning |
|-----------------|--------------------------------|------------|---------|
| `tvShowOffices` | `boolean`                      | `false`    | Master flag — shows the theme picker; off ⇒ always the office |
| `officeTheme`   | `'office' \| 'brooklyn99' \| …` | `'office'` | Selected theme id (resolved by `getTheme`, office fallback) |

**Switching starts a fresh cast.** With live workers, a destructive confirm modal warns
that the current agents are retired — PTYs killed, terminals disposed, agents archived
through the normal lifecycle — before the new theme persists. The **god orchestrator (and
the prep assistant) carry over**; god's PTY is never touched. If a terminal won't close the
switch **aborts** and the old theme stays. With no workers the switch is instant.

## Cast

The shipped theme renders **Pam's original, license-clean Brooklyn-Nine-Nine likenesses** —
eight sprite sheets (`assets/sprites/brooklyn99/*.png`) produced by the B99 art generator
(`tools/b99-art/gen-b99-art.cjs`), sliced by `SpriteAdapter`, and bound in
`castBrooklyn99.ts` (`getB99CastFrames`). Office agents skin onto the Nine-Nine roster by
character key:

| Office role (seat)        | Nine-Nine character          | Blurb |
|---------------------------|------------------------------|-------|
| god / boss (`desk-ceo`)   | **Captain Raymond Holt**     | "Captain. Bone dry." |
| Jim                       | **Jake Peralta**             | "Detective. Cool cool cool." |
| Pam                       | **Amy Santiago**             | "Detective. Binder enthusiast." |
| Oscar                     | **Rosa Diaz**                | "Detective. Do not ask." |
| Kevin                     | **Charles Boyle**            | "Detective. Your best friend." |

Other office agents map to the spares — **Terry Jeffords** ("Sergeant. Loves yogurt."),
with **Hitchcock** ("Probably napping.") & **Scully** ("Almost lunchtime.") skinning the
quieter / idle / archived roles. The default skin is **Jake**.

## Floor flavor

The theme supplies its own `FloorFlavor` line pools (`cafeteriaLinesBrooklyn99.ts`); the
office omits `flavor` and keeps its own in-file lines. The Nine-Nine reskin covers:

- **Errand mutters** — what a detective thinks while running each idle errand (filing
  evidence, the perp walk, Terry's yogurt run), keyed by errand kind.
- **Gossip / suck-up / cheer** — what workers say with the boss out of earshot, the
  performative excellence when Holt is watching, and the line thrown over the shoulder
  after shipping a task.
- **Café banter** — solo break lines and multi-beat table exchanges, with the Jake↔Amy
  rapport and Holt's deadpan.

## The five core rooms

The featured five (human-picked), authored as zones in `brooklyn99.tmj`:

1. **The detective bullpen** (`bullpen` zone; desks `pc-1`…`pc-8`) — eight facing desks,
   the working heart of the floor; the TASKS board hangs over it.
2. **Captain Holt's glass office** (`holt-office` zone; `desk-ceo`) — the boss's corner
   office; god's domain, home to the god-only errands (plant, cigar at the window).
3. **The interrogation room** (`interrogation` zone) — the suspect's table behind the
   one-way glass; the precinct's signature room.
4. **The holding cell** (`holding-cell` zone) — the precinct's perp bench; the Nine-Nine
   flourish.
5. **The break room** (`break-room` zone) — the full coffee economy (mug rack → machine →
   sink), fridge, and shelf, plus the four café seats (`cafe-seat-1`…`4`).

Clickable props carry over from the office: **TASKS** (boards over the bullpen),
**SCHEDULES** (wall calendar), **CLOSING TIME** (corner clock). Idle errands — watering
plants, the water cooler, windows, fridge/shelf, bins, and the boss's cigar — are
re-anchored to the precinct's floor.

## Status & limitations

- **Fully bound, end-to-end.** Cast (`castBrooklyn99.ts`), floor flavor
  (`cafeteriaLinesBrooklyn99.ts`), and the precinct map (Oscar's `brooklyn99.tmj`) are all
  wired into `BROOKLYN99_THEME`. The precinct tileset (`brooklyn99-precinct.png`) is
  appended as `tilesets[3]` at `firstgid 2449` — that entry is what makes every `2449+`
  precinct gid render — and the desk-monitor stamp is rebound to the detective desk
  (off `2515`, on `2516`).
- **Palette is the office tokens by design.** Pam shipped no separate B99 palette; the
  precinct look comes entirely from her tileset, so `palette` deliberately reuses the
  office tones (the kanban note-status colors are unchanged).
- **Office fallback is load-bearing.** `getTheme` falls back to the office for any
  unknown/missing theme, so a bad bundle can never break the floor; `OFFICE_THEME` omits
  `flavor` and uses its in-file constants (regression-guarded, verified byte-identical).
- **In-app visual QA + screenshots are PENDING (human-gated).** The engine is
  type/build-green and the precinct gid range is verified (all `2449+` gids resolve, zero
  out-of-range); the floor renders the real B99 frames once the branch runs on a machine
  with a display. The Pixi canvas can't be captured headlessly, so live visual QA is a
  **PR-review item** — it does **not** block opening the PR.

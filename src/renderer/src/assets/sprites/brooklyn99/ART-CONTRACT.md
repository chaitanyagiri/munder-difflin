# Brooklyn Nine-Nine — Art Contract (v1)

**Author:** Pam (`pam-mqmv2u8e`, art lead) · **For:** Kevin (engine/cast wiring), Oscar (map/`.tmj`) · **Card:** `b99-art-assets`
**Status:** CONTRACT (posted first to unblock map + engine). Final pixels follow on branch `feat/b99-art`.

All art on this branch is **original, hand-authored pixel art that EVOKES** the show's
characters/rooms. No copyrighted game/show sprite is copied, traced, or reused. Generated
deterministically by `tools/b99-art/gen-b99-art.cjs` (pure Node `zlib`, zero deps) so every
pixel is attributable and reproducible — license-clean.

---

## 1. Character sprite sheets — the grid Kevin slices

Format that drops straight into `CharacterSprite` (`scene/office/CharacterSprite.ts`) and the
existing procedural cast scale (`portraitArt.ts` `SCENE_W=18`, `SCENE_H=32`, `CHAR_SCALE=1.08`,
seated leg-crop reads `frameW/frameH` from the texture).

| Property | Value |
|---|---|
| Frame size | **18 × 32 px** (W × H) — same as the procedural cast, so it's drop-in |
| Grid | **3 rows × 6 cols** |
| Sheet size | **108 × 96 px** (6·18 wide × 3·32 tall) |
| Background | transparent RGBA (alpha 0 outside the body) |
| Outline | `[38,34,46]` (matches the existing cast `OUTLINE`) |
| Foot anchor | feet on the **bottom edge** (sprite anchor is `0.5, 1`); ~1px ground margin; head near top |

**Rows (top → bottom)** — match `CharacterSprite.DIRECTION_ROW`:
- row 0 = facing **DOWN**
- row 1 = facing **UP**
- row 2 = facing **RIGHT**
- *left is engine-flipped from right* (`scale.x = -1`) — **no left row is drawn**.

**Cols (left → right):**
| col | name | pose |
|---|---|---|
| 0 | walk1 | **neutral stand / idle** (feet together) — `idle` uses col 0, so this MUST be the rest pose |
| 1 | walk2 | left-foot stride |
| 2 | walk3 | right-foot stride |
| 3 | type  | seated typing pose (hands forward/down) |
| 4 | read1 | reading pose A |
| 5 | read2 | reading pose B |

**Engine slice (per row, per col):**
```
frames[row][col] = new Texture({ source, frame: new Rectangle(col*18, row*32, 18, 32) })
// rows: down=0, up=1, right=2   cols: 0..5 as above
```
> Today `CharacterSprite.ANIM_FRAMES` only indexes cols 0–2 (`walk/type/read=[0,1,2,1]`,
> `idle=[0]`). Cols 3–5 are authored **now** so Kevin can later extend `ANIM_FRAMES`
> (e.g. `type:[3]`, `read:[4,5]`) **without re-cutting art**. Until then, cols 3–5 are simply
> unused — slicing all 6 is harmless.

**Files** → `src/renderer/src/assets/sprites/brooklyn99/<key>.png`:
`holt.png · jake.png · amy.png · rosa.png · terry.png · charles.png · hitchcock.png · scully.png`

**Casting (tunable, per god's dispatch):** god → Holt · Jim → Jake · **Pam(me) → Amy** ·
Oscar → Rosa · Kevin → Charles · Terry / Hitchcock / Scully = spare. Wiring (which agent maps
to which sheet) is Kevin's in `themeRegistry`/cast — the sheets are agent-agnostic.

### Per-character design (original silhouette + palette, evokes the show)
| key | reads as | hair / head | outfit (primary / accent) |
|---|---|---|---|
| holt | stern captain, older | bald, dark-grey fringe, glasses | charcoal NYPD captain suit / slate-blue tie |
| jake | boyish detective | brown messy short | navy henley + brown leather jacket / faded jeans |
| amy | organized, tidy | dark-brown low ponytail | teal blazer + white shirt / navy slacks |
| rosa | tough, guarded | long black wavy | black leather jacket / oxblood + black jeans |
| terry | big, muscular | bald | grey NYPD tee, broad build / navy suspenders |
| charles | soft, earnest | thinning brown | tan cardigan + olive shirt / brown |
| hitchcock | rumpled, lazy | bald, grey side fringe | open wrinkled tan shirt / coffee-stained |
| scully | rumpled, lazy | balding grey, glasses | pale-blue short-sleeve shirt / grey tie |

---

## 2. Custom tileset — `brooklyn99-precinct.png`

| Property | Value |
|---|---|
| Tile size | **16 × 16 px** (matches the office gid space the `.tmj` uses) |
| Columns | **16** (atlas width 256px) — same convention as a5/interiors atlases |
| Rows | 6 → atlas **256 × 96 px**, `tilecount = 96` |
| File | `src/renderer/src/assets/tilesets/brooklyn99-precinct.png` |

Kevin adds the `TilesetEntry` (assigns `firstgid`; `image:'b99'`, `imagewidth:256`,
`imageheight:96`, `tilewidth:16`, `tileheight:16`, `columns:16`, `tilecount:96`). Oscar
references each element in `brooklyn99.tmj` by **`firstgid + localIndex`** below.

**GID map — local tile index (0-based, row-major in the 16-col atlas) → element:**

| local idx | element | piece |
|---|---|---|
| 0 | holding-cell-bars | vertical bars |
| 1 | holding-cell-bars | horizontal bar (top) |
| 2 | holding-cell-bars | corner (TL) |
| 3 | holding-cell-bars | corner (TR) |
| 4 | holding-cell-bars | barred door |
| 5 | holding-cell | concrete floor |
| 16 | interrogation-table | table left |
| 17 | interrogation-table | table right |
| 18 | interrogation | metal chair |
| 19 | one-way-mirror | mirror left |
| 20 | one-way-mirror | mirror right |
| 21 | one-way-mirror | frame |
| 32 | holt-glass-wall | glass panel |
| 33 | holt-glass-wall | glass frame (vertical) |
| 34 | holt-glass-wall | glass door |
| 35 | holt-glass-wall | glass corner |
| 36 | holt-office | nameplate desk front |
| 48 | breakroom | counter |
| 49 | breakroom | fridge (top) |
| 50 | breakroom | fridge (bottom) |
| 51 | breakroom | microwave |
| 52 | breakroom | sink |
| 53 | breakroom | coffee machine |
| 64 | detective-desk | desk top-left |
| 65 | detective-desk | desk top-right |
| 66 | detective-desk | monitor (off) |
| 67 | detective-desk | monitor (on) |
| 68 | detective-desk | desk chair |
| 69 | detective-desk | case-folder stack |
| 80 | case-board | corkboard |
| 81 | case-board | corkboard + photos |
| 82 | case-board | corkboard + red string |
| 83 | case-board | whiteboard |
| 84 | case-board | whiteboard + text |
| 85 | case-board | wanted poster |

**Palette:** precinct teal-grey walls, warm-wood trim, NYPD-navy accents, evidence cork +
red string, brushed-steel interrogation furniture.

> If Oscar needs an element split differently (e.g. a 2×2 desk stamp vs the 1×N pieces above),
> ping me on `conv-b99-office` and I'll re-cut — the generator makes that cheap.

---

## 3. Definition of done
- [x] Contract posted (this file) — unblocks Oscar (map) + Kevin (engine)
- [ ] 8 character sheets (`brooklyn99/*.png`, 108×96 each)
- [ ] `brooklyn99-precinct.png` tileset (256×96)
- [ ] License-clean attestation (all original, generator-authored)

Boundaries respected: NEW files only (no edits to shared TS); does **not** touch
`themeRegistry`/cast wiring (Kevin) or `brooklyn99.tmj` (Oscar).

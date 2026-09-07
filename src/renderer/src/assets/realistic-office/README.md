# Realistic office artwork

Generated September 7, 2026 with the built-in Imagegen tool. These assets are
bundled locally; rendering does not call any image service at runtime.

| Asset | Dimensions | Use |
| --- | --- | --- |
| `office-daylight.png` | 1560 × 1008 | Default office room, furniture, lighting and materials |
| `employees-front.png` | 1536 × 1024 | Front-facing workers and card portraits |
| `employees-back.png` | 1536 × 1024 | Back-facing standing and walking workers |
| `employees-side.png` | 1536 × 1024 | Profile walking, mirrored for left-facing movement |
| `employees-seated.png` | 1536 × 1024 | Bent-arm seated poses facing monitors |

All employee sheets use five columns and three rows in `OFFICE_CAST` order.
The generated files contain an opaque neutral preview matte. `spriteMatte.ts`
removes the edge-connected bright background once during import while retaining
enclosed light clothing. The original generated files stay unchanged. Actual
alpha cutouts and logical 18 × 32 frame dimensions are verified in the browser.
Walking articulation and subtle breathing are prepared once at eight texels per
world pixel; all frames are shared across instances of the same character.

The room is a photographic **pre-rendered 2D background**, not a freely rotatable
3D model. It retains the existing room arrangement. The existing Tiled map owns
collision and pathfinding; `realisticOfficeLayout.ts` registers live monitor
surfaces and seated figures against the new furniture. The alternate Brooklyn
map continues to render its existing tiles. No agent execution, terminal,
task-routing or persistence behavior is changed.

The room reference was an in-engine render of the repository's existing office
map and licensed tilesets. Existing credits are retained in `../ATTRIBUTION.md`.
Production prompts are recorded in `generation-prompts.json`.

Validation: TypeScript checks, production build, 14 focused tests, and a browser
render of the actual `OfficeFloor` with 15 seeded agents. Browser checks cover
concurrent status updates during image loading, seat arrival, selection,
walking, transparent cutouts, frame dimensions, resizing, and a round trip to
the alternate theme. The preview uses seeded agents and mocked desktop events;
it does not start real agent sessions.

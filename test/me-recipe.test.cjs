'use strict';
/**
 * Character-creator recipe tests. Self-contained, no test framework — run with
 * `node test/me-recipe.test.cjs` (mirrors test/agent-provider.test.cjs).
 *
 * Two halves, and the second is the one that matters. The first exercises
 * src/shared/meRecipe.ts as data: validation, the catalogues, the bridge to the
 * painter. The second RENDERS — `compose()` in portraitArt.ts writes into a
 * typed array and touches no DOM (only the scaled blit does), so the real
 * painter can be driven headlessly here and asked whether a recipe actually
 * produced different pixels. That is what lets this file verify the three
 * card/floor traps and the three never-rendered engine values for real, instead
 * of asserting that we passed the right arguments and hoping.
 *
 * Both modules are TypeScript, so they are transpiled with the bundled compiler
 * into a temp dir and required — portraitArt.ts's only import is `import type`,
 * which transpiles away to nothing, so it loads with no dependencies.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'merecipe-'));

function load(relPath, outName) {
  const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  const file = path.join(out, `${outName}.js`);
  fs.writeFileSync(file, js, 'utf8');
  return require(file);
}

const me = load('src/shared/meRecipe.ts', 'meRecipe');
const art = load('src/renderer/src/scene/office/portraitArt.ts', 'portraitArt');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.log(`  ✗ ${name}\n     ${err && err.message}`); }
}

// ─── render helpers ──────────────────────────────────────────────────────────
const PW = art.PORTRAIT_W, PH = art.PORTRAIT_H, SW = art.SCENE_W;

const portrait = (recipe) => art.composeRecipeBuf(me.toPainterRecipe(recipe));
const recipe = (patch) => ({ ...me.DEFAULT_ME_RECIPE, ...patch });

/** Opaque pixels in a buffer — a cheap "did anything get drawn" signal. */
function inked(buf) {
  let n = 0;
  for (let i = 3; i < buf.length; i += 4) if (buf[i] !== 0) n++;
  return n;
}

function same(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Rows [y0,y1) of a buffer, as a plain array — for comparing across canvas heights. */
function rows(buf, width, y0, y1) {
  return Array.from(buf.slice(y0 * width * 4, y1 * width * 4));
}

/**
 * How far hair hangs down one side, in rows.
 *
 * Reads the OUTER column (x=3, just past the head box at x=4..13) and only rows
 * 6..17, which is the band where a long style drapes and nothing else is drawn.
 * The obvious metric — lowest opaque pixel anywhere — is useless here: it finds
 * the shoes at row 31 on every sprite, so it reports "equal" whatever the hair
 * is doing.
 */
function hairDrapeDepth(buf, width) {
  let last = -1;
  for (let y = 6; y <= 17; y++) if (buf[(y * width + 3) * 4 + 3] !== 0) last = y;
  return last;
}

console.log('character-creator recipe tests');

// ─── validation: the TypeError guard ─────────────────────────────────────────

test('an unrecognised skin falls back instead of reaching the painter', () => {
  // The painter types Recipe.skin as plain `string` and dereferences
  // SKIN[skin].base, so a bad value is a TypeError inside the render loop.
  const r = me.normalizeMeRecipe({ ...me.DEFAULT_ME_RECIPE, skin: 'chartreuse' });
  assert.strictEqual(r.skin, 'light', 'fell back to the default tone');
  assert.doesNotThrow(() => portrait(r), 'and the painter survives it');
});

test('validation is per field — one bad value does not discard the character', () => {
  const r = me.normalizeMeRecipe({
    skin: 'dark',
    build: 'broad',
    hair: 'a-tile-from-a-newer-build',
    hairColor: 'not-a-colour',
    glasses: 'yes',
    facial: 'goatee',
    garment: 'polo',
    garmentColor: '#4F8F88',
    brow: 'soft', mouth: 'grin', blush: true, lashes: true
  });
  assert.strictEqual(r.hair, me.DEFAULT_ME_RECIPE.hair, 'unknown tile → default');
  assert.strictEqual(r.hairColor, me.DEFAULT_ME_RECIPE.hairColor, 'bad hex → default');
  assert.strictEqual(r.glasses, false, 'non-boolean → default');
  // …and everything valid is kept, which is the actual point.
  assert.strictEqual(r.skin, 'dark');
  assert.strictEqual(r.build, 'broad');
  assert.strictEqual(r.facial, 'goatee');
  assert.strictEqual(r.garment, 'polo');
  assert.strictEqual(r.garmentColor, '#4f8f88', 'hex normalised to lower case');
  assert.strictEqual(r.mouth, 'grin');
  assert.strictEqual(r.lashes, true);
});

test('normalize accepts junk of any shape without throwing', () => {
  for (const junk of [null, undefined, 0, '', [], 'nope', { skin: null }]) {
    const r = me.normalizeMeRecipe(junk);
    assert.deepStrictEqual(r, me.DEFAULT_ME_RECIPE, `${JSON.stringify(junk)} → default`);
  }
});

test('the default is Michael and round-trips through validation and JSON', () => {
  const d = me.DEFAULT_ME_RECIPE;
  assert.deepStrictEqual(me.normalizeMeRecipe(d), d);
  assert.deepStrictEqual(me.normalizeMeRecipe(JSON.parse(JSON.stringify(d))), d);
  const p = me.toPainterRecipe(d);
  assert.deepStrictEqual(p.hairc, [58, 42, 28], "Michael's hair");
  assert.deepStrictEqual(p.c1, [58, 63, 74], "Michael's suit");
  assert.strictEqual(p.hair, 'styleShort');
  assert.deepStrictEqual(p.hairargs, { part: 'L' });
  assert.strictEqual(p.mouth, 'smile');
});

test("the dialog opens with real swatches selected, not 'Custom'", () => {
  // If the defaults were not themselves palette entries, opening the creator on
  // Michael would show no swatch selected in either colour row.
  assert.ok(me.HAIR_COLORS.some((c) => c.id === me.DEFAULT_ME_RECIPE.hairColor), 'hair');
  assert.ok(me.GARMENT_COLORS.some((c) => c.id === me.DEFAULT_ME_RECIPE.garmentColor), 'garment');
});

// ─── fix 1: the messy tile must pin its length ───────────────────────────────

test("FIX 1 — every hair tile's arguments are fully specified", () => {
  // The painter's per-style defaults are not all consistent between the front
  // and back views, so no tile may rely on one.
  const messy = me.HAIR_TILES.find((t) => t.id === 'messy');
  assert.ok(messy.args && typeof messy.args.length === 'number', 'messy pins `length`');
  for (const t of me.HAIR_TILES) {
    if (t.style === 'styleFrame') {
      assert.ok(t.args && typeof t.args.length === 'number' && typeof t.args.vol === 'number',
        `${t.id} pins length + vol`);
    }
  }
});

test('FIX 1 (rendered) — messy hair is the same length from the front and the back', () => {
  // The painter defaults styleMessy's length to 8 from the front and 9 from the
  // back. Left unset, the character's hair changes length when it turns around.
  const p = me.toPainterRecipe(recipe({ hair: 'messy' }));
  const frames = art.recipeSceneFrameBufs(p);
  assert.strictEqual(
    hairDrapeDepth(frames.front[0], SW),
    hairDrapeDepth(frames.back[0], SW),
    'the hair hangs to the same row whichever way the character faces'
  );

  // Prove the trap is real rather than trusting the comment: the same style with
  // no length DOES disagree across the two views.
  const unpinned = { ...p, hairargs: {} };
  const bad = art.recipeSceneFrameBufs(unpinned);
  assert.notStrictEqual(
    hairDrapeDepth(bad.front[0], SW),
    hairDrapeDepth(bad.back[0], SW),
    'an unpinned messy length really does disagree — the fix is load-bearing'
  );
});

// ─── fix 2: suit and dress shirt always get a tie ────────────────────────────

test('FIX 2 — the two garments that read a tie always get one', () => {
  for (const g of me.GARMENTS) {
    const p = me.toPainterRecipe(recipe({ garment: g.id }));
    if (g.needsTie) assert.ok(Array.isArray(p.tie), `${g.id} carries a tie colour`);
    else assert.strictEqual(p.tie, undefined, `${g.id} does not`);
  }
  assert.deepStrictEqual(
    me.GARMENTS.filter((g) => g.needsTie).map((g) => g.id),
    ['suit', 'dressShirt'],
    'exactly the two the painter reads a tie for'
  );
});

test('FIX 2 (rendered) — a tie-less suit really does differ, card vs floor', () => {
  // Without a tie the painter draws a white placket on the 18x28 card and plain
  // jacket colour on the 18x32 floor sprite: a card/floor mismatch inside the
  // one feature whose premise is card/floor parity.
  const tied = me.toPainterRecipe(recipe({ garment: 'suit' }));
  const bare = { ...tied };
  delete bare.tie;
  assert.ok(!same(art.composeRecipeBuf(tied), art.composeRecipeBuf(bare)),
    'the tie is visible on the card, so leaving it unset would be visible too');
});

// ─── fix 3: the swatches avoid the ends of the ramp ──────────────────────────

test('FIX 3 — no swatch collapses the three-tone shading ramp', () => {
  // The painter derives highlight/shadow by multiplying by 1.22 / 0.68 and
  // clamping, so #000000 and #ffffff render flat. Rather than assert "not black",
  // reproduce the ramp and require three distinct tones.
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  const flat = (hex) => {
    const c = me.hexToRgb(hex);
    const hi = c.map((v) => clamp(v * 1.22));
    const sh = c.map((v) => clamp(v * 0.68));
    return hi.join() === c.join() || sh.join() === c.join();
  };
  for (const s of [...me.HAIR_COLORS, ...me.GARMENT_COLORS]) {
    assert.ok(!flat(s.id), `${s.label} (${s.id}) keeps a highlight and a shadow`);
  }
});

test('FIX 3 — the palettes still cover the ends of their range', () => {
  // The fix must not have quietly removed black and white from the palette.
  assert.ok(me.HAIR_COLORS.some((c) => c.label === 'Black'), 'hair has a black');
  assert.ok(me.HAIR_COLORS.some((c) => c.label === 'White'), 'hair has a white');
  assert.ok(me.GARMENT_COLORS.some((c) => c.label === 'Off-white'), 'garments have an off-white');
});

// ─── the three values no shipped recipe has ever rendered ────────────────────

test("latent values render — skin 'brown', mouth 'grin', facial 'goatee'", () => {
  const base = portrait(me.DEFAULT_ME_RECIPE);
  for (const [label, patch] of [
    ["skin 'brown'", { skin: 'brown' }],
    ["mouth 'grin'", { mouth: 'grin' }],
    ["facial 'goatee'", { facial: 'goatee' }],
    ['the bald fringe variant', { hair: 'baldFringe' }]
  ]) {
    const buf = portrait(recipe(patch));
    assert.ok(inked(buf) > 0, `${label} draws something`);
    assert.ok(!same(buf, base), `${label} actually changes the portrait`);
  }
});

test("the bald fringe is distinct from plain bald, not a silent no-op", () => {
  assert.ok(!same(portrait(recipe({ hair: 'bald' })), portrait(recipe({ hair: 'baldFringe' }))));
});

// ─── the catalogue renders, all of it ────────────────────────────────────────

test('every option in every control composes at both sizes', () => {
  const groups = [
    ['skin', me.SKIN_TONES], ['build', me.BUILDS], ['hair', me.HAIR_TILES],
    ['facial', me.FACIAL_HAIR], ['garment', me.GARMENTS],
    ['brow', me.BROWS], ['mouth', me.MOUTHS]
  ];
  for (const [field, options] of groups) {
    for (const o of options) {
      const p = me.toPainterRecipe(recipe({ [field]: o.id }));
      const card = art.composeRecipeBuf(p);
      assert.ok(inked(card) > 100, `${field}=${o.id} paints a card`);
      const frames = art.recipeSceneFrameBufs(p);
      assert.strictEqual(frames.front.length, 3, `${field}=${o.id} has 3 walk phases`);
      assert.strictEqual(frames.back.length, 3, `${field}=${o.id} has 3 back phases`);
      for (const f of [...frames.front, ...frames.back]) {
        assert.ok(inked(f) > 100, `${field}=${o.id} paints every frame`);
      }
    }
  }
  for (const c of [...me.HAIR_COLORS, ...me.GARMENT_COLORS]) {
    const field = me.HAIR_COLORS.includes(c) ? 'hairColor' : 'garmentColor';
    assert.ok(inked(portrait(recipe({ [field]: c.id }))) > 100, `${field}=${c.id}`);
  }
});

test('each hair tile is visually distinct from every other', () => {
  // Two tiles that render identically are a picker with a dead entry in it.
  const seen = new Map();
  for (const t of me.HAIR_TILES) {
    const key = Buffer.from(portrait(recipe({ hair: t.id }))).toString('base64');
    assert.ok(!seen.has(key), `${t.id} differs from ${seen.get(key)}`);
    seen.set(key, t.id);
  }
});

// ─── card / floor parity for a CUSTOM recipe ─────────────────────────────────

test('a custom recipe paints the same head on the card and on the floor', () => {
  // drawHeadGroup is shared between compose() and the front-facing scene sprite,
  // so this should hold for any recipe — including one the engine has never seen.
  const p = me.toPainterRecipe(recipe({
    skin: 'brown', build: 'broad', hair: 'curly', hairColor: '#b5613a',
    glasses: true, facial: 'goatee', garment: 'polo', garmentColor: '#4f8f88',
    brow: 'raised', mouth: 'grin', blush: true, lashes: true
  }));
  const card = art.composeRecipeBuf(p);
  const floor = art.recipeSceneFrameBufs(p).front[0];
  assert.strictEqual(PW, SW, 'both canvases are the same width');
  // Rows 0-16 are the head group — hair, face, glasses, facial hair. Row 17 is
  // the neck, where a shoulders-up bust and a standing torso legitimately differ
  // (and where the outline pass starts reacting to what is below), so the
  // comparison stops there rather than pretending the whole sprite should match.
  assert.deepStrictEqual(rows(card, PW, 0, 17), rows(floor, SW, 0, 17));
});

test('the walk phases differ only below the waist', () => {
  const p = me.toPainterRecipe(me.DEFAULT_ME_RECIPE);
  const [stand, stepL, stepR] = art.recipeSceneFrameBufs(p).front;
  assert.deepStrictEqual(rows(stand, SW, 0, 25), rows(stepL, SW, 0, 25), 'head + torso hold');
  assert.deepStrictEqual(rows(stand, SW, 0, 25), rows(stepR, SW, 0, 25));
  assert.ok(!same(stand, stepL) && !same(stand, stepR) && !same(stepL, stepR),
    'but the feet really move — three distinct frames');
});

// ─── surprise me ─────────────────────────────────────────────────────────────

test('Surprise me always produces a valid, renderable character', () => {
  // Pinned sequences rather than Math.random: a randomiser checked only by eye
  // is one whose bias nobody notices.
  for (const seed of [0, 0.999999, 0.5, 0.25, 0.75]) {
    const r = me.randomMeRecipe(() => seed);
    assert.deepStrictEqual(me.normalizeMeRecipe(r), r, `rand()=${seed} is already valid`);
    assert.ok(inked(portrait(r)) > 100, `rand()=${seed} renders`);
  }
  let i = 0;
  const cycle = () => ((i = (i + 7) % 97), i / 97);
  for (let n = 0; n < 200; n++) {
    const r = me.randomMeRecipe(cycle);
    assert.deepStrictEqual(me.normalizeMeRecipe(r), r, 'stays inside the catalogue');
  }
});

test('Surprise me reaches the whole catalogue, not a corner of it', () => {
  const rnd = (() => { let s = 1; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; })();
  const hits = { skin: new Set(), hair: new Set(), garment: new Set(), facial: new Set() };
  for (let n = 0; n < 2000; n++) {
    const r = me.randomMeRecipe(rnd);
    for (const k of Object.keys(hits)) hits[k].add(r[k]);
  }
  assert.strictEqual(hits.skin.size, me.SKIN_TONES.length, 'every skin tone');
  assert.strictEqual(hits.hair.size, me.HAIR_TILES.length, 'every hair tile');
  assert.strictEqual(hits.garment.size, me.GARMENTS.length, 'every garment');
  assert.strictEqual(hits.facial.size, me.FACIAL_HAIR.length, 'every facial-hair option');
});

// ─── the never-evicting-cache trap ───────────────────────────────────────────

test('editing and reverting returns the ORIGINAL character, not a pinned one', () => {
  // The cast's caches are keyed by character name and never evict — right for a
  // recipe that cannot change, and the exact trap a live-edited one falls into.
  // The portrait path therefore caches nothing at all: this walks a recipe
  // through several edits and back, and requires the result to be byte-identical
  // to where it started. A cache that pinned the first version would pass; one
  // that pinned a LATER version, or that keyed on something stale, would not.
  const start = portrait(me.DEFAULT_ME_RECIPE);
  let cur = me.DEFAULT_ME_RECIPE;
  for (const patch of [{ hair: 'spiky' }, { skin: 'dark' }, { garment: 'polo' }, { glasses: true }]) {
    cur = { ...cur, ...patch };
    assert.ok(!same(portrait(cur), start), `${JSON.stringify(patch)} repainted`);
  }
  assert.ok(same(portrait(me.DEFAULT_ME_RECIPE), start), 'and reverting is exact');
});

test('the recipe cache key is stable for equal recipes and differs for unequal ones', () => {
  // getRecipeFrames (meCharacter.ts) keys its texture cache on this serialisation,
  // so a key that varied between two identical recipes would rebuild GPU textures
  // on every repaint, and one that collided would show the wrong character.
  const key = (r) => JSON.stringify(me.toPainterRecipe(r));
  const a = recipe({ hair: 'curly', skin: 'tan' });
  assert.strictEqual(key(a), key({ ...a }), 'field order does not disturb the key');
  assert.strictEqual(key(a), key({ ...a, hair: 'curly' }), 'a no-op edit is a cache HIT');
  assert.notStrictEqual(key(a), key({ ...a, skin: 'dark' }), 'a real edit is a cache MISS');
  // Two recipes that differ only in a field the painter ignores for this garment
  // must still be one key — otherwise the cache misses on edits that draw nothing.
  const seen = new Set(me.HAIR_TILES.map((t) => key(recipe({ hair: t.id }))));
  assert.strictEqual(seen.size, me.HAIR_TILES.length, 'every hair tile keys distinctly');
});

// ─── the shape of the control set ────────────────────────────────────────────

test('the catalogue matches the curated v1 control set', () => {
  assert.strictEqual(me.SKIN_TONES.length, 4);
  assert.strictEqual(me.BUILDS.length, 2);
  assert.strictEqual(me.HAIR_TILES.length, 13);
  assert.strictEqual(me.HAIR_COLORS.length, 11);
  assert.strictEqual(me.FACIAL_HAIR.length, 5);
  assert.strictEqual(me.GARMENTS.length, 6);
  assert.strictEqual(me.GARMENT_COLORS.length, 12);
  assert.strictEqual(me.BROWS.length, 4);
  assert.strictEqual(me.MOUTHS.length, 4);
});

test('excluded dimensions stay excluded from the persisted shape', () => {
  // pants / c2 / a tie control / hair-shape sliders are all out of v1.
  const keys = Object.keys(me.DEFAULT_ME_RECIPE).sort();
  assert.deepStrictEqual(keys, [
    'blush', 'brow', 'build', 'facial', 'garment', 'garmentColor',
    'glasses', 'hair', 'hairColor', 'lashes', 'mouth', 'skin'
  ]);
  const p = me.toPainterRecipe(me.DEFAULT_ME_RECIPE);
  assert.strictEqual(p.pants, undefined, 'no pants field reaches the painter');
  assert.strictEqual(p.c2, undefined, 'no c2 accent reaches the painter');
});

test('hex conversion round-trips every swatch', () => {
  for (const s of [...me.HAIR_COLORS, ...me.GARMENT_COLORS, { id: me.DEFAULT_TIE_COLOR }]) {
    assert.strictEqual(me.rgbToHex(me.hexToRgb(s.id)), s.id);
  }
  assert.ok(me.isHexColor('#AABBCC') && !me.isHexColor('#abc') && !me.isHexColor('abcdef'));
});

// ─── a PERSISTED recipe is untrusted input ───────────────────────────────────
/**
 * A saved recipe outlives the version that wrote it. It sits in userData, loads
 * into every hive including brand-new ones, and can carry a value this build has
 * since retired — or one a user typed by hand, since it is small, legible JSON.
 * The painter indexes its tables by those strings, so an unhandled value is a
 * TypeError mid-draw, which on the cold-boot path means an app that opens to a
 * blank screen with a stack trace nobody sees.
 *
 * `toPainterRecipe` normalizes on the way in, so this holds today. These pin it,
 * because the failure it prevents costs a debugging session every time.
 */
test('the exact recipe persisted by the first real user renders', () => {
  // Verbatim from Gary's config.json after he customized Michael (md-36 verify),
  // which is the state a cold start was reported blank on.
  const persisted = {
    skin: 'tan', build: 'regular', hair: 'messy', hairColor: '#3a2a1c',
    glasses: false, facial: 'none', garment: 'suit', garmentColor: '#7a3c50',
    brow: 'raised', mouth: 'grin', blush: true, lashes: false
  };
  assert.deepStrictEqual(me.normalizeMeRecipe(persisted), persisted,
    'every field is a real catalogue value — normalize must not rewrite any of them');
  assert.ok(inked(portrait(persisted)) > 0, 'it has to actually draw something');
});

test('a retired or hand-edited value falls back instead of throwing', () => {
  for (const bad of [
    { skin: 'chartreuse' }, { hair: 'mohawk' }, { garment: 'spacesuit' },
    { brow: 'quizzical' }, { mouth: 'smirk' }, { build: 'colossal' },
    { hairColor: 'not-a-hex' }, { garmentColor: '#xyz' }, { facial: 'muttonchops' }
  ]) {
    const field = Object.keys(bad)[0];
    const r = { ...me.DEFAULT_ME_RECIPE, ...bad };
    assert.doesNotThrow(() => portrait(r), `${field}=${bad[field]} must not throw`);
    assert.ok(inked(portrait(r)) > 0, `${field}=${bad[field]} must still draw a character`);
    assert.notStrictEqual(me.normalizeMeRecipe(r)[field], bad[field],
      `${field} must be replaced by a known value, not passed through`);
  }
});

test('a recipe missing fields entirely, or not an object at all, still renders', () => {
  // What a config written by an OLDER build looks like: fields that did not exist
  // yet are simply absent. And what a corrupted one looks like.
  for (const partial of [{}, { skin: 'tan' }, null, undefined, 'nonsense', 42, []]) {
    assert.doesNotThrow(() => portrait(partial), `${JSON.stringify(partial)} must not throw`);
    assert.ok(inked(portrait(partial)) > 0, `${JSON.stringify(partial)} must still draw`);
  }
});

// ─── "Surprise me" is a curated randomiser, not a uniform one ────────────────
/**
 * The randomiser takes an injectable `rand` precisely so its bias can be
 * measured rather than eyeballed, and one entry had never been measured: facial
 * hair was a uniform pick over a five-entry list containing 'none', so four in
 * five random characters came out bearded — a ratio nobody chose, sitting next
 * to three deliberately tuned probabilities.
 */
test('facial hair is tuned like its neighbours, not left to catalogue length', () => {
  let bearded = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    // A real PRNG, seeded, rather than a canned sequence: the function calls
    // rand() a varying number of times, so a fixed script would silently
    // measure the wrong call.
    let seed = i * 2654435761 % 4294967296;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    if (me.randomMeRecipe(rand).facial !== 'none') bearded++;
  }
  const p = bearded / N;
  assert.ok(p > 0.25 && p < 0.45,
    `P(facial hair) should sit near the tuned 0.35, got ${p.toFixed(3)} — 0.8 was the `
    + 'uniform-over-five bug this pins');
});

test('every randomised value is one the painter can actually draw', () => {
  for (let i = 0; i < 500; i++) {
    let seed = (i + 1) * 48271 % 2147483647;
    const rand = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    const r = me.randomMeRecipe(rand);
    // normalize is the arbiter of "valid": if it rewrites anything, the
    // randomiser produced something outside the catalogue.
    assert.deepStrictEqual(me.normalizeMeRecipe(r), r, `run ${i} produced an invalid recipe`);
    assert.ok(inked(portrait(r)) > 0, `run ${i} drew nothing`);
  }
});

/**
 * The bridge's whole justification is that a checked assignment fails the build
 * when the painter and the shared vocabulary drift. It shipped with `as Recipe`
 * on that line, which suppresses exactly that error — the guard the file's
 * doc-block promised had never once been able to fire. A cast here is not a
 * style question; it silently retracts the guarantee, so pin its absence.
 */
test('the painter bridge asserts nothing away', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/src/scene/office/meCharacter.ts'), 'utf8');
  const fn = src.slice(src.indexOf('export function toRecipe'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(!/\bas Recipe\b/.test(body),
    'toRecipe must assign, not assert: `as Recipe` suppresses the drift error this bridge exists to raise');
  assert.ok(/const r: Recipe = toShapedRecipe\(me\);/.test(body),
    'the checked assignment is the guard; if it changes shape, say so deliberately');
});

console.log(failures === 0 ? '\nall passed' : `\n${failures} failing`);
process.exit(failures === 0 ? 0 : 1);

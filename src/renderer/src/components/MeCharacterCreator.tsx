import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { SpritePortrait } from './SpritePortrait';
import { SCENE_W, SCENE_H, recipeSceneFrameBufs } from '@/scene/office/portraitArt';
import { toRecipe } from '@/scene/office/meCharacter';
import {
  DEFAULT_ME_RECIPE, SKIN_TONES, BUILDS, HAIR_TILES, HAIR_COLORS,
  FACIAL_HAIR, GARMENTS, GARMENT_COLORS, BROWS, MOUTHS,
  normalizeMeRecipe, randomMeRecipe, isHexColor,
  type MeRecipe
} from '@shared/meRecipe';

export interface MeCharacterCreatorProps {
  /** The saved character, or null when the user has never opened this before. */
  recipe: MeRecipe | null;
  onSave: (recipe: MeRecipe) => void;
  onClose: () => void;
}

/**
 * "Make Michael yours" — the character creator.
 *
 * OPENS ON MICHAEL, ALWAYS. Not on a blank or neutral base: every intermediate
 * state then looks finished (change two things and stop, and you have
 * Michael-with-your-hair rather than a half-made person), and cancelling is
 * genuinely free because the starting point is what you already had.
 *
 * The controls are eight in four pairs, with the four expression controls behind
 * a disclosure. That split is not arbitrary — brow, mouth, blush and lashes are
 * two or three pixels each at this size, so they read as personality rather than
 * likeness, and putting them in the primary flow would nearly double its length
 * for almost no gain in "is that me".
 */
export function MeCharacterCreator({ recipe, onSave, onClose }: MeCharacterCreatorProps) {
  const [me, setMe] = useState<MeRecipe>(() => normalizeMeRecipe(recipe ?? DEFAULT_ME_RECIPE));
  const [expressionOpen, setExpressionOpen] = useState(false);

  const set = <K extends keyof MeRecipe>(key: K, value: MeRecipe[K]) =>
    setMe((prev) => ({ ...prev, [key]: value }));

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(26, 19, 32, 0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 600
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: 720, maxWidth: '95vw' }}>
        <PixelPanel variant="dialog" title="MAKE MICHAEL YOURS" style={{ padding: 16 }} noPadding>
          <div style={{
            display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 200px',
            gap: 16, padding: 16, maxHeight: '86vh', overflowY: 'auto'
          }}>
            {/* ── the controls: four groups of two ───────────────────────── */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
              <Group label="Basics">
                <Field label="Skin">
                  <Tiles
                    options={SKIN_TONES}
                    value={me.skin}
                    onPick={(id) => set('skin', id)}
                    render={(o) => <Mini me={{ ...me, skin: o.id }} />}
                  />
                </Field>
                <Field label="Build">
                  <Tiles
                    options={BUILDS}
                    value={me.build}
                    onPick={(id) => set('build', id)}
                    render={(o) => <Mini me={{ ...me, build: o.id }} />}
                    showLabels
                  />
                </Field>
              </Group>

              <Group label="Hair">
                <Field label="Style">
                  <Tiles
                    options={HAIR_TILES}
                    value={me.hair}
                    onPick={(id) => set('hair', id)}
                    render={(o) => <Mini me={{ ...me, hair: o.id }} />}
                  />
                </Field>
                <Field label="Colour">
                  <Swatches
                    options={HAIR_COLORS}
                    value={me.hairColor}
                    onPick={(hex) => set('hairColor', hex)}
                  />
                </Field>
              </Group>

              <Group label="Face">
                <Field label="Glasses">
                  <Toggle value={me.glasses} onChange={(v) => set('glasses', v)} />
                </Field>
                <Field label="Facial hair">
                  <Tiles
                    options={FACIAL_HAIR}
                    value={me.facial}
                    onPick={(id) => set('facial', id)}
                    render={(o) => <Mini me={{ ...me, facial: o.id }} />}
                  />
                </Field>
              </Group>

              <Group label="Outfit">
                <Field label="Garment">
                  <Tiles
                    options={GARMENTS}
                    value={me.garment}
                    onPick={(id) => set('garment', id)}
                    render={(o) => <Mini me={{ ...me, garment: o.id }} />}
                  />
                </Field>
                <Field label="Colour">
                  <Swatches
                    options={GARMENT_COLORS}
                    value={me.garmentColor}
                    onPick={(hex) => set('garmentColor', hex)}
                  />
                </Field>
              </Group>

              {/* Collapsed by design — invisible to the people who want to be
                  done, one click away for the people who want to fiddle. */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <button
                  type="button"
                  onClick={() => setExpressionOpen((v) => !v)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                    fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '12px',
                    color: 'var(--cth-ink-900)', textTransform: 'uppercase'
                  }}
                >
                  <span>{expressionOpen ? '▾' : '▸'}</span>
                  <span>Expression</span>
                  <span style={{
                    fontFamily: 'inherit', fontSize: 11, textTransform: 'none',
                    color: 'var(--cth-ink-500)'
                  }}>4 more</span>
                </button>
                {expressionOpen && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <Field label="Brow">
                      <Tiles
                        options={BROWS}
                        value={me.brow}
                        onPick={(id) => set('brow', id)}
                        render={(o) => <Mini me={{ ...me, brow: o.id }} />}
                      />
                    </Field>
                    <Field label="Mouth">
                      <Tiles
                        options={MOUTHS}
                        value={me.mouth}
                        onPick={(id) => set('mouth', id)}
                        render={(o) => <Mini me={{ ...me, mouth: o.id }} />}
                      />
                    </Field>
                    <Field label="Blush">
                      <Toggle value={me.blush} onChange={(v) => set('blush', v)} />
                    </Field>
                    <Field label="Lashes">
                      <Toggle value={me.lashes} onChange={(v) => set('lashes', v)} />
                    </Field>
                  </div>
                )}
              </div>
            </div>

            {/* ── live preview + actions ─────────────────────────────────── */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
              <div style={{
                display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 14,
                background: 'var(--cth-paper-100)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                padding: '14px 8px'
              }}>
                <Preview caption="Card"><SpritePortrait recipe={me} character="michael" scale={3} /></Preview>
                {/* The walking sprite is not decoration. It is the proof that the
                    character the user just built is the one that will be on the
                    office floor, which is the whole promise of the feature. */}
                <Preview caption="Floor"><WalkPreview me={me} scale={3} /></Preview>
              </div>

              <PixelButton variant="secondary" fullWidth onClick={() => setMe(randomMeRecipe())}>
                Surprise me
              </PixelButton>

              <div style={{ fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-500)' }}>
                Four skin tones ship today. More are hand-drawn art rather than a
                colour picker, so they are on the way rather than hidden.
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
                <PixelButton variant="ghost" onClick={onClose} style={{ flex: 1 }}>Cancel</PixelButton>
                <PixelButton variant="primary" onClick={() => onSave(me)} style={{ flex: 1 }}>Save</PixelButton>
              </div>
            </div>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}

// ─── preview ─────────────────────────────────────────────────────────────────

function Preview({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end' }}>{children}</div>
      <span style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '11px',
        color: 'var(--cth-ink-500)', textTransform: 'uppercase'
      }}>{caption}</span>
    </div>
  );
}

/**
 * The 18x32 floor sprite, walking on the spot.
 *
 * Painted on a plain canvas rather than through Pixi: this is three buffers
 * cycling on a timer, and standing up a WebGL renderer for it would mean owning
 * texture lifetimes inside a dialog the user opens and closes repeatedly. The
 * frames come from the same `recipeSceneFrameBufs` the real floor sprite uses,
 * so what walks here is what walks downstairs.
 */
function WalkPreview({ me, scale }: { me: MeRecipe; scale: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const recipeKey = JSON.stringify(me);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const frames = recipeSceneFrameBufs(toRecipe(me)).front;
    const stage = document.createElement('canvas');
    stage.width = SCENE_W; stage.height = SCENE_H;
    const sctx = stage.getContext('2d');
    if (!sctx) return;

    // stand, step-left, stand, step-right — the cast's own gait, so the preview
    // and the floor read as the same character rather than two impressions of one.
    const order = [0, 1, 0, 2];
    let i = 0;
    const draw = () => {
      const img = sctx.createImageData(SCENE_W, SCENE_H);
      img.data.set(frames[order[i % order.length]]);
      sctx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(stage, 0, 0, SCENE_W, SCENE_H, 0, 0, canvas.width, canvas.height);
      i++;
    };
    draw();
    const timer = window.setInterval(draw, 220);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipeKey, scale]);

  const w = Math.round(SCENE_W * scale);
  const h = Math.round(SCENE_H * scale);
  return (
    <canvas
      ref={canvasRef}
      width={w}
      height={h}
      style={{ width: w, height: h, imageRendering: 'pixelated' }}
    />
  );
}

/** A 1x portrait of one candidate option, for the picker tiles themselves. */
function Mini({ me }: { me: MeRecipe }) {
  return <SpritePortrait recipe={me} character="michael" scale={1} />;
}

// ─── controls ────────────────────────────────────────────────────────────────

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '12px',
        color: 'var(--cth-ink-900)', textTransform: 'uppercase'
      }}>{label}</span>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
        color: 'var(--cth-ink-700)', textTransform: 'uppercase'
      }}>{label}</span>
      {children}
    </div>
  );
}

function tileStyle(active: boolean): CSSProperties {
  return {
    padding: 3,
    background: active ? 'var(--cth-sky-light)' : 'var(--cth-cream-100)',
    boxShadow: active ? 'inset 0 0 0 1.5px var(--cth-ink-500)' : 'inset 0 0 0 1px var(--cth-ink-100)',
    cursor: 'pointer', border: 'none',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2
  };
}

/** A row of option tiles, each previewing the option applied to the CURRENT
 *  character — so the choice is "which of these is me", not "which word". */
function Tiles<T extends string>({
  options, value, onPick, render, showLabels = false
}: {
  options: ReadonlyArray<{ id: T; label: string }>;
  value: T;
  onPick: (id: T) => void;
  render: (o: { id: T; label: string }) => ReactNode;
  showLabels?: boolean;
}) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onPick(o.id)}
          title={o.label}
          aria-pressed={value === o.id}
          style={{ ...tileStyle(value === o.id), width: showLabels ? 56 : 28 }}
        >
          {/* Crop to the head: an 18x28 bust inside a 28px tile would shrink the
              face to nothing, and the face is the part being chosen. */}
          <div style={{
            width: 20, height: 26, overflow: 'hidden',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center'
          }}>{render(o)}</div>
          {showLabels && (
            <span style={{ fontSize: 9, color: 'var(--cth-ink-700)' }}>{o.label}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Curated colour swatches plus a custom chip. Swatches first because someone
 *  choosing hair already knows the answer ("dark brown") and a continuous picker
 *  makes them search for it. */
function Swatches({
  options, value, onPick
}: {
  options: ReadonlyArray<{ id: string; label: string }>;
  value: string;
  onPick: (hex: string) => void;
}) {
  const custom = !options.some((o) => o.id === value);
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onPick(o.id)}
          title={o.label}
          aria-pressed={value === o.id}
          style={{
            width: 22, height: 22, background: o.id, cursor: 'pointer', border: 'none',
            boxShadow: value === o.id
              ? 'inset 0 0 0 1.5px var(--cth-ink-500), 0 0 0 2px var(--cth-ink-900)'
              : 'inset 0 0 0 1px var(--cth-ink-300)'
          }}
        />
      ))}
      <label
        title="Custom colour"
        style={{
          width: 22, height: 22, position: 'relative', cursor: 'pointer',
          background: custom ? value : 'var(--cth-cream-100)',
          boxShadow: custom
            ? 'inset 0 0 0 1.5px var(--cth-ink-500), 0 0 0 2px var(--cth-ink-900)'
            : 'inset 0 0 0 1px var(--cth-ink-300)',
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}
      >
        {!custom && <span style={{ fontSize: 12, color: 'var(--cth-ink-700)' }}>+</span>}
        <input
          type="color"
          value={value}
          // A native colour input can hand back any string; the recipe is
          // validated again on save, but rejecting a bad one here keeps the
          // preview from flickering to the default mid-drag.
          onChange={(e) => { if (isHexColor(e.target.value)) onPick(e.target.value.toLowerCase()); }}
          style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
        />
      </label>
    </div>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {([['No', false], ['Yes', true]] as const).map(([label, v]) => (
        <button
          key={label}
          type="button"
          onClick={() => onChange(v)}
          aria-pressed={value === v}
          style={{ ...tileStyle(value === v), width: 48, padding: '4px 0' }}
        >
          <span style={{ fontSize: 10, color: 'var(--cth-ink-700)' }}>{label}</span>
        </button>
      ))}
    </div>
  );
}

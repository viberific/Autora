/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The cards for what a shape is made of and what grows on it: Material (a finish to start from, its colour and its numbers),
 * Texture (a pattern the modeller draws, or a picture), Hair (hair or fur, and the person's grooming brush) and Light (the
 * surroundings the scene is lit by). Each shows the few controls the work needs now; the rest wait behind More, and a
 * control that does nothing yet (the bend of light with nothing clear, a picture's size with no picture) is not there.
 */
import React, { useRef, useState } from 'react';
import { Body3D, Hair, MATERIAL_PRESETS, MaterialType, PatternKind, PictureSlot, SceneLook, SWATCHES } from '../types';
import { DEFAULT_PATTERN, PATTERNS, SURFACE_RANGES, imageDataUrl, resolveSurface, type SurfaceNumber } from '../utils/surface';
import { GROOM_TOOLS, HAIR_RANGES, settleHair, type GroomBrush, type HairNumber } from '../utils/hair';
import type { SurfaceArgs, HairArgs } from '../core/ops';
import { Segmented } from './controls';

const chip = (on: boolean) =>
  `h-8 px-3 rounded-full text-xs font-medium transition-colors ${on ? 'bg-accent-500 text-white' : 'bg-white/6 text-slate-300 hover:bg-white/12'}`;
const quiet = 'h-8 px-3.5 rounded-full text-xs font-medium bg-white/6 text-slate-200 hover:bg-white/12 disabled:opacity-40';
const WIDTH = 'w-[min(19rem,calc(100vw-1.5rem))]';

/** A labelled slider with its value; `label` is also its accessible name, which the agent's hand finds it by. */
export function Slider({ label, value, min, max, step, onChange, unit = '', percent = false }: { label: string; value: number; min: number; max: number; step: number; onChange: (n: number) => void; unit?: string; percent?: boolean }) {
  const shown = percent ? `${Math.round(value * 100)}%` : `${Math.round(value * 100) / 100}${unit ? ` ${unit}` : ''}`;
  return (
    <label className="flex items-center gap-3 text-xs text-slate-300">
      <span className="w-20 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ ['--fill' as string]: `${((value - min) / (max - min || 1)) * 100}%` }}
        className="flex-1 min-w-0 accent-accent-500"
      />
      <span className="w-12 text-right tabular-nums text-slate-400">{shown}</span>
    </label>
  );
}

function ColourField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-3 text-xs text-slate-300">
      <span className="w-20 shrink-0">{label}</span>
      <span className="relative w-7 h-7 rounded-full border border-white/20 overflow-hidden" style={{ backgroundColor: value }}>
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#888888'} onChange={(e) => onChange(e.target.value)} aria-label={label} className="absolute inset-0 opacity-0 cursor-pointer" />
      </span>
      <span className="tabular-nums text-slate-500">{value}</span>
    </label>
  );
}

function More({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button type="button" aria-expanded={open} onClick={onToggle} className="self-start text-xs font-medium text-accent-300 hover:text-accent-200">
      {open ? 'Fewer' : 'More'}
    </button>
  );
}

export interface SurfacePanelProps {
  selected: Body3D[];
  onSurface: (args: SurfaceArgs) => void;
  /** Opens another card of the bar (Texture, Hair): how they are reached before the shape has a pattern or hair. */
  onOpen?: (id: 'texture' | 'hair') => void;
}

/** What one shape is made of: a finish to start from, its colour, and the numbers that matter for that finish. */
export function MaterialPanel({ selected, onSurface, onOpen }: SurfacePanelProps) {
  const [more, setMore] = useState(false);
  const body = selected.length === 1 ? selected[0] : null;
  if (!body) return null;
  const s = resolveSurface(body);
  const textured = !!(s.pattern || s.image || s.reliefImage || s.roughnessImage);
  const set = (k: SurfaceNumber) => (n: number) => onSurface({ id: body.id, [k]: n });
  const range = (k: SurfaceNumber) => SURFACE_RANGES[k];
  const clear = s.transmission > 0;
  return (
    <div className={`p-4 flex flex-col gap-3 ${WIDTH}`}>
      <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="Finish">
        {MATERIAL_PRESETS.map((m) => (
          <button key={m.id} type="button" aria-pressed={body.materialType === m.id} title={m.name} aria-label={m.name} onClick={() => onSurface({ id: body.id, preset: m.id as MaterialType })} className={`${chip(body.materialType === m.id)} truncate`}>
            {m.id[0].toUpperCase() + m.id.slice(1)}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Colour">
        {SWATCHES.map((w) => (
          <button key={w.value} type="button" title={w.name} aria-label={w.name} aria-pressed={body.color.toLowerCase() === w.value.toLowerCase()} onClick={() => onSurface({ id: body.id, color: w.value })} style={{ backgroundColor: w.value }} className={`w-7 h-7 rounded-full border border-white/20 ${body.color.toLowerCase() === w.value.toLowerCase() ? 'ring-2 ring-offset-2 ring-offset-slate-800 ring-accent-400' : ''}`} />
        ))}
        <label title="Custom color" className="relative w-7 h-7 rounded-full border border-dashed border-white/30 overflow-hidden cursor-pointer" style={{ background: 'conic-gradient(#f43f5e, #f59e0b, #10b981, #3b82f6, #a855f7, #f43f5e)' }}>
          <input type="color" value={/^#[0-9a-f]{6}$/i.test(body.color) ? body.color : '#3b82f6'} onChange={(e) => onSurface({ id: body.id, color: e.target.value })} aria-label="Custom color" className="absolute inset-0 opacity-0 cursor-pointer" />
        </label>
      </div>
      <Slider label="Roughness" value={s.roughness} min={0} max={1} step={0.01} percent onChange={set('roughness')} />
      <Slider label="Metal" value={s.metalness} min={0} max={1} step={0.01} percent onChange={set('metalness')} />
      <Slider label="Clear" value={s.transmission} min={0} max={1} step={0.01} percent onChange={set('transmission')} />
      {clear && <Slider label="Bends light" value={s.ior} min={range('ior')[0]} max={range('ior')[1]} step={0.01} onChange={set('ior')} />}
      <More open={more} onToggle={() => setMore((v) => !v)} />
      {more && (
        <>
          {clear && <Slider label="Thickness" value={s.thickness} min={0} max={100} step={1} unit="mm" onChange={set('thickness')} />}
          <Slider label="Opacity" value={s.opacity} min={range('opacity')[0]} max={1} step={0.01} percent onChange={set('opacity')} />
          <Slider label="Lacquer" value={s.clearcoat} min={0} max={1} step={0.01} percent onChange={set('clearcoat')} />
          <Slider label="Sheen" value={s.sheen} min={0} max={1} step={0.01} percent onChange={set('sheen')} />
          <Slider label="Light through" value={s.subsurface} min={0} max={1} step={0.01} percent onChange={set('subsurface')} />
          <Slider label="Glow" value={s.glow} min={0} max={range('glow')[1]} step={0.05} onChange={set('glow')} />
          {body.surface && Object.keys(body.surface).some((k) => k !== 'pattern' && k !== 'image') && (
            <button type="button" className={quiet} onClick={() => onSurface({ id: body.id, reset: true })}>Back to the finish</button>
          )}
        </>
      )}
      {onOpen && (!textured || (!body.hair && !body.frame)) && (
        // Texture and Hair join the bar once the shape has a pattern or hair; until then they are reached from here.
        <div className="flex gap-2 pt-2 border-t border-white/8">
          {!textured && <button type="button" className={quiet} onClick={() => onOpen('texture')}>Texture…</button>}
          {!body.hair && !body.frame && <button type="button" className={quiet} onClick={() => onOpen('hair')}>Hair…</button>}
        </div>
      )}
    </div>
  );
}

/** A pattern drawn on the shape, or a picture laid on it. */
export function TexturePanel({ selected, onSurface }: SurfacePanelProps) {
  const file = useRef<HTMLInputElement>(null);
  /** Which picture the file chooser is for. */
  const slot = useRef<PictureSlot>('image');
  const [note, setNote] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const body = selected.length === 1 ? selected[0] : null;
  if (!body) return null;
  const pattern = body.surface?.pattern;
  const image = body.surface?.image;
  const relief = body.surface?.reliefImage;
  const rough = body.surface?.roughnessImage;
  const kind: PatternKind = pattern?.kind ?? 'none';
  const choose = (which: PictureSlot) => {
    slot.current = which;
    file.current?.click();
  };
  const pick = async (f: File | undefined) => {
    if (!f) return;
    const data = imageDataUrl(new Uint8Array(await f.arrayBuffer()));
    if (!data) return setNote('That is not a PNG or a JPEG.');
    setNote(null);
    onSurface({ id: body.id, [slot.current]: data });
  };
  return (
    <div className={`p-4 flex flex-col gap-3 ${WIDTH}`}>
      <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="Pattern">
        {PATTERNS.map((p) => (
          <button key={p.kind} type="button" aria-pressed={kind === p.kind} onClick={() => onSurface({ id: body.id, pattern: p.kind })} className={chip(kind === p.kind)}>
            {p.label}
          </button>
        ))}
      </div>
      {pattern && (
        <>
          <ColourField label="Second colour" value={pattern.color2} onChange={(v) => onSurface({ id: body.id, pattern: { color2: v } })} />
          <Slider label="Size" value={pattern.scale} min={5} max={400} step={1} unit="mm" onChange={(n) => onSurface({ id: body.id, pattern: { scale: n } })} />
          <Slider label="Relief" value={pattern.bump} min={0} max={1} step={0.01} percent onChange={(n) => onSurface({ id: body.id, pattern: { bump: n } })} />
          <Slider label="Turn" value={pattern.angle ?? DEFAULT_PATTERN.angle ?? 0} min={0} max={359} step={1} unit="°" onChange={(n) => onSurface({ id: body.id, pattern: { angle: n } })} />
        </>
      )}
      <div className="flex items-center gap-2">
        <button type="button" className={quiet} onClick={() => choose('image')}>{image ? 'Another picture' : 'Picture…'}</button>
        {image && <button type="button" className={quiet} onClick={() => onSurface({ id: body.id, image: null })}>Remove picture</button>}
        <input ref={file} type="file" accept="image/png,image/jpeg" aria-label="Picture file" className="hidden" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      {image && <Slider label="Picture size" value={image.scale ?? 100} min={5} max={1000} step={1} unit="mm" onChange={(n) => onSurface({ id: body.id, imageScale: n })} />}
      {(relief || rough) ? null : <More open={more} onToggle={() => setMore((v) => !v)} />}
      {(more || relief || rough) && (
        // Grey pictures for relief and roughness: rarer, so they wait behind More until the shape has one.
        <>
          <div className="flex items-center gap-2">
            <button type="button" className={quiet} onClick={() => choose('reliefImage')}>{relief ? 'Another relief picture' : 'Relief picture…'}</button>
            {relief && <button type="button" className={quiet} onClick={() => onSurface({ id: body.id, reliefImage: null })}>Remove relief</button>}
          </div>
          {relief && <Slider label="Relief strength" value={relief.strength ?? 0.5} min={0} max={1} step={0.01} percent onChange={(n) => onSurface({ id: body.id, reliefStrength: n })} />}
          <div className="flex items-center gap-2">
            <button type="button" className={quiet} onClick={() => choose('roughnessImage')}>{rough ? 'Another roughness picture' : 'Roughness picture…'}</button>
            {rough && <button type="button" className={quiet} onClick={() => onSurface({ id: body.id, roughnessImage: null })}>Remove roughness</button>}
          </div>
        </>
      )}
      {note && <p className="text-xs text-amber-300">{note}</p>}
    </div>
  );
}

export interface HairPanelProps {
  selected: Body3D[];
  onHair: (args: HairArgs) => void;
  groomBrush: GroomBrush;
  onGroomBrush: (patch: Partial<GroomBrush>) => void;
  groomOn: boolean;
  onGroomOn: (on: boolean) => void;
}

/** Hair or fur on one shape: how it grows (the agent may set these too), and the grooming brush (the person's alone). */
export function HairPanel({ selected, onHair, groomBrush, onGroomBrush, groomOn, onGroomOn }: HairPanelProps) {
  const [more, setMore] = useState(false);
  const body = selected.length === 1 ? selected[0] : null;
  if (!body) return null;
  if (body.frame) return null;
  if (!body.hair) {
    return (
      <div className={`p-4 flex gap-2 ${WIDTH}`}>
        <button type="button" className={quiet} onClick={() => onHair({ id: body.id, style: 'strands' })}>Grow hair</button>
        <button type="button" className={quiet} onClick={() => onHair({ id: body.id, style: 'fur' })}>Grow fur</button>
      </div>
    );
  }
  const h: Hair = settleHair(body.hair);
  const set = (k: HairNumber) => (n: number) => onHair({ id: body.id, [k]: n });
  const r = (k: HairNumber) => HAIR_RANGES[k];
  const maxLength = h.style === 'fur' ? 60 : 400;
  return (
    <div className={`p-4 flex flex-col gap-3 ${WIDTH}`}>
      <div className="flex gap-1.5" role="group" aria-label="Style">
        <button type="button" aria-pressed={h.style === 'strands'} className={chip(h.style === 'strands')} onClick={() => onHair({ id: body.id, style: 'strands' })}>Hair</button>
        <button type="button" aria-pressed={h.style === 'fur'} className={chip(h.style === 'fur')} onClick={() => onHair({ id: body.id, style: 'fur' })}>Fur</button>
      </div>
      <Slider label="Length" value={Math.min(h.length, maxLength)} min={1} max={maxLength} step={1} unit="mm" onChange={set('length')} />
      <Slider label="Density" value={h.density} min={r('density')[0]} max={r('density')[1]} step={0.1} onChange={set('density')} />
      <Slider label="Curl" value={h.curl} min={0} max={1} step={0.01} percent onChange={set('curl')} />
      <ColourField label="Root colour" value={h.rootColor} onChange={(v) => onHair({ id: body.id, rootColor: v })} />
      <ColourField label="Tip colour" value={h.tipColor} onChange={(v) => onHair({ id: body.id, tipColor: v })} />
      <More open={more} onToggle={() => setMore((v) => !v)} />
      {more && (
        <>
          <Slider label="Thickness" value={h.thickness} min={r('thickness')[0]} max={r('thickness')[1]} step={0.05} unit="mm" onChange={set('thickness')} />
          <Slider label="Frizz" value={h.frizz} min={0} max={1} step={0.01} percent onChange={set('frizz')} />
          <Slider label="Locks" value={h.clump} min={0} max={1} step={0.01} percent onChange={set('clump')} />
          <Slider label="Droop" value={h.droop} min={0} max={1} step={0.01} percent onChange={set('droop')} />
          <Slider label="Shine" value={h.shine} min={0} max={1} step={0.01} percent onChange={set('shine')} />
          <button type="button" className={quiet} onClick={() => onHair({ id: body.id, seed: h.seed + 1 })}>Grow it another way</button>
        </>
      )}
      <div className="pt-2 border-t border-white/8 flex flex-col gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Groom">
          <button type="button" aria-pressed={!groomOn} className={chip(!groomOn)} onClick={() => onGroomOn(false)}>Off</button>
          {GROOM_TOOLS.map((t) => (
            <button key={t.tool} type="button" title={t.hint} aria-pressed={groomOn && groomBrush.tool === t.tool} className={chip(groomOn && groomBrush.tool === t.tool)} onClick={() => { onGroomBrush({ tool: t.tool }); onGroomOn(true); }}>
              {t.label}
            </button>
          ))}
        </div>
        {groomOn && (
          <>
            <Slider label="Brush size" value={groomBrush.radius} min={1} max={150} step={1} unit="mm" onChange={(n) => onGroomBrush({ radius: n })} />
            <Slider label="Brush strength" value={groomBrush.strength} min={0.05} max={1} step={0.05} percent onChange={(n) => onGroomBrush({ strength: n })} />
            <div className="flex items-center gap-3 text-xs text-slate-300">
              <span className="w-20 shrink-0" title="L–R grooms the other side across the shape's middle left to right; F–B front to back">Mirror</span>
              <Segmented id="groom-mirror" label="Mirror" value={groomBrush.mirror} options={[{ value: 'off', label: 'Off' }, { value: 'x', label: 'L–R' }, { value: 'y', label: 'F–B' }]} onChange={(v) => onGroomBrush({ mirror: v })} />
            </div>
          </>
        )}
        <div className="flex gap-2">
          {!!h.strokes?.length && <button type="button" className={quiet} onClick={() => onHair({ id: body.id, clearGrooming: true })}>Undo all grooming</button>}
          <button type="button" className={quiet} onClick={() => { onGroomOn(false); onHair({ id: body.id, remove: true }); }}>Remove {h.style === 'fur' ? 'fur' : 'hair'}</button>
        </div>
      </div>
    </div>
  );
}

const ENVIRONMENTS: { value: SceneLook['environment']; label: string }[] = [
  { value: 'studio', label: 'Studio' },
  { value: 'daylight', label: 'Daylight' },
  { value: 'sunset', label: 'Sunset' },
  { value: 'night', label: 'Night' },
];

/** The surroundings the whole scene is lit by, and how bright. */
export function LightPanel({ look, onLook }: { look: SceneLook | undefined; onLook: (patch: Partial<SceneLook>) => void }) {
  const env = look?.environment ?? 'studio';
  return (
    <div className={`p-4 flex flex-col gap-3 ${WIDTH}`}>
      <div className="grid grid-cols-4 gap-1.5" role="group" aria-label="Surroundings">
        {ENVIRONMENTS.map((e) => (
          <button key={e.value} type="button" aria-pressed={env === e.value} className={`${chip(env === e.value)} px-1.5`} onClick={() => onLook({ environment: e.value })}>{e.label}</button>
        ))}
      </div>
      <Slider label="Brightness" value={look?.exposure ?? 1} min={0.3} max={2} step={0.05} onChange={(n) => onLook({ exposure: n })} />
    </div>
  );
}

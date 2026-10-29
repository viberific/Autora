import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ATOMS, emptyValue, type LaneItem, type Value } from "../../lib/panacea/atoms";
import type { Panel } from "../../lib/panacea/canvas";
import { revealed } from "../../lib/panacea/profile";
import { bindsOf, isRef, parseBind, type Node, type Option } from "../../lib/panacea/recipe";
import { findParam } from "../../lib/panacea/kinds";
import { LOOKS, type ParamSpec } from "../../lib/panacea/surfaces";
import { Chart, DataTable } from "./Chart";
import { Bespoke } from "./Bespoke";
import { imageStats, onImageStats } from "./imagegl";
import { usePanacea, type PanaceaApi } from "./context";

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const roundTo = (v: number, step: number) => (step > 0 ? Math.round(v / step) * step : v);
const decimals = (step: number) => (step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step))));
const fmt = (v: number, step: number) => v.toFixed(decimals(step));

/** The parameter a bind names on its surface, for ranges, options and defaults the recipe did not spell out. */
function paramOf(api: PanaceaApi, bind: string | undefined): ParamSpec | null {
  if (!bind?.startsWith("@")) return null;
  const { surface, param } = parseBind(bind);
  const s = api.canvas.surfaces.find((x) => x.id === surface);
  return s ? findParam(s.kind, s.table, param) : null;
}

/** A prop that may read a shared value ("=data.chart"). */
function resolved(api: PanaceaApi, v: unknown): unknown {
  return typeof v === "string" && isRef(v) ? api.value(v.slice(1)) : v;
}

/** The options a choice shows: the recipe's own, ones read off a surface, or the parameter's. */
function optionsOf(api: PanaceaApi, node: Node, panel: Panel): Option[] {
  const raw = node.props?.options;
  if (Array.isArray(raw)) return raw as Option[];
  const data = api.canvas.surfaces.find((s) => s.kind === "data" && (s.id === panel.context || bindsOf(node).some((b) => parseBind(b).surface === s.id))) ?? api.canvas.surfaces.find((s) => s.kind === "data");
  if (raw === "looks") return Object.entries(LOOKS).map(([value, l]) => ({ value, label: l.label, color: l.swatch }));
  if (raw === "palette") {
    const img = api.canvas.surfaces.find((s) => s.kind === "image" && s.id === panel.context) ?? api.canvas.surfaces.find((s) => s.kind === "image");
    return (img ? imageStats(img.id).palette : []).map((c) => ({ value: c, label: c, color: c }));
  }
  if (raw === "columns") return (data?.table?.columns ?? []).map((c) => ({ value: c.name, label: c.name }));
  if (typeof raw === "string" && raw.startsWith("column:") && data?.table) {
    const name = raw.slice(7);
    const i = data.table.columns.findIndex((c) => c.name === name);
    const seen = new Set<string>();
    if (i >= 0) for (const r of data.table.rows) { if (r[i] !== null) seen.add(String(r[i])); if (seen.size >= 60) break; }
    return [...seen].map((v) => ({ value: v, label: v }));
  }
  const p = paramOf(api, node.bind);
  if (p?.name === "look") return Object.entries(LOOKS).map(([value, l]) => ({ value, label: l.label, color: l.swatch }));
  if (p?.options) return p.options.map((o) => ({ value: o, label: p.name === "rotate" ? `${o}°` : o === "" ? "None" : o }));
  return [];
}

function useImageStats(): number {
  return useSyncExternalStore(onImageStats, () => statsTick, () => 0);
}
let statsTick = 0;
onImageStats(() => { statsTick++; });

type AtomProps = { node: Node; panel: Panel };

/** One atom of a panel, and the atoms inside it. */
export function Atom({ node, panel }: AtomProps): ReactNode {
  const api = usePanacea();
  const spec = ATOMS[node.atom];
  if (spec.container) return <Container node={node} panel={panel} />;
  const bind = node.bind;
  const p = paramOf(api, bind);
  const current = bind ? api.value(bind) : undefined;
  const value: Value = current !== undefined ? current : p ? p.default : spec.value ? emptyValue(spec.value) : null;
  const label = typeof node.props?.label === "string" ? node.props.label : p?.label ?? "";
  const set = (v: Value, what?: string) => { if (bind) api.set(bind, v, panel, what ?? `${label || node.atom}`); };
  const attrs = { "data-atom": node.atom, ...(bind ? { "data-bind": bind } : {}) };
  switch (node.atom) {
    case "divider": return <hr className="pa-divider" />;
    case "label": return <div className="pa-label">{String(node.props?.text ?? "")}</div>;
    case "note": return <p className="pa-note">{String(node.props?.text ?? "")}</p>;
    case "stat": {
      const n = typeof value === "number" ? value : 0;
      const d = typeof node.props?.decimals === "number" ? node.props.decimals : Number.isInteger(n) ? 0 : 1;
      return <div className="pa-stat" {...attrs}><span className="pa-stat-num">{n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d })}{node.props?.unit ? <small> {String(node.props.unit)}</small> : null}</span><span className="pa-cap">{label}</span></div>;
    }
    case "meter": {
      const lo = Number(node.props?.min ?? 0);
      const hi = Number(node.props?.max ?? 100);
      const f = clamp(((typeof value === "number" ? value : 0) - lo) / ((hi - lo) || 1), 0, 1);
      return <div className="pa-meter" {...attrs}><div className="pa-row-between"><span className="pa-cap">{label}</span><span className="pa-val">{typeof value === "number" ? value.toLocaleString() : "–"}</span></div><div className="pa-meter-track"><i style={{ width: `${f * 100}%` }} /></div></div>;
    }
    case "badge": return <span className={`pa-badge is-${String(node.props?.tone ?? "plain")}`} {...attrs}>{label ? `${label}: ` : ""}{String(value ?? "")}</span>;
    case "slider": return <Slider node={node} panel={panel} value={typeof value === "number" ? value : 0} param={p} label={label} set={set} />;
    case "knob": return <Knob node={node} value={typeof value === "number" ? value : 0} param={p} label={label} set={set} />;
    case "stepper": {
      const lo = Number(node.props?.min ?? p?.min ?? 0);
      const hi = Number(node.props?.max ?? p?.max ?? 100);
      const step = Number(node.props?.step ?? p?.step ?? 1) || 1;
      const v = typeof value === "number" ? value : lo;
      return (
        <div className="pa-field pa-stepper" {...attrs} data-min={lo} data-max={hi} data-step={step}>
          <span className="pa-cap">{label}</span>
          <span className="pa-step">
            <button type="button" data-act="less" aria-label={`Less ${label}`} disabled={v <= lo} onClick={() => set(clamp(roundTo(v - step, step), lo, hi))}>−</button>
            <input type="number" value={v} min={lo} max={hi} step={step} aria-label={label} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) set(clamp(n, lo, hi)); }} />
            <button type="button" data-act="more" aria-label={`More ${label}`} disabled={v >= hi} onClick={() => set(clamp(roundTo(v + step, step), lo, hi))}>+</button>
          </span>
          {node.props?.unit ? <span className="pa-unit">{String(node.props.unit)}</span> : null}
        </div>
      );
    }
    case "toggle": {
      const on = value === true;
      return (
        <div className="pa-field pa-toggle-row" {...attrs}>
          <span className="pa-cap">{label}</span>
          <button type="button" role="switch" aria-checked={on} aria-label={label} className={`pa-switch${on ? " is-on" : ""}`} onClick={() => set(!on, `${label} ${on ? "off" : "on"}`)}><i /></button>
        </div>
      );
    }
    case "segmented": {
      const opts = optionsOf(api, node, panel);
      return (
        <div className="pa-field" {...attrs}>
          {label && <span className="pa-cap">{label}</span>}
          <div className="pa-seg" role="radiogroup" aria-label={label}>
            {opts.map((o) => <button key={o.value} type="button" role="radio" aria-checked={value === o.value} data-value={o.value} className={value === o.value ? "is-on" : ""} onClick={() => set(o.value, `${label} ${o.label}`)}>{o.label}</button>)}
          </div>
        </div>
      );
    }
    case "select": return <Select node={node} label={label} value={typeof value === "string" ? value : ""} options={optionsOf(api, node, panel)} set={set} />;
    case "chips": {
      const opts = optionsOf(api, node, panel);
      const on = new Set(Array.isArray(value) ? (value as string[]) : []);
      return (
        <div className="pa-field" {...attrs}>
          {label && <span className="pa-cap">{label}</span>}
          <div className="pa-chips">
            {opts.map((o) => (
              <button key={o.value} type="button" aria-pressed={on.has(o.value)} data-value={o.value} className={on.has(o.value) ? "is-on" : ""}
                onClick={() => { const next = new Set(on); if (next.has(o.value)) next.delete(o.value); else next.add(o.value); set(opts.map((x) => x.value).filter((x) => next.has(x)), `${label} ${o.label}`); }}>
                {o.label}
              </button>
            ))}
            {!opts.length && <span className="pa-note">Nothing to choose from yet.</span>}
          </div>
        </div>
      );
    }
    case "swatches": return <Swatches node={node} panel={panel} label={label} value={value} set={set} />;
    case "color": return <ColorField node={node} label={label} value={typeof value === "string" ? value : "#7c5cff"} set={set} />;
    case "text": return <TextField node={node} label={label} value={typeof value === "string" ? value : ""} set={set} />;
    case "range": return <RangeField node={node} panel={panel} value={Array.isArray(value) && value.length === 2 ? (value as [number, number]) : null} param={p} label={label} set={set} />;
    case "xy": return <XYPad node={node} label={label} value={Array.isArray(value) && value.length === 2 ? (value as [number, number]) : [0, 0]} set={set} />;
    case "curve": return <Curve node={node} panel={panel} label={label} value={Array.isArray(value) ? (value as Array<[number, number]>) : [[0, 0], [1, 1]]} set={set} />;
    case "button": return <ActionButton node={node} panel={panel} label={label} />;
    case "list": return <ListField node={node} label={label} value={Array.isArray(value) ? (value as string[]) : []} set={set} />;
    case "pads": return <Pads node={node} label={label} value={Array.isArray(value) ? (value as number[]) : []} set={set} />;
    case "lanes": return <Lanes node={node} label={label} value={Array.isArray(value) ? (value as LaneItem[]) : []} set={set} />;
    case "histogram": return <Histogram surface={String(node.props?.surface ?? "")} />;
    case "chart": {
      const s = api.canvas.surfaces.find((x) => x.id === node.props?.surface);
      if (!s?.table) return <div className="pa-chart-empty">The table this chart drew is gone.</div>;
      const raw = node.props?.y;
      const y = Array.isArray(raw) ? raw.flatMap((c) => { const v = resolved(api, c); return Array.isArray(v) ? v : [v]; }) : resolved(api, raw);
      return <Chart table={s.table} params={s.params} kind={String(resolved(api, node.props?.kind) ?? "bar")} x={String(resolved(api, node.props?.x) ?? "")} y={Array.isArray(y) ? (y as string[]) : typeof y === "string" ? [y] : []} agg={String(node.props?.agg ?? "sum")} label={label || undefined} />;
    }
    case "table": {
      const s = api.canvas.surfaces.find((x) => x.id === node.props?.surface);
      if (!s?.table) return <div className="pa-chart-empty">The table is gone.</div>;
      return <DataTable table={s.table} params={s.params} columns={Array.isArray(node.props?.columns) ? (node.props!.columns as string[]) : undefined} limit={Number(node.props?.limit ?? 50)} />;
    }
    case "bespoke": return <Bespoke node={node} panel={panel} />;
    default: return null;
  }
}

/** Stack, row or group: the children in view, and the advanced ones behind More until opened or learned. */
function Container({ node, panel }: AtomProps) {
  const api = usePanacea();
  const kids = node.children ?? [];
  const shows = (k: Node) => !k.advanced || panel.expanded || (bindsOf(k).length > 0 && bindsOf(k).every((b) => revealed(api.profile, b)));
  const hidden = kids.filter((k) => !shows(k));
  const anyAdvanced = kids.some((k) => k.advanced);
  const body = (
    <>
      {kids.filter(shows).map((k, i) => <Atom key={i} node={k} panel={panel} />)}
      {hidden.length > 0 && <button type="button" className="pa-more" data-act="more-settings" onClick={() => api.expand(panel, true)}>More <span>{hidden.length}</span></button>}
      {!hidden.length && anyAdvanced && panel.expanded && <button type="button" className="pa-more" data-act="less-settings" onClick={() => api.expand(panel, false)}>Less</button>}
    </>
  );
  const gap = typeof node.props?.gap === "number" ? { gap: node.props.gap } : undefined;
  if (node.atom === "row") return <div className="pa-rowbox" style={gap}>{body}</div>;
  if (node.atom === "group") return <section className="pa-group">{typeof node.props?.label === "string" && node.props.label !== panel.title && <h5 className="pa-group-title">{node.props.label}</h5>}<div className="pa-stack">{body}</div></section>;
  return <div className="pa-stack" style={gap}>{body}</div>;
}

// ---------------------------------------------------------------- controls --

/** A drag on a track: the pointer's place along it as 0..1, while held. */
function useTrackDrag(onMove: (f: number, e: PointerEvent | ReactPointerEvent) => void, onEnd?: () => void) {
  const api = usePanacea();
  return (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const at = (x: number) => clamp((x - rect.left) / Math.max(1, rect.width), 0, 1);
    api.hold(true);
    el.setPointerCapture?.(e.pointerId);
    onMove(at(e.clientX), e);
    const move = (ev: PointerEvent) => onMove(at(ev.clientX), ev);
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      api.hold(false);
      onEnd?.();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
}

function Slider({ node, value, param, label, set }: { node: Node; panel: Panel; value: number; param: ParamSpec | null; label: string; set: (v: Value) => void }) {
  const lo = Number(node.props?.min ?? param?.min ?? 0);
  const hi = Number(node.props?.max ?? param?.max ?? 100);
  const step = Number(node.props?.step ?? param?.step ?? 1) || 0.01;
  const centre = node.props?.centre === true || (lo < 0 && hi > 0);
  const f = clamp((value - lo) / ((hi - lo) || 1), 0, 1);
  const z = clamp((0 - lo) / ((hi - lo) || 1), 0, 1);
  const [dragging, setDragging] = useState(false);
  const down = useTrackDrag((t) => { setDragging(true); set(clamp(roundTo(lo + t * (hi - lo), step), lo, hi)); }, () => setDragging(false));
  const reset = () => set(typeof param?.default === "number" ? param.default : centre ? 0 : lo);
  const key = (e: ReactKeyboardEvent) => {
    const big = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); set(clamp(roundTo(value + step * big, step), lo, hi)); }
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); set(clamp(roundTo(value - step * big, step), lo, hi)); }
    if (e.key === "Home") { e.preventDefault(); set(lo); }
    if (e.key === "End") { e.preventDefault(); set(hi); }
  };
  const unit = node.props?.unit ?? param?.unit;
  return (
    <div className={`pa-field pa-slider${dragging ? " is-dragging" : ""}`} data-atom="slider" data-bind={node.bind} data-min={lo} data-max={hi} data-step={step}>
      <div className="pa-row-between"><span className="pa-cap">{label}</span><span className="pa-val">{value > 0 && centre ? "+" : ""}{fmt(value, step)}{unit ? <small> {String(unit)}</small> : null}</span></div>
      <div className="pa-track" role="slider" tabIndex={0} aria-label={label} aria-valuemin={lo} aria-valuemax={hi} aria-valuenow={value}
        onPointerDown={down} onKeyDown={key} onDoubleClick={reset} title="Double-click to reset" style={{ ["--f" as string]: f, ["--z" as string]: centre ? z : 0 }}>
        <i className="pa-fill" /><b className="pa-thumb" />
      </div>
    </div>
  );
}

function Knob({ node, value, param, label, set }: { node: Node; value: number; param: ParamSpec | null; label: string; set: (v: Value) => void }) {
  const api = usePanacea();
  const lo = Number(node.props?.min ?? param?.min ?? 0);
  const hi = Number(node.props?.max ?? param?.max ?? 100);
  const step = Number(node.props?.step ?? param?.step ?? 1) || 0.01;
  const f = clamp((value - lo) / ((hi - lo) || 1), 0, 1);
  const a0 = -135;
  const ang = a0 + f * 270;
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const start = value;
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    api.hold(true);
    const move = (ev: PointerEvent) => set(clamp(roundTo(start + ((startY - ev.clientY) / 160) * (hi - lo), step), lo, hi));
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); api.hold(false); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const arc = (from: number, to: number) => {
    const p = (a: number) => [24 + 18 * Math.cos(((a - 90) * Math.PI) / 180), 24 + 18 * Math.sin(((a - 90) * Math.PI) / 180)];
    const [x1, y1] = p(from);
    const [x2, y2] = p(to);
    return `M ${x1} ${y1} A 18 18 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2}`;
  };
  return (
    <div className="pa-knob" data-atom="knob" data-bind={node.bind} data-min={lo} data-max={hi}>
      <div className="pa-knob-dial" role="slider" tabIndex={0} aria-label={label} aria-valuemin={lo} aria-valuemax={hi} aria-valuenow={value} onPointerDown={down}
        onDoubleClick={() => set(typeof param?.default === "number" ? param.default : lo < 0 ? 0 : lo)}
        onKeyDown={(e) => { if (e.key === "ArrowUp" || e.key === "ArrowRight") set(clamp(roundTo(value + step, step), lo, hi)); if (e.key === "ArrowDown" || e.key === "ArrowLeft") set(clamp(roundTo(value - step, step), lo, hi)); }}>
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <path d={arc(a0, 135)} className="pa-knob-track" />
          {f > 0.002 && <path d={arc(a0, ang)} className="pa-knob-fill" />}
          <line x1="24" y1="24" x2={24 + 13 * Math.cos(((ang - 90) * Math.PI) / 180)} y2={24 + 13 * Math.sin(((ang - 90) * Math.PI) / 180)} className="pa-knob-hand" />
        </svg>
      </div>
      <span className="pa-val">{fmt(value, step)}{node.props?.unit ? <small> {String(node.props.unit)}</small> : null}</span>
      <span className="pa-cap">{label}</span>
    </div>
  );
}

function Select({ node, label, value, options, set }: { node: Node; label: string; value: string; options: Option[]; set: (v: Value, what?: string) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as globalThis.Node)) setOpen(false); };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);
  const shown = options.find((o) => o.value === value)?.label ?? (value || "Choose…");
  return (
    <div className="pa-field pa-select" data-atom="select" data-bind={node.bind} ref={box}>
      {label && <span className="pa-cap">{label}</span>}
      <button type="button" className="pa-select-btn" aria-haspopup="listbox" aria-expanded={open} aria-label={label} onClick={() => setOpen(!open)}>{shown}<span className="pa-caret" aria-hidden="true">▾</span></button>
      {open && (
        <div className="pa-menu" role="listbox" aria-label={label}>
          {options.map((o) => <button key={o.value} type="button" role="option" aria-selected={o.value === value} data-value={o.value} className={o.value === value ? "is-on" : ""} onClick={() => { set(o.value, `${label} ${o.label}`); setOpen(false); }}>{o.label}</button>)}
          {!options.length && <span className="pa-note">Nothing to choose from.</span>}
        </div>
      )}
    </div>
  );
}

function Swatches({ node, panel, label, value, set }: { node: Node; panel: Panel; label: string; value: Value; set: (v: Value, what?: string) => void }) {
  const api = usePanacea();
  useImageStats();
  const opts = optionsOf(api, node, panel);
  return (
    <div className="pa-field" data-atom="swatches" data-bind={node.bind}>
      {label && <span className="pa-cap">{label}</span>}
      <div className="pa-swatches" role="radiogroup" aria-label={label}>
        {opts.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={value === o.value} data-value={o.value} className={`pa-swatch${value === o.value ? " is-on" : ""}`} onClick={() => set(o.value, `${label} ${o.label}`)}>
            <i style={{ background: o.color ?? "var(--s3)" }} /><span>{o.label}</span>
          </button>
        ))}
        {!opts.length && <span className="pa-note">No colours yet.</span>}
      </div>
    </div>
  );
}

function ColorField({ node, label, value, set }: { node: Node; label: string; value: string; set: (v: Value) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <div className="pa-field pa-color" data-atom="color" data-bind={node.bind}>
      <span className="pa-cap">{label}</span>
      <span className="pa-color-row">
        <label className="pa-color-chip" style={{ background: value }}><input type="color" value={value} aria-label={label} onChange={(e) => set(e.target.value)} /></label>
        <input className="pa-input pa-hex" value={text} maxLength={7} aria-label={`${label} hex`} onChange={(e) => { setText(e.target.value); if (/^#[0-9a-f]{6}$/i.test(e.target.value)) set(e.target.value.toLowerCase()); }} />
      </span>
    </div>
  );
}

function TextField({ node, label, value, set }: { node: Node; label: string; value: string; set: (v: Value) => void }) {
  const [text, setText] = useState(value);
  const typing = useRef(false);
  useEffect(() => { if (!typing.current) setText(value); }, [value]);
  const props = {
    className: "pa-input",
    value: text,
    "aria-label": label,
    placeholder: typeof node.props?.placeholder === "string" ? node.props.placeholder : "",
    onFocus: () => { typing.current = true; },
    onBlur: () => { typing.current = false; if (text !== value) set(text); },
    onChange: (e: { target: { value: string } }) => { setText(e.target.value); set(e.target.value); },
  };
  return (
    <label className="pa-field" data-atom="text" data-bind={node.bind}>
      <span className="pa-cap">{label}</span>
      {node.props?.multiline ? <textarea rows={3} {...props} /> : <input {...props} />}
    </label>
  );
}

function RangeField({ node, value, param, label, set }: { node: Node; panel: Panel; value: [number, number] | null; param: ParamSpec | null; label: string; set: (v: Value) => void }) {
  const lo = Number(node.props?.min ?? param?.min ?? 0);
  const hi = Number(node.props?.max ?? param?.max ?? 100);
  const step = Number(node.props?.step ?? param?.step ?? 1) || 0.01;
  const [a, b] = value ?? [lo, hi];
  const which = useRef<0 | 1>(0);
  const down = useTrackDrag((t, e) => {
    const v = clamp(roundTo(lo + t * (hi - lo), step), lo, hi);
    if (e.type === "pointerdown") which.current = Math.abs(v - a) <= Math.abs(v - b) ? 0 : 1;
    set(which.current === 0 ? [Math.min(v, b), b] : [a, Math.max(v, a)]);
  });
  const f = (v: number) => clamp((v - lo) / ((hi - lo) || 1), 0, 1);
  return (
    <div className="pa-field pa-range" data-atom="range" data-bind={node.bind} data-min={lo} data-max={hi}>
      <div className="pa-row-between"><span className="pa-cap">{label}</span><span className="pa-val">{fmt(a, step)} – {fmt(b, step)}{node.props?.unit ? <small> {String(node.props.unit)}</small> : null}</span></div>
      <div className="pa-track is-range" role="group" aria-label={label} onPointerDown={down} onDoubleClick={() => set([lo, hi])} style={{ ["--a" as string]: f(a), ["--b" as string]: f(b) }}>
        <i className="pa-fill" /><b className="pa-thumb is-a" data-thumb="a" /><b className="pa-thumb is-b" data-thumb="b" />
      </div>
    </div>
  );
}

function XYPad({ node, label, value, set }: { node: Node; label: string; value: [number, number]; set: (v: Value) => void }) {
  const api = usePanacea();
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const at = (ev: { clientX: number; clientY: number }) => set([Math.round(clamp(((ev.clientX - r.left) / r.width) * 2 - 1, -1, 1) * 100) / 100, Math.round(clamp(1 - ((ev.clientY - r.top) / r.height) * 2, -1, 1) * 100) / 100]);
    el.setPointerCapture?.(e.pointerId);
    api.hold(true);
    at(e);
    const move = (ev: PointerEvent) => at(ev);
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); api.hold(false); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  return (
    <div className="pa-field" data-atom="xy" data-bind={node.bind}>
      <span className="pa-cap">{label}</span>
      <div className="pa-xy" onPointerDown={down} role="group" aria-label={label}>
        <span className="pa-xy-x">{String(node.props?.x ?? "")}</span><span className="pa-xy-y">{String(node.props?.y ?? "")}</span>
        <b style={{ left: `${(value[0] + 1) * 50}%`, top: `${(1 - value[1]) * 50}%` }} />
      </div>
    </div>
  );
}

function Curve({ node, panel, label, value, set }: { node: Node; panel: Panel; label: string; value: Array<[number, number]>; set: (v: Value) => void }) {
  const api = usePanacea();
  useImageStats();
  const img = api.canvas.surfaces.find((s) => s.kind === "image" && (s.id === panel.context || node.bind?.startsWith(`@${s.id}.`)));
  const hist = img ? imageStats(img.id).hist?.[3] : null;
  const pts = [...value].sort((a, b) => a[0] - b[0]);
  const svg = useRef<SVGSVGElement>(null);
  const to = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = svg.current!.getBoundingClientRect();
    return [Math.round(clamp((e.clientX - r.left) / r.width, 0, 1) * 1000) / 1000, Math.round(clamp(1 - (e.clientY - r.top) / r.height, 0, 1) * 1000) / 1000];
  };
  const drag = (i: number) => (e: ReactPointerEvent<SVGCircleElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    api.hold(true);
    const move = (ev: PointerEvent) => {
      const [x, y] = to(ev);
      const next = pts.map((p) => [...p] as [number, number]);
      const lo = i === 0 ? 0 : next[i - 1]![0] + 0.01;
      const hi = i === next.length - 1 ? 1 : next[i + 1]![0] - 0.01;
      next[i] = [i === 0 ? 0 : i === next.length - 1 ? 1 : clamp(x, lo, hi), y];
      set(next);
    };
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); api.hold(false); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const add = (e: ReactMouseEvent<SVGSVGElement>) => {
    if (pts.length >= 12) return;
    const p = to(e);
    set([...pts, p].sort((a, b) => a[0] - b[0]));
  };
  const remove = (i: number) => { if (i > 0 && i < pts.length - 1) set(pts.filter((_, k) => k !== i)); };
  const max = hist ? Math.max(1, ...hist) : 1;
  const path = useMemo(() => {
    const lut = Array.from({ length: 33 }, (_, i) => i / 32);
    return lut.map((x) => {
      let k = 0;
      while (k < pts.length - 2 && x > pts[k + 1]![0]) k++;
      const a = pts[k]!;
      const b = pts[k + 1] ?? a;
      const t = b[0] === a[0] ? 0 : (x - a[0]) / (b[0] - a[0]);
      const s = t * t * (3 - 2 * t);
      return `${x * 100},${(1 - (a[1] + (b[1] - a[1]) * s)) * 100}`;
    }).join(" ");
  }, [pts]);
  return (
    <div className="pa-field" data-atom="curve" data-bind={node.bind}>
      <span className="pa-cap">{label}</span>
      <svg ref={svg} className="pa-curve" viewBox="0 0 100 100" preserveAspectRatio="none" onDoubleClick={add} role="group" aria-label={`${label}: double-click to add a point`}>
        {hist && hist.map((v, i) => <rect key={i} x={(i / hist.length) * 100} width={100 / hist.length} y={100 - (v / max) * 100} height={(v / max) * 100} className="pa-curve-hist" />)}
        {[25, 50, 75].map((g) => <g key={g}><line x1={g} x2={g} y1={0} y2={100} className="pa-grid" /><line y1={g} y2={g} x1={0} x2={100} className="pa-grid" /></g>)}
        <line x1={0} y1={100} x2={100} y2={0} className="pa-grid" />
        <polyline points={path} className="pa-curve-line" />
        {pts.map((p, i) => <circle key={i} cx={p[0] * 100} cy={(1 - p[1]) * 100} r={3.2} className="pa-curve-pt" onPointerDown={drag(i)} onDoubleClick={(e) => { e.stopPropagation(); remove(i); }} />)}
      </svg>
    </div>
  );
}

function ActionButton({ node, panel, label }: { node: Node; panel: Panel; label: string }) {
  const api = usePanacea();
  const ask = typeof node.props?.ask === "string" ? node.props.ask : "";
  const action = typeof node.props?.action === "string" ? node.props.action : "";
  const run = () => {
    if (ask) return api.ask(ask, panel);
    if (action.startsWith("@")) return api.act(action);
    if (action.startsWith("set:")) {
      const eq = action.indexOf("=");
      try { api.set(action.slice(4, eq), JSON.parse(action.slice(eq + 1)) as Value, panel, label); } catch { /* a value that is not JSON does nothing */ }
    }
  };
  return <button type="button" className={`pa-btn${node.props?.tone === "accent" ? " is-accent" : ""}`} data-atom="button" data-action={action || "ask"} onClick={run}>{label || (ask ? "Ask Autora" : "Do it")}</button>;
}

function ListField({ node, label, value, set }: { node: Node; label: string; value: string[]; set: (v: Value, what?: string) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => { const t = draft.trim(); if (!t) return; set([...value, t.slice(0, 200)], `${label}: added`); setDraft(""); };
  const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= value.length) return; const next = [...value]; [next[i], next[j]] = [next[j]!, next[i]!]; set(next, `${label}: reordered`); };
  const tick = (i: number) => set(value.map((v, k) => (k === i ? (v.startsWith("✓ ") ? v.slice(2) : `✓ ${v}`) : v)), `${label}: ticked`);
  return (
    <div className="pa-field pa-list" data-atom="list" data-bind={node.bind}>
      <span className="pa-cap">{label}</span>
      <ol>
        {value.map((v, i) => (
          <li key={`${i}-${v}`} className={v.startsWith("✓ ") ? "is-done" : ""}>
            <button type="button" className="pa-tick" aria-label={v.startsWith("✓ ") ? "Not done" : "Done"} onClick={() => tick(i)} />
            <span>{v.replace(/^✓ /, "")}</span>
            <span className="pa-list-acts">
              <button type="button" aria-label="Up" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
              <button type="button" aria-label="Down" onClick={() => move(i, 1)} disabled={i === value.length - 1}>↓</button>
              <button type="button" aria-label="Remove" onClick={() => set(value.filter((_, k) => k !== i), `${label}: removed`)}>×</button>
            </span>
          </li>
        ))}
      </ol>
      <input className="pa-input" value={draft} placeholder={typeof node.props?.placeholder === "string" ? node.props.placeholder : "Add…"} aria-label={`Add to ${label}`}
        onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} onBlur={add} />
    </div>
  );
}

function Pads({ node, label, value, set }: { node: Node; label: string; value: number[]; set: (v: Value, what?: string) => void }) {
  const cols = Number(node.props?.cols ?? 8);
  const names = Array.isArray(node.props?.names) ? (node.props!.names as Option[]).map((o) => o.label) : [];
  const rows = Number(node.props?.rows ?? (names.length || 1));
  const at = (r: number, c: number) => value[r * cols + c] === 1;
  const flip = (r: number, c: number) => {
    const next = Array.from({ length: rows * cols }, (_, i) => (value[i] === 1 ? 1 : 0));
    next[r * cols + c] = next[r * cols + c] ? 0 : 1;
    set(next, `${label}: step`);
  };
  return (
    <div className="pa-field pa-pads" data-atom="pads" data-bind={node.bind}>
      <span className="pa-cap">{label}</span>
      <div className="pa-pads-grid" style={{ gridTemplateColumns: `minmax(40px, auto) repeat(${cols}, 1fr)` }}>
        {Array.from({ length: rows }, (_, r) => [
          <span key={`n${r}`} className="pa-pads-name">{names[r] ?? ""}</span>,
          ...Array.from({ length: cols }, (_, c) => <button key={`${r}-${c}`} type="button" aria-pressed={at(r, c)} aria-label={`${names[r] ?? `Row ${r + 1}`} step ${c + 1}`} className={`pa-pad${at(r, c) ? " is-on" : ""}${c % 4 === 0 ? " is-beat" : ""}`} onClick={() => flip(r, c)} />),
        ])}
      </div>
    </div>
  );
}

function Lanes({ node, label, value, set }: { node: Node; label: string; value: LaneItem[]; set: (v: Value, what?: string) => void }) {
  const api = usePanacea();
  const names = Array.isArray(node.props?.lanes) ? (node.props!.lanes as Option[]).map((o) => o.label) : ["Lane"];
  const length = Number(node.props?.length ?? 100);
  const unit = String(node.props?.unit ?? "");
  const area = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const toUnits = (px: number) => (px / Math.max(1, area.current?.clientWidth ?? 1)) * length;
  const grab = (item: LaneItem, mode: "move" | "size") => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || editing) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    api.hold(true);
    const move = (ev: PointerEvent) => {
      const d = Math.round(toUnits(ev.clientX - startX) * 10) / 10;
      set(value.map((it) => (it.id !== item.id ? it : mode === "move" ? { ...it, start: clamp(item.start + d, 0, length - it.length) } : { ...it, length: clamp(item.length + d, length / 100, length - it.start) })), `${label}: ${mode === "move" ? "moved" : "resized"} ${item.label}`);
    };
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); api.hold(false); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const addAt = (lane: number, e: ReactMouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const start = Math.round(((e.clientX - r.left) / r.width) * length * 10) / 10;
    const len = Math.max(length / 12, 1);
    const id = `b${Date.now().toString(36)}`;
    set([...value, { id, lane, start: clamp(start, 0, length - len), length: len, label: "New" }], `${label}: added a block`);
    setEditing(id);
  };
  const ticks = Array.from({ length: 5 }, (_, i) => (i * length) / 4);
  return (
    <div className="pa-field pa-lanes" data-atom="lanes" data-bind={node.bind}>
      <span className="pa-cap">{label}</span>
      <div className="pa-lanes-body">
        <div className="pa-lanes-ruler">{ticks.map((t) => <span key={t} style={{ left: `${(t / length) * 100}%` }}>{Math.round(t)}{unit}</span>)}</div>
        <div ref={area} className="pa-lanes-area">
          {names.map((n, lane) => (
            <div key={lane} className="pa-lane" onDoubleClick={(e) => addAt(lane, e)} title="Double-click to add a block">
              <span className="pa-lane-name">{n}</span>
              {value.filter((it) => it.lane === lane).map((it) => (
                <div key={it.id} className="pa-block" style={{ left: `${(it.start / length) * 100}%`, width: `${(it.length / length) * 100}%` }} onPointerDown={grab(it, "move")} onDoubleClick={(e) => { e.stopPropagation(); setEditing(it.id); }}>
                  {editing === it.id
                    ? <input autoFocus className="pa-block-input" defaultValue={it.label} aria-label="Block name" onBlur={(e) => { set(value.map((x) => (x.id === it.id ? { ...x, label: e.target.value.slice(0, 40) || x.label } : x)), `${label}: named a block`); setEditing(null); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Delete" && !(e.target as HTMLInputElement).value) { set(value.filter((x) => x.id !== it.id)); setEditing(null); } }} />
                    : <span>{it.label}</span>}
                  <i className="pa-block-end" onPointerDown={grab(it, "size")} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Histogram({ surface }: { surface: string }) {
  useImageStats();
  const hist = imageStats(surface).hist;
  if (!hist) return <div className="pa-hist is-empty">Reading the picture…</div>;
  const max = Math.max(1, ...hist.slice(0, 3).flat());
  const path = (bins: number[]) => `M 0 100 ${bins.map((v, i) => `L ${(i / (bins.length - 1)) * 100} ${100 - (v / max) * 96}`).join(" ")} L 100 100 Z`;
  // Clipping: a pile-up in the luminance's first or last bin, against its own tallest.
  const lum = hist[3]!;
  const top = Math.max(1, ...lum);
  const clipLo = lum[0]! > top * 0.2 && lum[0]! > lum[1]! * 2;
  const clipHi = lum[63]! > top * 0.2 && lum[63]! > lum[62]! * 2;
  return (
    <div className="pa-hist" data-atom="histogram">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Histogram" role="img">
        <path d={path(hist[0]!)} className="pa-hist-r" /><path d={path(hist[1]!)} className="pa-hist-g" /><path d={path(hist[2]!)} className="pa-hist-b" />
      </svg>
      {(clipLo || clipHi) && <span className="pa-hist-warn">{clipLo && clipHi ? "Clipping at both ends" : clipLo ? "Shadows clipping" : "Highlights clipping"}</span>}
    </div>
  );
}

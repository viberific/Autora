import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { GRID, PANEL_MAX_W, PANEL_MIN_W, snap, type Canvas, type Panel, type Surface } from "../../lib/panacea/canvas";
import { KINDS } from "../../lib/panacea/kinds";
import type { Recipe } from "../../lib/panacea/library";
import { IconX } from "../Icons";
import { PanelCard, type PanelActions } from "./PanelCard";
import { SurfaceView } from "./Surfaces";
import { Summon } from "./Summon";
import type { Editor } from "./useCanvas";

interface View { x: number; y: number; zoom: number }

/** What the window and the agent's hand can ask of the board. */
export interface BoardHandle {
  /** Bring a canvas point into view if it is not, and say where it is on screen. */
  reveal: (x: number, y: number) => Promise<{ x: number; y: number }>;
  /** The board's element: where the grid is, for a double-click. */
  grid: () => HTMLElement | null;
  /** The screen point of a canvas point. */
  toScreen: (x: number, y: number) => { x: number; y: number };
  zoom: () => number;
  /** Open the picker at the middle of what is on screen. */
  summonHere: () => void;
  /** What is on screen, in canvas pixels, less the strip along the bottom. */
  viewRect: () => { x: number; y: number; w: number; h: number };
}

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2;

/**
 * The canvas: a dotted grid as far as the person cares to go. Drag the grid (or scroll) to pan, Ctrl+scroll to zoom,
 * double-click or press / to summon a panel, Shift+drag to pick several, drop a file or paste a table to add a surface.
 * Panels move by their title bars and widen by their right edge, and land on the grid.
 */
export function Board({ canvas, fresh, edit, hold, recipes, actions, selected, setSelected, onPick, onFocus, onFiles, onPaste, onRemoveSurface, onSurfaceSize, onMoved, handle, children }: {
  canvas: Canvas;
  fresh: ReadonlySet<string>;
  edit: Editor;
  hold: (on: boolean) => void;
  recipes: Recipe[];
  actions: Omit<PanelActions, "grab" | "widen">;
  selected: ReadonlySet<string>;
  setSelected: (ids: Set<string>) => void;
  onPick: (r: Recipe, at: { x: number; y: number }) => void;
  onFocus: (surface: string) => void;
  onFiles: (files: File[], at: { x: number; y: number }) => void;
  onPaste: (text: string, at: { x: number; y: number }) => void;
  onRemoveSurface: (s: Surface) => void;
  onSurfaceSize: (s: Surface, px: { w: number; h: number }) => void;
  onMoved: (panel: Panel, box: { x: number; y: number; w: number }) => void;
  handle: MutableRefObject<BoardHandle | null>;
  children?: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [view, setViewState] = useState<View>({ x: -80, y: -60, zoom: 1 });
  const viewRef = useRef(view);
  const [glide, setGlide] = useState(false);
  const glideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Move the view; `smooth` for a move the person did not make themselves, so it glides instead of jumping. */
  const setView = useCallback((v: View, smooth = false) => {
    viewRef.current = v;
    setViewState(v);
    if (glideTimer.current) clearTimeout(glideTimer.current);
    setGlide(smooth);
    if (smooth) glideTimer.current = setTimeout(() => setGlide(false), 450);
  }, []);
  const [drag, setDrag] = useState<{ ids: Set<string>; dx: number; dy: number } | null>(null);
  const [widen, setWiden] = useState<{ id: string; w: number } | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [summon, setSummon] = useState<{ sx: number; sy: number; at: { x: number; y: number } } | null>(null);
  const fitted = useRef(false);

  const toWorld = useCallback((cx: number, cy: number) => {
    const r = root.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: v.x + (cx - r.left) / v.zoom, y: v.y + (cy - r.top) / v.zoom };
  }, []);
  const toScreen = useCallback((x: number, y: number) => {
    const r = root.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: r.left + (x - v.x) * v.zoom, y: r.top + (y - v.y) * v.zoom };
  }, []);

  // The first time there is something on the canvas, frame it.
  useEffect(() => {
    if (fitted.current || !root.current) return;
    const boxes = [...canvas.surfaces, ...canvas.panels.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h || 240 }))];
    if (!boxes.length) {
      const r = root.current.getBoundingClientRect();
      setView({ x: -r.width / 2, y: -r.height / 3, zoom: 1 });
      return;
    }
    fitted.current = true;
    const x0 = Math.min(...boxes.map((b) => b.x));
    const y0 = Math.min(...boxes.map((b) => b.y));
    const x1 = Math.max(...boxes.map((b) => b.x + b.w));
    const y1 = Math.max(...boxes.map((b) => b.y + b.h));
    const r = root.current.getBoundingClientRect();
    const zoom = Math.max(MIN_ZOOM, Math.min(1, (r.width - 64) / Math.max(1, x1 - x0), (r.height - 140) / Math.max(1, y1 - y0)));
    setView({ x: x0 - (r.width / zoom - (x1 - x0)) / 2, y: y0 - (r.height / zoom - (y1 - y0)) / 2 + 20, zoom });
  }, [canvas.surfaces, canvas.panels, setView]);

  // A new surface the agent added off screen comes into view.
  const surfaceCount = useRef(canvas.surfaces.length);
  useEffect(() => {
    if (canvas.surfaces.length > surfaceCount.current && root.current) {
      const s = canvas.surfaces.at(-1)!;
      const r = root.current.getBoundingClientRect();
      const v = viewRef.current;
      const inView = s.x >= v.x && s.y >= v.y && s.x + s.w <= v.x + r.width / v.zoom && s.y + s.h <= v.y + r.height / v.zoom;
      if (!inView) setView({ ...v, x: s.x - 48 / v.zoom, y: s.y - 48 / v.zoom }, true);
    }
    surfaceCount.current = canvas.surfaces.length;
  }, [canvas.surfaces, setView]);

  // A panel placed off screen (the agent's, or one that had nowhere closer to go) comes into view: measured as
  // drawn, so a tall one is not left under the strip along the bottom.
  const seenPanels = useRef(new Set(canvas.panels.map((p) => p.id)));
  useEffect(() => {
    // A ghost is only an offer: it never moves the person's view away from what they are doing.
    const fresh = canvas.panels.filter((p) => !seenPanels.current.has(p.id) && p.state !== "ghost").map((p) => p.id);
    seenPanels.current = new Set(canvas.panels.map((p) => p.id));
    if (!fresh.length || !root.current || drag) return;
    const frame = requestAnimationFrame(() => {
      const el = root.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const boxes = fresh.map((id) => el.querySelector(`[data-panel="${CSS.escape(id)}"]`)?.getBoundingClientRect()).filter((b): b is DOMRect => !!b);
      if (!boxes.length) return;
      const top = Math.min(...boxes.map((b) => b.top));
      const bottom = Math.max(...boxes.map((b) => b.bottom));
      const left = Math.min(...boxes.map((b) => b.left));
      const right = Math.max(...boxes.map((b) => b.right));
      const floor = r.bottom - 76;
      let dx = 0;
      let dy = 0;
      if (top < r.top + 16) dy = top - (r.top + 16);
      else if (bottom > floor) dy = Math.min(bottom - floor, top - (r.top + 16));
      if (left < r.left + 16) dx = left - (r.left + 16);
      else if (right > r.right - 16) dx = Math.min(right - (r.right - 16), left - (r.left + 16));
      if (!dx && !dy) return;
      const v = viewRef.current;
      setView({ ...v, x: v.x + dx / v.zoom, y: v.y + dy / v.zoom }, true);
    });
    return () => cancelAnimationFrame(frame);
  }, [canvas.panels, drag, setView]);

  handle.current = {
    reveal: async (x, y) => {
      const r = root.current!.getBoundingClientRect();
      const v = viewRef.current;
      const margin = 80 / v.zoom;
      if (x < v.x + margin || y < v.y + margin || x > v.x + r.width / v.zoom - margin || y > v.y + r.height / v.zoom - margin) {
        setView({ ...v, x: x - r.width / v.zoom / 2, y: y - r.height / v.zoom / 3 }, true);
        await new Promise((res) => setTimeout(res, 380));
      }
      return toScreen(x, y);
    },
    grid: () => root.current,
    toScreen,
    zoom: () => viewRef.current.zoom,
    viewRect: () => {
      const r = root.current!.getBoundingClientRect();
      const v = viewRef.current;
      return { x: v.x + 16 / v.zoom, y: v.y + 16 / v.zoom, w: (r.width - 32) / v.zoom, h: (r.height - 90) / v.zoom };
    },
    summonHere: () => {
      const r = root.current!.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 3;
      setSummon({ sx: r.width / 2, sy: r.height / 3, at: toWorld(cx, cy) });
    },
  };

  // ------------------------------------------------------------ the grid --

  const onGridDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) return;
    if ((e.target as HTMLElement).closest(".pa-panel, .pa-surface, .pa-summon, .pa-chrome")) return;
    e.preventDefault();
    root.current?.focus({ preventScroll: true });
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    if (e.shiftKey) {
      const a = toWorld(e.clientX, e.clientY);
      setMarquee({ x0: a.x, y0: a.y, x1: a.x, y1: a.y });
      const move = (ev: PointerEvent) => { const b = toWorld(ev.clientX, ev.clientY); setMarquee({ x0: a.x, y0: a.y, x1: b.x, y1: b.y }); };
      const up = (ev: PointerEvent) => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        const b = toWorld(ev.clientX, ev.clientY);
        const [lx, hx] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
        const [ly, hy] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
        setSelected(new Set(canvas.panels.filter((p) => p.x < hx && p.x + p.w > lx && p.y < hy && p.y + (p.h || 200) > ly).map((p) => p.id)));
        setMarquee(null);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      return;
    }
    if (selected.size) setSelected(new Set());
    const start = { x: e.clientX, y: e.clientY, v: viewRef.current };
    const move = (ev: PointerEvent) => setView({ ...start.v, x: start.v.x - (ev.clientX - start.x) / start.v.zoom, y: start.v.y - (ev.clientY - start.y) / start.v.zoom });
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  // Wheel: pan, or zoom about the pointer with Ctrl (a pinch on a trackpad comes as Ctrl+wheel). Not passive, so it can stop the page scrolling.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest(".pa-table-wrap, .pa-summon-list, .pa-menu, textarea")) return;
      e.preventDefault();
      const v = viewRef.current;
      if (e.ctrlKey || e.metaKey) {
        const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * Math.exp(-e.deltaY * 0.0025)));
        const r = el.getBoundingClientRect();
        const wx = v.x + (e.clientX - r.left) / v.zoom;
        const wy = v.y + (e.clientY - r.top) / v.zoom;
        setView({ zoom, x: wx - (e.clientX - r.left) / zoom, y: wy - (e.clientY - r.top) / zoom });
      } else setView({ ...v, x: v.x + e.deltaX / v.zoom, y: v.y + e.deltaY / v.zoom });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [setView]);

  const onDouble = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest(".pa-panel, .pa-surface, .pa-summon, .pa-chrome")) return;
    const r = root.current!.getBoundingClientRect();
    setSummon({ sx: e.clientX - r.left, sy: e.clientY - r.top, at: toWorld(e.clientX, e.clientY) });
  };

  // ---------------------------------------------------------- the panels --

  const grab = useCallback((panel: Panel, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey) {
      const next = new Set(selected);
      if (next.has(panel.id)) next.delete(panel.id); else next.add(panel.id);
      setSelected(next);
      return;
    }
    // What moves: the picked panels if this is one of them, and everything grouped with any of them.
    const base = selected.has(panel.id) ? new Set(selected) : new Set([panel.id]);
    for (const p of canvas.panels) if (p.group && [...base].some((id) => canvas.panels.find((q) => q.id === id)?.group === p.group)) base.add(p.id);
    if (!selected.has(panel.id)) setSelected(new Set([panel.id]));
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    hold(true);
    const z = viewRef.current.zoom;
    const sx = e.clientX;
    const sy = e.clientY;
    let last = { dx: 0, dy: 0 };
    const move = (ev: PointerEvent) => { last = { dx: (ev.clientX - sx) / z, dy: (ev.clientY - sy) / z }; setDrag({ ids: base, ...last }); };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setDrag(null);
      hold(false);
      if (Math.abs(last.dx) < 2 && Math.abs(last.dy) < 2) return;
      edit((d) => {
        for (const p of d.panels) if (base.has(p.id)) { p.x = snap(p.x + last.dx); p.y = snap(p.y + last.dy); }
      }, base.size > 1 ? `Moved ${base.size} panels` : `Moved ${panel.title}`);
      onMoved(panel, { x: snap(panel.x + last.dx), y: snap(panel.y + last.dy), w: panel.w });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }, [canvas.panels, selected, setSelected, hold, edit, onMoved]);

  const widenStart = useCallback((panel: Panel, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    hold(true);
    const z = viewRef.current.zoom;
    const sx = e.clientX;
    let w = panel.w;
    const move = (ev: PointerEvent) => { w = Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, panel.w + (ev.clientX - sx) / z)); setWiden({ id: panel.id, w }); };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      setWiden(null);
      hold(false);
      if (Math.abs(w - panel.w) >= GRID / 2) edit((d) => { const p = d.panels.find((x) => x.id === panel.id); if (p) p.w = snap(w); }, `Resized ${panel.title}`);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  }, [hold, edit]);

  const panelActions = useMemo<PanelActions>(() => ({ ...actions, grab, widen: widenStart }), [actions, grab, widenStart]);

  // ------------------------------------------------------ files and paste --

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    e.preventDefault();
    onFiles(files, toWorld(e.clientX, e.clientY));
  };
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const paste = (e: ClipboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      const files = [...(e.clipboardData?.files ?? [])];
      const r = el.getBoundingClientRect();
      const at = toWorld(r.left + r.width / 2, r.top + r.height / 2);
      if (files.length) { e.preventDefault(); onFiles(files, at); }
      else if (text.includes("\n") && /[\t,;]/.test(text)) { e.preventDefault(); onPaste(text, at); }
    };
    el.addEventListener("paste", paste);
    return () => el.removeEventListener("paste", paste);
  }, [onFiles, onPaste, toWorld]);

  const z = view.zoom;
  const dot = GRID * 1.5 * z;
  const bg = {
    backgroundSize: `${dot}px ${dot}px`,
    backgroundPosition: `${-view.x * z}px ${-view.y * z}px`,
  };
  return (
    <div
      ref={root}
      className="pa-board"
      style={bg}
      tabIndex={-1}
      onPointerDown={onGridDown}
      onDoubleClick={onDouble}
      // The canvas pans by its view, never by scrolling: a focus or scrollIntoView inside it must not shift it.
      onScroll={(e) => { e.currentTarget.scrollTop = 0; e.currentTarget.scrollLeft = 0; }}
      onDragOver={(e) => { if ([...e.dataTransfer.types].includes("Files")) e.preventDefault(); }}
      onDrop={onDrop}
      aria-label="The canvas: double-click for a panel, drop a photo or a table"
    >
      <div className={`pa-world${glide ? " is-glide" : ""}`} style={{ transform: `scale(${z}) translate(${-view.x}px, ${-view.y}px)` }}>
        {canvas.surfaces.map((s) => (
          <section
            key={s.id}
            className={`pa-surface is-${s.kind}${canvas.focus === s.id ? " is-focus" : ""}`}
            data-surface={s.id}
            style={{ left: s.x, top: s.y, width: s.w, height: s.h }}
            onPointerDown={(e) => { if (canvas.focus !== s.id && !(e.target as HTMLElement).closest("button")) onFocus(s.id); }}
            aria-label={`${s.title}, ${KINDS[s.kind].noun}`}
          >
            <header className="pa-surface-head">
              <span className="pa-title">{s.title}</span>
              <span className="pa-surface-meta">{KINDS[s.kind].meta(s)}</span>
              <button type="button" className="pa-surface-x" aria-label={`Remove ${s.title}`} onClick={() => onRemoveSurface(s)}><IconX size={11} /></button>
            </header>
            <div className="pa-surface-body">
              <SurfaceView surface={s} onSize={(px) => onSurfaceSize(s, px)} />
            </div>
          </section>
        ))}
        {canvas.panels.map((p) => (
          <PanelCard
            key={p.id}
            panel={p}
            selected={selected.has(p.id)}
            fresh={fresh.has(p.id)}
            offset={drag?.ids.has(p.id) ? { dx: drag.dx, dy: drag.dy } : null}
            width={widen?.id === p.id ? widen.w : null}
            actions={panelActions}
          />
        ))}
        {marquee && (
          <div className="pa-marquee" style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }} />
        )}
      </div>
      {summon && (
        <Summon
          x={summon.sx}
          y={summon.sy}
          recipes={recipes}
          onClose={() => setSummon(null)}
          onPick={(r) => { setSummon(null); onPick(r, summon.at); }}
        />
      )}
      {children}
    </div>
  );
}

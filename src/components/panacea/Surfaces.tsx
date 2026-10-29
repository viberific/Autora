import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import type { Value } from "../../lib/panacea/atoms";
import type { Surface } from "../../lib/panacea/canvas";
import type { SurfaceKind } from "../../lib/panacea/kinds";
import { DataTable } from "./Chart";
import { ImageEngine, outputAspect, paletteOf, setImageStats } from "./imagegl";

/** The pictures on the canvas, loaded once each: for export and auto, which need the original. */
const pictures = new Map<string, HTMLImageElement>();
export const pictureOf = (surface: string) => pictures.get(surface) ?? null;

/**
 * An image surface: the picture with every adjustment, drawn live on the GPU at the card's size. With Before / after
 * on, a line to drag across it shows the original on its left. Its histogram and palette are published for the panels
 * that read them.
 */
function ImageView({ surface, onSize }: { surface: Surface; onSize: (px: { w: number; h: number }) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<ImageEngine | null>(null);
  const [loaded, setLoaded] = useState<{ w: number; h: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [split, setSplit] = useState(0.5);
  const [room, setRoom] = useState({ w: 0, h: 0 });
  const params = surface.params;
  const compare = params.compare === true;
  const sized = useRef(onSize);
  sized.current = onSize;

  // The picture.
  useEffect(() => {
    if (!surface.artifact) { setProblem("This picture's file is not here."); return; }
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      pictures.set(surface.id, img);
      try {
        engine.current ??= new ImageEngine(canvas.current!);
        engine.current.setImage(img);
        setLoaded({ w: img.naturalWidth, h: img.naturalHeight });
        setImageStats(surface.id, { palette: paletteOf(img) });
        sized.current({ w: img.naturalWidth, h: img.naturalHeight });
      } catch (err) {
        setProblem(err instanceof Error ? err.message : String(err));
      }
    };
    img.onerror = () => setProblem("The picture could not be loaded.");
    img.src = `/api/artifacts/${encodeURIComponent(surface.artifact)}`;
  }, [surface.artifact, surface.id]);

  // The room the card gives it.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setRoom({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Drawn whenever a setting or the room changes; the histogram read off it a moment later.
  const histTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const e = engine.current;
    const c = canvas.current;
    if (!e || !c || !loaded || !room.w || !room.h) return;
    const a = outputAspect(params, loaded.w, loaded.h);
    let w = room.w;
    let h = w / a;
    if (h > room.h) { h = room.h; w = h * a; }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.style.width = `${Math.round(w)}px`;
    c.style.height = `${Math.round(h)}px`;
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
    const frame = requestAnimationFrame(() => {
      e.render(params, compare ? split : null);
      if (histTimer.current) clearTimeout(histTimer.current);
      histTimer.current = setTimeout(() => {
        // The histogram is of the edit, not of the before half.
        if (compare) e.render(params, null);
        setImageStats(surface.id, { hist: e.histogram() });
        if (compare) e.render(params, split);
      }, 90);
    });
    return () => cancelAnimationFrame(frame);
  }, [params, loaded, room, compare, split, surface.id]);

  useEffect(() => () => { if (histTimer.current) clearTimeout(histTimer.current); }, []);

  const drag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget.parentElement!;
    const r = el.getBoundingClientRect();
    const at = (x: number) => setSplit(Math.min(1, Math.max(0, (x - r.left) / r.width)));
    const target = e.currentTarget;
    target.setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => at(ev.clientX);
    const up = () => { target.removeEventListener("pointermove", move); target.removeEventListener("pointerup", up); };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  return (
    <div className="pa-image" ref={box}>
      <div className="pa-image-frame">
        <canvas ref={canvas} aria-label={`${surface.title}, as edited`} role="img" />
        {compare && loaded && (
          <>
            <div className="pa-split" style={{ left: `${split * 100}%` }} onPointerDown={drag} role="slider" aria-label="Before and after" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(split * 100)}><i /></div>
            <span className="pa-split-tag is-before">Before</span><span className="pa-split-tag is-after">After</span>
          </>
        )}
      </div>
      {!loaded && !problem && <span className="pa-image-wait">Opening the picture…</span>}
      {problem && <span className="pa-image-wait is-problem">{problem}</span>}
    </div>
  );
}

/** A data surface: the table itself, as its filters leave it. */
function DataView({ surface }: { surface: Surface }) {
  if (!surface.table) return <div className="pa-chart-empty">This table's rows are gone.</div>;
  return <DataTable table={surface.table} params={surface.params as Record<string, Value>} limit={200} />;
}

/** How each kind of surface is drawn on the board. A kind added to the registry does not compile until it has a view here. */
const VIEWS: Record<SurfaceKind, (p: { surface: Surface; onSize: (px: { w: number; h: number }) => void }) => ReactElement> = {
  image: ({ surface, onSize }) => <ImageView surface={surface} onSize={onSize} />,
  data: ({ surface }) => <DataView surface={surface} />,
};

export function SurfaceView({ surface, onSize }: { surface: Surface; onSize: (px: { w: number; h: number }) => void }) {
  const View = VIEWS[surface.kind];
  return <View surface={surface} onSize={onSize} />;
}

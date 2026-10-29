import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Value } from "../../lib/panacea/atoms";
import type { Surface } from "../../lib/panacea/canvas";
import { cropOf, geometry, invert3, isSelectTool, newImageDoc, outputAspect, selectionOf, thinPoints, toOutput, toSource, type Selection } from "../../lib/panacea/image";
import { maskBounds, maskEdge } from "../../lib/panacea/mask";
import { DataTable } from "./Chart";
import { Picture, workSize } from "./compose";
import { usePanacea } from "./context";
import { ImageEngine, outputSize, paletteOf, setImageStats } from "./imagegl";

/** The pictures on the canvas, loaded once each: for export and auto, which need the original. */
const pictures = new Map<string, HTMLImageElement>();
export const pictureOf = (surface: string) => pictures.get(surface) ?? null;

/** What the window and the agent's hand can ask of an image on screen. */
interface ImageHandle {
  /** The photo at its working size, for the segmentation model. */
  work: () => HTMLCanvasElement | null;
  /** The box around a selection from its pixels. */
  bounds: (sel: Selection) => { x: number; y: number; w: number; h: number } | null;
  /** The screen point of a point on the photo (0..1). */
  toScreen: (x: number, y: number) => { x: number; y: number } | null;
  /** Where the tools take the pointer. */
  overlay: () => HTMLCanvasElement | null;
  /** The picture as it looks now, with the selection outlined, as a PNG (what the agent is shown). */
  snapshot: (grid: boolean) => Promise<Blob | null>;
  /** The layers and masks at a size, for an export at full size. */
  picture: () => Picture | null;
}
const handles = new Map<string, ImageHandle>();
export const imageHandle = (surface: string) => handles.get(surface) ?? null;

/** Masks the segmentation model made, by id: kept on the server, loaded once. */
const masks = new Map<string, HTMLImageElement | "loading" | "failed">();
let maskTick = 0;
const maskWatchers = new Set<() => void>();
function maskFrom(session: string, id: string, w: number, h: number): Uint8Array | null {
  const m = masks.get(id);
  if (!m) {
    masks.set(id, "loading");
    const img = new Image();
    img.onload = () => { masks.set(id, img); maskTick++; for (const fn of maskWatchers) fn(); };
    img.onerror = () => masks.set(id, "failed");
    img.src = `/api/panacea/${encodeURIComponent(session)}/mask/${encodeURIComponent(id)}`;
    return null;
  }
  if (typeof m === "string") return null;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(m, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = d[i * 4]!;
  return out;
}

/** Placed pictures (a layer's artifact), loaded once. */
const placed = new Map<string, HTMLImageElement | "loading">();
function placedFrom(artifact: string): HTMLImageElement | null {
  const m = placed.get(artifact);
  if (m instanceof HTMLImageElement) return m;
  if (!m) {
    placed.set(artifact, "loading");
    const img = new Image();
    img.onload = () => { placed.set(artifact, img); maskTick++; for (const fn of maskWatchers) fn(); };
    img.src = `/api/artifacts/${encodeURIComponent(artifact)}`;
  }
  return null;
}

type Gesture =
  | { tool: "marquee" | "ellipse"; a: [number, number]; b: [number, number]; mode: string }
  | { tool: "crop-new"; a: [number, number]; b: [number, number]; mode: string }
  | { tool: "lasso" | "quick" | "brush" | "eraser" | "heal"; pts: number[]; mode: string }
  | { tool: "polygon"; pts: number[]; hover: [number, number] | null; mode: string }
  | { tool: "move"; from: [number, number]; to: [number, number] }
  | { tool: "crop-move" | "crop-corner"; from: [number, number]; to: [number, number]; box: [number, number, number, number]; corner?: number };

const modeOf = (e: { shiftKey: boolean; altKey: boolean }, fallback: string) =>
  e.shiftKey && e.altKey ? "intersect" : e.shiftKey ? "add" : e.altKey ? "subtract" : fallback;

const num = (v: Value | undefined, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/**
 * An image surface: the picture with every layer and adjustment, drawn live on the GPU at the card's size, and the
 * engine's tools on it: select (box, ellipse, lasso, polygon, brush, wand, colour range, object), move a layer, crop,
 * paint, erase, heal, text, the eyedropper. The selection shows as marching ants. With Before / after on, a line to drag
 * across it shows the original on its left. Its histogram and palette are published for the panels that read them.
 */
export function ImageView({ surface, onSize }: { surface: Surface; onSize: (px: { w: number; h: number }) => void }) {
  const api = usePanacea();
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const engine = useRef<ImageEngine | null>(null);
  const pic = useRef<Picture | null>(null);
  const work = useRef<HTMLCanvasElement | null>(null);
  const [loaded, setLoaded] = useState<{ w: number; h: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [split, setSplit] = useState(0.5);
  const [room, setRoom] = useState({ w: 0, h: 0 });
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const hover = useRef<[number, number] | null>(null);
  const params = surface.params;
  const doc = surface.image ?? newImageDoc();
  const tool = String(params.tool ?? "pointer");
  const cropping = tool === "crop";
  const compare = params.compare === true;
  const sized = useRef(onSize);
  sized.current = onSize;
  const latest = useRef({ surface, params, doc, tool, loaded });
  latest.current = { surface, params, doc, tool, loaded };

  // Something loaded later (a placed picture, an object's mask): draw again.
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    maskWatchers.add(fn);
    return () => { maskWatchers.delete(fn); };
  }, []);

  // The picture.
  useEffect(() => {
    if (!surface.artifact) { setProblem("This picture's file is not here."); return; }
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      pictures.set(surface.id, img);
      try {
        engine.current ??= new ImageEngine(canvas.current!);
        const ws = workSize({ w: img.naturalWidth, h: img.naturalHeight }, Math.min(2048, engine.current.max));
        const c = document.createElement("canvas");
        c.width = ws.w;
        c.height = ws.h;
        c.getContext("2d")!.drawImage(img, 0, 0, ws.w, ws.h);
        work.current = c;
        pic.current = new Picture({ photo: c, picture: placedFrom, mask: (id, w, h) => maskFrom(api.sessionId, id, w, h) });
        setLoaded({ w: img.naturalWidth, h: img.naturalHeight });
        setImageStats(surface.id, { palette: paletteOf(img) });
        sized.current({ w: img.naturalWidth, h: img.naturalHeight });
      } catch (err) {
        setProblem(err instanceof Error ? err.message : String(err));
      }
    };
    img.onerror = () => setProblem("The picture could not be loaded.");
    img.src = `/api/artifacts/${encodeURIComponent(surface.artifact)}`;
  }, [surface.artifact, surface.id, api.sessionId]);

  useEffect(() => () => { engine.current?.dispose(); engine.current = null; handles.delete(surface.id); }, [surface.id]);

  // The room the card gives it.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setRoom({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The layers put together and the adjustments' masks, when they change (not on every slider).
  const layered = useMemo(() => {
    const p = pic.current;
    const c = work.current;
    if (!p || !c || !loaded) return null;
    const scale = c.width / loaded.w;
    const plain = Picture.plain(doc, params);
    return { base: plain ? c : p.compose(doc, params, c.width, c.height, scale), masks: p.masks(doc, c.width, c.height, scale) };
    // `tick` redraws once a placed picture or a mask has loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, JSON.stringify(doc.layers), JSON.stringify(doc.masks), JSON.stringify(Object.entries(params).filter(([k]) => k.startsWith("layer."))), tick]);

  // Drawn whenever a setting or the room changes; the histogram read off it a moment later.
  const histTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [drawn, setDrawn] = useState(0);
  useEffect(() => {
    const e = engine.current;
    const c = canvas.current;
    if (!e || !c || !loaded || !layered || !room.w || !room.h) return;
    e.setImage(layered.base, work.current!);
    e.setMasks(layered.masks);
    const a = outputAspect(params, loaded.w, loaded.h, cropping);
    let w = room.w;
    let h = w / a;
    if (h > room.h) { h = room.h; w = h * a; }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.style.width = `${Math.round(w)}px`;
    c.style.height = `${Math.round(h)}px`;
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
    const o = overlay.current;
    if (o) { o.style.width = c.style.width; o.style.height = c.style.height; if (o.width !== pw || o.height !== ph) { o.width = pw; o.height = ph; } }
    const frame = requestAnimationFrame(() => {
      e.render(params, compare ? split : null, cropping);
      setDrawn((n) => n + 1);
      if (histTimer.current) clearTimeout(histTimer.current);
      histTimer.current = setTimeout(() => {
        // The histogram is of the edit, not of the before half.
        if (compare) e.render(params, null, cropping);
        setImageStats(surface.id, { hist: e.histogram() });
        if (compare) e.render(params, split, cropping);
      }, 90);
    });
    return () => cancelAnimationFrame(frame);
  }, [params, loaded, layered, room, compare, split, surface.id, cropping]);

  useEffect(() => () => { if (histTimer.current) clearTimeout(histTimer.current); }, []);

  // ------------------------------------------------------------ geometry --

  /** The pointer as a point on the picture as shown (0..1). */
  const outAt = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = canvas.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width))), Math.min(1, Math.max(0, (e.clientY - r.top) / Math.max(1, r.height)))];
  };
  const toSrc = (p: [number, number]): [number, number] => {
    const { params: pr, loaded: l } = latest.current;
    return toSource(pr, l!, p[0], p[1], latest.current.tool === "crop");
  };
  /** Is the picture shown square to the photo (no straighten, a quarter turn at most), so a box stays a box? */
  const square = () => num(latest.current.params.straighten, 0) === 0;

  // ------------------------------------------------------------- overlay --

  const ants = useRef<{ key: string; edge: number[]; w: number; h: number; img: ImageData | null; canvas: HTMLCanvasElement | null }>({ key: "", edge: [], w: 0, h: 0, img: null, canvas: null });
  const phase = useRef(0);

  const paint = () => {
    const o = overlay.current;
    const c = canvas.current;
    const l = latest.current.loaded;
    if (!o || !c || !l) return;
    const g = o.getContext("2d")!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, o.width, o.height);
    const { params: pr, doc: d, tool: t } = latest.current;
    const W = o.width;
    const H = o.height;
    const crop = t === "crop";
    // The selection's edge, marching.
    const sel = selectionOf(d, pr);
    if (sel && pic.current && work.current) {
      const vs = workSize(l, Math.min(1400, Math.max(W, H)));
      const key = `${vs.w}x${vs.h}:${JSON.stringify(sel)}:${maskTick}`;
      const a = ants.current;
      if (a.key !== key) {
        const m = pic.current.raster(sel, vs.w, vs.h, vs.w / l.w);
        const e = maskEdge(m, vs.w, vs.h);
        a.edge = [];
        for (let i = 0; i < e.length; i++) if (e[i]) a.edge.push(i);
        a.key = key; a.w = vs.w; a.h = vs.h;
        a.canvas = document.createElement("canvas");
        a.canvas.width = vs.w; a.canvas.height = vs.h;
        a.img = new ImageData(vs.w, vs.h);
      }
      if (a.img && a.canvas) {
        const data = a.img.data;
        for (const i of a.edge) {
          const x = i % a.w; const y = (i / a.w) | 0;
          const on = ((x + y + phase.current) >> 2) & 1;
          data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = on ? 255 : 0;
          data[i * 4 + 3] = 255;
        }
        a.canvas.getContext("2d")!.putImageData(a.img, 0, 0);
        const m = invert3(geometry(pr, l.w, l.h, crop));
        // Photo pixels -> photo uv -> output uv -> overlay pixels.
        g.setTransform((W * m[0]) / a.w, (H * m[3]) / a.w, (W * m[1]) / a.h, (H * m[4]) / a.h, W * m[2], H * m[5]);
        g.imageSmoothingEnabled = false;
        g.drawImage(a.canvas, 0, 0);
        g.setTransform(1, 0, 0, 1, 0, 0);
      }
    }
    const P = (p: [number, number]) => [p[0] * W, p[1] * H] as const;
    const ink = (dash = true) => { g.lineWidth = 1.5; g.strokeStyle = "#ffffff"; g.setLineDash(dash ? [5, 4] : []); };
    // The crop frame: the rest dimmed.
    if (crop) {
      const gs = gesture.current;
      const [cx, cy, cw, ch] = gs && (gs.tool === "crop-move" || gs.tool === "crop-corner" || gs.tool === "crop-new") ? cropDraft(gs, pr) : cropOf(pr);
      g.fillStyle = "rgba(0,0,0,0.5)";
      g.fillRect(0, 0, W, cy * H);
      g.fillRect(0, (cy + ch) * H, W, (1 - cy - ch) * H);
      g.fillRect(0, cy * H, cx * W, ch * H);
      g.fillRect((cx + cw) * W, cy * H, (1 - cx - cw) * W, ch * H);
      ink(false);
      g.strokeRect(cx * W, cy * H, cw * W, ch * H);
      g.lineWidth = 0.75;
      for (const f of [1 / 3, 2 / 3]) {
        g.beginPath(); g.moveTo((cx + cw * f) * W, cy * H); g.lineTo((cx + cw * f) * W, (cy + ch) * H); g.stroke();
        g.beginPath(); g.moveTo(cx * W, (cy + ch * f) * H); g.lineTo((cx + cw) * W, (cy + ch * f) * H); g.stroke();
      }
      g.fillStyle = "#ffffff";
      for (const [x, y] of [[cx, cy], [cx + cw, cy], [cx, cy + ch], [cx + cw, cy + ch]]) g.fillRect(x! * W - 4, y! * H - 4, 8, 8);
    }
    const gs = gesture.current;
    if (gs) {
      ink();
      if (gs.tool === "marquee" || gs.tool === "ellipse") {
        const [ax, ay] = P(gs.a); const [bx, by] = P(gs.b);
        g.beginPath();
        if (gs.tool === "marquee") g.rect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
        else g.ellipse((ax + bx) / 2, (ay + by) / 2, Math.abs(bx - ax) / 2, Math.abs(by - ay) / 2, 0, 0, Math.PI * 2);
        g.stroke();
      } else if (gs.tool === "lasso" || gs.tool === "polygon") {
        g.beginPath();
        for (let i = 0; i < gs.pts.length; i += 2) { const x = gs.pts[i]! * W; const y = gs.pts[i + 1]! * H; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
        if (gs.tool === "polygon" && gs.hover) g.lineTo(gs.hover[0] * W, gs.hover[1] * H);
        g.stroke();
        if (gs.tool === "polygon") { g.fillStyle = "#ffffff"; for (let i = 0; i < gs.pts.length; i += 2) g.fillRect(gs.pts[i]! * W - 3, gs.pts[i + 1]! * H - 3, 6, 6); }
      } else if (gs.tool === "quick" || gs.tool === "brush" || gs.tool === "eraser" || gs.tool === "heal") {
        g.setLineDash([]);
        g.lineCap = "round";
        g.lineJoin = "round";
        g.lineWidth = brushPx();
        g.strokeStyle = gs.tool === "brush" ? String(pr.color ?? "#ffffff") : gs.tool === "eraser" ? "rgba(255,255,255,0.45)" : gs.tool === "heal" ? "rgba(120,200,255,0.5)" : "rgba(124,92,255,0.45)";
        g.globalAlpha = gs.tool === "brush" ? num(pr["tool.opacity"], 100) / 100 : 1;
        g.beginPath();
        for (let i = 0; i < gs.pts.length; i += 2) { const x = gs.pts[i]! * W; const y = gs.pts[i + 1]! * H; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
        if (gs.pts.length === 2) g.lineTo(gs.pts[0]! * W + 0.1, gs.pts[1]! * H);
        g.stroke();
        g.globalAlpha = 1;
      }
    }
    // A brush's size, under the pointer.
    const brushy = t === "quick" || t === "brush" || t === "eraser" || t === "heal";
    if (brushy && hover.current) {
      g.setLineDash([]);
      g.lineWidth = 1;
      g.strokeStyle = "#ffffff";
      g.beginPath();
      g.arc(hover.current[0] * W, hover.current[1] * H, brushPx() / 2, 0, Math.PI * 2);
      g.stroke();
      g.strokeStyle = "rgba(0,0,0,0.6)";
      g.beginPath();
      g.arc(hover.current[0] * W, hover.current[1] * H, brushPx() / 2 + 1, 0, Math.PI * 2);
      g.stroke();
    }
    g.setLineDash([]);
  };

  /** The brush's width in overlay pixels: a share of the photo's long side, as the photo is shown. */
  const brushPx = () => {
    const { params: pr, loaded: l } = latest.current;
    const o = overlay.current;
    if (!l || !o) return 10;
    const size = num(pr["tool.size"], 4) / 100;
    const k = Math.max(l.w, l.h);
    const a = toOutput(pr, l, 0.5, 0.5, latest.current.tool === "crop");
    const b = toOutput(pr, l, 0.5 + (size * k) / l.w, 0.5, latest.current.tool === "crop");
    return Math.max(2, Math.hypot((b[0] - a[0]) * o.width, (b[1] - a[1]) * o.height));
  };

  // Redrawn after every draw of the picture and every change; the ants march while there is a selection.
  const selKey = JSON.stringify([doc.selection, params["sel.feather"], params["sel.grow"], params["sel.invert"], params.crop, tool]);
  useEffect(() => { paint(); });
  useEffect(() => {
    if (!doc.selection.length) return;
    const t = setInterval(() => { phase.current = (phase.current + 1) % 8; paint(); }, 140);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey, drawn]);

  // ---------------------------------------------------------------- tools --

  const run = (name: string, args: Record<string, unknown>, label: string) => api.run(surface.id, name, args, label);
  const pts = (list: number[]) => {
    const out: Array<[number, number]> = [];
    for (let i = 0; i < list.length; i += 2) out.push(toSrc([list[i]!, list[i + 1]!]));
    return out;
  };

  /** A box or an ellipse drawn on the picture as shown, as a shape on the photo: a box while the view is square to it. */
  const finishShape = (g: Extract<Gesture, { tool: "marquee" | "ellipse" }>) => {
    const x0 = Math.min(g.a[0], g.b[0]); const x1 = Math.max(g.a[0], g.b[0]);
    const y0 = Math.min(g.a[1], g.b[1]); const y1 = Math.max(g.a[1], g.b[1]);
    if (x1 - x0 < 0.004 || y1 - y0 < 0.004) {
      // A click without a drag deselects, as everywhere.
      if (g.mode === "new") void run("select.none", {}, "Deselected");
      return;
    }
    if (square()) {
      const [ax, ay] = toSrc([x0, y0]);
      const [bx, by] = toSrc([x1, y1]);
      const box = { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay), mode: g.mode };
      void run(g.tool === "marquee" ? "select.rect" : "select.ellipse", box, g.tool === "marquee" ? "Selected a box" : "Selected an ellipse");
      return;
    }
    const ring: number[] = [];
    if (g.tool === "marquee") ring.push(x0, y0, x1, y0, x1, y1, x0, y1);
    else for (let k = 0; k < 64; k++) { const a = (k / 64) * Math.PI * 2; ring.push((x0 + x1) / 2 + (Math.cos(a) * (x1 - x0)) / 2, (y0 + y1) / 2 + (Math.sin(a) * (y1 - y0)) / 2); }
    void run("select.polygon", { points: pts(ring), mode: g.mode }, g.tool === "marquee" ? "Selected a box" : "Selected an ellipse");
  };

  const onDown = async (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const t = latest.current.tool;
    if (t === "pointer") return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    const at = outAt(e);
    const src = toSrc(at);
    const mode = modeOf(e, String(latest.current.params["tool.mode"] ?? "new"));
    const pr = latest.current.params;
    switch (t) {
      case "wand": void run("select.wand", { x: src[0], y: src[1], mode }, "Magic wand"); return;
      case "color": void run("select.color", { x: src[0], y: src[1], mode }, "Colour range"); return;
      case "object": {
        setBusy("Finding it…");
        try { await api.run(surface.id, "select.object", { x: src[0], y: src[1], mode }, "Selected an object"); } finally { setBusy(null); }
        return;
      }
      case "text": {
        await run("layer.text", { text: "Text", x: src[0], y: src[1] }, "Added text");
        api.setOn(surface.id, { tool: "move" }, "Move tool");
        return;
      }
      case "eyedropper": {
        const c = engine.current?.colorAt(at[0], at[1]);
        if (c) api.setOn(surface.id, { color: c }, `Took colour ${c}`);
        return;
      }
      case "polygon": {
        const g = gesture.current;
        if (g?.tool === "polygon") {
          const [fx, fy] = [g.pts[0]!, g.pts[1]!];
          const close = g.pts.length >= 6 && (Math.hypot((at[0] - fx) * el.clientWidth, (at[1] - fy) * el.clientHeight) < 10 || e.detail >= 2);
          if (close) { gesture.current = null; void run("select.polygon", { points: pts(g.pts), mode: g.mode }, "Selected around"); }
          else g.pts.push(at[0], at[1]);
        } else gesture.current = { tool: "polygon", pts: [at[0], at[1]], hover: null, mode };
        paint();
        return;
      }
    }
    el.setPointerCapture?.(e.pointerId);
    api.hold(true);
    if (t === "marquee" || t === "ellipse") gesture.current = { tool: t, a: at, b: at, mode };
    else if (t === "lasso" || t === "quick" || t === "brush" || t === "eraser" || t === "heal") gesture.current = { tool: t, pts: [at[0], at[1]], mode };
    else if (t === "move") gesture.current = { tool: "move", from: src, to: src };
    else if (t === "crop") {
      const box = cropOf(pr);
      const corners: Array<[number, number]> = [[box[0], box[1]], [box[0] + box[2], box[1]], [box[0], box[1] + box[3]], [box[0] + box[2], box[1] + box[3]]];
      const near = corners.findIndex(([cx, cy]) => Math.hypot((cx - at[0]) * el.clientWidth, (cy - at[1]) * el.clientHeight) < 14);
      const inside = at[0] > box[0] && at[0] < box[0] + box[2] && at[1] > box[1] && at[1] < box[1] + box[3];
      gesture.current = near >= 0 ? { tool: "crop-corner", from: at, to: at, box, corner: near } : inside && (box[2] < 1 || box[3] < 1) ? { tool: "crop-move", from: at, to: at, box } : { tool: "crop-new", a: at, b: at, mode };
    }
    const move = (ev: PointerEvent) => {
      const g = gesture.current;
      if (!g) return;
      const p = outAt(ev);
      if ("b" in g) g.b = p;
      else if ("pts" in g) { g.pts.push(p[0], p[1]); hover.current = p; }
      else if (g.tool === "move") {
        g.to = toSrc(p);
        moveLayer(g.from, g.to);
        g.from = g.to;
      } else g.to = p;
      paint();
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      api.hold(false);
      const g = gesture.current;
      gesture.current = null;
      if (!g) return;
      if (g.tool === "marquee" || g.tool === "ellipse") finishShape(g);
      else if (g.tool === "lasso") { if (g.pts.length >= 6) void run("select.polygon", { points: pts(thinPoints(g.pts)), mode: g.mode }, "Selected around"); }
      else if (g.tool === "quick") void run("select.brush", { points: pts(thinPoints(g.pts)), mode: g.mode === "new" && latest.current.doc.selection.length ? "add" : g.mode }, "Brushed a selection");
      else if (g.tool === "brush") void run("layer.paint", { points: pts(thinPoints(g.pts)) }, "Painted");
      else if (g.tool === "eraser") void run("layer.erase_stroke", { points: pts(thinPoints(g.pts)) }, "Erased");
      else if (g.tool === "heal") void run("layer.heal_stroke", { points: pts(thinPoints(g.pts)) }, "Healed");
      else if (g.tool === "crop-new" || g.tool === "crop-move" || g.tool === "crop-corner") {
        const b = cropDraft(g, latest.current.params);
        if (b[2] > 0.01 && b[3] > 0.01) api.setOn(surface.id, { crop: b.map((v) => Math.round(v * 10000) / 10000) }, "Cropped");
      }
      paint();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    paint();
  };

  /** The Move tool: the active layer goes with the pointer. */
  const moveLayer = (from: [number, number], to: [number, number]) => {
    const { doc: d, params: pr } = latest.current;
    const l = d.layers.find((x) => x.id === d.active);
    if (!l || l.kind === "photo" || l.kind === "fill" || l.kind === "heal") return;
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    if (!dx && !dy) return;
    const [kx, ky] = l.kind === "image" || l.kind === "text" ? ["x", "y"] : ["dx", "dy"];
    const base = (k: string, d0: number) => num(pr[`layer.${l.id}.${k}`], d0);
    api.setOn(surface.id, {
      [`layer.${l.id}.${kx}`]: Math.round((base(kx, kx === "x" ? 0.5 : 0) + dx) * 10000) / 10000,
      [`layer.${l.id}.${ky}`]: Math.round((base(ky, ky === "y" ? 0.5 : 0) + dy) * 10000) / 10000,
    }, `Moved ${l.name}`);
  };

  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const t = latest.current.tool;
    if (t === "quick" || t === "brush" || t === "eraser" || t === "heal") { hover.current = outAt(e); if (!gesture.current) paint(); }
    const g = gesture.current;
    if (g?.tool === "polygon") { g.hover = outAt(e); paint(); }
  };

  // Keys the tools take while the picture has the focus: Escape lets go of a polygon, Backspace takes its last corner,
  // Enter closes it.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const g = gesture.current;
      if (g?.tool !== "polygon") return;
      if (e.key === "Escape") { gesture.current = null; paint(); e.stopPropagation(); }
      else if (e.key === "Backspace" && g.pts.length > 2) { g.pts.length -= 2; paint(); e.preventDefault(); e.stopPropagation(); }
      else if (e.key === "Enter" && g.pts.length >= 6) { gesture.current = null; void run("select.polygon", { points: pts(g.pts), mode: g.mode }, "Selected around"); e.stopPropagation(); }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  });

  // A tool put down mid-gesture drops the gesture.
  useEffect(() => { gesture.current = null; }, [tool]);

  // ---------------------------------------------------------- the handle --

  useEffect(() => {
    handles.set(surface.id, {
      work: () => work.current,
      bounds: (sel) => {
        const l = latest.current.loaded;
        if (!pic.current || !l) return null;
        const vs = workSize(l, 1024);
        return maskBounds(pic.current.raster(sel, vs.w, vs.h, vs.w / l.w), vs.w, vs.h);
      },
      toScreen: (x, y) => {
        const c = canvas.current;
        const l = latest.current.loaded;
        if (!c || !l) return null;
        const [u, v] = toOutput(latest.current.params, l, x, y, latest.current.tool === "crop");
        const r = c.getBoundingClientRect();
        return { x: r.left + u * r.width, y: r.top + v * r.height };
      },
      overlay: () => overlay.current,
      picture: () => pic.current,
      snapshot: async (grid) => {
        const c = canvas.current;
        const o = overlay.current;
        if (!c) return null;
        const out = document.createElement("canvas");
        out.width = c.width;
        out.height = c.height;
        const g = out.getContext("2d")!;
        g.drawImage(c, 0, 0);
        if (o) g.drawImage(o, 0, 0);
        if (grid) {
          // A tenth-of-the-way grid with its numbers, so a point can be named as x, y from 0 to 1.
          g.strokeStyle = "rgba(255,255,255,0.35)";
          g.fillStyle = "rgba(255,255,255,0.85)";
          g.lineWidth = 1;
          g.font = `${Math.max(10, Math.round(out.width / 60))}px sans-serif`;
          for (let k = 1; k < 10; k++) {
            const x = (k / 10) * out.width; const y = (k / 10) * out.height;
            g.beginPath(); g.moveTo(x, 0); g.lineTo(x, out.height); g.stroke();
            g.beginPath(); g.moveTo(0, y); g.lineTo(out.width, y); g.stroke();
            g.fillText((k / 10).toFixed(1), x + 2, 12);
            g.fillText((k / 10).toFixed(1), 2, y - 2);
          }
        }
        return await new Promise<Blob | null>((res) => out.toBlob(res, "image/png"));
      },
    });
  });

  // ------------------------------------------------------- before / after --

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
        <canvas ref={canvas} className="pa-image-gl" aria-label={`${surface.title}, as edited`} role="img" />
        <canvas
          ref={overlay}
          className={`pa-image-tools is-${tool}${isSelectTool(tool) ? " is-select" : ""}`}
          data-tool={tool}
          aria-label={`${surface.title}: the ${tool} tool`}
          onPointerDown={(e) => void onDown(e)}
          onPointerMove={onMove}
          onPointerLeave={() => { hover.current = null; paint(); }}
        />
        {compare && loaded && (
          <>
            <div className="pa-split" style={{ left: `${split * 100}%` }} onPointerDown={drag} role="slider" aria-label="Before and after" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(split * 100)}><i /></div>
            <span className="pa-split-tag is-before">Before</span><span className="pa-split-tag is-after">After</span>
          </>
        )}
      </div>
      {!loaded && !problem && <span className="pa-image-wait">Opening the picture…</span>}
      {busy && <span className="pa-image-wait is-busy" role="status">{busy}</span>}
      {problem && <span className="pa-image-wait is-problem">{problem}</span>}
    </div>
  );
}

/** The crop frame a drag is making: a new one (kept to the aspect when one is set), moved, or a corner pulled. */
function cropDraft(g: Gesture, params: Record<string, Value>): [number, number, number, number] {
  const fixed = /^\d+:\d+$/.test(String(params.aspect ?? ""));
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  if (g.tool === "crop-new") {
    let x0 = Math.min(g.a[0], g.b[0]); let x1 = Math.max(g.a[0], g.b[0]);
    let y0 = Math.min(g.a[1], g.b[1]); let y1 = Math.max(g.a[1], g.b[1]);
    if (fixed) { const s = Math.min(x1 - x0, y1 - y0); if (g.b[0] < g.a[0]) x0 = x1 - s; else x1 = x0 + s; if (g.b[1] < g.a[1]) y0 = y1 - s; else y1 = y0 + s; }
    return [clamp01(x0), clamp01(y0), clamp01(x1) - clamp01(x0), clamp01(y1) - clamp01(y0)];
  }
  if (g.tool === "crop-move") {
    const [x, y, w, h] = g.box;
    const nx = Math.min(1 - w, Math.max(0, x + g.to[0] - g.from[0]));
    const ny = Math.min(1 - h, Math.max(0, y + g.to[1] - g.from[1]));
    return [nx, ny, w, h];
  }
  if (g.tool === "crop-corner") {
    const [x, y, w, h] = g.box;
    const c = g.corner ?? 3;
    let x0 = x; let y0 = y; let x1 = x + w; let y1 = y + h;
    const px = clamp01(g.to[0]); const py = clamp01(g.to[1]);
    if (c === 0 || c === 2) x0 = Math.min(px, x1 - 0.02); else x1 = Math.max(px, x0 + 0.02);
    if (c === 0 || c === 1) y0 = Math.min(py, y1 - 0.02); else y1 = Math.max(py, y0 + 0.02);
    if (fixed) { const s = Math.min(x1 - x0, y1 - y0); if (c === 0 || c === 2) x0 = x1 - s; else x1 = x0 + s; if (c === 0 || c === 1) y0 = y1 - s; else y1 = y0 + s; }
    return [x0, y0, x1 - x0, y1 - y0];
  }
  return cropOf(params);
}

/**
 * The picture with every layer and adjustment at its full size (up to 8192, or the GPU's most, on a side), as a file:
 * what Export saves.
 */
export async function renderPicture(surface: Surface, session: string, format: "png" | "jpeg"): Promise<Blob> {
  const img = pictureOf(surface.id);
  if (!img) throw new Error("The picture is not loaded yet.");
  const out = document.createElement("canvas");
  out.width = 1;
  out.height = 1;
  const engine = new ImageEngine(out);
  try {
    const doc = surface.image ?? newImageDoc();
    const px = { w: img.naturalWidth, h: img.naturalHeight };
    const full = workSize(px, Math.min(8192, engine.max));
    const photo = document.createElement("canvas");
    photo.width = full.w;
    photo.height = full.h;
    photo.getContext("2d")!.drawImage(img, 0, 0, full.w, full.h);
    const pic = new Picture({ photo, picture: placedFrom, mask: (id, w, h) => maskFrom(session, id, w, h) });
    const base = Picture.plain(doc, surface.params) ? photo : pic.compose(doc, surface.params, full.w, full.h, full.scale);
    engine.setImage(base, photo);
    engine.setMasks(pic.masks(doc, full.w, full.h, full.scale));
    const size = outputSize(surface.params, full.w, full.h, Math.min(8192, engine.max));
    out.width = size.w;
    out.height = size.h;
    engine.render(surface.params, null);
    return await new Promise<Blob>((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error("The picture could not be made."))), `image/${format}`, 0.92));
  } finally {
    engine.dispose();
  }
}

/** A data surface: the table itself, as its filters leave it. */
export function DataView({ surface }: { surface: Surface }) {
  if (!surface.table) return <div className="pa-chart-empty">This table's rows are gone.</div>;
  return <DataTable table={surface.table} params={surface.params as Record<string, Value>} limit={200} />;
}

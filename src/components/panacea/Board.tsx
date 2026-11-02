import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { GRID, PANEL_MAX_W, PANEL_MIN_W, snap, type Canvas, type Panel, type Surface } from "../../lib/panacea/canvas";
import { KINDS } from "../../lib/panacea/kinds";
import type { Recipe } from "../../lib/panacea/library";
import { IconCode, IconCube, IconFile, IconGame, IconGlobe, IconImage, IconMusic, IconSparkle, IconTable, IconVideo, IconX, IconMaximize } from "../Icons";
import { PanelCard, type PanelActions } from "./PanelCard";
import { SurfaceView } from "./Surfaces";
import { Summon } from "./Summon";
import type { Editor } from "./useCanvas";
import { fitWorkView, revealWorkView, type WorkBox } from "../../lib/workspaceViewport";
import type { HostedWork } from "../../lib/workspaceScene";
import { WORKSPACE_MODES, type WorkspaceMode } from "../../lib/workspace";
import { usePhone } from "../../lib/stage";
import { jumpTo, zoomAt } from "../../lib/panacea/workspace-camera";
import { workViewport } from "../../lib/frameCoordinates";

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
  /** Show all work without changing any surface or pinned panel's world position. */
  fit: () => void;
  focus: () => void;
  jump: (id: string | null, automatic?: boolean) => void;
  /** Glide to show a box of the canvas whole (a project phase's region); `automatic` gives way to a person holding the view. */
  frame: (box: { x: number; y: number; w: number; h: number }, automatic?: boolean) => void;
  zoomOut: () => void;
}

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2;

/**
 * The canvas: a dotted grid as far as the person cares to go. Drag the grid (or scroll) to pan, Ctrl+scroll or pinch to zoom,
 * double-click or press / to summon a panel, Shift+drag to pick several, drop a file or paste a table to add a surface.
 * Panels move by their title bars and widen by their right edge, and land on the grid.
 */
export function Board({ canvas, fresh, edit, hold, recipes, actions, selected, setSelected, onPick, onFocus, onFiles, onPaste, onRemoveSurface, onSurfaceSize, onMoved, handle, children,
  hosted = [], ready = true, scene, followTarget, onJumpWork, onCloseWork, navigationHost }: {
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
  hosted?: readonly HostedWork[];
  ready?: boolean;
  scene?: MutableRefObject<BoardHandle | null>;
  followTarget?: WorkspaceMode | null;
  onJumpWork?: (mode: WorkspaceMode) => void;
  onCloseWork?: (mode: WorkspaceMode) => void;
  navigationHost?: HTMLElement | null;
}) {
  const phone = usePhone();
  /** On a phone the work area is measured above the conversation already, and every pixel of it counts: fit tight. */
  const fitOpts = useMemo(() => (phone ? { padding: 8, foot: 0 } : {}), [phone]);
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
    glideTimer.current = null;
    setGlide(smooth);
    if (smooth) glideTimer.current = setTimeout(() => { glideTimer.current = null; setGlide(false); }, 450);
  }, []);
  /* Every finger on the canvas, by pointer id. Two are a pinch (see the effect below); one is the pan. */
  const fingers = useRef(new Map<number, { x: number; y: number }>());
  const [drag, setDrag] = useState<{ ids: Set<string>; dx: number; dy: number } | null>(null);
  const [widen, setWiden] = useState<{ id: string; w: number } | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [summon, setSummon] = useState<{ sx: number; sy: number; at: { x: number; y: number } } | null>(null);
  const fitted = useRef(false);
  const interacted = useRef(false);
  const canvasRef = useRef(canvas);
  const [engineBoxes, setEngineBoxes] = useState<Record<string, WorkBox>>({});
  const [enginePins, setEnginePins] = useState<ReadonlySet<string>>(new Set());
  const engineBoxesRef = useRef(engineBoxes);
  const hostedRef = useRef(hosted);
  const pendingJump = useRef<string | null>(null);
  const previousFollow = useRef<WorkspaceMode | null>(null);
  const hostedKey = hosted.map((work) => work.id).join("|");
  useEffect(() => { engineBoxesRef.current = engineBoxes; hostedRef.current = hosted; }, [engineBoxes, hosted]);
  useEffect(() => {
    if (!ready) return;
    const ids = hostedKey.split("|").filter(Boolean);
    setEngineBoxes((before) => {
      const next = { ...before };
      let count = Object.keys(next).length;
      for (const id of ids) if (!next[id]) {
        /* On a phone, the size of the screen there is for work (above the conversation, beside the jump buttons), so it
           opens at its real size: fitted any bigger, the board zooms out and every control in it is too small to use. */
        const room = phone && root.current ? workViewport(root.current) : null;
        const width = phone ? Math.max(320, (room?.width ?? 390) - 16) : 1056;
        // Never shorter than an app needs to show itself under its own bars (the app preview's phone screen is tall).
        const height = phone ? Math.max(560, (room?.height ?? 600) - 16) : 740;
        next[id] = { x: -(count % 3 + 1) * 1200, y: Math.floor(count / 3) * 920, w: width, h: height };
        count += 1;
      }
      return ids.some((id) => !before[id]) ? next : before;
    });
  }, [hostedKey, phone, ready]);
  useEffect(() => { canvasRef.current = canvas; }, [canvas]);
  const boxesOf = useCallback((): WorkBox[] => {
    const current = canvasRef.current;
    // On a project's canvas, "all the work" is the phase being worked on: the other phases' regions are a tap away in the strip.
    const phase = current.project?.phase;
    const surfaces = phase ? current.surfaces.filter((s) => s.phase === phase) : current.surfaces;
    const here = new Set(surfaces.map((s) => s.id));
    const panels = phase ? current.panels.filter((panel) => here.has(panel.context) || panel.context === "general") : current.panels;
    const engines = phase && surfaces.length ? [] : hostedRef.current.flatMap((work) => engineBoxesRef.current[work.id] ? [engineBoxesRef.current[work.id]] : []);
    return [...surfaces, ...engines,
      ...panels.filter((panel) => panel.state === "live" || panel.pinned).map((panel) => ({
      x: panel.x, y: panel.y, w: panel.w,
      h: root.current?.querySelector<HTMLElement>(`[data-panel="${CSS.escape(panel.id)}"]`)?.offsetHeight || panel.h || 240,
    }))];
  }, []);
  const fit = useCallback(() => {
    const el = root.current;
    if (!el) return;
    const boxes = boxesOf();
    const room = workViewport(el);
    const next = fitWorkView(boxes, { width: room.width, height: room.height }, fitOpts);
    if (!next) return;
    fitted.current = boxes.length > 0;
    setView(next);
  }, [boxesOf, setView, fitOpts]);
  const focus = useCallback(() => {
    const el = root.current;
    const current = canvasRef.current;
    const surface = current.surfaces.find((item) => item.id === current.focus);
    if (!el || !surface) return;
    const boxes = boxesOf().filter((box) => box === surface || current.panels.some((panel) => panel.context === surface.id && panel.x === box.x && panel.y === box.y));
    const room = workViewport(el);
    const next = fitWorkView([surface, ...boxes], { width: room.width, height: room.height }, fitOpts);
    if (next) { interacted.current = true; setView(next); }
  }, [boxesOf, setView, fitOpts]);
  const handsBusy = useCallback(() => {
    const el = root.current;
    const active = document.activeElement;
    if (active?.closest(".scrim,.rail-grid")) return true;
    if (active?.closest(".conversation-flow") && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) return !!active.value.trim();
    return !!el && el.contains(active) && (active?.tagName === "IFRAME" || !!active?.closest("input,textarea,[contenteditable='true']"));
  }, []);

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
    if (ready && !fitted.current) fit();
  }, [canvas.surfaces, canvas.panels, engineBoxes, ready, fit]);
  useEffect(() => {
    if (ready && !interacted.current && !handsBusy() && enginePins.size === 0 && !canvasRef.current.panels.some((panel) => panel.pinned || panel.touched)) fit();
  }, [engineBoxes, ready, enginePins.size, fit, handsBusy]);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth <= 40 || el.clientHeight <= 40) return;
      if (!ready) return;
      if (!fitted.current || (!interacted.current && !handsBusy() && enginePins.size === 0 && !canvasRef.current.panels.some((panel) => panel.pinned || panel.touched))) fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit, handsBusy, ready, enginePins.size]);

  // A new surface the agent added off screen comes into view.
  const surfaceCount = useRef(canvas.surfaces.length);
  useEffect(() => {
    if (canvas.surfaces.length > surfaceCount.current && root.current && !handsBusy()) {
      if (!interacted.current && !canvas.panels.some((panel) => panel.pinned || panel.touched)) { fit(); surfaceCount.current = canvas.surfaces.length; return; }
      const s = canvas.surfaces.at(-1)!;
      const r = root.current.getBoundingClientRect();
      const v = viewRef.current;
      const inView = s.x >= v.x && s.y >= v.y && s.x + s.w <= v.x + r.width / v.zoom && s.y + s.h <= v.y + r.height / v.zoom;
      if (!inView && r.width > 40 && r.height > 40 && !canvas.panels.some((panel) => panel.pinned)) setView({ ...v, x: s.x - 48 / v.zoom, y: s.y - 48 / v.zoom }, true);
    }
    surfaceCount.current = canvas.surfaces.length;
  }, [canvas.surfaces, canvas.panels, setView, fit, handsBusy]);

  // A panel placed off screen (the agent's, or one that had nowhere closer to go) comes into view: measured as
  // drawn, so a tall one is not left under the strip along the bottom.
  const seenPanels = useRef(new Set(canvas.panels.map((p) => p.id)));
  useEffect(() => {
    // A ghost is only an offer: it never moves the person's view away from what they are doing.
    const fresh = canvas.panels.filter((p) => !seenPanels.current.has(p.id) && p.state !== "ghost").map((p) => p.id);
    seenPanels.current = new Set(canvas.panels.map((p) => p.id));
    if (!fresh.length || !root.current || drag || handsBusy() || canvas.panels.some((panel) => panel.pinned)) return;
    const reveal = () => {
      const el = root.current;
      if (!el) return;
      if (handsBusy()) return;
      const boxes = canvasRef.current.panels.filter((panel) => fresh.includes(panel.id)).map((panel) => ({
        x: panel.x, y: panel.y, w: panel.w,
        h: el.querySelector<HTMLElement>(`[data-panel="${CSS.escape(panel.id)}"]`)?.offsetHeight || panel.h || 240,
      }));
      const current = viewRef.current;
      const next = revealWorkView(current, boxes, { width: el.clientWidth, height: el.clientHeight });
      if (next !== current) setView(next, true);
    };
    // Heights are untransformed; positions come from the model, never a gliding screen rectangle.
    const frame = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(frame);
  }, [canvas.panels, drag, setView, handsBusy]);

  handle.current = {
    fit,
    focus,
    jump: (id, automatic = false) => {
      if (automatic && (interacted.current || handsBusy() || enginePins.size > 0 || canvasRef.current.panels.some((panel) => panel.pinned))) return;
      const el = root.current;
      if (!el) return;
      const current = canvasRef.current;
      const target = id ? engineBoxesRef.current[id] ?? current.surfaces.find((surface) => surface.id === id) : current.surfaces.find((surface) => surface.id === current.focus);
      if (!target) { if (id && !automatic) pendingJump.current = id; return; }
      // Follow leaves the view alone when what it would show is mostly on screen already (the window being worked in).
      if (automatic) {
        const v = viewRef.current;
        const room = workViewport(el);
        const x0 = Math.max(target.x, v.x), x1 = Math.min(target.x + target.w, v.x + room.width / v.zoom);
        const y0 = Math.max(target.y, v.y), y1 = Math.min(target.y + target.h, v.y + room.height / v.zoom);
        const seen = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
        if (target.w * target.h > 0 && seen / (target.w * target.h) >= 0.7) return;
      }
      if (!automatic && phone) {
        interacted.current = true;
        // A phone's manual jump can enlarge the workspace; fit only after that layout has settled.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const currentRoot = root.current;
          if (!currentRoot) return;
          const freshTarget = id ? engineBoxesRef.current[id] ?? canvasRef.current.surfaces.find((surface) => surface.id === id)
            : canvasRef.current.surfaces.find((surface) => surface.id === canvasRef.current.focus);
          if (!freshTarget) return;
          const room = workViewport(currentRoot);
          const next = fitWorkView([freshTarget], { width: room.width, height: room.height }, fitOpts);
          if (next) setView(next);
        }));
        return;
      }
      const v = viewRef.current;
      const room = workViewport(el);
      if (room.width <= 0 || room.height <= 0) return;
      const camera = automatic ? jumpTo({ x: target.x, y: target.y, width: target.w, height: target.h },
        { width: room.width, height: room.height }, { x: -v.x * v.zoom, y: -v.y * v.zoom, zoom: v.zoom }) : null;
      const next = camera ? { x: -camera.x / camera.zoom, y: -camera.y / camera.zoom, zoom: camera.zoom }
        : fitWorkView([target], { width: room.width, height: room.height }, fitOpts);
      if (next) { if (!automatic) interacted.current = true; setView(next); }
    },
    frame: (box, automatic = false) => {
      if (automatic && (interacted.current || handsBusy() || enginePins.size > 0 || canvasRef.current.panels.some((panel) => panel.pinned))) return;
      const el = root.current;
      if (!el) return;
      const room = workViewport(el);
      if (room.width <= 0 || room.height <= 0) return;
      const next = fitWorkView([box], { width: room.width, height: room.height }, fitOpts);
      if (next) { if (!automatic) interacted.current = true; setView(next, true); }
    },
    zoomOut: () => {
      const el = root.current;
      if (!el) return;
      interacted.current = true;
      const v = viewRef.current;
      const camera = zoomAt({ x: -v.x * v.zoom, y: -v.y * v.zoom, zoom: v.zoom },
        { x: workViewport(el).width / 2, y: workViewport(el).height / 2 }, v.zoom * 0.75);
      setView({ x: -camera.x / camera.zoom, y: -camera.y / camera.zoom, zoom: camera.zoom });
    },
    reveal: async (x, y) => {
      /* What the person can see of the board, not all of it: on a phone the conversation sheet covers its foot, and a
         point under the sheet is a hand nobody watches (and a picker opened there is out of reach). */
      const r = workViewport(root.current!);
      const v = viewRef.current;
      const margin = 80 / v.zoom;
      // Too far out to press anything (a phone fitting a whole canvas): in to a size a person works at, on the point.
      if (v.zoom < 0.75) {
        setView({ zoom: 1, x: x - r.width / 2, y: y - r.height / 3 }, true);
        await new Promise((res) => setTimeout(res, 420));
        return toScreen(x, y);
      }
      if (x < v.x + margin || y < v.y + margin || x > v.x + r.width / v.zoom - margin || y > v.y + r.height / v.zoom - margin) {
        /* Only the agent's hand asks, and while it works it has the screen, as someone who took control of it would:
           it moves the view to where it is working, even where the person had moved it, and even while its own typing
           has the focus (which `handsBusy` would otherwise read as the person's). */
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
  useEffect(() => {
    if (scene) scene.current = handle.current;
    return () => { if (scene) scene.current = null; };
  }, [scene, handle, engineBoxes, canvas, view]);
  useEffect(() => {
    if (followTarget && !previousFollow.current) interacted.current = false;
    previousFollow.current = followTarget ?? null;
    if (followTarget && ready) handle.current?.jump(followTarget === "panacea" ? null : `engine:${followTarget}`, true);
  }, [followTarget, ready, engineBoxes, handle, canvas.focus]);
  useEffect(() => {
    const id = pendingJump.current;
    if (id && engineBoxes[id] && !handsBusy()) { pendingJump.current = null; handle.current?.jump(id); }
  }, [engineBoxes, handle, handsBusy]);

  // ------------------------------------------------------------ the grid --

  const onGridDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) return;
    if ((e.target as HTMLElement).closest(".pa-panel, .pa-surface, .pa-summon, .pa-chrome, .pw-engine")) return;
    // A second finger is the pinch's, never a second pan.
    if (fingers.current.size > 1) return;
    interacted.current = true;
    if (e.isTrusted) onJumpWork?.(followTarget ?? "panacea");
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
    // Incremental, so a pinch in the middle (which moves the view itself) leaves the pan going from where the finger is.
    const id = e.pointerId;
    let last = { x: e.clientX, y: e.clientY };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      const dx = ev.clientX - last.x, dy = ev.clientY - last.y;
      last = { x: ev.clientX, y: ev.clientY };
      if (fingers.current.size > 1) return;
      const v = viewRef.current;
      setView({ ...v, x: v.x - dx / v.zoom, y: v.y - dy / v.zoom });
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  // Pinch: two fingers zoom about the midpoint between them (and carry the canvas with it); lifting one ends the
  // pinch and the finger left down pans on. Counted in the capture phase, as on the Mind map, because a panel
  // stops its own presses and two fingers on two panels are as much a pinch as two on the empty grid.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let pinch: { d: number; zoom: number; wx: number; wy: number } | null = null;
    const pair = () => {
      const [a, b] = [...fingers.current.values()];
      return a && b ? { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 } : null;
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      fingers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const two = fingers.current.size === 2 ? pair() : null;
      if (!two) return;
      const v = viewRef.current;
      const r = el.getBoundingClientRect();
      interacted.current = true;
      pinch = { d: Math.max(two.d, 1), zoom: v.zoom, wx: v.x + (two.mx - r.left) / v.zoom, wy: v.y + (two.my - r.top) / v.zoom };
    };
    const move = (e: PointerEvent) => {
      const f = fingers.current.get(e.pointerId);
      if (!f) return;
      f.x = e.clientX; f.y = e.clientY;
      const two = pinch && pair();
      if (!pinch || !two) return;
      e.preventDefault();
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinch.zoom * (two.d / pinch.d)));
      const r = el.getBoundingClientRect();
      setView({ zoom, x: pinch.wx - (two.mx - r.left) / zoom, y: pinch.wy - (two.my - r.top) / zoom });
    };
    const lift = (e: PointerEvent) => {
      if (!fingers.current.delete(e.pointerId)) return;
      if (fingers.current.size < 2) pinch = null;
    };
    el.addEventListener("pointerdown", down, true);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", lift, true);
    el.addEventListener("pointercancel", lift, true);
    const fingerSet = fingers.current;
    return () => {
      el.removeEventListener("pointerdown", down, true);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", lift, true);
      el.removeEventListener("pointercancel", lift, true);
      fingerSet.clear();
    };
  }, [setView]);

  // Wheel: pan, or zoom about the pointer with Ctrl (a pinch on a trackpad comes as Ctrl+wheel). Not passive, so it can stop the page scrolling.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest(".pa-table-wrap, .pa-summon-list, .pa-menu, textarea, .pw-engine, .pa-doc-scroll")) return;
      interacted.current = true;
      if (e.isTrusted) onJumpWork?.(followTarget ?? "panacea");
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
  }, [setView, onJumpWork, followTarget]);

  const onDouble = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest(".pa-panel, .pa-surface, .pa-summon, .pa-chrome, .pw-engine")) return;
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

  // ----------------------------------------------- moving and sizing tiles --
  /* Every tile on the board (an app's window, a photo, a table, a document, a board) moves by its title bar and is
     sized by its corner, with a mouse or a finger; and its Maximise fills the screen there is, and gives it back. */

  /** A drag that reports how far it has gone in the board's own units (so a zoomed-out board moves tiles as far as the finger). */
  const gesture = useCallback((e: ReactPointerEvent<HTMLElement>, step: (dx: number, dy: number) => void, done: (dx: number, dy: number) => void) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    interacted.current = true;
    hold(true);
    const target = e.currentTarget;
    target.setPointerCapture?.(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, zoom: viewRef.current.zoom };
    const at = (ev: PointerEvent) => [(ev.clientX - start.x) / start.zoom, (ev.clientY - start.y) / start.zoom] as const;
    const move = (ev: PointerEvent) => { const [dx, dy] = at(ev); step(dx, dy); };
    const up = (ev: PointerEvent) => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      hold(false);
      const [dx, dy] = at(ev);
      done(dx, dy);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }, [hold]);

  const MIN_TILE = { w: 280, h: 180 };
  /** A surface being moved or sized: drawn with the change, and written to the canvas (one undoable step) when let go. */
  const [tileDrag, setTileDrag] = useState<{ id: string; dx: number; dy: number; dw: number; dh: number } | null>(null);
  const surfaceGesture = (s: Surface, how: "move" | "size") => (e: ReactPointerEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest("button") && how === "move") return;
    gesture(e, (dx, dy) => setTileDrag(how === "move" ? { id: s.id, dx, dy, dw: 0, dh: 0 } : { id: s.id, dx: 0, dy: 0, dw: Math.max(MIN_TILE.w - s.w, dx), dh: Math.max(MIN_TILE.h - s.h, dy) }),
      (dx, dy) => {
        setTileDrag(null);
        if (Math.abs(dx) + Math.abs(dy) < 3) return;
        maxed.current.delete(s.id);
        edit((d) => {
          const t = d.surfaces.find((x) => x.id === s.id);
          if (!t) return;
          if (how === "move") { t.x = snap(t.x + dx); t.y = snap(t.y + dy); }
          else { t.w = snap(Math.max(MIN_TILE.w, t.w + dx)); t.h = snap(Math.max(MIN_TILE.h, t.h + dy)); }
        }, `${how === "move" ? "Moved" : "Resized"} ${s.title}`);
      });
  };
  const engineResize = (id: string) => (e: ReactPointerEvent<HTMLElement>) => {
    const box = engineBoxesRef.current[id];
    if (!box) return;
    gesture(e, (dx, dy) => setEngineBoxes((before) => ({ ...before, [id]: { ...box, w: Math.max(320, box.w + dx), h: Math.max(240, box.h + dy) } })),
      () => { maxed.current.delete(id); });
  };

  /** What each maximised tile was, to give it back. */
  const maxed = useRef(new Map<string, WorkBox>());
  /** Maximise: the tile takes the whole screen there is for work, at its real size, in the middle; again, and it is as it was. */
  const maximize = (id: string, kind: "engine" | "surface") => {
    const el = root.current;
    if (!el) return;
    const room = workViewport(el);
    const was = maxed.current.get(id);
    const now = kind === "engine" ? engineBoxesRef.current[id] : canvasRef.current.surfaces.find((s) => s.id === id);
    if (!now) return;
    const pad = phone ? 8 : 16;
    const next = was ?? { x: now.x, y: now.y, w: Math.max(MIN_TILE.w, room.width - pad * 2), h: Math.max(MIN_TILE.h, room.height - pad * 2) };
    if (was) maxed.current.delete(id);
    else maxed.current.set(id, { x: now.x, y: now.y, w: now.w, h: now.h });
    if (kind === "engine") setEngineBoxes((before) => ({ ...before, [id]: next }));
    else edit((d) => { const t = d.surfaces.find((x) => x.id === id); if (t) { t.x = next.x; t.y = next.y; t.w = next.w; t.h = next.h; } }, was ? "Restored a window" : "Maximised a window");
    interacted.current = true;
    if (was) setView(fitWorkView([next], { width: room.width, height: room.height }, fitOpts) ?? viewRef.current, true);
    else setView({ x: next.x - pad, y: next.y - pad, zoom: 1 }, true);
  };
  const [, rerender] = useState(0);
  const isMaxed = (id: string) => maxed.current.has(id);

  const z = view.zoom;

  // ------------------------------------------------- where the work went --
  /* A line between two windows for each pair of apps work went between (lib/panacea/flows.ts): a 3D model into the game,
     a picture into a document. An arrow halfway along points the way it went; beside it, what went (the latest, and how
     many more). Drawn under the windows, from edge to edge. */
  const flowLines = (() => {
    const flows = canvas.flows ?? [];
    if (!flows.length) return [];
    const boxOf = (mode: string, artifact?: string, what?: string): WorkBox | null => {
      if (mode === "panacea") {
        const s = canvas.surfaces.find((x) => (artifact && x.artifact === artifact) || (what && x.name === what));
        return s ? { x: s.x, y: s.y, w: s.w, h: s.h } : null;
      }
      const work = hosted.find((w) => w.mode === mode);
      return work ? engineBoxes[work.id] ?? null : null;
    };
    const pairs = new Map<string, { a: WorkBox; b: WorkBox; what: string; more: number; key: string }>();
    for (const f of flows) {
      const a = boxOf(f.from, f.artifact, f.what);
      const b = boxOf(f.to, f.artifact, f.what);
      if (!a || !b) continue;
      const key = `${f.from}>${f.to}`;
      const had = pairs.get(key);
      pairs.set(key, { a, b, what: f.what, more: had ? had.more + 1 : 0, key });
    }
    /** Where the line from a box's middle toward `p` leaves the box. */
    const edge = (box: WorkBox, p: { x: number; y: number }) => {
      const c = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      const t = Math.min(dx ? (box.w / 2) / Math.abs(dx) : Infinity, dy ? (box.h / 2) / Math.abs(dy) : Infinity, 1);
      return { x: c.x + dx * t, y: c.y + dy * t };
    };
    return [...pairs.values()].map(({ a, b, what, more, key }) => {
      const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
      const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      const p = edge(a, cb);
      const q = edge(b, ca);
      return { key, p, q, mid: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, angle: Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI, label: more ? `${what} +${more}` : what };
    });
  })();
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
      <div className={`pa-world${glide ? " is-glide" : ""}`} style={{ transform: `translate(${-view.x * z}px, ${-view.y * z}px) scale(${z})`, ["--pa-z" as string]: z }}>
        {flowLines.length > 0 && (
          <svg className="pa-flows" width="1" height="1" aria-hidden="true">
            {flowLines.map((l) => (
              <g key={l.key} className="pa-flow" data-flow={l.key}>
                <line x1={l.p.x} y1={l.p.y} x2={l.q.x} y2={l.q.y} vectorEffect="non-scaling-stroke" />
                {/* The arrow and the words stay the same size on screen however far out the board is. */}
                <g transform={`translate(${l.mid.x} ${l.mid.y}) scale(${1 / z})`}>
                  <path className="pa-flow-arrow" d="M -9 -7 L 9 0 L -9 7 Z" transform={`rotate(${l.angle})`} />
                  <text className="pa-flow-label" y={-14} textAnchor="middle">{l.label}</text>
                </g>
              </g>
            ))}
          </svg>
        )}
        {hosted.map((work) => {
          const box = engineBoxes[work.id];
          if (!box) return null;
          return <section key={work.id} className={`pw-engine${enginePins.has(work.id) ? " is-pinned" : ""}${isMaxed(work.id) ? " is-max" : ""}`} data-engine={work.mode}
            data-work={work.id} style={{ left: box.x, top: box.y, width: box.w, height: box.h }} aria-label={`${work.title} work surface`}
            /* Working in a window is not holding the view (only panning, zooming or dragging is): Follow still brings the
               agent's next window into view after the person has pressed a button in this one. */
            onPointerDownCapture={(e) => { if (e.isTrusted) onJumpWork?.(work.mode); }}>
            <header className="pw-engine-head" onPointerDown={(e) => {
              if (e.button !== 0 || (e.target as HTMLElement).closest("button") || enginePins.has(work.id)) return;
              e.preventDefault(); e.stopPropagation(); interacted.current = true; hold(true);
              const target = e.currentTarget; target.setPointerCapture(e.pointerId);
              const start = { x: e.clientX, y: e.clientY, zoom: viewRef.current.zoom };
              const move = (event: PointerEvent) => setEngineBoxes((before) => ({ ...before,
                [work.id]: { ...box, x: box.x + (event.clientX - start.x) / start.zoom, y: box.y + (event.clientY - start.y) / start.zoom } }));
              const up = () => { target.removeEventListener("pointermove", move); target.removeEventListener("pointerup", up); target.removeEventListener("pointercancel", up); hold(false); };
              target.addEventListener("pointermove", move); target.addEventListener("pointerup", up); target.addEventListener("pointercancel", up);
            }}>
              <span>{workIcon(work.mode)}</span><b>{work.title}</b><span className="pw-engine-context">{WORKSPACE_MODES[work.mode].context}</span>
              <button type="button" aria-label={isMaxed(work.id) ? `Restore ${work.title}` : `Maximise ${work.title}`} aria-pressed={isMaxed(work.id)}
                onClick={() => { maximize(work.id, "engine"); rerender((n) => n + 1); onJumpWork?.(work.mode); }}><IconMaximize size={14} /></button>
              <button type="button" aria-pressed={enginePins.has(work.id)} aria-label={`Pin ${work.title} work`} onClick={() => setEnginePins((before) => {
                const next = new Set(before); if (next.has(work.id)) next.delete(work.id); else next.add(work.id); return next;
              })}>Pin</button>
              {onCloseWork && work.mode !== "browser" && <button type="button" aria-label={`Close ${work.title} work`} onClick={() => onCloseWork(work.mode)}><IconX size={14} /></button>}
            </header>
            <div className="pw-engine-body">{work.content}</div>
            <i className="pa-resize" role="presentation" title="Drag to resize" onPointerDown={engineResize(work.id)} />
          </section>;
        })}
        {canvas.surfaces.map((s) => {
          const d = tileDrag?.id === s.id ? tileDrag : null;
          return (
          <section
            key={s.id}
            className={`pa-surface is-${s.kind}${canvas.focus === s.id ? " is-focus" : ""}${d ? " is-moving" : ""}${isMaxed(s.id) ? " is-max" : ""}`}
            data-surface={s.id}
            style={{ left: s.x + (d?.dx ?? 0), top: s.y + (d?.dy ?? 0), width: s.w + (d?.dw ?? 0), height: s.h + (d?.dh ?? 0) }}
            onPointerDown={(e) => {
              if (!(e.target as HTMLElement).closest("button")) {
                if (e.isTrusted) onJumpWork?.("panacea");
                if (canvas.focus !== s.id) onFocus(s.id);
              }
            }}
            aria-label={`${s.title}, ${KINDS[s.kind].noun}`}
          >
            <header className="pa-surface-head" onPointerDown={surfaceGesture(s, "move")}>
              <span className="pa-title">{s.title}</span>
              <span className="pa-surface-meta">{KINDS[s.kind].meta(s)}</span>
              <button type="button" className="pa-surface-max" aria-label={isMaxed(s.id) ? `Restore ${s.title}` : `Maximise ${s.title}`} aria-pressed={isMaxed(s.id)}
                onClick={() => { maximize(s.id, "surface"); rerender((n) => n + 1); }}><IconMaximize size={11} /></button>
              <button type="button" className="pa-surface-x" aria-label={`Remove ${s.title}`} onClick={() => onRemoveSurface(s)}><IconX size={11} /></button>
            </header>
            <div className="pa-surface-body">
              <SurfaceView surface={s} onSize={(px) => onSurfaceSize(s, px)} />
            </div>
            <i className="pa-resize" role="presentation" title="Drag to resize" onPointerDown={surfaceGesture(s, "size")} />
          </section>
          );
        })}
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
      {(() => {
        const dock = <nav className="pw-jump-dock pa-chrome" aria-label="Jump to work">
        {canvas.surfaces.map((surface) => <button type="button" key={surface.id} data-jump={surface.id} title={`Jump to ${surface.title}`}
          aria-label={`Jump to ${surface.title}`} onClick={() => { handle.current?.jump(surface.id); onFocus(surface.id); onJumpWork?.("panacea"); }}>
          {workIcon(surface.kind === "image" ? "photo" : surface.kind === "data" ? "sheets" : surface.kind === "doc" ? "pages" : "widget")}
        </button>)}
        {hosted.map((work) => <button type="button" key={work.id} data-jump={work.id} title={`Jump to ${work.title}`} aria-label={`Jump to ${work.title}`}
          onClick={() => { handle.current?.jump(work.id); onJumpWork?.(work.mode); }}>{workIcon(work.mode)}</button>)}
        <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => { handle.current?.zoomOut(); onJumpWork?.(followTarget ?? "panacea"); }}>−</button>
        <button type="button" aria-label="Show all work" title="Show all work" onClick={() => { interacted.current = true; fit(); onJumpWork?.(followTarget ?? "panacea"); }}><IconMaximize size={16} /></button>
        </nav>;
        return navigationHost ? createPortal(dock, navigationHost) : dock;
      })()}
      {children}
    </div>
  );
}

function workIcon(mode: WorkspaceMode): ReactNode {
  const icons: Partial<Record<WorkspaceMode, ReactNode>> = {
    pages: <IconFile size={17} />, sheets: <IconTable size={17} />, slides: <IconFile size={17} />, pdf: <IconFile size={17} />,
    photo: <IconImage size={17} />, video: <IconVideo size={17} />, studio: <IconMusic size={17} />, cad: <IconCube size={17} />,
    game: <IconGame size={17} />, browser: <IconGlobe size={17} />, app: <IconCode size={17} />,
  };
  return icons[mode] ?? <IconSparkle size={17} />;
}

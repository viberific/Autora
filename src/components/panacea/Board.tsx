import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { GRID, PANEL_MAX_W, PANEL_MIN_W, snap, type Canvas, type Panel, type Surface } from "../../lib/panacea/canvas";
import { maximise as maximiseWindow, placeWindow, raise as raiseWindow, tidy as tidyBoxes } from "../../lib/panacea/windows";
import { KINDS } from "../../lib/panacea/kinds";
import type { Recipe } from "../../lib/panacea/library";
import { IconCode, IconCube, IconFile, IconGame, IconGlobe, IconImage, IconMusic, IconNotebook, IconOrg, IconSlides, IconSparkle, IconTable, IconVideo, IconX, IconMaximize, IconMoreH, IconTidy } from "../Icons";
import { PanelCard, type PanelActions } from "./PanelCard";
import { SHEET_MOVED } from "./chatLayout";
import { SurfaceView } from "./Surfaces";
import { Summon } from "./Summon";
import type { Edit, Editor } from "./useCanvas";
import { fitWorkView, revealWorkView, type WorkBox } from "../../lib/workspaceViewport";
import type { HostedWork } from "../../lib/workspaceScene";
import { WORKSPACE_MODES, type WorkspaceMode } from "../../lib/workspace";
import { usePhone } from "../../lib/stage";
import { sure } from "../../lib/sure";
import { jumpTo, zoomAt } from "../../lib/panacea/workspace-camera";
import { engineSends, surfaceSends, takersOf, type SentFile } from "../../lib/panacea/flows";
import { addJoin, canJoin, joinOffer, removeJoin } from "../../lib/panacea/joins";
import { workViewport } from "../../lib/frameCoordinates";
import { EngineFrame, setFullscreen, useFullscreen } from "../../lib/fullscreen";

/* How far the free part of the board starts from its left edge. On a desktop the conversation is on the left and the
   work rail stands on the canvas beside it, so what is framed is framed to the right of the rail, not under it. */
/** Below this zoom, text on the board cannot be read: Autora's own framing does not go under it for the piece being worked on. */
const READABLE = 0.6;
const insetOf = (el: Element, room: { left: number }) => Math.max(0, room.left - el.getBoundingClientRect().left);
function shifted<T extends { x: number; zoom: number }>(next: T | null, inset: number): T | null {
  return next && inset ? { ...next, x: next.x - inset / next.zoom } : next;
}

interface View { x: number; y: number; zoom: number }

/** One window's frame (see EngineFrame): a value that changes only with the window's own state, so panning the board
    does not re-render every editor on it. */
function EngineFrameScope({ id, full, onFull, children }: { id: string; full: boolean; onFull: (id: string, next: boolean) => void; children: ReactNode }) {
  const value = useMemo(() => ({ full, setFull: (next: boolean) => onFull(id, next) }), [id, full, onFull]);
  return <EngineFrame.Provider value={value}>{children}</EngineFrame.Provider>;
}

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
/** How long a dragged window is held over another before letting go would join them (a pass over one does not). */
const JOIN_DWELL_MS = 350;
const MAX_ZOOM = 2;

/**
 * The canvas: a dotted grid as far as the person cares to go. Drag the grid (or scroll) to pan, Ctrl+scroll or pinch to zoom,
 * double-click or press / to summon a panel, Shift+drag to pick several, drop a file or paste a table to add a surface.
 * Panels move by their title bars and widen by their right edge, and land on the grid.
 */
export function Board({ canvas, fresh, edit, quiet, loaded = true, hold, recipes, actions, selected, setSelected, onPick, onFocus, onFiles, onLink, onJoined, onPaste, onRemoveSurface, onSurfaceSize, onMoved, handle, children,
  hosted = [], ready = true, scene, followTarget, onJumpWork, onCloseWork, navigationHost }: {
  canvas: Canvas;
  fresh: ReadonlySet<string>;
  edit: Editor;
  /** A change that is not a step to undo (a window raised, the room measured, a window's first place). */
  quiet?: (fn: Edit) => void;
  /** The canvas has been read: a window's first place is not written over the one it kept. */
  loaded?: boolean;
  hold: (on: boolean) => void;
  recipes: Recipe[];
  actions: Omit<PanelActions, "grab" | "widen">;
  selected: ReadonlySet<string>;
  setSelected: (ids: Set<string>) => void;
  onPick: (r: Recipe, at: { x: number; y: number }) => void;
  onFocus: (surface: string) => void;
  onFiles: (files: File[], at: { x: number; y: number }) => void;
  /** The person connected a piece of work (a surface's id, or an app window's) to an app: send the first to the second. */
  onLink?: (from: string, to: WorkspaceMode) => void;
  /** The person joined one window into another by dragging it there (joins.ts): told so it can be said. */
  onJoined?: (from: string, to: string) => void;
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
  /* While a window or a piece is being moved or resized, the editors' frames let the pointer pass (styles.css,
     .pa-board.is-gesturing iframe): a drag that crossed into one of them was taken by it, and the grip let go of nothing. */
  const holdBoard = useCallback((on: boolean) => {
    root.current?.classList.toggle("is-gesturing", on);
    hold(on);
  }, [hold]);
  /* A window full screen on a phone has the screen: the jump dock steps aside for it (its own bar has the way back), so it
     takes the phone's whole width instead of the room left of the dock. */
  const [windowFull] = useFullscreen();
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
  /* The board's left edge moves when the conversation beside it opens, retracts or is resized, or the app rail folds.
     The work keeps its place on the screen: the view moves by as much, so retracting the conversation does not throw
     everything on the board a panel's width to the left and under the work rail. */
  const lastLeft = useRef<number | null>(null);
  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const check = () => {
      const left = el.getBoundingClientRect().left;
      const was = lastLeft.current;
      lastLeft.current = left;
      if (was === null || Math.abs(left - was) < 1) return;
      const v = viewRef.current;
      setView({ ...v, x: v.x - (was - left) / v.zoom });
    };
    check();
    const watch = new ResizeObserver(check);
    watch.observe(el);
    return () => watch.disconnect();
  }, [setView]);
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
  /** The piece that arrived last: what Autora's own framing shows when everything at once would be too small to read. */
  const latest = useRef<string | null>(null);
  const pendingJump = useRef<string | null>(null);
  const previousFollow = useRef<WorkspaceMode | null>(null);
  const hostedKey = hosted.map((work) => work.id).join("|");
  useEffect(() => { engineBoxesRef.current = engineBoxes; hostedRef.current = hosted; }, [engineBoxes, hosted]);
  /* Where each app window is comes from the canvas (it is kept with it, and the agent lays it out by `panacea_arrange`).
     The page keeps a working copy so a drag is smooth, and takes the canvas's whenever that changes. A window the canvas
     has no place for yet gets a first one, written quietly (it is not a step to undo). */
  const winsKey = JSON.stringify(canvas.windows ?? []);
  useEffect(() => {
    const saved = canvas.windows ?? [];
    setEngineBoxes((before) => {
      let next = before;
      for (const w of saved) {
        const now = before[w.id];
        if (!now || now.x !== w.x || now.y !== w.y || now.w !== w.w || now.h !== w.h) next = { ...next, [w.id]: { x: w.x, y: w.y, w: w.w, h: w.h } };
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `winsKey` stands for the windows' content
  }, [winsKey]);
  useEffect(() => {
    if (!ready) return;
    const saved = canvas.windows ?? [];
    const ids = hostedKey.split("|").filter(Boolean);
    setEngineBoxes((before) => {
      const next = { ...before };
      let count = Object.keys(next).length;
      for (const id of ids) if (!next[id]) {
        const kept = saved.find((w) => w.id === id);
        if (kept) { next[id] = { x: kept.x, y: kept.y, w: kept.w, h: kept.h }; continue; }
        /* On a phone, the size of the screen there is for work (above the conversation, beside the jump buttons), so it
           opens at its real size: fitted any bigger, the board zooms out and every control in it is too small to use. */
        const room = phone && root.current ? workViewport(root.current, { clearDock: true }) : null;
        const width = phone ? Math.max(320, (room?.width ?? 390) - 16) : 1056;
        // Never shorter than an app needs to show itself under its own bars (the app preview's phone screen is tall).
        const height = phone ? Math.max(560, (room?.height ?? 600) - 16) : 740;
        next[id] = { x: -(count % 3 + 1) * 1200, y: Math.floor(count / 3) * 920, w: width, h: height };
        latest.current = id;
        count += 1;
      }
      return ids.some((id) => !before[id]) ? next : before;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `winsKey` stands for the windows' content
  }, [hostedKey, phone, ready, winsKey]);
  // Once the canvas is read, a window it has no place for gets the one the page gave it, written quietly (not a step to undo).
  useEffect(() => {
    if (!ready || !loaded || !quiet) return;
    const saved = new Set((canvas.windows ?? []).map((w) => w.id));
    const missing = hostedKey.split("|").filter((id) => id && !saved.has(id) && engineBoxes[id]);
    if (!missing.length) return;
    quiet((d) => { const wins = d.windows ?? (d.windows = []); for (const id of missing) if (!wins.some((w) => w.id === id)) placeWindow(wins, id, engineBoxes[id]!); });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `winsKey` stands for the windows' content
  }, [hostedKey, ready, loaded, quiet, engineBoxes, winsKey]);
  // The room there is for work, for the agent's "maximise": written when it changes, not as a step.
  const room = useRef<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!quiet || !loaded || !root.current) return;
    const el = root.current;
    const measure = () => {
      const r = workViewport(el, { clearDock: phone });
      const w = Math.round(r.width), h = Math.round(r.height);
      if (w < 200 || h < 200 || (room.current && Math.abs(room.current.w - w) < 24 && Math.abs(room.current.h - h) < 24)) return;
      room.current = { w, h };
      quiet((d) => { d.room = { w, h }; });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener(SHEET_MOVED, measure);
    return () => { window.removeEventListener("resize", measure); window.removeEventListener(SHEET_MOVED, measure); };
  }, [quiet, loaded, phone]);
  useEffect(() => { canvasRef.current = canvas; }, [canvas]);
  const boxesOf = useCallback((): WorkBox[] => {
    const current = canvasRef.current;
    // On a project's canvas, "all the work" is the phase being worked on: the other phases' regions are a tap away in the strip.
    const phase = current.project?.phase;
    const surfaces = phase ? current.surfaces.filter((s) => s.phase === phase) : current.surfaces;
    const here = new Set(surfaces.map((s) => s.id));
    const panels = phase ? current.panels.filter((panel) => here.has(panel.context) || panel.context === "general") : current.panels;
    const engines = phase && surfaces.length ? [] : hostedRef.current.flatMap((work) => engineBoxesRef.current[work.id] ? [engineBoxesRef.current[work.id]] : []);
    // A panel that is only offered is framed with the rest: an offer the framing leaves off screen is not an offer.
    return [...surfaces, ...engines,
      ...panels.filter((panel) => panel.state === "live" || panel.state === "ghost" || panel.pinned).map((panel) => ({
      x: panel.x, y: panel.y, w: panel.w,
      h: root.current?.querySelector<HTMLElement>(`[data-panel="${CSS.escape(panel.id)}"]`)?.offsetHeight || panel.h || 240,
    }))];
  }, []);
  const fit = useCallback(() => {
    const el = root.current;
    if (!el) return;
    const boxes = boxesOf();
    const room = workViewport(el);
    const next = shifted(fitWorkView(boxes, { width: room.width, height: room.height }, fitOpts), insetOf(el, room));
    if (!next) return;
    fitted.current = boxes.length > 0;
    setView(next);
  }, [boxesOf, setView, fitOpts]);
  /* Autora's own framing, used while nobody has taken the camera. Everything is shown while that keeps it readable; once
     it would not, the newest piece is framed with its panels instead, at a size its words can be read. "Show all work"
     is still one press away, and is the person's to ask for. */
  const groupOf = useCallback((id: string): WorkBox[] => {
    const current = canvasRef.current;
    const engine = engineBoxesRef.current[id];
    if (engine) return [engine];
    const surface = current.surfaces.find((item) => item.id === id);
    if (!surface) return [];
    return [surface, ...current.panels.filter((panel) => panel.context === id && (panel.state === "live" || panel.state === "ghost" || panel.state === "dim" || panel.pinned)).map((panel) => ({
      x: panel.x, y: panel.y, w: panel.w,
      h: root.current?.querySelector<HTMLElement>(`[data-panel="${CSS.escape(panel.id)}"]`)?.offsetHeight || panel.h || 240,
    }))];
  }, []);
  const autoFit = useCallback(() => {
    const el = root.current;
    if (!el) return;
    const boxes = boxesOf();
    const room = workViewport(el);
    const size = { width: room.width, height: room.height };
    const all = fitWorkView(boxes, size, fitOpts);
    if (!all) return;
    let next = all;
    if (boxes.length > 0 && all.zoom < READABLE) {
      const current = canvasRef.current;
      const id = latest.current ?? current.focus ?? current.surfaces.at(-1)?.id ?? hostedRef.current.at(-1)?.id ?? null;
      const group = id ? groupOf(id) : [];
      const framed = group.length ? fitWorkView(group, size, fitOpts) : null;
      // A piece with many panels can itself be too much: then the piece alone, which is what was asked for.
      const alone = framed && framed.zoom < READABLE ? fitWorkView(group.slice(0, 1), size, fitOpts) : framed;
      if (alone) next = alone;
    }
    fitted.current = boxes.length > 0;
    setView(shifted(next, insetOf(el, room)) ?? next);
  }, [boxesOf, groupOf, setView, fitOpts]);
  const focus = useCallback(() => {
    const el = root.current;
    const current = canvasRef.current;
    const surface = current.surfaces.find((item) => item.id === current.focus);
    if (!el || !surface) return;
    const boxes = boxesOf().filter((box) => box === surface || current.panels.some((panel) => panel.context === surface.id && panel.x === box.x && panel.y === box.y));
    const room = workViewport(el);
    const next = shifted(fitWorkView([surface, ...boxes], { width: room.width, height: room.height }, fitOpts), insetOf(el, room));
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
    if (ready && !fitted.current) autoFit();
  }, [canvas.surfaces, canvas.panels, engineBoxes, ready, autoFit]);
  useEffect(() => {
    if (ready && !interacted.current && !handsBusy() && enginePins.size === 0 && !canvasRef.current.panels.some((panel) => panel.pinned || panel.touched)) autoFit();
  }, [engineBoxes, ready, enginePins.size, autoFit, handsBusy]);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const refit = () => {
      if (el.clientWidth <= 40 || el.clientHeight <= 40) return;
      if (!ready) return;
      if (!fitted.current || (!interacted.current && !handsBusy() && enginePins.size === 0 && !canvasRef.current.panels.some((panel) => panel.pinned || panel.touched))) autoFit();
    };
    const observer = new ResizeObserver(refit);
    observer.observe(el);
    // A phone's sheet lies over the board and so never resizes it: it says when the room above it has changed.
    window.addEventListener(SHEET_MOVED, refit);
    return () => { observer.disconnect(); window.removeEventListener(SHEET_MOVED, refit); };
  }, [autoFit, handsBusy, ready, enginePins.size]);

  /* Nothing is left lying on something else. A panel is placed by a guess at its height and a table or a picture grows
     once it is drawn, so a panel can end up under its neighbour. Once they are drawn, any panel the person has not
     placed themselves (not pinned, not moved by hand) that lies on a surface, a window or a panel above it is moved
     down clear of it. Quietly: it is the layout settling, not a step to undo. */
  useEffect(() => {
    const el = root.current;
    if (!quiet || !el || drag || handsBusy()) return;
    const frame = requestAnimationFrame(() => {
      const c = canvasRef.current;
      const heightOf = (p: Panel) => el.querySelector<HTMLElement>(`[data-panel="${CSS.escape(p.id)}"]`)?.offsetHeight || p.h || 0;
      const fixed: WorkBox[] = [...c.surfaces.map((s) => ({ x: s.x, y: s.y, w: s.w, h: s.h })), ...Object.values(engineBoxesRef.current)];
      const moves = new Map<string, number>();
      const live = c.panels.filter((p) => p.state !== "dim").map((p) => ({ p, h: heightOf(p) })).filter((x) => x.h > 0).sort((a, b) => a.p.y - b.p.y);
      for (const { p, h } of live) {
        let y = p.y;
        if (!p.pinned && !p.touched) {
          for (let pass = 0; pass < 8; pass += 1) {
            const on = fixed.find((b) => p.x < b.x + b.w - 4 && p.x + p.w > b.x + 4 && y < b.y + b.h - 4 && y + h > b.y + 4);
            if (!on) break;
            y = snap(on.y + on.h + GRID);
          }
          if (y !== p.y) moves.set(p.id, y);
        }
        fixed.push({ x: p.x, y, w: p.w, h });
      }
      if (moves.size) quiet((d) => { for (const p of d.panels) { const y = moves.get(p.id); if (y !== undefined) p.y = y; } });
    });
    return () => cancelAnimationFrame(frame);
  }, [canvas.panels, canvas.surfaces, engineBoxes, quiet, drag, handsBusy]);

  // A new surface the agent added off screen comes into view.
  const surfaceCount = useRef(canvas.surfaces.length);
  useEffect(() => {
    if (canvas.surfaces.length > surfaceCount.current && root.current && !handsBusy()) {
      const s = canvas.surfaces.at(-1)!;
      latest.current = s.id;
      if (!interacted.current && !canvas.panels.some((panel) => panel.pinned || panel.touched)) { autoFit(); surfaceCount.current = canvas.surfaces.length; return; }
      /* What can be seen of the board is the room clear of the conversation (beside a desktop's window, above a phone's
         sheet), which does not begin at the board's left edge: a surface under the conversation is not in view. */
      const r = workViewport(root.current);
      const v = viewRef.current;
      const inset = insetOf(root.current, r);
      const left = v.x + inset / v.zoom;
      const inView = s.x >= left && s.y >= v.y && s.x + s.w <= left + r.width / v.zoom && s.y + s.h <= v.y + r.height / v.zoom;
      if (!inView && r.width > 40 && r.height > 40 && !canvas.panels.some((panel) => panel.pinned)) setView({ ...v, x: s.x - (inset + 48) / v.zoom, y: s.y - 48 / v.zoom }, true);
    }
    surfaceCount.current = canvas.surfaces.length;
  }, [canvas.surfaces, canvas.panels, setView, autoFit, handsBusy]);

  // A panel placed off screen (the agent's, or one that had nowhere closer to go) comes into view: measured as
  // drawn, so a tall one is not left under the strip along the bottom.
  const seenPanels = useRef(new Set(canvas.panels.map((p) => p.id)));
  useEffect(() => {
    // A ghost is only an offer: it never moves the person's view away from what they are doing.
    const fresh = canvas.panels.filter((p) => !seenPanels.current.has(p.id) && p.state !== "ghost").map((p) => p.id);
    const offered = canvas.panels.some((p) => !seenPanels.current.has(p.id) && p.state === "ghost");
    seenPanels.current = new Set(canvas.panels.map((p) => p.id));
    /* An offer is no use out of sight. It never takes the view from someone who has put the camera where they want
       it; while the camera is still Autora's own framing, that framing is redone to take the offer in. */
    if (offered && !fresh.length && root.current && !drag && !interacted.current && !handsBusy() && !canvas.panels.some((panel) => panel.pinned || panel.touched)) {
      const frame = requestAnimationFrame(autoFit);
      return () => cancelAnimationFrame(frame);
    }
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
      /* Into the room that can be seen: clear of the conversation and of the work buttons, not just inside the board
         (a panel brought "into view" under the buttons could not be pressed). The reveal is worked out as if that
         room began at the board's edge, then moved back by how far in it really starts. */
      const room = workViewport(el);
      const inset = insetOf(el, room);
      const seen = { ...current, x: current.x + inset / current.zoom };
      const revealed = revealWorkView(seen, boxes, { width: room.width, height: room.height });
      if (revealed !== seen) setView(shifted(revealed, inset) ?? revealed, true);
    };
    // Heights are untransformed; positions come from the model, never a gliding screen rectangle.
    const frame = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(frame);
  }, [canvas.panels, drag, setView, handsBusy, autoFit]);

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
        const left = v.x + insetOf(el, room) / v.zoom;
        const x0 = Math.max(target.x, left), x1 = Math.min(target.x + target.w, left + room.width / v.zoom);
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
          const next = shifted(fitWorkView([freshTarget], { width: room.width, height: room.height }, fitOpts), insetOf(currentRoot, room));
          if (next) setView(next);
        }));
        return;
      }
      const v = viewRef.current;
      const room = workViewport(el);
      if (room.width <= 0 || room.height <= 0) return;
      const inset = insetOf(el, room);
      // The camera is worked out for the free room as if it began at the board's edge, then moved past the rail.
      const camera = automatic ? jumpTo({ x: target.x, y: target.y, width: target.w, height: target.h },
        { width: room.width, height: room.height }, { x: -(v.x + inset / v.zoom) * v.zoom, y: -v.y * v.zoom, zoom: v.zoom }) : null;
      const next = shifted(camera ? { x: -camera.x / camera.zoom, y: -camera.y / camera.zoom, zoom: camera.zoom }
        : (() => {
          /* A jump shows the piece with the controls that are out for it; when that is too much to read, the piece alone. */
          const size = { width: room.width, height: room.height };
          const group = id ? groupOf(id) : [target];
          const whole = group.length > 1 ? fitWorkView(group, size, fitOpts) : null;
          return whole && whole.zoom >= READABLE ? whole : fitWorkView([target], size, fitOpts);
        })(), inset);
      if (next) { if (!automatic) interacted.current = true; setView(next); }
    },
    frame: (box, automatic = false) => {
      if (automatic && (interacted.current || handsBusy() || enginePins.size > 0 || canvasRef.current.panels.some((panel) => panel.pinned))) return;
      const el = root.current;
      if (!el) return;
      const room = workViewport(el);
      if (room.width <= 0 || room.height <= 0) return;
      const next = shifted(fitWorkView([box], { width: room.width, height: room.height }, fitOpts), insetOf(el, room));
      if (next) { if (!automatic) interacted.current = true; setView(next, true); }
    },
    zoomOut: () => {
      const el = root.current;
      if (!el) return;
      interacted.current = true;
      const v = viewRef.current;
      const room = workViewport(el);
      const camera = zoomAt({ x: -v.x * v.zoom, y: -v.y * v.zoom, zoom: v.zoom },
        { x: insetOf(el, room) + room.width / 2, y: room.height / 2 }, v.zoom * 0.75);
      setView({ x: -camera.x / camera.zoom, y: -camera.y / camera.zoom, zoom: camera.zoom });
    },
    reveal: async (x, y) => {
      /* What the person can see of the board, not all of it: on a phone the conversation sheet covers its foot, and a
         point under the sheet is a hand nobody watches (and a picker opened there is out of reach). */
      const r = workViewport(root.current!);
      const inset = insetOf(root.current!, r);
      const v = viewRef.current;
      const margin = 80 / v.zoom;
      // Too far out to press anything (a phone fitting a whole canvas): in to a size a person works at, on the point.
      if (v.zoom < 0.75) {
        setView({ zoom: 1, x: x - inset - r.width / 2, y: y - r.height / 3 }, true);
        await new Promise((res) => setTimeout(res, 420));
        return toScreen(x, y);
      }
      const left = v.x + inset / v.zoom;
      if (x < left + margin || y < v.y + margin || x > left + r.width / v.zoom - margin || y > v.y + r.height / v.zoom - margin) {
        /* Only the agent's hand asks, and while it works it has the screen, as someone who took control of it would:
           it moves the view to where it is working, even where the person had moved it, and even while its own typing
           has the focus (which `handsBusy` would otherwise read as the person's). */
        setView({ ...v, x: x - (inset + r.width / 2) / v.zoom, y: y - r.height / v.zoom / 3 }, true);
        await new Promise((res) => setTimeout(res, 380));
      }
      return toScreen(x, y);
    },
    grid: () => root.current,
    toScreen,
    zoom: () => viewRef.current.zoom,
    viewRect: () => {
      const room = workViewport(root.current!);
      const inset = insetOf(root.current!, room);
      const v = viewRef.current;
      // What is in view and clear of the conversation and the work buttons on either side, so a new piece of work (or
      // a panel that is only offered) is not put down under them where it cannot be seen or pressed.
      return { x: v.x + (inset + 16) / v.zoom, y: v.y + 16 / v.zoom, w: (room.width - 32) / v.zoom, h: (room.height - 90) / v.zoom };
    },
    summonHere: () => {
      const r = root.current!.getBoundingClientRect();
      const h = workViewport(root.current!).height;
      const cx = r.left + r.width / 2;
      const cy = r.top + h / 3;
      setSummon({ sx: r.width / 2, sy: h / 3, at: toWorld(cx, cy) });
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
    // A dialog a window opened is portalled to the body, but React still bubbles its presses here: they are not the grid's.
    if (!e.currentTarget.contains(e.target as Node)) return;
    if ((e.target as HTMLElement).closest(".pa-panel, .pa-surface, .pa-summon, .pa-chrome, .pw-engine")) return;
    // A second finger is the pinch's, never a second pan.
    if (fingers.current.size > 1) return;
    interacted.current = true;
    setActiveWin(null);
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
    holdBoard(true);
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
      holdBoard(false);
      if (Math.abs(last.dx) < 2 && Math.abs(last.dy) < 2) return;
      edit((d) => {
        for (const p of d.panels) if (base.has(p.id)) { p.x = snap(p.x + last.dx); p.y = snap(p.y + last.dy); }
      }, base.size > 1 ? `Moved ${base.size} panels` : `Moved ${panel.title}`);
      onMoved(panel, { x: snap(panel.x + last.dx), y: snap(panel.y + last.dy), w: panel.w });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }, [canvas.panels, selected, setSelected, holdBoard, edit, onMoved]);

  const widenStart = useCallback((panel: Panel, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    holdBoard(true);
    const z = viewRef.current.zoom;
    const sx = e.clientX;
    let w = panel.w;
    const move = (ev: PointerEvent) => { w = Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, panel.w + (ev.clientX - sx) / z)); setWiden({ id: panel.id, w }); };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      setWiden(null);
      holdBoard(false);
      if (Math.abs(w - panel.w) >= GRID / 2) edit((d) => { const p = d.panels.find((x) => x.id === panel.id); if (p) p.w = snap(w); }, `Resized ${panel.title}`);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  }, [holdBoard, edit]);

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
      const at = toWorld(r.left + r.width / 2, r.top + workViewport(el).height / 2);
      if (files.length) { e.preventDefault(); onFiles(files, at); }
      // Rows become a table and plain words a page: nothing pasted onto the canvas is silently dropped.
      else if (text.trim().length > 1) { e.preventDefault(); onPaste(text, at); }
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
    holdBoard(true);
    const target = e.currentTarget;
    target.setPointerCapture?.(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, zoom: viewRef.current.zoom };
    const at = (ev: PointerEvent) => [(ev.clientX - start.x) / start.zoom, (ev.clientY - start.y) / start.zoom] as const;
    const move = (ev: PointerEvent) => { const [dx, dy] = at(ev); step(dx, dy); };
    const up = (ev: PointerEvent) => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      holdBoard(false);
      const [dx, dy] = at(ev);
      done(dx, dy);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }, [holdBoard]);

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
  /** The shape of the picture a browser or app window shows (width over height), and what is around it. */
  const pictureFit = (id: string): { ratio: number; chrome: number; side: number } | null => {
    const win = root.current?.querySelector<HTMLElement>(`[data-work="${CSS.escape(id)}"]`);
    if (!win || !["browser", "app"].includes(win.dataset.engine ?? "")) return null;
    const img = win.querySelector<HTMLImageElement>(".frame img, img.frame, .app-canvas img");
    const stage = win.querySelector<HTMLElement>(".shot-stage, .app-canvas")?.closest<HTMLElement>(".shot-stage") ?? win.querySelector<HTMLElement>(".app-canvas")?.parentElement;
    if (!img || !stage || !img.naturalWidth || !img.naturalHeight) return null;
    const css = getComputedStyle(stage);
    const padX = parseFloat(css.paddingLeft) + parseFloat(css.paddingRight), padY = parseFloat(css.paddingTop) + parseFloat(css.paddingBottom);
    return {
      ratio: img.naturalWidth / img.naturalHeight,
      chrome: win.offsetHeight - (stage.clientHeight - padY),
      side: win.offsetWidth - (stage.clientWidth - padX),
    };
  };
  const engineResize = (id: string) => (e: ReactPointerEvent<HTMLElement>) => {
    const box = engineBoxesRef.current[id];
    if (!box) return;
    raiseIt(id);
    /* A page or an app is a picture of a fixed shape: the corner pull keeps it, so the window never has bars or a
       blank band beside or below it. Everything else around the picture (title bar, toolbar) keeps its own height. */
    const fit = pictureFit(id);
    const sized = (dx: number, dy: number) => {
      const w = Math.max(320, box.w + dx);
      return { w, h: fit ? Math.max(240, Math.round(fit.chrome + (w - fit.side) / fit.ratio)) : Math.max(240, box.h + dy) };
    };
    gesture(e, (dx, dy) => setEngineBoxes((before) => ({ ...before, [id]: { ...box, ...sized(dx, dy) } })),
      (dx, dy) => {
        if (Math.abs(dx) + Math.abs(dy) < 3) return;
        const { w, h } = sized(dx, dy);
        edit((d) => { const wins = d.windows ?? (d.windows = []); const t = placeWindow(wins, id, { w, h }, { front: true }); if (t) delete t.was; }, `Resized ${windowName(id)}`);
      });
  };
  const windowName = (id: string) => hostedRef.current.find((w) => w.id === id)?.title ?? "a window";
  /** A window raised over the rest (not a step to undo). */
  const raiseIt = (id: string) => { if (quiet && raiseWindow(structuredClone(canvasRef.current.windows ?? []), id)) quiet((d) => { raiseWindow(d.windows ?? [], id); }); };
  /** Tidy: windows and surfaces in rows, none over another, as the agent's `tidy` does (one step to undo). */
  const tidyUp = () => {
    const c = canvasRef.current;
    /* A surface is tidied with the panels that belong to it, as one block: put in rows by itself it left its controls
       behind, and landed on the next one's. */
    const mine = (id: string) => c.panels.filter((p) => p.context === id && p.state !== "dim");
    const blockOf = (x: Surface) => {
      const parts = [{ x: x.x, y: x.y, w: x.w, h: x.h }, ...mine(x.id).map((p) => ({ x: p.x, y: p.y, w: p.w, h: root.current?.querySelector<HTMLElement>(`[data-panel="${CSS.escape(p.id)}"]`)?.offsetHeight || p.h || 240 }))];
      const left = Math.min(...parts.map((b) => b.x)), top = Math.min(...parts.map((b) => b.y));
      return { id: x.id, x: left, y: top, w: Math.max(...parts.map((b) => b.x + b.w)) - left, h: Math.max(...parts.map((b) => b.y + b.h)) - top };
    };
    const items = [
      ...hostedRef.current.flatMap((w) => engineBoxesRef.current[w.id] ? [{ id: w.id, ...engineBoxesRef.current[w.id]! }] : []),
      ...c.surfaces.map(blockOf),
    ];
    if (!items.length) return;
    const room = root.current ? workViewport(root.current, { clearDock: phone }) : { width: 1056, height: 740 };
    const spots = tidyBoxes(items, { width: Math.max(1600, room.width * 2) });
    interacted.current = true;
    edit((d) => {
      const wins = d.windows ?? (d.windows = []);
      for (const w of hostedRef.current) {
        const at = spots.get(w.id), box = engineBoxesRef.current[w.id];
        if (at && box) { const t = placeWindow(wins, w.id, { x: snap(at.x), y: snap(at.y), w: box.w, h: box.h }); if (t) delete t.was; }
      }
      for (const x of d.surfaces) {
        const at = spots.get(x.id), was = items.find((i) => i.id === x.id);
        if (!at || !was) continue;
        const dx = snap(at.x - was.x), dy = snap(at.y - was.y);
        x.x += dx; x.y += dy;
        for (const p of d.panels) if (p.context === x.id && p.state !== "dim") { p.x += dx; p.y += dy; }
      }
    }, "Tidied the layout");
    maxed.current.clear();
    rerender((n) => n + 1);
    const boxes = [...spots].map(([id, at]) => { const it = items.find((i) => i.id === id)!; return { x: at.x, y: at.y, w: it.w, h: it.h }; });
    // Framed in the room that can be seen (clear of the conversation and the buttons), not from the board's own edge.
    setView(shifted(fitWorkView(boxes, { width: room.width, height: room.height }, fitOpts), root.current && "left" in room ? insetOf(root.current, room) : 0) ?? viewRef.current, true);
  };

  /** What each maximised tile was, to give it back. */
  const maxed = useRef(new Map<string, WorkBox>());
  /** Maximise: the tile takes the whole screen there is for work, at its real size, in the middle; again, and it is as it was. */
  const maximize = (id: string, kind: "engine" | "surface") => {
    const el = root.current;
    if (!el) return;
    // Clear of the board's bottom row (the history track) on any screen: a maximised window is not drawn under it.
    const room = workViewport(el, { clearDock: true });
    const pad = phone ? 8 : 16;
    if (kind === "engine") {
      // A window's "was" is kept with the canvas, so a reload (or the agent) can give it back.
      const was = canvasRef.current.windows?.find((w) => w.id === id)?.was;
      const now = engineBoxesRef.current[id];
      if (!now) return;
      const base = canvasRef.current.windows?.some((w) => w.id === id) ? null : { id, ...now };
      let result: "maximised" | "restored" | null = null;
      edit((d) => {
        const wins = d.windows ?? (d.windows = []);
        if (base && !wins.some((w) => w.id === id)) placeWindow(wins, id, base);
        result = maximiseWindow(wins, id, { w: room.width, h: room.height }, pad);
      }, was ? "Restored a window" : "Maximised a window");
      interacted.current = true;
      const win = (maxedPreview(id, was, now, room, pad));
      if (was) setView(fitWorkView([win], { width: room.width, height: room.height }, fitOpts) ?? viewRef.current, true);
      else setView(snugView(win, room, pad), true);
      void result;
      return;
    }
    const was = maxed.current.get(id);
    const now = canvasRef.current.surfaces.find((s) => s.id === id);
    if (!now) return;
    const next = was ?? { x: now.x, y: now.y, w: Math.max(MIN_TILE.w, room.width - pad * 2), h: Math.max(MIN_TILE.h, room.height - pad * 2) };
    if (was) maxed.current.delete(id);
    else maxed.current.set(id, { x: now.x, y: now.y, w: now.w, h: now.h });
    edit((d) => { const t = d.surfaces.find((x) => x.id === id); if (t) { t.x = next.x; t.y = next.y; t.w = next.w; t.h = next.h; } }, was ? "Restored a window" : "Maximised a window");
    interacted.current = true;
    if (was) setView(fitWorkView([next], { width: room.width, height: room.height }, fitOpts) ?? viewRef.current, true);
    else setView(snugView(next, room, pad), true);
  };
  /** The view that puts a maximised box's corner a pad inside the room there is for work (clear of the conversation and
      the rail, which the board's own edge is not), at full size, so it fills that room rather than sitting under them. */
  const snugView = (box: WorkBox, room: { left: number; top: number }, pad: number): View => {
    const at = root.current?.getBoundingClientRect();
    return { x: box.x - pad - (at ? Math.max(0, room.left - at.left) : 0), y: box.y - pad - (at ? Math.max(0, room.top - at.top) : 0), zoom: 1 };
  };
  /** What a window's box is after maximising (or restoring), to put the view on. */
  const maxedPreview = (id: string, was: WorkBox | undefined, now: WorkBox, room: { width: number; height: number }, pad: number): WorkBox =>
    was ?? { x: now.x, y: now.y, w: Math.max(320, room.width - pad * 2), h: Math.max(240, room.height - pad * 2) };
  // A phone's work buttons: folded into one until wanted (see where the dock is drawn).
  const [dockOpen, setDockOpen] = useState(false);
  /* The window being worked in: its controls are there while it is, and gone when the work moves to the board or another window. */
  const [activeWin, setActiveWin] = useState<string | null>(null);
  /* An editor in a frame takes the pointer and the keys whole: the page hears no press inside it, and neither :hover nor
     :focus-within can be counted on there. What the page can always see is that the frame has the focus, so that is
     looked at a couple of times a second: the window being typed or clicked in is the one being worked in. */
  useEffect(() => {
    const look = window.setInterval(() => {
      const el = document.activeElement;
      const id = el instanceof HTMLIFrameElement ? el.closest(".pw-engine")?.getAttribute("data-work") : null;
      if (id) setActiveWin((before) => (before === id ? before : id));
      // The work has moved off the board (into the conversation, a dialog): no window is being worked in.
      else if (el && el !== document.body && !el.closest(".pa-board")) setActiveWin(null);
    }, 400);
    return () => window.clearInterval(look);
  }, []);
  const dockTimer = useRef(0);
  const foldDockSoon = useCallback(() => {
    window.clearTimeout(dockTimer.current);
    dockTimer.current = window.setTimeout(() => setDockOpen(false), 2500);
  }, []);
  useEffect(() => {
    const el = root.current;
    if (!dockOpen || !el) return;
    const fold = () => setDockOpen(false);
    el.addEventListener("pointerdown", fold);
    return () => { el.removeEventListener("pointerdown", fold); window.clearTimeout(dockTimer.current); };
  }, [dockOpen]);
  const [, rerender] = useState(0);
  const isMaxed = (id: string) => maxed.current.has(id) || Boolean(canvas.windows?.find((w) => w.id === id)?.was);
  /* A window's own Full screen: the board's Maximise for it, and on a phone the conversation sheet drops to its strip
     (the shared flag, which the chat view reads). Through a ref, so the frames' value stays put while the board pans. */
  const fullRef = useRef<(id: string, next: boolean) => void>(() => undefined);
  fullRef.current = (id, next) => {
    const toggle = () => { if (next !== isMaxed(id)) { maximize(id, "engine"); rerender((n) => n + 1); } };
    if (!phone) { toggle(); return; }
    if (!next) { toggle(); setFullscreen(false); return; }
    /* The sheet drops first and the board grows into the room it gives; the window is sized to that room once the board
       has stopped growing (a few still frames, a second at most), not to the room it had a moment before. */
    setFullscreen(true);
    const el = root.current;
    let last = -1, still = 0, frames = 0;
    const settle = () => {
      // The room above the sheet, not the board's own height: the sheet lies over the board and never resizes it.
      const h = el ? Math.round(workViewport(el).height) : 0;
      still = h === last ? still + 1 : 0;
      last = h;
      if (still >= 3 || ++frames > 60) toggle(); else requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  };
  const onWindowFull = useCallback((id: string, next: boolean) => fullRef.current(id, next), []);

  const z = view.zoom;

  // ------------------------------------------- sending work to another window --
  /* Every piece of work that can be sent somewhere has a node in its title bar. Drag from it onto another window and a
     line follows the pointer; the windows that can take it light, and letting go on one sends it there. A click on the
     node lists where it can go instead, including apps that are not open yet (sending opens them). The line that stays
     is the board's own record of where work went (flowLines, below). */
  const [link, setLink] = useState<{ from: string; sx: number; sy: number; x: number; y: number; over: string | null } | null>(null);
  const [linkMenu, setLinkMenu] = useState<{ from: string; x: number; y: number } | null>(null);
  const linkDragged = useRef(false);
  const sourceOf = (id: string): { file: SentFile; mode: WorkspaceMode } | null => {
    const s = canvas.surfaces.find((x) => x.id === id);
    if (s) { const file = surfaceSends(s.kind, s.title); return file ? { file, mode: "panacea" } : null; }
    const work = hosted.find((w) => w.id === id);
    const file = work ? engineSends(work.mode) : null;
    return work && file ? { file, mode: work.mode } : null;
  };
  /* Which apps this server has and has switched on: an app that is not there is not offered, since sending to it could
     only open a window that says so. Unknown until it is read (and then everything is offered, as before). */
  const [usable, setUsable] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!onLink) return;
    let live = true;
    fetch("/api/settings").then((r) => r.json()).then((s: { tools?: { installed?: Record<string, boolean>; config?: Record<string, { enabled?: boolean } | undefined> } }) => {
      if (!live) return;
      const out: Record<string, boolean> = {};
      for (const mode of Object.keys(WORKSPACE_MODES)) out[mode] = s?.tools?.installed?.[mode] !== false && s?.tools?.config?.[mode]?.enabled !== false;
      setUsable(out);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [onLink]);
  const appsFor = (id: string): WorkspaceMode[] => {
    const src = sourceOf(id);
    return src ? takersOf(src.file, src.mode).filter((mode) => usable[mode] !== false || hosted.some((w) => w.mode === mode)) : [];
  };
  useEffect(() => {
    if (!linkMenu) return;
    const shut = (e: Event) => { if (!(e.target as HTMLElement | null)?.closest?.(".pa-link-menu, .pa-link-dot")) setLinkMenu(null); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setLinkMenu(null); };
    document.addEventListener("pointerdown", shut, true);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", shut, true); document.removeEventListener("keydown", key); };
  }, [linkMenu]);
  const startLink = (id: string) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    const board = root.current;
    if (e.button !== 0 || !board) return;
    e.stopPropagation();
    linkDragged.current = false;
    const dot = e.currentTarget;
    const takes = new Set(appsFor(id));
    const at = (cx: number, cy: number) => { const r = board.getBoundingClientRect(); return { x: cx - r.left, y: cy - r.top }; };
    const d = dot.getBoundingClientRect();
    const from = at(d.left + d.width / 2, d.top + d.height / 2);
    const start = { x: e.clientX, y: e.clientY };
    /** The window under the pointer, when it is one this can be sent to. */
    const windowAt = (cx: number, cy: number) => {
      const win = document.elementFromPoint(cx, cy)?.closest<HTMLElement>(".pw-engine");
      const work = hosted.find((w) => w.id === win?.dataset.work);
      return work && work.id !== id && takes.has(work.mode) ? work : null;
    };
    dot.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (!linkDragged.current && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
      if (!linkDragged.current) { linkDragged.current = true; setLinkMenu(null); holdBoard(true); }
      setLink({ from: id, sx: from.x, sy: from.y, ...at(ev.clientX, ev.clientY), over: windowAt(ev.clientX, ev.clientY)?.id ?? null });
    };
    const up = (ev: PointerEvent) => {
      dot.removeEventListener("pointermove", move); dot.removeEventListener("pointerup", up); dot.removeEventListener("pointercancel", up);
      if (!linkDragged.current) return;
      holdBoard(false);
      setLink(null);
      const to = ev.type === "pointerup" ? windowAt(ev.clientX, ev.clientY) : null;
      if (to) onLink?.(id, to.mode);
    };
    dot.addEventListener("pointermove", move); dot.addEventListener("pointerup", up); dot.addEventListener("pointercancel", up);
  };
  /** The node in a piece of work's title bar; none when it has nothing to send or nowhere it could go. */
  const linkDot = (id: string, title: string) => {
    if (!onLink || phone || !appsFor(id).length) return null;
    return (
      <button type="button" className="pa-link-dot" aria-label={`Send ${title} to another window`} aria-haspopup="menu" aria-expanded={linkMenu?.from === id}
        title="Drag onto another window to send this there, or click to choose where"
        onPointerDown={startLink(id)}
        onClick={(e) => {
          if (linkDragged.current) return;
          const board = root.current;
          if (!board) return;
          const r = board.getBoundingClientRect();
          const d = e.currentTarget.getBoundingClientRect();
          setLinkMenu((open) => (open?.from === id ? null : { from: id, x: d.left - r.left, y: d.bottom - r.top + 6 }));
        }}>
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" focusable="false">
          <circle cx="4" cy="8" r="2.25" /><circle cx="12" cy="8" r="2.25" fill="currentColor" /><path d="M6.25 8h3.5" />
        </svg>
      </button>
    );
  };
  const linkTakes = link ? new Set(appsFor(link.from)) : null;

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
    return [...pairs.values()].map(({ a, b, what, more, key }) => {
      const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
      const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      const p = boxEdge(a, cb);
      const q = boxEdge(b, ca);
      return { key, p, q, mid: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, angle: Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI, label: more ? `${what} +${more}` : what };
    });
  })();
  // ------------------------------------------------------ windows joined --
  /* A join (joins.ts) is the person's own: one window dragged onto another and let go. It is drawn as a thick solid
     connector with a round end at each window, unlike a flow's thin dashed arrow, and has an Unjoin button halfway. Drawn
     under the windows, so it never takes a click meant for one. */
  const joinLines = (canvas.joins ?? []).flatMap((j) => {
    const a = engineBoxes[j.from], b = engineBoxes[j.to];
    if (!a || !b) return [];
    const p = boxEdge(a, { x: b.x + b.w / 2, y: b.y + b.h / 2 });
    const q = boxEdge(b, { x: a.x + a.w / 2, y: a.y + a.h / 2 });
    return [{ key: `${j.from}>${j.to}`, from: j.from, to: j.to, p, q, mid: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 } }];
  });
  const unjoin = (from: string, to: string) => edit((d) => { d.joins = removeJoin(d.joins ?? [], from, to); if (!d.joins.length) delete d.joins; },
    `Unjoined ${windowName(from)} from ${windowName(to)}`);
  /** A window being dragged that can be joined into another: which one it is over, and whether letting go joins them. */
  const [joinDrag, setJoinDrag] = useState<{ from: string; over: string | null; armed: boolean } | null>(null);
  const dot = GRID * 1.5 * z;
  const bg = {
    backgroundSize: `${dot}px ${dot}px`,
    backgroundPosition: `${-view.x * z}px ${-view.y * z}px`,
  };
  /** Take a window by its title strip, with a mouse or a finger: it comes over the rest and goes where it is put. */
  const moveWindow = (e: ReactPointerEvent<HTMLElement>, work: HostedWork, box: { x: number; y: number; w: number; h: number }) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button,a,input,select,textarea,[role='button']") || enginePins.has(work.id)) return;
    e.preventDefault(); e.stopPropagation(); interacted.current = true; holdBoard(true);
    raiseIt(work.id);
    const target = e.currentTarget; target.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, zoom: viewRef.current.zoom };
    /* Hovering to join: held over a window it can be joined into for a moment, that window lights and says what letting
       go does; let go there and the two are joined (the dragged window goes back where it was). Moving off, or Escape,
       and nothing is joined. */
    const targets = hostedRef.current.filter((w) => canJoin(work.id, w.id)).map((w) => w.id);
    let over: string | null = null, armed = false, dwell = 0;
    if (targets.length) {
      setJoinDrag({ from: work.id, over: null, armed: false });
      // Escape has to reach this page: an editor's frame that has the keys would keep it.
      if (document.activeElement instanceof HTMLIFrameElement) document.activeElement.blur();
    }
    const overAt = (event: PointerEvent): string | null => {
      const r = root.current?.getBoundingClientRect(), v = viewRef.current;
      if (!r) return null;
      const x = v.x + (event.clientX - r.left) / v.zoom, y = v.y + (event.clientY - r.top) / v.zoom;
      return targets.find((id) => { const b = engineBoxesRef.current[id]; return b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h; }) ?? null;
    };
    const move = (event: PointerEvent) => {
      setEngineBoxes((before) => ({ ...before,
        [work.id]: { ...box, x: box.x + (event.clientX - start.x) / start.zoom, y: box.y + (event.clientY - start.y) / start.zoom } }));
      if (!targets.length) return;
      const now = overAt(event);
      if (now === over) return;
      over = now; armed = false; window.clearTimeout(dwell);
      setJoinDrag({ from: work.id, over, armed: false });
      if (now) dwell = window.setTimeout(() => { armed = true; setJoinDrag({ from: work.id, over: now, armed: true }); }, JOIN_DWELL_MS);
    };
    const end = () => {
      target.removeEventListener("pointermove", move); target.removeEventListener("pointerup", up); target.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key, true);
      window.clearTimeout(dwell); holdBoard(false);
      if (targets.length) setJoinDrag(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation();
      end();
      if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId);
      setEngineBoxes((before) => ({ ...before, [work.id]: box }));
    };
    const up = (event: PointerEvent) => {
      end();
      const dx = (event.clientX - start.x) / start.zoom, dy = (event.clientY - start.y) / start.zoom;
      if (armed && over && event.type === "pointerup") {
        const to = over;
        setEngineBoxes((before) => ({ ...before, [work.id]: box }));
        edit((d) => { d.joins = addJoin(d.joins ?? [], { from: work.id, to, at: Date.now() }); }, `Joined ${work.title} into ${windowName(to)}`);
        onJoined?.(work.id, to);
        return;
      }
      if (Math.abs(dx) + Math.abs(dy) < 3) return;
      edit((d) => { placeWindow(d.windows ?? (d.windows = []), work.id, { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h }, { front: true }); }, `Moved ${work.title}`);
    };
    target.addEventListener("pointermove", move); target.addEventListener("pointerup", up); target.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key, true);
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
        {joinLines.length > 0 && <>
          <svg className="pa-joins" width="1" height="1" aria-hidden="true">
            {joinLines.map((l) => (
              <g key={l.key} className="pa-join" data-join={l.key}>
                <line x1={l.p.x} y1={l.p.y} x2={l.q.x} y2={l.q.y} vectorEffect="non-scaling-stroke" />
                <circle cx={l.p.x} cy={l.p.y} r={6 / z} />
                <circle cx={l.q.x} cy={l.q.y} r={6 / z} />
              </g>
            ))}
          </svg>
          {joinLines.map((l) => (
            <button type="button" key={l.key} className="pa-join-chip" data-join={l.key}
              style={{ left: l.mid.x, top: l.mid.y, transform: `translate(-50%, -50%) scale(${1 / z})` }}
              title={`${windowName(l.from)} is joined into ${windowName(l.to)}: its table there follows it. Click to unjoin.`}
              aria-label={`Unjoin ${windowName(l.from)} from ${windowName(l.to)}`}
              onPointerDown={(e) => e.stopPropagation()} onClick={() => unjoin(l.from, l.to)}>
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" focusable="false">
                <circle cx="4" cy="8" r="2.25" fill="currentColor" /><circle cx="12" cy="8" r="2.25" fill="currentColor" /><path d="M6.25 8h3.5" />
              </svg>
              <span>Unjoin</span>
            </button>
          ))}
        </>}
        <div className="pa-wins">{hosted.map((work) => {
          const box = engineBoxes[work.id];
          if (!box) return null;
          const z = canvas.windows?.find((w) => w.id === work.id)?.z ?? 0;
          return <section key={work.id} className={`pw-engine${enginePins.has(work.id) ? " is-pinned" : ""}${isMaxed(work.id) ? " is-max" : ""}${activeWin === work.id ? " is-active" : ""}`} data-engine={work.mode}
            data-link={!link || link.from === work.id ? undefined : link.over === work.id ? "over" : linkTakes?.has(work.mode) ? "takes" : "no"}
            data-join={!joinDrag ? undefined : joinDrag.from === work.id ? (joinDrag.over ? "dragging" : undefined)
              : !canJoin(joinDrag.from, work.id) ? undefined : joinDrag.over === work.id ? (joinDrag.armed ? "armed" : "near") : "takes"}
            data-work={work.id} style={{ left: box.x, top: box.y, width: box.w, height: box.h, zIndex: z + 1, ...(phone ? { maxWidth: "calc(100vw - 16px)" } : {}) }} aria-label={`${work.title} work surface`}
            /* Working in a window is not holding the view (only panning, zooming or dragging is): Follow still brings the
               agent's next window into view after the person has pressed a button in this one. */
            onPointerDownCapture={(e) => { if (e.isTrusted) { onJumpWork?.(work.mode); raiseIt(work.id); } setActiveWin(work.id); }}
            /* The app's own bar (the file's name) is the window's title strip too: taken anywhere that is not a control, it moves the window. */
            onPointerDown={(e) => { if ((e.target as HTMLElement).closest(".pw-engine-body .pdf-bar, .pw-engine-body .app-bar")) moveWindow(e, work, box); }}>
            <header className="pw-engine-head" onPointerDown={(e) => moveWindow(e, work, box)}>
              <span className="pw-engine-ico">{workIcon(work.mode)}</span><b>{work.title}</b><span className="spacer" />
              {linkDot(work.id, work.title)}
              <button type="button" aria-label={isMaxed(work.id) ? `Restore ${work.title}` : `Maximise ${work.title}`} aria-pressed={isMaxed(work.id)}
                onClick={() => { onWindowFull(work.id, !isMaxed(work.id)); onJumpWork?.(work.mode); }}><IconMaximize size={14} /></button>
              <button type="button" aria-pressed={enginePins.has(work.id)} aria-label={`Pin ${work.title} work`} onClick={() => setEnginePins((before) => {
                const next = new Set(before); if (next.has(work.id)) next.delete(work.id); else next.add(work.id); return next;
              })}>Pin</button>
              {onCloseWork && <button type="button" aria-label={`Close ${work.title} work`}
                onClick={() => { void sure(`Close ${work.title}?`, "Close").then((yes) => { if (yes) onCloseWork(work.mode); }); }}><IconX size={14} /></button>}
            </header>
            {joinDrag && joinDrag.over === work.id && (
              <div className={`pa-join-drop${joinDrag.armed ? " is-armed" : ""}`} role="status">
                <span>{joinDrag.armed ? joinOffer(joinDrag.from, work.id) : "Hold here to join"}</span>
              </div>
            )}
            <div className="pw-engine-body"><EngineFrameScope id={work.id} full={isMaxed(work.id)} onFull={onWindowFull}>{work.content}</EngineFrameScope></div>
            <i className="pa-resize" role="presentation" title="Drag to resize" onPointerDown={engineResize(work.id)} />
          </section>;
        })}</div>
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
              {linkDot(s.id, s.title)}
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
        /* The controls for moving around the work are there when there is work to move around: none on a blank canvas, and
           Tidy only once there is more than one thing to put in rows. (CLAUDE.md: controls appear when the work needs them.) */
        const pieces = canvas.surfaces.length + hosted.length;
        if (pieces === 0 || (phone && windowFull)) return null;
        /* On a phone the buttons stand over a small screen's work, so they are folded into one small button until they
           are wanted: a tap opens them, and they fold away again a moment after one is used or the board is touched. */
        const dock = <nav className={`pw-jump-dock pa-chrome${phone ? ` is-phone${dockOpen ? " is-open" : ""}` : ""}`} aria-label="Jump to work"
          onClick={phone ? (event) => { if (!(event.target as HTMLElement).closest(".pw-jump-toggle")) foldDockSoon(); } : undefined}>
        {phone && <button type="button" className="pw-jump-toggle" aria-expanded={dockOpen}
          aria-label={dockOpen ? "Hide the work buttons" : "Show the work buttons"} title={dockOpen ? "Hide" : "Jump to work, zoom out, show all"}
          onClick={() => { window.clearTimeout(dockTimer.current); setDockOpen((open) => !open); }}>{dockOpen ? <IconX size={14} /> : <IconMoreH size={16} />}</button>}
        {canvas.surfaces.map((surface) => <button type="button" key={surface.id} data-jump={surface.id} title={`Jump to ${surface.title}`}
          aria-label={`Jump to ${surface.title}`} onClick={() => { handle.current?.jump(surface.id); onFocus(surface.id); onJumpWork?.("panacea"); }}>
          {surface.kind === "board" ? <IconOrg size={17} /> : workIcon(surface.kind === "image" ? "photo" : surface.kind === "data" ? "sheets" : surface.kind === "doc" ? "pages" : "widget")}
        </button>)}
        {hosted.map((work) => <button type="button" key={work.id} data-jump={work.id} title={`Jump to ${workName(root.current, work)}`} aria-label={`Jump to ${work.title}`}
          onClick={() => { handle.current?.jump(work.id); onJumpWork?.(work.mode); }}>{workIcon(work.mode)}</button>)}
        <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => { handle.current?.zoomOut(); onJumpWork?.(followTarget ?? "panacea"); }}>−</button>
        <button type="button" aria-label="Show all work" title="Show all work" onClick={() => { interacted.current = true; fit(); onJumpWork?.(followTarget ?? "panacea"); }}><IconMaximize size={16} /></button>
        {pieces > 1 && <button type="button" aria-label="Tidy the layout" title="Tidy: windows and surfaces in rows, none over another" onClick={() => { tidyUp(); onJumpWork?.(followTarget ?? "panacea"); }}><IconTidy size={16} /></button>}
        </nav>;
        return navigationHost ? createPortal(dock, navigationHost) : dock;
      })()}
      {link && (
        <svg className="pa-link-line" aria-hidden="true">
          <line x1={link.sx} y1={link.sy} x2={link.x} y2={link.y} className={link.over ? "is-over" : undefined} />
          <circle cx={link.x} cy={link.y} r={link.over ? 7 : 5} className={link.over ? "is-over" : undefined} />
        </svg>
      )}
      {linkMenu && (() => {
        const apps = appsFor(linkMenu.from);
        const open = apps.filter((mode) => hosted.some((w) => w.mode === mode));
        const rest = apps.filter((mode) => !open.includes(mode));
        const item = (mode: WorkspaceMode) => (
          <button type="button" role="menuitem" key={mode} onClick={() => { setLinkMenu(null); onLink?.(linkMenu.from, mode); }}>
            {workIcon(mode)}<span>{WORKSPACE_MODES[mode].name}</span>
          </button>
        );
        return (
          <div className="pa-link-menu pa-chrome" role="menu" aria-label="Send to" style={{ left: linkMenu.x, top: linkMenu.y }}>
            <span className="pa-link-menu-h">Send to</span>
            {open.map(item)}
            {rest.length > 0 && open.length > 0 && <span className="pa-link-menu-h">Open in</span>}
            {rest.map(item)}
          </div>
        );
      })()}
      {children}
    </div>
  );
}

/** Where the line from a box's middle toward `p` leaves the box. */
function boxEdge(box: WorkBox, p: { x: number; y: number }) {
  const c = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  const t = Math.min(dx ? (box.w / 2) / Math.abs(dx) : Infinity, dy ? (box.h / 2) / Math.abs(dy) : Infinity, 1);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/** What a window's work is called, for the button that jumps to it: the file's or the song's own name off its strip
    ("Budget.xlsx"), with the app's name when it has none yet. */
function workName(board: HTMLElement | null, work: HostedWork): string {
  const strip = board?.querySelector(`.pw-engine[data-work="${CSS.escape(work.id)}"] .pw-engine-body .pdf-bar`);
  const name = (strip?.querySelector<HTMLInputElement>("input.st-song-name")?.value ?? strip?.querySelector(".pdf-bar-name")?.textContent ?? "").trim();
  return name && name !== work.title ? `${name} (${work.title})` : work.title;
}

function workIcon(mode: WorkspaceMode): ReactNode {
  const icons: Partial<Record<WorkspaceMode, ReactNode>> = {
    pages: <IconNotebook size={17} />, sheets: <IconTable size={17} />, slides: <IconSlides size={17} />, pdf: <IconFile size={17} />,
    photo: <IconImage size={17} />, video: <IconVideo size={17} />, studio: <IconMusic size={17} />, cad: <IconCube size={17} />,
    game: <IconGame size={17} />, browser: <IconGlobe size={17} />, app: <IconCode size={17} />,
  };
  return icons[mode] ?? <IconSparkle size={17} />;
}

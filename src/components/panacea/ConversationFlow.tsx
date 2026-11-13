import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import {
  FLOAT_GAP, FLOAT_STEP, clampFloat, defaultFloat, magnet, nudgeFloat, resizeFloat,
  SHEET_MOVED, type Edge, type FloatBox, type PreviewLine, type Room, type Sheet,
} from "./chatLayout";
import { AutoraMark } from "../AutoraMark";
import { IconUser } from "../Icons";
import "./ConversationFlow.css";

interface ConversationFlowProps {
  conversation: ReactNode;
  entry: ReactNode;
  todos?: ReactNode;
  workNavigation?: ReactNode;
  conversationLabel?: string;
  /** Nothing has been said yet: the pane is only as tall as its message box, with no empty glass above it. */
  empty?: boolean;
  /** A phone's sheet is retracted to its entry strip (Canvas only). A desktop window is never retracted. */
  collapsed?: boolean;
  /** A phone: opens or retracts the sheet. */
  onToggle?: () => void;
  /** A phone: the conversation is a glass sheet over the foot of the canvas instead of a window anywhere over it. */
  phone?: boolean;
  /** Where the desktop window stands and how big it is (null: never moved, so the default at the bottom left), and the
      way to change it (called when a drag, a resize or a key press settles; null puts it back). */
  float?: FloatBox | null;
  onFloat?: (box: FloatBox | null) => void;
  /** Phone sheet height when open, and the way to change it. */
  sheet?: Sheet;
  onSheet?: (sheet: Sheet) => void;
  /** A question or permission is waiting: the sheet may not be lowered below half. */
  locked?: boolean;
  /** The last thing or two said, shown on a phone while the sheet is retracted; a tap opens the sheet. */
  preview?: readonly PreviewLine[];
  /** How many steps and memory notes the newest turn holds that the preview leaves out. */
  hiddenSteps?: number;
}

/** A finger must move this far before a press on the handle is a drag rather than a tap. */
const SHEET_SLOP = 8;
/** Where a touch never moves the sheet: the entry box, where you type. */
const NO_SHEET_DRAG = "textarea, input, select, [contenteditable], .conversation-flow__entry";
/** The handle row, and the column's padding and gap under the entry strip (ConversationFlow.css). */
const HANDLE_H = 0;
const SHEET_PAD = 17;

interface SheetDrag {
  y: number; lastY: number; lastT: number; speed: number; active: boolean;
  startH: number; h: number; parentH: number;
}

/** What paint() needs of the sheet's surroundings, measured once when it starts to move rather than every frame. */
interface SheetGeometry { parentH: number; half: number; min: number }

const LEVELS = ["Canvas only", "Half", "Full"] as const;

/** Whether a finger at this x is on the sheet's left half, the only side whose swipes open and close it. */
function onSheetSide(root: HTMLElement, x: number) {
  const box = root.getBoundingClientRect();
  return x - box.left <= box.width / 2;
}

/** The window's resize handles: four edges and four corners. */
const EDGES: readonly Edge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

/** Hosts the live Thread and native composer without taking ownership of either: a glass window floating over the
    world on a desktop (moved by the Move button in its top-left corner, sized by the pull in its top-right, pulled onto the left or
    right side when brought near it), a glass sheet floating over the foot of the canvas on a phone. */
export function ConversationFlow({
  conversation,
  entry,
  todos,
  workNavigation,
  conversationLabel = "Conversation with Autora",
  collapsed = false,
  onToggle,
  phone = false,
  float = null,
  onFloat,
  empty = false,
  sheet = "half",
  onSheet,
  locked = false,
  preview,
  hiddenSteps = 0,
}: ConversationFlowProps) {
  const conversationId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  // Only a phone's sheet retracts: a desktop window is always open.
  const shut = phone && collapsed;
  // A retracted sheet hides the history: focus inside it moves to the sheet's handle rather than being lost.
  useEffect(() => {
    const history = historyRef.current;
    if (shut && history?.contains(document.activeElement)) handleRef.current?.focus({ preventScroll: true });
  }, [shut]);

  // Desktop window. Its room is the world area it floats over (the parent), measured as it changes; the box is the
  // person's, kept inside that room. A drag or a resize writes the box straight onto the window (no re-render per
  // pixel) and settles once, through onFloat.
  const [room, setRoom] = useState<Room | null>(null);
  useLayoutEffect(() => {
    const parent = rootRef.current?.parentElement;
    if (phone || !parent) return;
    const measure = () => {
      const box = parent.getBoundingClientRect();
      // A hidden page has no size: keep the last room rather than squeezing the window to nothing.
      if (box.width > 0 && box.height > 0) setRoom((was) => was && was.w === Math.round(box.width) && was.h === Math.round(box.height) ? was : { w: Math.round(box.width), h: Math.round(box.height) });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(parent);
    return () => watch.disconnect();
  }, [phone]);
  const box = room ? clampFloat(float ?? defaultFloat(room), room) : null;
  const boxRef = useRef(box);
  boxRef.current = box;
  const roomRef = useRef(room);
  roomRef.current = room;
  /** A window held to a side and reaching the foot of the world keeps the board's bottom row (its history slider) out
      from under it: the room it takes is given to the world as --flow-clear-left or --flow-clear-right (and the work
      rail's, --flow-held-right). */
  const clear = (root: HTMLElement, next: FloatBox | null) => {
    const parent = root.parentElement;
    const at = roomRef.current;
    if (!parent) return;
    const low = !!next && !!at && next.y + next.h >= at.h - 120;
    for (const side of ["left", "right"] as const) {
      if (low && next!.snap === side) parent.style.setProperty(`--flow-clear-${side}`, `${next!.w + FLOAT_GAP}px`);
      else parent.style.removeProperty(`--flow-clear-${side}`);
    }
    // The work rail stands on the right: a window held there, at any height, moves it to the window's left.
    if (next?.snap === "right") parent.style.setProperty("--flow-held-right", `${next.w + FLOAT_GAP}px`);
    else parent.style.removeProperty("--flow-held-right");
  };
  /* The box is the room the window may take; the window itself stands on the box's foot and is only as tall as what
     has been said (its max-height is the box's), so a short chat leaves no empty glass above it. While it is being
     sized it is drawn at the box's whole height, so the person sees the height they are choosing, and once they have
     chosen one (`sized`) it keeps it: letting go must not shrink it back to the messages. */
  const place = (root: HTMLElement, next: FloatBox) => {
    const at = roomRef.current;
    if (!at) return;
    root.style.left = `${next.x}px`;
    root.style.width = `${next.w}px`;
    root.style.bottom = `${at.h - next.y - next.h}px`;
    root.style.maxHeight = `${next.h}px`;
    root.style.height = next.sized || (gesture.current && gesture.current.kind !== "move") ? `${next.h}px` : "auto";
    if (next.snap) root.dataset.snap = next.snap; else delete root.dataset.snap;
    if (next.sized) root.dataset.sized = ""; else delete root.dataset.sized;
    clear(root, next);
  };
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || phone) return;
    clear(root, box);
    return () => clear(root, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clear only reads refs and the DOM; the box is its value
  }, [phone, box?.x, box?.y, box?.w, box?.h, box?.snap]);
  /* The window lies over the board and never resizes it, so the board cannot tell when the room beside or above the
     window has changed. It is told (SHEET_MOVED, a beat after the change settles): when the window is put somewhere
     else or sized, and when it grows or shrinks with what is said in it. The board frames the work again only if the
     person has not taken the camera. */
  const telling = useRef(0);
  const tellBoard = () => {
    window.clearTimeout(telling.current);
    telling.current = window.setTimeout(() => window.dispatchEvent(new Event(SHEET_MOVED)), 180);
  };
  useEffect(() => {
    const root = rootRef.current;
    if (phone || !root || typeof ResizeObserver === "undefined") return;
    let first = true;
    const watch = new ResizeObserver(() => { if (first) { first = false; return; } if (!gesture.current) tellBoard(); });
    watch.observe(root);
    return () => { watch.disconnect(); window.clearTimeout(telling.current); };
  }, [phone]);
  const gesture = useRef<{ kind: "move" | Edge; x: number; y: number; start: FloatBox; live: FloatBox } | null>(null);
  const beginGesture = (kind: "move" | Edge) => (event: PointerEvent<HTMLElement>) => {
    const root = rootRef.current;
    const start = boxRef.current;
    if (!root || !start || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { kind, x: event.clientX, y: event.clientY, start, live: start };
    root.dataset.moving = kind === "move" ? "move" : "size";
  };
  const moveGesture = (event: PointerEvent<HTMLElement>) => {
    const state = gesture.current;
    const root = rootRef.current;
    const at = roomRef.current;
    if (!state || !root || !at) return;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    // Moved, it is free until the magnet takes it: near a side it is pulled onto that side and held there.
    const next = state.kind === "move"
      ? magnet({ ...state.start, x: state.start.x + dx, y: state.start.y + dy, snap: null }, at)
      : resizeFloat(state.start, state.kind, dx, dy, at);
    state.live = next;
    place(root, next);
  };
  const endGesture = (event: PointerEvent<HTMLElement>) => {
    const state = gesture.current;
    gesture.current = null;
    const root = rootRef.current;
    if (root) { delete root.dataset.moving; root.style.height = state?.live.sized ? `${state.live.h}px` : "auto"; }
    if (!state) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const moved = state.live.x !== state.start.x || state.live.y !== state.start.y || state.live.w !== state.start.w || state.live.h !== state.start.h;
    if (moved) { onFloat?.(state.live); tellBoard(); }
  };
  /** The arrow keys on Move move the window, and on the top-right pull size it (up is taller, right is wider); Home and
      End on Move put it on the left or right. */
  const keyFloat = (kind: "move" | "ne") => (event: KeyboardEvent<HTMLElement>) => {
    const current = boxRef.current;
    const at = roomRef.current;
    if (!current || !at) return;
    const step = event.shiftKey ? FLOAT_STEP * 4 : FLOAT_STEP;
    const dx = event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0;
    const dy = event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0;
    let next: FloatBox | null = null;
    if (kind === "move" && (event.key === "Home" || event.key === "End")) next = clampFloat({ ...current, snap: event.key === "Home" ? "left" : "right" }, at);
    // A key's step is shorter than the magnet's reach, so the magnet would never let a held window go: by keyboard it
    // is free the moment it steps off a side, and held again only when it is stepped right up against one.
    else if (dx || dy) next = kind === "move" ? nudgeFloat(current, dx, dy, at) : resizeFloat(current, "ne", dx, dy, at);
    if (!next) return;
    event.preventDefault();
    onFloat?.(next);
    tellBoard();
  };

  // Phone sheet: Canvas only (the retracted conversation), half, full. A tap steps up and wraps to the canvas;
  // a drag or the arrow keys move one level. Lowering to the canvas goes through the same refusal as Retract.
  const level = shut ? 0 : sheet === "full" ? 2 : 1;
  // The sheet glides between heights. The new level is laid out at once; the root's own height is then animated from
  // where it was, so the conversation slides rather than snaps. While it moves (a glide or a finger) the sheet lies
  // over a canvas that never changes size (`data-gliding`, ConversationFlow.css), so only the sheet is
  // laid out each frame: resizing the canvas and the editors in it every frame is what made the sheet stutter.
  const lastBox = useRef<DOMRect | null>(null);
  const restBox = useRef<number | null>(null);
  const gliding = useRef(false);
  const sheetDrag = useRef<SheetDrag | null>(null);
  const geometry = useRef<SheetGeometry | null>(null);
  /** Redraws the faded top edge of the message list; it waits while the sheet moves (see the effect that sets it). */
  const refreshEdge = useRef<() => void>(() => undefined);
  /** The sheet starts to move: measure its surroundings once, for every frame of the move. */
  const startMoving = (root: HTMLElement) => {
    const parent = root.parentElement;
    const parentH = parent?.getBoundingClientRect().height ?? 0;
    const half = Math.max(parentH * 0.55, Math.min(parentH, 320));
    const entry = root.querySelector<HTMLElement>(".conversation-flow__entry-area")?.offsetHeight ?? 90;
    geometry.current = { parentH, half, min: Math.min(restBox.current ?? (HANDLE_H + entry + SHEET_PAD), half) };
    gliding.current = true;
    root.dataset.gliding = "";
  };
  /** The sheet lies over the canvas, so the board never changes size with it: once the sheet is at rest the board is
      told how much of its foot is covered (--flow-sheet-h keeps its bottom row above the sheet) and that the room
      above has changed (SHEET_MOVED: it frames the work again). */
  const settledAt = useRef(-1);
  const settled = (root: HTMLElement, moved = false) => {
    const parent = root.parentElement;
    if (!parent) return;
    const cover = Math.round(Math.max(0, parent.getBoundingClientRect().bottom - root.getBoundingClientRect().top));
    // After a move the board is always told, even back at the height it last heard of: it framed work in the room
    // there was while the sheet was on its way.
    if (!moved && cover === settledAt.current) return;
    settledAt.current = cover;
    parent.style.setProperty("--flow-sheet-h", `${cover}px`);
    window.dispatchEvent(new Event(SHEET_MOVED));
  };
  const stopMoving = (root: HTMLElement) => {
    gliding.current = false;
    delete root.dataset.gliding;
    root.style.removeProperty("height");
    geometry.current = null;
    refreshEdge.current();
    settled(root, true);
  };
  /** Animates the root from a box it was in to the one it is in now. Returns a way to stop it. */
  const glide = (root: HTMLElement, from: { height: number }, to: { height: number }) => {
    if (Math.abs(from.height - to.height) < 2 || typeof root.animate !== "function") return undefined;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;
    const style = getComputedStyle(root);
    const duration = (parseFloat(style.getPropertyValue("--dur-3")) || 0.4) * 1000;
    const easing = style.getPropertyValue("--ease").trim() || "ease";
    startMoving(root);
    const run = root.animate([{ height: `${from.height}px` }, { height: `${to.height}px` }], { duration, easing });
    follow();
    const done = () => {
      // A cancelled run reports late; by then a newer one (or a finger) may own the sheet.
      if (sheetDrag.current?.active) return;
      if (root.getAnimations().some((a) => a !== run && a.playState === "running")) return;
      stopMoving(root);
      lastBox.current = root.getBoundingClientRect();
    };
    run.onfinish = done;
    run.oncancel = done;
    return () => run.cancel();
  };
  // How far open the sheet is, as two numbers on the root for the stylesheet: p runs 0 to 1 from canvas only to half
  // (the preview gives way to the messages), q from half to full (the steps fade in and the list sets off from the
  // top). At rest they follow the level; while the sheet moves they follow its height, frame by frame.
  const levelRef = useRef(level);
  levelRef.current = level;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const frame = useRef(0);
  const paintDone = (root: HTMLElement) => {
    const at = levelRef.current;
    root.style.setProperty("--flow-p", at === 0 ? "0" : "1");
    root.style.setProperty("--flow-q", at === 2 ? "1" : "0");
  };
  const paint = (root: HTMLElement) => {
    const at = geometry.current;
    if (!at) return;
    const { parentH, half, min } = at;
    // Every read comes before every write, so a frame lays the sheet out once, not once per measurement.
    const h = sheetDrag.current?.active ? sheetDrag.current.h : root.getBoundingClientRect().height;
    const list = root.querySelector<HTMLElement>(".thread");
    const room = list ? list.scrollHeight - list.clientHeight : 0;
    const p = half > min ? Math.max(0, Math.min(1, (h - min) / (half - min))) : 1;
    const q = parentH > half ? Math.max(0, Math.min(1, (h - half) / (parentH - half))) : 0;
    root.style.setProperty("--flow-p", p.toFixed(3));
    root.style.setProperty("--flow-q", q.toFixed(3));
    // Messages stay on the newest while the sheet opens to half, and slide to the oldest as it opens to full.
    if (list && room > 0) list.scrollTop = room * (1 - q);
  };
  const follow = () => {
    cancelAnimationFrame(frame.current);
    const tick = () => {
      const root = rootRef.current;
      if (!root) return;
      if (gliding.current) { paint(root); frame.current = requestAnimationFrame(tick); } else paintDone(root);
    };
    frame.current = requestAnimationFrame(tick);
  };
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !phone) return;
    if (!gliding.current) paintDone(root);
  }, [phone, level]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !phone || typeof ResizeObserver === "undefined") return;
    const parent = root.parentElement;
    const watch = new ResizeObserver(() => {
      if (gliding.current) return;
      lastBox.current = root.getBoundingClientRect();
      if (root.classList.contains("is-collapsed")) restBox.current = lastBox.current.height;
      settled(root);
    });
    watch.observe(root);
    return () => {
      watch.disconnect();
      settledAt.current = -1;
      parent?.style.removeProperty("--flow-sheet-h");
      window.dispatchEvent(new Event(SHEET_MOVED));
    };
  }, [phone]);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !phone) { lastBox.current = null; return; }
    const from = lastBox.current;
    const to = root.getBoundingClientRect();
    lastBox.current = to;
    if (!from) return;
    return glide(root, from, to);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- glide only reads refs and the DOM
  }, [phone, level]);

  const setLevel = (target: number) => {
    const next = Math.max(0, Math.min(2, target));
    if (next === level) return;
    if (next === 0) { onToggle?.(); return; }
    if (shut) onToggle?.();
    onSheet?.(next === 2 ? "full" : "half");
  };
  const cycle = () => setLevel(level === 2 ? (locked ? 1 : 0) : level + 1);
  /** The heights a finger can settle the sheet at: canvas only, half, full (the first is out of reach while locked). */
  const restHeights = (parentH: number) => {
    const half = Math.max(parentH * 0.55, Math.min(parentH, 320));
    // Retracted, the sheet is its handle and the entry strip. Before it has been seen retracted, that is measured.
    const entry = rootRef.current?.querySelector<HTMLElement>(".conversation-flow__entry-area")?.offsetHeight ?? 90;
    const retracted = restBox.current ?? (HANDLE_H + entry + SHEET_PAD);
    return [locked ? half : Math.min(retracted, half), half, parentH];
  };
  const beginSheetDrag = (y: number) => {
    const root = rootRef.current;
    if (!root) return;
    const box = root.getBoundingClientRect();
    sheetDrag.current = {
      y, lastY: y, lastT: performance.now(), speed: 0, active: false,
      startH: box.height, h: box.height,
      parentH: root.parentElement?.getBoundingClientRect().height ?? box.height,
    };
  };
  const dragSheet = (y: number) => {
    const root = rootRef.current;
    const state = sheetDrag.current;
    if (!root || !state) return;
    const heights = restHeights(state.parentH);
    if (!state.active) {
      if (Math.abs(y - state.y) < SHEET_SLOP) return;
      state.active = true;
      // Measured from here, so the sheet does not jump by the slop the finger travelled before it took hold.
      state.y = y;
      // The finger owns the height now: stop any glide and let the conversation draw while it is pulled open.
      const box = root.getBoundingClientRect();
      for (const run of root.getAnimations()) run.cancel();
      state.startH = box.height;
      startMoving(root);
      follow();
    }
    const h = Math.max(heights[0], Math.min(state.parentH, state.startH - (y - state.y)));
    root.style.height = `${h}px`;
    const now = performance.now();
    state.speed = (y - state.lastY) / Math.max(1, now - state.lastT);
    state.lastY = y;
    state.lastT = now;
    state.h = h;
  };
  const endSheetGesture = () => {
    const root = rootRef.current;
    const state = sheetDrag.current;
    sheetDrag.current = null;
    if (!root || !state) return;
    if (!state.active) return;
    // Let go: settle on the nearest height, carried a little further by a flick, gliding from where the finger left it.
    const box = root.getBoundingClientRect();
    stopMoving(root);
    follow();
    const heights = restHeights(state.parentH);
    const reach = state.h - state.speed * 180;
    let target = 0;
    heights.forEach((h, i) => { if (Math.abs(h - reach) < Math.abs(heights[target] - reach)) target = i; });
    if (target === level) {
      glide(root, box, root.getBoundingClientRect());
    } else {
      lastBox.current = box;
      setLevel(target);
    }
  };
  // The sheet is split down the middle. A swipe on its left half only ever moves the sheet (anywhere but where you
  // type): it never scrolls, not even when the sheet cannot follow (up once it is full, down once it is retracted),
  // so every move there is claimed from the first one, before the browser can start a pan of its own. On its right
  // half a swipe only scrolls the conversation and never moves the sheet. Moves are applied once per frame, not once
  // per touch event: a phone reports touches faster than it draws. Touch events, not pointer events, because a pan
  // the browser takes up is cancelled from under pointer events.
  const touchRef = useRef({ begin: beginSheetDrag, drag: dragSheet, end: endSheetGesture });
  touchRef.current = { begin: beginSheetDrag, drag: dragSheet, end: endSheetGesture };
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !phone) return;
    let from = 0;
    let mode: "idle" | "pending" | "drag" = "idle";
    let pendingY: number | null = null;
    let tick = 0;
    const flush = () => {
      tick = 0;
      if (pendingY == null) return;
      const y = pendingY;
      pendingY = null;
      touchRef.current.drag(y);
    };
    const onStart = (event: TouchEvent) => {
      const target = event.target as HTMLElement | null;
      mode = "idle";
      if (event.touches.length !== 1 || !target || target.closest(NO_SHEET_DRAG)) return;
      if (!onSheetSide(root, event.touches[0].clientX)) return;
      from = event.touches[0].clientY;
      mode = "pending";
    };
    const onMove = (event: TouchEvent) => {
      if (mode === "idle") return;
      if (event.cancelable) event.preventDefault();
      const y = event.touches[0].clientY;
      if (mode === "pending") {
        if (Math.abs(y - from) < 3) return;
        mode = "drag";
        touchRef.current.begin(from);
      }
      pendingY = y;
      if (!tick) tick = requestAnimationFrame(flush);
    };
    const onEnd = () => {
      if (mode === "drag") {
        cancelAnimationFrame(tick);
        flush();
        touchRef.current.end();
      }
      mode = "idle";
    };
    root.addEventListener("touchstart", onStart, { passive: true });
    root.addEventListener("touchmove", onMove, { passive: false });
    root.addEventListener("touchend", onEnd);
    root.addEventListener("touchcancel", onEnd);
    return () => {
      cancelAnimationFrame(tick);
      root.removeEventListener("touchstart", onStart);
      root.removeEventListener("touchmove", onMove);
      root.removeEventListener("touchend", onEnd);
      root.removeEventListener("touchcancel", onEnd);
    };
  }, [phone]);
  const keySheet = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowUp") setLevel(level + 1);
    else if (event.key === "ArrowDown") setLevel(level - 1);
    else if (event.key === "Home") setLevel(0);
    else if (event.key === "End") setLevel(2);
    else if (event.key === "Enter" || event.key === " ") cycle();
    else return;
    event.preventDefault();
  };
  useEffect(() => {
    const history = historyRef.current;
    if (!history) return;
    let frame = 0;
    let messages: HTMLElement[] = [];
    let dirty = true;
    const faded = new Set<HTMLElement>();
    const update = () => {
      frame = 0;
      // While the sheet moves the list is scrolled every frame; the fade waits for it to settle (stopMoving).
      if (gliding.current) return;
      if (history.getAttribute("aria-hidden") !== "true") {
        history.style.setProperty("--flow-history-height", `${history.getBoundingClientRect().height}px`);
      }
      const thread = history.querySelector<HTMLElement>(".thread");
      if (!thread) return;
      if (dirty) {
        messages = Array.from(thread.querySelectorAll<HTMLElement>(".msg"));
        dirty = false;
      }
      const edge = thread.getBoundingClientRect().top;
      // Messages follow DOM order. Find the live top edge without measuring every old turn.
      let low = 0;
      let high = messages.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (messages[middle].getBoundingClientRect().bottom <= edge) low = middle + 1;
        else high = middle;
      }
      const next = new Set<HTMLElement>();
      for (let index = low; index < messages.length; index += 1) {
        const message = messages[index];
        const rect = message.getBoundingClientRect();
        if (rect.top >= edge + 36) break;
        // Fade only the bubble's top strip, never a long reply's entire visible body.
        // A focused control or fixed overlay stays unmasked, including its focus ring.
        if (message.contains(document.activeElement)
          || Array.from(message.querySelectorAll("*")).some((node) => getComputedStyle(node).position === "fixed")) continue;
        const start = edge - rect.top;
        message.style.setProperty("--flow-edge-mask", `linear-gradient(to bottom, transparent ${start}px, var(--text) ${start + 36}px)`);
        next.add(message);
      }
      for (const message of faded) {
        if (!next.has(message)) message.style.removeProperty("--flow-edge-mask");
      }
      faded.clear();
      for (const message of next) faded.add(message);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    refreshEdge.current = schedule;
    const mutation = new MutationObserver(() => {
      dirty = true;
      schedule();
    });
    mutation.observe(history, { childList: true, subtree: true, characterData: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(history);
    history.addEventListener("scroll", schedule, true);
    history.addEventListener("focusin", schedule);
    history.addEventListener("focusout", schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      mutation.disconnect();
      resize.disconnect();
      history.removeEventListener("scroll", schedule, true);
      history.removeEventListener("focusin", schedule);
      history.removeEventListener("focusout", schedule);
      refreshEdge.current = () => undefined;
      for (const message of faded) message.style.removeProperty("--flow-edge-mask");
      history.style.removeProperty("--flow-history-height");
    };
  }, []);

  const navigation = workNavigation != null && (
    <div className="conversation-flow__work-navigation" role="group" aria-label="Workspace navigation">
      {workNavigation}
    </div>
  );
  const floatStyle: CSSProperties | undefined = phone || !box || !room ? undefined
    : { left: box.x, bottom: room.h - box.y - box.h, width: box.w, maxHeight: box.h, top: "auto", height: box.sized ? box.h : "auto" };

  return (
    <>
    <div
      ref={rootRef}
      className={`conversation-flow${shut ? " is-collapsed" : ""}${empty ? " is-empty" : ""}${phone ? " is-sheet" : " is-float"}${phone && !shut ? ` is-${sheet}` : ""}`}
      style={floatStyle}
      data-snap={!phone && box?.snap ? box.snap : undefined}
      data-sized={!phone && box?.sized ? "" : undefined}
    >
      {phone ? (
        <div
          className="conversation-flow__handle"
          ref={handleRef}
          role="slider"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label="Conversation size"
          aria-valuemin={0}
          aria-valuemax={2}
          aria-valuenow={level}
          aria-valuetext={LEVELS[level]}
          onKeyDown={keySheet}
          onPointerDown={(event) => {
            const root = rootRef.current;
            if (!root || !onSheetSide(root, event.clientX)) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            beginSheetDrag(event.clientY);
          }}
          onPointerMove={(event) => dragSheet(event.clientY)}
          onPointerUp={endSheetGesture}
          onPointerCancel={endSheetGesture}
        >
          <span aria-hidden="true" />
        </div>
      ) : (
        <>
          <button
            className="conversation-flow__move"
            type="button"
            aria-label="Move conversation"
            title="Move (drag; double-click to put it back)"
            aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home End"
            onKeyDown={keyFloat("move")}
            onPointerDown={beginGesture("move")}
            onPointerMove={moveGesture}
            onPointerUp={endGesture}
            onPointerCancel={endGesture}
            onDoubleClick={() => onFloat?.(null)}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
              <path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" />
            </svg>
          </button>
          {EDGES.map((edge) => (
            <div
              key={edge}
              className="conversation-flow__size"
              data-edge={edge}
              {...(edge === "ne"
                ? { role: "separator", tabIndex: 0, "aria-label": "Resize conversation", title: "Resize (drag)", "aria-valuenow": box?.w, onKeyDown: keyFloat("ne") }
                : { "aria-hidden": true })}
              onPointerDown={beginGesture(edge)}
              onPointerMove={moveGesture}
              onPointerUp={endGesture}
              onPointerCancel={endGesture}
            >
              {edge === "ne" && (
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                  <path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" />
                </svg>
              )}
            </div>
          ))}
        </>
      )}
      <div className="conversation-flow__column">
        <section
          className="conversation-flow__conversation"
          id={conversationId}
          ref={historyRef}
          aria-label={conversationLabel}
          aria-hidden={shut || undefined}
          {...(shut ? { inert: "" } : {})}
        >
          {conversation}
        </section>
        <div className="conversation-flow__entry-area">
          {phone && onToggle && preview && preview.length > 0 && (
            <button
              className="conversation-flow__preview"
              type="button"
              onClick={onToggle}
              aria-controls={conversationId}
              tabIndex={shut ? 0 : -1}
              aria-label={`Open the conversation. ${preview.map((line) => `${line.who}: ${line.text}`).join(" ")}`}
            >
              {preview.map((line, index) => (
                <span className="conversation-flow__preview-line" key={index} aria-hidden="true">
                  <i className={`conversation-flow__who is-${line.who === "You" ? "you" : "agent"}`}>{line.who === "You" ? <IconUser size={11} /> : <AutoraMark size={16} />}</i>
                  {line.text}
                </span>
              ))}
              {hiddenSteps > 0 && (
                <span className="conversation-flow__preview-more" aria-hidden="true">
                  {hiddenSteps} {hiddenSteps === 1 ? "step" : "steps"} and memory notes hidden · tap to see
                </span>
              )}
            </button>
          )}
          {todos != null && <div className="conversation-flow__todos">{todos}</div>}
          <div className="conversation-flow__entry">{entry}</div>
        </div>
      </div>
      {phone && navigation}
    </div>
    {!phone && navigation}
    </>
  );
}

import { useEffect, useId, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { PANEL_DEFAULT, PANEL_MAX, PANEL_MIN, PANEL_STEP, clampPanelWidth, type PreviewLine, type Sheet } from "./chatLayout";
import "./ConversationFlow.css";

interface ConversationFlowProps {
  conversation: ReactNode;
  entry: ReactNode;
  todos?: ReactNode;
  workNavigation?: ReactNode;
  conversationLabel?: string;
  collapsed?: boolean;
  onToggle?: () => void;
  /** A phone: the conversation is a bottom sheet under the canvas instead of a panel beside it. */
  phone?: boolean;
  /** Desktop panel width in pixels, and the way to change it (called when a drag or key press settles). */
  width?: number;
  onWidth?: (width: number) => void;
  /** Phone sheet height when open, and the way to change it. */
  sheet?: Sheet;
  onSheet?: (sheet: Sheet) => void;
  /** A question or permission is waiting: the sheet may not be lowered below half. */
  locked?: boolean;
  /** The last thing or two said, shown on a phone while the sheet is retracted; a tap opens the sheet. */
  preview?: readonly PreviewLine[];
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
  startH: number; h: number; wasFull: boolean; parentH: number;
}

const LEVELS = ["Canvas only", "Half", "Full"] as const;

/** The one glyph for showing and retracting the conversation: a speech bubble, the same open or retracted. */
function ConversationIcon() {
  return (
    <svg className="conversation-flow__icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />
    </svg>
  );
}

/** Hosts the live Thread and native composer without taking ownership of either: docked beside the canvas on a
    desktop, a bottom sheet under it on a phone. The canvas is resized around it, never covered. */
export function ConversationFlow({
  conversation,
  entry,
  todos,
  workNavigation,
  conversationLabel = "Conversation with Autora",
  collapsed = false,
  onToggle,
  phone = false,
  width = PANEL_DEFAULT,
  onWidth,
  sheet = "half",
  onSheet,
  locked = false,
  preview,
}: ConversationFlowProps) {
  const conversationId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const edgeRef = useRef<HTMLButtonElement>(null);
  // Where focus goes once the toggle that was pressed has been hidden by the change it made.
  const restoreFocus = useRef<"toggle" | "edge" | null>(null);
  useEffect(() => {
    const history = historyRef.current;
    if (!history) return;
    const wanted = restoreFocus.current;
    restoreFocus.current = null;
    if (collapsed && (wanted === "edge" || history.contains(document.activeElement))) {
      (phone ? toggleRef : edgeRef).current?.focus({ preventScroll: true });
    } else if (!collapsed && wanted === "toggle") toggleRef.current?.focus({ preventScroll: true });
  }, [collapsed, phone]);

  // Desktop width: a drag writes the variable straight onto the panel (no re-render per pixel) and settles once.
  const drag = useRef<{ x: number; start: number; live: number } | null>(null);
  const roomNow = () => (typeof window === "undefined" ? Infinity : window.innerWidth);
  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (!root || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = root.getBoundingClientRect().width;
    drag.current = { x: event.clientX, start, live: start };
  };
  const moveResize = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    state.live = clampPanelWidth(state.start + (state.x - event.clientX), roomNow());
    rootRef.current?.style.setProperty("--flow-panel-w", `${state.live}px`);
  };
  const endResize = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    drag.current = null;
    if (!state) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    onWidth?.(state.live);
  };
  const keyResize = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? PANEL_STEP * 4 : PANEL_STEP;
    // The panel's edge is on its left: moving it left makes the panel wider.
    const next = event.key === "ArrowLeft" ? width + step
      : event.key === "ArrowRight" ? width - step
      : event.key === "Home" ? PANEL_MIN
      : event.key === "End" ? PANEL_MAX
      : null;
    if (next == null) return;
    event.preventDefault();
    onWidth?.(clampPanelWidth(next, roomNow()));
  };

  // Phone sheet: Canvas only (the retracted conversation), half, full. A tap steps up and wraps to the canvas;
  // a drag or the arrow keys move one level. Lowering to the canvas goes through the same refusal as Retract.
  const level = collapsed ? 0 : sheet === "full" ? 2 : 1;
  // The sheet glides between heights. The new level is laid out at once (the canvas resizes to it); the root's own
  // height is then animated from where it was, so the conversation slides rather than snaps. Full lies over the canvas,
  // so going to or from it moves the top edge instead.
  const lastBox = useRef<DOMRect | null>(null);
  const restBox = useRef<number | null>(null);
  const gliding = useRef(false);
  const sheetDrag = useRef<SheetDrag | null>(null);
  /** Animates the root from a box it was in to the one it is in now. Returns a way to stop it. */
  const glide = (root: HTMLElement, from: { top: number; height: number }, to: { height: number }, toFull: boolean) => {
    if (Math.abs(from.height - to.height) < 2 || typeof root.animate !== "function") return undefined;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;
    const style = getComputedStyle(root);
    const duration = (parseFloat(style.getPropertyValue("--dur-3")) || 0.4) * 1000;
    const easing = style.getPropertyValue("--ease").trim() || "ease";
    const parentTop = root.parentElement?.getBoundingClientRect().top ?? 0;
    const frames = toFull
      ? [{ top: `${from.top - parentTop}px` }, { top: "0px" }]
      : [{ flexBasis: `${from.height}px` }, { flexBasis: `${to.height}px` }];
    gliding.current = true;
    root.dataset.gliding = "";
    const run = root.animate(frames, { duration, easing });
    const done = () => {
      // A cancelled run reports late; by then a newer one (or a finger) may own the sheet.
      if (sheetDrag.current?.active) return;
      if (root.getAnimations().some((a) => a !== run && a.playState === "running")) return;
      gliding.current = false;
      delete root.dataset.gliding;
      lastBox.current = root.getBoundingClientRect();
    };
    run.onfinish = done;
    run.oncancel = done;
    return () => run.cancel();
  };
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !phone || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => {
      if (gliding.current) return;
      lastBox.current = root.getBoundingClientRect();
      if (root.classList.contains("is-collapsed")) restBox.current = lastBox.current.height;
    });
    watch.observe(root);
    return () => watch.disconnect();
  }, [phone]);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !phone) { lastBox.current = null; return; }
    const from = lastBox.current;
    const to = root.getBoundingClientRect();
    lastBox.current = to;
    if (!from) return;
    return glide(root, from, to, level === 2);
  }, [phone, level]);

  const setLevel = (target: number) => {
    const next = Math.max(0, Math.min(2, target));
    if (next === level) return;
    if (next === 0) { onToggle?.(); return; }
    if (collapsed) onToggle?.();
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
      startH: box.height, h: box.height, wasFull: level === 2,
      parentH: root.parentElement?.getBoundingClientRect().height ?? box.height,
    };
  };
  const dragSheet = (y: number) => {
    const root = rootRef.current;
    const state = sheetDrag.current;
    if (!root || !state) return;
    const moved = y - state.y;
    if (!state.active) {
      if (Math.abs(moved) < SHEET_SLOP) return;
      state.active = true;
      // The finger owns the height now: stop any glide and let the conversation draw while it is pulled open.
      gliding.current = true;
      root.dataset.gliding = "";
      for (const run of root.getAnimations()) run.cancel();
    }
    const heights = restHeights(state.parentH);
    const h = Math.max(heights[0], Math.min(state.parentH, state.startH - moved));
    if (state.wasFull) root.style.top = `${state.parentH - h}px`;
    else root.style.flexBasis = `${h}px`;
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
    root.style.removeProperty("flex-basis");
    root.style.removeProperty("top");
    gliding.current = false;
    delete root.dataset.gliding;
    const heights = restHeights(state.parentH);
    const reach = state.h - state.speed * 180;
    let target = 0;
    heights.forEach((h, i) => { if (Math.abs(h - reach) < Math.abs(heights[target] - reach)) target = i; });
    if (target === level) {
      glide(root, box, root.getBoundingClientRect(), level === 2);
    } else {
      lastBox.current = box;
      setLevel(target);
    }
  };
  // A drag may start anywhere in the sheet but where you type. The message list still scrolls: a swipe on it moves the
  // sheet only when it has nothing to scroll that way (up, until the sheet is full; down, once it is at its top).
  // Touch events, not pointer events, because a pan the browser takes up is cancelled from under pointer events.
  const touchRef = useRef({ begin: beginSheetDrag, drag: dragSheet, end: endSheetGesture, level });
  touchRef.current = { begin: beginSheetDrag, drag: dragSheet, end: endSheetGesture, level };
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !phone) return;
    let from = 0;
    let mode: "idle" | "pending" | "drag" | "scroll" = "idle";
    let scroller: HTMLElement | null = null;
    const scrollerOf = (start: HTMLElement) => {
      for (let el: HTMLElement | null = start; el && el !== root; el = el.parentElement) {
        const overflow = getComputedStyle(el).overflowY;
        if ((overflow === "auto" || overflow === "scroll") && el.scrollHeight > el.clientHeight + 1) return el;
      }
      return null;
    };
    const onStart = (event: TouchEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.touches.length !== 1 || !target || target.closest(NO_SHEET_DRAG) || target.closest(".conversation-flow__handle")) { mode = "idle"; return; }
      from = event.touches[0].clientY;
      scroller = scrollerOf(target);
      mode = "pending";
    };
    const onMove = (event: TouchEvent) => {
      if (mode === "idle" || mode === "scroll") return;
      const y = event.touches[0].clientY;
      if (mode === "pending") {
        const moved = y - from;
        if (Math.abs(moved) < 3) return;
        const takes = !scroller || (moved < 0 ? touchRef.current.level < 2 : scroller.scrollTop <= 1);
        if (!takes) { mode = "scroll"; return; }
        mode = "drag";
        touchRef.current.begin(from);
      }
      if (event.cancelable) event.preventDefault();
      touchRef.current.drag(y);
    };
    const onEnd = () => {
      if (mode === "drag") touchRef.current.end();
      mode = "idle";
    };
    root.addEventListener("touchstart", onStart, { passive: true });
    root.addEventListener("touchmove", onMove, { passive: false });
    root.addEventListener("touchend", onEnd);
    root.addEventListener("touchcancel", onEnd);
    return () => {
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
      for (const message of faded) message.style.removeProperty("--flow-edge-mask");
      history.style.removeProperty("--flow-history-height");
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className={`conversation-flow${collapsed ? " is-collapsed" : ""}${phone ? " is-sheet" : " is-panel"}${phone && !collapsed ? ` is-${sheet}` : ""}`}
      style={{ "--flow-panel-w": `${width}px` } as CSSProperties}
    >
      {phone ? (
        <div
          className="conversation-flow__handle"
          role="slider"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label="Conversation size"
          aria-valuemin={0}
          aria-valuemax={2}
          aria-valuenow={level}
          aria-valuetext={LEVELS[level]}
          onKeyDown={keySheet}
          onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); beginSheetDrag(event.clientY); }}
          onPointerMove={(event) => dragSheet(event.clientY)}
          onPointerUp={endSheetGesture}
          onPointerCancel={endSheetGesture}
        >
          <span aria-hidden="true" />
        </div>
      ) : (
        <>
          {!collapsed && (
            <div
              className="conversation-flow__resize"
              role="separator"
              tabIndex={0}
              aria-orientation="vertical"
              aria-label="Resize conversation panel"
              aria-valuemin={PANEL_MIN}
              aria-valuemax={PANEL_MAX}
              aria-valuenow={width}
              onKeyDown={keyResize}
              onPointerDown={startResize}
              onPointerMove={moveResize}
              onPointerUp={endResize}
              onPointerCancel={endResize}
              onDoubleClick={() => onWidth?.(PANEL_DEFAULT)}
            />
          )}
          {onToggle && (
            <button
              className="conversation-flow__edge"
              type="button"
              ref={edgeRef}
              onClick={() => { restoreFocus.current = "toggle"; onToggle(); }}
              aria-expanded={!collapsed}
              aria-controls={conversationId}
              aria-label="Show conversation"
              tabIndex={collapsed ? 0 : -1}
            >
              <ConversationIcon />
            </button>
          )}
        </>
      )}
      <div className="conversation-flow__column">
        <section
          className="conversation-flow__conversation"
          id={conversationId}
          ref={historyRef}
          aria-label={conversationLabel}
          aria-hidden={collapsed || undefined}
          {...(collapsed ? { inert: "" } : {})}
        >
          {conversation}
        </section>
        <div className="conversation-flow__entry-area">
          {onToggle && (
            <button
              className="conversation-flow__toggle"
              type="button"
              ref={toggleRef}
              onClick={() => { if (!phone) restoreFocus.current = "edge"; onToggle(); }}
              aria-expanded={!collapsed}
              aria-controls={conversationId}
              aria-label={collapsed ? "Show conversation" : "Retract conversation"}
            >
              <ConversationIcon />
            </button>
          )}
          {phone && collapsed && onToggle && preview && preview.length > 0 && (
            <button
              className="conversation-flow__preview"
              type="button"
              onClick={() => { restoreFocus.current = "toggle"; onToggle(); }}
              aria-controls={conversationId}
              aria-label={`Open the conversation. ${preview.map((line) => `${line.who}: ${line.text}`).join(" ")}`}
            >
              {preview.map((line, index) => (
                <span className="conversation-flow__preview-line" key={index} aria-hidden="true">
                  <b>{line.who}</b> {line.text}
                </span>
              ))}
            </button>
          )}
          {todos != null && <div className="conversation-flow__todos">{todos}</div>}
          <div className="conversation-flow__entry">{entry}</div>
        </div>
      </div>
      {workNavigation != null && (
        <div className="conversation-flow__work-navigation" role="group" aria-label="Workspace navigation">
          {workNavigation}
        </div>
      )}
    </div>
  );
}

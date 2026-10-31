import { useEffect, useId, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { PANEL_DEFAULT, PANEL_MAX, PANEL_MIN, PANEL_STEP, clampPanelWidth, type Sheet } from "./chatLayout";
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
}

const LEVELS = ["Canvas only", "Half", "Full"] as const;

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
  const setLevel = (target: number) => {
    const next = Math.max(0, Math.min(2, target));
    if (next === level) return;
    if (next === 0) { onToggle?.(); return; }
    if (collapsed) onToggle?.();
    onSheet?.(next === 2 ? "full" : "half");
  };
  const cycle = () => setLevel(level === 2 ? (locked ? 1 : 0) : level + 1);
  const gesture = useRef<number | null>(null);
  const keySheet = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowUp") setLevel(level + 1);
    else if (event.key === "ArrowDown") setLevel(level - 1);
    else if (event.key === "Home") setLevel(0);
    else if (event.key === "End") setLevel(2);
    else if (event.key === "Enter" || event.key === " ") cycle();
    else return;
    event.preventDefault();
  };
  const endSheetGesture = (event: PointerEvent<HTMLDivElement>) => {
    const from = gesture.current;
    gesture.current = null;
    if (from == null) return;
    const moved = event.clientY - from;
    if (Math.abs(moved) < PANEL_STEP * 3) cycle();
    else setLevel(level + (moved < 0 ? 1 : -1));
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
          onPointerDown={(event) => { gesture.current = event.clientY; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerUp={endSheetGesture}
          onPointerCancel={() => { gesture.current = null; }}
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
              tabIndex={collapsed ? 0 : -1}
            >
              Show conversation
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
            >
              {collapsed ? "Show conversation" : "Retract conversation"}
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

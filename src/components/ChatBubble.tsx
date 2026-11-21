import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { AutoraMark } from "./AutoraMark";
import { glance } from "./ImmersiveChat";
import { IconX } from "./Icons";
import {
  BUBBLE_SLOP, closeTarget, loadBubble, overClose, placeBubble, saveBubble, settleBubble, type BubbleSpot, type Screen,
} from "../lib/bubble";

/**
 * Autora as a bubble, while a tool has the whole of a phone's screen (a window's Maximise on a phone: see the takeover
 * in panacea/Board.tsx). The tool is the screen; the conversation is this one round button the person can drag
 * anywhere, out of the way of what they are testing.
 *
 *  - A tap opens the conversation over the tool; another tap, or a tap on the tool, puts it away again.
 *  - What the agent says shows beside the bubble for a few seconds, so the work can be watched without opening it.
 *  - Dragged onto the close target at the foot of the screen, it ends full screen (as the window's Restore does).
 *
 * Drawn into the page's body, so no tool's frame or the board's transform can hold it in.
 */
const SHOWN_MS = 5200;

function measureScreen(probe: HTMLElement | null): Screen {
  const vv = window.visualViewport;
  const w = Math.round(vv?.width ?? window.innerWidth);
  const h = Math.round(vv?.height ?? window.innerHeight);
  // The notch and the home bar: the probe's padding is the screen's safe-area insets.
  const style = probe ? getComputedStyle(probe) : null;
  return { w, h, top: style ? parseFloat(style.paddingTop) || 0 : 0, bottom: style ? parseFloat(style.paddingBottom) || 0 : 0 };
}

export function ChatBubble({
  open, onToggle, onExit, busy, waiting, say,
}: {
  /** The conversation is open over the tool. */
  open: boolean;
  onToggle: () => void;
  /** Leave full screen: the tool goes back where it was. */
  onExit: () => void;
  /** The agent is at work. */
  busy: boolean;
  /** A question or a permission is waiting on the person. */
  waiting: boolean;
  /** What the agent last said, as written. */
  say: string;
}) {
  const probe = useRef<HTMLDivElement>(null);
  const [screen, setScreen] = useState<Screen>(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const [spot, setSpot] = useState<BubbleSpot>(loadBubble);
  /** Where the finger has it, while it is being dragged. */
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const press = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const dragged = useRef(false);

  useLayoutEffect(() => {
    const measure = () => setScreen((was) => {
      const next = measureScreen(probe.current);
      return was.w === next.w && was.h === next.h && was.top === next.top && was.bottom === next.bottom ? was : next;
    });
    measure();
    const vv = window.visualViewport;
    window.addEventListener("resize", measure);
    vv?.addEventListener("resize", measure);
    return () => { window.removeEventListener("resize", measure); vv?.removeEventListener("resize", measure); };
  }, []);

  // What the agent says, shown beside the bubble for a moment. What was said before the tool went full is not news.
  const [line, setLine] = useState("");
  const [shown, setShown] = useState(false);
  const [unread, setUnread] = useState(false);
  const seen = useRef(glance(say));
  useEffect(() => {
    const next = glance(say);
    if (!next || next === seen.current) return;
    // Wait for the words to settle: a reply being streamed would otherwise flash half a word.
    let hide = 0;
    const settle = window.setTimeout(() => {
      seen.current = next;
      setLine(next);
      setShown(true);
      setUnread(true);
      hide = window.setTimeout(() => setShown(false), SHOWN_MS);
    }, 450);
    return () => { window.clearTimeout(settle); window.clearTimeout(hide); };
  }, [say]);
  useEffect(() => { if (open) { setUnread(false); setShown(false); } }, [open]);

  // Open, it waits at the top of its side, out of the conversation's way; closed, it goes back where it was put.
  const rest = placeBubble(open ? { side: spot.side, at: 0 } : spot, screen);
  const at = drag ?? rest;
  const closing = drag !== null && overClose(drag.x, drag.y, screen);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    press.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: e.clientX - rest.x, oy: e.clientY - rest.y, moved: false };
    dragged.current = false;
    // Held from the press: a quick flick leaves the bubble before the first move arrives, and must still drag it.
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, [rest.x, rest.y]);
  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    if (!p.moved && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) < BUBBLE_SLOP) return;
    p.moved = true;
    setDrag({ x: e.clientX - p.ox, y: e.clientY - p.oy });
  }, []);
  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    press.current = null;
    if (!p || p.id !== e.pointerId || !p.moved) return;
    dragged.current = true;
    const x = e.clientX - p.ox;
    const y = e.clientY - p.oy;
    setDrag(null);
    if (overClose(x, y, screen)) { onExit(); return; }
    const next = settleBubble(x, y, screen);
    setSpot(next);
    saveBubble(next);
  }, [screen, onExit]);
  const onPointerCancel = useCallback(() => { press.current = null; setDrag(null); }, []);
  // A drag ends with a click on the button too: that one is not a tap.
  const onClick = useCallback(() => {
    if (dragged.current) { dragged.current = false; return; }
    onToggle();
  }, [onToggle]);

  const target = closeTarget(screen);
  const state = waiting ? "waiting" : busy ? "building" : "rest";
  return createPortal(
    <div className="chat-bubble-layer" ref={probe} data-side={spot.side}>
      {drag && (
        <span className={`chat-bubble-close${closing ? " is-over" : ""}`} style={{ left: target.x, top: target.y }} aria-hidden="true">
          <IconX size={20} />
        </span>
      )}
      {line && !open && !drag && (
        <button type="button" className={`chat-bubble-say${shown ? " is-on" : ""}`} tabIndex={shown ? 0 : -1}
          style={{ top: rest.y + 8, ...(spot.side === "left" ? { left: rest.x + 64 } : { right: screen.w - rest.x + 8 }) }}
          onClick={onToggle} aria-hidden={!shown || undefined}>
          {line}
        </button>
      )}
      <button
        type="button"
        className={`chat-bubble${open ? " is-open" : ""}${drag ? " is-dragging" : ""}${busy ? " is-busy" : ""}`}
        style={{ left: at.x, top: at.y }}
        aria-label={open ? "Close the conversation" : "Open the conversation with Autora"}
        aria-expanded={open}
        title={open ? "Back to the tool (drag to move)" : "Autora (drag to move, or onto the X to leave full screen)"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onClick={onClick}
      >
        {open ? <IconX size={22} /> : <AutoraMark size={30} state={state} />}
        {(unread || waiting) && !open && <i className="chat-bubble-dot" aria-hidden="true" />}
      </button>
    </div>,
    document.body,
  );
}

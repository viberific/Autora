import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { IconRotateCcw, IconRotateCw } from "../Icons";
import type { Step } from "./useCanvas";

/**
 * The history: Undo, Redo, and a track with a tick for every change (the person's grey, Autora's in the accent), to drag
 * back and forth through. Where the marker is, is the canvas shown.
 */
export function History({ past, future, onScrub, onUndo, onRedo }: {
  past: Step[];
  future: Step[];
  onScrub: (n: number) => void;
  onUndo: () => void;
  onRedo: () => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  // Every step in order: the past, then the future (kept newest-last in reverse).
  const steps = [...past, ...[...future].reverse()];
  const total = steps.length;
  const at = past.length;
  const pos = (i: number) => (total ? (i / total) * 100 : 100);
  const drag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!total) return;
    e.preventDefault();
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const to = (x: number) => onScrub(Math.round(Math.min(1, Math.max(0, (x - r.left) / r.width)) * total));
    el.setPointerCapture?.(e.pointerId);
    to(e.clientX);
    const move = (ev: PointerEvent) => to(ev.clientX);
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  return (
    <div className="pa-history" aria-label="History">
      <button type="button" className="pa-hbtn" onClick={onUndo} disabled={!past.length} aria-label="Undo" title={past.length ? `Undo: ${past.at(-1)!.label}` : "Undo"}><IconRotateCcw size={13} /></button>
      <div ref={track} className="pa-htrack" onPointerDown={drag} role="slider" aria-label="Changes" aria-valuemin={0} aria-valuemax={total} aria-valuenow={at}>
        {steps.map((s, i) => <i key={`${i}-${s.at}`} className={`pa-htick is-${s.by}${i >= at ? " is-ahead" : ""}`} style={{ left: `${pos(i + 1)}%` }} title={s.label} />)}
        <b className="pa-hmark" style={{ left: `${pos(at)}%` }} />
      </div>
      <button type="button" className="pa-hbtn" onClick={onRedo} disabled={!future.length} aria-label="Redo" title={future.length ? `Redo: ${future.at(-1)!.label}` : "Redo"}><IconRotateCw size={13} /></button>
    </div>
  );
}

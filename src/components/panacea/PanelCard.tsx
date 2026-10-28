import { memo, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Panel } from "../../lib/panacea/canvas";
import { IconPin, IconX } from "../Icons";
import { Atom } from "./Atoms";

export interface PanelActions {
  /** Pointer down on the title bar: a move begins (or Shift picks it). */
  grab: (panel: Panel, e: ReactPointerEvent<HTMLElement>) => void;
  /** Pointer down on the right edge: a resize begins. */
  widen: (panel: Panel, e: ReactPointerEvent<HTMLElement>) => void;
  pin: (panel: Panel) => void;
  close: (panel: Panel) => void;
  /** Not this: put it away and teach Panacea not to offer it. */
  notThis: (panel: Panel) => void;
  accept: (panel: Panel) => void;
  wave: (panel: Panel) => void;
  keep: (panel: Panel) => void;
  discard: (panel: Panel) => void;
  wake: (panel: Panel) => void;
}

const WHO: Record<Panel["by"], string> = { agent: "Autora placed it", person: "You placed it", rule: "It came with the work" };

/**
 * A panel on the canvas: a title bar to move it by, its ⓘ (why it is here, and Not this), a pin, ×, and the atoms. A
 * ghost (an offer) shows its reason with Add and Not now, and cannot be used until taken; a draft (a bespoke piece being
 * worked out) offers Keep in library and Discard; a dim one (the work moved on) wakes with a click.
 */
export const PanelCard = memo(function PanelCard({ panel, selected, fresh, offset, width, actions }: {
  panel: Panel;
  selected: boolean;
  fresh: boolean;
  /** While being dragged: how far it has moved, in canvas pixels. */
  offset: { dx: number; dy: number } | null;
  /** While being widened. */
  width: number | null;
  actions: PanelActions;
}) {
  const [why, setWhy] = useState(false);
  const ghost = panel.state === "ghost";
  const draft = panel.state === "draft";
  const dim = panel.state === "dim";
  const style = {
    left: panel.x,
    top: panel.y,
    width: width ?? panel.w,
    ...(panel.h ? { height: panel.h } : {}),
    ...(offset ? { transform: `translate(${offset.dx}px, ${offset.dy}px)` } : {}),
  };
  return (
    <div
      className={`pa-panel is-${panel.state}${selected ? " is-selected" : ""}${fresh ? " is-fresh" : ""}${offset ? " is-moving" : ""}${panel.pinned ? " is-pinned" : ""}`}
      data-panel={panel.id}
      style={style}
      onPointerDown={dim ? (e) => { e.stopPropagation(); actions.wake(panel); } : undefined}
      aria-label={`${panel.title}${ghost ? " (suggested)" : draft ? " (draft)" : dim ? " (faded)" : ""}`}
      role="group"
    >
      <header className="pa-head" onPointerDown={(e) => { if ((e.target as HTMLElement).closest("button")) return; actions.grab(panel, e); }}>
        <span className="pa-title">{panel.title}</span>
        {draft && <span className="pa-draft-tag">Draft</span>}
        <span className="pa-head-acts">
          <button type="button" data-act="why" className={why ? "is-on" : ""} aria-label="Why is this here?" aria-expanded={why} onClick={() => setWhy(!why)}>i</button>
          {!ghost && !draft && <button type="button" data-act="pin" className={panel.pinned ? "is-on" : ""} aria-label={panel.pinned ? "Unpin" : "Pin: keep it"} aria-pressed={!!panel.pinned} onClick={() => actions.pin(panel)}><IconPin size={11} /></button>}
          <button type="button" data-act="close" aria-label="Put away" onClick={() => actions.close(panel)}><IconX size={11} /></button>
        </span>
      </header>
      {why && (
        <div className="pa-why">
          <p>{panel.why || "No reason was given."}</p>
          <span className="pa-why-foot">
            <span>{WHO[panel.by]}</span>
            {!panel.pinned && <button type="button" data-act="not-this" onClick={() => { setWhy(false); actions.notThis(panel); }}>Not this</button>}
          </span>
        </div>
      )}
      {/* An offer says what it is for and how to take it first, under the title: a ghost half off screen can still be answered. */}
      {ghost && (
        <div className="pa-offer is-top">
          <span>{panel.why}</span>
          <span className="pa-offer-acts">
            <button type="button" className="pa-btn is-accent" data-act="accept" onClick={() => actions.accept(panel)}>Add</button>
            <button type="button" className="pa-btn" data-act="wave" onClick={() => actions.wave(panel)}>Not now</button>
          </span>
        </div>
      )}
      <div className="pa-body" ref={(el) => el?.toggleAttribute("inert", ghost || dim)}>
        <Atom node={panel.tree} panel={panel} />
      </div>
      {draft && (
        <footer className="pa-offer">
          <span>Made for this. Tell Autora what to change, or keep it.</span>
          <span className="pa-offer-acts">
            <button type="button" className="pa-btn is-accent" data-act="keep" onClick={() => actions.keep(panel)}>Keep in library</button>
            <button type="button" className="pa-btn" data-act="discard" onClick={() => actions.discard(panel)}>Discard</button>
          </span>
        </footer>
      )}
      {!ghost && !dim && <i className="pa-resize" aria-hidden="true" onPointerDown={(e) => actions.widen(panel, e)} />}
    </div>
  );
});

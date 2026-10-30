import { holdSurface } from "../lib/collab";
import { IconHand } from "./Icons";

/**
 * The window's hand-over switch: work on the document yourself while the agent carries on elsewhere, or hand it back.
 * A labelled pill in a desktop's bar; on a phone, where the bar has room for the name and three controls, one round
 * hand button to take it, and a labelled Hand back pill while the document is the person's (the same `holdSurface`,
 * the same state).
 */
export function TakeControl({ sessionId, surface, mine, phone, thing, variant }: {
  sessionId: string;
  surface: "pdf" | "video" | "office" | "app" | "browser";
  mine: boolean;
  phone: boolean;
  thing: string;
  /** The App window's bar has its own button classes. */
  variant?: "app" | "shot";
}) {
  const title = mine ? `Let the agent work on the ${thing} again` : `Work on the ${thing} yourself; the agent carries on with other work`;
  const flip = () => void holdSurface(sessionId, surface, !mine);
  /* Held, it says so in words on a phone too: a lit hand did not read as "the agent is waiting for this back". */
  if (phone && mine) {
    return (
      <button className="held-pill" onClick={flip} aria-pressed title={title}>
        <IconHand size={13} /> Hand back
      </button>
    );
  }
  if (phone) {
    return (
      <button className={`${variant === "app" ? "app-icon" : variant === "shot" ? "shot-tool" : "btn icon ghost"} pdf-hold-btn${mine ? " is-on" : ""}`} onClick={flip} aria-pressed={mine} title={title} aria-label={mine ? "Hand back" : "Take control"}>
        <IconHand size={16} />
      </button>
    );
  }
  return (
    <button className={variant === "app" ? `app-control${mine ? " on" : ""}` : `pdf-pill${mine ? " is-accept" : ""}`} onClick={flip} aria-pressed={mine} title={title}>
      {mine ? "Hand back" : "Take control"}
    </button>
  );
}

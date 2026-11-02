/**
 * What the agent's hand is about to pick in the summon picker, when it is not in the library: a panel the agent
 * composed, a bespoke draft, an offer (a ghost), or a new board, document or table. The picker lists it under the name
 * the hand types, so the hand picks it the way a person picks anything there; the window then puts in the server's own
 * object (`pending` in PanaceaWindow.tsx), so what lands is exactly what the call made. Set only while the hand works.
 */
import type { Recipe } from "../../lib/panacea/library";

let offer: Recipe | null = null;

export const handOffer = (): Recipe | null => offer;

export function setHandOffer(next: Recipe | null) {
  offer = next;
}

/** The picker's id for the agent's pending piece. */
export const OFFER_PREFIX = "pending.";

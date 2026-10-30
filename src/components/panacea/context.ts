import { createContext, useContext } from "react";
import type { Value } from "../../lib/panacea/atoms";
import type { Canvas, Panel } from "../../lib/panacea/canvas";
import type { BoardState } from "../../lib/panacea/board";
import type { DocMode, DocState } from "../../lib/panacea/document";
import type { Profile } from "../../lib/panacea/profile";

/** What every atom of a panel can reach: the canvas, its values, and the person's hands on them. */
export interface PanaceaApi {
  canvas: Canvas;
  profile: Profile;
  /** The value at a bind, or undefined. */
  value: (key: string) => Value | undefined;
  /** The person set a value with a control on `panel`. `label` names the step in the history. */
  set: (key: string, value: Value, panel: Panel, label: string) => void;
  /** A surface's action (reset, auto, export, clear). */
  act: (bind: string) => void;
  /** Send a request to the chat, with the panel's values. */
  ask: (text: string, panel: Panel) => void;
  /** A drag began or ended: the agent's changes wait for it. */
  hold: (on: boolean) => void;
  /** More opened or closed on a panel. */
  expand: (panel: Panel, open: boolean) => void;
  /** A document's text or caret changed in its view; `content` says words changed (a step of history) and not only the caret. */
  writeDoc: (surface: string, doc: DocState, content: boolean) => void;
  /** A board changed in its view; `label` names the step in the history, or null for a selection only. */
  writeBoard: (surface: string, board: BoardState, label: string | null) => void;
  /** Who writes a document or a board: the person (`guide`) or Autora (`agent`). */
  setMode: (surface: string, mode: DocMode) => void;
  /** The chat, for the routes a bespoke piece or an export calls. */
  sessionId: string;
}

export const PanaceaCtx = createContext<PanaceaApi | null>(null);

export function usePanacea(): PanaceaApi {
  const api = useContext(PanaceaCtx);
  if (!api) throw new Error("usePanacea outside the Panacea window");
  return api;
}

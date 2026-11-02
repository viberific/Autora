/**
 * The chat's message box and the Panacea window, which do not share a parent worth threading props through.
 *
 * On a phone the window has no bar of its own: opening a saved file on the canvas and saving the canvas to
 * Artifacts are in the message box's folder sheet instead (App.tsx). The window offers its Save here and hears of a
 * file opened on it by an event (PanaceaWindow.tsx).
 */
import type { LoadResult } from "../components/LoadButton";

export const PANACEA_LOADED = "autora:panacea-loaded";
/** The open canvas's Save, while it has native work to keep; null otherwise. */
let keeper: (() => Promise<string>) | null = null;

/** The window says whether, and how, it can be saved right now (null when it cannot). */
export function offerKeep(keep: (() => Promise<string>) | null) {
  keeper = keep;
  return () => { if (keeper === keep) keeper = null; };
}

/** Whether there is a canvas to save, for the sheet to offer it. */
export const canKeepCanvas = () => keeper !== null;

/** A file was opened on the canvas from outside the window: show it there. */
export function announceLoaded(result: LoadResult) {
  window.dispatchEvent(new CustomEvent<LoadResult>(PANACEA_LOADED, { detail: result }));
}

/** Save the canvas to Artifacts, as the window's own Save does; what it was kept as. */
export function keepCanvas(): Promise<string> {
  return keeper ? keeper() : Promise.reject(new Error("There is no canvas work to save yet."));
}

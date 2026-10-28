import { useSyncExternalStore } from "react";

/**
 * Panacea's window on this page (server/panacea.ts): whether it is open beside the conversation, what changed last,
 * and the commands the agent sends it (do steps by hand, render a picture, draw a chart to a file). The canvas itself
 * is not here: the window fetches it when `rev` moves on and the change was the agent's.
 */
type PanaceaState = {
  open: boolean;
  since?: number;
  rev?: number;
  by?: "agent" | "person";
  name?: string;
  panels?: number;
  surfaces?: number;
  /** This revision was made by the agent's hand in the window, which has it already: take it without lighting it up. */
  quiet?: number;
};

type PanaceaCommand = { id: string; name: string; args: Record<string, unknown> };

const CLOSED: PanaceaState = { open: false };
let state: PanaceaState = CLOSED;
const listeners = new Set<() => void>();

export function setPanaceaState(next: unknown) {
  state = next && typeof next === "object" && (next as PanaceaState).open !== undefined ? (next as PanaceaState) : CLOSED;
  for (const l of listeners) l();
}

export function resetPanacea() {
  setPanaceaState(null);
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function usePanaceaState(): PanaceaState {
  return useSyncExternalStore(subscribe, () => state, () => CLOSED);
}

export const panaceaStateNow = (): PanaceaState => state;

export function onPanaceaState(fn: () => void): () => void {
  return subscribe(fn);
}

type CommandListener = (cmd: PanaceaCommand) => void;
const commandListeners = new Set<CommandListener>();

export function onPanaceaCommand(fn: CommandListener): () => void {
  commandListeners.add(fn);
  return () => { commandListeners.delete(fn); };
}

/** One command off the session stream (called from App, where the stream lives). */
export function emitPanaceaCommand(cmd: PanaceaCommand): void {
  for (const fn of commandListeners) {
    try {
      fn(cmd);
    } catch (err) {
      console.error("[panacea] a listener threw", err);
    }
  }
}

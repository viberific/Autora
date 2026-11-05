import { useSyncExternalStore } from "react";

/**
 * Autora Games's window on this page (server/gamedesk.ts): whether it is open beside the conversation, and what changed
 * last. The game itself is not here: the window tells the editor to fetch it when `rev` moves on and the change was the agent's.
 */
type GameState = {
  open: boolean;
  /** When the window was opened, which orders it among the others. */
  since?: number;
  /** Goes up on every change to the game, by anyone. */
  rev?: number;
  /** Who made the latest change. */
  by?: "agent" | "person";
  /** The game's name, and how many scenes it has. */
  name?: string;
  scenes?: number;
  /** This revision came from a Panacea panel, which the window has already: it takes it without moving the camera. */
  quiet?: number;
};

const CLOSED: GameState = { open: false };
let state: GameState = CLOSED;
const listeners = new Set<() => void>();

export function setGameState(next: unknown) {
  state = next && typeof next === "object" && (next as GameState).open !== undefined ? (next as GameState) : CLOSED;
  for (const l of listeners) l();
}

export function resetGame() {
  setGameState(null);
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function useGameState(): GameState {
  return useSyncExternalStore(subscribe, () => state, () => CLOSED);
}

/** The state as it is now, for code that is not a component (the window's message handler). */
export const gameStateNow = (): GameState => state;

/** Be told whenever the state changes. */
export function onGameState(fn: () => void): () => void {
  return subscribe(fn);
}

const playListeners = new Set<() => void>();

/** The window listens for the agent asking for the game to be started (game_play). */
export function onGamePlay(fn: () => void): () => void {
  playListeners.add(fn);
  return () => { playListeners.delete(fn); };
}

/** The agent's request, off the session stream (called from App, where the stream lives). */
export function emitGamePlay(): void {
  for (const fn of playListeners) fn();
}

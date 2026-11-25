import { useSyncExternalStore } from "react";

/**
 * The phone window's state on this page (server/phone.ts): whether it is open beside the conversation, and how far the
 * screen has moved. The phone itself is not here -- the window fetches a new picture when `rev` moves on.
 */
type PhoneState = {
  open: boolean;
  since?: number;
  rev?: number;
  by?: "agent" | "person";
  device?: string;
  trouble?: string;
  held?: boolean;
};

const CLOSED: PhoneState = { open: false };
let state: PhoneState = CLOSED;
const listeners = new Set<() => void>();

export function setPhoneState(next: unknown) {
  state = next && typeof next === "object" && (next as PhoneState).open !== undefined ? (next as PhoneState) : CLOSED;
  for (const l of listeners) l();
}

export function resetPhone() {
  setPhoneState(null);
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function usePhoneState(): PhoneState {
  return useSyncExternalStore(subscribe, () => state, () => CLOSED);
}

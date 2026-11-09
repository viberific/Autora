import { createContext, useContext, useSyncExternalStore } from "react";

/**
 * Whether a tool is full screen on a phone. One flag for all of them (the
 * browser, the app window, the PDF, the three office apps, a widget) rather
 * than one per window, so that when "follow" moves the stage from one tool to
 * the next, the next opens full screen too instead of dropping the person
 * back to the thread. Each pinned window reads it; the thread draws the
 * messaging-lite layer over whichever one is up (components/ImmersiveChat.tsx).
 */
let on = false;
const listeners = new Set<() => void>();

export function setFullscreen(next: boolean) {
  if (on === next) return;
  on = next;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};

export function useFullscreen(): [boolean, (next: boolean) => void] {
  return [useSyncExternalStore(subscribe, () => on, () => false), setFullscreen];
}

/**
 * A window on the Panacea board. There "full screen" is the board's own Maximise for that window (the whole room there is
 * for work, at its real size), and on a phone the conversation sheet drops to its strip as well; the window's Full screen
 * button and its title bar's Maximise are one control. Outside the board a window has no frame and uses the flag above.
 */
export const EngineFrame = createContext<{ full: boolean; setFull: (next: boolean) => void } | null>(null);

/** Whether this window is full screen, and how to change it: the board's frame when it has one, else the shared flag. */
export function useWindowFull(): [boolean, (next: boolean) => void] {
  const frame = useContext(EngineFrame);
  const shared = useFullscreen();
  return frame ? [frame.full, frame.setFull] : shared;
}

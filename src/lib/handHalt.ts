/**
 * Halting the agent's hand: when Visible work is switched off, or the turn is stopped, whatever the hand is doing in
 * any window stops being shown at once. Switched off, the rest of its steps run without pauses and without a cursor
 * (the work lands as it would with Visible work off). Stopped, the steps not yet begun are not done at all.
 *
 * In this page: the hands here (Panacea's, Music's, Video's) and the board's pointer read `handsHalted()`; each run
 * clears it as it starts (`beginHandRun`). In the editors' frames (Office, PDF, 3D, Photo): `{type: "autora:halt"}` is
 * posted into every frame, and each frame's hand does the same with its own pauses and cursor.
 */
let halted = false;
let stopped = false;
const listeners = new Set<() => void>();
/** The pauses under way: a halt ends them at once, so a long one begun just before does not hold the rest back. */
const pausing = new Set<() => void>();

export function handsHalted(): boolean {
  return halted;
}

/** The turn was stopped: the hand does no more steps (a step in the middle may finish, at once). */
export function handsStopped(): boolean {
  return stopped;
}

/** A hand run starts: shown again, until the next halt. */
export function beginHandRun(): void {
  halted = false;
  stopped = false;
}

/** `stop`: the turn was stopped (do no more), rather than Visible work switched off (do the rest unseen). */
export function haltHands(stop = false): void {
  halted = true;
  if (stop) stopped = true;
  for (const end of [...pausing]) end();
  for (const frame of Array.from(document.querySelectorAll("iframe"))) {
    try { frame.contentWindow?.postMessage({ type: "autora:halt", stop }, "*"); } catch { /* a frame that has gone */ }
  }
  for (const fn of listeners) fn();
}

/** Told when the hands are halted (the board's pointer hides). */
export function onHandsHalted(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** A pause in a hand's work: none once halted (still a turn of the event loop, so the page keeps drawing), and one
    under way when the halt comes ends then. */
export function handPause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const end = () => { clearTimeout(timer); pausing.delete(end); resolve(); };
    const timer = setTimeout(end, halted ? 0 : ms);
    pausing.add(end);
  });
}

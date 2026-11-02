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

/** The fields the hand focused, and the inputmode each had: put back when the run ends. */
const quieted = new Map<HTMLElement, string | null>();
/* While the hand works, a field it focuses (the picker, a document, a card, a list) takes no on-screen keyboard: the
   agent's typing must never open the person's keyboard on a phone. `inputmode="none"` is set as the focus arrives. */
const quiet = (e: FocusEvent) => {
  const el = e.target;
  if (!(el instanceof HTMLElement) || !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) return;
  if (!quieted.has(el)) quieted.set(el, el.getAttribute("inputmode"));
  el.setAttribute("inputmode", "none");
};
let running = false;

/** A hand run starts: shown again, until the next halt; and (unless `keys` is false, for a hand that types only inside
    a frame) what it types into here raises no keyboard until `endHandRun`. */
export function beginHandRun(keys = true): void {
  halted = false;
  stopped = false;
  if (!keys) return;
  /* The board's own dock (history, ask, what was put away) steps aside while the hand works in the page, so it never
     sits over the control the hand is reaching for; it is back when the run ends (styles.css, .hands-at-work). */
  document.documentElement.classList.add("hands-at-work");
  if (!running) document.addEventListener("focusin", quiet, true);
  running = true;
}

/** A hand run is over: the fields it typed in are let go (a phone's keyboard stays down) and get their inputmode back. */
export function endHandRun(): void {
  if (!running) return;
  running = false;
  document.documentElement.classList.remove("hands-at-work");
  document.removeEventListener("focusin", quiet, true);
  const active = document.activeElement;
  if (active instanceof HTMLElement && quieted.has(active) && window.matchMedia?.("(pointer: coarse)").matches) active.blur();
  for (const [el, mode] of quieted) {
    if (mode === null) el.removeAttribute("inputmode");
    else el.setAttribute("inputmode", mode);
  }
  quieted.clear();
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

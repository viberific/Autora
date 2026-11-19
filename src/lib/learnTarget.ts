import type { LessonTarget } from "./learn";

/**
 * The control a lesson step names, found on the page: by its selector, then by its name (its accessible label or tooltip),
 * then by the words on it. Only a control a person can see and press counts. Null when it is not on screen -- a tool in a
 * closed panel, or one inside an editor's frame, which the page cannot look into -- and the lesson then points at nothing
 * and waits for Next instead of drawing a ring on a guess.
 */
const PRESSABLE = 'button, a[href], [role="button"], [role="tab"], [role="menuitem"], input, select, textarea, summary, label, [data-learn]';

const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

function shown(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.closest("[data-learn-guide]")) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const s = getComputedStyle(el);
  return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
}

/** Exact matches before partial ones, so "Text" finds the Text tool and not "Text size". */
function best(found: HTMLElement[], want: string, name: (el: HTMLElement) => string): HTMLElement | null {
  const exact = found.find((el) => name(el) === want);
  return exact ?? found.find((el) => name(el).includes(want)) ?? null;
}

export function findTarget(target: LessonTarget | undefined, root: ParentNode = document): HTMLElement | null {
  if (!target) return null;
  if (target.selector) {
    try {
      const hit = [...root.querySelectorAll<HTMLElement>(target.selector)].find(shown);
      if (hit) return hit;
    } catch {
      // a selector the agent got wrong: fall through to the words
    }
  }
  const pressable = [...root.querySelectorAll<HTMLElement>(PRESSABLE)].filter(shown);
  const label = norm(target.label);
  if (label) {
    const hit = best(pressable, label, (el) => norm(el.getAttribute("aria-label")) || norm(el.getAttribute("title")));
    if (hit) return hit;
    const byTitle = best(pressable, label, (el) => norm(el.getAttribute("title")));
    if (byTitle) return byTitle;
  }
  const words = norm(target.text ?? target.label);
  if (words) return best(pressable, words, (el) => norm(el.textContent));
  return null;
}

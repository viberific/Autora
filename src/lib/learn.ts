/**
 * Learn mode's lesson, read off the chat's log (the page and the server share this file, so both see the same lesson).
 *
 * A lesson is a short list of steps the agent leads the person through by highlighting the real control for each, then
 * waiting until the person has used it. Three events carry it, all in the log, so a reload or another device picks it up
 * where it was:
 *
 *   learn.lesson  {lesson, title, steps}      the agent starts one (a second one replaces the first)
 *   learn.step    {lesson, index, how}        step `index` is over: the person did it, skipped it, or the agent did it
 *   learn.end     {lesson, how}               finished, or the person left it
 *
 * Pure: a log in, the lesson now under way (or null) out.
 */

/** Where a step's control is, in the page's own words. The first that matches a control on screen is the one. */
export interface LessonTarget {
  /** What the control is called: its accessible name or title ("All tools", "Highlight"). */
  label?: string;
  /** Words on it. */
  text?: string;
  /** A CSS selector, only where the control has no words. */
  selector?: string;
}

export interface LessonStep {
  /** What the person is asked to do, and why, in one or two plain sentences. */
  say: string;
  /** Absent: a step that points at nothing (an idea to think about), advanced by the person's Next. */
  target?: LessonTarget;
}

export interface Lesson {
  id: string;
  title: string;
  steps: LessonStep[];
}

export interface LessonState {
  lesson: Lesson;
  /** The step the person is on now. */
  index: number;
}

export const MAX_STEPS = 12;
const SAY_MAX = 300;
const WORD_MAX = 80;
const SELECTOR_MAX = 200;

interface LogEvent {
  kind: string;
  payload?: Record<string, any>;
}

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

function cleanTarget(raw: unknown): LessonTarget | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const label = text(r.label, WORD_MAX);
  const words = text(r.text, WORD_MAX);
  const selector = text(r.selector, SELECTOR_MAX);
  if (!label && !words && !selector) return undefined;
  return { ...(label ? { label } : {}), ...(words ? { text: words } : {}), ...(selector ? { selector } : {}) };
}

/** What the agent sent, as steps; or why it cannot be a lesson. */
export function cleanSteps(raw: unknown): { steps: LessonStep[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "A lesson needs steps: a list of {say, target}." };
  if (raw.length > MAX_STEPS) return { error: `A lesson is at most ${MAX_STEPS} steps. Teach the first part, and offer the rest after.` };
  const steps: LessonStep[] = [];
  for (const [i, item] of raw.entries()) {
    const step: Record<string, unknown> = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const say = text(step.say, SAY_MAX);
    if (!say) return { error: `Step ${i + 1} has nothing to say. Each step says what to do and why.` };
    const target = cleanTarget(step.target);
    steps.push({ say, ...(target ? { target } : {}) });
  }
  return { steps };
}

/** The lesson under way: the last one started, at the first step nobody has finished, until the last step is done or it ends. */
export function lessonFrom(events: readonly LogEvent[]): LessonState | null {
  let now = null as LessonState | null;
  for (const e of events) {
    const p = e.payload ?? {};
    if (e.kind === "learn.lesson") {
      const cleaned = cleanSteps(p.steps);
      const id = text(p.lesson, 60);
      if (!id || "error" in cleaned) continue;
      now = { lesson: { id, title: text(p.title, 120) || "Lesson", steps: cleaned.steps }, index: 0 };
    } else if (e.kind === "learn.step" && now && p.lesson === now.lesson.id) {
      const done = Number(p.index);
      if (Number.isInteger(done) && done >= now.index) now = { ...now, index: done + 1 };
      if (now.index >= now.lesson.steps.length) now = null;
    } else if (e.kind === "learn.end" && now && p.lesson === now.lesson.id) {
      now = null;
    }
  }
  return now;
}

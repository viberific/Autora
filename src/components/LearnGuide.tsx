import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LessonState } from "../lib/learn";
import { findTarget } from "../lib/learnTarget";
import { IconX } from "./Icons";

/**
 * Learn mode's guide (docs/LEARN.md): the control the current step names is ringed, with a card saying what to do and why,
 * and it waits until the person has used that control before moving on. Nothing here presses anything: the person does the
 * work and the agent coaches.
 *
 * Where the control cannot be found (a tool in a closed panel, or inside an editor's frame, which the page cannot look
 * into), there is no ring -- the card says it in words and moves on with Next, rather than pointing at a guess. "Do this
 * one for me" asks the agent to do that one step at speed.
 */
const LOOK_MS = 250;
const SETTLE_MS = 180;
const CARD = { width: 300, gap: 12, edge: 12 };

interface Box { left: number; top: number; width: number; height: number }

export function LearnGuide({
  state, sessionId, onDoForMe,
}: {
  state: LessonState | null;
  sessionId: string | null;
  /** Ask the agent to do one step for the person (a message in the chat). */
  onDoForMe: (text: string) => void;
}) {
  const [box, setBox] = useState<Box | null>(null);
  const target = useRef<HTMLElement | null>(null);
  const reported = useRef("");
  const lessonId = state?.lesson.id ?? null;
  const index = state?.index ?? 0;
  const step = state?.lesson.steps[index];

  const report = useCallback((how: "done" | "skipped" | "agent") => {
    if (!sessionId || !lessonId) return;
    const key = `${lessonId}:${index}`;
    if (reported.current === key) return;
    reported.current = key;
    void fetch(`/api/sessions/${sessionId}/learn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lesson: lessonId, index, how }),
    }).catch(() => { reported.current = ""; });
  }, [sessionId, lessonId, index]);

  const leave = useCallback(() => {
    if (!sessionId || !lessonId) return;
    void fetch(`/api/sessions/${sessionId}/learn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lesson: lessonId, end: true }),
    }).catch(() => undefined);
  }, [sessionId, lessonId]);

  // Where the control is now: asked again as the page changes, since a panel opens and a window moves.
  useEffect(() => {
    target.current = null;
    setBox(null);
    if (!step?.target) return;
    const look = () => {
      const el = findTarget(step.target);
      target.current = el;
      if (!el) { setBox((b) => (b ? null : b)); return; }
      const r = el.getBoundingClientRect();
      setBox((b) => (b && b.left === r.left && b.top === r.top && b.width === r.width && b.height === r.height
        ? b : { left: r.left, top: r.top, width: r.width, height: r.height }));
    };
    look();
    const timer = window.setInterval(look, LOOK_MS);
    return () => window.clearInterval(timer);
  }, [step]);

  // The person uses the control: the step is done once what they pressed has had a moment to open what it opens.
  useEffect(() => {
    if (!step?.target) return;
    let wait = 0;
    const used = (e: Event) => {
      const el = target.current;
      if (!el || !(e.target instanceof Node) || !el.contains(e.target)) return;
      window.clearTimeout(wait);
      wait = window.setTimeout(() => report("done"), SETTLE_MS);
    };
    const events = ["click", "input", "change"] as const;
    for (const name of events) document.addEventListener(name, used, true);
    return () => {
      window.clearTimeout(wait);
      for (const name of events) document.removeEventListener(name, used, true);
    };
  }, [step, report]);

  if (!state || !step) return null;
  const total = state.lesson.steps.length;
  const found = box !== null;

  // The card sits beside the ring, inside the window; with no ring it rests at the foot of the page.
  const card: { left: number; top: number } | null = (() => {
    if (!box) return null;
    const room = { w: window.innerWidth, h: window.innerHeight };
    const left = Math.min(Math.max(CARD.edge, box.left + box.width / 2 - CARD.width / 2), room.w - CARD.width - CARD.edge);
    const below = box.top + box.height + CARD.gap;
    const top = below + 150 < room.h ? below : Math.max(CARD.edge, box.top - CARD.gap - 150);
    return { left, top };
  })();

  return createPortal(
    <div className="learn-guide" data-learn-guide="" role="region" aria-label="Lesson">
      {box && <i className="learn-ring" style={{ left: box.left - 4, top: box.top - 4, width: box.width + 8, height: box.height + 8 }} aria-hidden="true" />}
      <div className={`learn-card${card ? "" : " is-docked"}`} style={card ? { left: card.left, top: card.top, width: CARD.width } : undefined}>
        <div className="learn-card-head">
          <b>{state.lesson.title}</b>
          <span className="learn-count">{index + 1} of {total}</span>
          <button type="button" className="learn-x" aria-label="End the lesson" onClick={leave}><IconX size={13} /></button>
        </div>
        <p className="learn-say">{step.say}</p>
        <div className="learn-actions">
          {!found && <button type="button" className="learn-next" onClick={() => report("done")}>{index + 1 < total ? "Next" : "Done"}</button>}
          {found && <button type="button" className="learn-skip" onClick={() => report("skipped")}>Skip</button>}
          <button type="button" className="learn-skip" onClick={() => { report("agent"); onDoForMe(`Do this step for me: ${step.say}`); }}>Do this one for me</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

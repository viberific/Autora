/**
 * Learn mode, the server's part (docs/LEARN.md): the tool that starts a lesson, what the agent is told each turn, and the
 * route the page reports a step on. The lesson itself is read off the log by src/lib/learn.ts; the highlight is the page's.
 *
 * Learn is a choice the person makes for a chat (the switch in the header). On, the agent teaches the tools instead of
 * driving them; off, it works at its own speed, and teaches only when asked to show how.
 */

import type { Express, Request, Response } from "express";
import { cleanSteps, lessonFrom, type LessonState } from "../src/lib/learn";
import type { Session } from "./session-types";
import type { ToolContext } from "./tools";

/** The tool's work: validate, and hand the lesson to the page through the log. */
export function runLearnShow(args: Record<string, any>, ctx: ToolContext): { ok: boolean; summary: string; preview?: string } {
  if (!ctx.teach) return { ok: false, summary: "There is no chat to show a lesson in." };
  const title = typeof args.title === "string" ? args.title.trim().slice(0, 120) : "";
  const cleaned = cleanSteps(args.steps);
  if ("error" in cleaned) return { ok: false, summary: cleaned.error };
  ctx.teach({ title: title || "Lesson", steps: cleaned.steps });
  return {
    ok: true,
    summary:
      `The lesson "${title || "Lesson"}" is on screen, ${cleaned.steps.length} step${cleaned.steps.length === 1 ? "" : "s"}: ` +
      "the first control is highlighted and the person does each step themselves. Say one short line to start them and stop. " +
      "Do not do the steps for them; the page tells you how far they got.",
    preview: `${title || "Lesson"} (${cleaned.steps.length} steps)`,
  };
}

/** What the agent is told every turn about Learn: the mode, and the lesson under way. Null when there is nothing to say. */
export function learnBriefing(on: boolean, state: LessonState | null): string | null {
  const lines: string[] = [];
  if (on) {
    lines.push(
      "Learn mode is ON in this chat: the person chose to learn the tools, not have them driven. When they ask for something " +
      "to be done in a tool window or in Autora (a PDF, a document, a photo, a video, a song, the canvas, a setting), TEACH it: " +
      "call learn_show with the first steps, each naming the real control, and let them do it. Do not make the change yourself. " +
      "Only when they say to just do it (\"just do it\", \"do this one for me\") do it, at speed, as you would with Learn off. " +
      "Questions, reading, writing code, research and anything that is not using a tool window are unchanged: answer them as usual.",
    );
  }
  if (state) {
    const { lesson, index } = state;
    lines.push(
      `A lesson is under way: "${lesson.title}", on step ${index + 1} of ${lesson.steps.length}: ${lesson.steps[index].say} ` +
      "The person is doing the steps themselves and the page advances as they do. Do not do them for them. If they are stuck, " +
      "explain in words; if they ask you to do the step, do it and say so.",
    );
  }
  return lines.length ? lines.join("\n") : null;
}

/**
 * The page reports how a step went: the person did it, skipped it, or asked the agent to; or that they left the lesson.
 * Both become events, so the agent and a second device see them.
 */
export function learnRoutes(app: Express, deps: {
  session: (id: string) => Session | undefined;
  emit: (session: Session, kind: string, actor: string, payload: Record<string, any>) => void;
}) {
  app.post("/api/sessions/:id/learn", (req: Request, res: Response) => {
    const session = deps.session(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const now = lessonFrom(session.events);
    const body = req.body ?? {};
    if (!now || body.lesson !== now.lesson.id) return res.json({ ok: true, current: false });
    if (body.end === true) {
      deps.emit(session, "learn.end", "person", { lesson: now.lesson.id, how: "left" });
      return res.json({ ok: true, current: false });
    }
    const index = Number(body.index);
    if (!Number.isInteger(index) || index !== now.index) return res.json({ ok: true, current: true, index: now.index });
    const how = body.how === "skipped" || body.how === "agent" ? body.how : "done";
    deps.emit(session, "learn.step", "person", { lesson: now.lesson.id, index, how });
    return res.json({ ok: true, current: index + 1 < now.lesson.steps.length, index: index + 1 });
  });
}

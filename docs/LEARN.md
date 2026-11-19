# Learn mode: the agent teaches, or works at speed

There is no agent cursor. With Learn **off** (the default) the agent works at its own speed in every window: it changes the file
or the tool's state directly and the window shows the result. With Learn **on** it teaches the tools instead of driving them:
it leads the person through a task by ringing the real control for each step, and waits until the person has used it.

The switch is per chat (`session.learn`, the header's Learn button beside the permissions pill, saved with the chat). The person
can also ask "show me how" with Learn off, and the agent teaches that one thing the same way.

## What the person sees

- A ring round the control the step names, and a small card beside it: the lesson's title, "2 of 5", one or two sentences saying
  what to do and why.
- The step is done when the person uses that control (a click, or typing in it); the ring moves to the next. **Skip** moves on
  without it; the cross leaves the lesson; **Do this one for me** sends the agent a message to do that one step directly.
- A step whose control is not on screen (a tool in a closed panel, or one inside an editor's frame, which the page cannot look
  into) gets no ring: the card says it in words and **Next** moves on. Nothing is ever pointed at on a guess.
- Switching Learn off ends the lesson.

## How it is built

| Piece | Where |
| --- | --- |
| Lesson shape, cleaning, and the fold of the log into "the lesson now" | `src/lib/learn.ts` (shared by page and server) |
| The tool `learn_show` (title, steps of `{say, target: {label, text, selector}}`, at most 12) | `server/specs/learn.ts`, `server/learn.ts` `runLearnShow`, `ToolContext.teach` in `server.ts` |
| What the agent is told each turn (Learn on; the lesson under way) | `learnBriefing` in `server/learn.ts`; the manual is the "Learn mode" entry in `server/handbook.ts` |
| The step route the page reports on | `POST /api/sessions/:id/learn` (`learnRoutes`): `{lesson, index, how}` or `{lesson, end: true}` |
| Finding the control | `src/lib/learnTarget.ts`: selector, then accessible label / title, then the words on it; only visible, pressable elements |
| The ring and the card | `src/components/LearnGuide.tsx`, styles `.learn-*` in `src/styles.css` |
| The switch | `src/components/LearnToggle.tsx`; `learn` in `PATCH /api/sessions/:id` |

Events (all in the log, so a reload or a second device picks the lesson up where it was): `learn.lesson`, `learn.step`
(`how`: done, skipped, agent), `learn.end`. The `learn` tool family is loaded when Learn is on or the person asks to be shown
(`server/toolload.ts`); `learn_show` is allowed in Plan mode, since it changes nothing.

## What is not here yet

- **Controls inside an editor's frame** (Spectra, Pages/Sheets/Slides, Video, Photo, 3D, Games) cannot be ringed: those frames are
  sandboxed, so the page cannot find or watch a control in them. The way in is a message the frame answers with the control's rect
  and a note when the person uses it. The locators that used to drive the editors for the cursor (`spectra-editor/src/autora/hand.ts`,
  `office/shim/hand.js`, `photo/overlay/autora.rs`, `opencut-editor/src/autora/commands.ts`, `autora-3d/src/agentHand.ts`) already
  know where each control is drawn; nothing posts them work now, and they are what a frame's side of Learn grows from. Until then
  the card says the step in words and the person presses Next.
- **The offer.** A small "Show me" chip when the person seems stuck or is hunting for a tool, gone if ignored, is decided but not built;
  today a lesson starts only when Learn is on or the person asks to be shown.
- The window that is a page of its own (Panacea's panels, the tool rail, the header) works today.

Tests: `tests/learn.test.ts` (the fold, the tool, the route, the briefing, the switch) and `tests/ui-learn.test.ts` (the ring on a
real control, a step advancing when the control is used, Next when there is nothing to ring, Do this one for me, leaving, switching off).

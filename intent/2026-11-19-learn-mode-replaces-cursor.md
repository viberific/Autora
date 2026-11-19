# Learn mode replaces the agent's cursor

Problem:
The Visible switch (`state.agentCursor`) makes the agent drive each tool window through its real controls at a person's
pace, with a cursor, while the tool call waits. It is slow, needs a claim/answer protocol and halt machinery per window,
and `docs/VISIBLE-WORK.md` lists a long column of gaps where a window still replays. Watching the agent click is also not
what the person wants from it: they want either the work done, or to learn to do it themselves.

Outcome wanted:
- **Learn off (default): the agent works at its own speed.** No cursor, no pacing. It edits files directly; the window
  shows the result and the change is the agent's mark to accept or decline, as today with Visible off.
- **Learn on: the agent teaches the tools in Panacea by highlighting.** For a request it leads the person step by step:
  the real control is ringed with a line of explanation, the highlight waits until the window sees the person act on it
  (click, tool picked, value set), then moves to the next step. The person does the work; the agent coaches.
- If the person explicitly asks to be shown how, with Learn off, the agent teaches that one thing the same way.

Decisions (stated by the person, 2026-11-19):
- With Learn on, "make this bold" is taught, not done. A per-step / per-request "do this one for me" lets the agent do it at
  speed. It must stay easy to correct.
- The Learn switch lives in the chat header beside Yolo / Ask and the work mode (per chat), not in Settings.
- A step advances when the person does it. Where a window cannot detect the action, a Next / Skip fallback is allowed.
- Autora offers, never starts: when the person seems stuck or is hunting for a tool, a small "Show me" chip appears and
  goes away if ignored. It never opens a lesson on its own.
- The old Visible switch and setting are removed outright (no flag, no migration). Learn starts off for everyone.

Who / what it touches:
- Removed: the Visible switch (`VisibleWork.tsx`, `CollabSettings.tsx`), `lib/agentCursor.ts`, `lib/handHalt.ts`,
  `pointerFollow` / `humanPath` cursor travel, per-frame cursor drawing, the claim/answer protocol and `untilStopped`
  hand-waiting in `server.ts`, `autora:halt`, `hands.halt`; the "Visible" rule in CLAUDE.md; `docs/VISIBLE-WORK.md`
  (replaced by `docs/LEARN.md`).
- Kept and repurposed: each window's locator code that finds the element the editor really drew (`spectra-editor/src/autora/hand.ts`,
  `office/shim/hand.js`, `photo/overlay/autora.rs`, `opencut-editor/src/autora/commands.ts`, `autora-3d/src/agentHand.ts`).
  It is used to ring a control and to see the person act on it, never to drive the editor.
- Browser live copy / mirror (`server/mirror.ts`) is a view of a real page, not the agent's cursor; it stays.
- New: a lesson tool (steps of target + explanation) with a schema in `server/specs/`, a case in `runTool`, a toolload
  family, a test; the highlight overlay in each window; the header switch; the "Show me" chip.
- Manuals: every window's section in `server/handbook.ts` and `tests/handbook.test.ts` change in the same commit.
- Release: bump `package.json` / `package-lock.json`, rewrite `releaseNotes` in `blofstedt-autora/umbrel-app.yml`, and
  update the manifest `description` if it mentions watching the agent work.

Constraints (check CLAUDE.md's product decisions):
- Controls appear when the work needs them and go when it does not: the Learn switch and the highlight cards follow that;
  no standing instructions or empty-state text on a canvas.
- Learn is not a replay. A lesson never changes the file first and points at it after.
- Use design tokens (`--fs-*`, `--r-*`, `--dur-*`, status colours); `tests/tokens.test.ts` fails on literals.
- Every turn through `startTurn()`, every event through `emitEvent()`; a new `Thread` prop is stable; new per-session maps
  are cleared in `forgetSession`.
- A window with no locator for a step has the agent explain it in words; it never fakes a highlight.
- Yolo stays the default and Learn adds no approval prompts.
- Measure the prompt / tool change with `npm run eval -- code` on each vendor it touches.

Open questions:
- How does a window report "the person did the step" generically (one `learn.step` event shape across Office, PDF, Photo,
  Video, 3D, Games, Browser)?
- What does the highlight do when the target is off screen or in a collapsed panel (scroll to it, open the panel, or say so)?
- Does the lesson pause and resume when the person leaves the window or starts another chat turn?
- Order: the PDF window first (its tool rail is already being rebuilt, `docs/TOOL-RAIL.md`), then the other windows one at a
  time. The cursor and Visible switch go in one change so the two never coexist.

Proposed order: intent (this file) -> plan mode with the file list and a failing test for highlight-and-wait on the PDF
window -> build -> remove the cursor everywhere -> `verifier` agent -> PR.

# Panacea: the gaps, and the plan to close them

The bar: **every piece in Panacea does all of what it shows**. A control moves something real. A window's tool works on a
phone and a desktop. With Visible work on, the agent's work is done by hand. Nothing is a placeholder.

This page lists what falls short of that today (found 2026-11-02), then the order to close it. It sits beside
`docs/PANACEA-NEXT.md`, the plan for whole projects (N1 done, N2 to N8 to come). Those milestones are part of this plan,
not separate from it.

## How the gaps were found

- **The panel library, read in code.** For each of the 180 built-in panels: whether any of its controls changes a
  surface, or only writes a shared value. Then a search for anything that reads those shared values.
- **The docs' own lists.** "Not yet" in `docs/PANACEA.md`, the status in `docs/PANACEA-ENGINE.md`, and the gaps column
  of `docs/VISIBLE-WORK.md`.
- **What this session built and could not verify here,** and the tests that fail on main.
- **The tools' own reach:** what the person can do in a window that the agent's tools cannot, and the reverse.

## The gaps

### A. Controls that do nothing (the most serious)

| Panels | How many | What happens when used |
|---|---|---|
| Music (`music.*`: transport, key, mixer channel, drums, filter, EQ, compressor, master, export...) | 20 | Each sets a shared value (`music.bpm`, `music.cutoff`...) that **nothing reads**. The song does not change. |
| Video (`video.*`: trim, speed, grade, captions, keyframes, export...) | 20 | Same: `video.*` values go nowhere. |
| 3D (`3d.*`: move, rotate, material, light, boolean, bevel, print...) | 20 | Same: `model.*` values go nowhere. |
| Game (`game.*`: movement, physics, enemy, health, spawner, rules...) | 20 | Same: `game.*` values go nowhere. |
| Design (`design.*`: grid, type, palette, radius, buttons, publish...) | 20 | Same: `ui.*` values go nowhere. |
| Documents (`document.page`, `outline`, `tone`, `replace`, `columns`, `header`, `table`, `spacing`, `review`, `export`, `citations`, `readability`, `toc`, `language`) | 14 | Bound to `doc.*` shared values. The document engine has no tables, headers, columns, page setup, citations or review to act on. |

**114 of 180 panels look like tools and are not.** The only code that reads their values sorts recipes by domain
(`server/panacea.ts`). The rule offers them, the picker lists them, and the agent places them.

Only the native kinds are wired: photo (19 of 20), the data charts and filters, six document panels and the board's
panel. The general panels (budget, to-do, week, trip...) hold their own content, which is a fair use; but none of them
acts on anything either. That is acceptable for a list and thin for "Week plan" or "Trip".

### B. The native surfaces are partial

- **Table (data).** Read-only. You can filter, chart and export a CSV. You cannot edit a cell, sort by a column, add or
  remove rows or columns, write a formula, or save back to the XLSX it came from. A person expects a spreadsheet.
- **Image.** Adjustments, looks, crop and rotate on one layer. No layers, masks, brush, selection, text or retouch: the
  engine plan's M3. The full editor is the hosted Photo window, so on the board one picture has two half-tools.
- **Document.** Headings, lists, quotes, code, marks and colour. Missing:
  - tables, images and page setup;
  - headers and footers, a table of contents, comments;
  - DOCX import and export (Markdown only);
  - Autora *suggesting* a rewording in a "You write" document (ghost edits);
  - history held as steps rather than whole copies, which caps size at about 1.5 MB.
- **Board.** No frames or groups round cards, and no images on cards. Its history is whole snapshots too.
- **Bespoke pieces** cannot set their own binds from inside their frame (`docs/PANACEA.md`).

### C. Windows and layout

- **The agent cannot move, resize or maximise a surface or an app window.** `panacea_arrange` moves panels only. The
  person can do all three now, so the agent cannot lay out the board it works on.
- **App windows' places and sizes are not saved.** They live in the page's state and reset on reload. A surface's are
  saved.
- No bring-to-front for an overlapping window, no tidy or arrange for windows, no snapping between windows.
- **On a phone the board's own chrome sits over the windows:** the history slider and the jump buttons. A maximised
  window is partly under them.
- **Flows are judged by file type** (`.glb` means 3D). A file does not record which app made it. A picture uploaded by
  the person and used in a document draws a line from Photo, if the Photo window is open.

### D. Visible work still has gaps (from `docs/VISIBLE-WORK.md`)

- **Games:** no live hand at all. Every game change appears.
- **Video:** partial. Effects, masks, keyframes, speed, tracks, scenes and clip properties run directly.
- **PDF:**
  - images, signatures, stamps beyond five, watermarks, page numbers, properties and flatten appear;
  - `pdf_pages`, `pdf_redact`, `pdf_replace_text`, `pdf_compose` and `pdf_compress` appear;
  - text size and weight are not set by hand.
- **Pages, Sheets, Slides:**
  - formatting beyond bold, italic and underline appears (sizes, colours, headings, alignment, number formats);
  - tables, pictures, charts, new slides and boxes, and rows, columns and sheets appear;
  - `office_create` appears, and a call does at most 40 steps by hand.
- **Music:** quantize strength, note windows and drum velocity have no control. A call does at most 48 notes or 60 steps.
- **Photo:** commands with no tile run directly. Dialog values are typed, not dragged.
- **3D:** `doc_set`, library import and rename on a phone, and a shape's outline have no control. Reading calls show
  nothing.
- **Panacea:**
  - a project's stack and links have no control yet;
  - a value no panel shows still appears;
  - long passages are typed fast, and a call does at most 80 steps.

### E. Projects (N1 leftovers)

- The strip does not show or edit the **stack** or the **links**.
- **Decisions** are not written to the project's notebook, so a later chat does not read them.
- **Which panels a phase offers** is still special cases in `rules.ts`, not data (the "intent table").
- Phases have no "done" state of their own; ticking every step is the only signal.

### F. Whole apps and sites (N2 to N8 in `docs/PANACEA-NEXT.md`, not started)

- Files, code editors with streamed diffs, and a run panel with errors linked to the code.
- The app as a native surface, with design controls bound to tokens and ghost suggestions.
- A database surface.
- Ship: export to Artifacts and the Umbrel.
- The old app window retired.
- New surface kinds made on request and kept.
- Learned layouts per kind of project.

### G. Built but not verified here, and failing checks

- **The one cursor across apps.** It cannot be seen working with the Office, PDF, Photo, 3D and Video editors, because
  they are not built in this environment.
- **The Photo editor's halt and board-cursor change** (`photo/overlay/autora.rs`) parses but has not been compiled.
- **The keyboard staying down** is checked by attribute, not on a real phone.
- **`toolbudget`:** the agent's briefing is 28,750 characters against a 28,000 budget, on main too. It costs every call.
- **Flaky tests.** The picker test in `ui-panacea` fails about one run in three on main. `e2e-reuse` fails under
  parallel load.
- **`e2e-cad` and `e2e-game`** fail here; to be checked in an environment where the editors are built.

## The plan

**Status (2026-11-02):** G0 is done. G1: Music is wired (0.9.323: `src/lib/panacea/apps/music.ts`, `studioPanel` in
`server/studio.ts`, `POST /api/studio/:session/panel`) and so is 3D (0.9.324: `src/lib/panacea/apps/model.ts`, `cadPanel` in
`server/caddesk.ts`, `POST /api/cad/:session/panel`) and Video (0.9.325: `src/lib/panacea/apps/video.ts`, `videoPanel` in
`server/opencut.ts`) and Game (0.9.326: `src/lib/panacea/apps/game.ts`, `gamePanel` in `server/gamedesk.ts`): **G1 is done**. How the
Music one was built, to repeat for the others, is in `docs/PANACEA-G1-HANDOFF.md`.

The rule for every step: **no control without an effect, and no effect without a control.** A new test enforces the
first half: every bind in every built-in recipe must have something that acts on it, or the recipe is not offered.

### G0. Make it honest (first, small) — done

- **Stop dead panels being offered.** The rule, the picker and `panacea_place` skip any recipe whose binds nothing acts
  on, and the library says which. (A person's own saved recipes are untouched.)
- **The test above,** so a new dead panel fails CI.
- **Bring the briefing back under budget,** and fix the two flaky tests.

**Done when** no panel on the board is a placebo, and `npm run check` is green apart from the editor builds.

### G1. Wire the engine panels to the engines (gap A) — done (`docs/PANACEA-G1-HANDOFF.md`)

- Each hosted engine gets an **adapter**: shared values in → the engine's own tools and state out, and the engine's
  state → values back, so a panel shows what the song or model really is. Music through the studio desk, Video through
  OpenCut's commands, 3D through `caddesk`, Game through the GDevelop bridge.
- **Order:** Music and 3D first (their engines are in-page or already expose state), then Video, then Game.
- **Each panel is wired or deleted.** A panel no engine can honour (say, `3d.print` with no printer path) is removed,
  not kept as decoration. The design panels wait for N3, which is where they get their target.
- **Visible work:** setting such a panel's value with Visible on is done in the engine's own window by its hand.

**Done when** every Music, Video, 3D and Game panel changes its engine, and reads back from it, on a phone and a desktop.

**Done (0.9.323 to 0.9.326).** Every panel left is one of two things: a control that changes the engine and shows what the engine says (all of Music's mixer, key, tempo and drums; 3D's position, size, material, bevel and repeat; Video's speed, audio, title, picture and project; Game's movement and physics), or the person's own marks and words with an Ask button that has the agent build them (chords, sections, shapes to add, markers, scenes, a level sketch, enemies, win and lose, inventory, dialogue, power-ups, export choices). Panels the engine has nothing for were deleted. The engines' windows are not yet laid out so as to leave the panels clear on a phone: that is G2.

### G2. Windows the agent can lay out (gap C) — done (0.9.327)

- `panacea_arrange` gains `surfaces` and `windows`: move, resize, maximise, bring to front, tidy. These use the same
  gestures by hand.
- App windows' boxes are saved with the canvas.
- A phone keeps the board's chrome clear of a maximised window.
- Artifacts record the app that made them, so flows stop guessing from file type.

**Done when** the agent can lay out the board as a person does, and a reload keeps every window where it was.

**Done (0.9.327).** `src/lib/panacea/windows.ts` (a window's place, z, "was" when maximised; raise, maximise, tidy), kept in `Canvas.windows` with the page's `room`; `panacea_arrange` takes `windows`, `surfaces` and `tidy`; the board writes every drag, size, maximise and raise to the canvas and has a Tidy button; the hand does each by the same gesture; `workViewport` keeps a phone's maximised window clear of the bottom row; `Artifact.app` records the app that made a file and `appOfArtifact` replaces guessing from the name.

### G3. Full native surfaces (gap B)

- **Table:**
  - edit cells, sort, add and remove rows and columns;
  - formulas, through the same engine the hosted Sheets uses where possible;
  - save back to CSV or XLSX;
  - every action done by hand with Visible on.
- **Document:**
  - tables, images and page setup;
  - headers and footers, a table of contents and comments;
  - DOCX in and out;
  - ghost suggestions in "You write" documents;
  - history held as steps. This finishes M1 and wires the 14 document panels, or retires the ones the engine will not
    carry.
- **Board:** frames and groups, images on cards, history held as steps.
- **Image:** layers and masks (engine M3), or else the native image hands off to the Photo window for anything past
  adjustments, without two half-tools.
- **Bespoke:** binds set from inside the frame.

**Done when** each native surface does what its name promises, without opening another app.

### G4. Visible work, complete (gap D)

In order of what a person most often watches:

1. A live hand for **Games**.
2. **Video's** remaining actions.
3. **Office** formatting, tables, pictures and structure.
4. **PDF's** remaining tools.
5. **Photo's** dialogs by their own widgets.
6. **Music's** missing controls.
7. **3D's** leftovers.
8. **Panacea's** stack and links.

Raise the per-call step caps where a cap is what stops it. Each closes its row in `docs/VISIBLE-WORK.md`.

**Done when** that table's gaps column is empty, or says why something has no control in the app itself.

### G5. Projects finished (gap E)

- The stack and links shown and editable in the strip.
- Decisions written to the project's notebook.
- The intent table replaces the per-kind cases in `rules.ts`.
- A phase can be marked done.

### G6. Whole apps and sites (gap F)

N2 to N8, as `docs/PANACEA-NEXT.md` sets out:

- code that streams in as diffs;
- an Umbrel export;
- the agent's choice of stack;
- the app window retired once the new surface matches it.

The design panels (gap A) get their target in N3.

### G7. Verified where it runs (gap G)

Run in a full build (CI, or the Docker image):

- **Real apps on the board:** check, in a browser, the one cursor travelling between the Office, PDF, Photo, 3D and
  Video windows.
- **Photo:** compile the editor.
- **Games and 3D:** run `e2e-cad` and `e2e-game` with their editors built.
- **A real phone:** confirm the keyboard stays down while the agent types.

Each fix found goes in with a test.

## Order and size

| Step | Size | Why here |
|---|---|---|
| G0 | Small | Stops misleading people today; the test keeps it that way |
| G1 | Large (per engine) | The biggest gap: 80 panels that do nothing |
| G2 | Medium | The agent and the person lay out the same board |
| G7 | Small | Before more is built on unverified ground |
| G3 | Large | Native surfaces that live up to their names |
| G5 | Small | Finishes N1 |
| G4 | Large, in slices | One window at a time, each a release |
| G6 | Largest | The whole-app milestones |

## Decisions

1. **G0:** panels that do nothing are hidden until each is wired (done).
2. **G3, tables:** the native table becomes a full spreadsheet. A control is there when it is needed, gone when it is
   not, and offered before it is asked for.
3. **Order:** all of it, polished, with nothing broken, in the order above.

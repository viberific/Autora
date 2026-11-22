# One header and one right-click menu in every Panacea window

Problem: windows repeat the same chrome in different ways. Two bars stack at the top of a window, and the right-click
menu differs from app to app.

Outcome wanted: every hosted window has exactly one header bar, and every right-click in every window looks and
behaves the same (decided 2026-11-22 with the person: the Board's bar survives; the menu is one flat list).

Who / what it touches: `src/components/panacea/Board.tsx` (`pw-engine-head`), each `*Window.tsx` `pdf-bar`, `src/styles.css`
(the `:has(.pdf-bar)` folding, ~6630-6650), `office/shim/rail.js` (M1 menu), `src/components/panacea/BoardMenu.tsx`,
`spectra-editor/src/autora/edittext.ts`, `opencut-editor/src/autora/ui.ts`, `autora-3d/src/components/ModelViewer3D.tsx`,
`src/components/studio/PianoRoll.tsx`, `photo/overlay/autora.rs`, `gdevelop-editor/overlay/`, `server/handbook.ts`.

## Findings (read from code; not yet seen in screenshots)

Header
1. Two bars per window. The Board's `pw-engine-head` (icon, title, link dot, Maximise, Pin, Close) sits above the app's
   own `pdf-bar` (icon, name, Load, Save, Take control, Download, Versions). Desktop CSS hides the Board strip's
   title and floats its buttons over the right end of the app bar, but only for windows that have a `.pdf-bar`; every
   other window keeps both. This is a CSS patch over two components, not one bar.
2. Each window repeats the same JSX in its `pdf-bar`: Office, PDF, Video, Photo, 3D, Games, Music (7 copies of the
   phone Full-screen button; 6 of Load/Save). They differ: Take control only in Office/PDF/Video; Download only in
   Office/PDF; Music has an editable name field and a Export button; Photo/3D/Games show a count, not the file name.
3. The editors inside the frames add a third strip: PDF's menu/title/undo/find/export (rule 9, "top bar stays
   slim"), 3D's undo/redo/selection bar, Video's own header. Each repeats the title or undo the host bar can reach.
4. The web App window uses another bar (`app-bar`, `app-icon`, `app-control`, `app-errs`) with its own button classes,
   not `pdf-bar`, so Take control and Close look different there.
5. The bar's controls fade to opacity 0 until hover on desktop, but the name stays. Hover-only controls are hard to find.

Right-click menu
6. Only Sheets has the M1 menu (`office/shim/rail.js`: Formatting / Data / Formula / Autora, with pins). Pages and
   Slides have their own (M3, M4 are not done).
7. Board has its own `BoardMenu` (New / Open file / Add piece / View), with its own CSS (`pa-board-menu`).
8. PDF's `edittext.ts` makes an `.autora-menu` with `Edit text`, drawn by its own code.
9. Video fakes a right-click (`opencut-editor/src/autora/ui.ts`) for the agent's hand only; the person gets the editor's
   own. 3D's viewer cancels the browser menu and shows none. Music's piano roll has its own `onContextMenu`. Photo and
   Games show the editors' native menus (egui and GDevelop).
10. Five different implementations of one idea; none shares code with another.

## Decisions so far
- One bar: the Board's header. The app's `pdf-bar` content moves into it (name, Load, Save, Take control, Versions,
  Download); the app bar goes. The editors' internal top strips go after it.
- One menu: a flat list of the commands that apply, no groups, no pins. A shared component for host-side windows
  (Board, Music, 3D, Video, Games, App), the same markup/CSS shipped into each frame (PDF, Office, Photo).

## Constraints (CLAUDE.md)
- Controls appear when the work needs them (hover-only fading is the opposite of a bar that is hard to find: decide).
- Each window's handbook entry and its test change in the same commit (`server/handbook.ts`, `tests/handbook.test.ts`).
- Learn targets must still find the controls that move; the agent's hand (`pickTool`) must still press them.
- Every change that reaches the container gets a version bump and release notes (`check_release.py`).
- Tokens only (`tests/tokens.test.ts`); a new bordered field joins the shared focus rule.
- The docs already say "Change one, change all" for rail sizes; the new menu and bar go into docs/TOOL-RAIL.md.

## Open questions
- Which windows should I screenshot first to confirm items 1-5? (I could not build the editors in this environment.)
- Is Take control a header button, or should it live in the window's menu? It is the biggest item on every bar.
- Pages/Slides/Sheets menus today have grouped entries; a flat list will be long. Which entries are the 6 to 8 that matter?
- Should the hover fade of the bar's controls go (always visible) or stay?

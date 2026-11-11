# Panacea, tried as a user (2026-11-11, 0.9.x on `main`)

For: review and fixing. Every finding has a way to reproduce it, what was expected, the evidence (screenshot in
`docs/screenshots/try-2026-11-11/`) and, where I found it, the code it comes from. IDs are stable so fixes can cite them.

## Status (0.9.367, same branch)

Fixed, with tests (`tests/ui-panacea-rest.test.ts`, `tests/panacea-rest.test.ts`, the Panacea manual in `server/handbook.ts`):

| Finding | What changed |
|---|---|
| P1-1 | A surface under the conversation is no longer "in view" (the room starts at the inset); an app's window that opens out of sight is brought into view even when the camera is held |
| P1-2 | Autora's own framing shows everything only while the zoom stays ≥ 0.6; below that, the newest piece with its panels (`autoFit`, `Board.tsx`) |
| P1-3 | A jump frames the piece with the panels that are out for it |
| P1-4 | The agent's chart replaces an untouched starter chart and withdraws the standing offer beside that table |
| P1-5 (agent half) | "Autora Photo is not installed on this server…" / "…is switched off on the Tools page" instead of "its group is not available" |
| P1-6 | Maximise stays clear of the history track on every screen; the other pieces are not drawn around a maximised one |
| P1-7 (partly) | The install offer waits while an app's window is on a phone's board; window buttons are 36 px there |
| P2-1 | Folded steps read as what was done (`stepWords`); `key=value` only inside an opened step |
| P2-2 | Held-back steps show "planning first" / "yours to write" / "waited for you", never red |
| P2-3 | Removed: the document and board instruction lines, every app window's sentence, "Visible work: coming soon", "Saved as you go", the chooser's intro and footer, the hint after opening from the chooser; Load's title shortened |
| P2-4 | Chooser: no wrong "bottom-left", no tile for an app that is not installed, Explainers has its own icon, "New" only on files, inside its tile, and it asks first |
| P2-5 (partly) | "Saved as you go" gone everywhere; the canvas's button is "Save" |
| P2-6 (partly) | Documents, Presentations, PDF and boards have their own icons in the Jump dock |
| P2-7 | Pasted plain text keeps its lines and is called by its first line |
| P2-8 (partly) | A board's count includes Autora's questions ("0 cards · 2 questions") |
| P2-9 | A table's header sorts by its column (largest, smallest, own order) |
| P2-10 | The ⓘ reason is drawn at screen size |
| P2-12 (partly) | The in-thread to-do marker no longer says "above the message box" |
| P2-13 (partly) | An untitled document is called by its first heading |
| P2-15 | `office_create`'s description gives the real shape of a slide's `elements` |
| **App-like windows** (asked for with the fix) | One strip per window (the app's bar is the title bar, the board's buttons at its right end); all controls fade unless the person is in the window |

Not done, still open: P1-5's PDF window when its engine is missing; P1-7's sheet on a phone (does not retract on a tap, to-do
header clipped) and the remaining small buttons inside the editors; P2-5's second name in the header; P2-6's file names in the
dock's labels; P2-8's "Card colour" with nothing selected; P2-11; P2-12's empty bubble and where the finished list lands;
P2-13's `document.pdf`; P2-14 (console errors from the fetched editors); P3-1 to P3-7. Also seen while fixing: with every
editor built, `tests/ui-panacea-connect.test.ts` fails on `main` too ("Music has no node": a song can now go to Video).

## How this was tested

- The real server (`tests/e2e-harness.ts`) behind a **scripted stand-in model** (I wrote each tool call), the real page in
  headless Chromium at 1440×900 and 1600×1000, an iPhone 13 profile, and a `prefers-color-scheme: light` context.
- Built for real this time: the app, Spectra (PDF, editor and Python engine), OpenCut (Video), GDevelop (Games),
  Autora 3D, GenOffice (Pages, Sheets, Slides). **Not built:** PhotoCraft (Photo) — `trunk` is not installed here, so
  what was tested for Photo is the "not installed" path.
- Workflows run: a sales table → chart → board summary in Agent mode; a creative brainstorm on a board and a story
  chapter (guide mode); a dropped photo with sliders; pasted plain text and pasted semicolon-CSV; one chat building a
  launch kit across Sheets, Pages, Slides, PDF, Music, Video, Games, Photo and 3D; a model error, Stop mid-stream, a
  30-turn thread, moving and resizing the conversation, Visible work, the permission menu, the capability chooser, Load,
  "New · replace current", ⓘ / Put away / Ctrl+Z / Undo, export, reload persistence; the same data workflow on a phone.
- **Limits.** The model was scripted, so this tests how the app reacts to the agent, not what a real model would choose.
  Not tried: audio, real touch gestures, Safari/Firefox, Ask-mode approvals (my selector for the menu item missed, so the
  approval path is untested), Photo's editor.

Severity: **P1** = breaks the work or hides it; **P2** = wrong, confusing or against a stated rule; **P3** = polish.

---

## P1 — breaks the work or hides it

### P1-1. New work lands under the conversation window
`PANACEA.md` says new work is placed in the room clear of the conversation (`workViewport`). It is not, in three cases:
- Pasting plain text on the board made a "Pasted text" document that sits **behind** the conversation window (07).
- After the person enlarged the conversation window, the agent's new table **and** its bar chart were placed behind it.
  With Visible work on, the agent's cursor was clicking around in empty space to the right while the result was hidden
  (15). The person watches a hand do nothing.
- After a jump to a document, the offered "Explore" ghost panel sits under the conversation window (04).

Expected: anything new (surface, panel, ghost) is placed and revealed in the visible room; if the room is too small,
the camera moves, not the work under the chat.

### P1-2. Auto-fit makes the work unreadable every time something arrives
Each time a surface or app window arrives, the camera fits **everything** — at 0.33–0.41 zoom on desktop (01, 08) and
~0.25 with app windows (09). The table, chart and summary the person just asked for are illegible; on a phone they are
postage stamps (18). The person has to find and press a Jump button for every piece. Expected: reveal the newest piece
at a readable zoom (≥ ~0.75), with its panels, and leave Show all for when the person asks for it.

### P1-3. "Jump to <work>" frames the surface but not its panels
- Jump to the sales table: the Line chart, Category filter and Explore panels are all off-screen to the right
  (measured at x ≥ 1220 on a 1440 page, and under the Jump dock) (03).
- Jump to the document: Text style and Typography are cut off at the right edge and under the dock (04).
Expected: a jump frames the surface with its live panels, clear of the dock and the conversation.

### P1-4. The chart the person asked for ends up dimmed, among charts they did not ask for
"Chart revenue by region and write a summary": the agent placed `data.bar` (what was asked). Result on the canvas:
an automatic **Line chart** (revenue by month, summed across regions — not asked), the **Explore** ghost (another
revenue-by-region bar chart), and the requested **Bar chart** placed *below* the table and **dimmed** because focus moved
to the summary (01, 02). Three charts for one request, and the asked-for one is the faintest.
Expected: when the agent places the chart the person asked for, the starter chart and the Explore offer that duplicate
it are not added (or are put away), and focus fading does not dim the panel the person's own request produced.

### P1-5. A missing engine still fails badly (open since the 2026-11-05 report, finding 4)
- Photo: `photo_open` returns `"photo_open" exists but its group is not available right now. The tools you have are: …`
  — the agent cannot tell the person "Photo is not installed". The chooser knows ("Images · Not installed on this
  server"), the agent does not. Card: red "1 FAILED", no reason shown.
- PDF (before I built its Python engine): the PDF window opened over a fully enabled Home page and All-tools grid with a
  modal "Could Not Open — the PDF engine is not installed on this server" and an OK button, while the header said
  "Saved as you go" (10). `pdf_compose` meanwhile reported success ("Composed a document … shown in the conversation").
Expected: one health check that tells the agent which engines are missing, so it says so; a window whose engine is
missing says so in place of its tools, without a modal and without "Saved as you go".

### P1-6. Maximise does not fill the work area
Maximising the PDF window: the neighbouring Documents window shows at the right edge, the Spreadsheets grid shows under
the bottom edge, the history track (undo/redo slider) is drawn over the window's foot, and the Jump dock overlaps its
right side (11). Expected (per `PANACEA.md`): it fills the visible work area at its real size, nothing else showing.

### P1-7. Phone: the window's controls are under a banner and the work is too small to use
- The "Install Autora on this device" banner covers the Music window's title bar, so its Maximise / Pin / Close cannot be
  reached (17, panels 5–6).
- The data workflow's table and chart arrive at ~0.2 scale above a sheet that takes half the screen; tapping the canvas
  does not retract the sheet (18). The to-do card's header ("To do · 2 of 2 done") is clipped at the top of the sheet.
- 17 controls in view are under 32 px: window Maximise 17×21, Pin 19×20, Close 17×21, Music's Load/Save/Export/Undo/
  Redo 30–31 px, Undo/Redo 26×26, ghost "Not now" 40×24.

---

## P2 — wrong, confusing, or against a stated rule

### P2-1. Raw tool arguments in the thread
Collapsed step cards show `done=1 item start=2`, `ops=1 item`, `csv=Month,Region,Revenue 2025-07,…`,
`new={"width":800,"height":60…`, `type=pptx name=Pitch spec={"pages":[{"shapes":…` in monospace (01, 05, 13, 14).
Source: `src/components/ToolCell.tsx:53` (`${k}=${shortValue(v)}`). The rule is no plumbing shown to the person; the
2026-11-05 report (finding 8) flagged the same cards. Expected: the friendly status line, or the summary a person would
write ("Ticked 1, started 2").

### P2-2. The app's own guard rails are shown as red failures
- On the story board (guide mode) the agent tried to add a card: correctly refused, shown as red **"1 FAILED"** (05).
- In Agent mode every write before `set_mode build` is refused and shown as red **"1 FAILED" / "2 FAILED"** (14).
The person sees errors where the protection worked. Expected: a neutral chip ("held back: the words are yours",
"planning first"), red only for real failures.

### P2-3. Standing instruction text, against the 2026-11-05 rule ("no standing instructions … no plumbing")
- Document bar: "Every change is a step you can undo" / "Autora formats and structures; the words are yours"
  (`src/components/panacea/DocView.tsx:139`) (04).
- Board bar: "Double-click for a card · drag its dot onto another to link" (`BoardView.tsx:173`) (05).
- Every app window's header carries a sentence: "Read, edit, fill, sign and organize pages. Use the floating bar or All
  tools for the selected page.", "Work with cells, formulas and charts. Select a cell or range…", etc.
  (`src/lib/workspace.ts:7–8` and neighbours) (09–13).
- Games header: "Visible work: coming soon" (`GameWindow.tsx:163`) (13).
- Under the composer after "New · replace current": "Panels is open. Drop a photo or a table on it, or tell Autora what
  to make." (`src/App.tsx:139`) (20).
- Capability chooser intro and footer ("Commands run as collapsible cards in the conversation, not in a separate
  terminal.") (19); Load dialog title "Load a canvas, document, workbook (full Sheets), table, photo, PDF, media or saved
  song, model or game" (20).

### P2-4. The capability chooser is wrong in places (19)
- Says "the buttons at the canvas's bottom-left jump to it" — the Jump dock is at the **top right**
  (`src/components/ToolsSheet.tsx:170`; `docs/PANACEA.md` says "bottom-left" too).
- "New · replace current" is a small orphan link under the Canvas card, which makes the Canvas card shorter than its
  row-mate; it acts **with no confirmation**, and afterwards the Sales table was still on the canvas while the history
  track had reset — it is not clear what it replaced (20).
- Canvas and Explainers use the same sparkle icon. "Images — Not installed on this server" is chrome for a thing that
  cannot be used.

### P2-5. "Saved as you go" beside a Save button, everywhere; two names in the header
- The canvas bar and every app window say "Saved as you go" next to **Save** (canvas: "Save native work" — "native" is
  jargon). If it saves as you go, the person cannot tell what Save adds.
- The header shows the chat title (the first message) and, beside it, the canvas name, which stays "New Session" forever
  (01). The canvas is never named from its work.

### P2-6. The Jump dock names apps, not work; same icons for different work
Native work is listed by title ("Jump to Q3 sales"); app windows by app ("Jump to Documents", "Jump to Spreadsheets"),
not "Press release.docx" / "Budget.xlsx". Documents and PDF share one file icon, so the dock shows two identical
icons (09).

### P2-7. Pasted plain text loses its line breaks
Pasting "Meeting notes⏎We agreed to ship Friday.⏎Ana owns QA." made one paragraph: "Meeting notes We agreed to ship
Friday. Ana owns QA." (08). `PanaceaWindow.tsx:619` → `createDoc` → `blocksFromText` reads it as Markdown, where a
single newline is a space. Plain pasted text should keep its lines.

### P2-8. Board counts disagree; a control with nothing to act on (05)
The board header says "0 cards" while two question cards are on it; the Board panel repeats the counts (0 Cards,
0 Links, 2 Questions) and shows "Card colour: yellow" with no card selected.

### P2-9. Tables look like spreadsheets but do not act like them
Clicking a column header does not sort; double-clicking a cell does not edit it. Sorting and filtering only through
panels. Either make the header sort, or do not draw it like a sortable header.

### P2-10. The ⓘ "Why is this here?" popover is drawn at the world's zoom
At the auto-fit zoom the popover's text is unreadable (20, top right). The content itself is good ("A table arrived: a
chart of it, and a filter for its categories. · It came with the work · Not this"). It should be drawn at screen scale.

### P2-11. The conversation window loses the current turn
After enlarging the window, it stayed scrolled to the middle of the thread while a new turn ran, so the current work was
out of view (15); the "New messages" pill sits over the text of the bubble under it; the top fade clips the first
visible bubble (16).

### P2-12. To-do card and empty bubbles during a turn
- While the turn runs the to-do card docks above the composer (good), but the thread shows a marker reading
  "To do · 0 of 3 done · **above the message box**" — a pointer at the UI (02).
- After the turn ends the card moves into the middle of the history, between the first steps and "Building" (01).
- An "AUTORA" bubble with no text is shown while tools run (02, second frame).

### P2-13. Work named generically
A document the agent made without a `title` is called "Document" although its first line is the heading "Notes" (14);
`pdf_compose` saves "document.pdf" for "Lumen one-pager".

### P2-14. Console and network errors in normal use
- Sheets: `404 /office-app/sheets/Carlito-Regular-Cbe9FLjp.ttf` (`dist/office/web/sheets/` has no such file).
- PDF: `400 /api/spectra/invoke` two to four times on every PDF window open, also with the engine installed.
- Video: `Failed to load project: Error: Project with id new not found` on `video_open {new}`; the turn took 4.6–4.9 s with
  no progress text.
- Games: eight-plus blocked requests to `api.gdevelop.io` (shop, assets, achievements, announcements, tutorials) refused
  by the frame's CSP, each logged as an error.

### P2-15. Slides: the tool's description does not match its validator
`office_create` pptx's description says the deck is "a 1280x720 px canvas of shapes", `{pages:[...]}`. A page with
`shapes` fails: `the "elements" array is missing or empty`; with `elements: [{type:"text", text:…}]` it fails again:
`text element without any text, dropped`. An agent following the description fails twice before reading `office_guide`.

---

## P3 — polish

- **P3-1.** No light theme. All six themes are dark and nothing reads `prefers-color-scheme`; a light OS gets dark (checked).
- **P3-2.** The left rail's context gauge is a bare "62%" and a bar with no label (57–65% after one tiny turn with an
  unknown model, so it assumes a small window). On a phone the permission pill sometimes shows as a bare dot (17).
- **P3-3.** The Explore ghost is offered on every new table, even right after the agent placed the same chart.
- **P3-4.** Games' scene is a white canvas inside the dark app (13). Video's window behind Music shows its Export button
  with a bright focus ring through the gap (12).
- **P3-5.** The dropped photo is drawn with a dark band down its left edge inside its frame (06).
- **P3-6.** Mode-switch note in the thread: "The chat's mode is now Build. Does the work straight away, and shows each step
  as it happens." — reads like a settings description, not a message.
- **P3-7.** Agent mode makes every turn start in planning, including one-line follow-ups ("Make a notes page"): a
  Planning badge, a refused call, a switch, then the work. Correct by design, but it is visible friction on small asks.

---

## What worked (keep it)

- Guide mode holds: the agent's attempt to write a story card was refused; questions appear as "Autora asks" cards; the
  person's own card is recorded as theirs (`by: person`).
- A dropped photo gets Light and Colour beside it at once; the exposure slider is live; the Looks ghost drifted away
  after ~45 s untouched.
- A semicolon CSV with a quoted comma pasted correctly typed (`name:text, age:number, city:text`).
- Put away → "1 put away" chip; Ctrl+Z brought it back; export saved the table "as filtered".
- Stop mid-stream ends cleanly ("Turn interrupted by user"); empty Enter sends nothing; Shift+Enter makes a line.
- A 30-turn thread scrolls smoothly; "New messages" appears when scrolled up.
- The conversation window moves, snaps to the right side (the Jump dock moves out of its way), resizes, and resets on
  double-click.
- Reload keeps the canvas, the thread and all six app windows (they remount in ~7 s).
- No page errors from Autora's own code on any path.

## Screenshots (`docs/screenshots/try-2026-11-11/`)

| # | What |
|---|---|
| 01 | Data workflow finished: everything at 0.33 zoom; requested Bar chart dimmed under the table; raw `done=1 item` |
| 02 | The same turn live (6 frames): to-do docked, "above the message box" marker, empty AUTORA bubble |
| 03 | Jump to the table: its panels off-screen and under the dock |
| 04 | Jump to the document: Explore ghost under the chat, Text style under the dock, standing text in the doc bar |
| 05 | Story board: guard rail shown as "1 FAILED"; "0 cards" with two cards; instruction line |
| 06 | Dropped photo with Light, Colour and the Looks ghost |
| 07 | Pasted text document placed behind the conversation window |
| 08 | Show all: line breaks lost in the pasted text; everything tiny |
| 09 | Six app windows auto-fitted to ~0.25; two identical file icons in the dock |
| 10 | PDF window with its engine missing: modal over enabled tools, "Saved as you go" |
| 11 | Maximised PDF with neighbours, history track and dock over it |
| 12 | Music; Video's Export button glowing through the gap |
| 13 | Games: "Visible work: coming soon", white scene, header sentence |
| 14 | Agent mode small task: planning refusal shown as "1 FAILED"; document called "Document" |
| 15 | Visible work: the agent's hand on empty canvas; its table and chart behind the enlarged chat |
| 16 | Conversation window: long thread, scrolled up, moved, snapped right |
| 17 | Phone: empty, sending, done, Music under the install banner |
| 18 | Phone: data workflow at ~0.2 scale; sheet does not retract |
| 19 | Capability chooser: wrong "bottom-left", orphan "New · replace current", shared icon |
| 20 | Jump with panels off-screen; ⓘ at world scale; Load dialog title; after "replace current" with composer hint |

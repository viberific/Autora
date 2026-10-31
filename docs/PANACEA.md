# Panacea

**Panacea is the single workspace for all creative and productivity work.** Documents, spreadsheets, presentations,
PDFs, images, video, music, 3D, games, apps, browsing and interactive explainers are integrated capabilities inside it,
not standalone applications. The existing engines remain: removing their separate application chrome must not remove
their editing, import, export, agent or live-hand abilities.

The **Capabilities** chooser starts a blank file/project. **All work lives in one spatial scene**: native images, data,
documents and boards, plus every retained engine's real work card, inside the same Board and camera. There are no
Panacea/Music tabs, no work-mode combobox and no nested canvas application. The **fixed right-side icon dock** jumps the
camera to actual existing work; **Zoom out** reduces magnification; **Show all work [ ]** fits every native and hosted
surface without hiding any of them. Hosted card headers can be dragged and pinned. **Follow** may move the camera to
the agent's work, but never while the person is typing, dragging, pinned or holding a manual camera position.
Every opened engine stays mounted when the camera changes, so a jump is not a reload and cannot discard unsaved
editor state. Web remains a real work surface; Activity is not a separate card. The Tools page
presents Panacea with capability configuration, not separate applications.

The workspace fills the available area; there is **no left chat column**. The original composer is the single
**centered Ask Autora entry**, retaining work mode, speech, attachments, notebooks, artifacts, capabilities and
Send/Stop. The **TODO list is attached above the entry**. Messages float as individual bubbles above it, without a
history panel or scrim, and older bubbles fade at the top edge. **Retract conversation** preserves the mounted
complete history and leaves the TODO/entry visible; **Show conversation** brings it back. Questions and permissions
remain immediately actionable. All tool/output/file activity is in the bubbles, **contracted by default** until
expanded, including live and failed console work. Activity is not a second world surface.

Canvas fitting waits until the surface is actually visible (hidden engines have no usable viewport), observes phone /
desktop resizing, and calculates reveals from model coordinates rather than animated rectangles. **Show all work**
frames every native surface, its controls and hosted engine cards without relocating any of them. Empty chats offer **Open Panacea**, and the composer's wrench opens its
capability chooser without spending an agent turn. Automatic pan and control revelation pause while
the person is typing or dragging; pinned panels are not auto-revealed or shifted to make room for suggestions.

There is no terminal window or interactive shared shell. Commands run non-interactively and stay in the conversation
as per-call collapsible cards, with streaming output, failure status, duration and copy. Short and empty runs collapse
too; long output can separately fold its earlier lines. **Shell commands** is still a configurable ability.

The native canvas is a blank dotted canvas where the controls come to the work. The person says what they want to do
in the centered main entry, or drops a photo or a table on the scene, and the controls for that work appear around it, built
from a library of small, calm pieces. They are there while the work needs them and go when it moves on. The agent and the
person use the same controls, at the same time.

This page is the design and the plan. The code's map is in `docs/MODULES.md` (Panacea) and `docs/MAP.md`; the agent's
manual for the workspace is `PANACEA` in `server/handbook.ts`. The workspace shell is
`src/components/PanaceaWorkspace.tsx`, with capability metadata in `src/lib/workspace.ts`. `workspaceScene.ts` preserves
engine identities; `workspace-camera.ts` supplies the checked fit/jump/anchored-zoom math. The Board renders both native
surfaces and engine cards under one world transform. Engine hand/cursor reports map local coordinates through that
transform (`frameCoordinates.ts`); off-camera hand consumers leave calls to their existing safe fallback.

**Implemented versus planned:** the unified scene, retained engine surfaces, capability chooser, centered composer,
floating/retractable conversation, attached TODO, contracted activity, right icon dock, one shared camera,
show-all fitting and follow/manual camera protection are implemented. Canvas adaptation continues to use its existing
rules, selection-driven panels and learned profile. This does **not** imply a common operation log across engines,
native replacements for every editor, or new adaptive controls for every engine selection. Each integrated engine
still supplies its own live controls, model, save/export and history. See `docs/PANACEA-ENGINE.md` for that future work.

## What it is made of

- **Atoms** (`src/lib/panacea/atoms.ts`): the smallest pieces. Layout (stack, row, group, divider), display (label, note,
  stat, meter, badge), controls (slider, knob, stepper, toggle, segmented, select, chips, swatches, color, text, range, xy,
  curve, button, list, pads, lanes), views of a surface (histogram, chart, table), and `bespoke` (below). Each is drawn
  natively by the window (`src/components/panacea/Atoms.tsx`) in Autora's tokens, so anything composed looks like Autora.
- **Recipes**: a panel is a tree of atoms. The **rulebook** (`checkTree` in `src/lib/panacea/recipe.ts`) is what the agent
  cannot step outside: only known atoms and props, binds to what a surface declares (with a control of the right kind),
  depth and size limits, and **at most 8 controls in view** (the rest are `advanced` and wait behind More). It repairs what it
  can (numbers clamped, words trimmed) and says exactly why it refuses the rest.
- **The library** (`src/lib/panacea/library.ts`): twenty ready-made panels for each kind of work: photo, data, general,
  documents, music, video, 3D, games, web and app design (180). Photo and data panels bind to the surface near them
  (`@image.exposure`, `@data.filter.$text`, resolved by `instantiate`); the others bind to shared values the agent reads.
  What the agent composes and the person then **uses** joins the library (`learn` in `server/panacea.ts`), deduplicated by
  shape (`fingerprint`: the same panel worded differently is one entry), with use counts that decide what is reached for
  first. A composed recipe nobody used is forgotten in a week.
- **Bespoke pieces**: when atoms cannot do it, the agent drafts a piece with the person (`panacea_bespoke`): HTML/JS in a
  sandboxed frame (`sandbox="allow-scripts"`, no same origin), shown as a dashed draft, revised with them until they press
  **Keep in library** (or say so). It talks to the canvas only by messages, and only about its declared binds.
- **Surfaces** (`src/lib/panacea/surfaces.ts`): the work. Each publishes a manifest: `params` (kind, range, options,
  default, advanced) and `actions`. A control binds to a parameter by name; nothing else is reachable. Version 1 has an
  **image** (exposure, contrast, highlights, shadows, whites, blacks, temperature, tint, vibrance, saturation, clarity, fade,
  vignette, grain, a tone curve, looks with a strength, aspect, straighten, a quarter turn, flips, zoom, before/after; reset,
  auto, export: all live on the GPU, `src/components/panacea/imagegl.ts`) and   **data** (a table from CSV, TSV, a paste, or an explicitly requested flat XLSX copy:
  a filter per column, sort, search; charts and tables of the rows as filtered; clear, export CSV).
- **Shared values**: a bind without `@` is a value of the canvas. Every control bound to the same name shows and sets the
  same value, so panels link by sharing a name (a Region chip filters the chart and the table at once, on the person's machine,
  with no model call).

## How it behaves

- **Local rules, instant** (`src/lib/panacea/rules.ts`): a surface arrives and its starters open beside it (light and colour
  for a photo; a chart and a category filter for a table) with one more offered as a ghost. A telling value offers the next
  panel (exposure pushed far: the histogram; black and white: contrast and grain; filtered to one category: its top rows).
- **The agent, on each message**: `panacea_*` tools place recipes or composed trees (`why` required: it is shown under the
  panel's ⓘ), set values, arrange, bring surfaces in, draft bespoke pieces, export.
- **The agent, watching**: while the person works, a small background model (only with the companion switch on, nothing
  running, somebody watching; at most one every 90 s and ten an hour) may offer one ghost from the library
  (`suggestNow` in `server/panacea.ts`).
- **Ghosts**: one at a time, dashed, with the reason. Add takes it; Not now waves it away; left alone it drifts off after 45
  s. A recipe waved away is not offered again on that canvas for ten minutes, and never unasked once waved away twice.
- **Fading follows the work, not a timer**: when the focus moves to another surface its panels dim; when the work moves on
  again they go to the corner chip ("2 put away"), from which one click brings one back. Pinned panels stay.
- **Why is this here?** Every panel's ⓘ says why and who placed it; **Not this** puts it away and counts as a dismissal.
- **Adapting** (`src/lib/panacea/profile.ts`, one profile per install): controls used three times come out from behind
  More; panels go on the side the person puts them; waved-away recipes go quiet; someone at home in the advanced settings
  gets denser panels (`data-density`). The turn note tells the agent what has been learned.
- **Native history**: steps on native surfaces share the track along the bottom right: Undo, Redo and a scrubber.
  Hosted engines retain their own operation/undo logs, save/export and file-fidelity paths. A shared spatial camera is
  **not** a common cross-engine operation log.
- **Visible work**: with it on, `panacea_place`, `panacea_set` and `panacea_arrange` are done in the window by the agent's
  hand (`src/lib/panacea/handsteps.ts` plans, `src/components/panacea/hand.ts` does): a library panel summoned with the grid
  double-clicked, its name typed in the picker and the result clicked; values set by dragging that slider, knob or range,
  pressing that switch, clicking that segment, swatch or chip, choosing in that menu, typing in that field; panels dragged by
  their title bars and put away with ×. What has no control on screen goes in with the finished canvas, and the result says so.
- **Creative work stays theirs** (CLAUDE.md, the core principle): for a photo's look, a story, a melody or a design, the agent
  places controls and suggests; it does not set the creative values unless asked. Words are enforced in the tool: a panel with
  text or list fields bound to shared values shows **You write** (the default) or **Autora writes** by its title, and while it
  says You write, `panacea_set` and `panacea_place` refuse those fields (`wordsOwner` in `src/lib/panacea/canvas.ts`). The
  agent switches it (`panacea_arrange` `writes`, or `writes: "agent"` on placing) only when asked or for productivity work, and
  says so; the person switches it back with one click. Not covered: a bespoke piece setting its binds from inside its frame.
- **The home for the unplanned.** Work no other window was made for (a brainstorm, a map of ideas, a planner) comes here: the
  words that bring the Panacea tools in (`server/toolload.ts`) include brainstorms, mind maps, boards of ideas and organising
  thoughts, and the tool index and the prompt's line both say so.
- **Native canvas controls.** The Canvas mode has no floating tool bar, on purpose: there is no fixed set of tools to put
  on it. Its chrome is the name, Load, Save, ask box, history and put-away chip. Other integrated modes retain their engine's
  floating tool bars and All tools grids (`docs/TOOL-RAIL.md`) within Panacea's shared workspace chrome.

## Documents

A third kind of surface (`src/lib/panacea/document.ts`, drawn by `src/components/panacea/DocView.tsx`): text edited on
the canvas itself, in Panacea's own ProseMirror schema (headings, paragraphs, bullets, numbers, quotes, code, rules;
bold, italic, underline, strike, code, link, colour). It is the first kind whose panels **follow the selection**: Bold lights
up when the caret is in bold, the Style says H2 in a heading, and pressing either applies it to what is selected. Its
parameters are read off the selection (`paramsFromState`) and applied to it (`applyParam`): `block`, `align`, `bold`,
`italic`, `underline`, `strike`, `code`, `list`, `ink` follow it; `font`, `size`, `leading` are the whole document's;
`words`, `characters`, `minutes` are read-only (`derived`). Six library panels drive it (Text style, Typography, Paragraph,
Lists, Text colour, Word count); the other fourteen document recipes still bind to shared values nothing acts on, and are
to be retired or built as the engine gains tables, headers, page setup, comments and Word files.

**Whose words.** A document has a mode, shown as a chip on it: *You write* (`guide`, the default) or *Autora writes*
(`agent`). In `guide` the agent formats and structures (`panacea_doc` `format`, `style`) and may not insert, replace or
delete words; creative writing is the person's (CLAUDE.md). In `agent` it writes, undoably. The agent may switch it for
productivity work or when asked, and says so; the person flips it back with one click. It is enforced in the tool, not the
prompt. The agent reads a document with `panacea_look doc:` (an outline and every block with the id it changes it by).

One history: the editor has no undo of its own; Ctrl+Z is the canvas's (`useCanvas`), so typing, a panel's Bold and the
agent's edits are steps on one track. Known cost: each step holds the whole document, so a very large one makes the history
heavy (a document over ~1.5 MB as JSON is refused); steps of changes (ProseMirror's own) are the planned answer.

## Boards

**Flowcharts are explicit native work**, started from Capabilities → Flowchart or the native picker, not just a renamed
mind map. The board's diagram mode supplies process, decision and start/end shapes, directed connectors and editable
connector labels, with selection controls and SVG export. Existing idea boards remain compatible and word ownership
still applies. A person can start an empty diagram in guide mode without a model turn; agent mode is explicit productivity work.

A fourth kind of surface (`src/lib/panacea/board.ts`, drawn by `src/components/panacea/BoardView.tsx`) for thinking in space:
**cards** anywhere on it (a few words each, a colour), **links** between them, and Autora's **questions** as dashed cards for the
person to answer. It is the place for work that is not yet a document: a brainstorm, a mind map, a story's who / what / where /
when, a plan laid out. The person double-clicks the space for a card, double-clicks a card to change it, drags cards, drags from
a card's dot onto another to link them, and deletes what is selected; the picker (double-click the grid) offers Board. Its one
starter panel (`general.board`) follows the selection: the selected card's colour, the counts, Tidy and Ask me questions.

**Whose words**, as for documents: a board is *You write* (`guide`, the default) or *Autora writes* (`agent`), on its bar. In
`guide`, `panacea_board` lets the agent move, colour, link, unlink and tidy cards and **ask** (a card that must be a question,
removable by the agent or waved away by the person), and refuses adding, rewriting or removing the person's cards and labelling
links. That is the tutor's part of the core principle in the tool itself: it structures the brainstorm and asks, the ideas are
the person's. `panacea_look board:` reads it; `panacea_export` saves it as a Markdown outline (each cluster of linked cards a
heading, then the open questions).

Not yet: by hand with Visible work on (`docs/VISIBLE-WORK.md`), frames or groups drawn round cards, images on cards, arrows with
a direction, and a board's history being lighter than whole snapshots.

## Projects

Exports go to the chat's project folder in Artifacts. Every project folder has a notebook (`server/projectbook.ts`,
"<folder>: project notes"): each chat in it leaves one note with a line per turn (what was asked, what came of it, the files
it made). Attaching the folder to any chat (the composer's Artifacts button) brings its files and its notebook, so the work
carries on from what was decided. No model call is made for it.

## Engines: what comes next

The engine's plan (native engines, documents and code first, a work graph and operation log, selection-following binds,
authority in the schema) is `docs/PANACEA-ENGINE.md`. What follows is the earlier note on the same direction.

The direction (decided with the person who asked for Panacea): **Panacea becomes Autora's main workspace**, and the editors
Autora already runs become surfaces on it, rather than Panacea growing its own engines.

1. **The contract stays the one above.** A new surface kind adds a manifest (`paramsOf` / `actionsOf` in `surfaces.ts`),
   a view on the canvas, and an adapter that applies values through the tools the agent already uses for that editor:
   - documents (`office_*`, GenOffice), PDF (`pdf_*`, Spectra), video (`video_*`, OpenCut), 3D (`cad_*`), games (`game_*`,
     GDevelop), photo layers (`photo_*`, PhotoCraft), music (`studio_*`).
   The library's recipes for those kinds already exist and bind to shared values (`doc.font`, `music.bpm`, `video.speed`,
   `model.x`, `game.gravity`, `ui.radius`): once a kind has a surface, its recipes' binds move from `doc.font` to
   `@doc.font` and the panels start driving the editor.
   **Not every engine is equal yet.** Music, 3D and games are early: good starting points, nowhere near a Blender, and
   they will be refined over time. A surface's manifest declares only what its engine really does well today, and grows
   as the engine does; a panel never promises a control the engine behind it cannot honour. Expect these surfaces to
   change more often than Office's or the PDF's, and keep their recipes' binds easy to move.
2. **A surface can embed its editor's view** (a frame, as the windows do now) while the panels around it are Panacea's own.
   The editor's own chrome is hidden, as the tool rail did for the windows.
3. **Web and app design** gets a surface over the app window (`server/preview.ts`): the page, its components as parameters.
4. **Phone** (out of scope for v1): the canvas becomes one column, panels a sheet that rises from the bottom.

Open questions for v2: how a surface's parameters are discovered from an editor rather than written by hand; whether the
library's use counts should be per person when Autora has more than one; how bespoke pieces are reviewed before they are
shared (the Autora Store, `docs/BACKLOG.md`).

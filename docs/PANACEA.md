# Panacea

A blank dotted canvas where the controls come to the work. The person says what they want to do (in the chat, or the box
along the bottom of the canvas), or drops a photo or a table on it, and the controls for that work appear around it, built
from a library of small, calm pieces. They are there while the work needs them and go when it moves on. The agent and the
person use the same controls, at the same time.

This page is the design and the plan. The code's map is in `docs/MODULES.md` (Panacea) and `docs/MAP.md`; the agent's
manual for the window is `PANACEA` in `server/handbook.ts`.

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
  auto, export: all live on the GPU, `src/components/panacea/imagegl.ts`) and **data** (a table from CSV, TSV, XLSX or a paste:
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
- **One history**: every step, the person's and the agent's, on one track along the bottom right: Undo, Redo, and a scrubber.
- **Visible work**: with it on, `panacea_place`, `panacea_set` and `panacea_arrange` are done in the window by the agent's
  hand (`src/lib/panacea/handsteps.ts` plans, `src/components/panacea/hand.ts` does): a library panel summoned with the grid
  double-clicked, its name typed in the picker and the result clicked; values set by dragging that slider, knob or range,
  pressing that switch, clicking that segment, swatch or chip, choosing in that menu, typing in that field; panels dragged by
  their title bars and put away with ×. What has no control on screen goes in with the finished canvas, and the result says so.
- **Creative work stays theirs** (CLAUDE.md, the core principle): for a photo's look, a story, a melody or a design, the agent
  places controls and suggests; it does not set the creative values unless asked.
- **No tool rail.** Panacea is the one window without the floating tool bar of `docs/TOOL-RAIL.md`, on purpose: there is no
  fixed set of tools to put on it. Its only chrome is the top bar (name, Load, Save), the ask box, the history and the put
  away chip.

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

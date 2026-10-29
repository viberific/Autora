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
  curve, button, list, pads, lanes, tools: a surface's tool palette), views of a surface (histogram, chart, table, layers),
  and `bespoke` (below). A button runs a surface's command with its arguments (`action: "@image.layer.copy"`, `args`) or
  sets a value, a surface's parameter included (`set:@image.tool="lasso"`). Each is drawn
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
- **Surfaces and their engines** (`src/lib/panacea/surfaces.ts`): the work. Every surface kind is one of Panacea's own
  engines, and every engine keeps one contract (below, "Engines"): `paramsOf` (what a control can bind to: kind, range,
  options, default, advanced), `commandsOf` (what can be done, with typed arguments, grouped: the map the person's buttons,
  keys and tools and the agent's `panacea_do` all use) and `toolsOf` (what a pointer does on it). A control binds to a
  parameter by name; nothing else is reachable. Two engines so far: the **image** (below) and **data** (a table from CSV,
  TSV, XLSX or a paste: a filter per column, sort, search; charts and tables of the rows as filtered; clear, export CSV).
- **Shared values**: a bind without `@` is a value of the canvas. Every control bound to the same name shows and sets the
  same value, so panels link by sharing a name (a Region chip filters the chart and the table at once, on the person's machine,
  with no model call).

## The image engine

`src/lib/panacea/image.ts` (the model and every command, pure), `mask.ts` (selections as pixels, pure),
`src/components/panacea/{imagegl,compose,segment,Surfaces}.ts(x)` (the renderer, the layers put together, object select, the
tools on the picture).

- **Develop**: exposure, contrast, highlights, shadows, whites, blacks, white balance, vibrance, saturation, clarity,
  sharpen, blur, dehaze, colour by hue (hue, saturation and luminance for eight bands), grading (a tint in the shadows and one
  in the highlights, with a balance), a tone curve, fade, vignette, grain, looks with a strength. Live on the GPU in two passes:
  develop at the photo's size, then present through the geometry (aspect, straighten, a quarter turn, flips, zoom, a free crop).
- **Selection**: shapes combined in order by add, subtract and intersect (Shift and Alt as a person drags, or the Mode):
  Rectangle, Ellipse, Lasso, Polygon lasso, Brush select, Magic wand (tolerance, contiguous), Colour range, and **Object
  select**: a click, and MediaPipe's interactive segmenter finds the thing there, in the browser (its wasm is bundled; the
  model is fetched once by the server and kept; no picture leaves the machine). Select subject tries the centre and the
  thirds. Then feather, grow or shrink, invert. Kept as shapes, not pixels, so it is exact at any size, describable to the
  agent, and undoable; shown as marching ants.
- **Layers**: the photo; a copy (or cut) of the selection, which the Move tool drags; a placed picture; a fill; paint
  (brush strokes); text (words, size, colour, font, bold, align, shadow); a healed patch (Remove: the selection filled in from
  around it). Each has visibility, opacity, a blend mode, a place, and a layer mask the Eraser and Delete take away from.
- **Local adjustments**: the selection kept with develop sliders of its own (exposure, contrast, highlights, shadows,
  temperature, tint, vibrance, saturation, clarity, blur, amount), at most six, each one texture on the GPU.
- **Tools on the picture**: Pointer, Move, Rectangle, Ellipse, Lasso, Polygon lasso, Magic wand, Brush select, Object
  select, Colour range, Crop (a frame with handles, the aspect kept), Brush, Eraser, Heal, Text, Eyedropper; each with a key.
- **The controls come to it**: a photo arrives with its Tools (opposite its panels, as a tool bar), Light and Colour; a
  selection brings the Selection panel and deselecting puts it away; Adjust brings the adjustment's own sliders; text brings
  its words and type; a layer brings Layers. The library has thirty photo panels, the engine's tools among them.
- **The agent** sees the picture (`panacea_look` with `surface`, with a grid of tenths so it can name a point) and the
  engine's map (every tool and command with its arguments), and works it with `panacea_do`: the same commands, in order, with
  points as it sees them. With Visible work on its cursor does them in the window: picks the tool, drags, traces, clicks,
  types.
- **Export** renders everything at full size (up to 8192 on a side) as PNG or JPEG.

What it is not yet: a clone stamp, content-aware fill of large areas (Remove is a smooth fill), curves and levels per channel,
noise reduction, lens corrections, RAW. Those are the next of this engine's list, not a new direction.

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
  away chip. A surface's tools are a panel like any other (a photo's Tools come with it, and go with it).

## Projects

Exports go to the chat's project folder in Artifacts. Every project folder has a notebook (`server/projectbook.ts`,
"<folder>: project notes"): each chat in it leaves one note with a line per turn (what was asked, what came of it, the files
it made). Attaching the folder to any chat (the composer's Artifacts button) brings its files and its notebook, so the work
carries on from what was decided. No model call is made for it.

## Engines: what comes next

The direction (decided with the person who asked for Panacea, and corrected since): **Panacea is Autora's main workspace,
and it has engines of its own.** The editors Autora runs in windows (PhotoCraft, GenOffice, Spectra, OpenCut) are not
surfaces on it. Each Panacea engine takes the best of them (what they can do, how a person reaches it) and is rebuilt for
the canvas: drawn by Panacea, worked by the same atoms, driven by the same commands for the person and the agent. The bar
is "everything you expect, with no mental overhead": an engine is not done until a person can do every everyday thing in
that kind of work, and the agent has a map to do it quickly.

1. **The contract.** A new engine is a surface kind with a pure model in `src/lib/panacea/<kind>.ts`: its parameters
   (`paramsOf`, including per-object ones like `layer.<id>.opacity`), its commands with typed arguments (`commandsOf`, grouped,
   with keys and what they need: a selection, the window), its tools (`toolsOf`), its **selection** (kept as data, not
   pixels or DOM ranges, so it is exact, undoable and describable), and a `run<Kind>Command` both the page and the server call.
   `runCommand` in `rules.ts` brings the controls a result needs (a selection brings what to do with it) and puts them away
   when it is gone. The page draws it and puts its tools on it; the agent reads `engineWords` and works it with `panacea_do`.
2. **The order**, each its own change, each finished before the next:
   - **Image** (done: above).
   - **Sheet**: a real grid of cells with formulas (the data surface becomes a view of it): cell and range selection, fill
     down, formats (number, date, currency), conditional colours, sort and filter, freeze, charts and pivots from a range.
   - **Doc**: text with styles and headings, a text-range selection, find and replace, lists, tables, pictures, comments,
     tracked changes, page setup; export to DOCX and PDF.
   - **Slides**: slides with layouts and a theme, shapes and text boxes, multi-select, align and distribute, z-order,
     grouping, transitions; export to PPTX and PDF.
   - **PDF**: pages (reorder, rotate, delete, extract, merge), text and area selection, highlights and notes, redaction,
     form fields, signatures, OCR.
   - **Video**: tracks and clips on a timeline, a playhead and an in/out range as its selection, trim, split, ripple,
     transitions, titles, speed, audio levels, export.
   Music, 3D and games come after these and stay early until they are refined.
3. **Every engine meets the same checks**: its commands are tested in Node (`tests/panacea-<kind>.test.ts`), its tools in a
   real browser, its manual in `server/handbook.ts` says what the person sees, and Visible work does its commands by hand.
4. **Phone** (out of scope for now): the canvas becomes one column, panels a sheet that rises from the bottom.

Open questions for v2: how a surface's parameters are discovered from an editor rather than written by hand; whether the
library's use counts should be per person when Autora has more than one; how bespoke pieces are reviewed before they are
shared (the Autora Store, `docs/BACKLOG.md`).

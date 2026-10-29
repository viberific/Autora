/**
 * Panacea: the canvas window. The canvas lives on the server (server/panacea.ts) and in the window beside the chat;
 * these tools are the agent's hands on it. Surfaces are the work (a photo, a table); panels are controls built from
 * atoms and bound to a surface's parameters ("@img1.exposure") or to shared values ("budget"). The rulebook
 * (src/lib/panacea/recipe.ts) refuses anything outside the atoms, so what the agent composes always looks like Autora.
 */

import type { ToolSpec } from "../tools";

const NODE_HELP =
  "A panel is a tree of atoms: {\"atom\": \"group\", \"props\": {\"label\": \"Light\"}, \"children\": [{\"atom\": \"slider\", \"bind\": \"@image.exposure\", \"props\": {\"label\": \"Exposure\"}}]}. " +
  "Layout: stack, row, group (a titled section), divider. Show: label, note, stat, meter, badge. Controls (each needs a bind): slider, knob, stepper, toggle, " +
  "segmented (2-6 choices), select, chips (several), swatches, color, text, range (two numbers), xy, curve, list, pads (a step grid), lanes (blocks on a timeline), " +
  "button (props ask: a request sent to you with the values; or action: \"@<surface>.<command>\" with props args {...}, \"set:<value>=<json>\" or \"set:@<surface>.<parameter>=<json>\", " +
  "e.g. \"set:@image.tool=\\\"lasso\\\"\"), tools (a photo's tool palette, bind @image.tool). Views: histogram (an image), layers (a photo's layers), chart " +
  "(props kind bar|line|area|pie|scatter, x, y [columns], agg sum|mean|count|min|max), table. A bind is a surface parameter (\"@img1.exposure\", or \"@image.\" / " +
  "\"@data.\" for the one near) or a shared value name (\"budget\"): every control bound to the same name shows and sets the same value, so panels link by sharing a name. " +
  "Options are a list (strings or {value, label, color}), or \"columns\" / \"column:<name>\" / \"looks\" / \"palette\" read off the surface. Props kind, x and y may be " +
  "\"=<value name>\" to follow a shared value. At most 8 controls in view: mark the rarer ones \"advanced\": true and they wait behind More. Bindable parameters: " +
  "an image has exposure (-3..3), contrast, highlights, shadows, whites, blacks, temperature, tint, vibrance, saturation, clarity (-100..100), fade, vignette, grain " +
  "(0..100), curve (points), look, look_amount, aspect, straighten, rotate, flip_h, flip_v, zoom, compare, sharpen, blur, dehaze, hsl.<red|orange|yellow|green|aqua|blue|purple|magenta>.<hue|sat|lum>, " +
  "grade.shadows_hue, grade.shadows_sat, grade.highlights_hue, grade.highlights_sat, grade.balance, crop ([x, y, w, h]), the tools' options (tool, tool.mode, tool.size, tool.hardness, " +
  "tool.opacity, tool.tolerance, tool.contiguous, color, sel.feather, sel.grow, sel.invert), each layer's (layer.<id>.visible, opacity, blend, and by kind dx, dy, x, y, scale, angle, color, " +
  "text, size, font, bold, align, shadow) and each local adjustment's (mask.<id>.exposure, contrast, highlights, shadows, temperature, tint, vibrance, saturation, clarity, blur, amount); " +
  "a table has filter.<column> (choices, or a [lo, hi] range for a number column), sort, descending, search.";

export const panaceaSPECS: ToolSpec[] = [
  {
    name: "panacea_open",
    group: "files",
    description:
      "Open Panacea (the canvas window) beside the chat: a blank dotted canvas where the controls for the work appear when they are needed and go when they " +
      "are not. Returns the canvas and the library's index. Pass `new` (a name) to start a fresh canvas; if the canvas has work on it, that needs `replace: true` " +
      "-- only when the person asked to start over. The other panacea tools open the window themselves.",
    parameters: {
      type: "object",
      properties: {
        new: { type: "string", description: "A name for a new, empty canvas." },
        replace: { type: "boolean", description: "Allow `new` to clear a canvas that has work on it." },
      },
    },
  },
  {
    name: "panacea_look",
    group: "files",
    description:
      "Read the canvas: its surfaces (with every parameter that is not at its default), its panels (id, place, what they work on, why they are there, and each " +
      "tree), shared values, what faded lately, what the person did on it lately, and what Panacea has learned about them. Or search the library: `library` " +
      "(words, e.g. \"crop\", \"chart trend\") and/or `domain` (photo, data, general, document, music, video, 3d, game, design) list matching recipes with their trees; " +
      "`recipe` (an id) gives one recipe's whole tree as JSON, to change and place as your own. `surface` (a photo's id) shows you the picture as it is now, " +
      "with the selection outlined and a grid of tenths to place points by, and lists its engine: its layers, local adjustments, selection, tools and every " +
      "command with its arguments (for panacea_do). Read before you change anything: the person changes the canvas too. Changes nothing.",
    parameters: {
      type: "object",
      properties: {
        surface: { type: "string", description: "A photo's surface id: see it, and its engine's map." },
        grid: { type: "boolean", description: "With `surface`: draw the grid of tenths over it (default true)." },
        trees: { type: "boolean", description: "Include each panel's tree (default true)." },
        library: { type: "string", description: "Words to search the library for." },
        domain: { type: "string", description: "Only recipes for this kind of work." },
        recipe: { type: "string", description: "A recipe id: its whole tree." },
      },
    },
  },
  {
    name: "panacea_do",
    group: "files",
    risky: true,
    description:
      "Work on a photo on the canvas with its engine, the commands the person's tools and buttons run: select (select.rect, select.ellipse, select.polygon " +
      "for a lasso, select.brush, select.wand, select.color, select.object for the thing at a point, found by the segmentation model, select.subject, select.all, " +
      "select.none, select.invert, select.feather, select.grow), layers (layer.copy and layer.cut the selection to a layer, layer.fill, layer.erase deletes the " +
      "selection from the active layer, layer.remove fills it in from around it, layer.text, layer.place another picture, layer.paint, layer.erase_stroke, " +
      "layer.heal_stroke, layer.new, layer.select, layer.rename, layer.up, layer.down, layer.delete, layer.mask_clear), local adjustments (mask.add keeps the " +
      "selection with sliders of its own: a darker sky, a brighter face; mask.delete), and the frame (image.crop, image.crop_selection, image.uncrop, reset, auto, " +
      "export). `commands` run in order and stop at the first that fails. Every x, y, w, h and point is 0..1 across the picture AS SHOWN (as panacea_look " +
      "shows it), from its top left; look first to see where things are (panacea_look surface, which shows it with a grid of tenths). A selection made brings " +
      "the Selection panel, a local adjustment its own sliders, text its own panel, by themselves. panacea_look surface lists every command with its arguments. " +
      "With Visible work on your cursor does each by hand: picks the tool and drags, traces, clicks or types on the picture while the person watches. " +
      "The look of a photo is the person's: select and set up for them, and set creative values only when asked.",
    parameters: {
      type: "object",
      properties: {
        surface: { type: "string", description: "The photo's surface id (default: the one being worked on)." },
        commands: {
          type: "array",
          description: "[{\"name\": \"select.object\", \"args\": {\"x\": 0.42, \"y\": 0.55}}, {\"name\": \"mask.add\", \"args\": {\"name\": \"Dog\", \"exposure\": 0.3}}]",
          items: { type: "object", properties: { name: { type: "string" }, args: { type: "object" } }, required: ["name"] },
        },
      },
      required: ["commands"],
    },
  },
  {
    name: "panacea_surface",
    group: "files",
    risky: true,
    description:
      "Put work on the canvas, or take it off. `file` (an artifact id or a path in the working folder) adds a photo (PNG, JPEG, GIF, WebP) as an image surface or a " +
      "table (CSV, TSV, XLSX) as a data surface; `csv` adds a table from text. The panels that always help open beside it by themselves (its tools, light and colour for a " +
      "photo; a chart and a category filter for a table), and one more is offered as a ghost: you do not need to place those. `remove` (a surface id) takes a " +
      "surface off with its panels. Other kinds of work (documents, PDFs, video, 3D, games, music) are done in their own windows.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "An artifact id or a path: the photo or table to add." },
        csv: { type: "string", description: "A table as CSV or TSV text, header row first." },
        title: { type: "string", description: "What to call it on the canvas." },
        remove: { type: "string", description: "A surface id to take off the canvas." },
      },
    },
  },
  {
    name: "panacea_place",
    group: "files",
    risky: true,
    description:
      "Put a panel on the canvas, beside what it works on and on the side the person puts panels. Either `recipe` (a library id: the library has about twenty " +
      "ready-made panels for each kind of work, and what the person has used) or `tree` (a panel you compose from atoms, with a `title`). Prefer a recipe; " +
      "compose when none fits, and keep it small: two to six controls, the rest advanced. `why` is required: one sentence to the person, shown under the panel's " +
      "ⓘ, so they can say \"not this\". `ghost: true` offers it instead (dashed, with the why; the person takes it with a click or it drifts away): use that for " +
      "anything they did not ask for. `values` sets what it opens with. Creative work stays the person's: on their story, melody or design, place controls and " +
      "suggest; do not set their creative values for them unless asked. " + NODE_HELP,
    parameters: {
      type: "object",
      properties: {
        recipe: { type: "string", description: "A library recipe id, e.g. photo.light, data.bar, general.budget." },
        tree: { type: "object", description: "A panel composed of atoms (see the description)." },
        title: { type: "string", description: "Its title (required with `tree`)." },
        why: { type: "string", description: "Why it is here, one sentence to the person." },
        near: { type: "string", description: "A surface or panel id to put it beside (default: what the person is working on)." },
        ghost: { type: "boolean", description: "Offer it as a suggestion rather than place it." },
        values: { type: "object", description: "Values it opens with: {\"@image.exposure\": 0.3, \"budget\": 900}." },
        w: { type: "number", description: "Width in pixels (176-960)." },
      },
      required: ["why"],
    },
  },
  {
    name: "panacea_set",
    group: "files",
    risky: true,
    description:
      "Set values on the canvas: surface parameters (\"@img1.exposure\": 0.4, \"@dat1.filter.Region\": [\"EU\"]) and shared values (\"budget\": 1200). Each is checked " +
      "against what it is (a number in range, one of a choice's options) and the controls bound to it move. With Visible work on, your cursor moves the " +
      "person's own sliders and switches to the values while they watch.",
    parameters: {
      type: "object",
      properties: { values: { type: "object", description: "Bind -> value." } },
      required: ["values"],
    },
  },
  {
    name: "panacea_arrange",
    group: "files",
    risky: true,
    description:
      "Arrange the canvas. `move`: [{id, x, y, w}]; `remove`: panel ids to put away (they fade into the corner, where the person can bring them back; pinned " +
      "panels stay); `restore`: bring faded panels back; `accept`: take ghosts; `group` / `ungroup`: panels that move together; `titles`: {id: title}; `focus`: " +
      "the surface the work is on (the old work's panels dim, and go when the work moves on again); `name`: the canvas's name. Keep the canvas to what is in use: " +
      "put away what the work no longer needs.",
    parameters: {
      type: "object",
      properties: {
        move: { type: "array", items: { type: "object" }, description: "[{id, x, y, w}]" },
        remove: { type: "array", items: { type: "string" } },
        restore: { type: "array", items: { type: "string" } },
        accept: { type: "array", items: { type: "string" } },
        group: { type: "array", items: { type: "string" } },
        ungroup: { type: "array", items: { type: "string" } },
        titles: { type: "object" },
        focus: { type: ["string", "null"] },
        name: { type: "string" },
      },
    },
  },
  {
    name: "panacea_bespoke",
    group: "files",
    risky: true,
    description:
      "A piece made for this need when the atoms cannot do it (a colour wheel of their brand, a seating plan), worked out with the person. `draft` puts it on the " +
      "canvas as a dashed draft: `title`, `why`, `html` (a small page: HTML with inline CSS and JS, run in a sandboxed frame with Autora's colours as CSS " +
      "variables --bg --surface --text --muted --accent --border), `binds` (the values it may read and set), `height`. It talks to the canvas only by messages: it " +
      "receives {type: \"panacea:values\", values} and sends parent.postMessage({type: \"panacea:set\", key, value}, \"*\") for a key in its binds. Ask the person what " +
      "to change and `revise` (id + what changes) until they are happy; `keep` (id) puts it in the library for any canvas, once they say so (they can also press " +
      "Keep in library on it); `discard` (id) takes the draft away. Always try the atoms first.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["draft", "revise", "keep", "discard"] },
        id: { type: "string" },
        title: { type: "string" },
        why: { type: "string" },
        html: { type: "string" },
        binds: { type: "array", items: { type: "string" } },
        height: { type: "number" },
        near: { type: "string" },
        w: { type: "number" },
      },
      required: ["action"],
    },
  },
  {
    name: "panacea_export",
    group: "files",
    description:
      "Save from the canvas into the project's folder in Artifacts: `surface` (an image: the picture with every adjustment, PNG or `format` jpeg; a table: the rows " +
      "as filtered, CSV) or `panel` (a chart, as SVG). Only when the person wants a file.",
    parameters: {
      type: "object",
      properties: {
        surface: { type: "string" },
        panel: { type: "string" },
        format: { type: "string", enum: ["png", "jpeg"] },
        name: { type: "string" },
      },
    },
  },
];

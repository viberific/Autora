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
  "button (props ask: a request sent to you with the values; or action: \"@<surface>.<action>\" or \"set:<value>=<json>\"). Views: histogram (an image), chart " +
  "(props kind bar|line|area|pie|scatter, x, y [columns], agg sum|mean|count|min|max), table. A bind is a surface parameter (\"@img1.exposure\", or \"@image.\" / " +
  "\"@data.\" for the one near) or a shared value name (\"budget\"): every control bound to the same name shows and sets the same value, so panels link by sharing a name. " +
  "Options are a list (strings or {value, label, color}), or \"columns\" / \"column:<name>\" / \"looks\" / \"palette\" read off the surface. Props kind, x and y may be " +
  "\"=<value name>\" to follow a shared value. At most 8 controls in view: mark the rarer ones \"advanced\": true and they wait behind More. Bindable parameters: " +
  "an image has exposure (-3..3), contrast, highlights, shadows, whites, blacks, temperature, tint, vibrance, saturation, clarity (-100..100), fade, vignette, grain " +
  "(0..100), curve (points), look, look_amount, aspect, straighten, rotate, flip_h, flip_v, zoom, compare; a table has filter.<column> (choices, or a [lo, hi] range " +
  "for a number column), sort, descending, search; a document has block (paragraph|h1|h2|h3|quote|code), align (left|center|right|justify), bold, italic, " +
  "underline, strike, code (on/off), list (none|bullets|numbers), ink (a colour), all of which follow the person's selection, and font, size (8..32), leading " +
  "(1..2.5) for the whole document, and words, characters, minutes, which are read-only: \"@doc.words\"; a board has tone (the selected card's colour: " +
  "yellow|green|blue|pink|violet|plain), and cards, links, questions, read-only, and the action tidy.";

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
      "`recipe` (an id) gives one recipe's whole tree as JSON, to change and place as your own. `doc` (a document surface id) reads a document: its mode, the outline, " +
      "and every block with the id you change it by. `board` (a board surface id) reads a board: its mode, every card with its id, place and links. Read before you change anything: the person changes the canvas too. Changes nothing.",
    parameters: {
      type: "object",
      properties: {
        trees: { type: "boolean", description: "Include each panel's tree (default true)." },
        library: { type: "string", description: "Words to search the library for." },
        domain: { type: "string", description: "Only recipes for this kind of work." },
        recipe: { type: "string", description: "A recipe id: its whole tree." },
        doc: { type: "string", description: "A document surface id: read its outline and blocks." },
        full: { type: "boolean", description: "With `doc`: each block's whole text, not shortened." },
        board: { type: "string", description: "A board surface id: read its cards and links." },
      },
    },
  },
  {
    name: "panacea_surface",
    group: "files",
    risky: true,
    description:
      "Put work on the canvas, or take it off. `file` (an artifact id or a path in the working folder) adds a photo (PNG, JPEG, GIF, WebP) as an image surface or a " +
      "table (CSV, TSV, XLSX) as a data surface; `csv` adds a table from text. The panels that always help open beside it by themselves (light and colour for a " +
      "photo; a chart and a category filter for a table; text style and typography for a document), and one more is offered as a ghost: you do not need to place " +
      "those. `file` also takes a Markdown or text file as a document, and `document` makes one from text (Markdown: # headings, - bullets, 1. numbers, > quotes; \"\" for " +
      "a blank one). A document is the person's to write unless it is productivity work or they asked you to write it: pass `mode` \"agent\" only then, else leave it " +
      "\"guide\" and format and structure it. `board` (its title) adds a board: cards anywhere, links between them, your questions as cards; the place for a " +
      "brainstorm, a map of ideas, a story's who / what / where / when, a plan laid out. A board's words are the person's in the same way (`mode`). `remove` (a surface id) takes a surface off with its panels. Other kinds of work (PDFs, video, 3D, games, music) are " +
      "done in their own windows.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "An artifact id or a path: the photo or table to add." },
        csv: { type: "string", description: "A table as CSV or TSV text, header row first." },
        document: { type: "string", description: "A document from text or Markdown (\"\" for a blank one)." },
        board: { type: "string", description: "A new board, by its title." },
        mode: { type: "string", enum: ["guide", "agent"], description: "Who writes a new document or board: guide (the person; the default) or agent (you, for productivity work or when they asked)." },
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
      "suggest; do not set their creative values for them unless asked. The words in a panel's text and list fields are the person's (the panel says " +
      "\"You write\"): `values` for them are refused unless you pass `writes: \"agent\"`, for productivity work or when they asked you to fill it. " + NODE_HELP,
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
        writes: { type: "string", enum: ["agent"], description: "Let yourself fill its text and list fields: only for productivity work or when the person asked; say so." },
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
      "against what it is (a number in range, one of a choice's options) and the controls bound to it move. Words in a text or list field are refused " +
      "while its panel says \"You write\" (a brainstorm, a story's characters): ask and suggest in the chat; panacea_arrange writes lets you fill it when " +
      "they asked or it is productivity work. With Visible work on, your cursor moves the " +
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
      "panels stay); `restore`: bring faded panels back; `accept`: take ghosts; `group` / `ungroup`: panels that move together; `titles`: {id: title}; `writes`: {id: \"agent\"} to fill a panel's text and list fields yourself (only when they asked, or for " +
      "productivity work; say so), {id: \"person\"} to give them back; `focus`: " +
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
        writes: { type: "object", description: "{panel id: \"agent\" | \"person\"}: who writes the words in its text and list fields." },
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
    name: "panacea_doc",
    group: "files",
    risky: true,
    description:
      "Change a document on the canvas, by the block ids panacea_look doc: gives you. `ops` is a list done in order, all or none: " +
      "{op:\"format\", id, set:{block:\"h2\", align:\"center\", bold:true, list:\"bullets\", ink:\"#c2410c\"}} formats one block (always allowed); " +
      "{op:\"style\", set:{font:\"Georgia\", size:12, leading:1.6}} sets the whole document's type (always allowed); " +
      "{op:\"insert\", after:<id, or leave out for the start>, markdown:\"## Title\\n\\nText\"} adds blocks; {op:\"replace\", id, text} rewrites a block's words; " +
      "{op:\"delete\", id}; {op:\"mode\", mode:\"agent\"|\"guide\"}. Insert, replace and delete write or remove words, so they work only while the document is " +
      "yours to write (mode agent): that is productivity work (a form, a report, minutes, a letter) or what the person asked you to write. A story, a poem or anything " +
      "creative is theirs: format and structure it, ask questions, critique, brainstorm, and suggest changes in the chat; do not write it. Switching a document to " +
      "agent says so to the person, and they can switch it back from the bar on the document. Every change is a step they can undo. Returns the blocks as they are now.",
    parameters: {
      type: "object",
      properties: {
        surface: { type: "string", description: "The document surface id (default: the one in focus, or the only one)." },
        ops: { type: "array", items: { type: "object" }, description: "The changes, in order (at most 40)." },
      },
      required: ["ops"],
    },
  },
  {
    name: "panacea_board",
    group: "files",
    risky: true,
    description:
      "Change a board on the canvas, by the card ids panacea_look board: gives you. `ops` is a list done in order, all or none. Always allowed (arranging is " +
      "yours): {op:\"move\", id, x, y}; {op:\"tone\", id, tone:\"yellow\"|\"green\"|\"blue\"|\"pink\"|\"violet\"|\"plain\"}; {op:\"link\", from, to} and " +
      "{op:\"unlink\", from, to}; {op:\"tidy\"} (each set of linked cards a column); {op:\"ask\", text:\"Who wants the money most?\", near:<card id>} puts a " +
      "question on the board for the person to answer with cards of their own (it must be a question), and {op:\"remove\", id} takes one of your questions " +
      "away. Writing is not, while the board is the person's (mode guide, the default): {op:\"add\", text, near or x, y, tone}, {op:\"edit\", id, text}, " +
      "{op:\"remove\", id} on their cards, and a link's `label`. Those work only in mode agent: productivity work (a plan from a meeting, a sorted list) or what " +
      "they asked you to write; {op:\"mode\", mode:\"agent\"|\"guide\"} switches it, and you say so. On a brainstorm, a story or anything creative, ask, " +
      "group, link and suggest; the ideas are theirs. Every change is a step they can undo. Returns the cards as they are now.",
    parameters: {
      type: "object",
      properties: {
        surface: { type: "string", description: "The board surface id (default: the one in focus, or the only one)." },
        ops: { type: "array", items: { type: "object" }, description: "The changes, in order (at most 40)." },
      },
      required: ["ops"],
    },
  },
  {
    name: "panacea_export",
    group: "files",
    description:
      "Save from the canvas into the project's folder in Artifacts: `surface` (an image: the picture with every adjustment, PNG or `format` jpeg; a table: the rows " +
      "as filtered, CSV; a document or a board: Markdown) or `panel` (a chart, as SVG). Only when the person wants a file.",
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

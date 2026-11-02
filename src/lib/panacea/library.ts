/**
 * Panacea's library: ready-made panels for the work people do most, about twenty for each kind of work.
 *
 * Each is a recipe of atoms (src/lib/panacea/atoms.ts), so it is drawn like everything else, and each is a starting
 * point: the agent places one as it is, or changes it, or composes a new one from atoms; whatever the person then uses
 * joins the library beside these (server/panacea.ts keeps that part, with the use counts that decide what is reached
 * for first).
 *
 * Photo and data recipes bind to the image or table on the canvas ("@image.exposure", "@data.filter.$text": the
 * placeholders are resolved when the recipe is placed, `instantiate`). The other kinds of work (documents, music,
 * video, 3D, games, web and app design, general planning) bind to shared values the agent reads and acts on through
 * the window or tool that does that work, until those editors join the canvas as surfaces of their own.
 *
 * Shared by the server and the page, so written without DOM or Node types.
 */
import { MUSIC_TRACK } from "./apps/music";
import { MATERIALS, MODEL_PART } from "./apps/model";
import { VIDEO_CLIP } from "./apps/video";
import { GAME_OBJECT } from "./apps/game";
import { INSTRUMENTS, NOTE_NAMES, SCALE_NAMES } from "../studio/model";
import { MAX_DEPTH, type Value } from "./atoms";
import { INTENTS, type RecipeNext, type RecipeWhen } from "./intent";
import { checkTree, fingerprint, MAX_RECIPE_PARTS, type CheckContext, type Node, type RecipePart } from "./recipe";
import type { Table } from "./surfaces";

export const DOMAINS = ["photo", "data", "general", "document", "music", "video", "3d", "game", "design"] as const;
export type Domain = (typeof DOMAINS)[number];

export const DOMAIN_NAMES: Record<Domain, string> = {
  photo: "Photo", data: "Data", general: "General", document: "Documents", music: "Music", video: "Video", "3d": "3D", game: "Games", design: "Web & app design",
};

export interface Recipe {
  id: string;
  name: string;
  domain: Domain;
  about: string;
  tags: string[];
  tree: Node;
  /** Width on the canvas. */
  w: number;
  /** Shared values it starts with, unless the canvas has them already. */
  values?: Record<string, Value>;
  origin: "builtin" | "composed" | "bespoke";
  uses: number;
  /** Its shape (recipe.ts `fingerprint`), which dedupes the library. */
  fp?: string;
  at?: number;
  /** Local contextual intent; absent on old and learned recipes. */
  when?: RecipeWhen[];
  /** One-hop follow-ups, considered only when the source panel has actually been used. */
  next?: RecipeNext[];
}

// ------------------------------------------------------------ the builder --

type P = Record<string, unknown>;
const n = (atom: Node["atom"], props: P = {}, bind?: string, children?: Node[]): Node =>
  ({ atom, ...(Object.keys(props).length ? { props } : {}), ...(bind ? { bind } : {}), ...(children ? { children } : {}) });
const adv = (node: Node): Node => ({ ...node, advanced: true });

const stack = (...c: Node[]) => n("stack", {}, undefined, c);
const row = (...c: Node[]) => n("row", {}, undefined, c);
const grp = (label: string, ...c: Node[]) => n("group", { label }, undefined, c);
const note = (text: string) => n("note", { text });
const sl = (bind: string, label: string, p: P = {}) => n("slider", { label, ...p }, bind);
const kn = (bind: string, label: string, p: P = {}) => n("knob", { label, ...p }, bind);
const st = (bind: string, label: string, p: P = {}) => n("stepper", { label, ...p }, bind);
const tg = (bind: string, label: string) => n("toggle", { label }, bind);
const seg = (bind: string, label: string, options?: unknown) => n("segmented", { label, ...(options ? { options } : {}) }, bind);
const sel = (bind: string, label: string, options?: unknown) => n("select", { label, ...(options ? { options } : {}) }, bind);
const chips = (bind: string, label: string, options?: unknown) => n("chips", { label, ...(options ? { options } : {}) }, bind);
const sw = (bind: string, label: string, options: unknown) => n("swatches", { label, options }, bind);
const col = (bind: string, label: string) => n("color", { label }, bind);
const tx = (bind: string, label: string, p: P = {}) => n("text", { label, ...p }, bind);
const rg = (bind: string, label: string, p: P = {}) => n("range", { label, ...p }, bind);
const xy = (bind: string, label: string, x: string, y: string) => n("xy", { label, x, y }, bind);
const lst = (bind: string, label: string, placeholder = "Add…") => n("list", { label, placeholder }, bind);
const pads = (bind: string, label: string, cols: number, names: string[]) => n("pads", { label, cols, rows: names.length, names }, bind);
const lanes = (bind: string, label: string, names: string[], length: number, unit = "") => n("lanes", { label, lanes: names, length, ...(unit ? { unit } : {}) }, bind);
const ask = (label: string, q: string) => n("button", { label, ask: q });
const act = (label: string, action: string, tone: "plain" | "accent" = "plain") => n("button", { label, action, tone });
const stat = (bind: string, label: string, unit = "") => n("stat", { label, ...(unit ? { unit } : {}) }, bind);
const meter = (bind: string, label: string, min: number, max: number) => n("meter", { label, min, max }, bind);
const chart = (kind: string, x: string, y: string[], agg = "sum", extra: P = {}) => n("chart", { surface: "@data", kind, x, y, agg, ...extra });
const table = (limit = 50) => n("table", { surface: "@data", limit });
const hist = () => n("histogram", { surface: "@image" });

const I = (p: string) => `@image.${p}`;
const D = (p: string) => `@data.${p}`;
const DOC = (p: string) => `@doc.${p}`;

const LOOK_SWATCHES = "looks";
const SWATCHES = ["#7c5cff", "#e8c15a", "#2f9c95", "#d96ba0", "#6aa6e8", "#e8a15a", "#e2574c"];

function r(domain: Domain, id: string, name: string, about: string, tags: string, tree: Node, w = 288, values?: Record<string, Value>): Recipe {
  const key = `${domain}.${id}`;
  return { id: key, name, domain, about, tags: tags.split(" ").filter(Boolean), tree, w, ...(values ? { values } : {}), ...(INTENTS[key] ? { when: INTENTS[key] } : {}), origin: "builtin", uses: 0 };
}

// -------------------------------------------------------------- recipes --

const PHOTO: Recipe[] = [
  r("photo", "light", "Light", "exposure, contrast, highlights and shadows", "light exposure brightness contrast tone",
    grp("Light", sl(I("exposure"), "Exposure"), sl(I("contrast"), "Contrast", { centre: true }), sl(I("highlights"), "Highlights", { centre: true }), sl(I("shadows"), "Shadows", { centre: true }), adv(sl(I("whites"), "Whites", { centre: true })), adv(sl(I("blacks"), "Blacks", { centre: true })))),
  r("photo", "colour", "Colour", "white balance and saturation", "colour color temperature tint warm cool saturation vibrance",
    grp("Colour", sl(I("temperature"), "Temperature", { centre: true }), sl(I("tint"), "Tint", { centre: true }), sl(I("vibrance"), "Vibrance", { centre: true }), sl(I("saturation"), "Saturation", { centre: true }))),
  r("photo", "looks", "Looks", "a row of looks to try, and how strong", "looks presets filters style mood",
    stack(sw(I("look"), "Look", LOOK_SWATCHES), sl(I("look_amount"), "Strength", { unit: "%" })), 320),
  r("photo", "crop", "Crop & rotate", "aspect, straighten, rotate and flip", "crop rotate straighten aspect flip frame",
    grp("Crop & rotate", seg(I("aspect"), "Aspect"), sl(I("straighten"), "Straighten", { centre: true }), seg(I("rotate"), "Rotate"), adv(tg(I("flip_h"), "Flip horizontal")), adv(tg(I("flip_v"), "Flip vertical")), adv(sl(I("zoom"), "Zoom")))),
  r("photo", "curve", "Tone curve", "the tone curve over the live histogram", "curve curves tone histogram levels",
    stack(hist(), n("curve", { label: "Curve" }, I("curve"))), 304),
  r("photo", "histogram", "Histogram", "the picture's live histogram", "histogram levels clipping", stack(hist()), 256),
  r("photo", "detail", "Detail", "clarity and grain", "detail clarity sharpness texture grain", grp("Detail", sl(I("clarity"), "Clarity", { centre: true }), sl(I("grain"), "Grain"))),
  r("photo", "effects", "Effects", "vignette, grain and fade", "effects vignette grain fade", grp("Effects", sl(I("vignette"), "Vignette"), sl(I("grain"), "Grain"), sl(I("fade"), "Fade"))),
  r("photo", "compare", "Before & after", "compare with the original, reset or auto", "compare before after original reset auto",
    stack(tg(I("compare"), "Before / after"), row(act("Auto", "@image.auto"), act("Reset", "@image.reset")))),
  r("photo", "quick", "Quick fix", "one tap auto, then the two sliders that matter most", "quick fix auto enhance improve",
    stack(act("Auto fix", "@image.auto", "accent"), sl(I("exposure"), "Exposure"), sl(I("vibrance"), "Vibrance", { centre: true }), act("Reset", "@image.reset"))),
  r("photo", "white-balance", "White balance", "temperature and tint, or auto", "white balance temperature tint neutral",
    stack(sl(I("temperature"), "Temperature", { centre: true }), sl(I("tint"), "Tint", { centre: true }), act("Auto", "@image.auto"))),
  r("photo", "portrait", "Portrait", "gentle skin, bright eyes, a soft frame", "portrait face skin people soft",
    grp("Portrait", sl(I("shadows"), "Lift shadows", { centre: true }), sl(I("clarity"), "Soften", { centre: true }), sl(I("vibrance"), "Vibrance", { centre: true }), sl(I("vignette"), "Vignette"))),
  r("photo", "landscape", "Landscape", "skies, depth and colour", "landscape sky nature outdoor travel",
    grp("Landscape", sl(I("highlights"), "Sky", { centre: true }), sl(I("shadows"), "Shadows", { centre: true }), sl(I("clarity"), "Depth", { centre: true }), sl(I("vibrance"), "Vibrance", { centre: true }))),
  r("photo", "mono", "Black & white", "monochrome looks with contrast and grain", "black white mono monochrome noir",
    stack(sw(I("look"), "Look", [{ value: "mono", label: "Mono", color: "#5d5d5d" }, { value: "noir", label: "Noir", color: "#1f1f24" }, { value: "none", label: "Colour", color: "#8a8f99" }]), sl(I("contrast"), "Contrast", { centre: true }), sl(I("grain"), "Grain"))),
  r("photo", "film", "Film", "fade, grain and warmth of film", "film analog vintage retro grain fade",
    grp("Film", sl(I("fade"), "Fade"), sl(I("grain"), "Grain"), sl(I("temperature"), "Warmth", { centre: true }), sl(I("contrast"), "Contrast", { centre: true }))),
  r("photo", "straighten", "Straighten", "level the horizon, turn a quarter", "straighten level horizon rotate tilt", stack(sl(I("straighten"), "Straighten", { centre: true }), seg(I("rotate"), "Rotate"))),
  r("photo", "tone", "Tones", "highlights, shadows, whites and blacks", "tone tones range dynamic",
    grp("Tones", sl(I("highlights"), "Highlights", { centre: true }), sl(I("shadows"), "Shadows", { centre: true }), sl(I("whites"), "Whites", { centre: true }), sl(I("blacks"), "Blacks", { centre: true }))),
  r("photo", "mood", "Mood", "warmth, fade and a vignette", "mood atmosphere warm moody", grp("Mood", sl(I("temperature"), "Warmth", { centre: true }), sl(I("fade"), "Fade"), sl(I("vignette"), "Vignette"))),
  r("photo", "export", "Export", "save the picture to the project", "export save png download", stack(note("Saved to the project's folder in Artifacts, as a PNG."), act("Export PNG", "@image.export", "accent"))),
  r("photo", "social", "Social crop", "square, portrait or story crops", "social instagram square story crop",
    stack(seg(I("aspect"), "Crop", [{ value: "1:1", label: "Square" }, { value: "4:5", label: "Portrait" }, { value: "9:16", label: "Story" }, { value: "16:9", label: "Wide" }]), sl(I("zoom"), "Zoom"))),
];

const DATA: Recipe[] = [
  r("data", "bar", "Bar chart", "a measure by a category", "bar chart compare categories", stack(chart("bar", "$text", ["$number"])), 448),
  r("data", "line", "Line chart", "a measure over time or order", "line chart trend time series", stack(chart("line", "$date", ["$number"])), 448),
  r("data", "area", "Area chart", "a measure over time, filled", "area chart trend volume", stack(chart("area", "$date", ["$number"])), 448),
  r("data", "pie", "Share", "each category's share of the whole", "pie share proportion breakdown", stack(chart("pie", "$text", ["$number"])), 352),
  r("data", "scatter", "Scatter", "two measures against each other", "scatter correlation relationship", stack(chart("scatter", "$number", ["$number2"])), 448),
  r("data", "table", "Table", "the rows, as filtered", "table rows records spreadsheet", stack(table(100)), 512),
  r("data", "filter-category", "Category filter", "only the categories picked", "filter category segment group", stack(chips(D("filter.$text"), "$text"))),
  r("data", "filter-range", "Range filter", "only rows between two numbers", "filter range between numbers", stack(rg(D("filter.$number"), "$number"))),
  r("data", "search", "Search rows", "rows containing some words", "search find rows text", stack(tx(D("search"), "Search", { placeholder: "Words in any cell" }))),
  r("data", "sort", "Sort", "order the rows by a column", "sort order rank", stack(sel(D("sort"), "Sort by"), tg(D("descending"), "Largest first"))),
  r("data", "top", "Top rows", "the first ten, sorted", "top ten best ranking leaders", stack(sel(D("sort"), "Sort by"), table(10)), 448),
  r("data", "explore", "Explore", "pick what to chart and how", "explore chart pick axis kind",
    stack(row(sel("data.x", "Across", "columns"), sel("data.y", "Measure", "columns")), seg("data.chart", "Chart", [{ value: "bar", label: "Bar" }, { value: "line", label: "Line" }, { value: "area", label: "Area" }, { value: "pie", label: "Pie" }]), n("chart", { surface: "@data", kind: "=data.chart", x: "=data.x", y: "=data.y", agg: "sum" })),
    480, { "data.x": "$text", "data.y": "$number", "data.chart": "bar" }),
  r("data", "compare-series", "Compare measures", "two measures on one chart", "compare series two measures", stack(chart("line", "$date", ["$number", "$number2"])), 448),
  r("data", "averages", "Averages", "the mean of a measure by category", "average mean per", stack(chart("bar", "$text", ["$number"], "mean")), 448),
  r("data", "counts", "Counts", "how many rows per category", "count how many frequency", stack(chart("bar", "$text", [], "count")), 448),
  r("data", "overview", "Overview", "a chart over the top rows", "overview dashboard summary", stack(chart("bar", "$text", ["$number"]), table(5)), 512),
  r("data", "tools", "Data tools", "clear the filters, export the rows", "export csv clear reset", row(act("Clear filters", "@data.clear"), act("Export CSV", "@data.export", "accent"))),
  r("data", "ask", "Ask about it", "questions for Autora about what is shown", "ask explain insight analyse",
    stack(note("Autora answers about the rows as filtered now."), row(ask("Explain the trend", "Explain the trend in the data as it is filtered now."), ask("Find outliers", "Find the outliers in the rows as they are filtered now.")))),
  r("data", "share-total", "Share of total", "each category's part of the total", "share total percent contribution", stack(chart("pie", "$text", ["$number"], "sum")), 352),
  r("data", "filters", "Filters", "a category and a range together", "filters slice segment", grp("Filters", chips(D("filter.$text"), "$text"), rg(D("filter.$number"), "$number"), tx(D("search"), "Search"))),
];

const GENERAL: Recipe[] = [
  r("general", "budget", "Budget", "an amount and how it is split", "budget money spend cost", stack(sl("budget", "Budget", { min: 0, max: 10000, step: 50 }), seg("currency", "Currency", ["€", "$", "£"]), chips("budget.on", "Spend on", ["Food", "Travel", "Home", "Fun", "Savings"]))),
  r("general", "week", "Week plan", "blocks across the days of a week", "week plan schedule calendar days", stack(lanes("week", "Week", ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], 24, "h")), 520),
  r("general", "todo", "To do", "a list to tick off", "todo tasks checklist list", stack(lst("todo", "To do", "Add a task"))),
  r("general", "priorities", "Priorities", "what matters most, in order", "priorities rank order goals", stack(lst("priorities", "In order", "Add one"), seg("horizon", "Horizon", ["Today", "Week", "Month"]))),
  r("general", "pros-cons", "Pros & cons", "two lists side by side", "pros cons decide decision", row(lst("pros", "Pros"), lst("cons", "Cons")), 448),
  r("general", "recipe", "Recipe", "servings, spice and diet", "recipe cooking food servings", stack(st("servings", "Servings", { min: 1, max: 24 }), seg("spice", "Spice", ["Mild", "Medium", "Hot"]), chips("diet", "Diet", ["Vegetarian", "Vegan", "Gluten-free", "Dairy-free"]))),
  r("general", "focus", "Focus session", "length and mode of a work session", "focus pomodoro timer session", stack(st("focus.minutes", "Minutes", { min: 5, max: 120, step: 5 }), seg("focus.mode", "Mode", ["Deep", "Light", "Break"]), tg("focus.quiet", "Quiet notifications"))),
  r("general", "habits", "Habits", "days ticked for each habit", "habit tracker streak daily", stack(pads("habits", "This week", 7, ["Move", "Read", "Sleep"])), 360),
  r("general", "mood", "Mood", "energy and how it feels", "mood energy feeling check in", stack(xy("mood", "Mood", "Pleasant", "Energy")), 288),
  r("general", "rating", "Rating", "a score and a note", "rating score review feedback", stack(seg("rating", "Rating", ["1", "2", "3", "4", "5"]), tx("rating.note", "Why", { multiline: true }))),
  r("general", "compare", "Compare options", "options and what decides", "compare options choose", stack(lst("options", "Options"), chips("criteria", "What matters", ["Price", "Quality", "Speed", "Looks", "Ease"]))),
  r("general", "trip", "Trip", "days, budget and what you like", "trip travel holiday vacation", stack(st("trip.days", "Days", { min: 1, max: 60 }), sl("trip.budget", "Budget", { min: 0, max: 20000, step: 100 }), chips("trip.likes", "Into", ["Food", "Museums", "Nature", "Beaches", "Nightlife"]))),
  r("general", "workout", "Workout", "sets, reps and how hard", "workout exercise training gym", stack(row(st("sets", "Sets", { min: 1, max: 10 }), st("reps", "Reps", { min: 1, max: 50 })), sl("intensity", "Intensity", { min: 1, max: 10 }))),
  r("general", "board", "Board", "card colours, what is on the board, and tidying it", "board cards brainstorm map ideas sticky notes mind map",
    stack(sel("@board.tone", "Card colour", ["yellow", "green", "blue", "pink", "violet", "plain"]), row(stat("@board.cards", "Cards"), stat("@board.links", "Links"), stat("@board.questions", "Questions")),
      row(act("Tidy", "@board.tidy"), ask("Ask me questions", "Ask me questions on the board that help me think this through. Do not answer them for me.")), adv(act("Export Markdown", "@board.export")))),
  r("general", "flowchart", "Flowchart", "native process, decision, start and end nodes with directed connectors", "flowchart diagram workflow process decision arrows",
    stack(sel("@board.tone", "Node colour", ["yellow", "green", "blue", "pink", "violet", "plain"]), row(stat("@board.cards", "Nodes"), stat("@board.links", "Connectors")),
      note("Select a node to change its shape. Select a connector to change its direction or label. Double-click to edit words."),
      adv(row(ask("Export SVG", "Export this flowchart as a standalone SVG using panacea_export format svg. Keep its native graph editable."), ask("Export Markdown", "Export this flowchart's nodes and connectors as Markdown using panacea_export format markdown."))))),
  r("general", "brief", "Brief", "the goal, who it is for, and the tone", "brief goal audience tone", stack(tx("brief.goal", "Goal", { multiline: true }), tx("brief.audience", "For"), seg("brief.tone", "Tone", ["Friendly", "Neutral", "Formal"]))),
  r("general", "voice", "Tone of voice", "formal or casual, short or long", "tone voice writing style", stack(sl("voice.formal", "Casual ↔ formal", { min: 0, max: 100 }), sl("voice.length", "Short ↔ detailed", { min: 0, max: 100 }))),
  r("general", "notes", "Notes", "somewhere to jot", "notes jot scratch memo", stack(tx("notes", "Notes", { multiline: true }))),
  r("general", "progress", "Progress", "how far along", "progress done percent", stack(meter("progress", "Progress", 0, 100), st("progress", "Done", { min: 0, max: 100, step: 5, unit: "%" }))),
  r("general", "next", "What next", "ask Autora for the next step", "next step suggest help", row(ask("Suggest a next step", "Given what is on the canvas, suggest the next step."), ask("Tidy the canvas", "Tidy the canvas: keep what I am using, take away the rest."))),
  r("general", "question", "Questions", "a few answers in one go", "questions survey form answers", stack(seg("q.when", "When", ["Now", "Soon", "Later"]), tg("q.help", "Want help with it"), tx("q.more", "Anything else"))),
];

const DOCUMENT: Recipe[] = [
  r("document", "type", "Typography", "font and size of the whole document", "font typography type size", stack(sel(DOC("font"), "Font"), st(DOC("size"), "Size", { min: 8, max: 32, unit: "pt" }))),
  r("document", "paragraph", "Paragraph", "alignment and line height", "paragraph align line height spacing", stack(seg(DOC("align"), "Align", [{ value: "left", label: "Left" }, { value: "center", label: "Centre" }, { value: "right", label: "Right" }, { value: "justify", label: "Justify" }]), sl(DOC("leading"), "Line height", { min: 1, max: 2.5, step: 0.05 }))),
  r("document", "page", "Page setup", "size, orientation and margins", "page size margins orientation a4 letter", stack(seg("doc.paper", "Paper", ["A4", "Letter", "A5"]), seg("doc.orient", "Orientation", ["Portrait", "Landscape"]), st("doc.margin", "Margins", { min: 0, max: 60, unit: "mm" }))),
  r("document", "outline", "Outline", "the headings, in order", "outline headings structure sections", stack(lst("doc.outline", "Outline", "Add a heading"))),
  r("document", "tone", "Tone", "how it reads", "tone voice style formal", stack(sl("doc.formal", "Casual ↔ formal", { min: 0, max: 100 }), sl("doc.length", "Shorter ↔ longer", { min: -50, max: 50, centre: true }))),
  r("document", "replace", "Find & replace", "words to swap throughout", "find replace search", stack(tx("doc.find", "Find"), tx("doc.replace", "Replace with"), adv(tg("doc.case", "Match case")), ask("Replace all", "Replace every match in the document, as set in Find & replace."))),
  r("document", "styles", "Text style", "heading, quote or code, and bold, italic, underline", "style styles heading bold italic underline strike format text", stack(seg(DOC("block"), "Style", [{ value: "paragraph", label: "Text" }, { value: "h1", label: "H1" }, { value: "h2", label: "H2" }, { value: "h3", label: "H3" }, { value: "quote", label: "Quote" }, { value: "code", label: "Code" }]), row(tg(DOC("bold"), "Bold"), tg(DOC("italic"), "Italic"), tg(DOC("underline"), "Underline"), tg(DOC("strike"), "Strike")))),
  r("document", "lists", "Lists", "bullets or numbers", "lists bullets numbered", stack(seg(DOC("list"), "List", [{ value: "none", label: "None" }, { value: "bullets", label: "Bullets" }, { value: "numbers", label: "Numbers" }]))),
  r("document", "columns", "Columns", "text in columns", "columns layout gutter", stack(st("doc.columns", "Columns", { min: 1, max: 4 }), sl("doc.gutter", "Gutter", { min: 0, max: 30, unit: "mm" }))),
  r("document", "header", "Header & footer", "what runs along every page", "header footer page numbers", stack(tg("doc.header", "Header"), tg("doc.footer", "Footer"), tg("doc.numbers", "Page numbers"))),
  r("document", "table", "Insert table", "rows, columns and a header", "table insert grid", stack(row(st("doc.rows", "Rows", { min: 1, max: 50 }), st("doc.cols", "Columns", { min: 1, max: 12 })), tg("doc.headrow", "Header row"), ask("Insert it", "Insert a table as set in the Insert table panel."))),
  r("document", "spacing", "Spacing", "space around paragraphs", "spacing before after", stack(sl("doc.before", "Before", { min: 0, max: 48, unit: "pt" }), sl("doc.after", "After", { min: 0, max: 48, unit: "pt" }))),
  r("document", "colours", "Text colour", "the colour of the selected text", "colour text color ink", row(col(DOC("ink"), "Text"))),
  r("document", "count", "Word count", "words, characters and reading time", "word count length reading time", stack(stat(DOC("words"), "Words"), stat(DOC("characters"), "Characters"), stat(DOC("minutes"), "Minutes to read"))),
  r("document", "review", "Review", "track changes and comments", "review track changes comments", stack(tg("doc.track", "Track changes"), tg("doc.comments", "Show comments"))),
  r("document", "export", "Export", "the format to save in", "export pdf docx save", stack(seg("doc.format", "Format", ["PDF", "DOCX", "Markdown"]), ask("Export", "Export the document in the format set in the Export panel."))),
  r("document", "citations", "Citations", "the citation style", "citations references bibliography apa mla", stack(seg("doc.cite", "Style", ["APA", "MLA", "Chicago", "Harvard"]))),
  r("document", "readability", "Readability", "who it is for", "readability audience level plain", stack(seg("doc.audience", "Audience", ["General", "Expert", "Children"]), ask("Check it", "How readable is the document for the audience set in Readability?"))),
  r("document", "toc", "Contents", "a table of contents", "contents toc table index", stack(tg("doc.toc", "Table of contents"), st("doc.tocdepth", "Levels", { min: 1, max: 4 }))),
  r("document", "language", "Language", "language and spelling", "language spelling spellcheck", stack(sel("doc.lang", "Language", ["English (UK)", "English (US)", "Dutch", "German", "French", "Spanish"]), tg("doc.spell", "Check spelling"))),
];

// Every control here acts on the song in Autora Music (src/lib/panacea/apps/music.ts): wired, or the person's own words
// for the agent to place (chords, sections), or not here at all. The engine has no envelope, filter, compressor, groove,
// pad, arpeggiator, delay, drive, click or level meter, so there are no panels for them.
const TRACK = () => sel(MUSIC_TRACK, "Track", "tracks");
const MUSIC: Recipe[] = [
  r("music", "transport", "Transport", "tempo and loop", "transport tempo bpm loop", stack(st("music.bpm", "Tempo", { min: 30, max: 300, unit: "bpm" }), tg("music.loop", "Loop"))),
  r("music", "key", "Key", "root and scale", "key scale root mode", row(sel("music.root", "Root", [...NOTE_NAMES]), sel("music.scale", "Scale", [...SCALE_NAMES]))),
  r("music", "channel", "Channel", "level, pan, mute and solo of a track", "channel mixer volume pan mute solo", stack(TRACK(), sl("music.vol", "Volume", { min: 0, max: 100 }), kn("music.pan", "Pan", { min: -50, max: 50 }), row(tg("music.mute", "Mute"), tg("music.solo", "Solo")))),
  r("music", "drums", "Drum pattern", "sixteen steps of four drums", "drums beat pattern step sequencer", stack(pads("music.steps", "Pattern", 16, ["Kick", "Snare", "Hat", "Clap"])), 480),
  r("music", "effects", "Reverb", "how much room a track has", "effects reverb space room", stack(TRACK(), kn("music.reverb", "Reverb", { min: 0, max: 100 }))),
  r("music", "chords", "Chords", "a progression, and how it is played", "chords progression harmony", stack(lst("chords", "Progression", "Add a chord"), seg("chordstyle", "Played", ["Block", "Arp", "Strum"]), ask("Play these", "Play the chords in the Chords panel, in the way set there, in the Music window (studio_make). Use exactly the chords I wrote."))),
  r("music", "time", "Time", "tempo and time signature", "time signature meter tempo", stack(st("music.bpm", "Tempo", { min: 30, max: 300, unit: "bpm" }), seg("music.sig", "Time", ["2/4", "3/4", "4/4", "5/4", "6/8", "7/8"]))),
  r("music", "eq", "EQ", "low, mid and high of a track", "eq equaliser bass treble", stack(TRACK(), sl("music.low", "Low", { min: -12, max: 12, centre: true, unit: "dB" }), sl("music.mid", "Mid", { min: -12, max: 12, centre: true, unit: "dB" }), sl("music.high", "High", { min: -12, max: 12, centre: true, unit: "dB" }))),
  r("music", "structure", "Song structure", "sections in order", "structure verse chorus sections", stack(lst("sections", "Sections", "Verse, chorus…"), ask("Lay them out", "Lay out the sections in the Song structure panel, in that order, as clips in the Music window. Do not invent notes for them."))),
  r("music", "instrument", "Instrument", "what plays a track", "instrument sound patch", stack(TRACK(), sw("music.inst", "Instrument", INSTRUMENTS.map((i, k) => ({ value: i.id, label: i.name, color: SWATCHES[k % SWATCHES.length] }))))),
  r("music", "master", "Master", "overall level", "master output level loudness", stack(sl("music.master", "Master", { min: 0, max: 100 }))),
  r("music", "coach", "Melody coach", "questions and critique, never notes", "melody coach critique feedback ideas",
    stack(note("Autora listens to what you wrote and asks; the melody stays yours."), row(ask("Critique my melody", "Critique the melody I wrote: what works, what does not. Do not write notes."), ask("Ask me questions", "Ask me questions that would help me shape my melody. Do not write notes.")))),
  r("music", "export", "Export", "bounce the song to a WAV file", "export bounce wav", stack(ask("Bounce it", "Bounce the song to a WAV file (studio_export)."))),
];

// Every control here acts on the project in Autora Video (src/lib/panacea/apps/video.ts), on the clip picked in its Clip
// list. The editor has no colour grade, transition, stabiliser, caption engine, ducking, fades or looks, so there are no
// panels for them. Export, Markers and Scenes hold the person's choices and words for the agent to act on.
const CLIP = () => sel(VIDEO_CLIP, "Clip", "clips");
const VIDEO: Recipe[] = [
  r("video", "speed", "Speed", "faster or slower", "speed slow motion fast", stack(CLIP(), sl("video.speed", "Speed", { min: 0.25, max: 4, step: 0.05, unit: "×" }))),
  r("video", "audio", "Audio", "a clip's level and mute", "audio volume mute sound level", stack(CLIP(), sl("video.vol", "Volume", { min: -60, max: 20, step: 1, centre: true, unit: "dB" }), tg("video.mute", "Mute"))),
  r("video", "title", "Title", "the words and colour of a title", "title text caption lower third colour", stack(CLIP(), tx("video.title", "Text"), col("video.titlecolor", "Colour"))),
  r("video", "frame", "Picture", "zoom and see-through of a clip", "frame zoom scale opacity transparent fade picture", stack(CLIP(), sl("video.zoom", "Zoom", { min: 0.25, max: 3, step: 0.05 }), sl("video.opacity", "Opacity", { min: 0, max: 100, unit: "%" }))),
  r("video", "project", "Project", "aspect and frame rate of the film", "aspect ratio frame rate fps canvas size vertical square", stack(seg("video.aspect", "Aspect", ["16:9", "9:16", "1:1", "4:5"]), st("video.fps", "Frame rate", { min: 12, max: 60, unit: "fps" }))),
  r("video", "export", "Export", "resolution and format of the file", "export render resolution mp4 webm", stack(seg("video.res", "Resolution", ["720p", "1080p", "4K"]), seg("video.fmt", "Format", ["MP4", "WebM"]), ask("Export it", "Export the video in the format and resolution set in the Export panel (video_export; maxHeight 720, 1080 or 2160)."))),
  r("video", "markers", "Markers", "moments to come back to", "markers notes moments bookmarks", stack(lst("video.markers", "Markers", "0:12 the jump"), ask("Mark them", "Put a bookmark on the timeline at each moment in the Markers panel (video_project bookmark_set, with the note). Use exactly the times I wrote."))),
  r("video", "scenes", "Scenes", "the scenes in order", "scenes storyboard shots sequence", stack(lst("video.scenes", "Scenes", "Add a scene"), ask("Make them", "Make a scene for each name in the Scenes panel, in that order (video_project scene_create). Do not put clips in them unless I ask."))),
  r("video", "broll", "B-roll ideas", "ask for shots to cut in", "b-roll ideas shots cutaway", row(ask("Suggest b-roll", "Suggest b-roll shots that would fit this edit."), ask("Where to cut", "Where would cuts help the pacing?"))),
];

// Every control here acts on the model in Autora 3D (src/lib/panacea/apps/model.ts), on the part picked in its Part list.
// The modeller has no absolute rotation, light, camera, environment, render quality or printer path, so there are no
// panels for them. Shapes and Export hold what the person picked for the agent to act on.
const PART = () => sel(MODEL_PART, "Part", "parts");
const THREE_D: Recipe[] = [
  r("3d", "move", "Position", "where a part sits", "position move transform translate", stack(PART(), sl("model.x", "X", { min: -500, max: 500, centre: true, unit: "mm" }), sl("model.y", "Y", { min: -500, max: 500, centre: true, unit: "mm" }), sl("model.z", "Z (underside)", { min: -500, max: 500, centre: true, unit: "mm" }))),
  r("3d", "size", "Size", "how big a part is", "scale size resize width depth height", stack(PART(), sl("model.width", "Width", { min: 1, max: 500, unit: "mm" }), sl("model.depth", "Depth", { min: 1, max: 500, unit: "mm" }), sl("model.height", "Height", { min: 1, max: 500, unit: "mm" }))),
  r("3d", "material", "Material", "colour and finish", "material colour finish metal glass glossy", stack(PART(), col("model.color", "Colour"), seg("model.material", "Finish", [...MATERIALS]))),
  r("3d", "bevel", "Bevel", "round or flatten the edges", "bevel round edges fillet chamfer", stack(PART(), sl("model.bevel", "Size", { min: 0, max: 20, step: 0.5, unit: "mm" }), seg("model.bevelstyle", "Style", ["round", "chamfer"]))),
  r("3d", "array", "Repeat", "copies in a row", "array repeat copies pattern", stack(PART(), st("model.count", "Copies", { min: 1, max: 50 }), sl("model.gap", "Spacing", { min: 1, max: 200, unit: "mm" }), sl("model.dir", "Direction", { min: 0, max: 359, unit: "°" }))),
  r("3d", "parts", "Parts", "pick a part, show or hide it", "parts outliner objects list visible hide", stack(PART(), tg("model.visible", "Shown"))),
  r("3d", "shapes", "Shapes", "add a basic shape", "shapes primitives add cube cylinder", stack(sel("model.shape", "Shape", ["box", "roundedBox", "cylinder", "triangle", "wedge", "pentagon", "hexagon", "octagon", "star"]), ask("Add it", "Add the shape picked in the Shapes panel to the model (cad_shape_add)."))),
  r("3d", "export", "Export", "for printing or games", "export stl glb print", stack(seg("model.format", "Format", ["STL", "GLB"]), ask("Export", "Export the model in the format set in the Export panel (cad_export)."))),
];

// Every control here is wired to the game in Autora Games (src/lib/panacea/apps/game.ts) or holds the person's own
// choices and words for the agent to build, with an Ask button that has it do so. The movement behaviours have run
// speed, jump, gravity and deceleration (as "slippery"); a camera, health, score, sound, particles and the like are events
// the agent writes, and have no setting to move, so there are no panels for them.
const OBJECT = () => sel(GAME_OBJECT, "Object", "objects");
const GAME: Recipe[] = [
  r("game", "movement", "Movement", "how fast the player runs and jumps", "movement run jump player speed", stack(OBJECT(), sl("game.speed", "Run speed", { min: 0, max: 1000 }), sl("game.jump", "Jump", { min: 0, max: 1500 }))),
  r("game", "physics", "Physics", "gravity and how slippery", "physics gravity friction slippery", stack(OBJECT(), sl("game.gravity", "Gravity", { min: 0, max: 3000 }), sl("game.friction", "Grip ↔ slippery", { min: 0, max: 100 }))),
  r("game", "level", "Level sketch", "a grid of where things go", "level map layout tiles", stack(pads("game.tiles", "Level", 16, ["Sky", "High", "Mid", "Low", "Ground"]), ask("Build it", "Build the level sketched in the Level sketch panel in the game's scene: place what each marked square stands for, row by row. Use exactly the squares I marked.")), 480),
  r("game", "enemy", "Enemies", "how they behave", "enemy enemies ai behaviour", stack(seg("game.enemy", "Behaviour", ["Patrol", "Chase", "Guard"]), sl("game.aggro", "Aggression", { min: 0, max: 100 }), ask("Make them so", "Give the game's enemies the behaviour and aggression set in the Enemies panel."))),
  r("game", "rules", "Win & lose", "how a level ends", "win lose rules goal", stack(seg("game.win", "Win by", ["Reach exit", "Collect all", "Survive"]), st("game.limit", "Time limit", { min: 0, max: 600, step: 10, unit: "s" }), ask("Set the rules", "Make the level end the way set in the Win & lose panel (0 seconds is no time limit)."))),
  r("game", "inventory", "Inventory", "what the player carries", "inventory items pickup", stack(lst("game.items", "Items"), ask("Add them", "Give the player the items in the Inventory panel, with a way to pick each one up. Use exactly the items I listed."))),
  r("game", "dialogue", "Dialogue", "lines a character says", "dialogue lines npc talk story", stack(lst("game.lines", "Lines", "Hello, traveller…"), ask("Put them in", "Make a character say the lines in the Dialogue panel, in order, when the player comes near. Use my words exactly; do not write more."))),
  r("game", "powerups", "Power-ups", "what can be picked up", "power ups powerups bonus", stack(chips("game.powers", "Power-ups", ["Speed", "Shield", "Magnet", "Extra life", "Double jump"]), ask("Add them", "Add a pick-up for each power-up chosen in the Power-ups panel, with the effect its name says."))),
  r("game", "test", "Test it", "play and get notes", "test play playtest feedback", row(ask("Play-test it", "Play-test the game and tell me what feels off."), ask("Make it feel better", "Suggest small changes that would make the controls feel better; I will pick."))),
];

const DESIGN: Recipe[] = [
  r("design", "grid", "Layout grid", "columns, gutter and width", "grid layout columns gutter", stack(st("ui.cols", "Columns", { min: 1, max: 16 }), sl("ui.gutter", "Gutter", { min: 0, max: 64, unit: "px" }), sl("ui.maxw", "Max width", { min: 480, max: 1920, step: 20, unit: "px" }))),
  r("design", "type", "Type scale", "font, base size and scale", "type typography font scale", stack(sel("ui.font", "Font", ["Inter", "Geist", "Source Serif", "IBM Plex Sans", "Space Grotesk"]), sl("ui.base", "Base size", { min: 12, max: 22, unit: "px" }), sl("ui.ratio", "Scale", { min: 1.05, max: 1.6, step: 0.01 }))),
  r("design", "palette", "Palette", "brand colours", "palette colours brand theme", row(col("ui.primary", "Primary"), col("ui.secondary", "Second"), col("ui.accent", "Accent"), col("ui.bg", "Background")), 352),
  r("design", "spacing", "Spacing", "the spacing unit", "spacing padding margin rhythm", stack(sl("ui.unit", "Unit", { min: 2, max: 16, unit: "px" }))),
  r("design", "radius", "Corners", "how round the corners are", "corners radius rounded", stack(sl("ui.radius", "Radius", { min: 0, max: 32, unit: "px" }))),
  r("design", "shadows", "Depth", "shadows and elevation", "shadows depth elevation", stack(sl("ui.elev", "Elevation", { min: 0, max: 5 }), seg("ui.shadow", "Shadow", ["None", "Soft", "Sharp"]))),
  r("design", "buttons", "Buttons", "style and size", "buttons cta style", stack(seg("ui.btn", "Style", ["Solid", "Outline", "Ghost"]), seg("ui.btnsize", "Size", ["S", "M", "L"]))),
  r("design", "nav", "Navigation", "where the menu lives", "navigation nav menu header sidebar", stack(seg("ui.nav", "Menu", ["Top", "Side", "Bottom"]), tg("ui.sticky", "Stays on screen"))),
  r("design", "device", "Device", "which screen to look at", "device breakpoint mobile desktop responsive", stack(seg("ui.device", "Screen", ["Phone", "Tablet", "Desktop"]))),
  r("design", "theme", "Theme", "light, dark and contrast", "theme dark mode contrast", stack(seg("ui.mode", "Mode", ["Light", "Dark", "Auto"]), seg("ui.contrast", "Contrast", ["Soft", "Normal", "High"]))),
  r("design", "hero", "Hero", "the first thing people see", "hero headline landing", stack(tx("ui.headline", "Headline"), tx("ui.sub", "Subline"), seg("ui.heroalign", "Align", ["Left", "Centre"]))),
  r("design", "forms", "Form", "the fields it asks for", "form fields inputs signup", stack(chips("ui.fields", "Fields", ["Name", "Email", "Phone", "Company", "Message"]), tg("ui.inlabels", "Labels inside"))),
  r("design", "cards", "Cards", "cards per row, with pictures", "cards grid gallery", stack(st("ui.perrow", "Per row", { min: 1, max: 6 }), tg("ui.cardimg", "Pictures"))),
  r("design", "motion", "Motion", "how things move", "motion animation transitions easing", stack(sl("ui.dur", "Duration", { min: 0, max: 800, step: 10, unit: "ms" }), seg("ui.ease", "Feel", ["Calm", "Snappy", "Bouncy"]))),
  r("design", "icons", "Icons", "the icon style", "icons style outline filled", stack(seg("ui.icons", "Icons", ["Outline", "Filled", "Duotone"]))),
  r("design", "a11y", "Accessibility", "motion, size and contrast", "accessibility a11y contrast readable", stack(tg("ui.reduce", "Less motion"), sl("ui.textsize", "Text size", { min: 80, max: 150, unit: "%" }), ask("Check contrast", "Check the colour contrast of the design and say what fails."))),
  r("design", "components", "Components", "the pieces it needs", "components library parts", stack(lst("ui.components", "Components", "Button, card…"))),
  r("design", "sections", "Page sections", "the page, top to bottom", "sections page layout structure", stack(lst("ui.sections", "Sections", "Hero, features…"))),
  r("design", "brand", "Brand voice", "how the words sound", "brand voice copy tone", stack(sl("ui.playful", "Serious ↔ playful", { min: 0, max: 100 }), sl("ui.bold", "Quiet ↔ bold", { min: 0, max: 100 }))),
  r("design", "publish", "Publish", "where it goes live", "publish deploy launch", stack(seg("ui.target", "Publish to", ["Preview", "Live"]), ask("Publish", "Publish the design as set in the Publish panel."))),
];

export const BUILTINS: Recipe[] = [...PHOTO, ...DATA, ...GENERAL, ...DOCUMENT, ...MUSIC, ...VIDEO, ...THREE_D, ...GAME, ...DESIGN];

// Follow-ups are alternatives to offer, not automatic additions or creative edits.
for (const [id, recipe, why] of [
  ["photo.histogram", "photo.curve", "You are using the histogram: a tone curve can give finer control."],
  ["data.table", "data.sort", "You are using the matching rows: sorting may make them easier to compare."],
  ["document.paragraph", "document.lists", "You are using paragraph formatting: bullets or numbering are available if they fit your structure."],
] as const) {
  const source = BUILTINS.find((r) => r.id === id);
  if (source) source.next = [{ recipe, weight: 4, why }];
}

// ---------------------------------------------------------- using them --

/** The columns a data recipe's "$text", "$number", "$number2" and "$date" mean for a table. */
function columnTokens(table: Table | null | undefined): Record<string, string | undefined> {
  const cols = table?.columns ?? [];
  const nums = cols.filter((c) => c.type === "number");
  const text = cols.find((c) => c.type === "text") ?? cols.find((c) => c.type === "date");
  const date = cols.find((c) => c.type === "date") ?? text;
  return { $text: text?.name, $number: nums[0]?.name, $number2: nums[1]?.name ?? nums[0]?.name, $date: date?.name };
}

/**
 * A recipe made ready for a canvas: its "$text"-style column placeholders swapped for the table's columns, and then
 * checked against the canvas (which resolves "@image" and "@data" to the surfaces meant). Null with the reason when the
 * recipe cannot be placed here (a scatter needs two numeric columns).
 */
export function instantiate(recipe: Recipe, ctx: CheckContext): { tree: Node; values: Record<string, Value> } | { error: string } {
  const dataId = ctx.near?.data ?? ctx.surfaces.find((s) => s.kind === "data")?.id;
  const table = ctx.surfaces.find((s) => s.id === dataId)?.table;
  const tokens = columnTokens(table);
  let missing: string | null = null;
  const swap = (s: string): string => s.replace(/\$(text|number2|number|date)/g, (m) => {
    const v = tokens[m];
    if (!v) missing = m;
    return v ?? m;
  });
  const walk = (node: Node): Node => {
    const out: Node = { ...node };
    if (node.bind) out.bind = swap(node.bind);
    if (node.props) {
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.props)) props[k] = typeof v === "string" ? swap(v) : Array.isArray(v) ? v.map((x) => (typeof x === "string" ? swap(x) : x)) : v;
      out.props = props;
    }
    if (node.children) out.children = node.children.map(walk);
    return out;
  };
  const tree = walk(recipe.tree);
  const values: Record<string, Value> = {};
  for (const [k, v] of Object.entries(recipe.values ?? {})) values[k] = typeof v === "string" ? swap(v) : v;
  if (missing) return { error: `"${recipe.name}" needs a ${missing === "$number2" ? "second numeric" : missing === "$number" ? "numeric" : "text"} column, and the table has none.` };
  const checked = checkTree(tree, ctx);
  if (!checked.tree || checked.errors.length) return { error: `"${recipe.name}" does not fit this canvas: ${checked.errors.slice(0, 3).join(" ")}` };
  return { tree: checked.tree, values };
}

/**
 * Lego-like assembly of existing library recipes under native layout atoms. The result is an ordinary composed
 * recipe: placement, generalization, fingerprint deduplication and learning need no new storage or drawing path.
 * Defaults must agree; assembly never writes over the person's existing values.
 */
export function assembleRecipe(part: RecipePart, list: Recipe[], ctx: CheckContext, meta: Pick<Recipe, "id" | "name" | "domain" | "about" | "tags" | "w">): Recipe | { error: string } {
  let count = 0;
  const values: Record<string, Value> = {};
  const errors: string[] = [];
  const walk = (p: RecipePart, depth: number): Node | null => {
    if (++count > MAX_RECIPE_PARTS || depth > MAX_DEPTH) { errors.push("Recipe assembly is too large or too deep."); return null; }
    if ("recipe" in p) {
      const recipe = list.find((r) => r.id === p.recipe);
      if (!recipe) { errors.push(`Unknown recipe "${p.recipe}".`); return null; }
      const made = instantiate(recipe, ctx);
      if ("error" in made) { errors.push(made.error); return null; }
      for (const [key, value] of Object.entries(made.values)) {
        if (values[key] !== undefined && JSON.stringify(values[key]) !== JSON.stringify(value)) errors.push(`Conflicting defaults for "${key}".`);
        else values[key] = value;
      }
      return { ...made.tree, ...(p.advanced ? { advanced: true } : {}) };
    }
    if (p.children.length > MAX_RECIPE_PARTS) { errors.push("Recipe assembly has too many children."); return null; }
    return { atom: p.atom, ...(p.props ? { props: p.props } : {}), ...(p.advanced ? { advanced: true } : {}),
      children: p.children.map((child) => walk(child, depth + 1)).filter((child): child is Node => child !== null) };
  };
  const raw = walk(part, 0);
  if (errors.length) return { error: errors.slice(0, 3).join(" ") };
  const checked = checkTree(raw, ctx);
  if (!checked.tree || checked.errors.length) return { error: checked.errors.join(" ") };
  return { ...meta, tree: checked.tree, values, origin: "composed", uses: 0, fp: fingerprint(checked.tree) };
}

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9&]+/).filter((w) => w.length > 1);

/** Recipes that match some words, best first: name and tags weigh most, then what it is about; use counts break ties. */
export function searchLibrary(list: Recipe[], query: string, domain?: string | null, limit = 12): Recipe[] {
  const q = words(query);
  const pool = domain ? list.filter((r) => r.domain === domain) : list;
  if (!q.length) return [...pool].sort((a, b) => b.uses - a.uses).slice(0, limit);
  const scored = pool.map((r) => {
    const name = words(r.name);
    const tags = r.tags.map((t) => t.toLowerCase());
    const about = words(r.about);
    let s = 0;
    for (const w of q) {
      if (name.includes(w)) s += 5;
      else if (name.some((x) => x.startsWith(w))) s += 3;
      if (tags.includes(w)) s += 4;
      else if (tags.some((t) => t.startsWith(w))) s += 2;
      if (about.includes(w)) s += 1;
      if (r.domain === w) s += 2;
    }
    return { r, s: s ? s + Math.min(3, Math.log2(1 + r.uses)) : 0 };
  });
  return scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.r);
}

/** The library in a few lines for the agent: per kind of work, each recipe's id and what it is. */
export function libraryIndex(list: Recipe[], domain?: string | null): string {
  const lines: string[] = [];
  for (const d of DOMAINS) {
    if (domain && d !== domain) continue;
    const of = list.filter((r) => r.domain === d);
    if (!of.length) continue;
    lines.push(`${DOMAIN_NAMES[d]}: ${of.map((r) => `${r.id} (${r.name}${r.origin !== "builtin" ? `, ${r.origin}, used ${r.uses}x` : ""})`).join("; ")}`);
  }
  return lines.join("\n");
}

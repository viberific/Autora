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
import type { Value } from "./atoms";
import { checkTree, type CheckContext, type Node } from "./recipe";
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

const LOOK_SWATCHES = "looks";

function r(domain: Domain, id: string, name: string, about: string, tags: string, tree: Node, w = 288, values?: Record<string, Value>): Recipe {
  return { id: `${domain}.${id}`, name, domain, about, tags: tags.split(" ").filter(Boolean), tree, w, ...(values ? { values } : {}), origin: "builtin", uses: 0 };
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
  r("general", "palette", "Colours", "four colours side by side", "colours palette colors", row(col("c1", "One"), col("c2", "Two"), col("c3", "Three"), col("c4", "Four")), 352),
  r("general", "brief", "Brief", "the goal, who it is for, and the tone", "brief goal audience tone", stack(tx("brief.goal", "Goal", { multiline: true }), tx("brief.audience", "For"), seg("brief.tone", "Tone", ["Friendly", "Neutral", "Formal"]))),
  r("general", "voice", "Tone of voice", "formal or casual, short or long", "tone voice writing style", stack(sl("voice.formal", "Casual ↔ formal", { min: 0, max: 100 }), sl("voice.length", "Short ↔ detailed", { min: 0, max: 100 }))),
  r("general", "notes", "Notes", "somewhere to jot", "notes jot scratch memo", stack(tx("notes", "Notes", { multiline: true }))),
  r("general", "progress", "Progress", "how far along", "progress done percent", stack(meter("progress", "Progress", 0, 100), st("progress", "Done", { min: 0, max: 100, step: 5, unit: "%" }))),
  r("general", "next", "What next", "ask Autora for the next step", "next step suggest help", row(ask("Suggest a next step", "Given what is on the canvas, suggest the next step."), ask("Tidy the canvas", "Tidy the canvas: keep what I am using, take away the rest."))),
  r("general", "question", "Questions", "a few answers in one go", "questions survey form answers", stack(seg("q.when", "When", ["Now", "Soon", "Later"]), tg("q.help", "Want help with it"), tx("q.more", "Anything else"))),
];

const DOCUMENT: Recipe[] = [
  r("document", "type", "Typography", "font, size and weight", "font typography type size", stack(sel("doc.font", "Font", ["Inter", "Georgia", "Source Serif", "IBM Plex Sans", "JetBrains Mono"]), st("doc.size", "Size", { min: 8, max: 72, unit: "pt" }), seg("doc.weight", "Weight", ["Light", "Regular", "Bold"]))),
  r("document", "paragraph", "Paragraph", "alignment, line height and spacing", "paragraph align line height spacing", stack(seg("doc.align", "Align", ["Left", "Centre", "Right", "Justify"]), sl("doc.leading", "Line height", { min: 1, max: 2.5, step: 0.05 }), adv(st("doc.after", "Space after", { min: 0, max: 48, unit: "pt" })))),
  r("document", "page", "Page setup", "size, orientation and margins", "page size margins orientation a4 letter", stack(seg("doc.paper", "Paper", ["A4", "Letter", "A5"]), seg("doc.orient", "Orientation", ["Portrait", "Landscape"]), st("doc.margin", "Margins", { min: 0, max: 60, unit: "mm" }))),
  r("document", "outline", "Outline", "the headings, in order", "outline headings structure sections", stack(lst("doc.outline", "Outline", "Add a heading"))),
  r("document", "tone", "Tone", "how it reads", "tone voice style formal", stack(sl("doc.formal", "Casual ↔ formal", { min: 0, max: 100 }), sl("doc.length", "Shorter ↔ longer", { min: -50, max: 50, centre: true }))),
  r("document", "replace", "Find & replace", "words to swap throughout", "find replace search", stack(tx("doc.find", "Find"), tx("doc.replace", "Replace with"), adv(tg("doc.case", "Match case")), ask("Replace all", "Replace every match in the document, as set in Find & replace."))),
  r("document", "styles", "Styles", "a look for the whole document", "styles theme look design", stack(sw("doc.style", "Style", [{ value: "classic", label: "Classic", color: "#33302b" }, { value: "modern", label: "Modern", color: "#3b5bdb" }, { value: "warm", label: "Warm", color: "#c2410c" }, { value: "minimal", label: "Minimal", color: "#6b7280" }]))),
  r("document", "lists", "Lists", "bullets or numbers, and indent", "lists bullets numbered indent", stack(seg("doc.list", "List", ["Bullets", "Numbers", "None"]), st("doc.indent", "Indent", { min: 0, max: 6 }))),
  r("document", "columns", "Columns", "text in columns", "columns layout gutter", stack(st("doc.columns", "Columns", { min: 1, max: 4 }), sl("doc.gutter", "Gutter", { min: 0, max: 30, unit: "mm" }))),
  r("document", "header", "Header & footer", "what runs along every page", "header footer page numbers", stack(tg("doc.header", "Header"), tg("doc.footer", "Footer"), tg("doc.numbers", "Page numbers"))),
  r("document", "table", "Insert table", "rows, columns and a header", "table insert grid", stack(row(st("doc.rows", "Rows", { min: 1, max: 50 }), st("doc.cols", "Columns", { min: 1, max: 12 })), tg("doc.headrow", "Header row"), ask("Insert it", "Insert a table as set in the Insert table panel."))),
  r("document", "spacing", "Spacing", "space around paragraphs", "spacing before after", stack(sl("doc.before", "Before", { min: 0, max: 48, unit: "pt" }), sl("doc.after", "After", { min: 0, max: 48, unit: "pt" }))),
  r("document", "colours", "Text colour", "text and highlight colours", "colour highlight text color", row(col("doc.ink", "Text"), col("doc.highlight", "Highlight"))),
  r("document", "count", "Word count", "words written against a target", "word count target length", stack(stat("doc.words", "Words"), meter("doc.words", "Toward the target", 0, 2000), st("doc.target", "Target", { min: 100, max: 100000, step: 100 }))),
  r("document", "review", "Review", "track changes and comments", "review track changes comments", stack(tg("doc.track", "Track changes"), tg("doc.comments", "Show comments"))),
  r("document", "export", "Export", "the format to save in", "export pdf docx save", stack(seg("doc.format", "Format", ["PDF", "DOCX", "Markdown"]), ask("Export", "Export the document in the format set in the Export panel."))),
  r("document", "citations", "Citations", "the citation style", "citations references bibliography apa mla", stack(seg("doc.cite", "Style", ["APA", "MLA", "Chicago", "Harvard"]))),
  r("document", "readability", "Readability", "who it is for", "readability audience level plain", stack(seg("doc.audience", "Audience", ["General", "Expert", "Children"]), ask("Check it", "How readable is the document for the audience set in Readability?"))),
  r("document", "toc", "Contents", "a table of contents", "contents toc table index", stack(tg("doc.toc", "Table of contents"), st("doc.tocdepth", "Levels", { min: 1, max: 4 }))),
  r("document", "language", "Language", "language and spelling", "language spelling spellcheck", stack(sel("doc.lang", "Language", ["English (UK)", "English (US)", "Dutch", "German", "French", "Spanish"]), tg("doc.spell", "Check spelling"))),
];

const MUSIC: Recipe[] = [
  r("music", "transport", "Transport", "tempo, loop and click", "transport tempo bpm loop metronome", stack(st("music.bpm", "Tempo", { min: 30, max: 300, unit: "bpm" }), row(tg("music.loop", "Loop"), tg("music.click", "Click")))),
  r("music", "key", "Key", "root and scale", "key scale root mode", row(sel("music.root", "Root", ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]), sel("music.scale", "Scale", ["major", "minor", "dorian", "mixolydian", "pentatonic", "blues"]))),
  r("music", "channel", "Channel", "level, pan, mute and solo", "channel mixer volume pan mute solo", stack(sl("music.vol", "Volume", { min: 0, max: 100 }), kn("music.pan", "Pan", { min: -50, max: 50 }), row(tg("music.mute", "Mute"), tg("music.solo", "Solo")))),
  r("music", "drums", "Drum pattern", "sixteen steps of four drums", "drums beat pattern step sequencer", stack(pads("music.steps", "Pattern", 16, ["Kick", "Snare", "Hat", "Clap"])), 480),
  r("music", "arrange", "Arrangement", "parts along the bars", "arrangement song structure timeline", stack(lanes("music.parts", "Bars", ["Drums", "Bass", "Chords", "Lead"], 32)), 520),
  r("music", "envelope", "Envelope", "attack, decay, sustain, release", "synth envelope adsr attack release", row(kn("music.a", "Attack", { min: 0, max: 100 }), kn("music.d", "Decay", { min: 0, max: 100 }), kn("music.s", "Sustain", { min: 0, max: 100 }), kn("music.r", "Release", { min: 0, max: 100 })), 352),
  r("music", "filter", "Filter", "cutoff, resonance and type", "filter cutoff resonance lowpass", stack(seg("music.ftype", "Type", ["Low", "Band", "High"]), row(kn("music.cutoff", "Cutoff", { min: 0, max: 100 }), kn("music.res", "Resonance", { min: 0, max: 100 })))),
  r("music", "effects", "Effects", "reverb, delay and drive", "effects reverb delay drive distortion", row(kn("music.reverb", "Reverb", { min: 0, max: 100 }), kn("music.delay", "Delay", { min: 0, max: 100 }), kn("music.drive", "Drive", { min: 0, max: 100 }))),
  r("music", "chords", "Chords", "a progression, and how it is played", "chords progression harmony", stack(lst("music.chords", "Progression", "Add a chord"), seg("music.cstyle", "Played", ["Block", "Arp", "Strum"]))),
  r("music", "time", "Time", "tempo and time signature", "time signature meter tempo", stack(st("music.bpm", "Tempo", { min: 30, max: 300, unit: "bpm" }), seg("music.sig", "Time", ["3/4", "4/4", "6/8"]))),
  r("music", "eq", "EQ", "low, mid and high", "eq equaliser bass treble", stack(sl("music.low", "Low", { min: -12, max: 12, centre: true, unit: "dB" }), sl("music.mid", "Mid", { min: -12, max: 12, centre: true, unit: "dB" }), sl("music.high", "High", { min: -12, max: 12, centre: true, unit: "dB" }))),
  r("music", "compressor", "Compressor", "how much it squeezes", "compressor dynamics threshold ratio", stack(kn("music.thresh", "Threshold", { min: -60, max: 0, unit: "dB" }), kn("music.ratio", "Ratio", { min: 1, max: 20 }), adv(kn("music.attack", "Attack", { min: 0, max: 100, unit: "ms" })), adv(kn("music.release", "Release", { min: 10, max: 1000, unit: "ms" })))),
  r("music", "groove", "Groove", "swing and a human feel", "swing groove humanize feel", stack(sl("music.swing", "Swing", { min: 0, max: 100, unit: "%" }), sl("music.human", "Humanize", { min: 0, max: 100, unit: "%" }))),
  r("music", "structure", "Song structure", "sections in order", "structure verse chorus sections", stack(lst("music.sections", "Sections", "Verse, chorus…"))),
  r("music", "instrument", "Instrument", "what plays this part", "instrument sound patch", stack(sw("music.inst", "Instrument", [{ value: "keys", label: "Keys", color: "#7c5cff" }, { value: "bass", label: "Bass", color: "#2f9c95" }, { value: "pad", label: "Pad", color: "#6aa6e8" }, { value: "lead", label: "Lead", color: "#e8a15a" }, { value: "kit", label: "Drums", color: "#e2574c" }]))),
  r("music", "master", "Master", "overall level", "master output level loudness", stack(sl("music.master", "Master", { min: 0, max: 100 }), meter("music.level", "Level", 0, 100))),
  r("music", "pad", "Performance pad", "two effects on one pad", "xy pad performance perform", stack(xy("music.xy", "Pad", "Filter", "Space")), 288),
  r("music", "arp", "Arpeggiator", "pattern, octaves and rate", "arp arpeggiator pattern", stack(seg("music.arp", "Pattern", ["Up", "Down", "Up-down", "Random"]), st("music.oct", "Octaves", { min: 1, max: 4 }), seg("music.rate", "Rate", ["1/4", "1/8", "1/16"]))),
  r("music", "coach", "Melody coach", "questions and critique, never notes", "melody coach critique feedback ideas",
    stack(note("Autora listens to what you wrote and asks; the melody stays yours."), row(ask("Critique my melody", "Critique the melody I wrote: what works, what does not. Do not write notes."), ask("Ask me questions", "Ask me questions that would help me shape my melody. Do not write notes.")))),
  r("music", "export", "Export", "bounce the song", "export bounce wav mp3", stack(seg("music.format", "Format", ["WAV", "MP3"]), ask("Bounce it", "Bounce the song in the format set in the Export panel."))),
];

const VIDEO: Recipe[] = [
  r("video", "timeline", "Timeline", "clips on video, audio and title tracks", "timeline edit clips tracks", stack(lanes("video.clips", "Timeline", ["Video", "Audio", "Titles"], 120, "s")), 560),
  r("video", "trim", "Trim", "in and out points", "trim cut in out", stack(rg("video.trim", "In / out", { min: 0, max: 120, step: 0.1, unit: "s" }))),
  r("video", "speed", "Speed", "faster, slower or backwards", "speed slow motion reverse", stack(sl("video.speed", "Speed", { min: 0.25, max: 4, step: 0.05, unit: "×" }), tg("video.reverse", "Reverse"))),
  r("video", "transition", "Transition", "how one clip becomes the next", "transition fade dissolve wipe", stack(seg("video.trans", "Type", ["Cut", "Fade", "Dissolve", "Wipe"]), sl("video.transdur", "Length", { min: 0, max: 3, step: 0.1, unit: "s" }))),
  r("video", "grade", "Colour grade", "exposure, contrast and colour", "grade colour color correction", grp("Grade", sl("video.exposure", "Exposure", { min: -2, max: 2, step: 0.05, centre: true }), sl("video.contrast", "Contrast", { min: -100, max: 100, centre: true }), sl("video.sat", "Saturation", { min: -100, max: 100, centre: true }), sl("video.temp", "Temperature", { min: -100, max: 100, centre: true }))),
  r("video", "audio", "Audio", "level, fades and ducking", "audio volume fade ducking", stack(sl("video.vol", "Volume", { min: 0, max: 100 }), row(tg("video.fadein", "Fade in"), tg("video.fadeout", "Fade out")), adv(sl("video.duck", "Duck under voice", { min: 0, max: 100 })))),
  r("video", "title", "Title", "words on screen", "title text caption lower third", stack(tx("video.title", "Text"), row(col("video.titlecolor", "Colour"), seg("video.titlepos", "Where", ["Top", "Middle", "Bottom"])))),
  r("video", "frame", "Frame", "aspect, zoom and position", "frame crop aspect zoom pan", stack(seg("video.aspect", "Aspect", ["16:9", "9:16", "1:1", "4:5"]), sl("video.zoom", "Zoom", { min: 1, max: 3, step: 0.05 }), adv(xy("video.pan", "Position", "Left-right", "Up-down")))),
  r("video", "stabilise", "Stabilise", "smooth a shaky shot", "stabilise stabilize shake smooth", stack(tg("video.stab", "Stabilise"), sl("video.stabamt", "Strength", { min: 0, max: 100 }))),
  r("video", "captions", "Captions", "words of what is said", "captions subtitles transcript", stack(tg("video.captions", "Captions"), seg("video.capstyle", "Style", ["Plain", "Boxed", "Bold"]), seg("video.cappos", "Where", ["Bottom", "Top"]))),
  r("video", "export", "Export", "resolution, format and frame rate", "export render resolution mp4", stack(seg("video.res", "Resolution", ["720p", "1080p", "4K"]), seg("video.fmt", "Format", ["MP4", "WebM"]), st("video.fps", "Frame rate", { min: 12, max: 60, unit: "fps" }))),
  r("video", "markers", "Markers", "moments to come back to", "markers notes moments", stack(lst("video.markers", "Markers", "0:12 the jump"))),
  r("video", "scenes", "Scenes", "the scenes in order", "scenes storyboard shots sequence", stack(lst("video.scenes", "Scenes", "Add a scene"))),
  r("video", "pip", "Picture in picture", "a second shot in a corner", "picture in picture overlay inset", stack(xy("video.pip", "Where", "Left-right", "Up-down"), sl("video.pipsize", "Size", { min: 10, max: 60, unit: "%" }))),
  r("video", "keyframes", "Keyframes", "moments a setting changes", "keyframes animation motion", stack(lanes("video.keys", "Keyframes", ["Zoom", "Opacity"], 120, "s")), 520),
  r("video", "lut", "Looks", "a look for the whole film", "lut look grade style", stack(sw("video.lut", "Look", [{ value: "none", label: "None", color: "#8a8f99" }, { value: "teal", label: "Teal & orange", color: "#2f9c95" }, { value: "film", label: "Film", color: "#c9a27a" }, { value: "mono", label: "Mono", color: "#5d5d5d" }, { value: "warm", label: "Warm", color: "#e8a15a" }]))),
  r("video", "mix", "Audio mix", "music, voice and effects", "mix music voice sfx levels", stack(sl("video.music", "Music", { min: 0, max: 100 }), sl("video.voice", "Voice", { min: 0, max: 100 }), sl("video.sfx", "Effects", { min: 0, max: 100 }))),
  r("video", "playback", "Playback", "loop and preview quality", "playback preview loop quality", stack(tg("video.loop", "Loop"), seg("video.preview", "Preview", ["Fast", "Full"]))),
  r("video", "broll", "B-roll ideas", "ask for shots to cut in", "b-roll ideas shots cutaway", row(ask("Suggest b-roll", "Suggest b-roll shots that would fit this edit."), ask("Where to cut", "Where would cuts help the pacing?"))),
  r("video", "thumbnail", "Thumbnail", "the picture people click", "thumbnail cover poster", stack(tx("video.thumbtext", "Words"), col("video.thumbcolor", "Colour"), seg("video.thumbstyle", "Style", ["Bold", "Clean", "Photo"]))),
];

const THREE_D: Recipe[] = [
  r("3d", "move", "Position", "where it sits", "position move transform translate", stack(sl("model.x", "X", { min: -500, max: 500, centre: true, unit: "mm" }), sl("model.y", "Y", { min: -500, max: 500, centre: true, unit: "mm" }), sl("model.z", "Z", { min: -500, max: 500, centre: true, unit: "mm" }))),
  r("3d", "rotate", "Rotation", "turned about each axis", "rotate rotation orientation", row(kn("model.rx", "X", { min: -180, max: 180, unit: "°" }), kn("model.ry", "Y", { min: -180, max: 180, unit: "°" }), kn("model.rz", "Z", { min: -180, max: 180, unit: "°" }))),
  r("3d", "scale", "Scale", "how big", "scale size resize", stack(sl("model.scale", "Scale", { min: 0.1, max: 10, step: 0.05 }), adv(sl("model.sx", "X", { min: 0.1, max: 10, step: 0.05 })), adv(sl("model.sy", "Y", { min: 0.1, max: 10, step: 0.05 })), adv(sl("model.sz", "Z", { min: 0.1, max: 10, step: 0.05 })))),
  r("3d", "material", "Material", "colour, roughness and metal", "material colour roughness metal", stack(col("model.color", "Colour"), sl("model.rough", "Roughness", { min: 0, max: 100 }), sl("model.metal", "Metalness", { min: 0, max: 100 }))),
  r("3d", "light", "Lighting", "the light on the scene", "light lighting sun lamp", stack(seg("model.ltype", "Light", ["Sun", "Studio", "Lamp"]), sl("model.lint", "Intensity", { min: 0, max: 200 }), col("model.lcolor", "Colour"))),
  r("3d", "camera", "Camera", "the view and its lens", "camera view lens fov", stack(seg("model.view", "View", ["Perspective", "Top", "Front", "Side"]), sl("model.fov", "Field of view", { min: 15, max: 120, unit: "°" }))),
  r("3d", "shapes", "Shapes", "add a basic shape", "shapes primitives add cube sphere", stack(seg("model.shape", "Shape", ["Box", "Sphere", "Cylinder", "Cone"]), ask("Add it", "Add the shape picked in the Shapes panel to the model."))),
  r("3d", "modifier", "Modifier", "bevel, smooth or mirror", "modifier bevel subdivide mirror", stack(seg("model.mod", "Modifier", ["Bevel", "Smooth", "Mirror"]), st("model.level", "Level", { min: 0, max: 6 }))),
  r("3d", "snap", "Snapping", "snap to a grid", "snap grid snapping align", stack(tg("model.snap", "Snap"), st("model.grid", "Grid", { min: 1, max: 100, unit: "mm" }))),
  r("3d", "environment", "Environment", "the world around it", "environment hdri background sky", stack(sw("model.env", "World", [{ value: "studio", label: "Studio", color: "#9aa0a8" }, { value: "sunset", label: "Sunset", color: "#f0a050" }, { value: "night", label: "Night", color: "#1d2a48" }, { value: "forest", label: "Forest", color: "#3d7a4a" }]), sl("model.envamt", "Strength", { min: 0, max: 200 }))),
  r("3d", "render", "Render", "quality and shadows", "render quality shadows", stack(seg("model.quality", "Quality", ["Draft", "Good", "Best"]), tg("model.shadows", "Shadows"))),
  r("3d", "measure", "Measure", "the size of what is picked", "measure dimensions size", stack(stat("model.width", "Width", "mm"), stat("model.height", "Height", "mm"), ask("Measure it", "Measure the selected part and fill in the Measure panel."))),
  r("3d", "boolean", "Combine", "join, cut or keep the overlap", "boolean union subtract intersect combine", stack(seg("model.bool", "How", ["Join", "Cut", "Overlap"]), ask("Do it", "Combine the selected parts as set in the Combine panel."))),
  r("3d", "array", "Repeat", "copies in a row", "array repeat copies pattern", stack(st("model.count", "Copies", { min: 1, max: 50 }), sl("model.gap", "Spacing", { min: 0, max: 200, unit: "mm" }))),
  r("3d", "export", "Export", "for printing or games", "export stl glb print", stack(seg("model.format", "Format", ["STL", "GLB"]), ask("Export", "Export the model in the format set in the Export panel."))),
  r("3d", "symmetry", "Symmetry", "mirror the work across axes", "symmetry mirror axes", stack(chips("model.sym", "Mirror across", ["X", "Y", "Z"]))),
  r("3d", "extrude", "Extrude", "pull a face out", "extrude push pull depth", stack(sl("model.depth", "Depth", { min: -100, max: 100, centre: true, unit: "mm" }))),
  r("3d", "bevel", "Bevel", "round the edges", "bevel round edges fillet", stack(sl("model.bevel", "Width", { min: 0, max: 20, step: 0.5, unit: "mm" }), st("model.segments", "Segments", { min: 1, max: 12 }))),
  r("3d", "parts", "Parts", "what the model is made of", "parts outliner objects list", stack(lst("model.parts", "Parts"))),
  r("3d", "print", "Printing", "infill, quality and supports", "print printing infill supports", stack(sl("model.infill", "Infill", { min: 0, max: 100, unit: "%" }), seg("model.layer", "Quality", ["Draft", "Normal", "Fine"]), tg("model.supports", "Supports"))),
];

const GAME: Recipe[] = [
  r("game", "movement", "Movement", "how the player runs and jumps", "movement run jump player speed", stack(sl("game.speed", "Run speed", { min: 0, max: 1000 }), sl("game.jump", "Jump", { min: 0, max: 1500 }), tg("game.double", "Double jump"))),
  r("game", "physics", "Physics", "gravity and how slippery", "physics gravity friction slippery", stack(sl("game.gravity", "Gravity", { min: 0, max: 3000 }), sl("game.friction", "Grip ↔ slippery", { min: 0, max: 100 }))),
  r("game", "camera", "Camera", "how the view follows", "camera follow view", stack(seg("game.cam", "Follow", ["Locked", "Smooth", "Free"]), sl("game.camsmooth", "Smoothing", { min: 0, max: 100 }))),
  r("game", "enemy", "Enemies", "how they behave", "enemy enemies ai behaviour", stack(seg("game.enemy", "Behaviour", ["Patrol", "Chase", "Guard"]), sl("game.aggro", "Aggression", { min: 0, max: 100 }))),
  r("game", "health", "Health", "lives and healing", "health lives hp damage", stack(st("game.hp", "Health", { min: 1, max: 20 }), tg("game.regen", "Heal over time"))),
  r("game", "level", "Level sketch", "a grid of where things go", "level map layout tiles", stack(pads("game.tiles", "Level", 16, ["Sky", "High", "Mid", "Low", "Ground"])), 480),
  r("game", "spawner", "Spawner", "how many and how often", "spawn spawner waves enemies", stack(st("game.spawn", "How many", { min: 1, max: 50 }), sl("game.every", "Every", { min: 0.5, max: 30, step: 0.5, unit: "s" }))),
  r("game", "score", "Score", "points and combos", "score points combo", stack(st("game.points", "Points per hit", { min: 1, max: 1000 }), tg("game.combo", "Combos"))),
  r("game", "controls", "Controls", "keys for each action", "controls keys input mapping", stack(sel("game.jumpkey", "Jump", ["Space", "W", "Up"]), sel("game.actkey", "Action", ["E", "F", "Enter"]))),
  r("game", "sound", "Sound", "music and effects levels", "sound music sfx audio", stack(sl("game.music", "Music", { min: 0, max: 100 }), sl("game.sfx", "Effects", { min: 0, max: 100 }))),
  r("game", "difficulty", "Difficulty", "how hard it is", "difficulty easy hard", stack(seg("game.diff", "Difficulty", ["Easy", "Normal", "Hard"]))),
  r("game", "time", "Time of day", "day to night", "time day night lighting", stack(sl("game.hour", "Time", { min: 0, max: 24, step: 0.5, unit: "h" }))),
  r("game", "inventory", "Inventory", "what the player carries", "inventory items pickup", stack(lst("game.items", "Items"))),
  r("game", "dialogue", "Dialogue", "lines a character says", "dialogue lines npc talk story", stack(lst("game.lines", "Lines", "Hello, traveller…"))),
  r("game", "particles", "Particles", "sparks, dust or rain", "particles effects sparks rain", stack(seg("game.ptype", "Kind", ["Sparks", "Dust", "Rain", "Snow"]), sl("game.pamt", "Amount", { min: 0, max: 100 }), col("game.pcolor", "Colour"))),
  r("game", "powerups", "Power-ups", "what can be picked up", "power ups powerups bonus", stack(chips("game.powers", "Power-ups", ["Speed", "Shield", "Magnet", "Extra life", "Double jump"]))),
  r("game", "rules", "Win & lose", "how a level ends", "win lose rules goal", stack(seg("game.win", "Win by", ["Reach exit", "Collect all", "Survive"]), st("game.limit", "Time limit", { min: 0, max: 600, step: 10, unit: "s" }))),
  r("game", "sprite", "Sprite", "palette and size", "sprite art pixel palette", stack(sw("game.pal", "Palette", [{ value: "retro", label: "Retro", color: "#e2574c" }, { value: "pastel", label: "Pastel", color: "#f2c6c2" }, { value: "mono", label: "Mono", color: "#5d5d5d" }, { value: "neon", label: "Neon", color: "#41b883" }]), st("game.px", "Size", { min: 8, max: 128, step: 8, unit: "px" }))),
  r("game", "test", "Test it", "play and get notes", "test play playtest feedback", row(ask("Play-test it", "Play-test the game and tell me what feels off."), ask("Make it feel better", "Suggest small changes that would make the controls feel better; I will pick."))),
  r("game", "world", "World rules", "how the world behaves", "world rules physics wrap", stack(tg("game.wrap", "Wrap around edges"), tg("game.fall", "Falling hurts"), tg("game.water", "Water slows you"))),
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

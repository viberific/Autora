/**
 * Surface kinds: every kind of work that can sit on Panacea's canvas, and everything that is particular to each.
 *
 * A kind is one entry in `KINDS`. It says what the work publishes (parameters, actions), what opens beside it when it
 * arrives (starters), what is worth offering when a value goes somewhere telling (suggest), how it reads in words for
 * the agent and in the surface's title bar, how big it first is, and which part of the library its learned panels are
 * filed under. Nothing else in the model asks `kind === "image"`: it asks the registry, so a new kind is a new entry here
 * and the compiler names the places that still have to learn about it (the window's view of it, the server's adapter).
 * The design and the plan are in docs/PANACEA-ENGINE.md.
 *
 * Shared by the server and the page, so written without DOM or Node types.
 */
import type { Value } from "./atoms";
import type { Surface } from "./canvas";
import { BOARD_PARAMS, applyBoardParam, boardParams, readBoardState, type BoardState } from "./board";
import { DOC_PARAMS, applyParam, blocksOf, docStateOf, paramsFromState, readDocState, stateOf, type DocState } from "./document";
import type { Domain } from "./library";
import { intentOffer, type SelectionSignal } from "./intent";
import {
  DATA_ACTIONS, IMAGE_ACTIONS, IMAGE_PARAMS, dataParams, distinct, normalizeTable,
  type ActionSpec, type ParamSpec, type Table,
} from "./surfaces";

/** What opens by itself beside a surface that has just arrived: the panels, and one offered as a ghost. */
export interface Starters {
  live: string[];
  ghost: string | null;
  why: string;
}

/** A panel worth offering, and why. */
export interface Offer {
  recipe: string;
  why: string;
}

/** What a kind's `suggest` is given to judge with: whether a recipe is already beside the surface, and how to offer one. */
interface OfferTools {
  has: (recipe: string) => boolean;
  offer: (recipe: string, why: string) => Offer | null;
}

interface SurfaceKindDef {
  /** The start of its surfaces' ids ("img" for img1k3). */
  prefix: string;
  /** The part of the library its learned panels are filed under. */
  domain: Domain;
  /** What a person calls one ("a photo"). */
  noun: string;
  /** What a surface of this kind is called when its file gives no name. */
  title: string;
  /** What it lets a control change; the table's depend on its columns. */
  params: (table?: Table | null) => ParamSpec[];
  actions: ActionSpec[];
  /** How big it is when it arrives, before it is snapped to the grid; `px` is the picture's own size, when it has one. */
  size: (px?: { w: number; h: number } | null) => { w: number; h: number };
  starters: (surface: Surface) => Starters;
  /** One panel worth offering now that `param` has gone to `value`, or null. */
  suggest: (surface: Surface, param: string, value: Value, tools: OfferTools) => Offer | null;
  /** Context exposed to recipe intent without teaching the scorer about a particular engine. */
  selection: (surface: Surface) => SelectionSignal;
  /** Dynamic parameter families (such as column filters) which count toward familiarity with this engine. */
  skillFamilies?: string[];
  /** The surface in a line of words for the agent. */
  describe: (surface: Surface) => string;
  /** The small print in its title bar. */
  meta: (surface: Surface) => string;
  /** What a saved surface carries beyond the fields every kind has, read and checked; null when it cannot be read. */
  read: (raw: Record<string, unknown>) => { table?: Table; doc?: DocState; board?: BoardState } | null;
  /** For work whose parameters are read off it (a document's, off the selection): bring `surface.params` up to date with it. */
  settle?: (surface: Surface) => void;
  /** For work a parameter is applied to rather than stored in: carry `value` out on the work itself. */
  apply?: (surface: Surface, param: string, value: Value) => void;
}

const IMAGE: SurfaceKindDef = {
  prefix: "img",
  domain: "photo",
  noun: "a photo",
  title: "Image",
  params: () => IMAGE_PARAMS,
  actions: IMAGE_ACTIONS,
  size: (px) => {
    const w = 512;
    return { w, h: px && px.w > 0 ? Math.min(720, Math.max(192, (w * px.h) / px.w)) : 384 };
  },
  starters: () => ({ live: ["photo.light", "photo.colour"], ghost: "photo.looks", why: "A photo arrived: light and colour are where most edits start." }),
  suggest: (_s, param, value, tools) => intentOffer("image", param, value, tools),
  selection: () => "none",
  describe: (s) => `image "${s.title}"${s.px ? ` ${s.px.w}x${s.px.h}` : ""}${s.artifact ? ` (artifact ${s.artifact})` : ""}`,
  meta: (s) => (s.px ? `${s.px.w} × ${s.px.h}` : "Photo"),
  read: () => ({}),
};

const DATA: SurfaceKindDef = {
  prefix: "dat",
  domain: "data",
  noun: "a table",
  title: "Table",
  params: (table) => dataParams(table ?? { columns: [], rows: [] }),
  actions: DATA_ACTIONS,
  size: () => ({ w: 576, h: 352 }),
  starters: (surface) => {
    const t = surface.table;
    const cols = t?.columns ?? [];
    const nums = cols.filter((c) => c.type === "number");
    const date = cols.find((c) => c.type === "date");
    const cats = cols.filter((c) => c.type === "text" && t && distinct(t, c.name, 13).length >= 2 && distinct(t, c.name, 13).length <= 12);
    const live: string[] = [];
    if (nums.length && date) live.push("data.line");
    else if (nums.length && cats.length) live.push("data.bar");
    if (cats.length) live.push("data.filter-category");
    return { live, ghost: nums.length ? "data.explore" : null, why: "A table arrived: a chart of it, and a filter for its categories." };
  },
  suggest: (_s, param, value, tools) => intentOffer("data", param, value, tools),
  selection: () => "none",
  describe: (s) => `data "${s.title}", ${s.table?.rows.length ?? 0} rows; columns ${s.table?.columns.map((c) => `${c.name} (${c.type})`).join(", ")}`,
  skillFamilies: ["filter."],
  meta: (s) => `${s.table?.rows.length.toLocaleString() ?? 0} rows`,
  read: (raw) => {
    const table = normalizeTable(raw.table);
    return table ? { table } : null;
  },
};

const DOC_ACTIONS: ActionSpec[] = [
  { name: "export", label: "Export Markdown", about: "the document saved to the project as Markdown" },
];

const DOC: SurfaceKindDef = {
  prefix: "doc",
  domain: "document",
  noun: "a document",
  title: "Document",
  params: () => DOC_PARAMS,
  actions: DOC_ACTIONS,
  size: () => ({ w: 640, h: 592 }),
  starters: () => ({ live: ["document.styles", "document.type"], ghost: "document.paragraph", why: "A document arrived: text style and typography are where formatting starts." }),
  suggest: (_s, param, value, tools) => intentOffer("doc", param, value, tools),
  selection: (s) => s.doc?.sel && s.doc.sel.anchor !== s.doc.sel.head ? "range" : s.doc ? "caret" : "none",
  describe: (s) => {
    const blocks = s.doc ? blocksOf(stateOf(s.doc).doc).length : 0;
    const who = s.doc?.mode === "agent" ? "Autora may write in it" : "the person writes it: format and structure it, never write its words";
    return `document "${s.title}", ${s.params.words ?? 0} words in ${blocks} blocks; ${who}`;
  },
  meta: (s) => `${Number(s.params.words ?? 0).toLocaleString()} words`,
  read: (raw) => {
    const doc = readDocState(raw.doc);
    return doc ? { doc } : null;
  },
  settle: (s) => {
    if (s.doc) s.params = { ...s.params, ...paramsFromState(stateOf(s.doc)) };
  },
  apply: (s, param, value) => {
    if (!s.doc) return;
    const next = applyParam(stateOf(s.doc), param, value);
    if (next) s.doc = docStateOf(next, s.doc.mode);
  },
};

const BOARD_ACTIONS: ActionSpec[] = [
  { name: "tidy", label: "Tidy", about: "the cards laid out in columns, one for each set of linked cards; words and links unchanged" },
  { name: "export", label: "Export Markdown", about: "the board saved to the project as an outline in Markdown" },
];

const BOARD: SurfaceKindDef = {
  prefix: "brd",
  domain: "general",
  noun: "a board",
  title: "Board",
  params: () => BOARD_PARAMS,
  actions: BOARD_ACTIONS,
  size: () => ({ w: 832, h: 560 }),
  starters: (s) => ({ live: [s.board?.diagram === "flowchart" ? "general.flowchart" : "general.board"], ghost: null, why: s.board?.diagram === "flowchart" ? "A flowchart arrived: editable nodes and directed connectors." : "A board arrived: card colours and what is on it." }),
  suggest: (_s, param, value, tools) => intentOffer("board", param, value, tools),
  selection: (s) => s.board?.cards.some((c) => c.id === s.board?.sel) || s.board?.links.some((l) => l.id === s.board?.selLink) ? "card" : "none",
  describe: (s) => {
    const who = s.board?.mode === "agent" ? "Autora may write cards on it" : "its words are the person's: arrange, link, colour and ask questions, never write or remove their cards";
    return `${s.board?.diagram === "flowchart" ? "flowchart (process, decision, start/end nodes; directed connectors)" : "board"} "${s.title}", ${s.params.cards ?? 0} cards, ${s.params.links ?? 0} links, ${s.params.questions ?? 0} questions; ${who}`;
  },
  meta: (s) => `${Number(s.params.cards ?? 0)} ${s.board?.diagram === "flowchart" ? "nodes · flowchart" : "cards"}`,
  read: (raw) => {
    const board = readBoardState(raw.board);
    return board ? { board } : null;
  },
  settle: (s) => {
    if (s.board) s.params = boardParams(s.board, s.params);
  },
  apply: (s, param, value) => {
    if (s.board) {
      if (param === "diagram" && (value === "mindmap" || value === "flowchart") && value !== (s.board.diagram ?? "mindmap")) {
        s.params.shape = value === "flowchart" ? "process" : "card";
        s.params.direction = value === "flowchart" ? "forward" : "none";
      }
      s.board = applyBoardParam(s.board, param, value);
    }
  },
};

/** Every kind there is. Adding one here widens `SurfaceKind`, and the compiler lists what else has to learn of it. */
export const KINDS = { image: IMAGE, data: DATA, doc: DOC, board: BOARD } as const satisfies Record<string, SurfaceKindDef>;

export type SurfaceKind = keyof typeof KINDS;

export const KIND_NAMES = Object.keys(KINDS) as SurfaceKind[];

export const isKind = (v: unknown): v is SurfaceKind => typeof v === "string" && Object.hasOwn(KINDS, v);

/** "an image", "a data": a kind named in a sentence. */
export const withArticle = (kind: SurfaceKind): string => `${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}`;

/** What a surface of a kind lets a control change. */
export function paramsOf(kind: SurfaceKind, table?: Table | null): ParamSpec[] {
  return KINDS[kind].params(table);
}

export function actionsOf(kind: SurfaceKind): ActionSpec[] {
  return KINDS[kind].actions;
}

/** The parameter a name refers to on a surface, if it declares one. */
export function findParam(kind: SurfaceKind, table: Table | null | undefined, name: string): ParamSpec | null {
  return paramsOf(kind, table).find((p) => p.name === name) ?? null;
}

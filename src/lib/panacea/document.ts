/**
 * Panacea's document engine: the model a document surface is made of, and everything done to it.
 *
 * A document is a ProseMirror document (a typed tree: blocks holding text carrying marks) in Panacea's own schema.
 * ProseMirror's model, state and transform packages touch no DOM, so the server and the page run this same code: a
 * change the person makes with a panel and one the agent makes with a tool are the same operation on the same tree.
 *
 * What panels see of it is a set of parameters read off the selection (`paramsFromState`): bold lights up when the
 * caret is in bold, the style says heading when it is in one. Setting one applies it to what is selected
 * (`applyParam`). That is the "controls follow the work" half of Panacea's engine (docs/PANACEA-ENGINE.md).
 *
 * Every block has an id, so the agent can address a paragraph rather than count to it. Shared by the server and the
 * page, so written without DOM or Node types.
 */
import { Fragment, Mark, Node as PMNode, Schema, type Attrs, type MarkType, type NodeSpec, type NodeType } from "prosemirror-model";
import { EditorState, Plugin, Selection, TextSelection, type Command, type Transaction } from "prosemirror-state";
import { lift, setBlockType, wrapIn } from "prosemirror-commands";
import { liftListItem, wrapInList } from "prosemirror-schema-list";
import type { Value } from "./atoms";
import type { ParamSpec } from "./surfaces";

// ------------------------------------------------------------------ the shape --

/** Who writes the words. In `guide` the agent formats and structures but writes none; in `agent` it writes, and it is undoable. */
export type DocMode = "guide" | "agent";

/** A document surface's state: the tree as JSON, where the person's caret was, and who writes. */
export interface DocState {
  json: unknown;
  sel?: { anchor: number; head: number };
  /** With a caret and nothing selected, the marks the next typed text takes (Bold pressed, say); present only while set. */
  marks?: unknown[];
  mode: DocMode;
}

const DOC_FONTS = ["Inter", "Georgia", "Source Serif", "IBM Plex Sans", "JetBrains Mono"];
const BLOCK_STYLES = ["paragraph", "h1", "h2", "h3", "quote", "code"] as const;
const ALIGNS = ["left", "center", "right", "justify"] as const;
const LISTS = ["none", "bullets", "numbers"] as const;
const DEFAULT_INK = "#1c1c1f";
/** A document larger than this (as JSON) is refused: the canvas travels whole to the server and back. */
const MAX_JSON = 1_500_000;
const WORDS_PER_MINUTE = 230;

const blockAttrs = { id: { default: "" }, align: { default: "left" } };
const idOnly = { id: { default: "" } };
const align = (a: unknown) => (a && a !== "left" ? `text-align:${String(a)}` : undefined);
/** What a pasted element offers, typed without the DOM so the server can compile this file. */
type Pasted = { style?: { textAlign?: string }; getAttribute?: (name: string) => string | null };

const nodes: Record<string, NodeSpec> = {
  doc: { content: "block+", attrs: { font: { default: DOC_FONTS[0] }, size: { default: 11 }, leading: { default: 1.5 } } },
  paragraph: {
    group: "block", content: "inline*", attrs: blockAttrs,
    parseDOM: [{ tag: "p", getAttrs: (d) => ({ align: (d as Pasted).style?.textAlign || "left" }) }],
    toDOM: (n) => ["p", { "data-id": n.attrs.id, style: align(n.attrs.align) }, 0],
  },
  heading: {
    group: "block", content: "inline*", defining: true, attrs: { ...blockAttrs, level: { default: 1 } },
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, getAttrs: () => ({ level }) })),
    toDOM: (n) => [`h${n.attrs.level}`, { "data-id": n.attrs.id, style: align(n.attrs.align) }, 0],
  },
  blockquote: {
    group: "block", content: "block+", defining: true, attrs: idOnly,
    parseDOM: [{ tag: "blockquote" }], toDOM: (n) => ["blockquote", { "data-id": n.attrs.id }, 0],
  },
  code_block: {
    group: "block", content: "text*", marks: "", code: true, defining: true, attrs: idOnly,
    parseDOM: [{ tag: "pre", preserveWhitespace: "full" }], toDOM: (n) => ["pre", { "data-id": n.attrs.id }, ["code", 0]],
  },
  bullet_list: { group: "block", content: "list_item+", attrs: idOnly, parseDOM: [{ tag: "ul" }], toDOM: (n) => ["ul", { "data-id": n.attrs.id }, 0] },
  ordered_list: { group: "block", content: "list_item+", attrs: idOnly, parseDOM: [{ tag: "ol" }], toDOM: (n) => ["ol", { "data-id": n.attrs.id }, 0] },
  list_item: { content: "paragraph block*", defining: true, attrs: idOnly, parseDOM: [{ tag: "li" }], toDOM: (n) => ["li", { "data-id": n.attrs.id }, 0] },
  horizontal_rule: { group: "block", attrs: idOnly, parseDOM: [{ tag: "hr" }], toDOM: (n) => ["hr", { "data-id": n.attrs.id }] },
  text: { group: "inline" },
  hard_break: { group: "inline", inline: true, selectable: false, parseDOM: [{ tag: "br" }], toDOM: () => ["br"] },
};

export const schema = new Schema({
  nodes,
  marks: {
    link: {
      attrs: { href: { default: "" } }, inclusive: false,
      parseDOM: [{ tag: "a[href]", getAttrs: (d) => ({ href: (d as Pasted).getAttribute?.("href") ?? "" }) }],
      toDOM: (m) => ["a", { href: m.attrs.href }, 0],
    },
    em: { parseDOM: [{ tag: "i" }, { tag: "em" }], toDOM: () => ["em", 0] },
    strong: { parseDOM: [{ tag: "b" }, { tag: "strong" }], toDOM: () => ["strong", 0] },
    underline: { parseDOM: [{ tag: "u" }], toDOM: () => ["u", 0] },
    strike: { parseDOM: [{ tag: "s" }, { tag: "del" }], toDOM: () => ["s", 0] },
    code: { parseDOM: [{ tag: "code" }], toDOM: () => ["code", 0] },
    ink: { attrs: { color: { default: DEFAULT_INK } }, toDOM: (m) => ["span", { style: `color:${m.attrs.color}` }, 0] },
  },
});

const T = schema.nodes as Record<string, NodeType>;
const M = schema.marks as Record<string, MarkType>;

// ------------------------------------------------------------------------ ids --

let counter = 0;
/** An id for a block: short, and not going to repeat in a document. */
function newId(): string {
  counter = (counter + 1) % 46656;
  return `b${Date.now().toString(36).slice(-4)}${counter.toString(36).padStart(2, "0")}${Math.floor(Math.random() * 36).toString(36)}`;
}

/** A transaction giving an id to every block that has none (or shares one), or null when they all have. */
function ensureIds(state: EditorState): Transaction | null {
  const seen = new Set<string>();
  const fixes: Array<{ pos: number; attrs: Attrs }> = [];
  state.doc.descendants((node, pos) => {
    if (!node.type.spec.attrs || !("id" in node.type.spec.attrs)) return;
    const id = String(node.attrs.id ?? "");
    if (id && !seen.has(id)) { seen.add(id); return; }
    const fresh = newId();
    seen.add(fresh);
    fixes.push({ pos, attrs: { ...node.attrs, id: fresh } });
  });
  if (!fixes.length) return null;
  const tr = state.tr;
  for (const f of fixes) tr.setNodeMarkup(f.pos, undefined, f.attrs);
  return tr;
}

/** The plugin the editing view runs, so a block the person makes (Enter, a paste) gets its id. */
export const idPlugin = new Plugin({ appendTransaction: (trs, _old, state) => (trs.some((t) => t.docChanged) ? ensureIds(state) : null) });

// ------------------------------------------------------------------- building --

const p = (content?: Fragment | PMNode[], attrs: Attrs = {}) => T.paragraph!.create(attrs, content);

/** Inline text with the marks of `**bold**`, `*italic*` and `` `code` `` read, as nodes. */
function inline(text: string): PMNode[] {
  const out: PMNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/g;
  let last = 0;
  const plain = (s: string) => { if (s) out.push(schema.text(s)); };
  for (const m of text.matchAll(re)) {
    plain(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(schema.text(tok.slice(2, -2), [M.strong!.create()]));
    else if (tok.startsWith("`")) out.push(schema.text(tok.slice(1, -1), [M.code!.create()]));
    else out.push(schema.text(tok.slice(1, -1), [M.em!.create()]));
    last = (m.index ?? 0) + tok.length;
  }
  plain(text.slice(last));
  return out;
}

/** Blocks from text: headings (#), bullets (- * +), numbers (1.), quotes (>), fenced code, and paragraphs between blank lines. */
function blocksFromText(text: string): PMNode[] {
  const out: PMNode[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flushPara = () => { if (para.length) out.push(p(inline(para.join(" ")))); para = []; };
  const flushList = () => {
    if (!list) return;
    out.push(T[list.ordered ? "ordered_list" : "bullet_list"]!.create(null, list.items.map((t) => T.list_item!.create(null, p(inline(t))))));
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^```/.test(line)) {
      flushPara(); flushList();
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]!); i++) code.push(lines[i]!);
      out.push(T.code_block!.create(null, code.length ? schema.text(code.join("\n")) : undefined));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const number = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);
    if (heading) { flushPara(); flushList(); out.push(T.heading!.create({ level: Math.min(3, heading[1]!.length) }, inline(heading[2]!.trim()))); }
    else if (/^\s*(-{3,}|_{3,}|\*{3,})\s*$/.test(line)) { flushPara(); flushList(); out.push(T.horizontal_rule!.create()); }
    else if (bullet || number) {
      flushPara();
      const ordered = !bullet;
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? number)![1]!.trim());
    }
    else if (quote) { flushPara(); flushList(); out.push(T.blockquote!.create(null, p(inline(quote[1]!)))); }
    else if (!line.trim()) { flushPara(); flushList(); }
    else { flushList(); para.push(line.trim()); }
  }
  flushPara(); flushList();
  return out;
}

const withIds = (state: EditorState): EditorState => {
  const tr = ensureIds(state);
  return tr ? state.apply(tr) : state;
};

/** The state a document surface holds: a tree and a selection, with every block given an id. */
function build(doc: PMNode, sel?: DocState["sel"], marks?: unknown[]): EditorState {
  const state = EditorState.create({ doc });
  const placed = withIds(sel ? state.apply(state.tr.setSelection(clampSelection(doc, sel))) : state);
  // Set last: a step (the ids above) clears them.
  return marks && placed.selection.empty ? placed.apply(placed.tr.setStoredMarks(marks.map((m) => Mark.fromJSON(schema, m)))) : placed;
}

function clampSelection(doc: PMNode, sel: { anchor: number; head: number }): Selection {
  const at = (n: number) => doc.resolve(Math.max(0, Math.min(doc.content.size, Math.floor(n))));
  return TextSelection.between(at(sel.anchor), at(sel.head));
}

/** A new document, blank or from text; the agent's tool and a dropped `.md` or `.txt` use it. */
export function createDoc(text = "", mode: DocMode = "guide"): DocState {
  const blocks = text.trim() ? blocksFromText(text) : [];
  const doc = T.doc!.create(null, blocks.length ? blocks : [p()]);
  return docStateOf(build(doc), mode);
}

/** The surface's state read back from anywhere (disk, the page), checked and repaired; null when it is not a document. */
export function readDocState(raw: unknown): DocState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  try {
    if (JSON.stringify(r.json ?? null).length > MAX_JSON) return null;
    const doc = PMNode.fromJSON(schema, r.json);
    doc.check();
    const sel = r.sel && typeof r.sel === "object" ? (r.sel as Record<string, unknown>) : null;
    const anchor = sel && Number.isFinite(sel.anchor) ? Number(sel.anchor) : undefined;
    const head = sel && Number.isFinite(sel.head) ? Number(sel.head) : undefined;
    const marks = Array.isArray(r.marks) ? r.marks.slice(0, 8) : undefined;
    marks?.forEach((m) => Mark.fromJSON(schema, m));
    return docStateOf(build(doc, anchor !== undefined && head !== undefined ? { anchor, head } : undefined, marks), r.mode === "agent" ? "agent" : "guide");
  } catch {
    return null;
  }
}

export function stateOf(d: DocState): EditorState {
  return build(PMNode.fromJSON(schema, d.json), d.sel, d.marks);
}

export function docStateOf(state: EditorState, mode: DocMode): DocState {
  return {
    json: state.doc.toJSON(),
    sel: { anchor: state.selection.anchor, head: state.selection.head },
    ...(state.storedMarks ? { marks: state.storedMarks.map((m) => m.toJSON()) } : {}),
    mode,
  };
}

// -------------------------------------------------------------------- reading --

export function plainText(doc: PMNode): string {
  return doc.textBetween(0, doc.content.size, "\n\n", "\n");
}

export function wordCount(doc: PMNode): number {
  return plainText(doc).split(/\s+/).filter(Boolean).length;
}

/** What a block is called to the agent. */
function labelOf(node: PMNode, pos: number, doc: PMNode): string {
  if (node.type === T.heading) return `h${Math.min(3, node.attrs.level as number)}`;
  if (node.type === T.code_block) return "code";
  const $ = doc.resolve(pos);
  for (let d = $.depth; d > 0; d--) {
    const t = $.node(d).type;
    if (t === T.bullet_list) return "bullet";
    if (t === T.ordered_list) return "number";
    if (t === T.blockquote) return "quote";
  }
  return "p";
}

interface BlockInfo {
  id: string;
  kind: string;
  text: string;
}

/** Every block that holds text, in order, with the id the agent addresses it by. */
export function blocksOf(doc: PMNode): BlockInfo[] {
  const out: BlockInfo[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return;
    out.push({ id: String(node.attrs.id ?? ""), kind: labelOf(node, pos, doc), text: node.textContent });
  });
  return out;
}

/** The headings, in order: the outline. */
export function outlineOf(doc: PMNode): Array<{ id: string; level: number; text: string }> {
  const out: Array<{ id: string; level: number; text: string }> = [];
  doc.descendants((node) => {
    if (node.type === T.heading) out.push({ id: String(node.attrs.id), level: Math.min(3, node.attrs.level as number), text: node.textContent });
  });
  return out;
}

/** The document as Markdown. */
export function toMarkdown(doc: PMNode): string {
  const inlineMd = (node: PMNode): string => {
    let s = "";
    node.forEach((child) => {
      let t = child.text ?? (child.type === T.hard_break ? "  \n" : "");
      if (child.marks.some((m) => m.type === M.code)) t = `\`${t}\``;
      if (child.marks.some((m) => m.type === M.strong)) t = `**${t}**`;
      if (child.marks.some((m) => m.type === M.em)) t = `*${t}*`;
      const link = child.marks.find((m) => m.type === M.link);
      if (link) t = `[${t}](${String(link.attrs.href)})`;
      s += t;
    });
    return s;
  };
  const block = (node: PMNode, prefix = ""): string[] => {
    if (node.type === T.heading) return [`${"#".repeat(node.attrs.level as number)} ${inlineMd(node)}`];
    if (node.type === T.paragraph) return [prefix + inlineMd(node)];
    if (node.type === T.code_block) return ["```", node.textContent, "```"];
    if (node.type === T.horizontal_rule) return ["---"];
    if (node.type === T.blockquote) { const lines: string[] = []; node.forEach((c) => lines.push(...block(c).map((l) => `> ${l}`))); return lines; }
    if (node.type === T.bullet_list || node.type === T.ordered_list) {
      const lines: string[] = [];
      let n = 1;
      node.forEach((item) => {
        const mark = node.type === T.bullet_list ? "- " : `${n++}. `;
        item.forEach((c, _o, i) => lines.push(...block(c, i === 0 ? mark : "  ")));
      });
      return lines;
    }
    return [];
  };
  const parts: string[] = [];
  doc.forEach((n) => parts.push(block(n).join("\n")));
  return parts.join("\n\n");
}

// ----------------------------------------------------------------- parameters --

const choice = (name: string, label: string, options: readonly string[], def: string, extra: Partial<ParamSpec> = {}): ParamSpec =>
  ({ name, kind: "choice", label, options: [...options], default: def, ...extra });
const flag = (name: string, label: string): ParamSpec => ({ name, kind: "bool", label, default: false });

/** What a document surface lets a control change. The first group follows the selection; then the whole document; then what is only read off it. */
export const DOC_PARAMS: ParamSpec[] = [
  choice("block", "Style", BLOCK_STYLES, "paragraph"),
  choice("align", "Align", ALIGNS, "left"),
  flag("bold", "Bold"), flag("italic", "Italic"), flag("underline", "Underline"), flag("strike", "Strikethrough"), flag("code", "Code"),
  choice("list", "List", LISTS, "none"),
  { name: "ink", kind: "color", label: "Text colour", default: DEFAULT_INK },
  choice("font", "Font", DOC_FONTS, DOC_FONTS[0]!),
  { name: "size", kind: "number", label: "Size", min: 8, max: 32, step: 1, unit: "pt", default: 11 },
  { name: "leading", kind: "number", label: "Line height", min: 1, max: 2.5, step: 0.05, default: 1.5 },
  { name: "words", kind: "number", label: "Words", default: 0, derived: true },
  { name: "characters", kind: "number", label: "Characters", default: 0, derived: true },
  { name: "minutes", kind: "number", label: "Minutes to read", default: 0, step: 0.1, derived: true },
];

/** Where the selection is: the block holding it, whether that is in a quote, and the innermost list around it. */
function whereIs(state: EditorState): { parent: PMNode; quote: boolean; list: (typeof LISTS)[number]; listDepth: number } {
  const { $from } = state.selection;
  let quote = false;
  let list: (typeof LISTS)[number] = "none";
  let listDepth = 0;
  for (let d = $from.depth; d > 0; d--) {
    const t = $from.node(d).type;
    if (t === T.blockquote) quote = true;
    if (list === "none" && (t === T.bullet_list || t === T.ordered_list)) { list = t === T.bullet_list ? "bullets" : "numbers"; listDepth = d; }
  }
  return { parent: $from.parent, quote, list, listDepth };
}

function marksHere(state: EditorState, type: MarkType): { on: boolean; attrs?: Attrs } {
  const { from, to, empty, $from } = state.selection;
  if (empty) {
    const m = (state.storedMarks ?? $from.marks()).find((x) => x.type === type);
    return { on: !!m, attrs: m?.attrs };
  }
  let found: Attrs | undefined;
  state.doc.nodesBetween(from, to, (node) => { if (!found) found = node.marks.find((x) => x.type === type)?.attrs; });
  return { on: !!found, attrs: found };
}

/** The parameters at the selection: what the panels show. */
export function paramsFromState(state: EditorState): Record<string, Value> {
  const { parent, quote, list } = whereIs(state);
  const block = parent.type === T.heading ? `h${Math.min(3, parent.attrs.level as number)}` : parent.type === T.code_block ? "code" : quote ? "quote" : "paragraph";
  const words = wordCount(state.doc);
  const characters = plainText(state.doc).length;
  const ink = marksHere(state, M.ink!);
  return {
    block,
    align: (ALIGNS as readonly string[]).includes(parent.attrs.align as string) ? (parent.attrs.align as string) : "left",
    bold: marksHere(state, M.strong!).on,
    italic: marksHere(state, M.em!).on,
    underline: marksHere(state, M.underline!).on,
    strike: marksHere(state, M.strike!).on,
    code: marksHere(state, M.code!).on,
    list,
    ink: ink.on ? String(ink.attrs?.color ?? DEFAULT_INK) : DEFAULT_INK,
    font: String(state.doc.attrs.font),
    size: Number(state.doc.attrs.size),
    leading: Number(state.doc.attrs.leading),
    words,
    characters,
    minutes: Math.round((words / WORDS_PER_MINUTE) * 10) / 10,
  };
}

function run(state: EditorState, cmd: Command): EditorState | null {
  const out: { state: EditorState | null } = { state: null };
  const ok = cmd(state, (tr) => { out.state = state.apply(tr); });
  return ok ? out.state : null;
}

/** Turn a mark on or off over the selection (or, at a caret, for what is typed next). */
function setMark(state: EditorState, type: MarkType, on: boolean, attrs?: Attrs): EditorState {
  const { from, to, empty } = state.selection;
  if (empty) return state.apply(on ? state.tr.addStoredMark(type.create(attrs)) : state.tr.removeStoredMark(type));
  return state.apply(on ? state.tr.addMark(from, to, type.create(attrs)) : state.tr.removeMark(from, to, type));
}

/**
 * Apply a parameter to the selection (or to the whole document, for the font, size and line height). Returns the state
 * after, or null when there is nothing to do or the value is not one it takes.
 */
export function applyParam(state: EditorState, name: string, value: Value): EditorState | null {
  const now = paramsFromState(state)[name];
  switch (name) {
    case "block": {
      if (typeof value !== "string" || !(BLOCK_STYLES as readonly string[]).includes(value) || value === now) return null;
      const here = whereIs(state);
      if (value === "quote") return run(state, wrapIn(T.blockquote!));
      const keep = { align: here.parent.attrs.align ?? "left" };
      const set = value === "paragraph" ? setBlockType(T.paragraph!, keep) : value === "code" ? setBlockType(T.code_block!) : setBlockType(T.heading!, { ...keep, level: Number(value.slice(1)) });
      // Another style from inside a quote leaves the quote first.
      const base = here.quote && now === "quote" ? run(state, lift) : state;
      return base ? (run(base, set) ?? (base === state ? null : base)) : null;
    }
    case "align": {
      if (typeof value !== "string" || !(ALIGNS as readonly string[]).includes(value) || value === now) return null;
      const { from, to } = state.selection;
      const tr = state.tr;
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (node.type.spec.attrs && "align" in node.type.spec.attrs) tr.setNodeMarkup(pos, undefined, { ...node.attrs, align: value });
      });
      return tr.docChanged ? state.apply(tr) : null;
    }
    case "bold": case "italic": case "underline": case "strike": case "code": {
      if (typeof value !== "boolean" || value === now) return null;
      const type = { bold: M.strong, italic: M.em, underline: M.underline, strike: M.strike, code: M.code }[name]!;
      return setMark(state, type, value);
    }
    case "ink": {
      if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value) || value.toLowerCase() === String(now).toLowerCase()) return null;
      return setMark(state, M.ink!, value.toLowerCase() !== DEFAULT_INK, { color: value.toLowerCase() });
    }
    case "list": {
      if (typeof value !== "string" || !(LISTS as readonly string[]).includes(value) || value === now) return null;
      const here = whereIs(state);
      if (value === "none") {
        let s: EditorState | null = state;
        // A nested item takes more than one lift to leave every list.
        for (let i = 0; i < 8 && s && paramsFromState(s).list !== "none"; i++) s = run(s, liftListItem(T.list_item!));
        return s && paramsFromState(s).list === "none" ? s : null;
      }
      const type = value === "bullets" ? T.bullet_list! : T.ordered_list!;
      if (here.list !== "none") {
        const pos = state.selection.$from.before(here.listDepth);
        return state.apply(state.tr.setNodeMarkup(pos, type, state.doc.nodeAt(pos)!.attrs));
      }
      return run(state, wrapInList(type));
    }
    case "font": {
      if (typeof value !== "string" || !DOC_FONTS.includes(value) || value === now) return null;
      return state.apply(state.tr.setDocAttribute("font", value));
    }
    case "size": case "leading": {
      const spec = DOC_PARAMS.find((x) => x.name === name)!;
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      const v = Math.min(spec.max!, Math.max(spec.min!, value));
      return v === now ? null : state.apply(state.tr.setDocAttribute(name, v));
    }
    default:
      return null;
  }
}

// ------------------------------------------------------------ the agent's hands --

function blockPos(doc: PMNode, id: string): { node: PMNode; pos: number } | null {
  let found: { node: PMNode; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (!found && id && node.attrs?.id === id) found = { node, pos };
    return found ? false : undefined;
  });
  return found;
}

/** Select the text of one block, apply a parameter to it, and put the person's selection back. */
export function formatBlock(state: EditorState, id: string, name: string, value: Value): EditorState | string {
  const hit = blockPos(state.doc, id);
  if (!hit) return `There is no block ${id}.`;
  const start = hit.pos + 1;
  const end = hit.pos + hit.node.nodeSize - 1;
  const selected = state.apply(state.tr.setSelection(TextSelection.between(state.doc.resolve(start), state.doc.resolve(Math.max(start, end)))));
  const next = applyParam(selected, name, value);
  if (!next) return `${name} cannot be set to ${JSON.stringify(value)} on ${id}, or it already is.`;
  return withIds(next.apply(next.tr.setSelection(clampSelection(next.doc, { anchor: state.selection.anchor, head: state.selection.head }))));
}

/** Replace the words of a text block (Markdown marks read). Marks on the old words go with them. */
export function replaceBlockText(state: EditorState, id: string, text: string): EditorState | string {
  const hit = blockPos(state.doc, id);
  if (!hit) return `There is no block ${id}.`;
  if (!hit.node.isTextblock) return `${id} is not a block of text.`;
  const from = hit.pos + 1;
  const to = hit.pos + hit.node.nodeSize - 1;
  const content = hit.node.type === T.code_block ? (text ? [schema.text(text)] : []) : inline(text.replace(/\n+/g, " "));
  return state.apply(state.tr.replaceWith(from, to, content));
}

/** Insert Markdown as blocks at the top level, after the block holding `afterId` (or at the start when null). */
export function insertBlocks(state: EditorState, afterId: string | null, markdown: string): EditorState | string {
  const blocks = blocksFromText(markdown);
  if (!blocks.length) return "There was nothing to insert.";
  let at = 0;
  if (afterId) {
    const hit = blockPos(state.doc, afterId);
    if (!hit) return `There is no block ${afterId}.`;
    const $ = state.doc.resolve(hit.pos);
    at = $.depth === 0 ? hit.pos + hit.node.nodeSize : $.after(1);
  }
  return withIds(state.apply(state.tr.insert(at, Fragment.from(blocks))));
}

/** Take a block of text away, with the list item or list it leaves empty; a document is never left with nothing in it. */
export function deleteBlock(state: EditorState, id: string): EditorState | string {
  const hit = blockPos(state.doc, id);
  if (!hit) return `There is no block ${id}.`;
  const $ = state.doc.resolve(hit.pos);
  let from = hit.pos;
  let to = hit.pos + hit.node.nodeSize;
  // A list item holding only this block goes whole, and its list with it when it was the last.
  if ($.parent.type === T.list_item && $.parent.childCount === 1) {
    const list = $.node($.depth - 1);
    const itemFrom = $.before($.depth);
    if (list.childCount === 1) { from = $.before($.depth - 1); to = $.after($.depth - 1); }
    else { from = itemFrom; to = $.after($.depth); }
  }
  const tr = state.tr.delete(from, to);
  if (tr.doc.childCount === 0) tr.insert(0, p());
  return withIds(state.apply(tr));
}

/** A block, as the agent reads it. */
export function listing(doc: PMNode, full = false): string {
  return blocksOf(doc).map((b) => `[${b.id}] ${b.kind} ${JSON.stringify(full || b.text.length <= 140 ? b.text : `${b.text.slice(0, 137)}…`)}`).join("\n");
}

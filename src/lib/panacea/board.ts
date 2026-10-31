/**
 * A board: Panacea's surface for thinking in space. Cards (a few words each) placed anywhere on it, links drawn between
 * them, and Autora's questions as cards of their own. It is the place for a brainstorm, a map of ideas, a story's who /
 * what / where / when, a plan laid out before it is written.
 * In `diagram: "flowchart"` the same editable graph has process, decision, start/end shapes and directed connectors.
 * Old boards retain their implicit card shapes and undirected links; this is not a separate drawing or storage engine.
 *
 * Whose words: a board has a mode, like a document (document.ts). In `guide` (the default) the cards' words are the
 * person's: the agent may arrange, colour, link and tidy them, and ask questions (cards marked `ask`, which must be
 * questions), but not write, rewrite or remove a card of theirs. In `agent` it writes too, undoably. The tool enforces it
 * (server/panacea.ts `panacea_board`), not the prompt.
 *
 * Its parameters follow the selection, as a document's do: `tone` is the colour of the selected card (or of the next one
 * made, with none selected); `shape` follows a selected node, `direction` a selected connector; with none selected they
 * set creation defaults. `cards`, `links` and `questions` are counts, read off it.
 *
 * Pure: plain JSON in and out, so the server keeps it and the page edits the same thing. Shared by both, so written
 * without DOM or Node types.
 */
import type { Value } from "./atoms";
import type { ParamSpec } from "./surfaces";

export type BoardMode = "guide" | "agent";
export type Diagram = "mindmap" | "flowchart";
export const SHAPES = ["card", "process", "decision", "start", "end"] as const;
export type Shape = (typeof SHAPES)[number];
export const DIRECTIONS = ["none", "forward", "backward", "both"] as const;
type Direction = (typeof DIRECTIONS)[number];
const isShape = (v: unknown): v is Shape => typeof v === "string" && (SHAPES as readonly string[]).includes(v);
const isDirection = (v: unknown): v is Direction => typeof v === "string" && (DIRECTIONS as readonly string[]).includes(v);

const TONES = ["yellow", "green", "blue", "pink", "violet", "plain"] as const;
export type Tone = (typeof TONES)[number];

export interface Card {
  id: string;
  /** Where it is on the board, from its top left corner. */
  x: number;
  y: number;
  w: number;
  text: string;
  tone: Tone;
  /** A question Autora asked, for the person to answer with cards of their own. */
  ask?: true;
  by: "person" | "agent";
  shape?: Shape;
}

export interface Link {
  id: string;
  from: string;
  to: string;
  label: string;
  direction?: Direction;
}

export interface BoardState {
  mode: BoardMode;
  cards: Card[];
  links: Link[];
  /** The selected card, whose colour `tone` shows and sets. */
  sel?: string;
  selLink?: string;
  diagram?: Diagram;
}

const MAX_CARDS = 200;
const MAX_LINKS = 400;
export const MAX_CARD_TEXT = 400;
const MAX_LABEL = 40;
const CARD_W = 176;
const CARD_MIN_W = 112;
const CARD_MAX_W = 400;
/** How tall a card is taken to be when laying out: the page measures the real ones. */
const CARD_H = 80;
const GAP = 24;
const SPAN = 4000;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const isTone = (v: unknown): v is Tone => typeof v === "string" && (TONES as readonly string[]).includes(v);
const step = (n: number) => Math.round(n / 8) * 8;

let counter = 0;
function id(prefix: string): string {
  counter = (counter + 1) % 1296;
  return `${prefix}${Date.now().toString(36).slice(-4)}${counter.toString(36).padStart(2, "0")}${Math.floor(Math.random() * 36).toString(36)}`;
}

export const BOARD_PARAMS: ParamSpec[] = [
  { name: "tone", kind: "choice", label: "Card colour", options: [...TONES], default: "yellow" },
  { name: "diagram", kind: "choice", label: "Diagram", options: ["mindmap", "flowchart"], default: "mindmap" },
  { name: "shape", kind: "choice", label: "Node shape", options: [...SHAPES], default: "card" },
  { name: "direction", kind: "choice", label: "Connector direction", options: [...DIRECTIONS], default: "none" },
  { name: "cards", kind: "number", label: "Cards", default: 0, derived: true },
  { name: "links", kind: "number", label: "Links", default: 0, derived: true },
  { name: "questions", kind: "number", label: "Questions", default: 0, derived: true },
];

export function createBoard(mode: BoardMode = "guide", diagram: Diagram = "mindmap"): BoardState {
  return { mode, cards: [], links: [], ...(diagram === "flowchart" ? { diagram } : {}) };
}

/** A board from anywhere (disk, the page), checked and repaired; null when it is not one. */
export function readBoardState(raw: unknown): BoardState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.cards)) return null;
  if (r.diagram !== undefined && r.diagram !== "mindmap" && r.diagram !== "flowchart") return null;
  const flow = r.diagram === "flowchart";
  const seen = new Set<string>();
  const cards: Card[] = [];
  for (const c of r.cards.slice(0, MAX_CARDS)) {
    if (!c || typeof c !== "object") continue;
    const k = c as Record<string, unknown>;
    if (typeof k.id !== "string" || !/^[\w-]{1,40}$/.test(k.id) || seen.has(k.id)) continue;
    if (k.shape !== undefined && !isShape(k.shape)) return null;
    seen.add(k.id);
    cards.push({
      id: k.id,
      x: clamp(num(k.x, 0), r.diagram !== undefined ? -SPAN : 0, SPAN),
      y: clamp(num(k.y, 0), r.diagram !== undefined ? -SPAN : 0, SPAN),
      w: clamp(num(k.w, CARD_W), CARD_MIN_W, CARD_MAX_W),
      text: typeof k.text === "string" ? k.text.slice(0, MAX_CARD_TEXT) : "",
      tone: isTone(k.tone) ? k.tone : "yellow",
      ...(k.ask === true ? { ask: true as const } : {}),
      by: k.by === "agent" ? "agent" : "person",
      ...(k.shape !== undefined || flow ? { shape: (k.shape as Shape | undefined) ?? "process" } : {}),
    });
  }
  const links: Link[] = [];
  const pairs = new Set<string>();
  const linkIds = new Set<string>();
  for (const l of Array.isArray(r.links) ? r.links.slice(0, MAX_LINKS) : []) {
    if (!l || typeof l !== "object") continue;
    const k = l as Record<string, unknown>;
    if (typeof k.id !== "string" || !/^[\w-]{1,40}$/.test(k.id) || typeof k.from !== "string" || typeof k.to !== "string") continue;
    if (k.direction !== undefined && !isDirection(k.direction)) return null;
    const direction = (k.direction as Direction | undefined) ?? (flow ? "forward" : "none");
    const key = connectionKey(k.from, k.to, direction);
    if (linkIds.has(k.id) || k.from === k.to || !seen.has(k.from) || !seen.has(k.to) || pairs.has(key)) continue;
    pairs.add(key);
    linkIds.add(k.id);
    links.push({ id: k.id, from: k.from, to: k.to, label: typeof k.label === "string" ? k.label.slice(0, MAX_LABEL) : "", ...(k.direction !== undefined || flow ? { direction } : {}) });
  }
  const sel = typeof r.sel === "string" && seen.has(r.sel) ? r.sel : undefined;
  const selLink = !sel && typeof r.selLink === "string" && linkIds.has(r.selLink) ? r.selLink : undefined;
  return { mode: r.mode === "agent" ? "agent" : "guide", cards, links, ...(r.diagram !== undefined ? { diagram: r.diagram as Diagram } : {}), ...(sel ? { sel } : {}), ...(selLink ? { selLink } : {}) };
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const connectionKey = (a: string, b: string, d: Direction) => d === "none" || d === "both" ? `${d}:${pairKey(a, b)}` : d === "backward" ? `${b}>${a}` : `${a}>${b}`;
export const cardShape = (b: BoardState, c: Card): Shape => c.shape ?? (b.diagram === "flowchart" ? "process" : "card");
export const linkDirection = (b: BoardState, l: Link): Direction => l.direction ?? (b.diagram === "flowchart" ? "forward" : "none");

/** The parameters read off a board: the selected card's colour, and the counts. */
export function boardParams(b: BoardState, now: Record<string, Value>): Record<string, Value> {
  const sel = b.cards.find((c) => c.id === b.sel);
  const edge = b.links.find((l) => l.id === b.selLink);
  const newFlow = b.diagram === "flowchart" && now.diagram !== "flowchart";
  return {
    ...now,
    ...(sel ? { tone: sel.tone } : {}),
    ...(b.diagram === "flowchart" || now.diagram !== undefined ? { diagram: b.diagram ?? "mindmap", shape: sel ? cardShape(b, sel) : newFlow ? "process" : now.shape ?? "card", direction: edge ? linkDirection(b, edge) : newFlow ? "forward" : now.direction ?? "none" } : {}),
    cards: b.cards.filter((c) => !c.ask).length,
    links: b.links.length,
    questions: b.cards.filter((c) => c.ask).length,
  };
}

/** A parameter carried out on the board: a colour goes onto the selected card. */
export function applyBoardParam(b: BoardState, param: string, value: Value): BoardState {
  if (param === "diagram" && (value === "mindmap" || value === "flowchart")) return { ...b, diagram: value };
  if (param === "shape" && isShape(value) && b.sel) return { ...b, cards: b.cards.map((c) => c.id === b.sel ? { ...c, shape: value } : c) };
  if (param === "direction" && isDirection(value) && b.selLink) {
    const result = editLink(b, b.selLink, { direction: value });
    return typeof result === "string" ? b : result;
  }
  if (param !== "tone" || !isTone(value) || !b.sel) return b;
  return { ...b, cards: b.cards.map((c) => (c.id === b.sel ? { ...c, tone: value } : c)) };
}

/** A free place for a new card: beside `near` if given, else after the last row of cards. */
export function freeSpot(b: BoardState, near?: { x: number; y: number } | null, height = b.diagram === "flowchart" ? 112 : CARD_H): { x: number; y: number } {
  const taken = (x: number, y: number) => b.cards.some((c) => x < c.x + c.w + GAP / 2 && x + CARD_W + GAP / 2 > c.x && y < c.y + (b.diagram === "flowchart" ? cardHeight(b, c) : CARD_H) && y + height > c.y);
  const start = near ?? { x: GAP, y: GAP };
  for (let ring = 0; ring < 40; ring++) {
    for (let col = 0; col <= ring; col++) {
      for (const [dx, dy] of [[ring, col], [col, ring]] as const) {
        const x = start.x + dx * (CARD_W + GAP);
        const y = start.y + dy * (CARD_H + GAP);
        if (x <= SPAN - CARD_W && y <= SPAN - height && !taken(x, y)) return { x: step(x), y: step(y) };
      }
    }
  }
  return { x: GAP, y: GAP };
}

type Result = BoardState | string;

export function addCard(b: BoardState, input: { text: string; x?: number; y?: number; near?: string; tone?: unknown; shape?: unknown; ask?: boolean; by: Card["by"] }): { board: BoardState; card: Card } | string {
  if (b.cards.length >= MAX_CARDS) return `A board holds at most ${MAX_CARDS} cards.`;
  const text = input.text.trim().slice(0, MAX_CARD_TEXT);
  if (input.by === "agent" && !text) return "A card needs `text`.";
  if (input.tone !== undefined && !isTone(input.tone)) return `tone is one of ${TONES.join(", ")}.`;
  if (input.shape !== undefined && !isShape(input.shape)) return `shape is one of ${SHAPES.join(", ")}.`;
  if ((input.x !== undefined || input.y !== undefined) && (!Number.isFinite(input.x) || !Number.isFinite(input.y))) return "Give finite x and y coordinates together.";
  const by = b.cards.find((c) => c.id === input.near);
  if (input.near && !by) return `There is no card "${input.near}".`;
  const height = b.diagram === "flowchart" ? cardHeight(b, { id: "", x: 0, y: 0, w: CARD_W, text, shape: (input.shape as Shape | undefined) ?? "process", tone: "yellow", by: input.by, ...(input.ask ? { ask: true } : {}) }) : CARD_H;
  const at = typeof input.x === "number" && typeof input.y === "number"
    ? { x: step(clamp(input.x, b.diagram !== undefined ? -SPAN : 0, SPAN - CARD_W)), y: step(clamp(input.y, b.diagram !== undefined ? -SPAN : 0, SPAN - CARD_H)) }
    : freeSpot(b, by ? { x: by.x + by.w + GAP, y: by.y } : null, height);
  const card: Card = { id: id("c"), x: at.x, y: at.y, w: CARD_W, text, tone: (input.tone as Tone | undefined) ?? (input.ask ? "plain" : "yellow"), ...(input.ask ? { ask: true as const } : {}), by: input.by, ...(input.shape !== undefined || b.diagram === "flowchart" ? { shape: (input.shape as Shape | undefined) ?? "process" } : {}) };
  return { board: { ...b, cards: [...b.cards, card] }, card };
}

const needCard = (b: BoardState, cardId: string): Card | string => b.cards.find((c) => c.id === cardId) ?? `There is no card "${cardId}".`;

export function editCard(b: BoardState, cardId: string, set: { text?: string; tone?: unknown; w?: number; shape?: unknown }): Result {
  const card = needCard(b, cardId);
  if (typeof card === "string") return card;
  if (set.tone !== undefined && !isTone(set.tone)) return `tone is one of ${TONES.join(", ")}.`;
  if (set.shape !== undefined && !isShape(set.shape)) return `shape is one of ${SHAPES.join(", ")}.`;
  if (set.w !== undefined && !Number.isFinite(set.w)) return "Width must be finite.";
  const next: Card = {
    ...card,
    ...(typeof set.text === "string" ? { text: set.text.slice(0, MAX_CARD_TEXT) } : {}),
    ...(set.tone !== undefined ? { tone: set.tone as Tone } : {}),
    ...(set.shape !== undefined ? { shape: set.shape as Shape } : {}),
    ...(typeof set.w === "number" ? { w: clamp(step(set.w), CARD_MIN_W, CARD_MAX_W) } : {}),
  };
  return { ...b, cards: b.cards.map((c) => (c.id === cardId ? next : c)) };
}

export function moveCard(b: BoardState, cardId: string, x: number, y: number): Result {
  const card = needCard(b, cardId);
  if (typeof card === "string") return card;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return "Give finite x and y coordinates.";
  return { ...b, cards: b.cards.map((c) => (c.id === cardId ? { ...c, x: step(clamp(x, b.diagram !== undefined ? -SPAN : 0, SPAN - c.w)), y: step(clamp(y, b.diagram !== undefined ? -SPAN : 0, SPAN - CARD_H)) } : c)) };
}

/** A card taken off the board, with its links. */
export function removeCard(b: BoardState, cardId: string): Result {
  const card = needCard(b, cardId);
  if (typeof card === "string") return card;
  const { sel, selLink, ...rest } = b;
  return { ...rest, ...(sel && sel !== cardId ? { sel } : {}), ...(selLink && b.links.some((l) => l.id === selLink && l.from !== cardId && l.to !== cardId) ? { selLink } : {}), cards: b.cards.filter((c) => c.id !== cardId), links: b.links.filter((l) => l.from !== cardId && l.to !== cardId) };
}

export function linkCards(b: BoardState, from: string, to: string, label = "", direction: unknown = b.diagram === "flowchart" ? "forward" : "none"): { board: BoardState; link: Link } | string {
  for (const c of [from, to]) if (!b.cards.some((x) => x.id === c)) return `There is no card "${c}".`;
  if (from === to) return "A link joins two different cards.";
  if (!isDirection(direction)) return `direction is one of ${DIRECTIONS.join(", ")}.`;
  if (typeof label !== "string") return "A link label must be text.";
  if (b.links.some((l) => connectionKey(l.from, l.to, linkDirection(b, l)) === connectionKey(from, to, direction))) return `${from} and ${to} are linked already in that direction.`;
  if (b.links.length >= MAX_LINKS) return `A board holds at most ${MAX_LINKS} links.`;
  const link: Link = { id: id("l"), from, to, label: label.trim().slice(0, MAX_LABEL), ...(direction !== "none" || b.diagram === "flowchart" ? { direction } : {}) };
  return { board: { ...b, links: [...b.links, link] }, link };
}

export function editLink(b: BoardState, linkId: string, set: { label?: unknown; direction?: unknown }): Result {
  const link = b.links.find((l) => l.id === linkId);
  if (!link) return `There is no link "${linkId}".`;
  if (set.direction !== undefined && !isDirection(set.direction)) return `direction is one of ${DIRECTIONS.join(", ")}.`;
  if (set.label !== undefined && typeof set.label !== "string") return "A link label must be text.";
  const next = { ...link, ...(set.direction !== undefined ? { direction: set.direction as Direction } : {}), ...(typeof set.label === "string" ? { label: set.label.trim().slice(0, MAX_LABEL) } : {}) };
  if (b.links.some((l) => l.id !== linkId && connectionKey(l.from, l.to, linkDirection(b, l)) === connectionKey(next.from, next.to, linkDirection(b, next)))) return "Those cards are linked already in that direction.";
  return { ...b, links: b.links.map((l) => l.id === linkId ? next : l) };
}

/** A link taken away: by its id, or by the two cards it joins. */
export function unlink(b: BoardState, linkId: string | null, pair?: { from: string; to: string }): Result {
  const matches = b.links.filter((l) => (linkId ? l.id === linkId : pair && (b.diagram === "flowchart" ? l.from === pair.from && l.to === pair.to : pairKey(l.from, l.to) === pairKey(pair.from, pair.to))));
  if (matches.length > 1) return "Multiple connectors join those nodes; give a link id.";
  const hit = matches[0];
  if (!hit) return linkId ? `There is no link "${linkId}".` : "Those cards are not linked.";
  const next = { ...b, links: b.links.filter((l) => l !== hit) };
  if (next.selLink === hit.id) delete next.selLink;
  return next;
}

/** Cards that belong together: each set of cards joined by links, biggest first, a lone card on its own. */
export function clusters(b: BoardState): Card[][] {
  const next = new Map<string, string[]>();
  for (const l of b.links) {
    next.set(l.from, [...(next.get(l.from) ?? []), l.to]);
    next.set(l.to, [...(next.get(l.to) ?? []), l.from]);
  }
  const seen = new Set<string>();
  const out: Card[][] = [];
  const byId = new Map(b.cards.map((c) => [c.id, c]));
  // Cards in reading order, so a cluster starts at its top left card.
  for (const c of [...b.cards].sort((p, q) => p.y - q.y || p.x - q.x)) {
    if (seen.has(c.id)) continue;
    const group: Card[] = [];
    const todo = [c.id];
    seen.add(c.id);
    while (todo.length) {
      const at = todo.shift()!;
      const card = byId.get(at);
      if (card) group.push(card);
      for (const n of next.get(at) ?? []) if (!seen.has(n)) { seen.add(n); todo.push(n); }
    }
    out.push(group);
  }
  return out.sort((p, q) => q.length - p.length);
}

/** Tidied: each cluster a column, side by side, questions in a column of their own at the end. Words and links unchanged. */
export function tidy(b: BoardState): BoardState {
  const pos = new Map<string, { x: number; y: number }>();
  let x = GAP;
  const questions = b.cards.filter((c) => c.ask && !b.links.some((l) => l.from === c.id || l.to === c.id));
  const rest: BoardState = { ...b, cards: b.cards.filter((c) => !questions.includes(c)) };
  for (const group of [...clusters(rest), ...(questions.length ? [questions] : [])]) {
    let y = GAP;
    for (const c of group) {
      pos.set(c.id, { x, y });
      y += b.diagram === "flowchart" ? cardHeight(b, c) + GAP : CARD_H + Math.ceil(c.text.length / 28) * 8 + GAP;
    }
    x += Math.max(...group.map((c) => c.w)) + GAP * 2;
  }
  return { ...b, cards: b.cards.map((c) => ({ ...c, ...pos.get(c.id) })) };
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The board in words for the agent: every card with its id, where it is, and what it is linked to. */
export function boardListing(b: BoardState): string {
  if (!b.cards.length) return "(no cards yet)";
  const named = new Map(b.cards.map((c) => [c.id, c]));
  return b.cards.map((c) => {
    const links = b.links.filter((l) => l.from === c.id || l.to === c.id).map((l) => {
      const other = l.from === c.id ? l.to : l.from;
      const d = linkDirection(b, l);
      const arrow = d === "none" ? "" : d === "both" ? "↔ " : (d === "forward") === (l.from === c.id) ? "→ " : "← ";
      return `${arrow}${other} (${oneLine(named.get(other)?.text ?? "").slice(0, 24)})${l.label ? ` "${l.label}"` : ""}${b.diagram === "flowchart" ? ` [${l.id}; ${d}]` : ""}`;
    });
    const kind = c.ask ? "question" : b.diagram === "flowchart" ? `${cardShape(b, c)}${c.by === "agent" ? " (Autora's)" : ""}` : c.by === "agent" ? "card (Autora's)" : "card";
    return `[${c.id}] ${kind} at ${c.x},${c.y} ${c.tone}${b.sel === c.id ? " (selected)" : ""}: ${oneLine(c.text) || "(empty)"}${links.length ? ` -- linked to ${links.join(", ")}` : ""}`;
  }).join("\n");
}

/** The board as Markdown: a heading per cluster (its first card), its other cards beneath, then the questions still open. */
export function boardMarkdown(b: BoardState, title: string): string {
  const out: string[] = [`# ${title}`, ""];
  if (b.diagram === "flowchart") {
    out.push("## Nodes", "", ...b.cards.map((c) => `- [${c.id}] ${cardShape(b, c)}: ${oneLine(c.text)}`), "", "## Connectors", "", ...b.links.map((l) => `- ${l.from} ${linkDirection(b, l) === "forward" ? "→" : linkDirection(b, l) === "backward" ? "←" : linkDirection(b, l) === "both" ? "↔" : "—"} ${l.to}${l.label ? `: ${oneLine(l.label)}` : ""}`));
    return `${out.join("\n")}\n`;
  }
  const asked = b.cards.filter((c) => c.ask);
  const answered = { ...b, cards: b.cards.filter((c) => !c.ask) };
  for (const group of clusters(answered)) {
    const [head, ...rest] = group;
    if (!head) continue;
    if (!rest.length) { out.push(`- ${oneLine(head.text)}`); continue; }
    out.push("", `## ${oneLine(head.text)}`, "");
    for (const c of rest) {
      const via = b.links.find((l) => pairKey(l.from, l.to) === pairKey(head.id, c.id))?.label;
      out.push(`- ${oneLine(c.text)}${via ? ` (${via})` : ""}`);
    }
  }
  if (asked.length) out.push("", "## Open questions", "", ...asked.map((c) => `- ${oneLine(c.text)}`));
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

interface Point { x: number; y: number }

/** Invert a screen CTM without depending on browser DOM classes (also used by pointer tests). */
export function boardPoint(matrix: { a: number; b: number; c: number; d: number; e: number; f: number }, point: Point): Point | null {
  const { a, b, c, d, e, f } = matrix;
  const det = a * d - b * c;
  if (![a, b, c, d, e, f, point.x, point.y].every(Number.isFinite) || Math.abs(det) < 1e-12) return null;
  return { x: (d * (point.x - e) - c * (point.y - f)) / det, y: (-b * (point.x - e) + a * (point.y - f)) / det };
}

function cardLines(c: Card): string[] {
  const limit = Math.max(8, Math.floor((c.shape === "decision" ? c.w / 2 - 8 : c.w - 40) / 8));
  return c.text.split(/\r?\n/).flatMap((line) => {
    const chars = Array.from(line);
    const parts: string[] = [];
    for (let i = 0; i < chars.length; i += limit) parts.push(chars.slice(i, i + limit).join(""));
    return parts.length ? parts : [""];
  });
}

export function cardHeight(b: BoardState, c: Card): number {
  const text = cardLines(c).length * 20 + 32 + (c.ask ? 64 : 0);
  return cardShape(b, c) === "decision" ? Math.max(112, text * 2) : Math.max(80, text);
}

export function shapePath(shape: Shape, w: number, h: number): string {
  if (shape === "decision") return `M ${w / 2} 0 L ${w} ${h / 2} L ${w / 2} ${h} L 0 ${h / 2} Z`;
  if (shape === "start" || shape === "end") {
    const r = Math.min(w, h) / 2;
    return `M ${r} 0 H ${w - r} A ${r} ${r} 0 0 1 ${w} ${r} V ${h - r} A ${r} ${r} 0 0 1 ${w - r} ${h} H ${r} A ${r} ${r} 0 0 1 0 ${h - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
  }
  return `M 0 0 H ${w} V ${h} H 0 Z`;
}

/** Connect at the actual shape boundary, not the middle hidden under its text. */
export function connectorPoints(b: BoardState, a: Card, z: Card, ah = cardHeight(b, a), zh = cardHeight(b, z)): { p: Point; q: Point } {
  const p = { x: a.x + a.w / 2, y: a.y + ah / 2 };
  const q = { x: z.x + z.w / 2, y: z.y + zh / 2 };
  const dx = q.x - p.x || (q.y === p.y ? 1 : 0);
  const dy = q.y - p.y;
  const boundary = (c: Card, h: number, x: number, y: number) => {
    const hw = c.w / 2, hh = h / 2;
    const t = cardShape(b, c) === "decision" ? 1 / (Math.abs(x) / hw + Math.abs(y) / hh) : Math.min(x ? hw / Math.abs(x) : Infinity, y ? hh / Math.abs(y) : Infinity);
    // Rounded terminators: solve the ray's intersection with its semicircular ends.
    if ((cardShape(b, c) === "start" || cardShape(b, c) === "end") && hw >= hh && Math.abs(x * t) > hw - hh) {
      const offset = Math.sign(x) * (hw - hh);
      const aa = x * x + y * y;
      const root = (x * offset + Math.sqrt(Math.max(0, (x * offset) ** 2 - aa * (offset * offset - hh * hh)))) / aa;
      return { x: x * root, y: y * root };
    }
    if ((cardShape(b, c) === "start" || cardShape(b, c) === "end") && hh > hw && Math.abs(y * t) > hh - hw) {
      const offset = Math.sign(y) * (hh - hw);
      const aa = x * x + y * y;
      const root = (y * offset + Math.sqrt(Math.max(0, (y * offset) ** 2 - aa * (offset * offset - hw * hw)))) / aa;
      return { x: x * root, y: y * root };
    }
    return { x: x * t, y: y * t };
  };
  const start = boundary(a, ah, dx, dy), end = boundary(z, zh, -dx, -dy);
  return { p: { x: p.x + start.x, y: p.y + start.y }, q: { x: q.x + end.x, y: q.y + end.y } };
}

export function boardBounds(b: BoardState): { x: number; y: number; w: number; h: number } {
  const byId = new Map(b.cards.map((c) => [c.id, c]));
  const labels = b.links.flatMap((l) => {
    const a = byId.get(l.from), z = byId.get(l.to);
    if (!a || !z || !l.label) return [];
    const { p, q } = connectorPoints(b, a, z);
    const point = linkLabelPoint(b, l, p, q);
    const half = Array.from(l.label).length * 4 + 8;
    return [{ x: point.x - half, y: point.y - 20, w: half * 2, h: 32 }];
  });
  const boxes = [...b.cards.map((c) => ({ x: c.x, y: c.y, w: c.w, h: cardHeight(b, c) })), ...labels];
  const x = Math.min(0, ...boxes.map((c) => c.x)) - 32;
  const y = Math.min(0, ...boxes.map((c) => c.y)) - 32;
  return { x, y, w: Math.max(240, ...boxes.map((c) => c.x + c.w)) - x + 32, h: Math.max(160, ...boxes.map((c) => c.y + c.h)) - y + 32 };
}

export function linkLabelPoint(b: BoardState, l: Link, p: Point, q: Point): Point {
  const opposite = b.links.some((edge) => edge.id !== l.id && edge.from === l.to && edge.to === l.from);
  const length = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  return { x: (p.x + q.x) / 2 + (opposite ? -(q.y - p.y) * 20 / length : 0), y: (p.y + q.y) / 2 - 8 + (opposite ? (q.x - p.x) * 20 / length : 0) };
}

const xml = (s: string) => Array.from(s).map((c) => c.length === 1 && /[\ud800-\udfff]/.test(c) ? "\ufffd" : c).join("").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

/** A standalone vector artifact. It contains geometry and escaped text only, never markup supplied by the person. */
export function boardSvg(input: BoardState, title: string): string {
  const b = readBoardState(input);
  if (!b) throw new Error("Invalid board.");
  const bounds = boardBounds(b);
  const byId = new Map(b.cards.map((c) => [c.id, c]));
  const edges = b.links.map((l) => {
    const a = byId.get(l.from), z = byId.get(l.to);
    if (!a || !z) return "";
    const { p, q } = connectorPoints(b, a, z);
    const direction = linkDirection(b, l);
    const label = linkLabelPoint(b, l, p, q);
    return `<g><line x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}" stroke="currentColor" stroke-width="2"${direction === "backward" || direction === "both" ? ' marker-start="url(#arrow-start)"' : ""}${direction === "forward" || direction === "both" ? ' marker-end="url(#arrow-end)"' : ""}/>${l.label ? `<text x="${label.x}" y="${label.y}" text-anchor="middle">${xml(l.label)}</text>` : ""}</g>`;
  }).join("");
  const nodes = b.cards.map((c) => {
    const h = cardHeight(b, c), shape = cardShape(b, c), lines = cardLines(c);
    return `<g transform="translate(${c.x} ${c.y})" data-shape="${shape}"><path d="${shapePath(shape, c.w, h)}" fill="white" stroke="currentColor" stroke-width="${shape === "end" ? 3 : 2}"/><text text-anchor="middle">${lines.map((line, i) => `<tspan x="${c.w / 2}" y="${h / 2 - (lines.length - 1) * 10 + i * 20 + 5}">${xml(line)}</tspan>`).join("")}</text></g>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${bounds.w}" height="${bounds.h}" viewBox="${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}" role="img" aria-labelledby="title"><title id="title">${xml(title)}</title><defs><marker id="arrow-end" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" fill="currentColor"/></marker><marker id="arrow-start" markerWidth="8" markerHeight="8" refX="1" refY="4" orient="auto"><path d="M 8 0 L 0 4 L 8 8 Z" fill="currentColor"/></marker></defs><g fill="currentColor" font-family="sans-serif" font-size="14">${edges}${nodes}</g></svg>\n`;
}

/**
 * A board: Panacea's surface for thinking in space. Cards (a few words each) placed anywhere on it, links drawn between
 * them, and Autora's questions as cards of their own. It is the place for a brainstorm, a map of ideas, a story's who /
 * what / where / when, a plan laid out before it is written.
 *
 * Whose words: a board has a mode, like a document (document.ts). In `guide` (the default) the cards' words are the
 * person's: the agent may arrange, colour, link and tidy them, and ask questions (cards marked `ask`, which must be
 * questions), but not write, rewrite or remove a card of theirs. In `agent` it writes too, undoably. The tool enforces it
 * (server/panacea.ts `panacea_board`), not the prompt.
 *
 * Its parameters follow the selection, as a document's do: `tone` is the colour of the selected card (or of the next one
 * made, with none selected); `cards`, `links` and `questions` are counts, read off it.
 *
 * Pure: plain JSON in and out, so the server keeps it and the page edits the same thing. Shared by both, so written
 * without DOM or Node types.
 */
import type { Value } from "./atoms";
import type { ParamSpec } from "./surfaces";

export type BoardMode = "guide" | "agent";

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
}

export interface Link {
  id: string;
  from: string;
  to: string;
  label: string;
}

export interface BoardState {
  mode: BoardMode;
  cards: Card[];
  links: Link[];
  /** The selected card, whose colour `tone` shows and sets. */
  sel?: string;
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
  { name: "cards", kind: "number", label: "Cards", default: 0, derived: true },
  { name: "links", kind: "number", label: "Links", default: 0, derived: true },
  { name: "questions", kind: "number", label: "Questions", default: 0, derived: true },
];

export function createBoard(mode: BoardMode = "guide"): BoardState {
  return { mode, cards: [], links: [] };
}

/** A board from anywhere (disk, the page), checked and repaired; null when it is not one. */
export function readBoardState(raw: unknown): BoardState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.cards)) return null;
  const seen = new Set<string>();
  const cards: Card[] = [];
  for (const c of r.cards.slice(0, MAX_CARDS)) {
    if (!c || typeof c !== "object") continue;
    const k = c as Record<string, unknown>;
    if (typeof k.id !== "string" || !/^[\w-]{1,40}$/.test(k.id) || seen.has(k.id)) continue;
    seen.add(k.id);
    cards.push({
      id: k.id,
      x: clamp(num(k.x, 0), 0, SPAN),
      y: clamp(num(k.y, 0), 0, SPAN),
      w: clamp(num(k.w, CARD_W), CARD_MIN_W, CARD_MAX_W),
      text: typeof k.text === "string" ? k.text.slice(0, MAX_CARD_TEXT) : "",
      tone: isTone(k.tone) ? k.tone : "yellow",
      ...(k.ask === true ? { ask: true as const } : {}),
      by: k.by === "agent" ? "agent" : "person",
    });
  }
  const links: Link[] = [];
  const pairs = new Set<string>();
  for (const l of Array.isArray(r.links) ? r.links.slice(0, MAX_LINKS) : []) {
    if (!l || typeof l !== "object") continue;
    const k = l as Record<string, unknown>;
    if (typeof k.id !== "string" || !/^[\w-]{1,40}$/.test(k.id) || typeof k.from !== "string" || typeof k.to !== "string") continue;
    if (k.from === k.to || !seen.has(k.from) || !seen.has(k.to) || pairs.has(pairKey(k.from, k.to))) continue;
    pairs.add(pairKey(k.from, k.to));
    links.push({ id: k.id, from: k.from, to: k.to, label: typeof k.label === "string" ? k.label.slice(0, MAX_LABEL) : "" });
  }
  const sel = typeof r.sel === "string" && seen.has(r.sel) ? r.sel : undefined;
  return { mode: r.mode === "agent" ? "agent" : "guide", cards, links, ...(sel ? { sel } : {}) };
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** The parameters read off a board: the selected card's colour, and the counts. */
export function boardParams(b: BoardState, now: Record<string, Value>): Record<string, Value> {
  const sel = b.cards.find((c) => c.id === b.sel);
  return {
    ...now,
    ...(sel ? { tone: sel.tone } : {}),
    cards: b.cards.filter((c) => !c.ask).length,
    links: b.links.length,
    questions: b.cards.filter((c) => c.ask).length,
  };
}

/** A parameter carried out on the board: a colour goes onto the selected card. */
export function applyBoardParam(b: BoardState, param: string, value: Value): BoardState {
  if (param !== "tone" || !isTone(value) || !b.sel) return b;
  return { ...b, cards: b.cards.map((c) => (c.id === b.sel ? { ...c, tone: value } : c)) };
}

/** A free place for a new card: beside `near` if given, else after the last row of cards. */
export function freeSpot(b: BoardState, near?: { x: number; y: number } | null): { x: number; y: number } {
  const taken = (x: number, y: number) => b.cards.some((c) => x < c.x + c.w + GAP / 2 && x + CARD_W + GAP / 2 > c.x && y < c.y + CARD_H && y + CARD_H > c.y);
  const start = near ?? { x: GAP, y: GAP };
  for (let ring = 0; ring < 40; ring++) {
    for (let col = 0; col <= ring; col++) {
      for (const [dx, dy] of [[ring, col], [col, ring]] as const) {
        const x = start.x + dx * (CARD_W + GAP);
        const y = start.y + dy * (CARD_H + GAP);
        if (x <= SPAN - CARD_W && y <= SPAN - CARD_H && !taken(x, y)) return { x: step(x), y: step(y) };
      }
    }
  }
  return { x: GAP, y: GAP };
}

type Result = BoardState | string;

export function addCard(b: BoardState, input: { text: string; x?: number; y?: number; near?: string; tone?: unknown; ask?: boolean; by: Card["by"] }): { board: BoardState; card: Card } | string {
  if (b.cards.length >= MAX_CARDS) return `A board holds at most ${MAX_CARDS} cards.`;
  const text = input.text.trim().slice(0, MAX_CARD_TEXT);
  if (input.by === "agent" && !text) return "A card needs `text`.";
  if (input.tone !== undefined && !isTone(input.tone)) return `tone is one of ${TONES.join(", ")}.`;
  const by = b.cards.find((c) => c.id === input.near);
  if (input.near && !by) return `There is no card "${input.near}".`;
  const at = typeof input.x === "number" && typeof input.y === "number"
    ? { x: step(clamp(input.x, 0, SPAN - CARD_W)), y: step(clamp(input.y, 0, SPAN - CARD_H)) }
    : freeSpot(b, by ? { x: by.x + by.w + GAP, y: by.y } : null);
  const card: Card = { id: id("c"), x: at.x, y: at.y, w: CARD_W, text, tone: (input.tone as Tone | undefined) ?? (input.ask ? "plain" : "yellow"), ...(input.ask ? { ask: true as const } : {}), by: input.by };
  return { board: { ...b, cards: [...b.cards, card] }, card };
}

const needCard = (b: BoardState, cardId: string): Card | string => b.cards.find((c) => c.id === cardId) ?? `There is no card "${cardId}".`;

export function editCard(b: BoardState, cardId: string, set: { text?: string; tone?: unknown; w?: number }): Result {
  const card = needCard(b, cardId);
  if (typeof card === "string") return card;
  if (set.tone !== undefined && !isTone(set.tone)) return `tone is one of ${TONES.join(", ")}.`;
  const next: Card = {
    ...card,
    ...(typeof set.text === "string" ? { text: set.text.slice(0, MAX_CARD_TEXT) } : {}),
    ...(set.tone !== undefined ? { tone: set.tone as Tone } : {}),
    ...(typeof set.w === "number" ? { w: clamp(step(set.w), CARD_MIN_W, CARD_MAX_W) } : {}),
  };
  return { ...b, cards: b.cards.map((c) => (c.id === cardId ? next : c)) };
}

export function moveCard(b: BoardState, cardId: string, x: number, y: number): Result {
  const card = needCard(b, cardId);
  if (typeof card === "string") return card;
  return { ...b, cards: b.cards.map((c) => (c.id === cardId ? { ...c, x: step(clamp(x, 0, SPAN - c.w)), y: step(clamp(y, 0, SPAN - CARD_H)) } : c)) };
}

/** A card taken off the board, with its links. */
export function removeCard(b: BoardState, cardId: string): Result {
  const card = needCard(b, cardId);
  if (typeof card === "string") return card;
  const { sel, ...rest } = b;
  return { ...rest, ...(sel && sel !== cardId ? { sel } : {}), cards: b.cards.filter((c) => c.id !== cardId), links: b.links.filter((l) => l.from !== cardId && l.to !== cardId) };
}

export function linkCards(b: BoardState, from: string, to: string, label = ""): { board: BoardState; link: Link } | string {
  for (const c of [from, to]) if (!b.cards.some((x) => x.id === c)) return `There is no card "${c}".`;
  if (from === to) return "A link joins two different cards.";
  if (b.links.some((l) => pairKey(l.from, l.to) === pairKey(from, to))) return `${from} and ${to} are linked already.`;
  if (b.links.length >= MAX_LINKS) return `A board holds at most ${MAX_LINKS} links.`;
  const link: Link = { id: id("l"), from, to, label: label.trim().slice(0, MAX_LABEL) };
  return { board: { ...b, links: [...b.links, link] }, link };
}

/** A link taken away: by its id, or by the two cards it joins. */
export function unlink(b: BoardState, linkId: string | null, pair?: { from: string; to: string }): Result {
  const hit = b.links.find((l) => (linkId ? l.id === linkId : pair && pairKey(l.from, l.to) === pairKey(pair.from, pair.to)));
  if (!hit) return linkId ? `There is no link "${linkId}".` : "Those cards are not linked.";
  return { ...b, links: b.links.filter((l) => l !== hit) };
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
      group.push(byId.get(at)!);
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
      y += CARD_H + Math.ceil(c.text.length / 28) * 8 + GAP;
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
      return `${other} (${oneLine(named.get(other)?.text ?? "").slice(0, 24)})${l.label ? ` "${l.label}"` : ""}`;
    });
    const kind = c.ask ? "question" : c.by === "agent" ? "card (Autora's)" : "card";
    return `[${c.id}] ${kind} at ${c.x},${c.y} ${c.tone}${b.sel === c.id ? " (selected)" : ""}: ${oneLine(c.text) || "(empty)"}${links.length ? ` -- linked to ${links.join(", ")}` : ""}`;
  }).join("\n");
}

/** The board as Markdown: a heading per cluster (its first card), its other cards beneath, then the questions still open. */
export function boardMarkdown(b: BoardState, title: string): string {
  const out: string[] = [`# ${title}`, ""];
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

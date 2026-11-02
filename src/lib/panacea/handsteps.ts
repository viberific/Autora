/**
 * The agent's hand in Panacea (Visible work): from the canvas as it is to the canvas as the agent's call will leave it,
 * the steps a person would take with the window's own controls. A panel from the library is summoned the way a person
 * summons one (double-click the grid, type its name, pick it); a value is set by dragging that slider or pressing that
 * switch; a panel is moved by its header and put away with its ×. The window does them
 * (src/components/panacea/hand.ts) while the call waits; whatever has no control (a curve's points, a list's items) goes
 * in with the finished canvas afterwards, and the result says which was which.
 *
 * Shared by the server (which plans) and the page (which does), so written without DOM or Node types. Pure.
 */
import type { Value } from "./atoms";
import type { Canvas, Panel, Surface } from "./canvas";
import { ATOMS } from "./atoms";
import type { Node } from "./recipe";
import { createBoard, type BoardState } from "./board";
import { blockShapes, createDoc, paramsAtBlock, stateOf, type DocState } from "./document";
import { KINDS } from "./kinds";

/** Nothing set: zero, empty words, nothing chosen, off. */
const blank = (v: Value): boolean => v === 0 || v === "" || v === false || v === null || (Array.isArray(v) && v.length === 0);

export type HandStep =
  /** A panel summoned through the picker: a library one by its recipe, anything else (composed, bespoke, an offer) by
      the panel itself, which the picker lists as the agent's and the window puts in as it is. */
  | { op: "place"; id: string; recipe?: string; name: string; x: number; y: number; panel?: Panel }
  | { op: "set"; key: string; value: Value; panel: string; at?: { x: number; y: number } }
  /** `from`: where the hand takes it (its title bar; for a put-away, its ×), to bring into view first. */
  | { op: "move"; id: string; x: number; y: number; from?: { x: number; y: number } }
  | { op: "remove"; id: string; from?: { x: number; y: number } }
  /** A new surface, the way a person adds one: a board, flowchart or document from the picker, a table pasted, a file
      dropped. `surface` is what the window puts in (a document or board still empty: its words come in the steps after). */
  | { op: "surface"; id: string; how: "picker" | "paste" | "drop"; piece?: string; name: string; x: number; y: number; surface: Surface; text?: string }
  | { op: "unsurface"; id: string; title: string; from?: { x: number; y: number } }
  /** Words typed into a document: new blocks after `after` (null: at the start), each a line with its Markdown prefix. */
  | { op: "doc-type"; surface: string; after: string | null; lines: Array<{ kind: string; text: string }> }
  | { op: "doc-retype"; surface: string; block: string; text: string }
  | { op: "doc-erase"; surface: string; block: string }
  /** A block selected and formatted with the document's controls (its Style, Align, Bold... as a panel shows them). */
  | { op: "doc-format"; surface: string; block: string; set: Record<string, Value> }
  /** A board's cards and links, by hand: `card` is the server's id, which the hand maps to the one it makes. */
  | { op: "card"; surface: string; card: string; x: number; y: number; text: string }
  | { op: "card-text"; surface: string; card: string; text: string }
  | { op: "card-move"; surface: string; card: string; x: number; y: number }
  | { op: "card-remove"; surface: string; card: string }
  | { op: "link"; surface: string; from: string; to: string }
  | { op: "unlink"; surface: string; from: string; to: string; label: string };

/** Enough for a whole call done by hand; past it (a call that rebuilds a canvas) the rest goes in at once, and says so. */
const MAX_STEPS = 80;

/** A document's settings that follow where the caret is: a format step sets them on its block, not a panel's set step. */
const DOC_AT_CARET = new Set(["block", "align", "bold", "italic", "underline", "strike", "code", "list", "ink"]);

/** Whether a surface parameter is one a hand sets with a control: not one read off the surface (a count, a word total). */
function settable(s: Surface, key: string): boolean {
  const spec = KINDS[s.kind].params(s.table ?? null).find((p) => p.name === key);
  if (spec?.derived) return false;
  return !(s.kind === "doc" && DOC_AT_CARET.has(key));
}

/** How a person would add this surface, and what the window puts in when they do. */
function surfaceStep(s: Surface): Extract<HandStep, { op: "surface" }> {
  const base = { id: s.id, name: s.title, x: s.x, y: s.y };
  if (s.kind === "board" && s.board) {
    const flow = s.board.diagram === "flowchart";
    return { op: "surface", ...base, how: "picker", piece: flow ? "blank.flowchart" : "blank.board", name: flow ? "Flowchart" : "Board",
      surface: { ...s, board: createBoard(s.board.mode, s.board.diagram ?? "mindmap") } };
  }
  if (s.kind === "doc" && s.doc && !s.artifact) {
    return { op: "surface", ...base, how: "picker", piece: "blank.document", name: "Document", surface: { ...s, doc: createDoc("", s.doc.mode) } };
  }
  if (s.kind === "data" && !s.artifact && s.table) {
    // What is pasted is the table's head, as tab-separated text (the window puts in the whole table the call read).
    const line = (cells: unknown[]) => `${cells.map((v) => String(v ?? "")).join("\t")}\t`;
    const csv = [line(s.table.columns.map((c) => c.name)), ...s.table.rows.slice(0, 3).map(line)].join("\n") + "\n";
    return { op: "surface", ...base, how: "paste", surface: s, text: csv };
  }
  return { op: "surface", ...base, how: "drop", surface: s };
}

/** A document from `before` to `after`: blocks taken away, rewritten, formatted and typed in, top to bottom. */
function docSteps(id: string, before: DocState, after: DocState): HandStep[] {
  const steps: HandStep[] = [];
  const was = blockShapes(stateOf(before).doc);
  const now = blockShapes(stateOf(after).doc);
  const wasById = new Map(was.map((b) => [b.id, b]));
  const kept = new Set(now.map((b) => b.id));
  // A fresh document's one empty line is where typing starts, not a block to take away.
  const blankStart = was.length === 1 && !was[0]!.text && !kept.has(was[0]!.id);
  for (const b of was) if (!kept.has(b.id) && !blankStart) steps.push({ op: "doc-erase", surface: id, block: b.id });
  const afterState = stateOf(after);
  const beforeState = stateOf(before);
  let group: { after: string | null; lines: Array<{ kind: string; text: string }> } | null = null;
  let previous: string | null = null;
  const flush = () => { if (group?.lines.length) steps.push({ op: "doc-type", surface: id, after: group.after, lines: group.lines }); group = null; };
  for (const b of now) {
    const old = wasById.get(b.id);
    if (!old) {
      group ??= { after: previous, lines: [] };
      group.lines.push({ kind: b.kind, text: b.text });
      continue;
    }
    flush();
    previous = b.id;
    if (old.text !== b.text) steps.push({ op: "doc-retype", surface: id, block: b.id, text: b.text });
    if (old.shape !== b.shape || old.kind !== b.kind) {
      const want = paramsAtBlock(afterState, b.id);
      const had = paramsAtBlock(beforeState, b.id);
      if (want && had) {
        const set: Record<string, Value> = {};
        for (const k of DOC_AT_CARET) if (JSON.stringify(want[k]) !== JSON.stringify(had[k])) set[k] = want[k]!;
        if (Object.keys(set).length) steps.push({ op: "doc-format", surface: id, block: b.id, set });
      }
    }
  }
  flush();
  return steps;
}

/** A board from `before` to `after`: cards taken away, made, rewritten and moved, then the links. */
function boardSteps(id: string, before: BoardState, after: BoardState): HandStep[] {
  const steps: HandStep[] = [];
  const was = new Map(before.cards.map((c) => [c.id, c]));
  const now = new Map(after.cards.map((c) => [c.id, c]));
  const text = (b: BoardState, card: string) => b.cards.find((c) => c.id === card)?.text ?? "";
  const key = (l: { from: string; to: string }) => `${l.from}>${l.to}`;
  const linksNow = new Set(after.links.map(key));
  for (const l of before.links) if (!linksNow.has(key(l)) && now.has(l.from) && now.has(l.to)) steps.push({ op: "unlink", surface: id, from: l.from, to: l.to, label: `${text(before, l.from)} to ${text(before, l.to)}` });
  for (const c of before.cards) if (!now.has(c.id)) steps.push({ op: "card-remove", surface: id, card: c.id });
  for (const c of after.cards) {
    const old = was.get(c.id);
    if (!old) { steps.push({ op: "card", surface: id, card: c.id, x: c.x, y: c.y, text: c.text }); continue; }
    if (old.text !== c.text) steps.push({ op: "card-text", surface: id, card: c.id, text: c.text });
    if (old.x !== c.x || old.y !== c.y) steps.push({ op: "card-move", surface: id, card: c.id, x: c.x, y: c.y });
  }
  const linksWas = new Set(before.links.map(key));
  for (const l of after.links) if (!linksWas.has(key(l))) steps.push({ op: "link", surface: id, from: l.from, to: l.to });
  return steps;
}

/** The atoms the hand can work: every control a person can use. */
const BY_HAND = new Set(["slider", "knob", "stepper", "toggle", "segmented", "select", "chips", "swatches", "text", "range", "color", "xy", "curve", "list", "pads", "lanes"]);

/** The live panel whose control a person would use to set this value, if any: one where it shows before one where it is
    under More (the hand opens More), and the one on the focus first. */
function controlFor(canvas: Canvas, key: string): { id: string; at: { x: number; y: number } } | null {
  let best: { id: string; at: { x: number; y: number }; score: number } | null = null;
  for (const p of canvas.panels) {
    if (p.state !== "live") continue;
    let hit: "shown" | "more" | null = null;
    const walk = (n: Node, hidden: boolean) => {
      if (hit === "shown") return;
      const off = hidden || (n.advanced === true && !p.expanded);
      if (n.bind === key && BY_HAND.has(n.atom) && ATOMS[n.atom].control) hit = off ? "more" : "shown";
      n.children?.forEach((c) => walk(c, off));
    };
    walk(p.tree, false);
    if (!hit) continue;
    const score = (hit === "shown" ? 4 : 0) + (p.context === canvas.focus ? 2 : 0) + (p.touched ? 1 : 0);
    if (!best || score > best.score) best = { id: p.id, at: { x: p.x, y: p.y }, score };
  }
  return best ? { id: best.id, at: best.at } : null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The steps from `before` to `after`, and how many changes had no step. */
export function panaceaSteps(before: Canvas, after: Canvas): { steps: HandStep[]; skipped: number } {
  const steps: HandStep[] = [];
  let skipped = 0;
  const was = new Map(before.panels.map((p) => [p.id, p]));
  const now = new Map(after.panels.map((p) => [p.id, p]));

  // Put away what goes, first, so there is room for what comes.
  for (const p of before.panels) if (!now.has(p.id) && p.state !== "ghost") steps.push({ op: "remove", id: p.id, from: { x: p.x + p.w - 24, y: p.y } });
  const surfacesNow = new Set(after.surfaces.map((s) => s.id));
  for (const s of before.surfaces) if (!surfacesNow.has(s.id)) steps.push({ op: "unsurface", id: s.id, title: s.title, from: { x: s.x + s.w - 24, y: s.y } });
  // New surfaces, then what is written on each (a new one's from empty), before the panels that work on them.
  for (const s of after.surfaces) {
    const old = before.surfaces.find((x) => x.id === s.id);
    const step = old ? null : surfaceStep(s);
    if (step) steps.push(step);
    const from = step?.surface ?? old;
    if (s.doc && from?.doc) steps.push(...docSteps(s.id, from.doc, s.doc));
    if (s.board && from?.board) steps.push(...boardSteps(s.id, from.board, s.board));
  }
  for (const p of after.panels) {
    const old = was.get(p.id);
    if (!old) {
      // The panel itself goes too: a recipe the page has not loaded yet (one just learned) is picked as the agent's.
      steps.push({ op: "place", id: p.id, ...(p.state === "live" && p.recipe ? { recipe: p.recipe } : {}), name: p.title, x: p.x, y: p.y, panel: p });
    } else if (old.x !== p.x || old.y !== p.y) steps.push({ op: "move", id: p.id, x: p.x, y: p.y, from: { x: old.x, y: old.y } });
  }
  // Values: every surface parameter and shared value that changed, by its control where one is on screen.
  const changed: Array<{ key: string; value: Value }> = [];
  for (const s of after.surfaces) {
    const b = before.surfaces.find((x) => x.id === s.id);
    if (!b) continue;
    for (const [k, v] of Object.entries(s.params)) if (settable(s, k) && !same(b.params[k], v)) changed.push({ key: `@${s.id}.${k}`, value: v });
  }
  for (const [k, v] of Object.entries(after.values)) {
    /* A value that first exists now and is blank (a new panel opening on 0, "", nothing chosen) is what its control
       already shows: there is nothing for a hand to press, and trying left a step that could not be done. */
    if (!(k in before.values) && blank(v)) continue;
    if (!same(before.values[k], v)) changed.push({ key: k, value: v });
  }
  for (const c of changed) {
    const panel = controlFor(after, c.key);
    if (panel) steps.push({ op: "set", key: c.key, value: c.value, panel: panel.id, at: panel.at });
    else skipped++;
  }
  if (steps.length > MAX_STEPS) {
    skipped += steps.length - MAX_STEPS;
    steps.length = MAX_STEPS;
  }
  return { steps, skipped };
}

/** A step in a few words, for the agent's result. */
export function stepWords(s: HandStep): string {
  switch (s.op) {
    case "place": return `summoned ${s.name}`;
    case "set": return `set ${s.key.replace(/^@[\w-]+\./, "")} to ${JSON.stringify(s.value).slice(0, 40)}`;
    case "move": return `moved ${s.id}`;
    case "remove": return `put away ${s.id}`;
    case "surface": return `added ${s.name} (${s.how === "picker" ? "from the picker" : s.how === "paste" ? "pasted" : "dropped"})`;
    case "unsurface": return `removed ${s.title}`;
    case "doc-type": return `typed ${s.lines.length} line${s.lines.length === 1 ? "" : "s"} into ${s.surface}`;
    case "doc-retype": return `rewrote ${s.block}`;
    case "doc-erase": return `deleted ${s.block}`;
    case "doc-format": return `formatted ${s.block} (${Object.keys(s.set).join(", ")})`;
    case "card": return `wrote a card "${s.text.slice(0, 30)}"`;
    case "card-text": return `rewrote card ${s.card}`;
    case "card-move": return `moved card ${s.card}`;
    case "card-remove": return `took away card ${s.card}`;
    case "link": return `linked ${s.from} to ${s.to}`;
    case "unlink": return `unlinked ${s.from} from ${s.to}`;
  }
}

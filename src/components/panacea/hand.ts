/**
 * The agent's hand in Panacea (Visible work): the steps the server planned (src/lib/panacea/handsteps.ts), done with the
 * canvas's own controls while the person watches and the tool call waits. A library panel is summoned the way a person
 * summons one: the grid double-clicked where it goes, its name typed into the picker, the result clicked. A value is
 * set by dragging that slider, knob or range, pressing that switch, clicking that segment, swatch or chip, choosing in
 * that menu, or typing into that field. A panel is dragged by its title bar and put away with its ×.
 *
 * Every act is a real pointer, mouse or key event into the element the window drew, so the window's own handlers make
 * the change and save it as they would a person's. What it cannot do it leaves (the finished canvas goes in after), and
 * each step says whether it was done.
 */
import type { MutableRefObject } from "react";
import type { LaneItem, Value } from "../../lib/panacea/atoms";
import type { Recipe } from "../../lib/panacea/library";
import type { HandStep } from "../../lib/panacea/handsteps";
import type { Panel, Surface } from "../../lib/panacea/canvas";
import type { Project } from "../../lib/panacea/project";
import { OFFER_PREFIX, setHandOffer } from "./handOffer";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { applyParam, blockRange } from "../../lib/panacea/document";
import { docViews } from "./docViews";
import { centreOf, pointerGo, pointerPlace, pointerRest, pointerTyping } from "../../lib/pointer";
import { typingDelays, type Point } from "../../lib/humanPath";
import { isWorkVisible } from "../../lib/frameCoordinates";
import { beginHandRun, endHandRun, handPause, handsHalted, handsStopped } from "../../lib/handHalt";
import type { BoardHandle } from "./Board";

/** What the window puts in for the next thing picked: the server's id and place, and its own object when it is not a
    library panel (a composed or bespoke panel, an offer, a new surface), so what lands is what the call made. */
export type HandPending = { id: string; at: { x: number; y: number }; panel?: Panel; surface?: Surface; project?: Project };

type HandEnv = {
  root: HTMLElement;
  board: BoardHandle;
  pending: MutableRefObject<HandPending | null>;
};

type HandResult = { i: number; ok: boolean; error?: string };

class Skip extends Error {}
/** A pause between the hand's acts: none once the hand is halted (lib/handHalt.ts). */
const sleep = handPause;
/** A wait for the page to catch up (something to appear): real time, halted or not. */
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

async function waitFor<T>(fn: () => T | null | undefined | false, ms = 3000): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await tick(60);
  }
}

const ptr = (type: string, p: Point, extra: PointerEventInit = {}) =>
  new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, ...extra });
const mouse = (type: string, p: Point, detail = 1) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, button: 0, buttons: type === "mouseup" || type === "click" || type === "dblclick" ? 0 : 1, detail });

/** Whether a press at the middle of `el` lands on it: what a person needs to click it, even when an edge of it is covered. */
function pressable(el: Element): boolean {
  const p = centreOf(el);
  const hit = p && document.visibilityState === "visible" ? document.elementFromPoint(p.x, p.y) : null;
  return !!hit && (hit === el || el.contains(hit));
}

async function into(el: Element): Promise<Point> {
  // An entry further down a list that scrolls (the picker's, a menu's): scroll to it first, as a person would.
  const list = el.parentElement?.closest(".pa-summon-list, .pa-menu");
  if (list && list.scrollHeight > list.clientHeight) {
    el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    await sleep(260);
  }
  if (el.closest(".pa-board") && !isWorkVisible(el) && !pressable(el)) throw new Skip("the control is outside the workspace view");
  let p = centreOf(el);
  const r = el.getBoundingClientRect();
  if (!p || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) {
    el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    await sleep(350);
    p = centreOf(el);
  }
  if (!p) throw new Skip("not on screen");
  return p;
}

async function click(el: Element | null): Promise<void> {
  if (!el) throw new Skip("not on screen");
  if ((el as HTMLButtonElement).disabled) throw new Skip("not available");
  const p = await into(el);
  await pointerGo(p, true, el);
  el.dispatchEvent(ptr("pointerdown", p));
  el.dispatchEvent(mouse("mousedown", p));
  if (el instanceof HTMLElement) el.focus({ preventScroll: true });
  el.dispatchEvent(ptr("pointerup", p));
  el.dispatchEvent(mouse("mouseup", p));
  el.dispatchEvent(mouse("click", p));
  await sleep(rand(120, 220));
}

/** A double-click at the middle of `el`, or at `p` on it: the way a person adds a point, a block or a card. */
async function dblclick(el: Element | null, p?: Point): Promise<void> {
  if (!el) throw new Skip("not on screen");
  const at = p ?? await into(el);
  await pointerGo(at, true, el);
  for (const detail of [1, 2]) {
    el.dispatchEvent(ptr("pointerdown", at));
    el.dispatchEvent(mouse("mousedown", at, detail));
    el.dispatchEvent(ptr("pointerup", at));
    el.dispatchEvent(mouse("mouseup", at, detail));
    el.dispatchEvent(mouse("click", at, detail));
  }
  el.dispatchEvent(mouse("dblclick", at, 2));
  await sleep(rand(160, 260));
}

/** A key struck on what has the focus (or `el`): Enter to add, Delete to take away. */
async function press(key: string, el?: Element | null, mods: KeyboardEventInit = {}): Promise<void> {
  const target = el ?? document.activeElement ?? document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, composed: true, ...mods }));
  target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true, composed: true, ...mods }));
  await sleep(rand(90, 170));
}

/** Press on `el` at `from`, move to `to` a frame at a time, let go. */
async function drag(el: Element, from: Point, to: Point, area: Element = el): Promise<void> {
  if (!isWorkVisible(area) && !pressable(area)) throw new Skip("the control is outside the workspace view");
  await pointerGo(from, false);
  await sleep(rand(80, 150));
  el.dispatchEvent(ptr("pointerdown", from));
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const frames = Math.max(8, Math.min(36, Math.round(dist / 8)));
  for (let i = 1; i <= frames; i++) {
    const t = i / frames;
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    const p = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
    pointerPlace(p);
    el.dispatchEvent(ptr("pointermove", p));
    await sleep(16);
  }
  await sleep(rand(50, 110));
  el.dispatchEvent(ptr("pointerup", to));
  await sleep(rand(140, 240));
}

const setNative = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};

/** Click into a field, clear it, and type a key at a time. */
async function typeInto(input: HTMLInputElement | HTMLTextAreaElement | null, text: string): Promise<void> {
  if (!input) throw new Skip("the field is not on screen");
  await click(input);
  setNative(input, "");
  pointerTyping(true);
  try {
    const delays = typingDelays(text);
    let typed = "";
    for (let i = 0; i < text.length; i++) {
      if (handsStopped()) break;
      // Halted: the rest at once.
      typed = handsHalted() ? text : typed + text[i];
      setNative(input, typed);
      if (typed.length === text.length) break;
      await sleep(delays[i] ?? 60);
    }
  } finally {
    pointerTyping(false);
  }
  await sleep(rand(120, 220));
}

const num = (el: Element, name: string, d: number) => {
  const v = Number(el.getAttribute(name));
  return Number.isFinite(v) ? v : d;
};

/** Set one value with the control bound to it on one panel. */
async function setByHand(control: Element, value: Value): Promise<void> {
  const atom = control.getAttribute("data-atom");
  const lo = num(control, "data-min", 0);
  const hi = num(control, "data-max", 100);
  const frac = (v: number) => Math.min(1, Math.max(0, (v - lo) / ((hi - lo) || 1)));
  switch (atom) {
    case "slider": {
      const track = control.querySelector(".pa-track");
      if (!track || typeof value !== "number") throw new Skip("no track");
      const r = track.getBoundingClientRect();
      const thumb = control.querySelector(".pa-thumb");
      const from = thumb ? centreOf(thumb)! : { x: r.left, y: r.top + r.height / 2 };
      await drag(track, from, { x: r.left + frac(value) * r.width, y: r.top + r.height / 2 });
      return;
    }
    case "range": {
      const track = control.querySelector(".pa-track");
      if (!track || !Array.isArray(value)) throw new Skip("no track");
      const r = track.getBoundingClientRect();
      const y = r.top + r.height / 2;
      const a = control.querySelector(".pa-thumb.is-a");
      const b = control.querySelector(".pa-thumb.is-b");
      if (a) await drag(track, centreOf(a)!, { x: r.left + frac(value[0] as number) * r.width, y });
      if (b) await drag(track, centreOf(b)!, { x: r.left + frac(value[1] as number) * r.width, y });
      return;
    }
    case "knob": {
      const dial = control.querySelector(".pa-knob-dial");
      if (!dial || typeof value !== "number") throw new Skip("no dial");
      const now = Number(dial.getAttribute("aria-valuenow") ?? lo);
      const from = centreOf(dial)!;
      await drag(dial, from, { x: from.x, y: from.y - ((value - now) / ((hi - lo) || 1)) * 160 });
      return;
    }
    case "stepper": {
      const input = control.querySelector("input");
      if (typeof value !== "number") throw new Skip("not a number");
      const step = num(control, "data-step", 1);
      const now = Number(input?.value ?? lo);
      const n = Math.round((value - now) / step);
      if (Math.abs(n) <= 8) {
        const btn = control.querySelector(`[data-act="${n > 0 ? "more" : "less"}"]`);
        for (let i = 0; i < Math.abs(n); i++) { await click(btn); await sleep(rand(60, 140)); }
      } else await typeInto(input, String(value));
      return;
    }
    case "toggle": {
      const sw = control.querySelector('[role="switch"]');
      if ((sw?.getAttribute("aria-checked") === "true") !== (value === true)) await click(sw);
      return;
    }
    case "segmented": case "swatches":
      await click(control.querySelector(`[data-value="${CSS.escape(String(value))}"]`));
      return;
    case "chips": {
      const want = new Set(Array.isArray(value) ? (value as string[]) : []);
      for (const chip of [...control.querySelectorAll("[data-value]")]) {
        const on = chip.getAttribute("aria-pressed") === "true";
        if (on !== want.has(chip.getAttribute("data-value") ?? "")) await click(chip);
      }
      return;
    }
    case "select": {
      await click(control.querySelector(".pa-select-btn"));
      const opt = await waitFor(() => control.querySelector(`.pa-menu [data-value="${CSS.escape(String(value))}"]`), 1500);
      await click(opt);
      return;
    }
    case "text":
      await typeInto(control.querySelector("input, textarea"), String(value ?? ""));
      return;
    case "xy": {
      const pad = control.querySelector(".pa-xy");
      if (!pad || !Array.isArray(value) || value.length !== 2) throw new Skip("no pad");
      const r = pad.getBoundingClientRect();
      const [x, y] = value as [number, number];
      const dot = pad.querySelector("b");
      const from = dot ? centreOf(dot)! : { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      await drag(pad, from, { x: r.left + ((x + 1) / 2) * r.width, y: r.top + ((1 - y) / 2) * r.height });
      return;
    }
    case "curve": {
      const svg = control.querySelector("svg.pa-curve");
      if (!svg || !Array.isArray(value)) throw new Skip("no curve");
      const want = [...(value as Array<[number, number]>)].sort((a, b) => a[0] - b[0]);
      const r = svg.getBoundingClientRect();
      const screen = (p: [number, number]) => ({ x: r.left + p[0] * r.width, y: r.top + (1 - p[1]) * r.height });
      const points = () => [...svg.querySelectorAll("circle.pa-curve-pt")];
      // Too many: double-click the extra ones in the middle away. Too few: double-click where the new ones go.
      while (points().length > want.length && points().length > 2) await dblclick(points()[1]!);
      for (const p of want.slice(1, -1)) if (points().length < want.length) await dblclick(svg, screen(p));
      // Then each point to where it goes, end to end.
      for (let i = 0; i < want.length; i++) {
        const pt = points()[i];
        if (!pt) break;
        await drag(pt, centreOf(pt)!, screen(want[i]!), svg);
      }
      return;
    }
    case "list": {
      if (!Array.isArray(value)) throw new Skip("not a list");
      const want = (value as string[]).map(String);
      const shown = () => [...control.querySelectorAll("ol > li")].map((li) => (li.className.includes("is-done") ? "✓ " : "") + (li.querySelector("span")?.textContent ?? ""));
      // Take away what is not wanted, from the end so the rows above stay put.
      for (let i = shown().length - 1; i >= 0; i--) {
        if (!want.includes(shown()[i]!) && !want.includes(`✓ ${shown()[i]}`) && !want.includes(shown()[i]!.replace(/^✓ /, ""))) {
          await click(control.querySelectorAll('ol > li [aria-label="Remove"]')[i] ?? null);
        }
      }
      // Tick or untick what is there, and type in what is new.
      const have = shown();
      for (let i = 0; i < have.length; i++) {
        const bare = have[i]!.replace(/^✓ /, "");
        const done = want.includes(`✓ ${bare}`);
        if (done !== have[i]!.startsWith("✓ ") && (want.includes(bare) || done)) await click(control.querySelectorAll("ol > li .pa-tick")[i] ?? null);
      }
      const known = new Set(shown().map((v) => v.replace(/^✓ /, "")));
      for (const item of want) {
        const bare = item.replace(/^✓ /, "");
        if (known.has(bare)) continue;
        const input = control.querySelector<HTMLInputElement>("input.pa-input");
        await typeInto(input, bare);
        await press("Enter", input);
        known.add(bare);
        if (item.startsWith("✓ ")) await click([...control.querySelectorAll("ol > li .pa-tick")].at(-1) ?? null);
      }
      return;
    }
    case "pads": {
      if (!Array.isArray(value)) throw new Skip("not a pattern");
      const pads = [...control.querySelectorAll("button.pa-pad")];
      for (let i = 0; i < pads.length; i++) {
        const on = pads[i]!.getAttribute("aria-pressed") === "true";
        if (on !== ((value as number[])[i] === 1)) await click(pads[i]!);
      }
      return;
    }
    case "lanes": {
      if (!Array.isArray(value)) throw new Skip("no lanes");
      const want = value as LaneItem[];
      const area = control.querySelector(".pa-lanes-area");
      const lanes = [...control.querySelectorAll(".pa-lane")];
      if (!area || !lanes.length) throw new Skip("no lanes on screen");
      const length = num(control, "data-length", 100);
      const xOf = (units: number) => { const r = area.getBoundingClientRect(); return r.left + (units / length) * r.width; };
      const blocks = () => [...control.querySelectorAll<HTMLElement>(".pa-block")];
      const labelOf = (b: Element) => b.querySelector("span")?.textContent ?? "";
      // Blocks that go: open each and clear its name, then Delete, as the block's own field takes it away.
      for (const b of blocks()) {
        if (want.some((w) => w.label === labelOf(b))) continue;
        await dblclick(b);
        const input = await waitFor(() => control.querySelector<HTMLInputElement>(".pa-block-input"), 800);
        if (!input) continue;
        setNative(input, "");
        await press("Delete", input);
      }
      for (const w of want) {
        let block = blocks().find((b) => labelOf(b) === w.label);
        if (!block) {
          // A new one: double-click its lane where it starts, then name it.
          const lane = lanes[w.lane] ?? lanes[0]!;
          const lr = lane.getBoundingClientRect();
          await dblclick(lane, { x: Math.min(lr.right - 4, Math.max(lr.left + 4, xOf(w.start) + 2)), y: lr.top + lr.height / 2 });
          const input = await waitFor(() => control.querySelector<HTMLInputElement>(".pa-block-input"), 800);
          if (input) { await typeInto(input, w.label); await press("Enter", input); input.blur(); }
          await sleep(120);
          block = blocks().find((b) => labelOf(b) === w.label);
          if (!block) continue;
        }
        // Then where it starts and how long it is, by its body and its end.
        const br = block.getBoundingClientRect();
        const y = br.top + br.height / 2;
        if (Math.abs(br.left - xOf(w.start)) > 3) await drag(block, { x: br.left + Math.min(12, br.width / 3), y }, { x: xOf(w.start) + Math.min(12, br.width / 3), y });
        const end = block.querySelector(".pa-block-end");
        if (end) {
          const er = end.getBoundingClientRect();
          const target = xOf(w.start + w.length);
          if (Math.abs(er.right - target) > 3) await drag(end, { x: er.left + er.width / 2, y }, { x: target - er.width / 2, y });
        }
      }
      return;
    }
    case "color":
      await typeInto(control.querySelector(".pa-hex"), String(value ?? ""));
      return;
    default:
      throw new Skip("no control a hand can work");
  }
}

// ------------------------------------------------------------- documents --

/** At most this long typing one step's words: a long passage is typed faster rather than for minutes. */
const TYPING_BUDGET_MS = 9000;

/** The pauses between keys for `text`, a person's rhythm, sped up evenly when the whole would take too long. */
function paced(text: string): number[] {
  const d = typingDelays(text);
  const total = d.reduce((a, b) => a + b, 0);
  return total > TYPING_BUDGET_MS ? d.map((x) => (x * TYPING_BUDGET_MS) / total) : d;
}

function viewOf(surface: string): EditorView {
  const v = docViews.get(surface);
  if (!v) throw new Skip("the document is not on screen");
  return v;
}

/** The screen point of a place in the document, for the pointer. */
function caretPoint(v: EditorView, pos: number): Point {
  const c = v.coordsAtPos(Math.max(0, Math.min(v.state.doc.content.size, pos)));
  return { x: c.left + 1, y: (c.top + c.bottom) / 2 };
}

/** Bring a block into view and the pointer to `pos` in it, and put the caret (or a selection to `to`) there. */
async function caretTo(v: EditorView, pos: number, to = pos): Promise<void> {
  const el = v.domAtPos(pos).node;
  const block = (el instanceof Element ? el : el.parentElement)?.closest("[data-id]") ?? v.dom;
  block.scrollIntoView({ block: "nearest", behavior: "smooth" });
  await sleep(200);
  await pointerGo(caretPoint(v, pos), true, v.dom);
  v.focus();
  if (to !== pos) {
    // A selection is dragged over, a frame at a time, from where it starts to where it ends.
    const frames = 10;
    for (let i = 1; i <= frames; i++) {
      const head = Math.round(pos + ((to - pos) * i) / frames);
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, pos, head)));
      pointerPlace(caretPoint(v, head));
      await sleep(22);
    }
  } else {
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, pos)));
  }
  await sleep(rand(80, 160));
}

/** Words typed into the editor a key at a time, through its own input rules (`# ` makes a heading), as typing is. */
async function typeDoc(v: EditorView, text: string): Promise<void> {
  if (!text) return;
  pointerTyping(true);
  try {
    const delays = paced(text);
    let owed = 0;
    for (let i = 0; i < text.length; i++) {
      if (handsStopped()) break;
      // Halted: the rest goes in at once, through the same input (so `# ` still makes a heading at a line's start).
      const ch = handsHalted() ? text.slice(i) : text[i]!;
      const { from, to } = v.state.selection;
      const plain = () => v.state.tr.insertText(ch, from, to);
      if (!v.someProp("handleTextInput", (f) => f(v, from, to, ch, plain))) v.dispatch(plain());
      if (ch.length > 1) break;
      owed += delays[i] ?? 40;
      if (owed >= 16) {
        pointerPlace(caretPoint(v, v.state.selection.head));
        await sleep(owed);
        owed = 0;
      }
    }
  } finally {
    pointerTyping(false);
  }
}

/** A key into the editor, through its keymap: Enter splits the line (or ends a list), Backspace takes away. */
async function keyDoc(v: EditorView, key: string): Promise<void> {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  v.someProp("handleKeyDown", (f) => f(v, e));
  await sleep(rand(70, 140));
}

const PREFIX: Record<string, string> = { h1: "# ", h2: "## ", h3: "### ", bullet: "- ", number: "1. ", quote: "> ", code: "```" };
const LISTS = new Set(["bullet", "number"]);

/** Lines typed after a block (or at the start): Enter, its Markdown prefix unless a list carries on, its words. */
async function typeLines(v: EditorView, after: string | null, lines: Array<{ kind: string; text: string }>): Promise<void> {
  let prev: string | null = null;
  if (after) {
    const r = blockRange(v.state.doc, after);
    if (!r) throw new Skip("the block to write after is not there");
    await caretTo(v, r.to);
    prev = v.state.doc.resolve(r.from).parent.type.name === "heading" ? "h1" : null;
    const inList = (() => { const $ = v.state.doc.resolve(r.from); for (let d = $.depth; d > 0; d--) { const n = $.node(d).type.name; if (n === "bullet_list") return "bullet"; if (n === "ordered_list") return "number"; } return null; })();
    prev = inList ?? prev;
  } else {
    const first = v.state.doc.firstChild;
    await caretTo(v, 1);
    if (first && first.textContent) {
      // Above what is there: a new line first, and back up into it.
      await keyDoc(v, "Enter");
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1)));
    }
  }
  for (const [i, line] of lines.entries()) {
    if (i > 0 || after) {
      await keyDoc(v, "Enter");
      // Out of a list: an empty item's Enter lifts the line out.
      if (prev && LISTS.has(prev) && !LISTS.has(line.kind)) await keyDoc(v, "Enter");
    }
    const carries = prev !== null && LISTS.has(prev) && prev === line.kind;
    await typeDoc(v, `${carries ? "" : PREFIX[line.kind] ?? ""}${line.text}`);
    prev = line.kind;
  }
}

/** Before working on a document or board: the view on it, close enough to read, as a person zooms in to work. Once a run. */
async function lookAt(env: HandEnv, surface: string, seen: Set<string>): Promise<void> {
  if (seen.has(surface)) return;
  seen.add(surface);
  const el = env.root.querySelector(`[data-surface="${CSS.escape(surface)}"]`);
  if (el && env.board.zoom() >= 0.75 && isWorkVisible(el)) return;
  env.board.jump(surface);
  await sleep(520);
}

async function docStep(s: Extract<HandStep, { op: "doc-type" | "doc-retype" | "doc-erase" | "doc-format" }>, env: HandEnv): Promise<void> {
  const v = viewOf(s.surface);
  if (s.op === "doc-type") { await typeLines(v, s.after, s.lines); return; }
  const r = blockRange(v.state.doc, s.block);
  if (!r) throw new Skip("that block is not there");
  await caretTo(v, r.from, r.to);
  if (s.op === "doc-retype") {
    if (s.text) await typeDoc(v, s.text);
    else await keyDoc(v, "Backspace");
    return;
  }
  if (s.op === "doc-erase") {
    await keyDoc(v, "Backspace");
    await keyDoc(v, "Backspace");
    return;
  }
  // Formatting: with the block selected, the document's own control for each setting where a panel shows one.
  for (const [key, value] of Object.entries(s.set)) {
    const control = env.root.querySelector(`.pa-panel [data-bind="${CSS.escape(`@${s.surface}.${key}`)}"]`);
    if (control && isWorkVisible(control)) {
      await setByHand(control, value);
      continue;
    }
    // No panel with it on screen: the same change, made in the editor on the selected block.
    const next = applyParam(v.state, key, value);
    if (next) {
      const sel = v.state.selection;
      const tr = v.state.tr.replaceWith(0, v.state.doc.content.size, next.doc.content);
      v.dispatch(tr.setSelection(TextSelection.create(tr.doc, Math.min(sel.from, tr.doc.content.size), Math.min(sel.to, tr.doc.content.size))));
      await sleep(rand(160, 260));
    }
  }
}

// ---------------------------------------------------------------- boards --

/** A board's parts on screen: its root (where a double-click makes a card, where Delete goes) and where a board point is. */
function boardOf(surface: string): { root: HTMLElement; screen: (x: number, y: number) => Point } {
  const root = document.querySelector<HTMLElement>(`[data-surface="${CSS.escape(surface)}"] .pa-brd`);
  const svg = root?.querySelector<SVGSVGElement>("svg.pa-brd-links");
  const m = svg?.getScreenCTM();
  if (!root || !m) throw new Skip("the board is not on screen");
  return { root, screen: (x, y) => { const p = new DOMPoint(x, y).matrixTransform(m); return { x: p.x, y: p.y }; } };
}

const cardEl = (root: Element, id: string) => root.querySelector(`[data-card="${CSS.escape(id)}"]`);

/** Write in the card that is open for writing, and press Enter to keep it. */
async function writeCard(root: Element, text: string): Promise<string | null> {
  const area = await waitFor(() => root.querySelector<HTMLTextAreaElement>("textarea"), 1500);
  if (!area) throw new Skip("the card did not open for writing");
  const id = area.closest<HTMLElement>("[data-card]")?.dataset.card ?? null;
  await typeInto(area, text);
  await press("Enter", area);
  return id;
}

async function boardStep(s: Extract<HandStep, { op: "card" | "card-text" | "card-move" | "card-remove" | "link" | "unlink" }>, env: HandEnv, cards: Map<string, string>): Promise<void> {
  const { root, screen } = boardOf(s.surface);
  const idOf = (server: string) => cards.get(server) ?? server;
  const card = (server: string) => cardEl(root, idOf(server));
  switch (s.op) {
    case "card": {
      // Double-click the space where it goes (the card is made a little up and left of the press), then write it.
      await dblclick(root, screen(s.x + 88, s.y + 24));
      const made = await writeCard(root, s.text);
      if (made) cards.set(s.card, made);
      return;
    }
    case "card-text": {
      await dblclick(card(s.card));
      await writeCard(root, s.text);
      return;
    }
    case "card-move": {
      const el = card(s.card);
      if (!el) throw new Skip("that card is not on screen");
      const from = await into(el);
      const r = el.getBoundingClientRect();
      const dest = screen(s.x, s.y);
      await drag(el, from, { x: dest.x + (from.x - r.left), y: dest.y + (from.y - r.top) });
      return;
    }
    case "card-remove": {
      await click(card(s.card));
      await press("Delete", root);
      return;
    }
    case "link": {
      const a = card(s.from);
      const b = card(s.to);
      const dot = a?.querySelector(".pa-brd-dot");
      if (!dot || !b) throw new Skip("the cards are not on screen");
      await drag(dot, await into(dot), await into(b));
      return;
    }
    case "unlink": {
      const hit = [...root.querySelectorAll(".pa-brd-hit")].find((l) => (l.getAttribute("aria-label") ?? "").startsWith(`Select connector ${s.label}`));
      if (!hit) throw new Skip("that link is not on screen");
      // A level or upright line has no height or width: its middle, all the same.
      const r = hit.getBoundingClientRect();
      const p = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      if (r.width + r.height === 0) throw new Skip("that link is not on screen");
      await pointerGo(p, true, hit);
      hit.dispatchEvent(ptr("pointerdown", p));
      await press("Delete", root);
      return;
    }
  }
}

// -------------------------------------------------------------- surfaces --

async function surfaceStep(s: Extract<HandStep, { op: "surface" }>, env: HandEnv): Promise<void> {
  const at = await env.board.reveal(s.x + 40, s.y + 40);
  const grid = env.board.grid();
  if (!grid) throw new Skip("the canvas is not on screen");
  env.pending.current = { id: s.id, at: { x: s.x, y: s.y }, surface: s.surface };
  if (s.how === "picker") {
    await pointerGo(at, true);
    grid.dispatchEvent(mouse("dblclick", at, 2));
    const input = await waitFor(() => env.root.querySelector<HTMLInputElement>(".pa-summon-q"), 1500);
    await typeInto(input, s.name);
    const item = await waitFor(() => env.root.querySelector(`.pa-summon [data-recipe="${CSS.escape(s.piece ?? "")}"]`), 2000);
    if (!item) throw new Skip("not in the picker");
    await click(item);
  } else if (s.how === "paste") {
    // A click where it goes, then a paste of the table's text, as Ctrl+V would bring it.
    await pointerGo(at, true, grid);
    const data = new DataTransfer();
    data.setData("text/plain", s.text ?? "");
    pointerTyping(true);
    await sleep(rand(200, 320));
    grid.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    pointerTyping(false);
  } else {
    // A file carried in and let go where it goes.
    const data = new DataTransfer();
    data.items.add(new File([""], s.surface.name || s.name));
    const from = { x: Math.min(innerWidth - 24, at.x + 160), y: Math.max(24, at.y - 120) };
    await pointerGo(from, false);
    const target = document.elementFromPoint(at.x, at.y) ?? grid;
    const drop = (type: string, p: Point) => target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true, clientX: p.x, clientY: p.y }));
    drop("dragenter", from);
    for (let i = 1; i <= 16; i++) {
      const p = { x: from.x + ((at.x - from.x) * i) / 16, y: from.y + ((at.y - from.y) * i) / 16 };
      pointerPlace(p);
      drop("dragover", p);
      await sleep(18);
    }
    drop("drop", at);
  }
  const landed = await waitFor(() => env.root.querySelector(`[data-surface="${CSS.escape(s.id)}"]`), 2500);
  if (!landed) throw new Skip("did not land");
  // A new document or board needs a moment to draw before it is written in.
  await sleep(250);
}

// --------------------------------------------------------------- projects --

/** Whether this run opened the project's plan, to close it again when the run is over (as it found it). */
let openedPlan = false;

/** The project strip's plan, opened if it is not. */
async function openPlan(env: HandEnv): Promise<Element> {
  const strip = env.root.querySelector(".pa-proj");
  if (!strip) throw new Skip("the project strip is not on screen");
  if (!strip.classList.contains("is-open")) {
    openedPlan = true;
    await click(strip.querySelector('[data-act="project-open"]'));
    await waitFor(() => strip.querySelector(".pa-proj-body"), 1000);
  }
  return strip;
}

async function projectStep(s: Extract<HandStep, { op: "project" | "approve" | "phase" | "step-add" | "step-tick" | "decide" }>, env: HandEnv): Promise<void> {
  switch (s.op) {
    case "project": {
      // Started from the picker, as a person starts one: the window puts in the server's project (`pending`).
      const at = env.board.toScreen(env.board.viewRect().x + 120, env.board.viewRect().y + 120);
      const grid = env.board.grid();
      if (!grid) throw new Skip("the canvas is not on screen");
      env.pending.current = { id: "project", at: { x: 0, y: 0 }, project: s.project };
      await pointerGo(at, true);
      grid.dispatchEvent(mouse("dblclick", at, 2));
      const input = await waitFor(() => env.root.querySelector<HTMLInputElement>(".pa-summon-q"), 1500);
      await typeInto(input, "Project");
      const item = await waitFor(() => env.root.querySelector('.pa-summon [data-recipe="blank.project"]'), 2000);
      if (!item) throw new Skip("not in the picker");
      await click(item);
      if (!await waitFor(() => env.root.querySelector(".pa-proj"), 2000)) throw new Skip("the strip did not appear");
      return;
    }
    case "approve":
      await click(env.root.querySelector('.pa-proj [data-act="approve"]'));
      return;
    case "phase":
      await click(env.root.querySelector(`.pa-proj [data-phase="${CSS.escape(s.phase)}"]`));
      await sleep(520);
      return;
    case "step-add": {
      const strip = await openPlan(env);
      const input = strip.querySelector<HTMLInputElement>(`[data-phase-add="${CSS.escape(s.phase)}"]`);
      await typeInto(input, s.text);
      await press("Enter", input);
      return;
    }
    case "step-tick": {
      // The tick in the bar when it is the step being worked on, else its box in the opened plan; found by its words,
      // since a step the hand typed has the window's id, not the server's.
      const tick = env.root.querySelector(`.pa-proj [data-step-tick="${CSS.escape(s.step)}"]`);
      if (tick && s.done) { await click(tick); return; }
      const strip = await openPlan(env);
      const row = strip.querySelector(`[data-step="${CSS.escape(s.step)}"]`)
        ?? [...strip.querySelectorAll("[data-step]")].find((li) => li.textContent?.trim() === s.text) ?? null;
      const box = row?.querySelector("input[type=checkbox]") ?? null;
      if ((box as HTMLInputElement | null)?.checked !== s.done) await click(box);
      return;
    }
    case "decide": {
      const strip = await openPlan(env);
      const input = strip.querySelector<HTMLInputElement>(".pa-proj-decide");
      await typeInto(input, s.text);
      await press("Enter", input);
      return;
    }
  }
}

/** The picker's entry for something of the agent's that is not in the library (handOffer.ts). */
function offerOf(id: string, name: string, about: string, w = 288): Recipe {
  return { id, name, domain: "general", about, tags: [], tree: { atom: "note", props: { text: name } }, w, origin: "builtin", uses: 0 };
}

export async function runPanaceaHand(steps: HandStep[], env: HandEnv): Promise<{ results: HandResult[] }> {
  beginHandRun();
  const results: HandResult[] = [];
  /** A card the hand made, by the server's id for it: the window gives it an id of its own. */
  const cards = new Map<string, string>();
  /** The documents and boards the view has been brought to in this run. */
  const seen = new Set<string>();
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    // Stopped: the steps not begun are not done.
    if (handsStopped()) { results.push({ i, ok: false, error: "stopped" }); continue; }
    try {
      if (s.op === "surface") await surfaceStep(s, env);
      else if (s.op === "project" || s.op === "approve" || s.op === "phase" || s.op === "step-add" || s.op === "step-tick" || s.op === "decide") await projectStep(s, env);
      else if (s.op === "unsurface") {
        if (s.from) await env.board.reveal(s.from.x, s.from.y + 12).catch(() => undefined);
        await click(env.root.querySelector(`[data-surface="${CSS.escape(s.id)}"] .pa-surface-x`));
      }
      else if (s.op === "doc-type" || s.op === "doc-retype" || s.op === "doc-erase" || s.op === "doc-format") { await lookAt(env, s.surface, seen); await docStep(s, env); }
      else if (s.op === "card" || s.op === "card-text" || s.op === "card-move" || s.op === "card-remove" || s.op === "link" || s.op === "unlink") { await lookAt(env, s.surface, seen); await boardStep(s, env, cards); }
      else if (s.op === "place") {
        const at = await env.board.reveal(s.x + 24, s.y + 12);
        const grid = env.board.grid();
        if (!grid) throw new Skip("the canvas is not on screen");
        await pointerGo(at, true);
        env.pending.current = { id: s.id, at: { x: s.x, y: s.y }, ...(s.panel ? { panel: s.panel } : {}) };
        const offer = `${OFFER_PREFIX}${s.id}`;
        if (s.panel) setHandOffer(offerOf(offer, s.name, s.panel.why || "made for this", s.panel.w));
        grid.dispatchEvent(mouse("mousedown", at, 1));
        grid.dispatchEvent(mouse("mouseup", at, 1));
        grid.dispatchEvent(mouse("click", at, 1));
        grid.dispatchEvent(mouse("mousedown", at, 2));
        grid.dispatchEvent(mouse("mouseup", at, 2));
        grid.dispatchEvent(mouse("click", at, 2));
        grid.dispatchEvent(mouse("dblclick", at, 2));
        const input = await waitFor(() => env.root.querySelector<HTMLInputElement>(".pa-summon-q"), 1500);
        await typeInto(input, s.name);
        // The library's entry when the page has it, the agent's own (handOffer.ts) otherwise.
        const item = await waitFor(() => (s.recipe ? env.root.querySelector(`.pa-summon [data-recipe="${CSS.escape(s.recipe)}"]`) : null)
          ?? (s.panel ? env.root.querySelector(`.pa-summon [data-recipe="${CSS.escape(offer)}"]`) : null), 2000);
        if (!item) throw new Skip("not in the picker");
        await click(item);
        const placed = await waitFor(() => env.root.querySelector(`[data-panel="${CSS.escape(s.id)}"]`), 2000);
        if (!placed) throw new Skip("did not land");
      } else if (s.op === "set") {
        if (s.at) await env.board.reveal(s.at.x + 24, s.at.y + 12).catch(() => undefined);
        const panel = env.root.querySelector(`[data-panel="${CSS.escape(s.panel)}"]`);
        let control = panel?.querySelector(`[data-bind="${CSS.escape(s.key)}"]`);
        if (!control && panel) {
          // Under More: open it, as a person would, and the control is there.
          const more = panel.querySelector('[data-act="more-settings"]');
          if (more) {
            await click(more);
            control = await waitFor(() => panel.querySelector(`[data-bind="${CSS.escape(s.key)}"]`), 1500);
          }
        }
        if (!control) throw new Skip("its control is not on screen");
        await into(control);
        await setByHand(control, s.value);
      } else if (s.op === "move") {
        if (s.from) await env.board.reveal(s.from.x + 24, s.from.y + 12).catch(() => undefined);
        const head = env.root.querySelector(`[data-panel="${CSS.escape(s.id)}"] .pa-head`);
        if (!head) throw new Skip("not on screen");
        const from = await into(head);
        const r = head.getBoundingClientRect();
        const dest = env.board.toScreen(s.x, s.y);
        await drag(head, from, { x: dest.x + (from.x - r.left), y: dest.y + (from.y - r.top) });
      } else if (s.op === "remove") {
        if (s.from) await env.board.reveal(s.from.x, s.from.y + 12).catch(() => undefined);
        await click(env.root.querySelector(`[data-panel="${CSS.escape(s.id)}"] [data-act="close"]`));
      }
      results.push({ i, ok: true });
    } catch (err) {
      results.push({ i, ok: false, error: err instanceof Skip ? err.message : err instanceof Error ? err.message : String(err) });
    } finally {
      env.pending.current = null;
      setHandOffer(null);
    }
  }
  endHandRun();
  if (openedPlan) {
    openedPlan = false;
    const strip = env.root.querySelector(".pa-proj.is-open");
    if (strip) await click(strip.querySelector('[data-act="project-open"]')).catch(() => undefined);
  }
  pointerRest();
  return { results };
}

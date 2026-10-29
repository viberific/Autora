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
import type { Value } from "../../lib/panacea/atoms";
import type { HandStep } from "../../lib/panacea/handsteps";
import { centreOf, pointerGo, pointerPlace, pointerRest, pointerTyping } from "../../lib/pointer";
import { typingDelays, type Point } from "../../lib/humanPath";
import type { BoardHandle } from "./Board";
import { IMAGE_COMMANDS, TOOLS } from "../../lib/panacea/image";
import type { RunResult } from "../../lib/panacea/rules";
import { imageHandle } from "./Surfaces";

type HandEnv = {
  root: HTMLElement;
  board: BoardHandle;
  /** The id and place the next summoned panel takes: the server's, so its result names the panel the person sees. */
  pending: MutableRefObject<{ id: string; at: { x: number; y: number } } | null>;
};

type HandResult = { i: number; ok: boolean; error?: string };

class Skip extends Error {}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

async function waitFor<T>(fn: () => T | null | undefined | false, ms = 3000): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(60);
  }
}

const ptr = (type: string, p: Point, extra: PointerEventInit = {}) =>
  new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, ...extra });
const mouse = (type: string, p: Point, detail = 1) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, button: 0, buttons: type === "mouseup" || type === "click" || type === "dblclick" ? 0 : 1, detail });

async function into(el: Element): Promise<Point> {
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

/** Press on `el` at `from`, move to `to` a frame at a time, let go. */
async function drag(el: Element, from: Point, to: Point): Promise<void> {
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
      typed += text[i];
      setNative(input, typed);
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
    case "color":
      await typeInto(control.querySelector(".pa-hex"), String(value ?? ""));
      return;
    default:
      throw new Skip("no control a hand can work");
  }
}

export async function runPanaceaHand(steps: HandStep[], env: HandEnv): Promise<{ results: HandResult[] }> {
  const results: HandResult[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    try {
      if (s.op === "place") {
        const at = await env.board.reveal(s.x + 24, s.y + 12);
        const grid = env.board.grid();
        if (!grid) throw new Skip("the canvas is not on screen");
        await pointerGo(at, true);
        env.pending.current = { id: s.id, at: { x: s.x, y: s.y } };
        grid.dispatchEvent(mouse("mousedown", at, 1));
        grid.dispatchEvent(mouse("mouseup", at, 1));
        grid.dispatchEvent(mouse("click", at, 1));
        grid.dispatchEvent(mouse("mousedown", at, 2));
        grid.dispatchEvent(mouse("mouseup", at, 2));
        grid.dispatchEvent(mouse("click", at, 2));
        grid.dispatchEvent(mouse("dblclick", at, 2));
        const input = await waitFor(() => env.root.querySelector<HTMLInputElement>(".pa-summon-q"), 1500);
        await typeInto(input, s.name);
        const item = await waitFor(() => env.root.querySelector(`.pa-summon [data-recipe="${CSS.escape(s.recipe)}"]`), 2000);
        if (!item) throw new Skip("not in the picker");
        await click(item);
        const placed = await waitFor(() => env.root.querySelector(`[data-panel="${CSS.escape(s.id)}"]`), 2000);
        if (!placed) throw new Skip("did not land");
      } else if (s.op === "set") {
        const panel = env.root.querySelector(`[data-panel="${CSS.escape(s.panel)}"]`);
        const control = panel?.querySelector(`[data-bind="${CSS.escape(s.key)}"]`);
        if (!control) throw new Skip("its control is not on screen");
        await into(control);
        await setByHand(control, s.value);
      } else if (s.op === "move") {
        const head = env.root.querySelector(`[data-panel="${CSS.escape(s.id)}"] .pa-head`);
        if (!head) throw new Skip("not on screen");
        const from = await into(head);
        const r = head.getBoundingClientRect();
        const dest = env.board.toScreen(s.x, s.y);
        await drag(head, from, { x: dest.x + (from.x - r.left), y: dest.y + (from.y - r.top) });
      } else if (s.op === "remove") {
        await click(env.root.querySelector(`[data-panel="${CSS.escape(s.id)}"] [data-act="close"]`));
      }
      results.push({ i, ok: true });
    } catch (err) {
      results.push({ i, ok: false, error: err instanceof Skip ? err.message : err instanceof Error ? err.message : String(err) });
    } finally {
      env.pending.current = null;
    }
  }
  pointerRest();
  return { results };
}

// ---------------------------------------------------------- the picture --

type ImageHandEnv = {
  root: HTMLElement;
  board: BoardHandle;
  /** What the window's last command did: the hand's act lands there, and its result is the step's. */
  lastRun: MutableRefObject<{ name: string; at: number; result: RunResult } | null>;
  setOn: (surface: string, values: Record<string, Value>, label: string) => void;
};

/** The tool a command is drawn with on the picture, if it is one a hand draws. */
const DRAWN: Record<string, string> = {
  "select.rect": "marquee", "select.ellipse": "ellipse", "select.polygon": "lasso", "select.brush": "quick", "select.wand": "wand",
  "select.color": "color", "select.object": "object", "layer.paint": "brush", "layer.erase_stroke": "eraser", "layer.heal_stroke": "heal",
  "layer.text": "text", "image.crop": "crop",
};

const mods = (mode: unknown): PointerEventInit => (mode === "add" ? { shiftKey: true } : mode === "subtract" ? { altKey: true } : mode === "intersect" ? { shiftKey: true, altKey: true } : {});

/** Press at the first point, through the rest a frame at a time, let go: a lasso drawn, a stroke painted. */
async function trace(el: Element, path: Point[], extra: PointerEventInit): Promise<void> {
  if (!path.length) return;
  await pointerGo(path[0]!, false);
  await sleep(rand(80, 150));
  el.dispatchEvent(ptr("pointerdown", path[0]!, extra));
  let last = path[0]!;
  for (const p of path.slice(1)) {
    const steps = Math.max(1, Math.min(12, Math.round(Math.hypot(p.x - last.x, p.y - last.y) / 10)));
    for (let i = 1; i <= steps; i++) {
      const q = { x: last.x + ((p.x - last.x) * i) / steps, y: last.y + ((p.y - last.y) * i) / steps };
      pointerPlace(q);
      el.dispatchEvent(ptr("pointermove", q, extra));
      await sleep(12);
    }
    last = p;
  }
  await sleep(rand(50, 110));
  el.dispatchEvent(ptr("pointerup", last, extra));
  await sleep(rand(120, 200));
}

async function tap(el: Element, p: Point, extra: PointerEventInit): Promise<void> {
  await pointerGo(p, true);
  el.dispatchEvent(ptr("pointerdown", p, extra));
  el.dispatchEvent(ptr("pointerup", p, extra));
  await sleep(rand(120, 200));
}

/** Pick a tool as a person does: its button in a Tools panel on screen, or its key. */
async function pickTool(env: ImageHandEnv, surface: string, tool: string, key: string): Promise<void> {
  const btn = env.root.querySelector(`[data-atom="tools"][data-bind="@${CSS.escape(surface)}.tool"] [data-value="${CSS.escape(tool)}"]`);
  if (btn && btn.getAttribute("aria-checked") !== "true") { await click(btn); return; }
  if (btn) return;
  env.root.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  await sleep(rand(160, 260));
}

/**
 * One of the agent's commands on a picture done by hand, as a person does it, while the person watches: the tool
 * picked from the Tools panel (or by its key), then drawn on the picture (a box dragged, a lasso traced, the wand
 * clicked, a stroke painted, the crop frame pulled, text clicked in and typed), or the command's button pressed, or its
 * shortcut. Null when the hand cannot (the picture is not on screen): the window then runs it straight away.
 */
export async function imageByHand(surface: string, name: string, args: Record<string, unknown>, env: ImageHandEnv): Promise<RunResult | null> {
  const handle = imageHandle(surface);
  const el = handle?.overlay();
  const card = env.root.querySelector(`[data-surface="${CSS.escape(surface)}"]`);
  if (!handle || !el || !card) return null;
  const r = card.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null;
  const started = Date.now();
  const landed = async (ms: number): Promise<RunResult | null> => {
    const got = await waitFor(() => (env.lastRun.current && env.lastRun.current.at >= started ? env.lastRun.current : null), ms);
    return got?.result ?? null;
  };
  const tool = DRAWN[name];
  const spec = TOOLS.find((t) => t.name === tool);
  try {
    if (tool && spec) {
      if (name === "select.color" && typeof args.x !== "number") return null;
      if (typeof args.size === "number") env.setOn(surface, { "tool.size": args.size }, "Brush size");
      if (args.mode === "new") env.setOn(surface, { "tool.mode": "new" }, "Selection mode");
      await pickTool(env, surface, tool, spec.key);
      await sleep(120);
      const at = (x: unknown, y: unknown): Point | null => handle.toScreen(Number(x), Number(y));
      const m = mods(args.mode);
      if (name === "select.rect" || name === "select.ellipse") {
        const a = at(args.x, args.y);
        const b = at(Number(args.x) + Number(args.w), Number(args.y) + Number(args.h));
        if (!a || !b) return null;
        await trace(el, [a, b], m);
      } else if (name === "image.crop") {
        // The frame is pulled on the whole picture, which the crop tool shows.
        const o = el.getBoundingClientRect();
        const p = (u: number, v: number) => ({ x: o.left + u * o.width, y: o.top + v * o.height });
        await trace(el, [p(Number(args.x), Number(args.y)), p(Number(args.x) + Number(args.w), Number(args.y) + Number(args.h))], {});
      } else if (Array.isArray(args.points)) {
        const path = (args.points as Array<[number, number]>).map(([x, y]) => at(x, y)).filter((p): p is Point => p !== null);
        if (name === "select.polygon") path.push(path[0]!);
        await trace(el, path, m);
      } else {
        const p = at(args.x ?? 0.5, args.y ?? 0.5);
        if (!p) return null;
        await tap(el, p, m);
      }
      const result = await landed(name === "select.object" ? 60_000 : 6000);
      if (name === "layer.text" && result?.ok && result.layer && typeof args.text === "string") {
        const field = await waitFor(() => env.root.querySelector<HTMLTextAreaElement | HTMLInputElement>(`[data-bind="@${CSS.escape(surface)}.layer.${CSS.escape(result.layer!)}.text"] textarea, [data-bind="@${CSS.escape(surface)}.layer.${CSS.escape(result.layer!)}.text"] input`), 2000);
        if (field) await typeInto(field, args.text);
        else env.setOn(surface, { [`layer.${result.layer}.text`]: args.text }, "Text");
        // The engine's own text tool leaves the Move tool up; so does the hand.
      }
      return result;
    }
    // A command with no drawing: its button on screen when it takes nothing, else its shortcut.
    const btn = Object.keys(args).length ? null : env.root.querySelector(`[data-action="@${CSS.escape(surface)}.${CSS.escape(name)}"]`);
    if (btn) { await click(btn); return await landed(name === "select.subject" ? 60_000 : 6000); }
    const key = IMAGE_COMMANDS.find((c) => c.name === name)?.key;
    if (key && !Object.keys(args).length) {
      const parts = key.split("+");
      const k = parts.at(-1)!;
      await sleep(rand(200, 360));
      env.root.dispatchEvent(new KeyboardEvent("keydown", { key: k === "delete" ? "Delete" : k === "backspace" ? "Backspace" : k, ctrlKey: parts.includes("mod"), shiftKey: parts.includes("shift"), bubbles: true, cancelable: true }));
      return await landed(6000);
    }
    return null;
  } catch (err) {
    if (err instanceof Skip) return null;
    throw err;
  } finally {
    pointerRest();
  }
}

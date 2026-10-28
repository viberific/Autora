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

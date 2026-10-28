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
import type { Canvas } from "./canvas";
import { ATOMS } from "./atoms";
import type { Node } from "./recipe";

export type HandStep =
  | { op: "place"; id: string; recipe: string; name: string; x: number; y: number }
  | { op: "set"; key: string; value: Value; panel: string }
  | { op: "move"; id: string; x: number; y: number }
  | { op: "remove"; id: string };

/** A hand that takes more steps than this in one call is slower than the person wants to watch: the rest goes in at once. */
const MAX_STEPS = 24;

/** The atoms the hand can work. The others (a curve, a pad, a list, lanes) get their value straight away. */
const BY_HAND = new Set(["slider", "knob", "stepper", "toggle", "segmented", "select", "chips", "swatches", "text", "range", "color"]);

/** The panel (live, on screen) whose control a person would use to set this value, if any: the one on the focus first. */
function controlFor(canvas: Canvas, key: string): string | null {
  let best: { id: string; score: number } | null = null;
  for (const p of canvas.panels) {
    if (p.state !== "live") continue;
    let hit = false;
    const walk = (n: Node, hidden: boolean) => {
      if (hit) return;
      const off = hidden || (n.advanced === true && !p.expanded);
      if (!off && n.bind === key && BY_HAND.has(n.atom) && ATOMS[n.atom].control) hit = true;
      n.children?.forEach((c) => walk(c, off));
    };
    walk(p.tree, false);
    if (!hit) continue;
    const score = (p.context === canvas.focus ? 2 : 0) + (p.touched ? 1 : 0);
    if (!best || score > best.score) best = { id: p.id, score };
  }
  return best?.id ?? null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The steps from `before` to `after`, and how many changes had no step. */
export function panaceaSteps(before: Canvas, after: Canvas): { steps: HandStep[]; skipped: number } {
  const steps: HandStep[] = [];
  let skipped = 0;
  const was = new Map(before.panels.map((p) => [p.id, p]));
  const now = new Map(after.panels.map((p) => [p.id, p]));

  // Put away what goes, first, so there is room for what comes.
  for (const p of before.panels) if (!now.has(p.id) && p.state !== "ghost") steps.push({ op: "remove", id: p.id });
  for (const p of after.panels) {
    const old = was.get(p.id);
    if (!old) {
      if (p.state === "live" && p.recipe) steps.push({ op: "place", id: p.id, recipe: p.recipe, name: p.title, x: p.x, y: p.y });
      else skipped++;
    } else if (old.x !== p.x || old.y !== p.y) steps.push({ op: "move", id: p.id, x: p.x, y: p.y });
  }
  // Values: every surface parameter and shared value that changed, by its control where one is on screen.
  const changed: Array<{ key: string; value: Value }> = [];
  for (const s of after.surfaces) {
    const b = before.surfaces.find((x) => x.id === s.id);
    if (!b) continue;
    for (const [k, v] of Object.entries(s.params)) if (!same(b.params[k], v)) changed.push({ key: `@${s.id}.${k}`, value: v });
  }
  for (const [k, v] of Object.entries(after.values)) if (!same(before.values[k], v)) changed.push({ key: k, value: v });
  for (const c of changed) {
    const panel = controlFor(after, c.key);
    if (panel) steps.push({ op: "set", key: c.key, value: c.value, panel });
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
  }
}

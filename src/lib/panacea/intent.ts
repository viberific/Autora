/** Declarative, JSON-only recipe intent. No expressions or executable code are evaluated. */
import type { Value } from "./atoms";
import type { SurfaceKind } from "./kinds";

export type SelectionSignal = "none" | "caret" | "range" | "card";
type ValueTest =
  | { op: "eq"; value: Value }
  | { op: "not"; values: Value[] }
  | { op: "gte" | "lte" | "abs-gte" | "length"; value: number }
  | { op: "nonempty" };

export type Condition =
  | { signal: "param"; name: string; test: ValueTest }
  | { signal: "selection"; is: SelectionSignal }
  | { signal: "focus" }
  | { signal: "absent"; recipe: string };

export interface RecipeWhen {
  kind: SurfaceKind;
  /** A parameter name (or trailing "*" prefix) that triggers this rule on value activity. */
  on?: string;
  all: Condition[];
  weight: number;
  why: string;
}

export interface RecipeNext {
  recipe: string;
  weight: number;
  why: string;
}

export interface IntentSignals {
  kind: SurfaceKind;
  focused: boolean;
  selection: SelectionSignal;
  params: Record<string, Value>;
  present: ReadonlySet<string>;
  /** Absent for a contextual scan; present for one specific value change. */
  changed?: string;
}

function matchesName(pattern: string, name: string): boolean {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name;
}

function same(a: Value, b: Value): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function matchesValue(value: Value | undefined, test: ValueTest): boolean {
  if (value === undefined) return false;
  switch (test.op) {
    case "eq": return same(value, test.value);
    case "not": return !test.values.some((v) => same(value, v));
    case "gte": return typeof value === "number" && Number.isFinite(value) && value >= test.value;
    case "lte": return typeof value === "number" && Number.isFinite(value) && value <= test.value;
    case "abs-gte": return typeof value === "number" && Number.isFinite(value) && Math.abs(value) >= test.value;
    case "length": return Array.isArray(value) && value.length === test.value;
    case "nonempty": return typeof value === "string" ? !!value.trim() : Array.isArray(value) && value.length > 0;
  }
}

export function matchesWhen(rule: RecipeWhen, signals: IntentSignals): boolean {
  if (rule.kind !== signals.kind || !Number.isFinite(rule.weight) || rule.weight <= 0 || !rule.all.length || rule.all.length > 8) return false;
  if (signals.changed !== undefined && (!rule.on || !matchesName(rule.on, signals.changed))) return false;
  return rule.all.every((c) => {
    switch (c.signal) {
      case "focus": return signals.focused;
      case "selection": return signals.selection === c.is;
      case "absent": return !signals.present.has(c.recipe);
      case "param": return Object.entries(signals.params).some(([name, value]) =>
        matchesName(c.name, name) && (signals.changed === undefined || c.name !== rule.on || name === signals.changed)
        && matchesValue(value, c.test));
    }
  });
}

/** Existing reflexes, plus native selection-aware formatting. Kept on recipes when the library is built. */
export const INTENTS: Record<string, RecipeWhen[]> = {
  "photo.histogram": [{ kind: "image", on: "exposure", weight: 12, why: "Exposure is pushed a long way: the histogram shows what is clipping.", all: [
    { signal: "param", name: "exposure", test: { op: "abs-gte", value: 1.2 } }, { signal: "absent", recipe: "photo.curve" },
  ] }],
  "photo.mono": [{ kind: "image", on: "saturation", weight: 11, why: "It is black and white now: contrast and grain carry it from here.", all: [
    { signal: "param", name: "saturation", test: { op: "lte", value: -90 } },
  ] }],
  "photo.straighten": [{ kind: "image", on: "aspect", weight: 10, why: "Cropped: a level horizon matters more in a tight frame.", all: [
    { signal: "param", name: "aspect", test: { op: "not", values: ["original", "free"] } },
  ] }],
  "photo.compare": [{ kind: "image", on: "look", weight: 10, why: "A look is on: compare it with the original.", all: [
    { signal: "param", name: "look", test: { op: "not", values: ["none"] } },
  ] }],
  "data.top": [{ kind: "data", on: "filter.*", weight: 12, why: "Filtered to one category: its top rows.", all: [
    { signal: "param", name: "filter.*", test: { op: "length", value: 1 } },
  ] }],
  "data.table": [{ kind: "data", on: "search", weight: 11, why: "Searching: the matching rows.", all: [
    { signal: "param", name: "search", test: { op: "nonempty" } },
  ] }],
  "document.paragraph": [
    { kind: "doc", on: "align", weight: 10, why: "Aligned: line height goes with it.", all: [
      { signal: "param", name: "align", test: { op: "not", values: ["left"] } },
    ] },
    { kind: "doc", weight: 7, why: "A text range is selected: formatting stays with your selection; the words stay yours.", all: [
      { signal: "focus" }, { signal: "selection", is: "range" },
    ] },
  ],
  "document.lists": [{ kind: "doc", on: "list", weight: 9, why: "Working in a list: switch between bullets and numbering without rewriting it.", all: [
    { signal: "param", name: "list", test: { op: "not", values: ["none"] } },
  ] }],
  "general.board": [{ kind: "board", weight: 7, why: "A card is selected: its colour and the board's structure, without changing your words.", all: [
    { signal: "focus" }, { signal: "selection", is: "card" },
  ] }],
};

/** Compatibility for callers of the kind registry's original value-only offer API. */
export function intentOffer(kind: SurfaceKind, param: string, value: Value, tools: {
  has: (recipe: string) => boolean;
  offer: (recipe: string, why: string) => { recipe: string; why: string } | null;
}): { recipe: string; why: string } | null {
  const present = new Set(Object.keys(INTENTS).filter(tools.has));
  // Some prerequisites (e.g. a tone curve) have no rule of their own.
  for (const rules of Object.values(INTENTS)) for (const rule of rules) for (const c of rule.all) {
    if (c.signal === "absent" && tools.has(c.recipe)) present.add(c.recipe);
  }
  const signals: IntentSignals = { kind, params: { [param]: value }, focused: false, selection: "none", present, changed: param };
  const matches = Object.entries(INTENTS).flatMap(([recipe, rules]) =>
    rules.filter((rule) => matchesWhen(rule, signals)).map((rule) => ({ recipe, rule })));
  matches.sort((a, b) => b.rule.weight - a.rule.weight || a.recipe.localeCompare(b.recipe));
  for (const match of matches) {
    const offered = tools.offer(match.recipe, match.rule.why);
    if (offered) return offered;
  }
  return null;
}

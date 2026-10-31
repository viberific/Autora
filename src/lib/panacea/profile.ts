/**
 * What Panacea learns about the person, so the panels it shows fit them: which controls they reach for, which panels
 * they wave away, which side of their work they put panels on, and how far into the advanced settings they go.
 *
 *   - Progressive detail: an `advanced` control waits behind More until the person has used it a few times.
 *   - Habits: a recipe they keep dismissing stops being suggested; panels go on the side they put them.
 *   - Density follows skill: someone who lives in the advanced settings gets denser, more compact panels.
 *
 * One profile per install (server/panacea.ts keeps it). Pure: plain JSON in and out.
 */
import type { Side } from "./canvas";
import { KINDS, KIND_NAMES, paramsOf, type SurfaceKind } from "./kinds";

export interface Profile {
  /** Times used: "param:exposure", "value:budget", "atom:slider", "recipe:photo.light". */
  uses: Record<string, number>;
  /** Times waved away, by recipe id or fingerprint. */
  dismissed: Record<string, number>;
  /** Where they put panels relative to what they work on. */
  sides: Record<Side, number>;
  since: number;
  /** Last explicit dismissal: used for a short cooldown, without forgetting a repeated refusal. */
  dismissedAt?: Record<string, number>;
}

/** Uses before an advanced control stops hiding behind More. */
const REVEAL_AFTER = 3;
/** Dismissals before a recipe is no longer suggested unasked. */
const QUIET_AFTER = 2;

export function newProfile(): Profile {
  return { uses: {}, dismissed: {}, sides: { right: 0, left: 0, below: 0, above: 0 }, since: Date.now() };
}

const counts = (raw: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 2000)) {
      if (k.length <= 120 && typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = Math.min(1e6, Math.floor(v));
    }
  }
  return out;
};

export function normalizeProfile(raw: unknown): Profile {
  const p = newProfile();
  if (!raw || typeof raw !== "object") return p;
  const r = raw as Record<string, unknown>;
  p.uses = counts(r.uses);
  p.dismissed = counts(r.dismissed);
  if (r.dismissedAt && typeof r.dismissedAt === "object") {
    p.dismissedAt = {};
    for (const [key, value] of Object.entries(r.dismissedAt as Record<string, unknown>).slice(0, 2000)) {
      if (key.length <= 80 && typeof value === "number" && Number.isFinite(value) && value >= 0) p.dismissedAt[key] = value;
    }
  }
  const sides = counts(r.sides);
  for (const s of ["right", "left", "below", "above"] as Side[]) p.sides[s] = sides[s] ?? 0;
  if (typeof r.since === "number") p.since = r.since;
  return p;
}

/** The key a bind is counted under: a surface parameter by its name alone, so exposure is exposure on any photo. */
export function usageKey(bind: string): string {
  if (!bind.startsWith("@")) return `value:${bind}`;
  const dot = bind.indexOf(".");
  return `param:${dot < 0 ? bind.slice(1) : bind.slice(dot + 1)}`;
}

export function noteUse(p: Profile, key: string, n = 1, kind?: SurfaceKind): void {
  if (!Number.isFinite(n) || n <= 0) return;
  p.uses[key] = (p.uses[key] ?? 0) + n;
  if (kind) {
    const scoped = `kind:${kind}:${key}`;
    p.uses[scoped] = (p.uses[scoped] ?? 0) + n;
  }
}

export function noteDismiss(p: Profile, key: string, now = Date.now()): void {
  p.dismissed[key] = (p.dismissed[key] ?? 0) + 1;
  if (Number.isFinite(now)) (p.dismissedAt ??= {})[key] = now;
}

export function noteSide(p: Profile, side: Side): void {
  p.sides[side] += 1;
}

/** Has the person used this enough that it no longer hides behind More? */
export function revealed(p: Profile, bind: string, kind?: SurfaceKind): boolean {
  return usesFor(p, usageKey(bind), kind) >= REVEAL_AFTER;
}

export function quieted(p: Profile, recipe: string): boolean {
  return (p.dismissed[recipe] ?? 0) >= QUIET_AFTER;
}

/** One refusal buys ten minutes of quiet; two stay quiet until explicitly asked. */
export function cooling(p: Profile, recipe: string, now = Date.now()): boolean {
  const at = p.dismissedAt?.[recipe];
  return quieted(p, recipe) || (at !== undefined && now - at < 600_000);
}

/** Scoped counts win; legacy profiles still work before an engine has recorded scoped activity. */
export function usesFor(p: Profile, key: string, kind?: SurfaceKind): number {
  if (!kind) return p.uses[key] ?? 0;
  const prefix = `kind:${kind}:`;
  if (Object.keys(p.uses).some((k) => k.startsWith(prefix))) return p.uses[`${prefix}${key}`] ?? 0;
  return p.uses[key] ?? 0;
}

/**
 * How at home they are, 0 to 1: the advanced settings they use count most, then how much they have used Panacea at
 * all. Starts at 0, so a first canvas is calm and roomy.
 */
export function skillOf(p: Profile, kind: SurfaceKind): number {
  const params = paramsOf(kind).filter((s) => !s.derived);
  const advanced = params.filter((s) => s.advanced || s.kind === "points");
  // Engines without an advanced tier learn from their own declared controls, not photo knobs.
  const prefix = `kind:${kind}:`;
  const dynamic = [...new Set(Object.keys(p.uses).map((key) => key.startsWith(prefix) ? key.slice(prefix.length) : key)
    .filter((key) => key.startsWith("param:") && KINDS[kind].skillFamilies?.some((family) => key.slice(6).startsWith(family)))
    .map((key) => key.slice(6)))].sort().slice(0, 64);
  const names = [...new Set([...params.map((a) => a.name), ...dynamic])];
  const detail = advanced.length ? advanced.map((a) => a.name) : names;
  const deep = detail.length ? detail.filter((name) => usesFor(p, `param:${name}`, kind) >= REVEAL_AFTER).length / detail.length : 0;
  const total = names.reduce((n, name) => n + usesFor(p, `param:${name}`, kind), 0);
  return Math.min(1, deep * 0.7 + Math.min(1, total / 400) * 0.3);
}

export function densityOf(p: Profile, kind?: SurfaceKind): "calm" | "dense" {
  const skill = kind ? skillOf(p, kind) : Math.max(...KIND_NAMES.map((k) => skillOf(p, k)));
  return skill >= 0.5 ? "dense" : "calm";
}

/** The side they put panels on most; right until they show otherwise. */
export function preferredSide(p: Profile): Side {
  let best: Side = "right";
  for (const s of ["left", "below", "above"] as Side[]) if (p.sides[s] > p.sides[best] + 1) best = s;
  return best;
}

/** Where a box sits relative to another. */
export function sideOf(box: { x: number; y: number; w: number }, anchor: { x: number; y: number; w: number; h: number }): Side {
  const cx = box.x + box.w / 2;
  if (cx > anchor.x + anchor.w) return "right";
  if (cx < anchor.x) return "left";
  return box.y > anchor.y + anchor.h / 2 ? "below" : "above";
}

/** What the agent is told about the person, in a line or two; null while there is nothing to tell. */
export function profileWords(p: Profile): string | null {
  const top = Object.entries(p.uses)
    .filter(([k]) => k.startsWith("param:") || k.startsWith("recipe:"))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, v]) => `${k.replace(/^(param|recipe):/, "")} (${v})`);
  const waved = Object.entries(p.dismissed).filter(([, v]) => v >= QUIET_AFTER).map(([k]) => k).slice(0, 8);
  if (!top.length && !waved.length) return null;
  const skill = Math.max(...KIND_NAMES.map((k) => skillOf(p, k)));
  const comfortable = KIND_NAMES.filter((k) => skillOf(p, k) >= 0.5);
  const parts = [
    top.length ? `reaches for ${top.join(", ")}` : "",
    waved.length ? `has waved away ${waved.join(", ")} (do not suggest them unasked)` : "",
    `puts panels to the ${preferredSide(p)}`,
    skill >= 0.5 ? "is at home in the advanced settings (panels are drawn dense)" : skill >= 0.2 ? "is getting comfortable" : "is new to it (keep panels few and calm)",
    comfortable.length ? `comfortable with ${comfortable.join(", ")} controls (do not infer skill in other kinds)` : "",
  ].filter(Boolean);
  return `What Panacea has learned about this person: ${parts.join("; ")}.`;
}

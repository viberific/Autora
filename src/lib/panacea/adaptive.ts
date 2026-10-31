/** Cheap deterministic intent scoring. Offers only: never moves a control or changes the work. */
import type { Value } from "./atoms";
import { contextOf, type Canvas, type Surface } from "./canvas";
import { matchesWhen, type IntentSignals } from "./intent";
import { KINDS } from "./kinds";
import { instantiate, type Recipe } from "./library";
import { cooling, usesFor, type Profile } from "./profile";
import { fingerprint, parseBind, type Node } from "./recipe";

interface AdaptiveOptions {
  surface?: string | null;
  change?: { param: string; value: Value };
  profile?: Profile;
  quiet?: (recipe: string) => boolean;
  /** Explicit clock for reproducible tests and cooldown decisions. */
  now?: number;
  limit?: number;
}

interface RankedRecipe {
  recipe: Recipe;
  near: string;
  score: number;
  why: string;
  evidence: Array<{ signal: "context" | "next" | "use" | "dismissal"; weight: number; why: string }>;
}

export function signalsFor(canvas: Canvas, surface: Surface, change?: AdaptiveOptions["change"]): IntentSignals {
  return {
    kind: surface.kind,
    focused: canvas.focus === surface.id,
    selection: KINDS[surface.kind].selection(surface),
    params: { ...surface.params, ...(change ? { [change.param]: change.value } : {}) },
    present: new Set(canvas.panels.filter((p) => p.context === surface.id).flatMap((p) => p.recipe ? [p.recipe] : [])),
    ...(change ? { changed: change.param } : {}),
  };
}

function boundParams(tree: Node, surface: string): string[] {
  const found: string[] = [];
  const walk = (n: Node) => {
    if (n.bind) {
      const bind = parseBind(n.bind);
      if (bind.surface === surface) found.push(bind.param);
    }
    n.children?.forEach(walk);
  };
  walk(tree);
  return found;
}

/**
 * Recipes need contextual evidence before use counts can boost them. Quiet/dismissed recipes, duplicate shapes and
 * recipes which fail instantiate/checkTree never compete. Next edges are one hop from a live, used panel, not a loop.
 */
export function rankRecipes(canvas: Canvas, list: Recipe[], opts: AdaptiveOptions = {}): RankedRecipe[] {
  // Value activity has always returned an offer preview; the page owns the single ghost slot and refuses a second.
  // Background contextual scans, which can place a ghost themselves, wait until that slot is free.
  if (!opts.change && canvas.panels.some((p) => p.state === "ghost")) return [];
  const surface = canvas.surfaces.find((s) => s.id === (opts.surface ?? canvas.focus));
  if (!surface) return [];
  const signals = signalsFor(canvas, surface, opts.change);
  const ctx = contextOf(canvas, { [surface.kind]: surface.id });
  const now = opts.now ?? Date.now();
  const profile = opts.profile;
  const existing = new Set(canvas.panels.filter((p) => p.context === surface.id).map((p) => fingerprint(p.tree)));
  const next = new Map<string, { weight: number; why: string }>();
  if (!opts.change) {
    for (const panel of canvas.panels) {
      if (panel.context !== surface.id || panel.state !== "live" || panel.touched === undefined) continue;
      const source = list.find((r) => r.id === panel.recipe);
      for (const edge of source?.next?.slice(0, 8) ?? []) {
        if (Number.isFinite(edge.weight) && edge.weight > 0 && edge.weight > (next.get(edge.recipe)?.weight ?? 0)) {
          next.set(edge.recipe, { weight: Math.min(20, edge.weight), why: edge.why.slice(0, 240) });
        }
      }
    }
  }
  const ranked: RankedRecipe[] = [];
  const shapes = new Map<string, string>();
  const seen = new Set<string>();
  const pool = list.filter((r) => r.domain === KINDS[surface.kind].domain)
    .sort((a, b) => a.id.localeCompare(b.id)).slice(0, 256);
  for (const recipe of pool) {
    if (seen.has(recipe.id) || signals.present.has(recipe.id)) continue;
    seen.add(recipe.id);
    if (opts.quiet?.(recipe.id) || (profile && (cooling(profile, recipe.id, now) || (recipe.fp && cooling(profile, recipe.fp, now))))) continue;
    const evidence: RankedRecipe["evidence"] = [];
    const matched = (recipe.when ?? []).slice(0, 16).filter((rule) => matchesWhen(rule, signals))
      .sort((a, b) => b.weight - a.weight)[0];
    if (matched) evidence.push({ signal: "context", weight: Math.min(20, matched.weight), why: matched.why.slice(0, 240) });
    const edge = next.get(recipe.id);
    if (edge) evidence.push({ signal: "next", ...edge });
    const learned = !recipe.when?.length && recipe.origin === "composed" && recipe.uses > 0;
    if (!evidence.length && !learned) continue;
    const made = instantiate(recipe, ctx);
    if ("error" in made) continue;
    const fp = fingerprint(made.tree);
    if (existing.has(fp) || opts.quiet?.(fp) || (profile && cooling(profile, fp, now))) continue;
    // A used composition can evolve into a contextual option through the binds the rulebook already understands.
    if (learned) {
      const params = boundParams(made.tree, surface.id);
      const relevant = opts.change ? params.includes(opts.change.param)
        : signals.focused && params.some((param) => profile && usesFor(profile, `param:${param}`, surface.kind) >= 3);
      if (relevant) evidence.push({ signal: "context", weight: 6, why: "A panel you have used fits the controls you are working with." });
    }
    if (!evidence.length) continue;
    const uses = profile ? usesFor(profile, `recipe:${recipe.id}`, surface.kind) : 0;
    // allRecipes already projects profile counts onto builtins; do not count the same activity twice.
    const libraryUses = profile && recipe.origin === "builtin" ? 0 : Math.max(0, recipe.uses);
    const boost = Math.min(3, Math.log2(1 + uses + libraryUses));
    if (boost) evidence.push({ signal: "use", weight: boost, why: "You have used this panel before." });
    const dismissals = profile?.dismissed[recipe.id] ?? 0;
    if (dismissals) evidence.push({ signal: "dismissal", weight: -Math.min(6, dismissals * 3), why: "You previously waved this panel away." });
    const score = evidence.reduce((n, e) => n + e.weight, 0);
    if (score > 0) {
      ranked.push({ recipe, near: surface.id, score, why: evidence[0]!.why, evidence });
      shapes.set(recipe.id, fp);
    }
  }
  const unique = new Set<string>();
  return ranked.sort((a, b) => b.score - a.score || a.recipe.id.localeCompare(b.recipe.id)).filter((r) => {
    const fp = shapes.get(r.recipe.id)!;
    if (unique.has(fp)) return false;
    unique.add(fp);
    return true;
  }).slice(0, Math.max(0, Math.min(14, opts.limit ?? 8)));
}

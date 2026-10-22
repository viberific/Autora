/**
 * Roles: which model does which part of the work.
 *
 * Settings names the main model and, beside it, up to two more. The main one
 * does the work of a task: planning, building and every tool call, in one
 * conversation, so one model's prompt cache serves all of it. Talk mode's fast
 * model speaks. The background model folds old turns, learns and remarks; it
 * carries no live conversation, so it can be another model (even another
 * provider's) without costing the chat a cache. Either left empty falls back to
 * the rule that held before roles existed.
 *
 * There is deliberately no model of its own for planning: a model's prompt cache
 * is its own, so every hand-over between a planner and a builder cost one
 * uncached read of the whole conversation, and two models read the same history
 * a little differently. Another vendor reading the history is safe because it is
 * kept in one neutral shape (ChatMessage in ./llm) and rebuilt in each vendor's
 * own shape on every call.
 */

/** One model, and where and how it is reached. */
export interface Target {
  provider: string;
  model: string;
  key: string;
  baseUrl: string;
}

interface RoleModels {
  /** The main model, which does the work, and its provider. */
  provider: string;
  model: string;
  key: string;
  baseUrl: string;
  /** Talk mode's fast model, on the main provider, or empty. */
  fastModel: string;
  /** The background model, or null for the old rule. */
  background: Target | null;
}

/** The main model as a target. */
export function mainTarget(r: Pick<RoleModels, "provider" | "model" | "key" | "baseUrl">): Target {
  return { provider: r.provider, model: r.model, key: r.key, baseUrl: r.baseUrl };
}

/**
 * The model for unwatched work: the environment's override (a model of the
 * main provider), then the background role, then talk mode's fast model, then
 * a cheaper model of the main provider's when one is priced, then the main model.
 */
export function backgroundTarget(r: RoleModels, override?: string, cheaper?: string | null): Target {
  const main = mainTarget(r);
  const forced = (override || "").trim();
  if (forced) return { ...main, model: forced };
  if (r.background?.model) return r.background;
  if (r.fastModel) return { ...main, model: r.fastModel };
  /* Nothing named: a cheaper model of the same provider when the price list has one (providers.ts cheaperSibling). */
  return cheaper ? { ...main, model: cheaper } : main;
}

/**
 * The model a research worker runs on: AUTORA_WORKER_MODEL when set ("main" keeps the main model), else a cheaper model
 * of the main provider when its price list has one, else the main model. A worker's conversation is its own -- only
 * its report reaches the chat -- so unlike a planner it shares no prompt cache with the main model and costs none.
 * It only looks things up with read-only tools, and the main model judges what it reports.
 */
export function workerTarget(r: Pick<RoleModels, "provider" | "model" | "key" | "baseUrl">, override?: string, cheaper?: string | null): Target {
  const main = mainTarget(r);
  const forced = (override || "").trim();
  if (forced === "main") return main;
  if (forced) return { ...main, model: forced };
  return cheaper ? { ...main, model: cheaper } : main;
}

/**
 * Every model that may answer in one conversation this turn, for the context
 * window: they all hold the same conversation, so the smallest window binds.
 * The voice is the main provider's.
 */
export function conversationTargets(r: RoleModels, voice?: string): Pick<Target, "provider" | "model">[] {
  const out: Pick<Target, "provider" | "model">[] = [{ provider: r.provider, model: r.model }];
  if (voice && voice !== r.model) out.push({ provider: r.provider, model: voice });
  return out;
}

/**
 * An Organization agent's own model: it replaces the main model for that
 * agent's chat, so the agent works on it, while the background
 * model stays Settings' own. An agent runs in a chat of its own, so its model
 * never shares a conversation (or a prompt cache) with the lead's.
 *
 * Models are named per vendor, so the choice carries its provider. Another
 * provider than the main one is used when it can be reached (`reach` gives its
 * key and address, or null without a key); otherwise the agent runs on the main
 * model and `note` says why, rather than sending a model id to a vendor that
 * does not know it.
 */
export function agentModelFor<R extends RoleModels>(
  active: R,
  agent: { name: string; model?: { provider: string; model: string } } | null | undefined,
  reach: (provider: string) => { key: string; baseUrl: string } | null,
  providerLabel: (id: string) => string = (id) => id,
): { active: R; note: string | null } {
  const own = agent?.model;
  if (!own?.model || !active.provider) return { active, note: null };
  if (own.provider === active.provider) return { active: { ...active, model: own.model }, note: null };
  const there = reach(own.provider);
  if (!there) {
    return {
      active,
      note: `${agent!.name}'s model (${own.model}) is on ${providerLabel(own.provider)}, which has no key now, ` +
        `so it runs on ${active.model}. Add the key in Settings, or choose it another model on the Organization page.`,
    };
  }
  /* Talk mode's fast model belongs to the main provider; an agent's chat is never spoken. */
  return {
    active: { ...active, provider: own.provider, model: own.model, key: there.key, baseUrl: there.baseUrl, fastModel: "" },
    note: null,
  };
}

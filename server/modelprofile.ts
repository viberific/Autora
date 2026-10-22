/**
 * What one model takes, beyond what every model takes.
 *
 * The agent loop speaks in one neutral shape (ChatCall in ./llm), and each vendor's
 * request is built from it. Most of a call means the same to every model; a few
 * knobs do not. This says, per model, which of them it takes and in what form, so
 * an optimisation for one model switches on when that model is chosen and stays
 * off for the rest:
 *
 *   effort       how hard to think. A caller says "low" for work nobody watches (a
 *                research worker's lookups, folding old turns, a remark); Claude
 *                takes it as `output_config.effort`, OpenAI's reasoning models as
 *                `reasoning_effort`, and a model that has neither is sent nothing.
 *   temperature  the newest Claude models refuse one (Opus 4.7 and later, Sonnet
 *                and Haiku 5 and later, Fable, Mythos) and OpenAI's reasoning
 *                models ignore or refuse it; for those it is left out and the
 *                model's own default stands.
 *
 * The fallback for every model, known or not, is learning: a vendor that refuses
 * one of these with a 400 that names it is asked again without it, and that model
 * is not sent it again (learnRefusal). A model this table has never heard of works
 * the first time and costs one extra request at most.
 */

export type Effort = "low" | "medium" | "high";

interface ModelProfile {
  /** How this model takes the effort hint, or null when it takes none. */
  effort: "anthropic" | "openai" | null;
  /** Whether to send a temperature at all. */
  temperature: boolean;
}

/** Family and version out of a Claude id: "claude-opus-4-7" -> opus 4.7, "claude-sonnet-5-5" -> sonnet 5.5,
    "anthropic/claude-sonnet-4.5" (OpenRouter's spelling) -> sonnet 4.5. Null for an id that is not Claude's. */
export function claudeVersion(model: string): { family: string; version: number } | null {
  const m = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d{1,2})(?!\d))?/i.exec(model);
  if (!m) return null;
  return { family: m[1].toLowerCase(), version: Number(m[2]) + (m[3] ? Number(m[3]) / 10 : 0) };
}

/** OpenAI's reasoning models: GPT-5 and later, and the o-series. They take `max_completion_tokens` and reasoning
    effort, and refuse a temperature. The one rule for it: llm.ts asks here too. */
const OPENAI_REASONING = /^(gpt-(?:[5-9]|\d{2,})|o[1-9])/i;
export const isOpenAiReasoningModel = (model: string): boolean => OPENAI_REASONING.test(model);

/** What `model`, reached through `provider` (and `baseUrl`), takes. */
export function modelProfile(provider: string, model: string, baseUrl = ""): ModelProfile {
  const claude = claudeVersion(model);
  if (provider === "anthropic" && claude) {
    const { family, version } = claude;
    const newest = family === "fable" || family === "mythos" || version >= 5 || (family === "opus" && version >= 4.7);
    // Effort: Opus from 4.5, Sonnet from 4.6, Haiku from 5, and every Fable and Mythos.
    const effort = family === "fable" || family === "mythos" || version >= 5 ||
      (family === "opus" && version >= 4.5) || (family === "sonnet" && version >= 4.6);
    return { effort: effort ? "anthropic" : null, temperature: !newest };
  }
  const openai = provider === "openai" || /(^|\/\/)api\.openai\.com/.test(baseUrl);
  if (openai && OPENAI_REASONING.test(model)) return { effort: "openai", temperature: false };
  return { effort: null, temperature: true };
}

/** Request fields a model refused, by "provider|baseUrl|model". */
const refused = new Map<string, Set<"effort" | "temperature">>();
const keyOf = (provider: string, baseUrl: string, model: string) => `${provider}|${baseUrl}|${model}`;

/** The profile with what this model has refused taken off it. */
export function effectiveProfile(provider: string, model: string, baseUrl = ""): ModelProfile {
  const base = modelProfile(provider, model, baseUrl);
  const no = refused.get(keyOf(provider, baseUrl, model));
  if (!no) return base;
  return { effort: no.has("effort") ? null : base.effort, temperature: base.temperature && !no.has("temperature") };
}

/**
 * Whether a vendor's refusal names a field this request sent from the profile: if so it is remembered, and the
 * caller sends the request again without it. Only a 400 that says which field: anything else is a real failure.
 */
export function learnRefusal(
  provider: string, model: string, baseUrl: string,
  status: number | null, message: string, sent: { effort: boolean; temperature: boolean },
): boolean {
  if (status !== 400) return false;
  const field = sent.effort && /effort|output_config/i.test(message) ? "effort"
    : sent.temperature && /temperature|sampling/i.test(message) ? "temperature" : null;
  if (!field) return false;
  const key = keyOf(provider, baseUrl, model);
  const set = refused.get(key) ?? new Set();
  if (set.has(field)) return false;
  set.add(field);
  refused.set(key, set);
  console.warn(`[llm] ${provider}/${model} refused ${field}; it is left out from now on`);
  return true;
}

/* OpenAI models reached through the Responses API (/v1/responses) instead of chat completions: GPT-6 and later, which
   take function tools on chat completions only with reasoning switched off ("To use function tools, use /v1/responses
   or set reasoning_effort to 'none'"), and any other OpenAI model that has answered chat completions that way. Every
   other model keeps chat completions, as before. */
const RESPONSES_MODELS = /^gpt-(?:[6-9]|\d{2,})/i;
const viaResponses = new Set<string>();

/** Whether this call goes to OpenAI's Responses API. Only OpenAI itself serves it; a gateway is never assumed to. */
export function usesResponsesApi(provider: string, model: string, baseUrl = ""): boolean {
  const openai = provider === "openai" || /(^|\/\/)api\.openai\.com/.test(baseUrl);
  if (!openai) return false;
  return RESPONSES_MODELS.test(model) || viaResponses.has(keyOf(provider, baseUrl, model));
}

/** Whether a chat-completions refusal says to use the Responses API; if so it is remembered for this model. */
export function learnResponsesApi(provider: string, model: string, baseUrl: string, status: number | null, message: string): boolean {
  const openai = provider === "openai" || /(^|\/\/)api\.openai\.com/.test(baseUrl);
  if (!openai || status !== 400 || !/\/v1\/responses|responses api/i.test(message)) return false;
  const key = keyOf(provider, baseUrl, model);
  if (viaResponses.has(key)) return false;
  viaResponses.add(key);
  console.warn(`[llm] ${provider}/${model} asked for the Responses API; it is used from now on`);
  return true;
}

/** For tests: forget what was learned. */
export function forgetRefusals(): void {
  refused.clear();
  viaResponses.clear();
}

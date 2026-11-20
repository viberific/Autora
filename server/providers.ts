/**
 * Which model vendors Autora can talk to, and what they charge.
 *
 * One table, read by everything: the settings panel offers these models, the
 * chat client knows from `kind` which wire protocol to speak, and the billing
 * page prices a finished turn from the same numbers the panel quoted before it
 * ran. Keeping them apart is how a console ends up quoting one price and
 * billing another.
 *
 * Prices are the vendors' published list prices in US dollars per million
 * tokens, noted below with the date they were read. They move, and a cached
 * price silently going stale is worse than an honest "checked in March", so the
 * date travels with them to the UI. OpenRouter is the exception: it publishes
 * per-token prices over its API, so its catalogue can be refreshed live.
 */

/** The wire protocol a vendor speaks. Three shapes cover every provider here:
    most of the field has settled on OpenAI's chat-completions schema. */
type ProviderKind = "gemini" | "openai" | "anthropic" | "cli";

export interface ModelSpec {
  id: string;
  label: string;
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** USD per million input tokens served from the provider's prompt cache.
      Left out where we have not checked it, and those tokens are then
      priced as ordinary input: overstated, never under. */
  cachedInput?: number;
  /** Dearer prices for a prompt longer than `tokens` (Haiku 5.5 past 100K): every token of that request is billed at
      them, cached input at the same fraction of the input price as below the line. */
  over?: { tokens: number; input: number; output: number };
  /** One short line: what this model is for, shown beside it in the picker. */
  note?: string;
  /** How much this model actually holds, in tokens, where the vendor publishes
      a figure. The context gauge and the point at which older turns are folded
      away are both read from it, so a wrong number here is the difference
      between a model being used to a tenth of its capacity and being used
      whole. Left out where no figure has been read: a live listing that quotes
      one fills it in (see listModels), and failing that the vendor's own
      default applies, and failing that a plainly-labelled assumption. */
  window?: number;
  /** False for a model we found by asking the vendor for its catalogue but
      whose price it did not publish. Such a model can still be selected and
      used; its turns are counted and marked unpriced rather than billed at a
      figure nobody checked. */
  priced?: boolean;
  /** The multiple this model bills at inside its vendor's published peak
      hours. Only Lebrel prices on a schedule today (see lebrelPeak); absent
      means the price holds all day. */
  peak?: number;
}

interface ProviderSpec {
  id: string;
  label: string;
  /** The window every model this vendor serves shares, when there is one. Some
      vendors publish a single figure for the family rather than a page per
      model, and it is that figure this holds. */
  window?: number;
  kind: ProviderKind;
  /** What this vendor is, in a sentence, for someone deciding whether to add it. */
  note: string;
  /** Environment variables consulted when no key has been saved in the app. */
  envKeys: string[];
  /** What a key looks like, so a wrong paste is obvious before it is saved. */
  keyHint: string;
  /** Where to get one. */
  keysUrl: string;
  /** API root. Editable per install for local servers and proxies. */
  baseUrl: string;
  defaultModel: string;
  models: ModelSpec[];
  /** True where the vendor publishes a model list we can fetch and merge. */
  listable: boolean;
  /** Free-form models: the picker offers typing an id rather than choosing. */
  openEnded?: boolean;
  /** Where this vendor publishes what is left of the money paid in, and how to
      read the dollars out of it. Absent where the vendor has no such endpoint
      -- and then no balance is claimed for it at all, rather than borrowing
      another vendor's. See ./vendor-money. */
  balance?: BalanceSpec;
  /** True where one model is served from several endpoints and a request may
      say which one (OpenRouter, and only OpenRouter here). Such a vendor's
      model rows get a pin field in Settings, and a pinned turn sends the
      vendor's routing block. Absent everywhere else on purpose: the block is
      not a vendor-neutral field, and a gateway that does not know it refuses
      the whole request rather than ignoring it. */
  pinnable?: boolean;
  /** True where nothing is paid per token: the turns run on a subscription, through the vendor's own CLI signed in on this
      host (server/llm-cli.ts). Such a vendor needs no key, and its turns are counted but not billed. */
  cli?: boolean;
}

/**
 * How to ask a vendor what is left of the money paid in.
 *
 * Only three of the vendors here publish such a thing, and each answers in its
 * own shape, so each says both how to reach it and which number is the dollars.
 * The path is read against the provider's base URL with any /v1 suffix dropped,
 * since that root is editable per install for local servers and proxies.
 */
interface BalanceSpec {
  /** Path to append to the vendor's base URL, e.g. "/user/balance". */
  path: string;
  /** Which number in the reply is the remaining USD. */
  field: "deepseek" | "orcarouter" | "openrouter";
  /** Where the path hangs. Most vendors keep everything under the versioned
      prefix (/v1/balance); DeepSeek's money endpoint hangs off the host itself
      (/user/balance), so stripping /v1 from its base would aim at nothing. */
  root?: "base" | "host";
}

/** When the prices below were last read off the vendors' pricing pages. */
export const PRICES_CHECKED = "2026-05";

export const PROVIDERS: ProviderSpec[] = [
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    note: "GPT models, via the OpenAI API.",
    envKeys: ["OPENAI_API_KEY"],
    keyHint: "sk-...",
    keysUrl: "https://platform.openai.com/api-keys",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    listable: true,
    models: [
      { id: "gpt-5", label: "GPT-5", input: 1.25, output: 10, note: "Flagship reasoning" },
      { id: "gpt-5-mini", label: "GPT-5 mini", input: 0.25, output: 2, note: "Cheaper GPT-5" },
      { id: "gpt-5-nano", label: "GPT-5 nano", input: 0.05, output: 0.4, note: "Fastest, cheapest" },
      { id: "gpt-4.1", label: "GPT-4.1", input: 2, output: 8, note: "Long context, general" },
      { id: "gpt-4.1-mini", label: "GPT-4.1 mini", input: 0.4, output: 1.6 },
      { id: "gpt-4.1-nano", label: "GPT-4.1 nano", input: 0.1, output: 0.4 },
      { id: "gpt-4o", label: "GPT-4o", input: 2.5, output: 10 },
      { id: "gpt-4o-mini", label: "GPT-4o mini", input: 0.15, output: 0.6, note: "Good default for a console" },
      { id: "o3", label: "o3", input: 2, output: 8, note: "Deliberate reasoning" },
      { id: "o4-mini", label: "o4-mini", input: 1.1, output: 4.4 },
    ],
  },
  {
    id: "gemini",
    label: "Google Gemini",
    kind: "gemini",
    note: "Google AI Studio. The free tier covers Flash.",
    envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    keyHint: "AIza...",
    keysUrl: "https://aistudio.google.com/apikey",
    baseUrl: "https://generativelanguage.googleapis.com",
    defaultModel: "gemini-flash-latest",
    listable: true,
    models: [
      {
        id: "gemini-flash-latest",
        label: "Gemini Flash (latest)",
        input: 0.3,
        output: 2.5,
        note: "Rolling alias — follows Google's current Flash",
        window: 1_048_576,
      },
      { window: 1_048_576, id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", input: 1.25, output: 10, note: "Hardest questions" },
      { window: 1_048_576, id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", input: 0.3, output: 2.5 },
      { window: 1_048_576, id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", input: 0.1, output: 0.4 },
      { window: 1_048_576, id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", input: 0.1, output: 0.4 },
      { window: 1_048_576, id: "gemini-2.0-flash-lite", label: "Gemini 2.0 Flash Lite", input: 0.075, output: 0.3 },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    kind: "anthropic",
    note: "Claude models, via the Anthropic Messages API.",
    envKeys: ["ANTHROPIC_API_KEY"],
    keyHint: "sk-ant-...",
    keysUrl: "https://console.anthropic.com/settings/keys",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-haiku-5-5",
    listable: true,
    /* The 5.5 family read from Anthropic's model table in October 2026. Cache reads are a twentieth of the input price on
       Opus 5.5 and Sonnet 5.5 ($0.20), a tenth on Haiku 5.5; cache writes are the usual multiple (costParts). Haiku 5.5
       costs five times as much for a prompt past 100K tokens. The older ones stay listed for installs that chose them. */
    models: [
      { window: 1_000_000, id: "claude-opus-5-5", label: "Claude Opus 5.5", input: 4, output: 20, cachedInput: 0.2, note: "Most capable; hardest work" },
      { window: 1_000_000, id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", input: 2, output: 10, cachedInput: 0.2, note: "Balanced; everyday coding and agent work" },
      { window: 1_000_000, id: "claude-haiku-5-5", label: "Claude Haiku 5.5", input: 0.1, output: 0.5, cachedInput: 0.01, over: { tokens: 100_000, input: 0.5, output: 2.5 }, note: "Fast and very cheap" },
      { window: 200_000, id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", input: 3, output: 15, note: "Previous Sonnet" },
      { window: 200_000, id: "claude-haiku-4-5", label: "Claude Haiku 4.5", input: 1, output: 5, note: "Previous Haiku" },
      { window: 200_000, id: "claude-opus-4-1", label: "Claude Opus 4.1", input: 15, output: 75, note: "Older Opus, priciest" },
    ],
  },
  /* ------------------------------------------- subscription CLIs -- */
  /* Not the API: the vendor's own CLI, signed in on this host, answering a chat turn. No key, no per-token bill, and the
     person's subscription quota is what it spends (server/llm-cli.ts). The model ids are the CLI's own names, which drift
     with the CLI rather than with a price page, so both lists are open-ended and unpriced. */
  {
    id: "gemini-cli",
    label: "Gemini (subscription)",
    kind: "cli",
    cli: true,
    note: "Gemini through the Antigravity CLI signed in on this host. No API key; it spends the Google subscription's quota.",
    envKeys: [],
    keyHint: "",
    keysUrl: "https://antigravity.google/cli",
    baseUrl: "",
    defaultModel: "gemini-3.8-flash-high",
    listable: false,
    openEnded: true,
    models: [
      { window: 1_000_000, id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (high)", input: 0, output: 0, priced: false },
      { window: 1_000_000, id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (medium)", input: 0, output: 0, priced: false },
      { window: 1_000_000, id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (low)", input: 0, output: 0, priced: false },
    ],
  },
  {
    id: "claude-cli",
    label: "Claude (subscription)",
    kind: "cli",
    cli: true,
    note: "Claude Code signed in on this host. No API key; it spends the Claude subscription's quota.",
    envKeys: [],
    keyHint: "",
    keysUrl: "https://claude.ai/code",
    baseUrl: "",
    /* Claude Code's own aliases: each follows the newest model of its line as the CLI updates, so a choice made here does
       not go stale. A full id (claude-opus-5-5) is typed in when one model must be held. Sonnet by default: every plan has it. */
    defaultModel: "sonnet",
    listable: false,
    openEnded: true,
    models: [
      { window: 1_000_000, id: "opus", label: "Claude Opus (latest)", input: 0, output: 0, priced: false, note: "Most capable; spends the plan's quota fastest" },
      { window: 1_000_000, id: "sonnet", label: "Claude Sonnet (latest)", input: 0, output: 0, priced: false, note: "Balanced; everyday work" },
      { window: 1_000_000, id: "haiku", label: "Claude Haiku (latest)", input: 0, output: 0, priced: false, note: "Fast; lightest on the quota" },
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai",
    note: "Very cheap, OpenAI-compatible.",
    envKeys: ["DEEPSEEK_API_KEY"],
    keyHint: "sk-...",
    keysUrl: "https://platform.deepseek.com/api_keys",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-flash",
    listable: true,
    // /user/balance is all DeepSeek's API will say about money: no usage
    // endpoint exists, and per-key usage is a CSV export behind a login.
    balance: { path: "/user/balance", field: "deepseek", root: "host" },
    // Peak-hour list prices; see deepseekOffPeak for the half-price hours.
      // CONTEXT LENGTH on that same page is a single 1M for both models, which
      // is why every id here carries it -- including the retired names, whose
      // requests are served by V4.1 Flash.
    // DeepSeek's /models names its models but does not price them, so a
    // model missing here shows as unpriced on the billing page.
    models: [
      // Cache-hit input read from api-docs.deepseek.com/quick_start/pricing
      // in September 2026: about a fiftieth of the uncached price, which is
      // why the agent loop keeps the opening of its prompt unchanged.
      // deepseek-flash IS V4.1 Flash: DeepSeek renamed nothing, it retired
      // V4 Flash and V4 Flash Vision and serves both old ids from the new
      // model (api-docs.deepseek.com/news/news260910, 10 September 2026).
      { window: 1_000_000, id: "deepseek-flash", label: "DeepSeek V4.1 Flash", input: 0.3, output: 1.2, cachedInput: 0.006, note: "Fast and very cheap; 1M context, reads images" },
      { window: 1_000_000, id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", input: 1.32, output: 3.96, cachedInput: 0.044, note: "Most capable" },
      // Retired names DeepSeek still accepts, served by V4.1 Flash and billed
      // at its price, so they are here as aliases and priced the same.
      { window: 1_000_000, id: "deepseek-v4-flash", label: "DeepSeek V4 Flash (retired name)", input: 0.3, output: 1.2, cachedInput: 0.006 },
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai",
    note: "One key, hundreds of models from every vendor. Prices come from OpenRouter itself.",
    envKeys: ["OPENROUTER_API_KEY"],
    keyHint: "sk-or-v1-...",
    keysUrl: "https://openrouter.ai/keys",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
    listable: true,
    pinnable: true,
    balance: { path: "/credits", field: "openrouter" },
    models: [
      { id: "openai/gpt-4o-mini", label: "OpenAI GPT-4o mini", input: 0.15, output: 0.6 },
      { id: "openai/gpt-4.1-mini", label: "OpenAI GPT-4.1 mini", input: 0.4, output: 1.6 },
      { id: "anthropic/claude-sonnet-4.5", label: "Anthropic Claude Sonnet 4.5", input: 3, output: 15 },
      { id: "google/gemini-2.5-flash", label: "Google Gemini 2.5 Flash", input: 0.3, output: 2.5 },
      { id: "deepseek/deepseek-chat", label: "DeepSeek Chat", input: 0.27, output: 1.1 },
      { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B Instruct", input: 0.12, output: 0.3 },
      { id: "x-ai/grok-4", label: "xAI Grok 4", input: 3, output: 15 },
    ],
  },
  {
    id: "orcarouter",
    label: "Orca Router",
    kind: "openai",
    note: "Adaptive LLM routing across 200+ models with auto-failover, zero token markup, and intelligent complexity matching.",
    envKeys: ["ORCA_ROUTER_API_KEY", "ORCA_API_KEY"],
    keyHint: "orca-... or sk-...",
    keysUrl: "https://orcarouter.ai",
    baseUrl: "https://api.orcarouter.ai/v1",
    defaultModel: "orca-auto",
    listable: true,
    openEnded: true,
    // GET /v1/balance answers {"object":"balance","unit":"USD",
    // "paid_balance":19.99,"promo_credits":[...]}. Promo credits are scoped
    // to one model and expire, so they are not money you paid in.
    balance: { path: "/balance", field: "orcarouter" },
    models: [
      { id: "orca-auto", label: "Orca Auto Router", input: 0.15, output: 0.6, note: "Dynamically routes to the best model for cost and performance" },
      { id: "anthropic/claude-sonnet-4.5", label: "Anthropic Claude Sonnet 4.5", input: 3, output: 15 },
      { id: "anthropic/claude-haiku-4.5", label: "Anthropic Claude Haiku 4.5", input: 1, output: 5 },
      { id: "openai/gpt-5-mini", label: "OpenAI GPT-5 mini", input: 0.25, output: 2 },
      { id: "openai/gpt-4o", label: "OpenAI GPT-4o", input: 2.5, output: 10 },
      { id: "deepseek/deepseek-chat", label: "DeepSeek Chat", input: 0.27, output: 1.1 },
      { id: "google/gemini-2.5-flash", label: "Google Gemini 2.5 Flash", input: 0.3, output: 2.5 },
      { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B Instruct", input: 0.12, output: 0.3 },
    ],
  },
  {
    id: "lebrel",
    label: "Lebrel",
    kind: "openai",
    note: "Attested routing to open-weight models: every request ends inside Intel TDX hardware and every answer carries a signed receipt registered on Solana. One key serves every model, Lebrel's own uncensored edition included.",
    envKeys: ["LEBREL_API_KEY"],
    keyHint: "leb_live_...",
    keysUrl: "https://lebrel.ai/dashboard#keys",
    baseUrl: "https://attested.lebrel.ai/v1",
    defaultModel: "lebrel/deepseek-v4.1-flash-uncensored",
    listable: true,
    openEnded: true,
    // Lebrel publishes no balance endpoint, so none is claimed for it.
    models: [
      /* Lebrel's own edition is unpriced on purpose: it publishes no
         per-token rate for it (a free window each day, and a drop price it
         publishes separately outside that), so it is counted and marked
         unpriced rather than billed at a figure nobody quoted. Its window
         is the one its docs give. Routed models below publish no window at
         all, so theirs is left unset rather than borrowed. */
      { window: 1_048_544, id: "lebrel/deepseek-v4.1-flash-uncensored", label: "DeepSeek V4.1 Flash - Lebrel Uncensored", input: 0, output: 0, priced: false, note: "Lebrel's own uncensored edition on its own attested GPUs; unpriced, not free" },
      // Prices read off GET /v1/models (lebrel.pricing, microUSD per million
      // tokens) on 2026-11-18; a fifth of each is Lebrel's route fee, already
      // in the figure. v4-pro is listed at its off-peak rate: it carries a
      // peak schedule, which `peak` below applies.
      { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro", input: 0.792, output: 2.376, cachedInput: 0.0264, peak: 2, note: "Doubles in Lebrel's peak hours (weekdays 01-04 and 06-10 UTC)" },
      { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", input: 0.15, output: 0.6, cachedInput: 0.006 },
      { id: "moonshotai/kimi-k3", label: "Kimi K3", input: 3.3, output: 16.5, cachedInput: 0.33 },
      { id: "moonshotai/kimi-k3.1-pro", label: "Kimi K3.1 Pro", input: 1.95, output: 9.75, cachedInput: 0.195 },
      { id: "qwen/qwen3.8-flash", label: "Qwen 3.8 Flash", input: 0.15, output: 0.49, cachedInput: 0.016 },
      { id: "qwen/qwen3.8-max", label: "Qwen 3.8 Max", input: 2, output: 6, cachedInput: 0.25 },
      { id: "qwen/qwen4-max", label: "Qwen 4 Max", input: 1.4, output: 4.2, cachedInput: 0.07 },
      { id: "z-ai/glm-5.3", label: "GLM-5.3", input: 1.26, output: 3.96, cachedInput: 0.234 },
      { id: "z-ai/glm-5.3-flash", label: "GLM-5.3 Flash", input: 0.17, output: 0.56, cachedInput: 0.034 },
    ],
  },
  {
    id: "local",
    label: "Local server",
    kind: "openai",
    note: "Anything speaking the OpenAI API on your own machine — vLLM, Ollama, llama.cpp. No key, no bill.",
    envKeys: ["LOCAL_API_KEY", "OPENAI_COMPATIBLE_API_KEY"],
    keyHint: "usually not needed",
    keysUrl: "",
    baseUrl: "http://localhost:8000/v1",
    defaultModel: "",
    listable: true,
    openEnded: true,
    models: [],
  },
];

/** The routers: vendors that pick the model themselves. "Automatic" never
    chooses one -- a router is already a choice of model made by someone else,
    so Automatic picking one too would be routing on top of routing, a choice
    the person never saw and cannot see. It is still a fine provider to name
    yourself in Settings. */
export const AUTO_ROUTERS = ["orcarouter", "openrouter"];

/** What a call on this provider costs at list price, in $/Mtok added
    input+output, for the model Automatic would call on it (the one picked for
    that vendor, else its default, else the first listed). Null when the provider has no priced model -- which is
    how a local server says "I cost nothing you can predict", and how an
    unpriced default (Lebrel's own edition) says "nobody has quoted this",
    since a zero here would win the price race and then bill nothing. */
export function autoPriceOf(providerId: string, chosen?: string): number | null {
  const spec = providerSpec(providerId);
  if (!spec) return null;
  /* The model the person picked for this vendor is what a call would use, so it is what is priced; the vendor's
     default only when none is picked (or the picked one is not in the list). */
  const m = (chosen ? spec.models.find((x) => x.id === chosen) : undefined) ??
    spec.models.find((x) => x.id === spec.defaultModel) ?? spec.models[0];
  if (!m || m.priced === false || typeof m.input !== "number" || typeof m.output !== "number") return null;
  return m.input + m.output;
}

export function providerSpec(id: string): ProviderSpec | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * Prices found live, keyed `provider:model`.
 *
 * OpenRouter's catalogue is thousands of models deep and changes weekly, so
 * shipping it in the table above is hopeless. What we fetch lands here and
 * takes precedence, which also means a model the table has never heard of is
 * still billed correctly.
 */
const discovered = new Map<string, ModelSpec>();

export function rememberModels(providerId: string, models: ModelSpec[]) {
  const shipped = providerSpec(providerId)?.models ?? [];
  for (const model of models) {
    // A live listing that carries no price must not shadow a price we ship:
    // OpenAI's /models says which models exist, not what they cost.
    if (model.priced === false && shipped.some((m) => m.id === model.id)) continue;
    discovered.set(`${providerId}:${model.id}`, model);
  }
}

function discoveredModels(providerId: string): ModelSpec[] {
  const prefix = `${providerId}:`;
  return [...discovered.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, model]) => model);
}

/** Everything offerable for a provider: the shipped table, plus whatever a
    live refresh has since turned up, newest first and deduplicated. */
export function modelsFor(providerId: string): ModelSpec[] {
  const spec = providerSpec(providerId);
  const base = spec ? spec.models : [];
  const extra = discoveredModels(providerId).filter(
    (m) => !base.some((b) => b.id === m.id),
  );
  return [...base, ...extra];
}

/**
 * Windows for models this app does not list itself, keyed by how their id
 * begins. OpenAI's /models says which models exist and nothing about how much
 * they hold, so without this every OpenAI model would be measured against the
 * assumed default -- which is smaller than every one of these, and would fold
 * a conversation away while there was room to spare.
 *
 * Read off the vendors' own model pages, September 2026. A window quoted by a
 * live listing always wins over this (see listModels), and the most specific
 * prefix wins here, so an entry may sit above a broader one.
 */
const WINDOWS: Array<[string, number]> = [
  ["gpt-4.1", 1_047_576],
  ["gpt-4o", 128_000],
  ["gpt-5", 400_000],
  ["claude-", 200_000],
  ["gemini-", 1_048_576],
  ["deepseek-", 1_000_000],
];

/** Where a window came from: the model's own entry, or the vendor's figure for
    everything it serves. */
type WindowSource = "model" | "vendor";

/**
 * How much room a model actually has, or null when nobody has said.
 *
 * Asked in order of how much the answer is worth: the model's own entry, then
 * the longest id we have a window for that this model is a version of (a dated
 * snapshot such as gpt-4o-2024-08-06 belongs to the gpt-4o family), then the
 * family table, then the vendor's single figure. Null is a real answer and
 * means "assume": the caller then uses the shipped default and says so, which
 * is better than a number nobody checked presented as the truth.
 */
export function contextWindow(
  providerId: string,
  modelId: string,
): { tokens: number; source: WindowSource } | null {
  if (!modelId) return null;
  const own = modelSpec(providerId, modelId)?.window;
  if (own) return { tokens: own, source: "model" };

  const family = modelsFor(providerId)
    .filter((m) => m.window && (modelId.startsWith(m.id) || m.id.startsWith(modelId)))
    .sort((a, b) => b.id.length - a.id.length)[0];
  if (family?.window) return { tokens: family.window, source: "model" };

  const known = WINDOWS.find(([prefix]) => modelId.startsWith(prefix));
  if (known) return { tokens: known[1], source: "model" };

  const vendor = providerSpec(providerId)?.window;
  return vendor ? { tokens: vendor, source: "vendor" } : null;
}

function modelSpec(providerId: string, modelId: string): ModelSpec | undefined {
  return (
    discovered.get(`${providerId}:${modelId}`) ??
    providerSpec(providerId)?.models.find((m) => m.id === modelId)
  );
}

/**
 * DeepSeek charges half its list price outside peak hours: 01:00-04:00 and
 * 06:00-10:00 UTC, Monday to Friday. (Chinese public holidays are off-peak
 * too; we don't track those, so a holiday turn is overstated, never under.)
 */
function deepseekOffPeak(at: Date): boolean {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return true;
  const hour = at.getUTCHours();
  return !((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
}

/**
 * Lebrel's peak hours: weekdays 01:00-04:00 and 06:00-10:00 UTC, when the
 * models carrying a peak schedule bill at their multiple (2x for DeepSeek V4
 * Pro). Taken from the schedule the model listing itself publishes
 * (lebrel.pricing.peak: multiplier 200%, weekdays 1-5, those two windows),
 * read 2026-11-18. Chinese public holidays are off-peak and not tracked, so a
 * holiday turn inside these hours is overstated, never under.
 */
function lebrelPeak(at: Date): boolean {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/**
 * What a turn cost, in dollars.
 *
 * An unknown model prices at zero rather than at a guess. A made-up number
 * would flow into the billing total and be indistinguishable there from a real
 * one; a zero, paired with the "unpriced" count the billing page shows, says
 * plainly that this model is not in the table.
 */
export function costOf(
  providerId: string,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  at: Date = new Date(),
  /** Of `inputTokens`, how many were read from the prompt cache, and (for
      Anthropic) how many were written to it. */
  cache: { read?: number; write?: number } = {},
): number {
  const parts = costParts(providerId, modelId, inputTokens, outputTokens, at, cache);
  return parts.fresh + parts.cached + parts.output;
}

/** The same cost, split into new input, cached input and output. */
export function costParts(
  providerId: string,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  at: Date = new Date(),
  cache: { read?: number; write?: number } = {},
): { fresh: number; cached: number; output: number } {
  const spec = modelSpec(providerId, modelId);
  if (!spec || spec.priced === false) return { fresh: 0, cached: 0, output: 0 };
  const read = Math.min(cache.read ?? 0, inputTokens);
  const write = Math.min(cache.write ?? 0, inputTokens - read);
  // A long prompt on a model with dearer prices past a length is billed at those, all of it.
  const long = spec.over && inputTokens > spec.over.tokens ? spec.over : null;
  const input = long ? long.input : spec.input;
  // Anthropic publishes its cache prices as multiples of the input price: a tenth to read (less on some models,
  // which say so in cachedInput), a quarter more to write the five-minute cache and twice the price for the hour.
  const readPrice = spec.cachedInput !== undefined ? spec.cachedInput * (input / spec.input) : providerId === "anthropic" ? input * 0.1 : input;
  const writePrice = providerId === "anthropic" ? input * ((process.env.AUTORA_CACHE_TTL || "").trim() === "1h" ? 2 : 1.25) : input;
  // What the hour does to the list price: DeepSeek halves it off-peak,
  // Lebrel doubles it at peak. Both are multipliers on the same quoted rate.
  const hourRate = providerId === "deepseek" && deepseekOffPeak(at) ? 0.5 : 1;
  const peakRate = providerId === "lebrel" && spec.peak && lebrelPeak(at) ? spec.peak : 1;
  const scale = (hourRate * peakRate) / 1_000_000;
  return {
    fresh: (inputTokens - read - write) * input * scale,
    cached: (read * readPrice + write * writePrice) * scale,
    output: outputTokens * (long ? long.output : spec.output) * scale,
  };
}

/**
 * A cheaper model of the same provider for unwatched work (folding old turns, looking back after a turn) when the
 * person has named none: the provider's own default, when it is priced and costs at most half what the main model
 * does on a typical background call (mostly reading). Null when there is no such model -- the main model is then
 * used, as before -- and never a guess: an unpriced model is never picked, nor one this provider does not list.
 */
export function cheaperSibling(providerId: string, mainModel: string): string | null {
  const spec = providerSpec(providerId);
  /* A subscription has no prices to compare, but its quota and its wait both go further on its lightest model: the last in
     its list (Haiku, Flash low). Background work -- folding old turns, choosing memories -- does not need more. */
  if (spec?.cli) {
    const light = spec.models[spec.models.length - 1]?.id;
    return light && light !== mainModel ? light : null;
  }
  const pick = spec?.defaultModel;
  if (!pick || pick === mainModel) return null;
  if (!isPriced(providerId, pick) || !isPriced(providerId, mainModel)) return null;
  const typical = (model: string) => costOf(providerId, model, 8_000, 800);
  return typical(pick) * 2 <= typical(mainModel) ? pick : null;
}

export function isPriced(providerId: string, modelId: string): boolean {
  const spec = modelSpec(providerId, modelId);
  return Boolean(spec) && spec!.priced !== false;
}

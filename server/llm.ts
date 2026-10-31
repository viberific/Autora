/**
 * One way to ask a model something, whichever vendor is answering.
 *
 * Three wire protocols cover the field: Google's, Anthropic's, and OpenAI's --
 * which DeepSeek, OpenRouter, and every local server also speak. Each is
 * streamed, because a console that sits blank for eight seconds and then
 * prints a paragraph reads as broken, and each reports back how many tokens
 * the turn used, because that is what the billing page is counting.
 *
 * Token counts come from the vendor where the vendor sends them. Where one
 * does not, the turn is measured by the rough four-characters-per-token rule
 * and flagged `estimated`, so the billing page can mark that figure as an
 * approximation rather than quietly mixing it in with measured ones.
 */

import { GoogleGenAI } from "@google/genai";
import { type Effort, effectiveProfile, isOpenAiReasoningModel, learnRefusal, learnResponsesApi, usesResponsesApi } from "./modelprofile";
import { type ModelSpec, providerSpec } from "./providers";

/** A tool the model may call, in the one shape all three vendors accept once
    it has been wrapped in their own envelope. */
export interface ToolDef {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, any>; required?: string[] };
}

/** The model asking for a tool to be run. */
export interface ToolUse {
  /** The vendor's own id for this call, which its tool result must quote back.
      Gemini issues none, so one is made up and kept only on our side. */
  id: string;
  name: string;
  args: Record<string, any>;
  /** The arguments arrived but were not valid JSON -- almost always a call
      cut off by the output limit. Running it with `{}` would do the wrong
      thing quietly, so the caller answers it with an error instead. */
  incomplete?: boolean;
}

/** What came back, on its way to the model. */
export interface ToolReply {
  id: string;
  name: string;
  result: string;
  ok: boolean;
  /** Pictures the tool handed back -- a screenshot, mostly. Carried here
      rather than in `result`, which is text; what the model reads is put
      together per vendor, and OpenAI has nowhere else to put one. */
  images?: ChatImage[];
}

/**
 * One turn of the conversation.
 *
 * Three shapes in one interface rather than a union, because the great majority
 * of messages are still plain text and every existing caller builds them that
 * way. `calls` only ever appears on an assistant message; `replies` only on a
 * tool one.
 */
/** A picture handed to the model, base64 without the data-url prefix:
    every vendor's API takes the media type and the bytes separately. */
export interface ChatImage {
  mime: string;
  data: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  text?: string;
  /** Assistant only: tools this turn asked for. */
  calls?: ToolUse[];
  /** Tool only: what those calls returned. */
  replies?: ToolReply[];
  /** Assistant only: the model's thinking before it answered, where the
      vendor sends it (DeepSeek's `reasoning_content`). DeepSeek refuses a
      history with tools in it unless each assistant message carries this
      back. */
  reasoning?: string;
  /** Assistant only: what the vendor asked to be sent back unchanged with this message, and for which model -- OpenAI's
      Responses API returns its reasoning as encrypted items that carry the model's thinking from one tool call to the
      next. Sent back only to the model that made them. */
  carry?: { model: string; items: unknown[] };
  /** User only: pictures that came with the message. Sent with the turn they
      belong to and no later one -- see server/attach.ts. */
  images?: ChatImage[];
}

export interface ChatCall {
  provider: string;
  model: string;
  key: string;
  baseUrl: string;
  system: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Gemini only: tokens of thinking allowed before the first word. */
  thinkingBudget?: number;
  /**
   * OpenAI-shaped vendors only: DeepSeek thinks before it answers unless it is
   * told not to, and on a short reply the whole token budget goes on the
   * thinking, so the answer arrives empty. "off" is for calls that want the
   * answer and nothing else -- reading a picture, for one.
   */
  thinking?: "on" | "off";
  /**
   * How hard the model should think, for a model that takes it (./modelprofile): Claude's effort, OpenAI's reasoning
   * effort. Left out, the model's own default stands; a model with no such knob is sent nothing either way.
   */
  effort?: Effort;
  /** What the model may call this turn. Omitted or empty means text only, and
      the request then carries no tool field at all -- some local servers 400
      on an empty array. */
  tools?: ToolDef[];
  /**
   * One endpoint of the chosen model, for a vendor that routes between
   * several (OpenRouter). A slug, not an address: `deepinfra`, `chutes`.
   *
   * Empty or missing is the default and the old behaviour -- no routing block
   * in the body at all, so any endpoint serving the model may answer.
   */
  endpoint?: string;
  /** Stops the call mid-stream: the person pressed Stop, and every word
      after that would be spoken into a turn that is over. */
  signal?: AbortSignal;
}

export interface ChatUsage {
  /** Every input token, cached or not. */
  input: number;
  output: number;
  /** Of `input`, how many the provider served from its prompt cache. */
  cached?: number;
  /** Of `input`, how many were written to the cache (Anthropic bills these
      at a premium). */
  cacheWrite?: number;
  /** True when the counts are our arithmetic rather than the vendor's. */
  estimated: boolean;
}

/** What one call to a model produced: words, and whatever it wants run. */
export interface ChatTurn {
  usage: ChatUsage;
  text: string;
  calls: ToolUse[];
  /** The reply stopped because it hit the output limit, not because the model
      was finished. A turn that ends on one of these is a turn cut short. */
  cutOff?: boolean;
  /** The thinking that came before the reply, when the vendor streams it. */
  reasoning?: string;
  /** Items to send back with this turn's message (see ChatMessage.carry). */
  carry?: { model: string; items: unknown[] };
}

/** An error with the HTTP status kept, so the caller can tell a busy vendor
    (worth retrying) from a wrong key (never worth retrying). */
export class ProviderError extends Error {
  status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

const roughTokens = (text: string) => Math.max(1, Math.round(text.length / 4));

/** Everything in a message that costs tokens, text or not: a page of tool
    output is the bulk of an agentic turn and leaving it out of the estimate
    would under-report the expensive turns by an order of magnitude. */
function weigh(message: ChatMessage): string {
  return [
    message.text ?? "",
    message.reasoning ?? "",
    ...(message.calls ?? []).map((c) => c.name + JSON.stringify(c.args)),
    ...(message.replies ?? []).map((r) => r.result),
    /* A picture costs about a thousand tokens on every vendor, whatever its
       file size. Counting its base64 instead -- four characters per token by
       this rule -- would report a two-megabyte photograph as half a million
       tokens and have the context engine compacting a thread that is not
       actually long. */
    ...(message.images ?? []).map(() => "x".repeat(PICTURE_TOKENS * 4)),
  ].join("");
}

/** Charged per picture in the estimate above. */
const PICTURE_TOKENS = 1100;

/** What a prompt of this system text and history would cost, roughly. The
    context engine uses it to decide when to compact; the same rule as the
    billing estimate, so the two never disagree about what "large" means. */
export function estimateTokens(system: string, messages: readonly ChatMessage[]): number {
  return roughTokens(system + messages.map(weigh).join(""));
}

function estimate(call: ChatCall, reply: string): ChatUsage {
  const prompt = call.system + call.messages.map(weigh).join("");
  return { input: roughTokens(prompt), output: roughTokens(reply), estimated: true };
}

/**
 * The arguments a model streamed, as an object.
 *
 * Arguments arrive as a JSON string assembled from deltas, and a model that
 * stopped mid-object leaves that string unparseable. An empty object is the
 * right answer there: the tool then reports its own missing-argument error into
 * the thread, which the model can read and retry, where a thrown parse error
 * would end the turn with a stack trace.
 */
/** Whether a call's raw argument text is present but unreadable. */
function brokenArgs(raw: string): boolean {
  const text = raw.trim();
  if (!text) return false;
  try {
    JSON.parse(text);
    return false;
  } catch {
    return true;
  }
}

export function parseArgs(raw: string): Record<string, any> {
  let text = raw.trim();
  if (!text) return {};
  /* Some gateways wrap the JSON in a code fence, and some models (GLM among
     them) encode the object twice, so it parses to a string holding the real
     JSON. Peel both rather than call the arguments lost. */
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenced) text = fenced[1];
  try {
    let parsed: unknown = JSON.parse(text);
    for (let depth = 0; depth < 2 && typeof parsed === "string"; depth += 1) parsed = JSON.parse(parsed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, any>) : {};
  } catch {
    return {};
  }
}

/** A tool call being assembled from a stream's deltas. */
export interface BuildingCall {
  id: string;
  name: string;
  args: string;
}

/**
 * Fold one streamed tool-call delta into the calls being built.
 *
 * The OpenAI wire format sends the id and name once, then argument fragments,
 * all against an index. Vendors differ: some resend the whole name in every
 * chunk, some send the arguments so far rather than the next piece, and some
 * leave the index off or reuse it for a second parallel call, telling the calls
 * apart only by id. Taken literally these give "agentsagents", doubled JSON, or
 * two calls fused into one unparseable string whose arguments are then lost.
 */
export function addToolDelta(building: Map<number, BuildingCall>, part: any): void {
  let slot = Number(part.index ?? 0);
  const id = part.id ? String(part.id) : "";
  if (id) {
    // The same index under a new id is a new call, not more of the old one.
    for (const [at, held] of building) {
      if (held.id === id) slot = at;
    }
    const held = building.get(slot);
    if (held && held.id && held.id !== id) slot = Math.max(...building.keys()) + 1;
  }
  const found = building.get(slot) ?? { id: "", name: "", args: "" };
  if (id) found.id = id;
  const name = part.function?.name ? String(part.function.name) : "";
  if (name && name !== found.name) found.name = found.name && name.startsWith(found.name) ? name : found.name + name;
  const piece = part.function?.arguments;
  if (typeof piece === "string" && piece) found.args = found.args && piece.startsWith(found.args) ? piece : found.args + piece;
  else if (piece && typeof piece === "object") found.args = JSON.stringify(piece);
  building.set(slot, found);
}

/** The readable sentence inside a vendor's error body, which is variously a
    plain string, `{error: {message}}`, or `{message}`, sometimes nested. */
function readError(body: string, status: number): ProviderError {
  let text = body.trim();
  for (let depth = 0; depth < 3; depth += 1) {
    const start = text.indexOf("{");
    if (start < 0) break;
    try {
      const parsed = JSON.parse(text.slice(start));
      const inner = parsed?.error ?? parsed;
      const message = typeof inner === "string" ? inner : inner?.message;
      if (typeof message !== "string") break;
      text = message;
    } catch {
      break;
    }
  }
  const clean = text.replace(/\s+/g, " ").trim() || `HTTP ${status}`;
  return new ProviderError(clean, status);
}

async function failure(res: Response): Promise<ProviderError> {
  const body = await res.text().catch(() => "");
  return readError(body, res.status);
}

/**
 * fetch, with a network failure said in words.
 *
 * Node's fetch reports every DNS failure, refused connection, and TLS problem
 * as the two words "fetch failed", which in the thread reads as the app being
 * broken rather than as a server that is not there. The URL is what makes it
 * diagnosable -- nine times in ten the base URL has a typo in it.
 */
async function request(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err: any) {
    const cause = err?.cause?.code ?? err?.cause?.message ?? err?.message ?? "unknown error";
    throw new ProviderError(`could not reach ${url} (${cause})`, null);
  }
}

/** Server-sent events, one `data:` payload at a time. */
async function* sse(res: Response): AsyncGenerator<string> {
  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let done = false;
  while (!done) {
    const next = await reader.read();
    done = next.done;
    buffer += done ? decoder.decode() : decoder.decode(next.value, { stream: true });
    // A server may end on its last event with no newline after it (usage, often).
    if (done && buffer && !buffer.endsWith("\n")) buffer += "\n";

    let cut = buffer.indexOf("\n");
    while (cut >= 0) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      cut = buffer.indexOf("\n");
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload && payload !== "[DONE]") yield payload;
      }
    }
  }
}

const trimSlash = (url: string) => url.replace(/\/+$/, "");

// ------------------------------------------------------------- openai-ish --

function openAiHeaders(call: ChatCall): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (call.key) headers.Authorization = `Bearer ${call.key}`;
  if (call.provider === "openrouter") {
    // OpenRouter attributes traffic by these and shows the name on its own
    // activity page, which is where people go to check a bill against ours.
    headers["HTTP-Referer"] = "https://github.com/viberific/Autora";
    headers["X-Title"] = "Autora";
  }
  return headers;
}

/**
 * The history, in OpenAI's shape.
 *
 * A tool message per reply rather than per turn: the API pairs each result with
 * the `tool_call_id` it answers, and batching several into one message loses
 * that pairing -- which a model then notices as a call it never got an answer
 * for.
 *
 * Every call is answered straight after the message that made it, and nothing
 * else is: DeepSeek refuses the whole request, with "insufficient tool
 * messages following tool_calls message", over one call left unanswered, one
 * reply out of place, or two calls sharing an id. The history should never be
 * in that shape, but one bad request is a turn that cannot go on, so it is put
 * right here rather than trusted: a missing reply is filled in as not run, and
 * a stray one is dropped.
 */
export function openAiMessages(call: ChatCall): any[] {
  const out: any[] = [];
  if (call.system) out.push({ role: "system", content: call.system });
  // DeepSeek thinks by default, and with tools on it wants that thinking back
  // on every assistant message. Other vendors reject a field they do not know.
  const deepseek = call.provider === "deepseek" || /api\.deepseek\.com/.test(call.baseUrl);
  const openai = call.provider === "openai" || /(^|\/\/)api\.openai\.com/.test(call.baseUrl ?? "");
  const used = new Set<string>();

  for (let i = 0; i < call.messages.length; i += 1) {
    const message = call.messages[i];
    // A reply whose call is not the message just before it: see below.
    if (message.role === "tool") continue;

    if (message.role === "assistant") {
      const calls = (message.calls ?? []).map((c) => {
        const base = openai ? openAiCallId(c.id || "call") : c.id || "call";
        let id = base;
        while (used.has(id)) id = `${base}_${used.size}`.slice(-40);
        used.add(id);
        return { use: c, id };
      });
      out.push({
        role: "assistant",
        // Null rather than "" when a turn was nothing but tool calls: some
        // gateways reject an assistant message with both an empty string and
        // tool_calls set.
        content: message.text || (calls.length > 0 ? null : ""),
        ...(deepseek ? { reasoning_content: message.reasoning ?? "" } : {}),
        ...(calls.length > 0
          ? {
              tool_calls: calls.map(({ use, id }) => ({
                id,
                type: "function",
                function: { name: use.name, arguments: JSON.stringify(use.args) },
              })),
            }
          : {}),
      });
      if (calls.length === 0) continue;

      const next = call.messages[i + 1];
      const replies = next?.role === "tool" ? next.replies ?? [] : [];
      const taken = new Set<ToolReply>();
      for (const { use, id } of calls) {
        const reply = replies.find((r) => !taken.has(r) && r.id === use.id);
        if (reply) taken.add(reply);
        out.push({
          role: "tool",
          tool_call_id: id,
          content: reply?.result || (reply ? "(no output)" : "Not run: no result was recorded for this call."),
        });
      }
      /* A picture a call handed back. There is no room for one inside a tool
         result here, so it follows as the next user message -- which is where
         a person would put it too. */
      const shown = replies.filter((r) => r.images?.length);
      if (shown.length > 0) {
        out.push({
          role: "user",
          content: [
            { type: "text", text: "The picture from the call above, as it came back." },
            ...shown.flatMap((r) => (r.images ?? []).map((img) => ({
              type: "image_url",
              image_url: { url: `data:${img.mime};base64,${img.data}` },
            }))),
          ],
        });
      }
      continue;
    }
    if (message.images?.length) {
      out.push({
        role: "user",
        content: [
          { type: "text", text: message.text ?? "" },
          ...message.images.map((img) => ({
            type: "image_url",
            image_url: { url: `data:${img.mime};base64,${img.data}` },
          })),
        ],
      });
      continue;
    }
    out.push({ role: "user", content: message.text ?? "" });
  }

  return out;
}

/** Models (by vendor and name) that answered "reasoning is mandatory": asked to think off, they are sent no switch. */
const thinkingForced = new Set<string>();
const refusesThinkingOff = (message: string) => /reasoning is mandatory|cannot be disabled|can'?t be disabled|must be enabled/i.test(message);
/* OpenAI renamed the reply cap for its newer models: GPT-5 and later, and the
   o-series, 400 on `max_tokens` and ask for `max_completion_tokens`. They also
   refuse a temperature the caller picked, so it is left out and the model's own
   default stands. Older OpenAI models keep the old names, and every other
   OpenAI-shaped vendor (DeepSeek, OpenRouter, Orca, a local server) takes them,
   so those requests are untouched. */
function modernOpenAi(call: ChatCall): boolean {
  const openai = call.provider === "openai" || /(^|\/\/)api\.openai\.com/.test(call.baseUrl ?? "");
  return openai && isOpenAiReasoningModel(call.model ?? "");
}

/** OpenAI refuses a request with more than 128 tools ("array too long"). What stays, in order: tools this chat has already
    called (the history names them), the built-in tools, tools the agent wrote, and last the connected-server tools, which
    are the many and the least often needed. Within a tier the order it was built in is kept. */
export const OPENAI_MAX_TOOLS = 128;
export function capTools<T extends { name: string }>(tools: readonly T[], openai: boolean, called: ReadonlySet<string> = new Set()): T[] {
  if (!openai || tools.length <= OPENAI_MAX_TOOLS) return [...tools];
  const tier = (t: T) => (called.has(t.name) ? 0 : t.name.startsWith("mcp__") ? 3 : t.name.startsWith("my_") ? 2 : 1);
  const keep = new Set(
    tools.map((t, i) => ({ t, i, k: tier(t) })).sort((x, y) => x.k - y.k || x.i - y.i).slice(0, OPENAI_MAX_TOOLS).map((x) => x.t),
  );
  return tools.filter((t) => keep.has(t));
}

/** The line that tells the model which tools this request had no room for. They still run when called by name (the server
    runs any tool it knows), so the model is given the names rather than left to think they do not exist. */
export function omittedNote(left: readonly string[]): string {
  if (left.length === 0) return "";
  const shown = left.slice(0, 60).join(", ");
  return `\n\nThis model takes at most ${OPENAI_MAX_TOOLS} tools in a request, so ${left.length} are not in your list. ` +
    `They still work: call one by its exact name, with arguments as its name suggests. Not in your list: ${shown}` +
    `${left.length > 60 ? `, and ${left.length - 60} more` : ""}.`;
}

/** A tool schema OpenAI will accept. It 400s on an array with no `items`, and on a root that is not an object with
    `properties`; MCP servers send both. Only the wrong parts are put right, and the input is not changed. */
export function openAiSchema(schema: any): any {
  const fix = (s: any): any => {
    if (Array.isArray(s)) return s.map(fix);
    if (!s || typeof s !== "object") return s;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(s)) out[k] = k === "enum" || k === "required" || k === "default" || k === "const" || k === "examples" ? v : fix(v);
    const t = out.type;
    if ((t === "array" || (Array.isArray(t) && t.includes("array"))) && !out.items) out.items = {};
    return out;
  };
  const root = fix(schema ?? {});
  return root.type === "object" && root.properties ? root : { ...root, type: "object", properties: root.properties ?? {} };
}

/** OpenAI rejects a repeated tool name, and a tool-call id over 40 characters (ids minted by other vendors can be longer). */
export function openAiTools(tools: readonly ToolDef[]): ToolDef[] {
  const seen = new Set<string>();
  return tools.filter((t) => !seen.has(t.name) && Boolean(seen.add(t.name)));
}
export const openAiCallId = (id: string): string => (id.length <= 40 ? id : id.slice(0, 31) + "_" + (hash(id) % 1e7).toString(36));
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  return h;
}

async function streamOpenAi(call: ChatCall, onDelta: (text: string) => void): Promise<ChatTurn> {
  if (usesResponsesApi(call.provider ?? "", call.model, call.baseUrl ?? "")) return streamResponses(call, onDelta);
  const isOpenAi = call.provider === "openai" || /(^|\/\/)api\.openai\.com/.test(call.baseUrl ?? "");
  const called = new Set(call.messages.flatMap((m) => (m.calls ?? []).map((c) => c.name)));
  const tools = capTools(isOpenAi ? openAiTools(call.tools ?? []) : call.tools ?? [], isOpenAi, called);
  if (tools.length < (call.tools?.length ?? 0)) {
    console.warn(`[llm] ${call.model}: sent ${tools.length} of ${call.tools!.length} tools (OpenAI allows ${OPENAI_MAX_TOOLS})`);
  }
  const sent = new Set(tools.map((t) => t.name));
  const system = (call.system ?? "") + omittedNote([...new Set((call.tools ?? []).map((t) => t.name))].filter((n) => !sent.has(n)));
  const deepseek = (call.provider ?? "") === "deepseek" || /api\.deepseek\.com/.test(call.baseUrl ?? "");
  /* OpenRouter is a router: one model is served from several endpoints, and
     without being told which, it may answer a turn from a different one --
     another machine, at another price -- from call to call. A pin names one
     and refuses the rest: `allow_fallbacks: false` makes it an answer rather
     than a preference, so if that endpoint is down or does not carry the
     model the call fails and says so instead of being served from somewhere
     nobody chose. Sent to a vendor that routes and no other -- providers.ts
     marks it, and OpenAI and most gateways refuse a field they do not know --
     and only when a pin is set, so an install that never chose one sends the
     body it always did. */
  const pin = (call.endpoint ?? "").trim();
  const openrouter = Boolean(providerSpec(call.provider)?.pinnable) || /(^|\.)openrouter\.ai/.test(call.baseUrl ?? "");
  const forcedKey = `${call.provider ?? ""}|${call.baseUrl ?? ""}|${call.model}`;
  /* What this model takes beyond the common fields, read per request so a refusal learned below holds from the next. */
  const profileNow = () => effectiveProfile(call.provider ?? "", call.model, call.baseUrl ?? "");
  let profile = profileNow();
  const send = (off: boolean) => request(`${trimSlash(call.baseUrl)}/chat/completions`, {
    method: "POST",
    signal: call.signal,
    headers: openAiHeaders(call),
    body: JSON.stringify({
      model: call.model,
      ...(openrouter && pin ? { provider: { only: [pin], allow_fallbacks: false } } : {}),
      stream: true,
      stream_options: { include_usage: true },
      ...(modernOpenAi(call)
        ? { max_completion_tokens: call.maxTokens ?? 2048 }
        : { ...(profile.temperature ? { temperature: call.temperature ?? 0.7 } : {}), max_tokens: call.maxTokens ?? 2048 }),
      ...(call.effort && profile.effort === "openai" ? { reasoning_effort: call.effort } : {}),
      // Only DeepSeek takes this, and only when the caller asked either way:
      // left alone, its own default stands.
      ...(deepseek && call.thinking ? { thinking: { type: call.thinking === "off" ? "disabled" : "enabled" } } : {}),
      /* GLM thinks first too, and Z.ai (and gateways that pass the field on)
         switch it off with the same `thinking` block. OpenRouter has its own
         `reasoning` switch, honoured per model and ignored where a model cannot
         turn thinking off. Only when the caller said "off": a chat turn keeps
         whatever the model does by default. */
      ...(!deepseek && call.thinking === "off" && /glm/i.test(call.model) && off ? { thinking: { type: "disabled" } } : {}),
      ...(call.thinking === "off" && openrouter && off ? { reasoning: { enabled: false } } : {}),
      messages: openAiMessages({ ...call, system }),
      ...(tools.length
        ? {
            tools: tools.map((t) => ({
              type: "function",
              function: {
                name: t.name,
                description: t.description,
                parameters: isOpenAi ? openAiSchema(t.parameters) : t.parameters,
              },
            })),
            tool_choice: "auto",
          }
        : {}),
    }),
  });

  /* A model whose reasoning is mandatory refuses the off switch outright. Asked once, it is told so and the call is
     made again without the switch; the next call to that model does not ask. Thinking off is a wish, not a need. */
  let res = await send(!thinkingForced.has(forcedKey));
  let refused = res.ok ? null : await failure(res);
  /* An OpenAI model that takes tools only through the Responses API says so: it is asked there now, and from now on. */
  if (refused && learnResponsesApi(call.provider ?? "", call.model, call.baseUrl ?? "", refused.status, refused.message)) {
    return streamResponses(call, onDelta);
  }
  /* A field this model's profile added, refused by name: once more without it, and not sent to it again (./modelprofile). */
  const extras = { effort: Boolean(call.effort) && profile.effort === "openai", temperature: !modernOpenAi(call) && profile.temperature };
  if (refused && learnRefusal(call.provider ?? "", call.model, call.baseUrl ?? "", refused.status, refused.message, extras)) {
    profile = profileNow();
    res = await send(!thinkingForced.has(forcedKey));
    refused = res.ok ? null : await failure(res);
  }
  if (refused) {
    if (call.thinking === "off" && !thinkingForced.has(forcedKey) && refusesThinkingOff(refused.message)) {
      thinkingForced.add(forcedKey);
      res = await send(false);
      if (!res.ok) throw await failure(res);
    } else {
      throw refused;
    }
  }

  let reply = "";
  let reasoning = "";
  let usage: ChatUsage | null = null;
  /* Tool calls arrive as deltas keyed by position, not by id: the first chunk
     for a slot carries the id and name, and every chunk after it carries more
     of the argument JSON. So they are assembled by index and only parsed once
     the stream is done. */
  const building = new Map<number, BuildingCall>();
  let cutOff = false;

  for await (const payload of sse(res)) {
    let chunk: any;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    // Some gateways deliver an error mid-stream with a 200 on the envelope.
    if (chunk.error) throw new ProviderError(chunk.error.message ?? "stream failed", null);

    if (chunk.choices?.[0]?.finish_reason === "length") cutOff = true;
    const delta = chunk.choices?.[0]?.delta;
    const piece = delta?.content;
    if (typeof piece === "string" && piece) {
      reply += piece;
      onDelta(piece);
    }
    // Kept, not shown: DeepSeek needs it sent back with the rest of the turn.
    if (typeof delta?.reasoning_content === "string") reasoning += delta.reasoning_content;
    // OpenRouter and some gateways name it `reasoning`.
    else if (typeof delta?.reasoning === "string") reasoning += delta.reasoning;

    for (const part of delta?.tool_calls ?? []) addToolDelta(building, part);

    if (chunk.usage) {
      usage = {
        input: chunk.usage.prompt_tokens ?? 0,
        output: chunk.usage.completion_tokens ?? 0,
        // DeepSeek reports its own field; OpenAI and most gateways the other.
        cached: chunk.usage.prompt_cache_hit_tokens ??
          chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
        estimated: false,
      };
    }
  }

  const calls: ToolUse[] = [...building.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, found]) => found.name)
    .map(([slot, found]) => ({
      // A local server that omits ids still needs something stable to pair the
      // result against.
      id: found.id || `call_${slot}`,
      name: found.name,
      args: parseArgs(found.args),
      ...(brokenArgs(found.args) ? { incomplete: true } : {}),
    }));

  return {
    usage: usage ?? estimate(call, reply),
    text: reply,
    calls,
    cutOff,
    ...(reasoning ? { reasoning } : {}),
  };
}

// ------------------------------------------------------- openai responses --

/**
 * The history as OpenAI's Responses API takes it, built from the chat-completions shape so the pairing of calls and
 * results (and the id repairs) are made in one place: system becomes `instructions`, each assistant tool call a
 * `function_call` item, each result a `function_call_output`, pictures `input_image` parts. The reasoning items a
 * model returned go back in front of the calls they led to, to that model only.
 */
export function responsesInput(call: ChatCall): { instructions: string; input: any[] } {
  const chat = openAiMessages(call);
  const assistants = call.messages.filter((m) => m.role === "assistant");
  let nth = 0;
  let instructions = "";
  const input: any[] = [];
  const parts = (content: any): any => (typeof content === "string" ? content : (content as any[]).map((p) =>
    p.type === "image_url" ? { type: "input_image", image_url: p.image_url.url } : { type: "input_text", text: p.text ?? "" }));
  for (const m of chat) {
    if (m.role === "system") { instructions = m.content; continue; }
    if (m.role === "user") { input.push({ role: "user", content: parts(m.content) }); continue; }
    if (m.role === "tool") { input.push({ type: "function_call_output", call_id: m.tool_call_id, output: m.content }); continue; }
    // assistant
    const source = assistants[nth++];
    if (source?.carry && source.carry.model === call.model) input.push(...source.carry.items);
    if (m.content) input.push({ role: "assistant", content: m.content });
    for (const tc of m.tool_calls ?? []) {
      input.push({ type: "function_call", call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
    }
  }
  return { instructions, input };
}

/**
 * One call through OpenAI's Responses API, for the models that take tools with reasoning on only there (see
 * usesResponsesApi). Nothing is stored on OpenAI's side (`store: false`); the reasoning comes back encrypted and is
 * returned with the next request instead, so the model keeps its thread of thought between tool calls.
 */
async function streamResponses(call: ChatCall, onDelta: (text: string) => void): Promise<ChatTurn> {
  const called = new Set(call.messages.flatMap((m) => (m.calls ?? []).map((c) => c.name)));
  const tools = capTools(openAiTools(call.tools ?? []), true, called);
  const sent = new Set(tools.map((t) => t.name));
  const system = (call.system ?? "") + omittedNote([...new Set((call.tools ?? []).map((t) => t.name))].filter((n) => !sent.has(n)));
  const { instructions, input } = responsesInput({ ...call, system });
  const profile = effectiveProfile(call.provider ?? "openai", call.model, call.baseUrl ?? "");
  const res = await request(`${trimSlash(call.baseUrl)}/responses`, {
    method: "POST",
    signal: call.signal,
    headers: openAiHeaders(call),
    body: JSON.stringify({
      model: call.model,
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      ...(instructions ? { instructions } : {}),
      input,
      max_output_tokens: call.maxTokens ?? 2048,
      ...(call.effort && profile.effort === "openai" ? { reasoning: { effort: call.effort } } : {}),
      ...(tools.length
        ? {
            /* Strict is the Responses API's default, and it takes only schemas that list every property as required
               and forbid others; ours (and connected servers') are ordinary JSON Schema. */
            tools: tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: openAiSchema(t.parameters), strict: false })),
            tool_choice: "auto",
          }
        : {}),
    }),
  });
  if (!res.ok) throw await failure(res);

  let reply = "";
  let usage: ChatUsage | null = null;
  let cutOff = false;
  const carried: unknown[] = [];
  /* Calls by output position: the item opens with its id and name, its arguments stream in, and the finished item
     carries them whole. */
  const building = new Map<number, { id: string; name: string; args: string }>();
  for await (const payload of sse(res)) {
    let ev: any;
    try { ev = JSON.parse(payload); } catch { continue; }
    switch (ev.type) {
      case "response.output_text.delta":
        if (typeof ev.delta === "string" && ev.delta) { reply += ev.delta; onDelta(ev.delta); }
        break;
      case "response.output_item.added":
        if (ev.item?.type === "function_call") {
          building.set(ev.output_index ?? building.size, { id: ev.item.call_id ?? ev.item.id ?? "", name: ev.item.name ?? "", args: ev.item.arguments ?? "" });
        }
        break;
      case "response.function_call_arguments.delta": {
        const b = building.get(ev.output_index);
        if (b && typeof ev.delta === "string") b.args += ev.delta;
        break;
      }
      case "response.output_item.done":
        if (ev.item?.type === "function_call") {
          building.set(ev.output_index ?? building.size, { id: ev.item.call_id ?? ev.item.id ?? "", name: ev.item.name ?? "", args: ev.item.arguments ?? "" });
        } else if (ev.item?.type === "reasoning" && ev.item.encrypted_content) {
          carried.push({ type: "reasoning", id: ev.item.id, encrypted_content: ev.item.encrypted_content, summary: ev.item.summary ?? [] });
        }
        break;
      case "response.completed":
      case "response.incomplete": {
        const r = ev.response ?? {};
        if (ev.type === "response.incomplete" || r.incomplete_details?.reason === "max_output_tokens") cutOff = true;
        if (r.usage) {
          usage = {
            input: r.usage.input_tokens ?? 0,
            output: r.usage.output_tokens ?? 0,
            cached: r.usage.input_tokens_details?.cached_tokens ?? 0,
            estimated: false,
          };
        }
        break;
      }
      case "response.failed":
        throw new ProviderError(ev.response?.error?.message ?? "the response failed", null);
      case "error":
        throw new ProviderError(ev.message ?? ev.error?.message ?? "stream failed", null);
    }
  }

  const calls: ToolUse[] = [...building.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, found]) => found.name)
    .map(([slot, found]) => ({
      id: found.id || `call_${slot}`,
      name: found.name,
      args: parseArgs(found.args),
      ...(brokenArgs(found.args) ? { incomplete: true } : {}),
    }));
  return {
    usage: usage ?? estimate(call, reply),
    text: reply,
    calls,
    cutOff,
    ...(carried.length ? { carry: { model: call.model, items: carried } } : {}),
  };
}

// ------------------------------------------------------------- anthropic --

/**
 * The history, in Anthropic's shape.
 *
 * Tool results are a *user* message here, not a role of their own, and all of
 * one turn's results belong in a single message -- the API rejects an assistant
 * turn whose tool_use blocks are not all answered before the next assistant
 * turn. Empty text blocks are dropped rather than sent: a content block with an
 * empty string is a 400, and a turn that was nothing but tool calls has exactly
 * that.
 */
export function anthropicMessages(call: ChatCall): any[] {
  /* Anthropic takes a tool id only of [a-zA-Z0-9_-], and only once in a
     conversation. Ids come from whichever vendor made the call -- Gemini's are
     ours and repeat every round ("read_file-0"), and some gateways put a colon
     in theirs -- so with a planner or an agent on another vendor, the history
     Anthropic reads carries ids it would refuse. Each call gets a safe id of
     its own here, and its result the same one. */
  const used = new Set<string>();
  let open = new Map<string, string[]>();
  const fresh = (raw: string) => {
    const base = (raw || "call").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60) || "call";
    let id = base;
    for (let n = 1; used.has(id); n += 1) id = `${base}_${n}`;
    used.add(id);
    return id;
  };
  const resultId = (raw: string) => {
    const waiting = open.get(raw);
    return waiting?.length ? waiting.shift()! : fresh(raw);
  };
  const out = call.messages.map((message) => {
    if (message.role === "tool") {
      const blocks: any[] = (message.replies ?? []).map((reply) => ({
        type: "tool_result",
        tool_use_id: resultId(reply.id),
        content: reply.result,
        ...(reply.ok ? {} : { is_error: true }),
      }));
      /* A picture a call handed back goes in after the results: this message
         is one user turn, and Anthropic takes an image block in it. */
      for (const reply of message.replies ?? []) {
        for (const img of reply.images ?? []) {
          blocks.push({ type: "image", source: { type: "base64", media_type: img.mime, data: img.data } });
        }
      }
      return { role: "user", content: blocks };
    }

    const content: any[] = [];
    /* Picture first, then the words: that is the order Anthropic recommends,
       and it also leaves the last block of the turn a text one, which is
       where the cache breakpoint below has always gone. */
    for (const img of message.images ?? []) {
      content.push({ type: "image", source: { type: "base64", media_type: img.mime, data: img.data } });
    }
    if (message.text) content.push({ type: "text", text: message.text });
    if (message.role === "assistant") open = new Map();
    for (const use of message.calls ?? []) {
      const id = fresh(use.id);
      open.set(use.id, [...(open.get(use.id) ?? []), id]);
      content.push({ type: "tool_use", id, name: use.name, input: use.args });
    }
    return {
      role: message.role,
      // Never an empty array, which is also a 400.
      content: content.length > 0 ? content : [{ type: "text", text: "(no content)" }],
    };
  });
  /* Anthropic caches nothing unless asked. A breakpoint on the last block
     caches the whole prompt up to it, and the next round -- the same prompt
     with one exchange more -- reads all of that back at a tenth of the price.
     The system prompt carries a breakpoint of its own (see streamAnthropic),
     so a turn's first round still finds the instructions cached. */
  const last = out[out.length - 1];
  const block = last?.content?.[last.content.length - 1];
  if (block) block.cache_control = { ...CACHE_CONTROL };
  return out;
}

/* The provider keeps a cached prompt for five minutes after its last use. A
   long command, a build or a person thinking leaves a gap longer than that,
   and the next round then pays full price for the whole prompt. AUTORA_CACHE_TTL=1h
   asks for the hour instead (written at twice the price, so it is for chats
   where such gaps are common, and off by default). */
const CACHE_CONTROL: { type: "ephemeral"; ttl?: "1h" } =
  (process.env.AUTORA_CACHE_TTL || "").trim() === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };

async function streamAnthropic(call: ChatCall, onDelta: (text: string) => void): Promise<ChatTurn> {
  /* The newest Claude models refuse a temperature and take an effort; older ones the other way round (./modelprofile). */
  let profile = effectiveProfile(call.provider ?? "anthropic", call.model, call.baseUrl ?? "");
  const send = () => request(`${trimSlash(call.baseUrl)}/v1/messages`, {
    method: "POST",
    signal: call.signal,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": call.key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: call.model,
      stream: true,
      max_tokens: call.maxTokens ?? 2048,
      ...(profile.temperature ? { temperature: call.temperature ?? 0.7 } : {}),
      ...(call.effort && profile.effort === "anthropic" ? { output_config: { effort: call.effort } } : {}),
      system: call.system
        ? [{ type: "text", text: call.system, cache_control: { ...CACHE_CONTROL } }]
        : undefined,
      messages: anthropicMessages(call),
      ...(call.tools?.length
        ? {
            tools: call.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
          }
        : {}),
    }),
  });

  let res = await send();
  if (!res.ok) {
    const refused = await failure(res);
    const sent = { effort: Boolean(call.effort) && profile.effort === "anthropic", temperature: profile.temperature };
    if (!learnRefusal(call.provider ?? "anthropic", call.model, call.baseUrl ?? "", refused.status, refused.message, sent)) throw refused;
    profile = effectiveProfile(call.provider ?? "anthropic", call.model, call.baseUrl ?? "");
    res = await send();
    if (!res.ok) throw await failure(res);
  }

  let reply = "";
  const usage: ChatUsage = { input: 0, output: 0, estimated: false };
  let counted = false;
  let cutOff = false;
  /* Blocks are addressed by index across the whole message: a tool_use opens
     at some index, its arguments arrive as partial JSON against that index, and
     text blocks are interleaved at other indices. */
  const building = new Map<number, { id: string; name: string; args: string }>();

  for await (const payload of sse(res)) {
    let event: any;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    if (event.type === "error") {
      throw new ProviderError(event.error?.message ?? "stream failed", null);
    }
    if (event.type === "message_start") {
      // input_tokens here is only the part that was neither read from the
      // cache nor written to it; the other two are counted separately.
      const u = event.message?.usage ?? {};
      usage.cached = u.cache_read_input_tokens ?? 0;
      usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
      usage.input = (u.input_tokens ?? 0) + usage.cached + usage.cacheWrite;
      counted = true;
    } else if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
      building.set(Number(event.index ?? 0), {
        id: String(event.content_block.id ?? ""),
        name: String(event.content_block.name ?? ""),
        // A tool with no arguments sends no input_json_delta at all, so the
        // starting input is what it gets.
        args: JSON.stringify(event.content_block.input ?? {}),
      });
    } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
      const piece = String(event.delta.text ?? "");
      if (piece) {
        reply += piece;
        onDelta(piece);
      }
    } else if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
      const found = building.get(Number(event.index ?? 0));
      if (found) {
        // The first delta replaces the "{}" the block opened with; every one
        // after it appends.
        if (found.args === "{}") found.args = "";
        found.args += String(event.delta.partial_json ?? "");
      }
    } else if (event.type === "message_delta") {
      if (event.delta?.stop_reason === "max_tokens") cutOff = true;
      if (event.usage) {
        usage.output = event.usage.output_tokens ?? usage.output;
        counted = true;
      }
    }
  }

  const calls: ToolUse[] = [...building.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, found]) => found.name && found.id)
    .map(([, found]) => ({
      id: found.id,
      name: found.name,
      args: parseArgs(found.args),
      ...(brokenArgs(found.args) ? { incomplete: true } : {}),
    }));

  return { usage: counted ? usage : estimate(call, reply), text: reply, calls, cutOff };
}

// ---------------------------------------------------------------- gemini --

/** Lazy client per key and endpoint: rebuilding it on every turn throws away
    the SDK's connection reuse, and holding one past a change talks to the old
    key -- or, for anyone pointing this at a proxy, the old server. */
let geminiClient: GoogleGenAI | null = null;
let geminiClientFor = "";

function gemini(key: string, baseUrl: string): GoogleGenAI {
  const signature = `${key}@${baseUrl}`;
  if (!geminiClient || geminiClientFor !== signature) {
    geminiClient = new GoogleGenAI({
      apiKey: key,
      httpOptions: baseUrl ? { baseUrl } : undefined,
    });
    geminiClientFor = signature;
  }
  return geminiClient;
}

/**
 * A Gemini SDK error, made readable.
 *
 * The SDK hands back a message that is itself a JSON document with another
 * JSON document quoted inside it, so the useful sentence arrives buried two
 * levels deep behind escaped newlines. Shown raw it is a wall of braces, which
 * tells the reader nothing about whether their key is wrong or Google is busy.
 */
function fromSdk(err: any): ProviderError {
  const status = typeof err?.status === "number" ? err.status : null;
  const parsed = readError(String(err?.message ?? err), status ?? 0);
  return new ProviderError(parsed.message, status ?? parsed.status);
}

/**
 * The history, in Gemini's shape.
 *
 * Gemini names no ids: a functionResponse is matched to its functionCall by
 * name alone. So the ids the rest of this module relies on are ours, invented
 * at parse time, and dropped again here.
 */
export function geminiContents(call: ChatCall): any[] {
  return call.messages.map((message) => {
    if (message.role === "tool") {
      const parts: any[] = (message.replies ?? []).map((reply) => ({
        functionResponse: {
          name: reply.name,
          // The payload must be an object; the string goes inside it. A
          // failure travels as an `error` key so the model can tell a tool
          // that reported a problem from one that returned prose about one.
          response: reply.ok ? { result: reply.result } : { error: reply.result },
        },
      }));
      /* A picture a call handed back, beside the result it belongs to. */
      for (const reply of message.replies ?? []) {
        for (const img of reply.images ?? []) {
          parts.push({ inlineData: { mimeType: img.mime, data: img.data } });
        }
      }
      return { role: "user", parts };
    }

    const parts: any[] = [];
    if (message.text) parts.push({ text: message.text });
    for (const img of message.images ?? []) {
      parts.push({ inlineData: { mimeType: img.mime, data: img.data } });
    }
    for (const use of message.calls ?? []) {
      parts.push({ functionCall: { name: use.name, args: use.args } });
    }
    return {
      role: message.role === "assistant" ? "model" : "user",
      parts: parts.length > 0 ? parts : [{ text: "(no content)" }],
    };
  });
}

async function streamGemini(call: ChatCall, onDelta: (text: string) => void): Promise<ChatTurn> {
  const client = gemini(call.key, call.baseUrl);
  const stream = await client.models.generateContentStream({
    model: call.model,
    contents: geminiContents(call),
    config: {
      systemInstruction: call.system || undefined,
      abortSignal: call.signal,
      temperature: call.temperature ?? 0.7,
      maxOutputTokens: call.maxTokens ?? 2048,
      thinkingConfig: { thinkingBudget: call.thinkingBudget ?? 0 },
      ...(call.tools?.length
        ? {
            tools: [{
              functionDeclarations: call.tools.map((t) => ({
                name: t.name,
                description: t.description,
                /* Not `parameters`, which wants Google's own Schema type with
                   its uppercase Type enum. This field takes JSON Schema
                   verbatim, which is the one shape all three vendors share --
                   so the registry needs no per-vendor translation. */
                parametersJsonSchema: t.parameters,
              })),
            }],
          }
        : {}),
    },
  });

  let reply = "";
  const usage: ChatUsage = { input: 0, output: 0, estimated: false };
  let counted = false;
  let cutOff = false;
  const calls: ToolUse[] = [];

  for await (const chunk of stream) {
    /* `chunk.text` throws rather than returning undefined when the chunk holds
       a function call instead of prose, which would otherwise abort the stream
       on the very turn the tool was requested. */
    let piece: string | undefined;
    try {
      piece = chunk.text;
    } catch {
      piece = undefined;
    }
    if (piece) {
      reply += piece;
      onDelta(piece);
    }

    /* Function calls arrive whole -- there is no partial-argument streaming to
       reassemble -- but they can arrive on either the convenience getter or in
       the raw parts, depending on SDK version. Reading both and keyed
       de-duplication is cheaper than pinning a version. */
    const found: any[] = [];
    try {
      for (const fn of (chunk as any).functionCalls ?? []) found.push(fn);
    } catch {
      // Same getter problem as above.
    }
    for (const part of (chunk as any).candidates?.[0]?.content?.parts ?? []) {
      if (part?.functionCall) found.push(part.functionCall);
    }
    for (const fn of found) {
      const name = String(fn?.name ?? "");
      if (!name) continue;
      const args = fn?.args && typeof fn.args === "object" ? fn.args : {};
      const id = `${name}-${calls.length}`;
      if (calls.some((c) => c.name === name && JSON.stringify(c.args) === JSON.stringify(args))) {
        continue;
      }
      calls.push({ id, name, args });
    }

    if ((chunk as any).candidates?.[0]?.finishReason === "MAX_TOKENS") cutOff = true;
    const meta = (chunk as any).usageMetadata;
    if (meta) {
      // Gemini reports cumulative counts, so the last word wins rather than
      // the sum -- adding them up bills a long reply several times over.
      usage.input = meta.promptTokenCount ?? usage.input;
      usage.cached = meta.cachedContentTokenCount ?? usage.cached;
      usage.output = (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0);
      counted = true;
    }
  }

  return { usage: counted ? usage : estimate(call, reply), text: reply, calls, cutOff };
}

/**
 * Ask the configured model, streaming the words through `onDelta`.
 *
 * Returns what the model said *and* whatever it wants run. Running those, and
 * deciding whether to go round again, belongs to the caller: the agent loop
 * needs the session, the event log and the approval gate, none of which this
 * module should know about.
 *
 * Throws ProviderError on refusal; the caller decides whether that is worth
 * another attempt and what to tell the reader.
 */
export function streamChat(call: ChatCall, onDelta: (text: string) => void): Promise<ChatTurn> {
  const kind = providerSpec(call.provider)?.kind ?? "openai";
  // The Gemini SDK throws its own error shape rather than returning a
  // response, so unwrapping happens here rather than at the fetch.
  if (kind === "gemini") return streamGemini(call, onDelta).catch((err) => { throw fromSdk(err); });
  if (kind === "anthropic") return streamAnthropic(call, onDelta);
  return streamOpenAi(call, onDelta);
}

// -------------------------------------------------------- model discovery --

/**
 * The models a vendor says it has, right now.
 *
 * The shipped catalogue is a convenience, not the truth: models appear and
 * retire between releases of this app, and OpenRouter alone carries hundreds.
 * Where a vendor publishes prices with the list (OpenRouter does; nobody else
 * does) they come back priced, and those prices are what the billing page then
 * uses.
 */
/** A number out of a vendor's JSON, or undefined: several of them quote a
    limit as a string, and some omit the field entirely. */
function numberOr(value: any): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

/** A window as a person reads it: 1M, 128k, 400k. The old form divided by a
    thousand and said "k", so DeepSeek's million came back as "1000k". */
function windowLabel(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_048_576 > 0.9 && tokens / 1_048_576 < 1.1 ? 1 : Math.round(tokens / 1_000_000);
    return `${millions}M`;
  }
  return `${Math.round(tokens / 1000)}k`;
}

export async function listModels(
  providerId: string,
  key: string,
  baseUrl: string,
): Promise<ModelSpec[]> {
  const spec = providerSpec(providerId);
  if (!spec) throw new ProviderError(`Unknown provider "${providerId}".`, null);
  const root = trimSlash(baseUrl || spec.baseUrl);

  if (spec.kind === "gemini") {
    const res = await request(`${root}/v1beta/models?key=${encodeURIComponent(key)}&pageSize=200`);
    if (!res.ok) throw await failure(res);
    const body: any = await res.json();
    return (body.models ?? [])
      .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m: any) => ({
        id: String(m.name ?? "").replace(/^models\//, ""),
        label: m.displayName || String(m.name ?? "").replace(/^models\//, ""),
        input: 0,
        output: 0,
        priced: false,
        // Google states each model's input limit here, which is the number the
        // context gauge wants -- so it comes back with the list rather than
        // being looked up again somewhere else.
        window: numberOr(m.inputTokenLimit),
      }));
  }

  if (spec.kind === "anthropic") {
    const res = await request(`${root}/v1/models?limit=100`, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    if (!res.ok) throw await failure(res);
    const body: any = await res.json();
    return (body.data ?? []).map((m: any) => ({
      id: String(m.id),
      label: m.display_name || String(m.id),
      input: 0,
      output: 0,
      priced: false,
    }));
  }

  const res = await request(`${root}/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  });
  if (!res.ok) throw await failure(res);
  const body: any = await res.json();

  return (body.data ?? []).map((m: any): ModelSpec => {
    // OpenRouter is the one vendor that quotes a price per token here. It
    // arrives as a decimal string, sometimes "0" for a free model, so the
    // conversion to dollars-per-million is deliberate rather than implied.
    const prompt = Number(m.pricing?.prompt);
    const completion = Number(m.pricing?.completion);
    const quoted = Number.isFinite(prompt) && Number.isFinite(completion);
    /* What a token served from the prompt cache costs, which the same vendors
       also quote ("input_cache_read", a decimal string per token). Leaving it
       out is not neutral: readPrice then falls back to the fresh price, so a
       cache-heavy turn is billed as though every cached token were new. Orca
       Router's tencent/hy4-preview reads at $0.042/M against $0.834/M fresh --
       five times its real cost, which is how $22 of Orca spend read as $91 on
       2026-10-06. */
    const cacheRead = Number(m.pricing?.input_cache_read);
    const cacheQuoted = quoted && Number.isFinite(cacheRead) && cacheRead > 0;
    // OpenRouter quotes how much each of its models holds; Orca Router is
    // OpenAI-shaped and quotes it when it does. OpenAI's own /models says
    // neither, and those models get their window from the table instead.
    const window = numberOr(m.context_length) ?? numberOr(m.context_window);
    return {
      id: String(m.id),
      label: m.name || String(m.id),
      input: quoted ? prompt * 1_000_000 : 0,
      output: quoted ? completion * 1_000_000 : 0,
      cachedInput: cacheQuoted ? cacheRead * 1_000_000 : undefined,
      priced: quoted,
      window,
      note: window ? `${windowLabel(window)} context` : undefined,
    };
  });
}

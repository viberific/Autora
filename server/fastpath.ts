/**
 * The fast path: a few messages whose whole answer Autora already has, answered
 * without a model call.
 *
 * "What time is it" or "which model is this" used to cost a round trip to the
 * provider, a plan and a look back, for something the console can read off its
 * own clock and settings. The match is deliberately narrow and exact, like
 * quick.ts: a message that is wrongly missed is only as slow as it always was,
 * one wrongly caught would answer the wrong question with no one to notice. So
 * a message that says anything more ("what time is it in Tokyo") is not here.
 *
 * Three rules keep it safe. It fails open: the answer is computed under a hard
 * timeout, and a timeout, an error or an empty answer hands the message to the
 * normal turn as if this had never looked. It does nothing with side effects:
 * every action here reads and answers. And every decision is written to the
 * chat's log (a `fastpath` system.log through emitEvent, see beginTurn in
 * server.ts), so a wrong catch can be found and the patterns tightened.
 */

type FastAction = "time" | "date" | "model";

/** What an answer may read. Injected, so the matcher stays pure and testable. */
export interface FastContext {
  now: () => Date;
  /** The model and vendor the next turn would call, or null when none is connected. */
  model: () => { model: string; provider: string } | null;
}

/** What is left of a message once @names, punctuation and emoji are gone (as quick.ts reads one). */
function plain(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/(^|[^\w@.])@[\w-]+/g, " ")
    .replace(/[^a-z' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PATTERNS: readonly (readonly [FastAction, RegExp])[] = [
  ["time", /^(?:(?:hey |hi )?(?:autora )?(?:can you )?(?:tell me |show me )?)?(?:what(?:'s| is) the (?:current )?time|what time is it|what is the time|current time|the time)(?: now| right now| please)?$/],
  ["date", /^(?:(?:can you )?(?:tell me )?)?(?:what(?:'s| is) (?:today'?s |the )?(?:date|day)(?: today)?|what day is it|what is today'?s date|today'?s date|what(?:'s| is) the date today)(?: please)?$/],
  ["model", /^(?:which|what) (?:ai |llm )?model (?:are you|is this|is running|are you using|am i (?:talking|speaking) (?:to|with)|is answering)(?: right now| now| please)?$/],
];

/** The action a whole message asks for, or null when it asks for anything else. */
export function matchFastPath(text: string): FastAction | null {
  const said = plain(String(text ?? ""));
  if (!said || said.length > 60) return null;
  for (const [action, pattern] of PATTERNS) if (pattern.test(said)) return action;
  return null;
}

/** The answer to an action, in the console's own plain voice; null when it cannot be given. */
export function answerFor(action: FastAction, ctx: FastContext): string | null {
  const now = ctx.now();
  if (action === "time") {
    return `It's ${now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.`;
  }
  if (action === "date") {
    return `Today is ${now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}.`;
  }
  const using = ctx.model();
  return using ? `This chat is using ${using.model} on ${using.provider}.` : null;
}

/** How long an answer may take before the message goes to the normal turn instead. */
const FASTPATH_TIMEOUT_MS = 3000;

/** One decision, as the log keeps it. */
interface FastDecision {
  action: FastAction;
  outcome: "answered" | "empty" | "failed" | "timeout";
  ms: number;
  /** The answer, when there was one. */
  reply: string | null;
}

/** Answer under a hard timeout. Anything but an answer is a decision to fall through, never an error. */
export async function runFastPath(
  action: FastAction,
  ctx: FastContext,
  timeoutMs = FASTPATH_TIMEOUT_MS,
  answer: (action: FastAction, ctx: FastContext) => string | null | Promise<string | null> = answerFor,
): Promise<FastDecision> {
  const began = Date.now();
  const done = (outcome: FastDecision["outcome"], reply: string | null = null): FastDecision =>
    ({ action, outcome, ms: Date.now() - began, reply });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
    const got = await Promise.race([Promise.resolve().then(() => answer(action, ctx)), late]);
    if (got === "timeout") return done("timeout");
    return got ? done("answered", got) : done("empty");
  } catch {
    return done("failed");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

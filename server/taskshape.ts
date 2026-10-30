/**
 * What a message says about the work it asks for, read without a model: whether it names the place and the change,
 * whether it says when the work is finished, and whether it starts something new in a chat that has grown long.
 *
 * Each answers one of the habits that save a person's tokens most for least effort (measured over two weeks of logs:
 * 16 long chats out of 370 took 43% of every input token; planning took 1,777 calls; 31 tool calls per message). The
 * console infers what it can from them and says so in the thread, and asks only when it cannot infer.
 *
 * Pure: words in, a verdict out.
 */

/** A file named in the message: a path, or a name with a source extension. */
const FILE = /(?:^|[\s`'"(])((?:[\w.-]+\/)+[\w.-]+|[\w-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|rb|java|kt|swift|c|h|cc|cpp|hpp|cs|php|css|scss|less|html?|vue|svelte|md|json|ya?ml|toml|ini|sh|sql|lua|dart|ex|exs|tf))\b/i;
/** A function, component or name in code: backticked, or called. */
const SYMBOL = /`[^`\s]{2,80}`|\b[A-Za-z_$][\w$]{2,60}\(\)/;
/** A change, said as one. */
const CHANGE = /\b(change|rename|replace|set|fix|remove|delete|add|update|bump|move|swap|make|turn|increase|decrease|raise|lower|use)\b/i;
/** Several things asked at once: a list, or "and also". */
const SEVERAL = /\n\s*(?:[-*]|\d+[.)])\s|\b(?:and also|as well as|then also|also,)\b|;\s*\w+.*;/i;

/** Whether a message names where in the code the change goes: a file, or a function or name in it. */
export function namesPlace(text: string): boolean {
  return FILE.test(text) || SYMBOL.test(text);
}

/**
 * A change whose place and content the message already says: one ask, short, naming a file or a name in the code and
 * what to do there. Agent mode builds it straight away, as it does small talk; planning it would be a round trip spent
 * writing down what the person already wrote.
 */
export function pinpointed(text: string): boolean {
  const t = text.trim();
  if (t.length < 12 || t.length > 400 || SEVERAL.test(t)) return false;
  if (t.split(/[.!?](?:\s|$)/).filter((s) => s.trim()).length > 3) return false;
  return namesPlace(t) && CHANGE.test(t);
}

/** Whether the message says how to tell the work is finished: a check that passes, something to see, a condition. */
export function saysWhenDone(text: string): boolean {
  return /\b(done when|finished when|until|so that|make sure|ensure|should (?:pass|show|return|work|say|print|be)|expect(?:ed)?|tests? (?:pass|green)|passes|verify|check that|acceptance|success(?:ful)? when|it works when)\b/i.test(text);
}

/** A message that is a task, as against a question or a remark: there is work to do and finish. */
export function isTask(text: string): boolean {
  const t = text.trim();
  if (t.length < 15) return false;
  if (/\?\s*$/.test(t) && !/\b(can you|could you|would you|will you|please)\b/i.test(t)) return false;
  return /\b(build|make|create|write|add|fix|change|update|implement|set up|setup|install|refactor|move|rename|remove|delete|deploy|release|migrate|convert|generate|design|improve|clean up|port)\b/i.test(t);
}

const STOP = new Set(("the a an and or but of to in on at for with from by is are was were be been it its this that these those " +
  "i you we they he she me my your our their them us do does did can could would should will just also then than so not no " +
  "yes please thanks thank ok okay now here there what which who how when where why some any all more most very really " +
  "have has had get got go going let make want need like one two out up about into over again still").split(" "));

const words = (text: string): Set<string> =>
  new Set(text.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 2 && !STOP.has(w)));

/** Openings that carry on the work in hand rather than start something else. */
const CARRY_ON = /^\s*(and|also|now|then|ok|okay|great|thanks|yes|no|but|still|again|same|it|that|this|those|these|try|keep|continue|go on|next|another|one more|what about|how about)\b/i;

/**
 * Whether a message starts something unrelated to what the chat has been about: it shares almost none of the words of
 * the person's recent messages and does not open as a follow-up. Wrong now and then by design, since it only offers.
 */
export function newTopic(text: string, earlier: readonly string[]): boolean {
  if (CARRY_ON.test(text)) return false;
  const now = words(text);
  if (now.size < 4) return false;
  const before = words(earlier.join(" "));
  if (before.size === 0) return false;
  let shared = 0;
  for (const w of now) if (before.has(w)) shared += 1;
  return shared / now.size < 0.15;
}

/** The chat sends at least this many tokens a step, and twice what it began with, before a fresh one is offered. */
const FRESH_MIN_TOKENS = 60_000;

/**
 * Whether to offer this message a chat of its own: the chat now sends twice what it began with on every step (and
 * plenty), and the message starts something new. `first` and `last` are the input tokens of its first and latest
 * model calls.
 */
export function freshWorth(first: number, last: number, text: string, earlier: readonly string[]): boolean {
  if (!(first > 0) || last < FRESH_MIN_TOKENS || last < first * 2) return false;
  return isTask(text) && newTopic(text, earlier);
}

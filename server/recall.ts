/**
 * Recall by understanding, not by shared words.
 *
 * The memory graph ranks memories with BM25 (server/memory.ts): a memory is found when it shares words with the request. That
 * misses the one that matters whenever the person says it differently ("ship it" and a note about deploying), and it brings in
 * one that shares a word and nothing else. So a model reads the request and, during the work, what the agent is doing now,
 * and picks from the memories the ones that bear on it.
 *
 * What it is shown: every memory recall may bring in, when there are few enough to list (`CATALOG_MAX`), and otherwise the
 * best lexical candidates for the request, the conversation and the work together, without recall's relevance cut-off. What
 * comes back is ids, checked against that list, so nothing is recalled that was not offered. Pinned memories come every turn,
 * as before.
 *
 * It must never make a turn worse: a judge that is slow (past the budget), fails, or answers with something that is not a
 * list falls back to the word ranking, and says so in the reason. A judge that answers with an empty list is believed.
 */
import { createHash } from "node:crypto";
import type { MemoryGraph, MemoryRecord, Recalled } from "./memory";

/** One model call: system and prompt in, its text out. Stopped by `signal` when the budget runs out. */
export type Judge = (system: string, prompt: string, signal: AbortSignal) => Promise<string>;

interface RecallAsk {
  /** What the person asked this turn. */
  request: string;
  /** The exchange before it, for a follow-up ("yes, do that") whose subject is there. */
  conversation?: string;
  /** What the agent is doing now: the steps it has taken this turn, in a line each. Empty at the start of a turn. */
  work?: string;
  /** Memories already in front of the model this turn. */
  exclude?: ReadonlySet<string>;
  /** How many to bring in at most, pinned ones aside. */
  limit?: number;
}

interface SmartRecall {
  recalled: Recalled[];
  /** True when a model chose them; false when it fell back to the word ranking. */
  judged: boolean;
  /** Why the model did not choose, when it was asked and did not: for the server's log. */
  problem?: string;
}

/** Up to this many recallable memories are all shown to the judge; past it, the lexical candidates. */
const CATALOG_MAX = 150;
/** Candidates shown when the store is larger than that. */
const CANDIDATES = 40;
/** How long a turn waits for the judge before it goes on with the word ranking. */
export const RECALL_BUDGET_MS = Math.max(500, Number(process.env.AUTORA_RECALL_MS) || 6_000);

const SYSTEM = [
  "You choose which of an assistant's saved memories it should have in front of it right now.",
  "Judge by meaning, not by shared words: a memory about deploying bears on \"ship it\"; one that only shares a word does not.",
  "Pick a memory only if it would change or inform what the assistant does or says next: a preference of the person's, a",
  "procedure or fact for this task, a known quirk of the tool or site in use. Prefer fewer: an unrelated memory costs attention.",
  'Reply with JSON only: {"picks":[{"id":"<id>","why":"<at most eight words>"}]}, best first. {"picks":[]} when none applies.',
].join(" ");

/** A memory as one line of the list the judge reads. */
function line(r: MemoryRecord): string {
  const body = r.body.replace(/\s+/g, " ").trim();
  const tags = r.tags.filter((t) => !["agent-authored", "learned", "skill"].includes(t)).slice(0, 5);
  return `${r.id} | ${r.kind}${r.subject ? `, ${r.subject}` : ""} | ${r.title}: ${body.length > 220 ? `${body.slice(0, 219)}…` : body}` +
    (tags.length ? ` [${tags.join(", ")}]` : "");
}

/** The memories the judge chooses among. */
export function candidatesFor(graph: MemoryGraph, ask: RecallAsk): MemoryRecord[] {
  const exclude = ask.exclude ?? new Set<string>();
  const all = graph.recallable().filter((r) => !exclude.has(r.id));
  if (all.length <= CATALOG_MAX) return all;
  const query = [ask.request, ask.work ?? "", ask.conversation ?? ""].filter(Boolean).join("\n");
  return graph.candidates(query, CANDIDATES + exclude.size).filter((r) => !exclude.has(r.id)).slice(0, CANDIDATES);
}

function judgePrompt(ask: RecallAsk, pool: MemoryRecord[]): string {
  const limit = ask.limit ?? 6;
  return [
    `The person's request:\n${clip(ask.request, 2000)}`,
    ask.conversation?.trim() ? `The conversation just before it:\n${clip(ask.conversation, 1500)}` : "",
    ask.work?.trim() ? `What the assistant is doing now, newest last:\n${clip(ask.work, 1500, true)}` : "",
    `Memories (id | kind | title: body [tags]):\n${pool.map(line).join("\n")}`,
    `Pick at most ${limit}.`,
  ].filter(Boolean).join("\n\n");
}

/** The ids the judge picked, in its order, only ones it was offered. Null when the answer is not a list at all. */
export function parsePicks(text: string, pool: MemoryRecord[]): { id: string; why: string }[] | null {
  const offered = new Map(pool.map((r) => [r.id, r]));
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  let picks: unknown;
  try {
    picks = json ? (JSON.parse(json) as { picks?: unknown }).picks : undefined;
  } catch { picks = undefined; }
  if (!Array.isArray(picks)) {
    /* No JSON: a bare list of ids still says what was meant. Anything else is not an answer. */
    const ids = [...new Set(text.match(/[A-Za-z0-9_-]{4,}/g) ?? [])].filter((id) => offered.has(id));
    if (ids.length) return ids.map((id) => ({ id, why: "" }));
    return /\[\s*\]|\bnone\b/i.test(text) ? [] : null;
  }
  const out: { id: string; why: string }[] = [];
  for (const p of picks) {
    const id = typeof p === "string" ? p : typeof (p as any)?.id === "string" ? (p as any).id : "";
    if (!offered.has(id) || out.some((o) => o.id === id)) continue;
    out.push({ id, why: typeof (p as any)?.why === "string" ? String((p as any).why).slice(0, 80) : "" });
  }
  return out;
}

function clip(text: string, n: number, tail = false): string {
  const t = text.trim();
  if (t.length <= n) return t;
  return tail ? `…${t.slice(-(n - 1))}` : `${t.slice(0, n - 1)}…`;
}

/* The same question about the same memories gets the same answer: a retried turn, or a work digest that has not moved,
   is not asked twice. */
const cache = new Map<string, { id: string; why: string }[]>();
const CACHE_MAX = 64;

function keyOf(ask: RecallAsk, pool: MemoryRecord[]): string {
  const h = createHash("sha256");
  h.update(`${ask.request}\u0000${ask.conversation ?? ""}\u0000${ask.work ?? ""}\u0000${ask.limit ?? 6}`);
  for (const r of pool) h.update(`\u0000${r.id}:${r.updated}`);
  return h.digest("hex");
}

/**
 * The memories for this moment: pinned ones, then what the judge picked. `fallback` is the word ranking used when the judge
 * cannot answer in time; it is also what is returned when there is nothing to choose among.
 */
export async function smartRecall(
  graph: MemoryGraph, ask: RecallAsk, judge: Judge | null, fallback: () => Recalled[], budgetMs = RECALL_BUDGET_MS,
): Promise<SmartRecall> {
  const pool = candidatesFor(graph, ask);
  if (!judge || pool.length === 0) return { recalled: fallback(), judged: false };
  const pinned: Recalled[] = (ask.exclude ? [] : graph.active().filter((r) => r.pinned))
    .map((record) => ({ record, score: Infinity, reason: "pinned: always recalled" }));
  const key = keyOf(ask, pool);
  let picks = cache.get(key) ?? null;
  if (!picks) {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), budgetMs);
    let problem = "";
    try {
      const text = await judge(SYSTEM, judgePrompt(ask, pool), stop.signal);
      picks = parsePicks(text, pool);
      if (!picks) problem = `not a list: ${text.replace(/\s+/g, " ").slice(0, 120)}`;
    } catch (err: any) {
      picks = null;
      problem = stop.signal.aborted ? `no answer within ${budgetMs} ms` : String(err?.message ?? err).slice(0, 200);
    } finally {
      clearTimeout(timer);
    }
    if (!picks) {
      return {
        recalled: fallback().map((r) => (r.score === Infinity ? r : { ...r, reason: `${r.reason} (by words; the model choosing did not answer)` })),
        judged: false,
        problem,
      };
    }
    cache.set(key, picks);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  }
  const byId = new Map(pool.map((r) => [r.id, r]));
  const limit = ask.limit ?? 6;
  const chosen: Recalled[] = picks.slice(0, limit).map((p, i) => ({
    record: byId.get(p.id)!,
    score: limit - i,
    reason: p.why ? `chosen for this: ${p.why}` : "chosen as relevant to this",
  }));
  return { recalled: [...pinned, ...chosen], judged: true };
}

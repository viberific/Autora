/**
 * No fold in the middle of a job.
 *
 * The person's ask: a fold must not land while the agent is partway through a
 * job. maybeCompact is asked at the top of every round, so almost every ask is
 * mid-chain -- the last message is a tool reply, or a call still unanswered.
 * Folding there loses the reasoning that got the job that far (the failed
 * approach and why it failed) and re-bills every round of the chain after it.
 *
 * The fold now waits for the loop to come back to a user message, and is forced
 * only past forceHighWaterPct so a single very long chain cannot grow into the
 * window and be refused.
 *
 *   npx tsx tests/context-midtask.test.ts
 */
import assert from "node:assert/strict";
import { ContextEngine, type ContextConfig } from "../server/context";
import { estimateTokens, type ChatMessage } from "../server/llm";

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

/** A 400-token window: soft marks at 200, forced at 380. */
const config: ContextConfig = {
  maxContextTokens: 400,
  highWaterPct: 0.5,
  countHighWaterPct: 0.5,
  forceHighWaterPct: 0.95,
  protectedRecent: 2,
  maxToolTokens: 500,
  maxMessages: 24,
};

const chunk = "words about the work that was done and what it cost. ".repeat(4);

const msg = (role: ChatMessage["role"], extra: Partial<ChatMessage> = {}): ChatMessage => ({
  role,
  text: chunk,
  ...extra,
});

const call = { name: "terminal", id: "c1", args: {} } as unknown as NonNullable<ChatMessage["calls"]>[number];

/** Builds a history, checks it sits in the band the test needs, and loads it. */
function engineOf(messages: ChatMessage[], band: "soft" | "forced"): ContextEngine {
  const tokens = estimateTokens("system", messages);
  if (band === "soft") assert.ok(tokens > 200 && tokens < 380, `soft band: ${tokens} tokens`);
  else assert.ok(tokens >= 380, `forced band: ${tokens} tokens`);
  const engine = new ContextEngine(config, "test-midtask");
  engine.load(messages.map((message, i) => ({ message, seq: i + 1 })));
  return engine;
}

const summarizer = async () => "## ANCHORED WORKING MEMORY\n- the work so far";

console.log("context: no fold in the middle of a job");

await test("a tool reply at the end defers the fold", () => {
  const messages = [
    msg("user"),
    msg("assistant", { calls: [call] }),
    msg("tool", { replies: [] }),
    msg("assistant", { calls: [call] }),
    msg("tool", { replies: [] }),
    msg("tool", { replies: [] }),
  ];
  const engine = engineOf(messages, "soft");
  assert.equal(engine.maybeCompact("system", summarizer), false, "mid-chain: not folded");
});

await test("a call still waiting for its reply defers the fold", () => {
  const messages = [
    msg("user"),
    msg("tool", { replies: [] }),
    msg("user"),
    msg("tool", { replies: [] }),
    msg("user"),
    msg("assistant", { calls: [call] }),
  ];
  const engine = engineOf(messages, "soft");
  assert.equal(engine.maybeCompact("system", summarizer), false, "unanswered call: not folded");
});

await test("the end of a job does fold", () => {
  const messages = [
    msg("user"),
    msg("tool", { replies: [] }),
    msg("user"),
    msg("tool", { replies: [] }),
    msg("assistant"),
    msg("assistant"),
  ];
  const engine = engineOf(messages, "soft");
  assert.equal(engine.maybeCompact("system", summarizer), true, "between jobs: folds");
});

await test("a new user message folds even after a long chain", () => {
  const messages = [
    msg("tool", { replies: [] }),
    msg("assistant", { calls: [call] }),
    msg("tool", { replies: [] }),
    msg("user"),
    msg("tool", { replies: [] }),
    msg("user"),
  ];
  const engine = engineOf(messages, "soft");
  assert.equal(engine.maybeCompact("system", summarizer), true, "user message ends the chain");
});

await test("past the force ceiling it folds mid-chain anyway", () => {
  const messages = [
    msg("tool", { replies: [] }),
    msg("user"),
    msg("tool", { replies: [] }),
    msg("user"),
    msg("tool", { replies: [] }),
    msg("assistant", { calls: [call] }),
    msg("tool", { replies: [] }),
    msg("tool", { replies: [] }),
  ];
  const engine = engineOf(messages, "forced");
  assert.equal(engine.maybeCompact("system", summarizer), true, "over the ceiling: folds regardless");
});

console.log(`\n${passed} mid-task fold tests passed.`);

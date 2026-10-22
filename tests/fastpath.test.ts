/**
 * The fast path (server/fastpath.ts): a few exact questions answered from the
 * console's own clock and settings, with no model call.
 *
 * Checked here: only whole, exact messages match (anything more goes to the
 * model, as before); the answers read the injected clock and model; a slow,
 * failing or empty answer falls through instead of answering; and, end to end
 * against the real server, a matched message is answered without a request to
 * the model and logged, while an unmatched one is a normal turn.
 *
 *   npx tsx tests/fastpath.test.ts
 */
import assert from "node:assert/strict";
import { answerFor, matchFastPath, runFastPath, type FastContext } from "../server/fastpath";
import { startApp, type App } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const ctx: FastContext = {
  now: () => new Date(2026, 9, 22, 15, 5),
  model: () => ({ model: "deepseek-flash", provider: "DeepSeek" }),
};

await test("exact questions match", () => {
  for (const [text, action] of [
    ["What time is it?", "time"], ["what's the time", "time"], ["Current time", "time"], ["what time is it right now?!", "time"],
    ["What's the date?", "date"], ["what day is it", "date"], ["What is today’s date", "date"],
    ["Which model are you?", "model"], ["what model are you using", "model"], ["Which model is this?", "model"],
  ] as const) assert.equal(matchFastPath(text), action, text);
});

await test("anything more, or different, is left to the model", () => {
  for (const text of [
    "", "hello", "what time is it in Tokyo", "what time is the meeting", "set a timer for the time it takes",
    "what's the date format in this file", "which model should I use for this", "what day is the report due",
    "what time is it and then open the PDF", "fix the time zone bug", "x".repeat(80),
  ]) assert.equal(matchFastPath(text), null, text);
});

await test("the answers read the clock and the model they are given", () => {
  assert.equal(answerFor("time", ctx), "It's 3:05 PM.");
  assert.equal(answerFor("date", ctx), "Today is Thursday, October 22, 2026.");
  assert.equal(answerFor("model", ctx), "This chat is using deepseek-flash on DeepSeek.");
  assert.equal(answerFor("model", { ...ctx, model: () => null }), null, "no model connected: no answer");
});

await test("a decision is an answer only when one came in time", async () => {
  const ok = await runFastPath("time", ctx);
  assert.equal(ok.outcome, "answered");
  assert.equal(ok.reply, "It's 3:05 PM.");
  const empty = await runFastPath("model", { ...ctx, model: () => null });
  assert.deepEqual([empty.outcome, empty.reply], ["empty", null]);
  const broke = await runFastPath("time", ctx, 3000, () => { throw new Error("boom"); });
  assert.deepEqual([broke.outcome, broke.reply], ["failed", null]);
  const slow = await runFastPath("time", ctx, 30, () => new Promise((resolve) => setTimeout(() => resolve("late"), 500)));
  assert.deepEqual([slow.outcome, slow.reply], ["timeout", null]);
  assert.ok(slow.ms < 400, "gave up at the timeout, not when the answer finally came");
});

const app: App = await startApp({ env: { DEEPSEEK_API_KEY: "sk-test" } });
try {
  const set = await app.api("PATCH", "/api/settings", {
    provider: "deepseek", models: { deepseek: "deepseek-flash" }, base_urls: { deepseek: app.modelUrl },
  });
  assert.equal(set.status, 200, JSON.stringify(set.body));

  await test("a matched message is answered with no model call, and the decision is logged", async () => {
    app.seen.length = 0;
    const s = await app.newSession("Fast path", "agent");
    const events = await app.turn(s, "which model are you?");
    assert.equal(app.seen.length, 0, "the model was never called");
    const said = events.find((e) => e.kind === "turn.agent.text");
    assert.match(String(said?.payload.text), /deepseek-flash on DeepSeek/);
    assert.ok(events.some((e) => e.kind === "turn.agent.done"));
    const logged = events.find((e) => e.kind === "system.log" && e.payload.event === "fastpath");
    assert.deepEqual([logged?.payload.action, logged?.payload.outcome], ["model", "answered"]);
    assert.equal(logged?.payload.message, undefined, "the log is bookkeeping, not a line in the thread");
  });

  await test("anything else is a normal turn", async () => {
    app.seen.length = 0;
    app.decide = () => ({ text: "From the model." });
    const s = await app.newSession("Not fast", "agent");
    const events = await app.turn(s, "what time is it in Tokyo");
    assert.ok(app.seen.length > 0, "the model was called");
    assert.equal(events.some((e) => e.kind === "system.log" && e.payload.event === "fastpath"), false);
  });
} finally {
  await app.stop();
}

console.log(`\n${passed} passed`);

/**
 * What a message says about its work, read without a model: whether it names the place and the change, whether it
 * says when it is finished, and whether it starts something new in a chat that has grown long. Then, through the real
 * server and a scripted model: a pinpointed change is built without planning; a task with no finish line gets one
 * worked out and shown; a long chat sent something new offers a chat of its own, and taking it moves the message.
 *
 *   npx tsx tests/taskshape.test.ts
 */
import assert from "node:assert/strict";
import { freshWorth, isTask, namesPlace, newTopic, pinpointed, saysWhenDone } from "../server/taskshape";
import { applyRequirements, latestRequirements, requirementsBriefing } from "../server/requirements";
import { startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

console.log("task shape");

await test("a pinpointed change names the place and what to do there, in one short ask", () => {
  for (const t of [
    "In server/auth.ts, change the session timeout from 30 to 60 seconds",
    "Rename `fetchUser` to `loadUser` in src/api.ts",
    "fix the typo in README.md: 'recieve' should be 'receive'",
    "set retries to 3 in refreshSession()",
  ]) assert.ok(pinpointed(t), t);
  for (const t of [
    "Make the login faster",
    "Change the timeout",
    "In server/auth.ts change the timeout to 60s, and also add a retry to the client and write tests for both",
    "- rename x in a.ts\n- rename y in b.ts",
    "What does server/auth.ts do?",
  ]) assert.ok(!pinpointed(t), t);
  assert.ok(namesPlace("look at `refreshSession`") && !namesPlace("look at the login code"));
});

await test("a task, and whether it says when it is finished", () => {
  assert.ok(isTask("Build a page that lists my invoices"));
  assert.ok(!isTask("What is the weather like?"));
  assert.ok(!isTask("thanks!"));
  assert.ok(saysWhenDone("Fix the export so that the PDF opens in Preview"));
  assert.ok(saysWhenDone("Add caching; done when npm test passes"));
  assert.ok(!saysWhenDone("Add caching to the API"));
});

await test("a new topic shares almost no words with what came before, and does not open as a follow-up", () => {
  const before = ["Fix the invoice export so totals include tax", "The invoice PDF still shows the old total"];
  assert.ok(newTopic("Set up a nightly backup of the photos folder to the NAS", before));
  assert.ok(!newTopic("Also round the invoice totals to two decimals", before), "a follow-up");
  assert.ok(!newTopic("The tax line on the invoice export is wrong", before), "the same work");
  assert.ok(!newTopic("now do it", before), "too short to judge");
});

await test("a fresh chat is offered only when the chat sends twice what it began with, and plenty, and the task is new", () => {
  const before = ["Fix the invoice export so totals include tax"];
  const fresh = "Set up a nightly backup of the photos folder to the NAS";
  assert.ok(freshWorth(40_000, 120_000, fresh, before));
  assert.ok(!freshWorth(40_000, 70_000, fresh, before), "not twice what it began with");
  assert.ok(!freshWorth(20_000, 50_000, fresh, before), "not long enough to be worth it");
  assert.ok(!freshWorth(40_000, 120_000, "Also round the invoice totals", before), "not new");
});

await test("the finish line is recorded, said to the agent every turn, and asked for when a task comes without one", () => {
  const set = applyRequirements({ items: [] }, { done_when: "npm test passes and the invoice shows tax" });
  assert.ok(set.ok);
  assert.equal(set.list!.doneWhen, "npm test passes and the invoice shows tax");
  assert.match(requirementsBriefing(set.list!)!, /^Finished when: npm test passes.*check that it holds/);
  assert.match(requirementsBriefing({ items: [] }, true)!, /does not say when it is finished.*requirements done_when.*ask them in one short question/s);
  assert.equal(requirementsBriefing({ items: [] }, false), null);
  const back = latestRequirements([{ kind: "requirements.update", payload: set.list as any }]);
  assert.equal(back.doneWhen, "npm test passes and the invoice shows tax");
  assert.equal(applyRequirements(set.list!, { done_when: "" }).list!.doneWhen, undefined, "\"\" clears it");
});

// --------------------------------------------------------- through the server --

const app = await startApp();
const events = async (s: string) => {
  const body = (await app.api("GET", `/api/sessions/${s}/events`)).body;
  return (Array.isArray(body) ? body : body.events ?? []) as Array<{ kind: string; payload: Record<string, any> }>;
};

try {
  await test("Agent mode builds a pinpointed change straight away, and says why in the thread", async () => {
    const s = await app.newSession("Pinpointed", "agent");
    app.script = [{ text: "Changed." }];
    await app.turn(s, "In server/auth.ts, change the session timeout from 30 to 60 seconds");
    const switches = (await events(s)).filter((e) => e.kind === "mode.switch");
    assert.equal(switches[0]?.payload.to, "build");
    assert.match(switches[0]?.payload.reason, /names the place and the change/);
    const vague = await app.newSession("Vague", "agent");
    app.script = [{ text: "Planning." }];
    await app.turn(vague, "Make the login faster for everyone");
    assert.equal((await events(vague)).find((e) => e.kind === "mode.switch")?.payload.to, "plan", "a vague one still plans");
  });

  await test("a task with no finish line has the agent work one out; recorded, it is shown in the thread", async () => {
    const s = await app.newSession("Finish", "build");
    app.script = [
      { tools: [{ name: "requirements", args: { done_when: "the invoice PDF shows a tax line" } }] },
      { text: "Done." },
    ];
    await app.turn(s, "Add tax to the invoice export");
    const first = app.seen.find((r) => r.last.includes("Add tax to the invoice export"))!;
    assert.match(first.last, /does not say when it is finished/, "the agent was asked to work it out");
    const shown = (await events(s)).filter((e) => e.kind === "requirements.update").at(-1);
    assert.equal(shown?.payload.doneWhen, "the invoice PDF shows a tax line");
    app.script = [{ text: "ok" }];
    await app.turn(s, "Add tax to the invoice export so that the totals match the bank");
    assert.doesNotMatch(app.seen.at(-1)!.last, /does not say when it is finished/, "said by the person: not asked again");
  });

  await test("a long chat sent a new task offers a chat of its own; taking it moves the message there", async () => {
    const s = await app.newSession("Long", "build");
    app.script = [{ text: "Fixed.", promptTokens: 40_000 }];
    await app.turn(s, "Fix the invoice export so totals include tax");
    app.script = [{ text: "Fixed.", promptTokens: 110_000 }];
    await app.turn(s, "The invoice PDF still shows the old total, fix the tax line");
    app.script = [{ text: "On it.", promptTokens: 112_000 }];
    await app.turn(s, "Set up a nightly backup of the photos folder to the NAS");
    const offer = (await events(s)).find((e) => e.kind === "chat.fresh");
    assert.ok(offer, "offered");
    assert.equal(offer!.payload.tokens, 110_000);
    assert.equal(offer!.payload.first, 40_000);
    app.script = [{ text: "Starting the backup." }];
    const moved = await app.api("POST", `/api/sessions/${s}/fresh`, { text: offer!.payload.text });
    assert.equal(moved.status, 200);
    const id = moved.body.id as string;
    const until = Date.now() + 8000;
    while (Date.now() < until && !(await events(id)).some((e) => e.kind === "turn.agent.done")) await new Promise((r) => setTimeout(r, 100));
    const there = await events(id);
    assert.equal(there.find((e) => e.kind === "turn.user")?.payload.text, "Set up a nightly backup of the photos folder to the NAS");
    assert.ok((await events(s)).some((e) => e.kind === "system.log" && /Moved to a new chat/.test(String(e.payload.message))));
    // Not offered again straight away.
    app.script = [{ text: "ok", promptTokens: 112_000 }];
    await app.turn(s, "Write a poem about the garden shed and the autumn leaves");
    assert.equal((await events(s)).filter((e) => e.kind === "chat.fresh").length, 1);
  });
} finally {
  await app.stop();
}

console.log(`\n${passed} passed`);
process.exit(0);

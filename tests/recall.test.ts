/**
 * Recall by understanding (server/recall.ts): a model picks the memories that bear on the request and on the work in
 * progress, from a list it is shown; the word ranking is only the fallback.
 *
 *   npx tsx tests/recall.test.ts
 */
import assert from "node:assert/strict";
import { MemoryGraph } from "../server/memory";
import { candidatesFor, parsePicks, smartRecall, type Judge } from "../server/recall";

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

function store() {
  const g = new MemoryGraph([], []);
  const deploy = g.write({ title: "Deploying the shop", body: "Run ./release.sh from the repo root; it builds the image and rolls it out to the VPS." }).record;
  const tone = g.write({ title: "Writing style", body: "The person wants short answers without bullet lists.", kind: "preference" }).record;
  const nas = g.write({ title: "Backups go to the NAS", body: "The nightly backup writes to /mnt/nas/backups via rsync." }).record;
  return { g, deploy, tone, nas };
}

console.log("recall");

await test("a memory that shares no word with the request is found when the model sees it bears on it", async () => {
  const { g, deploy } = store();
  const words = () => g.recall("ship it to production", 6);
  assert.equal(words().length, 0, "the word ranking finds nothing: the premise of the test");
  let seen = "";
  const judge: Judge = async (_system, prompt) => {
    seen = prompt;
    return JSON.stringify({ picks: [{ id: deploy.id, why: "how this project ships" }] });
  };
  const out = await smartRecall(g, { request: "ship it to production" }, judge, words);
  assert.equal(out.judged, true);
  assert.deepEqual(out.recalled.map((r) => r.record.id), [deploy.id]);
  assert.match(out.recalled[0].reason, /how this project ships/);
  assert.match(seen, /ship it to production/);
  assert.match(seen, new RegExp(deploy.id), "the judge was shown the memory to choose it");
});

await test("what the agent is doing now is part of the question", async () => {
  const { g, nas } = store();
  let seen = "";
  const judge: Judge = async (_s, prompt) => { seen = prompt; return `{"picks":[{"id":"${nas.id}"}]}`; };
  const out = await smartRecall(g, { request: "tidy the server", work: "terminal: du -sh /mnt/nas\nterminal: ls /mnt/nas/backups", limit: 3 }, judge, () => []);
  assert.match(seen, /What the assistant is doing now[\s\S]*mnt\/nas\/backups/);
  assert.deepEqual(out.recalled.map((r) => r.record.id), [nas.id]);
});

await test("ids it was not offered are dropped, an empty answer is believed, and pinned ones always come", async () => {
  const { g, tone, deploy } = store();
  tone.pinned = true;
  const made = await smartRecall(g, { request: "hello there" }, async () => '{"picks":[{"id":"mem-not-real"},{"id":"' + deploy.id + '"}]}', () => []);
  assert.deepEqual(made.recalled.map((r) => r.record.id), [tone.id, deploy.id]);
  const none = await smartRecall(g, { request: "what time is it" }, async () => '{"picks":[]}', () => { throw new Error("no fallback for a real answer"); });
  assert.equal(none.judged, true);
  assert.deepEqual(none.recalled.map((r) => r.record.id), [tone.id], "only the pinned one");
  assert.ok(!candidatesFor(g, { request: "x" }).some((r) => r.id === tone.id), "a pinned memory is not offered to be chosen again");
});

await test("a judge that is slow, fails or does not answer with a list falls back to the word ranking", async () => {
  const { g, nas } = store();
  const words = () => g.recall("where do the nightly backups go", 6);
  assert.equal(words()[0]?.record.id, nas.id);
  const slow: Judge = (_s, _p, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const late = await smartRecall(g, { request: "where do the nightly backups go" }, slow, words, 50);
  assert.equal(late.judged, false);
  assert.equal(late.recalled[0].record.id, nas.id);
  assert.match(late.recalled[0].reason, /by words/);
  const broken = await smartRecall(g, { request: "where do the nightly backups go?" }, async () => "I think the NAS one, maybe", words);
  assert.equal(broken.judged, false);
  const failed = await smartRecall(g, { request: "where do nightly backups go" }, async () => { throw new Error("401"); }, words);
  assert.equal(failed.judged, false);
  assert.equal((await smartRecall(g, { request: "x" }, null, words)).judged, false, "no model connected: words");
});

await test("the same question about the same memories is not asked twice", async () => {
  const { g, deploy } = store();
  let calls = 0;
  const judge: Judge = async () => { calls += 1; return `{"picks":["${deploy.id}"]}`; };
  await smartRecall(g, { request: "roll out the new build" }, judge, () => []);
  await smartRecall(g, { request: "roll out the new build" }, judge, () => []);
  assert.equal(calls, 1);
  deploy.updated += 10;
  await smartRecall(g, { request: "roll out the new build" }, judge, () => []);
  assert.equal(calls, 2, "a memory that changed is a new question");
});

await test("a large store shows the judge the best candidates, not all of it", async () => {
  const g = new MemoryGraph([], []);
  for (let i = 0; i < 200; i++) g.write({ title: `Note ${i} about topic${i}`, body: `Detail number ${i} for subject${i} only.` });
  const target = g.write({ title: "Printer on the office network", body: "The printer is at 10.0.0.40 and needs the IPP driver." }).record;
  const pool = candidatesFor(g, { request: "the printer will not print" });
  assert.ok(pool.length <= 40, `${pool.length}`);
  assert.equal(pool[0].id, target.id);
});

await test("an answer is read as JSON, or as bare ids it was offered", () => {
  const { deploy, nas } = store();
  const pool = [deploy, nas];
  assert.deepEqual(parsePicks('Sure: {"picks":[{"id":"' + nas.id + '","why":"backups"}]}', pool), [{ id: nas.id, why: "backups" }]);
  assert.deepEqual(parsePicks(`${deploy.id}, ${nas.id}`, pool)?.map((p) => p.id), [deploy.id, nas.id]);
  assert.deepEqual(parsePicks("none apply", pool), []);
  assert.equal(parsePicks("I am not sure", pool), null);
});

console.log(`\nrecall: ${passed} passed`);

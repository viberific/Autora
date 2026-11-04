/**
 * The handshake every editor's window shares: a call is offered and pushed again until a window takes it, the first to
 * claim wins once, the reply (or a timeout, a failure, a cancel) ends it, and nothing is left behind.
 *
 *   npx tsx tests/handshake.test.ts
 */
import assert from "node:assert/strict";
import { UNTAKEN, createHandshake } from "../server/handshake";

async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const rig = () => {
  const hs = createHandshake();
  const sent: Record<string, unknown>[] = [];
  hs.setPush((_s, m) => sent.push(m));
  return { hs, sent };
};

await test("an offer is pushed with an id, again until claimed, and ends with the window's reply", async () => {
  const { hs, sent } = rig();
  const p = hs.offer<string>("s1", { type: "x.hand", n: 1 }, { resendMs: 20, claimMs: 500, replyMs: 500 });
  await sleep(70);
  assert.ok(sent.length >= 3, `pushed again while unclaimed: ${sent.length}`);
  const id = sent[0]!.id as string;
  assert.ok(sent.every((m) => m.id === id && m.type === "x.hand"));
  assert.deepEqual(hs.claim("s1", id), { won: true, info: undefined });
  const after = sent.length;
  await sleep(60);
  assert.equal(sent.length, after, "not pushed again once claimed");
  assert.equal(hs.reply("s1", id, "done"), true);
  assert.deepEqual(await p, { taken: true, value: "done" });
  assert.equal(hs.waiting(), 0);
});

await test("the first window to claim wins, once; another chat's window cannot claim or answer", async () => {
  const { hs, sent } = rig();
  const p = hs.offer<number>("s1", {}, { claimMs: 500, replyMs: 500, info: { goal: 7 } });
  const id = sent[0]!.id as string;
  assert.equal(hs.claim("other", id).won, false);
  assert.deepEqual(hs.claim("s1", id), { won: true, info: { goal: 7 } });
  assert.equal(hs.claim("s1", id).won, false, "a second tab does not also do it");
  assert.equal(hs.reply("other", id, 1), false);
  assert.equal(hs.reply("s1", id, 2), true);
  assert.deepEqual(await p, { taken: true, value: 2 });
  assert.equal(hs.reply("s1", id, 3), false, "answered once");
  assert.equal(hs.claim("s1", "nope").won, false);
});

await test("nobody claiming within claimMs is an answer, not an error", async () => {
  const { hs } = rig();
  const t = Date.now();
  assert.deepEqual(await hs.offer("s1", {}, { claimMs: 60, resendMs: 20 }), { taken: false });
  assert.ok(Date.now() - t < 400);
  assert.equal(hs.waiting(), 0);
});

await test("a reply cannot come before the claim", async () => {
  const { hs, sent } = rig();
  const p = hs.offer("s1", {}, { claimMs: 80 });
  assert.equal(hs.reply("s1", sent[0]!.id as string, 1), false);
  assert.deepEqual(await p, { taken: false });
});

await test("a timeout is a made-up reply, UNTAKEN, or an error, counted from the claim (replyMs) or the offer (totalMs)", async () => {
  const a = rig();
  const made = a.hs.offer<string>("s1", {}, { claimMs: 500, replyMs: 60, onTimeout: () => "too slow" });
  a.hs.claim("s1", a.sent[0]!.id as string);
  assert.deepEqual(await made, { taken: true, value: "too slow" });
  const b = rig();
  assert.deepEqual(await b.hs.offer("s1", {}, { totalMs: 50, onTimeout: () => UNTAKEN }), { taken: false });
  const c = rig();
  await assert.rejects(c.hs.offer("s1", {}, { totalMs: 50, timeoutError: "The music window did not answer in 0 seconds." }), /did not answer/);
  const d = rig();
  const started = Date.now();
  const q = d.hs.offer<string>("s1", {}, { replyMs: 60, onTimeout: () => "late" });
  await sleep(120);
  assert.equal(d.hs.waiting(), 1, "replyMs does not start until a window claims it");
  d.hs.claim("s1", d.sent[0]!.id as string);
  assert.deepEqual(await q, { taken: true, value: "late" });
  assert.ok(Date.now() - started >= 170);
});

await test("fail rejects the offer; cancelAll ends every call of a chat and no other", async () => {
  const { hs, sent } = rig();
  const failing = hs.offer("s1", {}, { totalMs: 1000 });
  const bad = assert.rejects(failing, /could not do that/);
  assert.equal(hs.fail("s2", sent[0]!.id as string, new Error("x")), false);
  assert.equal(hs.fail("s1", sent[0]!.id as string, new Error("The window could not do that.")), true);
  await bad;
  const mine = hs.offer("s1", {}, { totalMs: 2000 });
  const theirs = hs.offer<string>("s2", {}, { totalMs: 2000 });
  const gone = assert.rejects(mine, /closed/);
  hs.cancelAll("s1", "The window was closed.");
  await gone;
  assert.equal(hs.waiting("s2"), 1);
  hs.claim("s2", sent.at(-1)!.id as string);
  hs.reply("s2", sent.at(-1)!.id as string, "ok");
  assert.deepEqual(await theirs, { taken: true, value: "ok" });
  assert.equal(hs.waiting(), 0, "nothing is left behind");
});

console.log("handshake tests passed");

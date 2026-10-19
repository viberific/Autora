/**
 * The thumb under a reply, and the record it leaves.
 *
 * The self-improvement digest counts these -- `turn.rating` events with
 * `{ up, reason? }` -- so the shape of the event is the contract, not a
 * detail of this feature. And because a clear has to be written as something
 * without being a down-vote (counting it as one would poison the number the
 * digest exists to give), a clear is a kind of its own and the counting
 * readers skip it.
 *
 *   npm test -- rating
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sleep, startApp, type App, type Ev } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

/** The log as it is on disk, which is what the digest reads. The app writes it
    through a short batching timer, so the file can trail the last event by a
    moment: waited for, not assumed. */
async function logOnDisk(app: App, session: string, wantRatings = 0, wantClears = 0): Promise<Ev[]> {
  const file = path.join(app.home, "settings", "sessions", session, "events.jsonl");
  const read = () =>
    fs.existsSync(file)
      ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Ev)
      : [];
  /* Lines are written in batches, so a call that has just returned may not be
     in the file yet: wait for the number of ratings the test expects. */
  for (let i = 0; i < 60; i += 1) {
    const events = read();
    const rated = events.filter((e) => e.kind === "turn.rating").length;
    const cleared = events.filter((e) => e.kind === "turn.rating.cleared").length;
    if (rated >= wantRatings && cleared >= wantClears) return events;
    await sleep(50);
  }
  return read();
}

async function main() {
  const { cleanReason, ratingCall, ratingsFrom, MAX_REASON } = await import("../server/rating");

  console.log("what a rating call is");
  await test("a reason is one short line, whatever was typed", () => {
    assert.equal(cleanReason("  the\nanswer\twas   wrong "), "the answer was wrong");
    assert.equal(cleanReason("   "), undefined);
    assert.equal(cleanReason(42), undefined);
    const long = cleanReason("x".repeat(MAX_REASON + 50));
    assert.equal(long?.length, MAX_REASON);
    assert.ok(long?.endsWith("…"));
    /* Nul bytes and control characters never reach the payload. */
    assert.equal(cleanReason("a\u0000b\u001fc"), "a b c");
  });

  await test("a turn that is not in the chat is refused", () => {
    const call = ratingCall({ turn: 7, up: true }, new Set([3, 5]));
    assert.equal(call.ok, false);
    assert.equal(call.ok === false && call.status, 404);
  });

  await test("malformed asks are refused, not written", () => {
    for (const body of [{}, { turn: "x", up: true }, { turn: 0, up: true }, { turn: -4, up: true }, { turn: 3.5, up: true }]) {
      const call = ratingCall(body, new Set([3]));
      assert.equal(call.ok, false, JSON.stringify(body));
      assert.equal(call.ok === false && call.status, 400);
    }
    /* A turn that is here but no thumb on it: neither up nor down nor null. */
    assert.equal(ratingCall({ turn: 3, up: "yes" }, new Set([3])).ok, false);
    assert.equal(ratingCall({ turn: 3 }, new Set([3])).ok, false);
  });

  await test("null takes it back, and a boolean sets it", () => {
    assert.deepEqual(ratingCall({ turn: 3, up: null }, new Set([3])), { ok: true, clear: true, turn: 3 });
    assert.deepEqual(ratingCall({ turn: 3, up: true }, new Set([3])), { ok: true, clear: false, turn: 3, up: true });
    assert.deepEqual(
      ratingCall({ turn: 3, up: false, reason: " missed the point " }, new Set([3])),
      { ok: true, clear: false, turn: 3, up: false, reason: "missed the point" },
    );
  });

  await test("last word wins when read back", () => {
    const events = [
      { kind: "turn.rating", payload: { turn: 3, up: false, reason: "wrong file" } },
      { kind: "turn.rating", payload: { turn: 3, up: true } },
      { kind: "turn.rating", payload: { turn: 5, up: true } },
    ];
    const got = ratingsFrom(events);
    assert.deepEqual(got.get(3), { up: true });
    assert.deepEqual(got.get(5), { up: true });
    assert.equal(got.size, 2);
    const cleared = ratingsFrom([...events, { kind: "turn.rating.cleared", payload: { turn: 3 } }]);
    assert.equal(cleared.has(3), false);
    assert.equal(cleared.size, 1);
  });

  console.log("the route, on a real server");
  const app = await startApp();
  try {
    app.script.push({ text: "Done: the file is written." });
    const session = await app.newSession("Ratings");
    const events = await app.turn(session, "Write the file");
    const prompt = events.find((e) => e.kind === "turn.user");
    assert.ok(prompt, "the turn has a prompt to file a rating under");
    const turn = prompt.seq;

    await test("a thumb up is a turn.rating event in events.jsonl", async () => {
      const r = await app.api("POST", `/api/sessions/${session}/rating`, { turn, up: true });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.rating, { up: true });
      const logged = (await logOnDisk(app, session, 1)).filter((e) => e.kind === "turn.rating");
      assert.equal(logged.length, 1);
      assert.equal(logged[0].payload.turn, turn);
      assert.equal(logged[0].payload.up, true);
      assert.equal(logged[0].payload.reason, undefined);
    });

    await test("a thumb down carries its one-line reason, clamped", async () => {
      const r = await app.api("POST", `/api/sessions/${session}/rating`, {
        turn, up: false, reason: "  answered the\nother question  ",
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.rating, { up: false, reason: "answered the other question" });
      const long = await app.api("POST", `/api/sessions/${session}/rating`, { turn, up: false, reason: "y".repeat(4000) });
      assert.equal(long.status, 200);
      const last = (await logOnDisk(app, session, 2)).filter((e) => e.kind === "turn.rating").pop();
      assert.equal(last?.payload.reason.length, MAX_REASON);
      assert.equal(typeof last?.payload.up, "boolean");
    });

    await test("the second thumb replaces the first in what is read back", async () => {
      await app.api("POST", `/api/sessions/${session}/rating`, { turn, up: true });
      const got = await app.api("GET", `/api/sessions/${session}/ratings`);
      assert.equal(got.status, 200);
      assert.deepEqual(got.body.ratings[String(turn)], { up: true });
      /* Every click is still in the log -- the record is the history, and the
         reading of it is the state. */
      assert.ok((await logOnDisk(app, session)).filter((e) => e.kind === "turn.rating").length >= 3);
    });

    await test("clicking the lit thumb again clears it, and a clear is not a down-vote", async () => {
      const r = await app.api("POST", `/api/sessions/${session}/rating`, { turn, up: null });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.rating, null);
      const logged = (await logOnDisk(app, session, 0, 1));
      const clears = logged.filter((e) => e.kind === "turn.rating.cleared");
      assert.equal(clears.length, 1);
      assert.equal(clears[0].payload.turn, turn);
      assert.equal(clears[0].payload.up, undefined, "a clear must not look like a thumb down");
      const got = await app.api("GET", `/api/sessions/${session}/ratings`);
      assert.equal(got.body.ratings[String(turn)], undefined);
      /* The digest's own reading: ups and downs only, clears counted as neither. */
      const counted = logged.filter((e) => e.kind === "turn.rating");
      const stillUp = counted.filter((e) => e.payload.up === true).length;
      assert.ok(counted.length > stillUp, "the replaced thumbs are still in the log");
    });

    await test("a turn that is not in this chat, and a body with no turn, are refused", async () => {
      const notHere = await app.api("POST", `/api/sessions/${session}/rating`, { turn: 999999, up: true });
      assert.equal(notHere.status, 404);
      const noTurn = await app.api("POST", `/api/sessions/${session}/rating`, { up: true });
      assert.equal(noTurn.status, 400);
      const wrongUp = await app.api("POST", `/api/sessions/${session}/rating`, { turn, up: "up" });
      assert.equal(wrongUp.status, 400);
      const noSession = await app.api("POST", "/api/sessions/nope/rating", { turn, up: true });
      assert.equal(noSession.status, 404);
      /* None of the refusals wrote anything. */
      const kinds = (await logOnDisk(app, session)).map((e) => e.kind);
      assert.equal(kinds.filter((k) => k === "turn.rating.cleared").length, 1);
    });

    await test("the trace counts the thumbs, per turn and per tool", async () => {
      const { buildTrace } = await import("../server/trace");
      const logged = (await logOnDisk(app, session));
      const trace = buildTrace(logged);
      assert.equal(trace.turns, 1);
      assert.equal(trace.ratingsUp, 0, "the last word was a clear");
      assert.equal(trace.ratingsDown, 0);
      const after = buildTrace([
        ...logged,
        { kind: "turn.rating", seq: 999, payload: { turn, up: false, reason: "wrong file" } } as unknown as Ev,
      ]);
      assert.equal(after.ratingsDown, 1);
      assert.equal(after.ratingsWithReason, 1);
      assert.equal(after.ratingsUp, 0);
      assert.equal(after.recent[0].rating?.up, false);
    });
  } finally {
    await app.stop();
  }

  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

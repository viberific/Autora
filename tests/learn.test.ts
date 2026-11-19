/**
 * Learn mode (docs/LEARN.md): the switch is per chat and saved with it, the lesson tool puts a lesson in the log, a step is
 * reported by the page and moves the lesson on, switching Learn off ends it, and the agent is told what mode it is in.
 *
 *   npx tsx tests/learn.test.ts
 */
import assert from "node:assert/strict";
import { cleanSteps, lessonFrom, MAX_STEPS } from "../src/lib/learn";
import { learnBriefing } from "../server/learn";
import { FAMILIES, loadedFamilies } from "../server/toolload";
import { startApp, type App, type Ev } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const lesson = (id: string, steps: number): { kind: string; payload: Record<string, unknown> } => ({
  kind: "learn.lesson",
  payload: { lesson: id, title: "T", steps: Array.from({ length: steps }, (_, i) => ({ say: `step ${i + 1}`, target: { label: `Tool ${i + 1}` } })) },
});

async function main() {
  console.log("the lesson, read off the log");
  await test("steps are cleaned: a target needs a name, a step needs words, a lesson has a limit", () => {
    const ok = cleanSteps([{ say: " Click it. ", target: { label: "All tools", text: "", selector: "  " } }, { say: "Think." }]);
    assert.ok("steps" in ok);
    assert.deepEqual(ok.steps, [{ say: "Click it.", target: { label: "All tools" } }, { say: "Think." }]);
    assert.ok("error" in cleanSteps([]));
    assert.ok("error" in cleanSteps([{ say: "" }]));
    assert.ok("error" in cleanSteps(Array.from({ length: MAX_STEPS + 1 }, () => ({ say: "x" }))));
  });
  await test("a lesson starts at step one, moves on as steps are reported, and is over after the last", () => {
    assert.equal(lessonFrom([]), null);
    const log = [lesson("a", 3)];
    assert.equal(lessonFrom(log)?.index, 0);
    log.push({ kind: "learn.step", payload: { lesson: "a", index: 0, how: "done" } });
    assert.equal(lessonFrom(log)?.index, 1);
    log.push({ kind: "learn.step", payload: { lesson: "a", index: 1, how: "skipped" } }, { kind: "learn.step", payload: { lesson: "a", index: 2, how: "done" } });
    assert.equal(lessonFrom(log), null);
  });
  await test("a second lesson replaces the first, a report for the old one is ignored, and learn.end ends it", () => {
    const log = [lesson("a", 3), lesson("b", 2)];
    assert.equal(lessonFrom(log)?.lesson.id, "b");
    log.push({ kind: "learn.step", payload: { lesson: "a", index: 0, how: "done" } });
    assert.equal(lessonFrom(log)?.index, 0);
    log.push({ kind: "learn.end", payload: { lesson: "b", how: "left" } } as never);
    assert.equal(lessonFrom(log), null);
  });

  console.log("what the agent is told and shown");
  await test("Learn on tells the agent to teach, and a lesson under way says where the person is", () => {
    assert.equal(learnBriefing(false, null), null);
    assert.match(learnBriefing(true, null)!, /TEACH it/);
    const note = learnBriefing(false, lessonFrom([lesson("a", 2)]))!;
    assert.match(note, /step 1 of 2: step 1/);
    assert.match(note, /Do not do them for them/);
  });
  await test("the lesson tool is its own set, brought in by Learn being on or by asking to be shown", () => {
    assert.ok(FAMILIES.some((f) => f.id === "learn" && f.match("learn_show")));
    const none = { events: [] as never[], lazy: true };
    assert.ok(!loadedFamilies({ ...none, said: "write a poem" }).has("learn"));
    assert.ok(loadedFamilies({ ...none, said: "show me how to highlight a PDF" }).has("learn"));
    assert.ok(loadedFamilies({ ...none, said: "hello", learn: true }).has("learn"));
  });

  console.log("in the running app");
  const app: App = await startApp();
  try {
    const kinds = (events: Ev[], kind: string) => events.filter((e) => e.kind === kind);
    await test("the switch is per chat, saved with it, and starts off", async () => {
      const s = await app.newSession("learn", "build");
      const other = await app.newSession("other", "build");
      assert.equal((await app.api("GET", "/api/sessions")).body.find((x: any) => x.id === s).learn, false);
      const res = await app.api("PATCH", `/api/sessions/${s}`, { learn: true });
      assert.equal(res.body.learn, true);
      const list = (await app.api("GET", "/api/sessions")).body;
      assert.equal(list.find((x: any) => x.id === s).learn, true);
      assert.equal(list.find((x: any) => x.id === other).learn, false);
      await app.restart();
      assert.equal((await app.api("GET", "/api/sessions")).body.find((x: any) => x.id === s).learn, true, "still on after a restart");
    });

    await test("with Learn on the agent is told, and has the lesson tool; learn_show starts a lesson the page can see", async () => {
      const s = await app.newSession("teach", "build");
      await app.api("PATCH", `/api/sessions/${s}`, { learn: true });
      app.seen.length = 0;
      app.script.push({ tools: [{ name: "learn_show", args: { title: "Highlighting", steps: [{ say: "Open All tools.", target: { label: "All tools" } }, { say: "Pick Highlight.", target: { text: "Highlight" } }] } }] });
      app.script.push({ text: "Open All tools to start." });
      const events = await app.turn(s, "highlight this for me");
      assert.match(app.seen[0].system + JSON.stringify(app.seen[0].messages), /Learn mode is ON/);
      assert.ok(app.seen[0].tools.includes("learn_show"));
      const started = kinds(events, "learn.lesson");
      assert.equal(started.length, 1);
      assert.equal(started[0].payload.steps.length, 2);
      assert.equal(lessonFrom(events)?.index, 0);
    });

    await test("a reported step moves the lesson on; a stale or repeated report changes nothing; the last step finishes it", async () => {
      const s = await app.newSession("steps", "build");
      app.script.push({ tools: [{ name: "learn_show", args: { title: "Two steps", steps: [{ say: "One." }, { say: "Two." }] } }] });
      app.script.push({ text: "Go." });
      const id = lessonFrom(await app.turn(s, "show me how to do it"))!.lesson.id;
      const post = (body: object) => app.api("POST", `/api/sessions/${s}/learn`, body);
      assert.equal((await post({ lesson: "someone-else", index: 0 })).body.current, false);
      assert.equal((await post({ lesson: id, index: 1, how: "done" })).body.index, 0, "a step out of order is not taken");
      assert.equal((await post({ lesson: id, index: 0, how: "done" })).body.index, 1);
      assert.equal((await post({ lesson: id, index: 0, how: "done" })).body.index, 1, "the same step twice counts once");
      assert.equal(lessonFrom(await app.events(s))?.index, 1);
      assert.equal((await post({ lesson: id, index: 1, how: "skipped" })).body.current, false);
      assert.equal(lessonFrom(await app.events(s)), null);
    });

    await test("switching Learn off in the middle of a lesson ends it", async () => {
      const s = await app.newSession("off", "build");
      await app.api("PATCH", `/api/sessions/${s}`, { learn: true });
      app.script.push({ tools: [{ name: "learn_show", args: { title: "T", steps: [{ say: "One." }, { say: "Two." }] } }] });
      app.script.push({ text: "Go." });
      await app.turn(s, "show me how");
      assert.ok(lessonFrom(await app.events(s)));
      await app.api("PATCH", `/api/sessions/${s}`, { learn: false });
      const events = await app.events(s);
      assert.equal(lessonFrom(events), null);
      assert.equal(kinds(events, "learn.end").length, 1);
    });

    await test("a lesson with no steps, or too many, is refused in words the agent can act on", async () => {
      const s = await app.newSession("bad", "build");
      app.script.push({ tools: [{ name: "learn_show", args: { title: "Empty", steps: [] } }] });
      app.script.push({ text: "Ok." });
      const events = await app.turn(s, "show me how");
      assert.equal(kinds(events, "learn.lesson").length, 0);
      assert.match(JSON.stringify(app.seen[app.seen.length - 1].messages), /A lesson needs steps/);
    });

    await test("Plan mode still allows a lesson: it changes nothing", async () => {
      const s = await app.newSession("plan", "plan");
      app.script.push({ tools: [{ name: "learn_show", args: { title: "T", steps: [{ say: "One." }] } }] });
      app.script.push({ text: "Go." });
      const events = await app.turn(s, "show me how");
      assert.equal(kinds(events, "learn.lesson").length, 1);
    });
  } finally {
    await app.stop();
  }
  console.log(`\n${passed} passed, 0 failed`);
}

main().catch((err) => { console.error(err); process.exit(1); });

/**
 * Through the real server: a command that failed is not run again unchanged, the agent is told why in the same
 * round, `retry` with a reason lets it through, and a change (an edit) frees it. The command counts its own runs in
 * a file, so "not run" is checked on disk, not taken on the loop's word.
 *
 *   npx tsx tests/e2e-failedcmds.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startApp, turnStart } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function main() {
  const app = await startApp();
  try {
    const counter = path.join(app.home, "runs.txt");
    const command = `echo run >> ${counter}; echo "Error: the build is broken" >&2; exit 1`;
    const runs = () => (fs.existsSync(counter) ? fs.readFileSync(counter, "utf8").trim().split("\n").length : 0);
    const results = () => app.seen.flatMap((r) => r.messages.filter((m: any) => m.role === "tool").map((m: any) => String(m.content)));

    console.log("failed commands, through the loop");
    await test("the same failing command, again with nothing changed: not run, and the agent is told why", async () => {
      const s = await app.newSession("fails", "build");
      let step = 0;
      app.decide = (req) => {
        if (turnStart(req)) step = 0;
        step += 1;
        return step <= 2 ? { tools: [{ name: "terminal", args: { command } }] } : { text: "Stopped." };
      };
      await app.turn(s, "build it");
      assert.equal(runs(), 1, "it ran once, not twice");
      const said = results();
      assert.ok(said.some((r) => /will not be made again unchanged/.test(r)), "the first failure says it will not be rerun");
      assert.ok(said.some((r) => /Not done again: `echo run/.test(r) && /exit 1/.test(r)), "the repeat is refused with the reason");
      app.decide = null;

      // A new turn: still refused, and the note says so up front.
      const from = app.seen.length;
      app.decide = (req) => (turnStart(req) ? { tools: [{ name: "terminal", args: { command } }] } : { text: "ok" });
      await app.turn(s, "try the build");
      assert.equal(runs(), 1, "not run on the next turn either");
      assert.match(JSON.stringify(app.seen[from].messages), /Actions that failed in this chat and would fail again/);

      // retry with a reason runs it.
      app.decide = (req) => (turnStart(req) ? { tools: [{ name: "terminal", args: { command, retry: "the person says they fixed the build" } }] } : { text: "ok" });
      await app.turn(s, "I fixed it, try again");
      assert.equal(runs(), 2, "retry lets it through");

      // A change frees it without a reason.
      let edited = false;
      app.decide = (req) => {
        if (turnStart(req)) return { tools: [{ name: "edit_file", args: { path: "fix.txt", content: "fixed\n" } }] };
        if (!edited) { edited = true; return { tools: [{ name: "terminal", args: { command } }] }; }
        return { text: "ok" };
      };
      await app.turn(s, "fix it and build");
      assert.equal(runs(), 3, "after an edit it runs again");
      app.decide = null;
    });
    await test("an edit whose text is not in the file is not tried again; a retry with a reason is, and the tool never sees retry", async () => {
      const s = await app.newSession("edits", "build");
      fs.writeFileSync(path.join(app.home, "app.js"), "const a = 1;\n");
      const args = { path: "app.js", edits: [{ old: "const b = 1;", new: "const b = 2;" }] };
      let step = 0;
      app.decide = (req) => {
        if (turnStart(req)) step = 0;
        step += 1;
        return step === 1 ? { tools: [{ name: "edit_file", args }] }
          : step === 2 ? { tools: [{ name: "edit_file", args }] }
          : step === 3 ? { tools: [{ name: "edit_file", args: { ...args, retry: "checking the refusal is lifted" } }] }
          : { text: "Done." };
      };
      const from = app.seen.length;
      await app.turn(s, "change b");
      const back = app.seen.slice(from).map((r) => String(r.messages.filter((m: any) => m.role === "tool").pop()?.content ?? ""));
      assert.match(back[1], /that text is not in the file[\s\S]*will not be made again unchanged/, "the first failure, and the lesson");
      assert.match(back[2], /^Not done again: `edit_file /, "the repeat is refused");
      assert.match(back[3], /that text is not in the file/, "the retry ran the edit again, and it failed as before");
      assert.doesNotMatch(back[3], /retry/i, "the edit tool was not handed retry");
      app.decide = null;
    });
  } finally {
    await app.stop();
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });

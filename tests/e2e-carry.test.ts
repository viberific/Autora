/**
 * A follow-up within the vendor's cache lifetime carries the last turn's tool work on, through the real server: the
 * first request of the second turn opens with everything the first turn sent, byte for byte (a cache read), and the
 * file it read is still there. A local server is not carried (it bills nothing for a prompt).
 *
 *   npx tsx tests/e2e-carry.test.ts
 */
import assert from "node:assert/strict";
import { startApp, turnStart } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function main() {
  const app = await startApp({ env: { DEEPSEEK_API_KEY: "sk-test" } });
  try {
    console.log("carrying a turn on");
    const readFirst = (marker: string) => {
      app.decide = (req) => turnStart(req) && /read it/.test(req.last)
        ? { tools: [{ name: "terminal", args: { command: `echo ${marker}` } }] }
        : { text: "Done." };
    };

    await test("on a caching vendor, the next turn opens with the last one's requests and still has its output", async () => {
      const set = await app.api("PATCH", "/api/settings", {
        provider: "deepseek", models: { deepseek: "deepseek-flash" }, base_urls: { deepseek: app.modelUrl },
      });
      assert.ok(set.status < 300, JSON.stringify(set.body));
      const s = await app.newSession("carry", "build");
      readFirst("FIRST_OUTPUT_7");
      await app.turn(s, "read it");
      const lastOfFirst = app.seen[app.seen.length - 1];
      const from = app.seen.length;
      await app.turn(s, "and now say what it printed");
      const opening = app.seen[from];
      const before = lastOfFirst.messages.filter((m: any) => m.role !== "system");
      const after = opening.messages.filter((m: any) => m.role !== "system");
      assert.deepEqual(after.slice(0, before.length), before, "the last turn's history is a prefix of this one");
      assert.match(JSON.stringify(after), /FIRST_OUTPUT_7/, "the command's output is still in the history");
      app.decide = null;
    });

    await test("on a local server, the next turn starts from words, as before", async () => {
      await app.api("PATCH", "/api/settings", { provider: "local", models: { local: "fake-1" }, base_urls: { local: app.modelUrl } });
      const s = await app.newSession("local", "build");
      readFirst("LOCAL_OUTPUT_9");
      await app.turn(s, "read it");
      const from = app.seen.length;
      await app.turn(s, "and now say what it printed");
      assert.ok(!app.seen[from].messages.some((m: any) => m.role === "tool"), "no tool results from the last turn");
      app.decide = null;
    });
  } finally {
    await app.stop();
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });

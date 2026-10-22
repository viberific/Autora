/**
 * Roles across providers, end to end: the real server, a scripted model.
 *
 * DeepSeek does the work and the background model is on OpenRouter, both
 * pointed at the same fake model, which answers by the model each request
 * names. Checked: an Agent chat plans and builds on the one main model, every
 * request carrying that model and the mode chips naming no other; a planner
 * sent by an older client is ignored, not stored; and the settings report the
 * background model on its own provider.
 *
 *   npx tsx tests/e2e-roles.test.ts
 */
import assert from "node:assert/strict";
import { startApp, type App, type Seen } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const BUILDER = "deepseek-flash";
const BACKGROUND = "background-x";

async function main() {
  const app: App = await startApp({ env: { DEEPSEEK_API_KEY: "sk-test", OPENROUTER_API_KEY: "sk-or-test" } });
  try {
    const set = await app.api("PATCH", "/api/settings", {
      /* Roles are Automatic's: a named provider answers with itself every round
         (server/state.ts, and tests/roles.test.ts). */
      provider: "auto",
      models: { deepseek: BUILDER },
      base_urls: { deepseek: app.modelUrl, openrouter: app.modelUrl },
      background_providers: { deepseek: "openrouter" },
      background_models: { deepseek: BACKGROUND },
      /* What an older client still sends: no planner is kept. */
      planner_providers: { deepseek: "openrouter" },
      planner_models: { deepseek: "planner-x" },
    });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const card = set.body.catalog.find((c: { id: string }) => c.id === "deepseek");
    assert.equal(card.background_provider, "openrouter");
    assert.equal(card.background_model, BACKGROUND);
    assert.equal(card.planner_model, undefined, "there is no planner to report");
    assert.equal(set.body.active.planner, undefined);

    await test("an Agent chat plans and builds on the one main model", async () => {
      app.seen.length = 0;
      app.decide = (req: Seen) => req.model === BUILDER && app.seen.length === 1
        ? { tools: [{ name: "set_mode", args: { to: "build", reason: "plan is ready" } }] }
        : { text: "Built it." };
      const s = await app.newSession("Roles", "agent");
      const events = await app.turn(s, "Make the thing.");
      const models = app.seen.map((r) => r.model);
      assert.equal(models[0], BUILDER, "the turn opens planning, on the main model");
      assert.ok(models.every((m) => m === BUILDER || m === BACKGROUND), models.join(", "));

      const chips = events.filter((e) => e.kind === "mode.switch");
      assert.ok(chips.length > 0, "the switch is still said in the thread");
      assert.ok(chips.every((e) => e.payload.model === undefined), "no chip names another model");

      const usage = events.filter((e) => e.kind === "usage.turn").map((e) => `${e.payload.provider}/${e.payload.model}`);
      assert.ok(usage.includes(`deepseek/${BUILDER}`), usage.join(", "));
      assert.equal(events.some((e) => e.kind === "system.error"), false);
    });
  } finally {
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });

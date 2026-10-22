/**
 * Roles: which model does which part of the work.
 *
 * Checked here: the main model does every round, planning and building alike
 * (there is no planner role); background work keeps its old rule (talk mode's
 * model, else the main one) unless a background model or the environment says
 * otherwise; the context window counts every model that may answer the
 * conversation; the settings round-trip, a planner saved by an older version is
 * ignored, and the task ledger still reads tasks that recorded one. A background
 * model may be another provider's, reached with that provider's own key, and
 * falls back to the main model (saying why) when that key is gone. An
 * Organization agent's own model replaces the main model for its chat, on its
 * own provider when that can be reached, says why when it cannot, and is never
 * set on the lead. Anthropic is sent tool ids it accepts, unique and paired,
 * whoever made the calls.
 *
 *   npx tsx tests/roles.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-roles-"));
process.env.AUTORA_STATE_DIR = dir;

const { agentModelFor, backgroundTarget, conversationTargets, mainTarget } = await import("../server/roles");
const { state, resolveProvider } = await import("../server/state");
const { openTask, closeTask, taskSummary } = await import("../server/taskledger");
const { anthropicMessages } = await import("../server/llm");
const { createAgent, updateAgent, getAgent, agentLine, LEAD_ID } = await import("../server/agents");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

const main = { provider: "deepseek", key: "k-ds", baseUrl: "https://ds" };
const at = (model: string, provider = "deepseek") =>
  ({ provider, model, key: `k-${provider}`, baseUrl: `https://${provider}` });
const roles = (over: Partial<{ model: string; fastModel: string; background: ReturnType<typeof at> | null }> = {}) => ({
  ...main, model: "cheap", fastModel: "", background: null, ...over,
});
const model = (t: { model: string }) => t.model;

await test("the main model is the target of the work", () => {
  assert.deepEqual(mainTarget(roles()), { ...main, model: "cheap" });
});

await test("background work keeps its old rule unless told otherwise", () => {
  assert.equal(model(backgroundTarget(roles())), "cheap");
  assert.equal(model(backgroundTarget(roles({ fastModel: "fast" }))), "fast");
  assert.deepEqual(backgroundTarget(roles({ fastModel: "fast", background: at("tiny", "openai") })), at("tiny", "openai"));
  /* The environment's override is a model of the main provider. */
  assert.deepEqual(backgroundTarget(roles({ background: at("tiny", "openai") }), " env-model "), { ...main, model: "env-model" });
  assert.equal(model(backgroundTarget(roles({ background: at("tiny") }), "  ")), "tiny");
  /* With nothing named, a cheaper model of the same provider when the price list has one; anything named still wins. */
  assert.equal(model(backgroundTarget(roles(), undefined, "flash")), "flash");
  assert.equal(model(backgroundTarget(roles({ fastModel: "fast" }), undefined, "flash")), "fast");
  assert.equal(model(backgroundTarget(roles(), undefined, null)), "cheap");
});

await test("the cheaper sibling is the provider's priced default, only when it costs at most half the main model", async () => {
  const { cheaperSibling } = await import("../server/providers");
  assert.equal(cheaperSibling("anthropic", "claude-opus-4-1"), "claude-haiku-5-5");
  assert.equal(cheaperSibling("anthropic", "claude-haiku-5-5"), null, "already the cheap one");
  assert.equal(cheaperSibling("openai", "gpt-4o-mini"), null);
  assert.equal(cheaperSibling("openai", "some-unlisted-model"), null, "never a guess against an unpriced model");
  assert.equal(cheaperSibling("local", "llama3"), null);
});

await test("the context window counts every model that may answer, on its own provider", () => {
  const names = (list: { provider: string; model: string }[]) => list.map((t) => `${t.provider}/${t.model}`);
  assert.deepEqual(names(conversationTargets(roles())), ["deepseek/cheap"]);
  assert.deepEqual(names(conversationTargets(roles(), "fast")), ["deepseek/cheap", "deepseek/fast"]);
  assert.deepEqual(names(conversationTargets(roles(), "cheap")), ["deepseek/cheap"]);
});

await test("the settings carry the roles to the resolved provider, on any provider with a key", () => {
  /* Hermetic: an env key on this machine must not choose the provider. */
  const envBefore = { ...process.env };
  for (const k of ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "ORCA_ROUTER_API_KEY", "ORCA_API_KEY"]) delete process.env[k];
  state.provider = "auto";
  state.usage = [];
  state.keys.anthropic = "sk-ant-test";
  state.models.anthropic = "claude-haiku-4-5";
  state.keys.deepseek = "sk-test";
  state.models.deepseek = "deepseek-flash";
  /* The cheap vendor does the work; the background model sits on the dear one. */
  state.backgroundModels.deepseek = "claude-haiku-4-5";
  state.backgroundProviders.deepseek = "anthropic";
  let r = resolveProvider();
  assert.equal(r.provider, "deepseek", "the cheaper per-call vendor is chosen");
  assert.equal(r.model, "deepseek-flash");
  assert.equal(r.background?.provider, "anthropic");
  assert.equal(r.background?.model, "claude-haiku-4-5");
  assert.equal(r.background?.key, "sk-ant-test", "the background model is reached with Anthropic's own key");
  assert.deepEqual(r.roleProblems, []);

  /* Anthropic's key removed: the main model does that work, and Settings says why. */
  delete state.keys.anthropic;
  r = resolveProvider();
  assert.equal(r.background, null);
  assert.match(r.roleProblems.join(" "), /background model \(claude-haiku-4-5\) is on Anthropic[^,]*, which has no key/);

  state.backgroundProviders.deepseek = "";
  state.backgroundModels.deepseek = "";
  assert.equal(resolveProvider().background, null);
  Object.assign(process.env, envBefore);
});


await test("a named provider answers with itself every round: roles are Automatic's alone", () => {
  const envBefore = { ...process.env };
  for (const k of ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "ORCA_ROUTER_API_KEY", "ORCA_API_KEY"]) delete process.env[k];
  state.provider = "anthropic";
  state.keys.anthropic = "sk-ant-test";
  state.models.anthropic = "claude-haiku-4-5";
  state.backgroundModels.anthropic = "deepseek-v4-pro";
  state.backgroundProviders.anthropic = "deepseek";
  state.keys.deepseek = "sk-test";
  const r = resolveProvider();
  assert.equal(r.model, "claude-haiku-4-5");
  assert.equal(r.background, null, "no background model behind a named provider");
  assert.deepEqual(r.roleProblems, []);

  /* The same settings, on Automatic: the cheapest vendor is chosen and the
     roles named for it resolve. */
  state.usage = [];
  state.backgroundModels.deepseek = "deepseek-flash";
  state.provider = "auto";
  const auto = resolveProvider();
  assert.equal(auto.provider, "deepseek");
  assert.equal(auto.background?.model, "deepseek-flash");

  state.backgroundProviders.anthropic = "";
  state.backgroundModels.anthropic = "";
  state.backgroundModels.deepseek = "";
  state.provider = "deepseek";
  Object.assign(process.env, envBefore);
});

await test("Automatic never picks a router, and says so when only routers are connected", () => {
  const envBefore = { ...process.env };
  for (const k of ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "ORCA_ROUTER_API_KEY", "ORCA_API_KEY"]) delete process.env[k];
  state.keys.deepseek = "";
  state.keys.anthropic = "";
  state.keys.openrouter = "sk-or-test";
  state.keys.orcarouter = "";
  state.models.openrouter = "z-ai/glm-5.3-flash";
  state.provider = "auto";
  const r = resolveProvider();
  assert.equal(r.provider, "");
  assert.ok(r.problem);
  assert.match(r.problem, /does not choose a router/);
  assert.match(r.problem, /OpenRouter/);

  /* A direct vendor with a key is chosen over nothing, routers never. */
  state.keys.deepseek = "sk-test";
  const direct = resolveProvider();
  assert.equal(direct.provider, "deepseek");

  /* Nothing at all: the old plain message. */
  state.keys.deepseek = "";
  state.keys.openrouter = "";
  const none = resolveProvider();
  assert.ok(none.problem);
  assert.match(none.problem, /No provider is connected yet/);

  state.provider = "openrouter";
  state.keys.deepseek = "sk-test";
  Object.assign(process.env, envBefore);
});

await test("the task ledger files a task under the model that ran it", () => {
  const id = openTask({ session: "s1", provider: "deepseek", model: "cheap", version: "1.0.0", automated: false });
  closeTask(id, "finished", 1);
  const summary = taskSummary();
  const row = summary.recent.find((r) => r.id === id)!;
  assert.deepEqual([row.model, row.planner], ["cheap", null]);
  assert.deepEqual(summary.cells.map((c) => `${c.planner ?? "-"}>${c.model}`), ["->cheap"]);
});

await test("an agent's own model builds its chat, on its own provider when it can be reached", () => {
  const active = roles({ model: "deepseek-flash", fastModel: "deepseek-flash", background: at("deepseek-v4-pro") });
  const reach = (id: string) => (id === "openrouter" ? { key: "k-or", baseUrl: "https://or" } : null);
  const none = agentModelFor(active, { name: "Ada" }, reach);
  assert.equal(none.active, active, "no model of its own: Settings' choice, untouched");
  assert.equal(none.note, null);
  const own = agentModelFor(active, { name: "Ada", model: { provider: "deepseek", model: "deepseek-v4-pro" } }, reach);
  assert.equal(own.active.model, "deepseek-v4-pro");
  assert.equal(own.active.key, "k-ds");
  assert.deepEqual(own.active.background, active.background, "the background model stays Settings' own");
  const there = agentModelFor(active, { name: "Ada", model: { provider: "openrouter", model: "z-ai/glm" } }, reach);
  assert.deepEqual(
    [there.active.provider, there.active.model, there.active.key, there.active.baseUrl, there.active.fastModel],
    ["openrouter", "z-ai/glm", "k-or", "https://or", ""],
    "another provider's model, reached with that provider's key",
  );
  assert.equal(there.note, null);
  const lost = agentModelFor(active, { name: "Ada", model: { provider: "anthropic", model: "claude" } }, reach, (id) => id.toUpperCase());
  assert.equal(lost.active.model, "deepseek-flash", "a provider with no key is never called");
  assert.match(lost.note ?? "", /Ada's model \(claude\) is on ANTHROPIC, which has no key now, so it runs on deepseek-flash/);
  assert.equal(agentModelFor({ ...roles(), provider: "" }, { name: "Ada", model: { provider: "x", model: "y" } }, reach).note, null);
});

await test("Anthropic is sent tool ids it accepts: safe, unique, and paired with their results", () => {
  /* A history another vendor wrote: Gemini's ids repeat every round, and a gateway's carry a colon. */
  const messages = [
    { role: "user" as const, text: "go" },
    { role: "assistant" as const, calls: [{ id: "read_file-0", name: "read_file", args: { path: "a" } }] },
    { role: "tool" as const, replies: [{ id: "read_file-0", name: "read_file", result: "A", ok: true }] },
    { role: "assistant" as const, calls: [
      { id: "read_file-0", name: "read_file", args: { path: "b" } },
      { id: "functions.terminal:1", name: "terminal", args: { command: "ls" } },
    ] },
    { role: "tool" as const, replies: [
      { id: "functions.terminal:1", name: "terminal", result: "ls out", ok: true },
      { id: "read_file-0", name: "read_file", result: "B", ok: true },
    ] },
    { role: "assistant" as const, calls: [{ id: "toolu_01AbC", name: "read_file", args: {} }] },
    { role: "tool" as const, replies: [{ id: "toolu_01AbC", name: "read_file", result: "C", ok: true }] },
  ];
  const out = anthropicMessages({ provider: "anthropic", model: "m", key: "", baseUrl: "", system: "", messages });
  const uses = out.flatMap((m: any) => m.content.filter((b: any) => b.type === "tool_use"));
  const results = out.flatMap((m: any) => m.content.filter((b: any) => b.type === "tool_result"));
  const ids = uses.map((b: any) => b.id);
  assert.equal(new Set(ids).size, ids.length, "every id once");
  for (const id of ids) assert.match(id, /^[a-zA-Z0-9_-]+$/);
  assert.ok(ids.includes("toolu_01AbC"), "an id Anthropic made itself is left as it was");
  /* Each result answers the call it was made for. */
  const byId = new Map(uses.map((b: any) => [b.id, b]));
  const path = (r: any) => (byId.get(r.tool_use_id) as any)?.input?.path ?? (byId.get(r.tool_use_id) as any)?.input?.command;
  assert.deepEqual(results.map((r: any) => [r.content, path(r)]), [["A", "a"], ["ls out", "ls"], ["B", "b"], ["C", undefined]]);
});

await test("an agent's model is saved, cleared, checked, and never the lead's", () => {
  const ada = createAgent({ name: "Ada", role: "Coder", model: { provider: "deepseek", model: "deepseek-v4-pro" } });
  assert.deepEqual(getAgent(ada.id)?.model, { provider: "deepseek", model: "deepseek-v4-pro" });
  assert.match(agentLine(getAgent(ada.id)!), /Builds on deepseek-v4-pro\./, "the lead is told, to route work");
  updateAgent(ada.id, { role: "Senior coder" });
  assert.equal(getAgent(ada.id)?.model?.model, "deepseek-v4-pro", "an edit that does not mention it keeps it");
  updateAgent(ada.id, { model: null });
  assert.equal(getAgent(ada.id)?.model, undefined);
  assert.doesNotMatch(agentLine(getAgent(ada.id)!), /Builds on/);
  updateAgent(ada.id, { model: { provider: "deepseek", model: "  " } });
  assert.equal(getAgent(ada.id)?.model, undefined, "a blank model is the main model");
  assert.throws(() => updateAgent(ada.id, { model: "deepseek-v4-pro" }), /provider, model/);
  assert.throws(() => updateAgent(ada.id, { model: { provider: "", model: "m" } }), /which provider/);
  updateAgent(LEAD_ID, { model: { provider: "deepseek", model: "deepseek-v4-pro" } });
  assert.equal(getAgent(LEAD_ID)?.model, undefined, "the lead's model is Settings'");
});

console.log(`\n${passed} passed`);
